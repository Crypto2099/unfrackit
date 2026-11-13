// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A replay stage's run directory: each wallet's records written whole as a
// segment of its own, a stopped stage resumed at the wallets not done, and the
// segments joined in wallet order when every wallet is done. The joined
// stream's decompressed bytes are those one uninterrupted run writes, on any
// machine and at any worker count.
//
// Layout, in the run directory (out/records.mjs gives the root):
//   wallets.json   the ordered wallet list: { file, sha256 } per history file
//                  (its name and the SHA-256 of its bytes) or { shape } per
//                  synthetic shape. A wallet's index is its position.
//   run.json       what decides the records and nothing about the machine: the
//                  stage layout, the command, the plan, the options that change
//                  a record, the settings, the treatment's pins, the code
//                  manifest, the Node version, the CSL build, and
//                  walletsSha256, the SHA-256 of wallets.json. Its SHA-256 is
//                  the stage's compatibility key.
//   segments/<i>.records.jsonl.gz, segments/<i>.timings.jsonl.gz
//                  wallet i's records and timing rows, each one gzip member at
//                  level 6, written under the name with .tmp added and renamed
//                  when complete
//   segments/<i>.done.json
//                  written after both: per file the SHA-256, byte and line
//                  counts of the decompressed bytes and the compressed size;
//                  the record counts by kind, the wallet's totals, the machine
//                  label, start and end, and run.json's SHA-256
//   machines/<label>.json
//                  per invocation under the label: the host facts
//                  (out/host.mjs machineFacts), the worker count, the
//                  workers' memory budget and the pool's counts (the replay
//                  command adds them), the indexes it completed, start and
//                  end
//   machines/<label>.log.jsonl
//                  the log, appended by every invocation under the label
//   spool/<i>/     while wallet i is open: its jobs' spools and its records
//                  before compression (replay/run.mjs, which keeps several
//                  wallets open at once); removed when it is done
//   records.jsonl.gz, timings.jsonl.gz
//                  at the stage's end, the segments' gzip members joined in
//                  index order, not recompressed
//   done.json      written last: the joined streams' SHA-256, byte and line
//                  counts and compressed sizes, the record counts by kind and
//                  the totals, summed from the segments' done files
//   lock           the process ID of the invocation writing the stage
// Directories are created 0700 and files 0600.
//
// Identity is defined on decompressed bytes: compressed bytes can differ with
// the zlib version or how writes are chunked, and that is no difference in
// results. A multi-member gzip stream is a valid gzip file; zcat and Node's
// zlib.createGunzip() read every member.
//
// Resume. Opening a stage whose run.json exists compares it with this
// invocation's, field by field, and refuses any difference, naming the fields;
// the worker count and the machine are not in it, so either may change. Every
// index whose done file exists, names this run.json and whose segment files
// decompress to the bytes it records is kept; any other index's files (a
// temporary file, a segment with no done file, one whose bytes do not match)
// are deleted and the wallet runs again, and the spool is removed. A stage
// with no run.json starts empty. A stage that has ended (its done.json names
// this run.json and the wallet count, and both joined files have the
// compressed sizes it records) is not opened again: the invocation runs
// nothing, changes no segment and prints the totals done.json holds.
//
// Shards. An invocation may be given a selection of the wallet indexes
// (--shard k/n or --wallet-indexes, replay/shards.mjs), recorded in its entry
// in machines/<label>.json; the selection is not in run.json, so every shard
// of a stage has the same compatibility key. It runs only its indexes not
// done. Its end joins the segments when every index from 0 to N-1 is done in
// the directory, as an unsharded stage's does; otherwise it ends without the
// join, noting which indexes are done and how many remain. The segments of
// several directories are joined by out/merge.mjs.

import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, statSync, chmodSync, openSync, readSync, writeSync, closeSync, fsyncSync, createReadStream, createWriteStream, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { writeFile, rename, chmod, stat, rm } from 'node:fs/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';
import { ensureDir, JsonLines } from '../history/paths.mjs';
import { Segment } from './records.mjs';
import { machineFacts } from './host.mjs';
import { takeLock } from './lock.mjs';
import { machineLabel, flagOf } from '../options.mjs';

export const STAGE_LAYOUT = 'unfrackit-research-sim replay stage 1';
export const GZIP_LEVEL = 6;
const KINDS = ['records', 'timings'];
const EMPTY_SHA256 = createHash('sha256').digest('hex');
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
export const jsonText = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2) + '\n';

