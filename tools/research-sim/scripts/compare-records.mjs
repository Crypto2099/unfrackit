#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The equality check of the machine-independence proof: two record streams
// that must agree, compared record by record. A stream is a replay stage
// directory (its joined records.jsonl.gz), a records.jsonl.gz (every gzip
// member is read) or a records.jsonl.
//
// Compared byte for byte, in order: every record line except those of the
// unseeded methods, the library table's `seeded: false` rows (csl-ri and
// cml-ri, whose selection draws from a generator no caller can seed). Those
// are compared by key and count: their wallet-arm, refused and burst records
// by (kind, wallet, window, arm, variant, method, change, collateral,
// repetition) and their spend records by that key plus the intent. What an
// unseeded record holds is not compared.
//
//   node scripts/compare-records.mjs <reference> <candidate> [filters] [--digest-out <file>]
//   node scripts/compare-records.mjs <stream> --digest <file>
//   node scripts/compare-records.mjs <stream> --digest-out <file>
//   node scripts/compare-records.mjs --self-test <stream>
//
// Filters, applied to both sides (a digest remembers the filters it was
// written under and is compared only under the same ones):
//   --wallets <a,b,...>     only the records of these wallets
//   --max-repetition <n>    drop the records of a repetition above n
//
// Prints one JSON line. Exit 0: equal (or the digest written, or the
// self-test passed); 1: DIFFERENT (or the self-test failed); 2: unusable
// input (a missing or empty stream, a stream with no unseeded key, a bad
// option), with the reason on stderr.

