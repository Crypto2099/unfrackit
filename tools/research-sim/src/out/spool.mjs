// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A replay job's records on disk. The worker that ran the job builds its
// records and writes them to the job's spool; the run commits the spools in
// job order to the wallet's segment (replay/run.mjs, out/records.mjs), so the
// main thread holds no wallet's records. A job's spool is two files in its wallet's spool directory:
//   <job>.records.jsonl  the record lines, byte for byte as RunOutput.write
//                        writes them
//   <job>.timings.jsonl  their timing rows, numbered within the job from 1
// The commit appends the record lines, renumbers the timing rows to follow
// the records written before them, and removes both files. A job that runs
// again (a machine rerun) rewrites its spool from the start. A replay job's
// worker may write its spool as the job goes (SpoolStream, flushed after each
// record), so that a job the watchdog kills keeps the records it had written;
// resumeSpool reopens such a spool after the kill.

import { join } from 'node:path';
import { openSync, writeSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { prepare, timingLine, recordKey } from './records.mjs';

export const spoolPaths = (dir, job) => ({ records: join(dir, `${job}.records.jsonl`), timings: join(dir, `${job}.timings.jsonl`) });

// Lines written a mebibyte at a time, to a file created 0600.
class Spooler {
  constructor(path, flags = 'w') {
    this.fd = openSync(path, flags, 0o600);
    this.parts = [];
    this.size = 0;
  }
  add(line) {
    this.parts.push(line, '\n');
    this.size += line.length + 1;
    if (this.size >= 1 << 20) this.flush();
  }
  flush() {
    if (!this.parts.length) return;
    const buf = Buffer.from(this.parts.join(''));
    this.parts = [];
    this.size = 0;
    for (let off = 0; off < buf.length;) off += writeSync(this.fd, buf, off, buf.length - off);
  }
  close() {
    try {
      this.flush();
    } finally {
      closeSync(this.fd);
    }
  }
}

// A job's records written to its spool one at a time. hold(rec): whether a
// record's timing row is returned instead of written, for the run to
// complete (the run sets the wallet-arm's time to the attempt's); only a
// job's last record may be held, so its row still comes last. eager: each
// record reaches the file when it is added (its timing row first, so that a
// row never lacks its record's predecessor and a kill leaves at most one
// timing row beyond the records), where otherwise the files are written a
// mebibyte at a time; the bytes are the same. close() returns what the
// commit reads: the paths, the record count, the counts by kind, and the
// held row ({ n, kind, key, times }) or null.
export class SpoolStream {
  constructor(paths, { hold = () => false, eager = false, resume = null } = {}) {
    this.paths = paths;
    this.hold = hold;
    this.eager = eager;
    const flags = resume ? 'a' : 'w';
    this.r = new Spooler(paths.records, flags);
    try {
      this.t = new Spooler(paths.timings, flags);
    } catch (e) {
      this.r.close();
      throw e;
    }
    this.counts = resume ? { ...resume.counts } : {};
    this.count = resume ? resume.count : 0;
    this.held = null;
    this.closed = false;
  }
  add(rec) {
    if (this.held) throw new Error('only the last record of a job may hold its timing row');
    const { line, times } = prepare(rec);
    const n = ++this.count;
    this.counts[rec.kind] = (this.counts[rec.kind] || 0) + 1;
    const timed = Object.keys(times).length > 0;
    if (timed) {
      if (this.hold(rec)) this.held = { n, kind: rec.kind, key: recordKey(rec), times };
      else this.t.add(timingLine(n, rec, times));
    }
    if (this.eager) {
      this.t.flush();
      this.r.add(line);
      this.r.flush();
    } else this.r.add(line);
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      try {
        this.r.close();
      } finally {
        this.t.close();
      }
    }
    return { records: this.paths.records, timings: this.paths.timings, count: this.count, counts: this.counts, held: this.held };
  }
}

// Writes a job's records (an iterable, in order) to its spool; see SpoolStream.
export function spoolRecords(paths, recs, { hold = () => false } = {}) {
  const s = new SpoolStream(paths, { hold });
  try {
    for (const rec of recs) s.add(rec);
  } finally {
    s.close();
  }
  return s.close();
}

// What a killed job's spool holds, made whole: a spool written by a
// SpoolStream, cut after its last complete record line, its timing rows cut
// to those of the records kept. A spool that does not exist is empty.
// Returns { count, counts, spends, last }: the records by kind, the spend
// records' number and the last spend's intent and time ({ intent, t }), or
// null when it has none.
export function repairSpool(paths) {
  const text = (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return '';
      throw e;
    }
  };
  const whole = (t) => t.slice(0, t.lastIndexOf('\n') + 1);
  const recs = text(paths.records);
  const keptRecs = whole(recs);
  let count = 0;
  let spends = 0;
  let last = null;
  const counts = {};
  for (const line of keptRecs.split('\n')) {
    if (!line) continue;
    const r = JSON.parse(line);
    count++;
    counts[r.kind] = (counts[r.kind] || 0) + 1;
    if (r.kind === 'spend') {
      spends++;
      last = { intent: r.intent, t: r.t };
    }
  }
  const rows = whole(text(paths.timings))
    .split('\n')
    .filter((l) => {
      if (!l) return false;
      const m = /^\{"n":([1-9]\d*),/.exec(l);
      return m && Number(m[1]) <= count;
    });
  writeFileSync(paths.records, keptRecs, { mode: 0o600 });
  writeFileSync(paths.timings, rows.map((l) => `${l}\n`).join(''), { mode: 0o600 });
  return { count, counts, spends, last };
}

// Commits jobs in job order as they complete. done(i, value) keeps value
// until every earlier job is done, then calls commit(j, value) for each job j
// it releases, in order. stop() drops what it keeps and ignores later jobs.
export class Frontier {
  constructor(size, commit) {
    this.size = size;
    this.commit = commit;
    this.next = 0;
    this.kept = new Map();
    this.stopped = false;
  }
  // Whether value was taken (false once stopped).
  done(i, value) {
    if (this.stopped) return false;
    if (!Number.isSafeInteger(i) || i < this.next || i >= this.size || this.kept.has(i)) throw new Error(`job ${i} is not one still to commit`);
    this.kept.set(i, value);
    while (!this.stopped && this.kept.has(this.next)) {
      const v = this.kept.get(this.next);
      this.kept.delete(this.next);
      this.commit(this.next, v);
      this.next++;
    }
    return true;
  }
  get complete() {
    return this.next === this.size;
  }
  stop() {
    this.stopped = true;
    this.kept.clear();
  }
}