// A file written whole under a temporary name, flushed to disk and renamed.
export function writeAtomic(path, text) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600, flush: true });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

// writeAtomic without blocking the thread, for a wallet's close, which runs
// while other wallets' jobs end (replay/run.mjs).
async function writeAtomicAsync(path, text) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text, { mode: 0o600, flush: true });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

// The wallets.json entry of each replay wallet ({ spec }, replay/source.mjs),
// in the order given.
export function walletList(wallets) {
  return wallets.map(({ spec }) => {
    if (spec.kind === 'history') return { file: basename(spec.path), sha256: sha256(readFileSync(spec.path)) };
    if (spec.kind === 'shape') return { shape: spec.name };
    throw new Error(`unknown wallet source ${spec.kind}`);
  });
}

// The SHA-256 of the wallets.json a list of entries is written as.
export const walletsSha256 = (list) => sha256(jsonText(list));

// Indexes as ranges, `0-3,5,7-9`; `none` for an empty list.
export function indexRanges(indexes) {
  const xs = [...indexes].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < xs.length;) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
    out.push(j === i ? `${xs[i]}` : `${xs[i]}-${xs[j]}`);
    i = j + 1;
  }
  return out.length ? out.join(',') : 'none';
}

// How two run.json differ, as names: an option by its flag, any other field
// by what it records.
const FIELD_NAMES = Object.freeze({ layout: 'the stage layout', command: 'the command', plan: 'the plan', entries: 'the plan\'s entries', settings: 'the settings', treatmentPins: 'the treatment pins', node: 'the Node version', csl: 'the CSL build', manifest: 'the code manifest', walletsSha256: 'the wallet list' });
export function runDifferences(was, now) {
  const out = [];
  for (const k of [...new Set([...Object.keys(was), ...Object.keys(now)])]) {
    if (k === 'options') {
      const a = was.options || {};
      const b = now.options || {};
      for (const o of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) if (canonical(a[o]) !== canonical(b[o])) out.push(flagOf(o));
    } else if (canonical(was[k]) !== canonical(now[k])) {
      out.push(FIELD_NAMES[k] || k);
    }
  }
  return out;
}

// A pass-through that hashes the bytes and counts them and their newlines.
function tap() {
  const h = createHash('sha256');
  const st = { bytes: 0, lines: 0 };
  const t = new Transform({
    transform(chunk, _e, cb) {
      h.update(chunk);
      st.bytes += chunk.length;
      for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) st.lines++;
      cb(null, chunk);
    }
  });
  return { t, result: () => ({ sha256: h.digest('hex'), bytes: st.bytes, lines: st.lines }) };
}
const sink = () => new Writable({ write(_c, _e, cb) { cb(); } });

// src compressed to dst as one gzip member at GZIP_LEVEL; the decompressed
// bytes' SHA-256, byte and line counts, and the compressed size. The
// compression runs on libuv's thread pool and the file I/O is asynchronous,
// so the calling thread goes on with other work meanwhile.
export async function gzipFile(src, dst) {
  const { t, result } = tap();
  await pipeline(createReadStream(src), t, createGzip({ level: GZIP_LEVEL }), createWriteStream(dst, { mode: 0o600, flush: true }));
  await chmod(dst, 0o600);
  return { ...result(), gzipBytes: (await stat(dst)).size };
}

// A gzip file's decompressed bytes, every member: SHA-256, bytes, lines.
export async function gunzipDigest(path) {
  const { t, result } = tap();
  await pipeline(createReadStream(path), createGunzip(), t, sink());
  return result();
}