import { createReadStream, createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { LIBRARY_TABLE } from '../src/arms/plan.mjs';

export const UNSEEDED = new Set(LIBRARY_TABLE.filter((r) => !r.seeded).map((r) => r.method));
const COUNTED = new Set(['wallet-arm', 'refused', 'burst', 'spend']);
const DIGEST_FORMAT = 'compare-records-digest-1';

export class Unusable extends Error {}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// The file a stream argument names: a stage directory's joined records.
function resolveInput(arg) {
  if (!existsSync(arg)) throw new Unusable(`${arg} does not exist`);
  if (statSync(arg).isDirectory()) {
    const f = join(arg, 'records.jsonl.gz');
    if (!existsSync(f)) throw new Unusable(`${arg} holds no records.jsonl.gz (a stage that has not ended has not joined its records)`);
    return f;
  }
  return arg;
}

function gzipped(file) {
  const fd = openSync(file, 'r');
  try {
    const b = Buffer.alloc(2);
    return readSync(fd, b, 0, 2, 0) === 2 && b[0] === 0x1f && b[1] === 0x8b;
  } finally {
    closeSync(fd);
  }
}

async function* linesOf(file) {
  const raw = createReadStream(file);
  const input = gzipped(file) ? raw.pipe(createGunzip()) : raw;
  raw.on('error', (e) => input.destroy(e));
  for await (const l of createInterface({ input, crlfDelay: Infinity })) if (l) yield l;
}

export const keyOf = (r) => JSON.stringify([r.kind, r.wallet, r.window, r.arm, r.variant, r.method, r.change, r.collateral, r.repetition, ...(r.kind === 'spend' ? [r.intent ?? null] : [])]);

function keeps(r, filters) {
  if (filters.wallets && !filters.wallets.includes(String(r.wallet))) return false;
  if (filters.maxRepetition !== null && typeof r.repetition === 'number' && r.repetition > filters.maxRepetition) return false;
  return true;
}

// One side: the seeded lines in order (an async iterator) and the numbers
// gathered while it runs, final once it is drained.
function side(file, filters) {
  const st = { read: 0, kept: 0, kinds: {}, seededLines: 0, seededHash: createHash('sha256'), unseededLines: 0, unseeded: new Map() };
  async function* seeded() {
    for await (const l of linesOf(file)) {
      st.read++;
      let r;
      try {
        r = JSON.parse(l);
      } catch {
        throw new Unusable(`${file}: line ${st.read} is not JSON`);
      }
      if (!keeps(r, filters)) continue;
      st.kept++;
      st.kinds[r.kind] = (st.kinds[r.kind] || 0) + 1;
      if (UNSEEDED.has(r.method)) {
        st.unseededLines++;
        if (COUNTED.has(r.kind)) {
          const k = keyOf(r);
          st.unseeded.set(k, (st.unseeded.get(k) || 0) + 1);
        }
        continue;
      }
      st.seededLines++;
      st.seededHash.update(`${l}\n`);
      yield l;
    }
  }
  return { iter: seeded()[Symbol.asyncIterator](), st };
}

const sortedCounts = (m) => [...m].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

// What a side comes to once drained, as the digest keeps it.
function summary(st) {
  return {
    linesRead: st.read,
    linesKept: st.kept,
    kinds: Object.fromEntries(Object.entries(st.kinds).sort()),
    seeded: { lines: st.seededLines, sha256: st.seededHash.copy().digest('hex') },
    unseeded: { lines: st.unseededLines, keys: st.unseeded.size, keyCountsSha256: sha256(JSON.stringify(sortedCounts(st.unseeded))) }
  };
}

function requireUsable(name, s) {
  if (s.linesKept === 0) throw new Unusable(`${name} has no records${s.linesRead ? ' after the filters' : ''}`);
  if (s.unseeded.keys === 0) throw new Unusable(`${name} has no record of an unseeded method (${[...UNSEEDED].join(', ')}), so the check of those would compare nothing`);
}

function differingFields(la, lb) {
  if (la === undefined || lb === undefined) return null;
  const a = JSON.parse(la);
  const b = JSON.parse(lb);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
}

const filtersOut = (f) => ({ wallets: f.wallets, maxRepetition: f.maxRepetition });

// Two streams compared. Returns the result line (an object).
export async function compareStreams(argA, argB, filters) {
  const fa = resolveInput(argA);
  const fb = resolveInput(argB);
  const A = side(fa, filters);
  const B = side(fb, filters);
  let compared = 0;
  let differing = 0;
  let first = null;
  for (;;) {
    const [a, b] = await Promise.all([A.iter.next(), B.iter.next()]);
    if (a.done && b.done) break;
    compared++;
    if (a.done || b.done || a.value !== b.value) {
      differing++;
      if (!first) {
        const ra = a.done ? null : JSON.parse(a.value);
        const rb = b.done ? null : JSON.parse(b.value);
        const r = ra || rb;
        first = { seededLine: compared, key: JSON.parse(keyOf(r)), intent: r.intent ?? null, onlyIn: a.done ? 'candidate' : b.done ? 'reference' : null, fields: differingFields(a.value, b.value) };
      }
    }
  }
  const sa = summary(A.st);
  const sb = summary(B.st);
  requireUsable('the reference', sa);
  requireUsable('the candidate', sb);
  const seededEqual = differing === 0 && sa.seeded.sha256 === sb.seeded.sha256;
  const unseededEqual = sa.unseeded.keyCountsSha256 === sb.unseeded.keyCountsSha256;
  return {
    reference: argA,
    candidate: argB,
    filters: filtersOut(filters),
    linesRead: { reference: sa.linesRead, candidate: sb.linesRead },
    linesKept: { reference: sa.linesKept, candidate: sb.linesKept },
    seeded: { compared, differing, first, sha256: { reference: sa.seeded.sha256, candidate: sb.seeded.sha256 } },
    kinds: { reference: sa.kinds, candidate: sb.kinds },
    unseeded: { lines: { reference: sa.unseeded.lines, candidate: sb.unseeded.lines }, keys: { reference: sa.unseeded.keys, candidate: sb.unseeded.keys }, keyCountsSha256: { reference: sa.unseeded.keyCountsSha256, candidate: sb.unseeded.keyCountsSha256 }, equal: unseededEqual },
    _summaries: { a: sa, b: sb },
    result: seededEqual && unseededEqual ? 'equal' : 'DIFFERENT'
  };
}

async function drain(file, filters) {
  const s = side(file, filters);
  while (!(await s.iter.next()).done);
  return summary(s.st);
}

const digestOf = (s, filters) => ({ format: DIGEST_FORMAT, filters: filtersOut(filters), ...s });

// A stream against a digest an earlier run wrote.
export async function compareToDigest(arg, digestFile, filters) {
  const f = resolveInput(arg);
  let d;
  try {
    d = JSON.parse(readFileSync(digestFile, 'utf8'));
  } catch (e) {
    throw new Unusable(`${digestFile}: ${e.message}`);
  }
  if (d.format !== DIGEST_FORMAT) throw new Unusable(`${digestFile} is not a ${DIGEST_FORMAT} file`);
  if (JSON.stringify(d.filters) !== JSON.stringify(filtersOut(filters))) throw new Unusable(`${digestFile} was written under the filters ${JSON.stringify(d.filters)}, not ${JSON.stringify(filtersOut(filters))}`);
  const s = await drain(f, filters);
  requireUsable('the stream', s);
  const seededEqual = s.seeded.lines === d.seeded.lines && s.seeded.sha256 === d.seeded.sha256;
  const unseededEqual = s.unseeded.keyCountsSha256 === d.unseeded.keyCountsSha256;
  return {
    stream: arg,
    digest: digestFile,
    filters: filtersOut(filters),
    linesKept: { stream: s.linesKept, digest: d.linesKept },
    seeded: { lines: { stream: s.seeded.lines, digest: d.seeded.lines }, sha256: { stream: s.seeded.sha256, digest: d.seeded.sha256 } },
    kinds: { stream: s.kinds, digest: d.kinds },
    unseeded: { lines: { stream: s.unseeded.lines, digest: d.unseeded.lines }, keys: { stream: s.unseeded.keys, digest: d.unseeded.keys }, keyCountsSha256: { stream: s.unseeded.keyCountsSha256, digest: d.unseeded.keyCountsSha256 }, equal: unseededEqual },
    result: seededEqual && unseededEqual ? 'equal' : 'DIFFERENT'
  };
}

// The negative control. Three copies of a stream, written decompressed to a
// temporary directory: one unchanged (must compare equal), one with a digit
// of a seeded spend record's fee changed and one with an unseeded spend
// record dropped (each must compare DIFFERENT).
export async function selfTest(arg) {
  const file = resolveInput(arg);
  const noFilters = { wallets: null, maxRepetition: null };
  let feeAt = -1;
  let dropAt = -1;
  let n = 0;
  for await (const l of linesOf(file)) {
    const i = n++;
    if (feeAt >= 0 && dropAt >= 0) break;
    const r = JSON.parse(l);
    if (r.kind !== 'spend') continue;
    if (UNSEEDED.has(r.method)) {
      if (dropAt < 0) dropAt = i;
    } else if (feeAt < 0 && /"fee":"?\d/.test(l)) feeAt = i;
  }
  if (feeAt < 0) throw new Unusable(`${arg} has no seeded spend record with a fee to change`);
  if (dropAt < 0) throw new Unusable(`${arg} has no unseeded spend record to drop`);
  const dir = mkdtempSync(join(tmpdir(), 'compare-records-self-'));
  try {
    const copy = async (name, edit) => {
      const path = join(dir, name);
      const w = createWriteStream(path);
      let i = 0;
      for await (const l of linesOf(file)) {
        const out = edit(l, i++);
        if (out === null) continue;
        if (!w.write(`${out}\n`)) await once(w, 'drain');
      }
      w.end();
      await once(w, 'finish');
      return path;
    };
    const same = await copy('same.jsonl', (l) => l);
    const fee = await copy('fee.jsonl', (l, i) => (i === feeAt ? l.replace(/("fee":"?\d*)(\d)/, (_m, a, d) => `${a}${(Number(d) + 1) % 10}`) : l));
    const drop = await copy('drop.jsonl', (l, i) => (i === dropAt ? null : l));
    const res = {};
    for (const [name, p] of [['unchanged', same], ['feeChanged', fee], ['unseededDropped', drop]]) res[name] = (await compareStreams(file, p, noFilters)).result;
    const passed = res.unchanged === 'equal' && res.feeChanged === 'DIFFERENT' && res.unseededDropped === 'DIFFERENT';
    return { selfTest: true, source: arg, seededSpendLine: feeAt + 1, unseededSpendLine: dropAt + 1, ...res, result: passed ? 'passed' : 'failed' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseCli(argv) {
  const o = { positional: [], wallets: null, maxRepetition: null, digest: null, digestOut: null, selfTest: null };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Unusable(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--wallets') {
      const w = value(i++, a).split(',').filter(Boolean);
      if (!w.length) throw new Unusable('--wallets takes a comma-separated list of wallets');
      o.wallets = w;
    } else if (a === '--max-repetition') {
      const v = value(i++, a);
      if (!/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(Number(v))) throw new Unusable(`--max-repetition takes a positive whole number, not ${v}`);
      o.maxRepetition = Number(v);
    } else if (a === '--digest') o.digest = value(i++, a);
    else if (a === '--digest-out') o.digestOut = value(i++, a);
    else if (a === '--self-test') o.selfTest = value(i++, a);
    else if (a.startsWith('--')) throw new Unusable(`unknown option ${a}`);
    else o.positional.push(a);
  }
  return o;
}

const USAGE = 'usage: compare-records.mjs <reference> <candidate> [--wallets a,b] [--max-repetition n] [--digest-out file] | <stream> --digest <file> | <stream> --digest-out <file> | --self-test <stream>';

export async function main(argv) {
  const o = parseCli(argv);
  const filters = { wallets: o.wallets, maxRepetition: o.maxRepetition };
  let out;
  if (o.selfTest) {
    if (o.positional.length || o.digest || o.digestOut) throw new Unusable(USAGE);
    out = await selfTest(o.selfTest);
    return { out, code: out.result === 'passed' ? 0 : 1 };
  }
  if (o.digest) {
    if (o.positional.length !== 1 || o.digestOut) throw new Unusable(USAGE);
    out = await compareToDigest(o.positional[0], o.digest, filters);
  } else if (o.positional.length === 2) {
    out = await compareStreams(o.positional[0], o.positional[1], filters);
    if (o.digestOut) writeFileSync(resolve(o.digestOut), `${JSON.stringify(digestOf(out._summaries.a, filters), null, 2)}\n`);
    delete out._summaries;
  } else if (o.positional.length === 1 && o.digestOut) {
    const s = await drain(resolveInput(o.positional[0]), filters);
    requireUsable('the stream', s);
    writeFileSync(resolve(o.digestOut), `${JSON.stringify(digestOf(s, filters), null, 2)}\n`);
    out = { stream: o.positional[0], filters: filtersOut(filters), digestWritten: resolve(o.digestOut), ...s, result: 'digest-written' };
    return { out, code: 0 };
  } else throw new Unusable(USAGE);
  return { out, code: out.result === 'equal' ? 0 : 1 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { out, code } = await main(process.argv.slice(2));
    console.log(JSON.stringify(out));
    process.exitCode = code;
  } catch (e) {
    if (!(e instanceof Unusable) && e.code !== 'ENOENT' && e.code !== 'Z_DATA_ERROR' && e.code !== 'Z_BUF_ERROR') throw e;
    console.error(`compare-records: ${e.message}`);
    process.exitCode = 2;
  }
}
