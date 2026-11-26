// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The merge-stage command: the shards of one replay stage, written on
// several machines (out/stage.mjs, replay/shards.mjs), joined into one
// stage whose decompressed records are those of one uninterrupted run.
//
//   merge-stage --into <dir> [--machine <label>] <source dir>...
//
// The target is a replay stage's directory, or a new or empty one, which
// takes the sources' run.json and wallets.json. Before anything is written:
//   - every place (the target and each source) holds a stage whose
//     wallets.json is the one its run.json names, and every source's
//     run.json and wallets.json are byte for byte the target's (or the first
//     source's), else the merge is refused naming the fields that differ;
//   - a source that a running process holds is refused;
//   - every segment of every place is checked as a resume checks it: its
//     done file names this run.json and the index, and both files decompress
//     to the SHA-256 and byte count it records;
//   - an index in more than one place is refused unless the copies'
//     decompressed records and timing rows have equal SHA-256 (a run's
//     timing rows differ from any other run's, and an unseeded selector's
//     records too): the operator deletes one copy;
//   - every index from 0 to N-1 must be in some place;
//   - a machine record (machines/<label>.json or <label>.log.jsonl) in two
//     places with different bytes is refused, and so is a merge under a
//     label that only a source carries.
// Then the target gains the segments it lacks, copied (each file under a
// temporary name, flushed and renamed, the done file last), and the machine
// records it lacks, the stage's end runs (the segments joined in index
// order, checked against their done files, done.json written last), and the
// merge is recorded under this machine's label. The sources are only read.

import { existsSync, readFileSync, readdirSync, copyFileSync, renameSync, rmSync, chmodSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureDir, JsonLines } from '../history/paths.mjs';
import { takeLock, lockHolder } from './lock.mjs';
import { machineLabel } from '../options.mjs';
import { machineFacts } from './host.mjs';
import { checkSegment, joinStage, runDifferences, segmentPath, sha256, jsonText, writeAtomic } from './stage.mjs';

const DONE_FILE = /^(0|[1-9]\d*)\.done\.json$/;
const MACHINE_FILE = /^[A-Za-z0-9_-]{1,64}\.(json|log\.jsonl)$/;
const SEGMENT_KINDS = ['records', 'timings', 'done'];

// A file copied under a temporary name, flushed and renamed.
function copyAtomic(src, dst) {
  const tmp = `${dst}.tmp`;
  copyFileSync(src, tmp);
  const fd = openSync(tmp, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, dst);
}

// A place's stage: its run.json and wallets.json, bytes and parsed; null
// when it has no run.json.
function readPlace(dir, name) {
  const runPath = join(dir, 'run.json');
  if (!existsSync(runPath)) return null;
  const refuse = (what) => new Error(`refusing: ${name}'s ${what} cannot be read`);
  const runText = readFileSync(runPath);
  let run;
  try {
    run = JSON.parse(runText.toString('utf8'));
  } catch {
    throw refuse('run.json');
  }
  let walletsText;
  let wallets;
  try {
    walletsText = readFileSync(join(dir, 'wallets.json'));
    wallets = JSON.parse(walletsText.toString('utf8'));
  } catch {
    throw refuse('wallets.json');
  }
  if (!Array.isArray(wallets)) throw refuse('wallets.json');
  if (sha256(walletsText) !== run.walletsSha256) throw new Error(`refusing: ${name}'s wallets.json is not the one its run.json names`);
  return { dir, name, runText, run, walletsText, wallets };
}