// A gzip file's decompressed bytes cut into consecutive slices of the given
// sizes: the whole stream's SHA-256, bytes and lines, each slice's SHA-256,
// and whether the stream ran short of the sizes or past them.
async function sliceDigests(path, sizes) {
  const whole = createHash('sha256');
  const st = { bytes: 0, lines: 0, over: 0 };
  const parts = [];
  let i = 0;
  let left = 0;
  let part = null;
  const next = () => {
    while (i < sizes.length && sizes[i] === 0) {
      parts.push(EMPTY_SHA256);
      i++;
    }
    if (i < sizes.length) {
      left = sizes[i];
      part = createHash('sha256');
    }
  };
  next();
  const cut = new Writable({
    write(chunk, _e, cb) {
      whole.update(chunk);
      st.bytes += chunk.length;
      for (let k = chunk.indexOf(10); k !== -1; k = chunk.indexOf(10, k + 1)) st.lines++;
      let off = 0;
      while (off < chunk.length) {
        if (i >= sizes.length) {
          st.over += chunk.length - off;
          break;
        }
        const take = Math.min(left, chunk.length - off);
        part.update(chunk.subarray(off, off + take));
        off += take;
        left -= take;
        if (left === 0) {
          parts.push(part.digest('hex'));
          i++;
          next();
        }
      }
      cb();
    }
  });
  await pipeline(createReadStream(path), createGunzip(), cut);
  return { sha256: whole.digest('hex'), bytes: st.bytes, lines: st.lines, parts, short: i < sizes.length, over: st.over };
}

