// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The simulator's output records and the private run directory.
//
// A run writes under
//   ${XDG_DATA_HOME:-$HOME/.local/share}/unfrackit-research/sim/<network>/<run-id>/
// (RESEARCH_SIM_HOME overrides the root), never in the repository. A run
// directory (RunOutput) holds:
//   run.json        what the run ran under: its command and plan, the
//                   settings, the treatment's pins, the parameters, the Node
//                   version, the analysis-freeze transaction when it was given
//   records.jsonl   the records, one JSON object per line, bigint as decimal
//                   strings
//   timings.jsonl   wall-clock times, apart from the records so that a run
//                   repeated with the same seeds writes byte-identical records
//   log.jsonl       the run's log: start, each watchdog stop, machine rerun
//                   or error, end
// A replay stage writes each wallet's records as a segment of its own and
// joins them at its end (out/stage.mjs); a wallet's segment is written here
// first (Segment), uncompressed, in its spool directory.
// Directories are created 0700 and files 0600.
//
// Every record carries the key of the replay spend it belongs to:
//   wallet      db-sync's stake-credential id (an integer), or a shape's name
//   window      'recent', 'peak', 'snapshot', or 'synthetic'
//   arm         the starting layout and its maintenance
//   variant     the planner settings varied from the decided defaults, by name
//   method      the selector, by name and version
//   change      the change policy
//   collateral  the arm's collateral rule
//   repetition  the repetition number, 1-based
// and names no stake address, address or transaction hash: assertClean
// refuses a record carrying a bech32 address or stake address anywhere, and a
// run of 64 hex digits (a transaction hash) or 56 (a credential or a key
// hash) anywhere but a field named policy, name or asset (an asset is
// 'policy.name'), so free text (a failure's detail, a refusal's reason) is
// scrubbed of them first. Intents are named by their position in the wallet's
// stream.

import { join } from 'node:path';
import { openSync, readSync, closeSync, unlinkSync } from 'node:fs';
import { runDir, ensureDir, writeJson, JsonLines, toJson } from '../history/paths.mjs';

export const RECORD_KINDS = Object.freeze(['spend', 'plan', 'burst', 'trigger', 'wallet-arm', 'refused']);
export const KEY_FIELDS = Object.freeze(['wallet', 'window', 'arm', 'variant', 'method', 'change', 'collateral', 'repetition']);

const BECH32_ADDR = /(addr|addr_test|stake|stake_test)1[02-9ac-hj-np-z]{20,}/;
const HEX64 = /[0-9a-f]{64}/i;
const HEX56 = /[0-9a-f]{56}/i;
const TEXT_FIELDS = new Set(['detail', 'reason', 'error', 'refused']);

// A free-text field (a failure's detail, a refusal's reason) with every
// address, hash and credential in it replaced by a placeholder.
export function scrubText(t) {
  return String(t)
    .replace(new RegExp(BECH32_ADDR.source, 'g'), '<address>')
    .replace(/[0-9a-f]{64}/gi, '<hash>')
    .replace(/[0-9a-f]{56}/gi, '<hash28>');
}
function scrub(v, field) {
  if (typeof v === 'string') return TEXT_FIELDS.has(field) ? scrubText(v) : v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, field));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, k)]));
  return v;
}
const ASSET_FIELDS = new Set(['policy', 'name', 'asset']);

export class IdentifierInRecord extends Error {}

// Throws when a record names a stake address, an address, a transaction hash,
// or a credential.
export function assertClean(record, path = '') {
  const walk = (v, p, field) => {
    if (typeof v === 'string') {
      if (BECH32_ADDR.test(v)) throw new IdentifierInRecord(`record field ${p}: an address`);
      if (ASSET_FIELDS.has(field)) return;
      if (HEX64.test(v)) throw new IdentifierInRecord(`record field ${p}: a transaction hash`);
      if (HEX56.test(v)) throw new IdentifierInRecord(`record field ${p}: a credential or key hash`);

    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${p}[${i}]`, field));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k, k);
    }
  };
  walk(record, path, null);
  return record;
}

// Whether a record's wallet field can carry a shape's name: a capital letter
// and at most five letters or digits more.
export const recordsShapeName = (name) => typeof name === 'string' && /^[A-Z][A-Za-z0-9]{0,5}$/.test(name);

export function recordKey(k) {
  for (const f of KEY_FIELDS) if (k[f] === undefined) throw new TypeError(`record key: no ${f}`);
  if (!(Number.isSafeInteger(k.wallet) || typeof k.wallet === 'string')) throw new TypeError('record key: wallet must be a stake-credential id or a shape name');
  if (typeof k.wallet === 'string' && !recordsShapeName(k.wallet)) throw new TypeError(`record key: ${k.wallet} is not a shape name`);
  return Object.fromEntries(KEY_FIELDS.map((f) => [f, k[f]]));
}

// A record; free-text fields are scrubbed first.
export function record(kind, key, fields) {
  if (!RECORD_KINDS.includes(kind)) throw new TypeError(`unknown record kind ${kind}`);
  for (const f of ['kind', ...KEY_FIELDS]) if (f in fields) throw new TypeError(`a record's fields may not name its ${f}`);
  return assertClean({ kind, ...recordKey(key), ...scrub(fields, null) });
}

// A record as RunOutput writes it: its line of records.jsonl (the JSON text,
// without the newline) and its wall-clock fields (ms, at any depth) by path,
// for timings.jsonl. Pure, so that a worker can prepare the lines a run
// writes.
export function prepare(rec) {
  assertClean(rec);
  const times = {};
  const strip = (v, p) => {
    if (Array.isArray(v)) return v.map((x, i) => strip(x, `${p}[${i}]`));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === 'ms' && typeof x === 'number') times[p ? `${p}.ms` : 'ms'] = x;
        else o[k] = strip(x, p ? `${p}.${k}` : k);
      }
      return o;
    }
    return v;
  };
  return { line: toJson(strip(rec, '')), times };
}

