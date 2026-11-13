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
// again (a watchdog stop, a machine rerun) rewrites its spool from the start.

import { join } from 'node:path';
import { openSync, writeSync, closeSync } from 'node:fs';
import { prepare, timingLine, recordKey } from './records.mjs';

export const spoolPaths = (dir, job) => ({ records: join(dir, `${job}.records.jsonl`), timings: join(dir, `${job}.timings.jsonl`) });

// Lines written a mebibyte at a time, to a file created 0600.
class Spooler {
  constructor(path) {
    this.fd = openSync(path, 'w', 0o600);
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

// Writes a job's records (an iterable, in order) to its spool. hold(rec):
// whether a record's timing row is returned instead of written, for the run
// to complete (the run sets the wallet-arm's time to the attempt's); only a
// job's last record may be held, so its row still comes last. Returns what
// the commit reads: the paths, the record count, the counts by kind, and the
// held row ({ n, kind, key, times }) or null.
export function spoolRecords(paths, recs, { hold = () => false } = {}) {
  const r = new Spooler(paths.records);
  let t = null;
  const counts = {};
  let count = 0;
  let held = null;
  try {
    t = new Spooler(paths.timings);
    for (const rec of recs) {
      if (held) throw new Error('only the last record of a job may hold its timing row');
      const { line, times } = prepare(rec);
      const n = ++count;
      r.add(line);
      counts[rec.kind] = (counts[rec.kind] || 0) + 1;
      if (!Object.keys(times).length) continue;
      if (hold(rec)) held = { n, kind: rec.kind, key: recordKey(rec), times };
      else t.add(timingLine(n, rec, times));
    }
  } finally {
    r.close();
    if (t) t.close();
  }
  return { records: paths.records, timings: paths.timings, count, counts, held };
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