// Merges the sources' segments into the target. into: the target
// directory; sources: the source directories; machine: this machine's label
// (`local` when absent). Returns { dir, wallets, kept, copied, duplicates,
// sources, totals, counts }.
export async function mergeStage({ into, sources = [], machine }) {
  const label = machineLabel(machine);
  if (typeof into !== 'string' || !into) throw new Error('--into <dir> names the stage directory the sources are merged into');
  if (!sources.length) throw new Error('name the source stage directories after the options: merge-stage --into <dir> <source dir>...');
  const target = resolve(into);
  const srcDirs = sources.map((s) => resolve(String(s)));
  if (srcDirs.includes(target)) throw new Error(`refusing: ${target} is the target and a source`);
  if (new Set(srcDirs).size !== srcDirs.length) throw new Error('refusing: a source is named twice');
  const own = existsSync(target) ? readPlace(target, `the target ${target}`) : null;
  if (!own && existsSync(target) && readdirSync(target).length) throw new Error(`refusing: the target ${target} holds files but no run.json; merge into a replay stage's directory or a new or empty one`);
  const srcs = srcDirs.map((d) => {
    if (!existsSync(d)) throw new Error(`refusing: source ${d} does not exist`);
    const p = readPlace(d, `source ${d}`);
    if (!p) throw new Error(`refusing: source ${d} holds no replay stage (no run.json)`);
    const pid = lockHolder(d);
    if (pid) throw new Error(`refusing: process ${pid} is writing source ${d}`);
    return p;
  });
  const places = own ? [own, ...srcs] : srcs;
  const ref = places[0];
  for (const p of places.slice(1)) {
    if (!p.runText.equals(ref.runText)) {
      const diff = runDifferences(ref.run, p.run);
      throw new Error(`refusing: ${p.name}'s run.json differs from ${ref.name}'s${diff.length ? ` in ${diff.join(', ')}` : ' in its bytes'}; only shards of one stage are merged`);
    }
    if (!p.walletsText.equals(ref.walletsText)) throw new Error(`refusing: ${p.name}'s wallets.json differs from ${ref.name}'s; only shards of one stage are merged`);
  }
  const runSha256 = sha256(ref.runText);
  const n = ref.wallets.length;
  let unlock = own ? takeLock(target, { what: 'replay stage' }) : null;
  try {
    // Every place's segments, checked; per index, its copies.
    const copies = new Map();
    for (const p of places) {
      const segs = join(p.dir, 'segments');
      const idx = existsSync(segs) ? readdirSync(segs).filter((f) => DONE_FILE.test(f)).map((f) => Number(DONE_FILE.exec(f)[1])).sort((a, b) => a - b) : [];
      for (const i of idx) {
        if (i >= n) throw new Error(`refusing: ${p.name} holds segment ${i}, beyond the stage's ${n} wallets`);
        const r = await checkSegment(segs, i, runSha256);
        if (!r.done) throw new Error(`refusing: segment ${i} of ${p.name} fails its check: ${r.reason}; nothing was copied`);
        if (!copies.has(i)) copies.set(i, []);
        copies.get(i).push({ place: p, done: r.done });
      }
    }
    let duplicates = 0;
    for (const [i, cs] of [...copies.entries()].sort((a, b) => a[0] - b[0])) {
      for (const c of cs.slice(1)) {
        if (c.done.records.sha256 !== cs[0].done.records.sha256 || c.done.timings.sha256 !== cs[0].done.timings.sha256) {
          throw new Error(`refusing: wallet index ${i} is in ${cs[0].place.name} and ${c.place.name} with different records or timing rows (the timing rows of two runs always differ, and an unseeded selector's records too); keep one copy, deleting segments/${i}.records.jsonl.gz, ${i}.timings.jsonl.gz and ${i}.done.json from the other, and merge again`);
        }
        duplicates++;
      }
    }
    const missing = [];
    for (let i = 0; i < n; i++) if (!copies.has(i)) missing.push(i);
    if (missing.length) throw new Error(`refusing: the merged stage would lack ${missing.length} of ${n} wallets, the first index ${missing[0]}; run the shards that hold them and merge again`);
    // The machine records: one content per file name.
    const records = new Map();
    for (const p of places) {
      const md = join(p.dir, 'machines');
      if (!existsSync(md)) continue;
      for (const f of readdirSync(md).sort()) {
        if (!MACHINE_FILE.test(f)) continue;
        const bytes = readFileSync(join(md, f));
        const was = records.get(f);
        if (!was) records.set(f, { place: p, bytes });
        else if (!was.bytes.equals(bytes)) throw new Error(`refusing: the machine record ${f} is in ${was.place.name} and ${p.name} with different contents; each machine writes under a label of its own (--machine)`);
      }
    }
    const mine = [`${label}.json`, `${label}.log.jsonl`];
    if (mine.some((f) => records.has(f) && records.get(f).place !== own)) throw new Error(`refusing: the label ${label} names a source's machine record; merge under this machine's own label (--machine)`);

    // From here the target is written.
    const start = new Date().toISOString();
    if (!own) {
      ensureDir(target);
      unlock = takeLock(target, { what: 'replay stage' });
      writeAtomic(join(target, 'wallets.json'), ref.walletsText);
      writeAtomic(join(target, 'run.json'), ref.runText);
    }
    // The stage is not done until its end writes done.json again.
    rmSync(join(target, 'done.json'), { force: true });
    const segT = ensureDir(join(target, 'segments'));
    const copied = [];
    for (let i = 0; i < n; i++) {
      const cs = copies.get(i);
      if (cs.some((c) => c.place === own)) continue;
      for (const kind of SEGMENT_KINDS) copyAtomic(segmentPath(join(cs[0].place.dir, 'segments'), i, kind), segmentPath(segT, i, kind));
      copied.push(i);
    }
    const mT = ensureDir(join(target, 'machines'));
    for (const [f, r] of records) if (r.place !== own) copyAtomic(join(r.place.dir, 'machines', f), join(mT, f));
    // The merge's own record under this machine's label.
    const machinePath = join(mT, `${label}.json`);
    let invocations = [];
    try {
      invocations = JSON.parse(readFileSync(machinePath, 'utf8')).invocations || [];
    } catch {
      // the label's first record
    }
    const invocation = { command: 'merge-stage', start, end: null, finished: false, workers: null, selection: null, completed: [], merged: copied, sources: srcs.length, ...machineFacts() };
    const saveMachine = () => writeAtomic(machinePath, jsonText({ label, invocations: [...invocations, invocation] }));
    saveMachine();
    const log = new JsonLines(join(mT, `${label}.log.jsonl`), { append: true });
    try {
      log.write({ at: new Date().toISOString(), event: 'stage-merge', machine: label, wallets: n, sources: srcs.length, kept: n - copied.length, copied: copied.length, duplicates });
      rmSync(join(target, 'spool'), { recursive: true, force: true });
      const dones = Array.from({ length: n }, (_x, i) => copies.get(i)[0].done);
      const end = await joinStage(target, { runSha256, dones, label });
      log.write({ at: new Date().toISOString(), event: 'stage-end', records: end.records, totals: end.totals });
      invocation.finished = true;
      invocation.end = new Date().toISOString();
      saveMachine();
      return { dir: target, wallets: n, kept: n - copied.length, copied: copied.length, duplicates, sources: srcs.length, totals: end.totals, counts: end.counts };
    } finally {
      log.close();
    }
  } finally {
    if (unlock) unlock();
  }
}

export async function cmdMergeStage(opts) {
  const r = await mergeStage({ into: opts.into, sources: opts._ || [], machine: opts.machine });
  return { print: { command: 'merge-stage', dir: r.dir, wallets: r.wallets, kept: r.kept, copied: r.copied, duplicates: r.duplicates, sources: r.sources, totals: r.totals, records: r.counts }, failed: !!(r.totals.validity && r.totals.validity.failed) };
}