// The files' bytes, in order, into dst (a byte copy: gzip members stay as
// they are), flushed to disk.
export function concatFiles(paths, dst) {
  const fd = openSync(dst, 'w', 0o600);
  const buf = Buffer.allocUnsafe(4 << 20);
  try {
    for (const p of paths) {
      const src = openSync(p, 'r');
      try {
        for (let n; (n = readSync(src, buf, 0, buf.length, null)) > 0;) for (let off = 0; off < n;) off += writeSync(fd, buf, off, n - off);
      } finally {
        closeSync(src);
      }
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(dst, 0o600);
}

// Numbers summed into `to`, nested objects too, keys in the order first seen.
function addInto(to, from) {
  for (const [k, v] of Object.entries(from || {})) {
    if (typeof v === 'number') to[k] = (to[k] || 0) + v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) addInto((to[k] = to[k] || {}), v);
    else throw new Error(`a wallet's totals hold ${k}, which is not a count`);
  }
  return to;
}

// A segment file's path in a segments directory: kind records, timings or done.
export const segmentPath = (segments, i, kind) => join(segments, `${i}.${kind === 'done' ? 'done.json' : `${kind}.jsonl.gz`}`);

// The done record of index i in a segments directory when its segment holds
// what the done file says under the stage whose run.json has SHA-256
// runSha256, else the reason it does not: the done file read, its index and
// runSha256, both segment files present, each decompressing to the SHA-256
// and byte count it records.
export async function checkSegment(segments, i, runSha256) {
  let d;
  try {
    d = JSON.parse(readFileSync(segmentPath(segments, i, 'done'), 'utf8'));
  } catch {
    return { reason: 'its done file cannot be read' };
  }
  if (!d || d.index !== i || d.runSha256 !== runSha256) return { reason: 'its done file belongs to another stage' };
  for (const kind of KINDS) {
    if (!existsSync(segmentPath(segments, i, kind))) return { reason: `its ${kind} file is missing` };
    let got;
    try {
      got = await gunzipDigest(segmentPath(segments, i, kind));
    } catch (e) {
      return { reason: `its ${kind} file cannot be decompressed (${e.code || e.message})` };
    }
    if (!d[kind] || got.sha256 !== d[kind].sha256 || got.bytes !== d[kind].bytes) return { reason: `its ${kind} file's decompressed bytes differ from its done file's SHA-256` };
  }
  return { done: d };
}

// The stage's done.json when the stage in dir has ended under the run.json
// whose SHA-256 is runSha256 with n wallets: done.json read, naming that
// run.json and n wallets, and both joined files present at the compressed
// sizes it records. Else null.
export function endedRecord(dir, runSha256, n) {
  let d;
  try {
    d = JSON.parse(readFileSync(join(dir, 'done.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!d || d.runSha256 !== runSha256 || d.wallets !== n) return null;
  for (const kind of KINDS) {
    const p = join(dir, `${kind}.jsonl.gz`);
    if (!d[kind] || !existsSync(p) || statSync(p).size !== d[kind].gzipBytes) return null;
  }
  return d;
}

// The totals and counts of done records summed: { totals: { wallets, ... },
// counts }.
export function sumDone(dones) {
  const totals = { wallets: dones.length };
  const counts = {};
  for (const d of dones) {
    addInto(totals, d.totals);
    addInto(counts, d.counts);
  }
  return { totals, counts };
}

// The stage's end in dir: the segments of every index, in index order (dones:
// each index's done record), joined into records.jsonl.gz and
// timings.jsonl.gz, the joined streams decompressed and cut at the segments'
// byte counts giving each segment's SHA-256, and done.json written last with
// the totals and counts summed from the done records. A joined stream that
// does not give its segments' bytes is removed and the end throws, before
// done.json. Returns { totals, counts, records } (records: the joined
// records stream's SHA-256, bytes, lines and compressed size).
export async function joinStage(dir, { runSha256, dones, label }) {
  const segments = join(dir, 'segments');
  const joined = {};
  for (const kind of KINDS) {
    const dst = join(dir, `${kind}.jsonl.gz`);
    const tmp = `${dst}.tmp`;
    concatFiles(dones.map((_d, i) => segmentPath(segments, i, kind)), tmp);
    const got = await sliceDigests(tmp, dones.map((d) => d[kind].bytes));
    const bad = got.parts.findIndex((h, i) => h !== dones[i][kind].sha256);
    if (got.short || got.over || bad !== -1) {
      unlinkSync(tmp);
      throw new Error(`the joined ${kind} stream does not decompress to the segments' bytes${bad !== -1 ? `: segment ${bad} differs` : got.short ? ': it ends early' : ': it runs past the last segment'}`);
    }
    joined[kind] = { tmp, dst, digest: { sha256: got.sha256, bytes: got.bytes, lines: got.lines, gzipBytes: statSync(tmp).size } };
  }
  for (const kind of KINDS) renameSync(joined[kind].tmp, joined[kind].dst);
  const { totals, counts } = sumDone(dones);
  writeAtomic(join(dir, 'done.json'), jsonText({ runSha256, wallets: dones.length, records: joined.records.digest, timings: joined.timings.digest, counts, totals, machine: label, end: new Date().toISOString() }));
  return { totals, counts, records: joined.records.digest };
}

// Opens a replay stage in dir, resuming it when its run.json matches.
// header: run.json's fields but walletsSha256; wallets: wallets.json's
// entries (walletList); machine: the label (--machine, `local` when absent);
// workers: this invocation's worker count; selection: null for every wallet,
// or this invocation's share, { indexes (each below the wallet count),
// record (what machines/<label>.json records of it) }
// (replay/shards.mjs selectionOf). Throws, before changing anything, when
// the stage is locked by a running process or was started under another
// run.json.
export async function openStage(dir, { header, wallets, machine, workers = null, selection = null }) {
  const label = machineLabel(machine);
  if (selection && !(Array.isArray(selection.indexes) && selection.indexes.every((i) => Number.isSafeInteger(i) && i >= 0 && i < wallets.length))) throw new Error(`a selection's indexes are wallet indexes below ${wallets.length}`);
  ensureDir(dir);
  const unlock = takeLock(dir, { what: 'replay stage' });
  try {
    const stage = new ReplayStage(dir, { header, wallets, label, workers, unlock, selection });
    await stage.resume();
    return stage;
  } catch (e) {
    unlock();
    throw e;
  }
}

export class ReplayStage {
  constructor(dir, { header, wallets, label, workers, unlock, selection = null }) {
    this.dir = dir;
    this.label = label;
    this.unlock = unlock;
    this.n = wallets.length;
    this.mine = selection ? new Set(selection.indexes) : null;
    // Set by finish(): whether the stage ended, and, when a shard ends
    // without the join, { done, remaining }.
    this.ended = false;
    this.progress = null;
    this.segments = join(dir, 'segments');
    this.spool = join(dir, 'spool');
    const walletsText = jsonText(wallets);
    const run = { ...header, walletsSha256: sha256(walletsText) };
    const runText = jsonText(run);
    const runPath = join(dir, 'run.json');
    this.resumed = existsSync(runPath);
    if (this.resumed) {
      const diff = runDifferences(JSON.parse(readFileSync(runPath, 'utf8')), run);
      if (diff.length) throw new Error(`refusing: the replay stage in ${dir} was started under another run.json; it differs in ${diff.join(', ')}. Resume it with the same options, wallets, code, Node version and CSL build, or start a new run ID`);
      if (!existsSync(join(dir, 'wallets.json')) || sha256(readFileSync(join(dir, 'wallets.json'))) !== run.walletsSha256) writeAtomic(join(dir, 'wallets.json'), walletsText);
    } else {
      // A stage that never wrote run.json starts empty.
      for (const f of ['segments', 'spool', 'done.json', 'records.jsonl.gz', 'timings.jsonl.gz', 'records.jsonl.gz.tmp', 'timings.jsonl.gz.tmp']) rmSync(join(dir, f), { recursive: true, force: true });
      writeAtomic(join(dir, 'wallets.json'), walletsText);
      writeAtomic(runPath, runText);
    }
    this.runSha256 = sha256(readFileSync(runPath));
    // A stage that has ended is not opened again.
    this.earlier = this.resumed ? endedRecord(dir, this.runSha256, this.n) : null;
    this.done = new Array(this.n).fill(null);
    this.counts = {};
    ensureDir(this.segments);
    const machines = ensureDir(join(dir, 'machines'));
    this.log = new JsonLines(join(machines, `${label}.log.jsonl`), { append: true });
    this.machinePath = join(machines, `${label}.json`);
    let invocations = [];
    try {
      invocations = JSON.parse(readFileSync(this.machinePath, 'utf8')).invocations || [];
    } catch {
      // the first invocation under this label, or a file a kill cut short
    }
    this.invocation = { start: new Date().toISOString(), end: null, finished: false, workers, selection: selection ? selection.record : null, completed: [], ...machineFacts() };
    this.invocations = [...invocations, this.invocation];
    this.saveMachine();
  }

  saveMachine() {
    writeAtomic(this.machinePath, jsonText({ label: this.label, invocations: this.invocations }));
  }

  // Fields this invocation's machine record gains beside the host facts
  // (the workers' memory budget and the pool's counts, replay/pool.mjs);
  // an object given is written as it stands at each save.
  machine(fields) {
    Object.assign(this.invocation, fields);
    this.saveMachine();
  }

  note(entry) {
    this.log.write({ at: new Date().toISOString(), ...entry });
  }

  path(i, kind) {
    return segmentPath(this.segments, i, kind);
  }

  // The done record of index i when its segment holds what it says, else
  // the reason it does not.
  check(i) {
    return checkSegment(this.segments, i, this.runSha256);
  }

  // Keeps every index whose segment holds what its done file says; deletes
  // every other file of the segments directory and the spool. A stage that
  // has ended is left as it is.
  async resume() {
    if (this.earlier) {
      this.note({ event: 'stage-ended-earlier', machine: this.label, workers: this.invocation.workers, wallets: this.n });
      return;
    }
    const name = /^(0|[1-9]\d*)\.(records\.jsonl\.gz|timings\.jsonl\.gz|done\.json)$/;
    const indexOf = (f) => {
      const m = /^(0|[1-9]\d*)(\.|$)/.exec(f);
      return m && Number(m[1]) < this.n ? Number(m[1]) : null;
    };
    const partial = new Set();
    if (existsSync(this.spool)) for (const f of readdirSync(this.spool)) if (indexOf(f) !== null) partial.add(indexOf(f));
    rmSync(this.spool, { recursive: true, force: true });
    // The stage is not done until its end writes done.json again.
    rmSync(join(this.dir, 'done.json'), { force: true });
    for (const f of readdirSync(this.segments)) {
      const i = indexOf(f);
      const done = i !== null && existsSync(this.path(i, 'done'));
      if (done && name.test(f)) continue;
      if (i !== null && !done) partial.add(i);
      rmSync(join(this.segments, f), { recursive: true, force: true });
    }
    const redo = [];
    for (let i = 0; i < this.n; i++) {
      if (!existsSync(this.path(i, 'done'))) continue;
      const r = await this.check(i);
      if (r.done) {
        this.done[i] = r.done;
        continue;
      }
      redo.push(i);
      this.note({ event: 'segment-redo', index: i, reason: r.reason });
      for (const kind of [...KINDS, 'done']) rmSync(this.path(i, kind), { force: true });
    }
    const kept = this.done.filter(Boolean).length;
    this.note({ event: this.resumed ? 'stage-resume' : 'stage-open', machine: this.label, workers: this.invocation.workers, wallets: this.n, kept, partial: [...partial].sort((a, b) => a - b), redo });
  }

  isDone(i) {
    return this.earlier !== null || this.done[i] !== null;
  }

  // Whether this invocation runs wallet i: one it was given (every wallet
  // when it was given no selection) and not done.
  runs(i) {
    return !this.isDone(i) && (this.mine === null || this.mine.has(i));
  }

  // Wallet i's records, written in its spool directory until complete().
  segment(i) {
    if (!Number.isSafeInteger(i) || i < 0 || i >= this.n) throw new Error(`the stage has no wallet ${i}`);
    if (this.isDone(i)) throw new Error(`wallet ${i}'s segment is done`);
    return new Segment(join(this.spool, String(i)), i);
  }

  // The machine record written without blocking the thread; such writes
  // follow one another, each with the record as it stood when it was asked
  // for.
  saveMachineAsync() {
    const text = jsonText({ label: this.label, invocations: this.invocations });
    this.machineWrite = (this.machineWrite || Promise.resolve()).then(() => writeAtomicAsync(this.machinePath, text));
    return this.machineWrite;
  }

  // Wallet i's segment compressed into segments/, its done file written last,
  // and its spool directory removed. wallet: the records' wallet field;
  // totals: the wallet's counts; start: when the wallet started. The
  // compression, the hashing and the file writes are asynchronous, so a
  // run's other wallets go on while one closes.
  async complete(i, seg, { wallet, totals, start }) {
    seg.close();
    const out = {};
    for (const kind of KINDS) {
      const src = kind === 'records' ? seg.records.path : seg.timings.path;
      out[kind] = await gzipFile(src, `${this.path(i, kind)}.tmp`);
    }
    if (out.records.lines !== seg.n) throw new Error(`wallet ${i}'s segment holds ${out.records.lines} records, not the ${seg.n} written`);
    for (const kind of KINDS) await rename(`${this.path(i, kind)}.tmp`, this.path(i, kind));
    const done = { index: i, wallet, runSha256: this.runSha256, records: out.records, timings: out.timings, counts: seg.counts, totals, machine: this.label, start: start instanceof Date ? start.toISOString() : start, end: new Date().toISOString() };
    await writeAtomicAsync(this.path(i, 'done'), jsonText(done));
    await rm(seg.dir, { recursive: true, force: true });
    this.done[i] = done;
    this.invocation.completed.push(i);
    await this.saveMachineAsync();
    this.note({ event: 'segment-done', index: i, records: seg.n });
    return done;
  }

  // The stage's end: every index from 0 to n-1 must have its done record.
  // The segments' gzip members are joined in index order into
  // records.jsonl.gz and timings.jsonl.gz, the joined streams decompressed
  // and cut at the segments' byte counts must give each segment's SHA-256,
  // and done.json records the joined streams and the totals and counts
  // summed from the segments' done files. The segments are kept. Returns the
  // totals: { wallets, ...the wallets' totals summed }. A stage that had
  // ended returns done.json's totals and counts. A shard (an invocation
  // given a selection) whose directory lacks an index ends without the join:
  // it returns the done wallets' totals summed ({ wallets: the number done,
  // ... }) and sets progress to { done: the done indexes as ranges, count,
  // remaining: the number of indexes not done }.
  async finish() {
    if (this.earlier) {
      this.counts = this.earlier.counts;
      this.ended = true;
      this.invocation.finished = true;
      return this.earlier.totals;
    }
    const missing = [];
    for (let i = 0; i < this.n; i++) if (!this.isDone(i)) missing.push(i);
    if (missing.length && this.mine === null) throw new Error(`refusing: the stage's end needs every wallet's segment; ${missing.length} of ${this.n} have none, the first index ${missing[0]}`);
    rmSync(this.spool, { recursive: true, force: true });
    if (missing.length) {
      const dones = this.done.filter(Boolean);
      const { totals, counts } = sumDone(dones);
      this.counts = counts;
      this.progress = { done: indexRanges(this.done.flatMap((d, i) => (d ? [i] : []))), count: dones.length, remaining: missing.length };
      this.note({ event: 'stage-part', ...this.progress, totals });
      return totals;
    }
    const { totals, counts, records } = await joinStage(this.dir, { runSha256: this.runSha256, dones: this.done, label: this.label });
    this.counts = counts;
    this.ended = true;
    this.invocation.finished = true;
    this.note({ event: 'stage-end', records, totals });
    return totals;
  }

  close() {
    try {
      this.invocation.end = new Date().toISOString();
      this.saveMachine();
      this.log.close();
    } finally {
      this.unlock();
    }
  }
}