// A line of timings.jsonl: the times of record number n, under the record's
// kind and key. In a replay stage's segment, n counts within the segment and
// the row leads with the wallet's index (walletIndex), so that the segments'
// rows join without renumbering.
export const timingLine = (n, rec, times, walletIndex) => toJson({ ...(walletIndex === undefined ? {} : { walletIndex }), n, kind: rec.kind, ...recordKey(rec), times });

const addCounts = (to, from) => {
  for (const [k, c] of Object.entries(from)) to[k] = (to[k] || 0) + c;
};

// Calls fn with each line of a file, without its newline, reading a mebibyte
// at a time. A file that does not end with a newline is refused.
function eachLine(path, fn) {
  const fd = openSync(path, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  let carry = Buffer.alloc(0);
  try {
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) {
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      for (let i = chunk.indexOf(10); i !== -1; start = i + 1, i = chunk.indexOf(10, start)) fn(chunk.toString('utf8', start, i));
      carry = Buffer.from(chunk.subarray(start));
    }
  } finally {
    closeSync(fd);
  }
  if (carry.length) throw new Error(`${path} ends inside a line`);
}

// Records and their times, numbered from 1: written one at a time, or
// committed from a replay job's spool (out/spool.mjs). walletIndex: the
// wallet's index in a replay stage, which its timing rows carry.
class RecordLines {
  constructor(recordsPath, timingsPath, walletIndex) {
    this.records = new JsonLines(recordsPath);
    this.timings = new JsonLines(timingsPath);
    this.walletIndex = walletIndex;
    this.n = 0;
    this.counts = {};
  }
  // A record; its wall-clock fields (ms, at any depth) go to timings.jsonl
  // under the record's key and number.
  write(rec) {
    const { line, times } = prepare(rec);
    const n = ++this.n;
    this.records.line(line);
    if (Object.keys(times).length) this.timings.line(timingLine(n, rec, times, this.walletIndex));
    this.counts[rec.kind] = (this.counts[rec.kind] || 0) + 1;
  }
  // A job's spooled records after those written so far: its record lines as
  // the worker wrote them, its timing rows renumbered to follow on, then its
  // held row (spool.mjs); the job's spool files are removed. The lines are
  // the ones write() would have written for the same records.
  commit(s) {
    const base = this.n;
    const lines = this.records.append(s.records);
    if (lines !== s.count) throw new Error(`${s.records} holds ${lines} records, not the ${s.count} its job wrote`);
    const lead = this.walletIndex === undefined ? '{' : `{"walletIndex":${this.walletIndex},`;
    eachLine(s.timings, (line) => {
      const m = /^\{"n":([1-9]\d*),/.exec(line);
      if (!m || Number(m[1]) > s.count) throw new Error(`${s.timings}: not a timing row of its job`);
      this.timings.line(`${lead}"n":${base + Number(m[1])},${line.slice(m[0].length)}`);
    });
    if (s.held) this.timings.line(timingLine(base + s.held.n, { kind: s.held.kind, ...s.held.key }, s.held.times, this.walletIndex));
    this.n = base + s.count;
    addCounts(this.counts, s.counts);
    unlinkSync(s.records);
    unlinkSync(s.timings);
  }
  close() {
    this.records.close();
    this.timings.close();
  }
}

// A run's directory and its files (a replay stage's are out/stage.mjs's).
export class RunOutput extends RecordLines {
  constructor(network, runId, header) {
    const dir = ensureDir(runDir(network, runId));
    writeJson(join(dir, 'run.json'), { ...header, network, runId });
    super(join(dir, 'records.jsonl'), join(dir, 'timings.jsonl'));
    this.dir = dir;
    this.log = new JsonLines(join(dir, 'log.jsonl'));
  }
  note(entry) {
    this.log.write({ at: new Date().toISOString(), ...entry });
  }
  close() {
    super.close();
    this.log.close();
  }
}

// One wallet's records in a replay stage, in directory dir: its jobs' spools
// committed in job order, then its trigger records, numbered within the
// wallet from 1, with the wallet's index in every timing row. The stage
// compresses the two files into the wallet's segment when the wallet is
// complete (out/stage.mjs).
export class Segment extends RecordLines {
  constructor(dir, walletIndex) {
    if (!Number.isSafeInteger(walletIndex) || walletIndex < 0) throw new TypeError('a segment needs its wallet\'s index');
    ensureDir(dir);
    super(join(dir, 'records.jsonl'), join(dir, 'timings.jsonl'), walletIndex);
    this.dir = dir;
  }
  remove() {
    unlinkSync(this.records.path);
    unlinkSync(this.timings.path);
  }
}
