// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// scripts/compare-records.mjs over small hand-built record streams: equal
// streams, a seeded line changed or moved, an unseeded record's content
// changed under equal keys (passes), an unseeded key's count changed (fails),
// each filter, digests, a multi-member gzip, a stage directory as input, the
// unusable inputs and the self-test. No treatment.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'compare-records.mjs');
let root;
let seq = 0;
before(() => { root = mkdtempSync(join(tmpdir(), 'compare-records-')); });
after(() => rmSync(root, { recursive: true, force: true }));

// A record with the key fields the comparison reads.
const rec = (kind, wallet, method, repetition, extra = {}) => ({ kind, wallet, window: 'synthetic', arm: 'observed', variant: 'default', method, change: 'default', collateral: 'ledger', repetition, ...extra });
const spend = (wallet, method, repetition, intent, extra = {}) => rec('spend', wallet, method, repetition, { intent, outcome: 'built', fee: '168317', size: 289, ...extra });

// Two wallets, one seeded method (csl-lf), the two unseeded ones, repetitions 1 to 3 for the random methods.
function stream() {
  const out = [];
  for (const wallet of ['S1', 'S6']) {
    out.push(rec('wallet-arm', wallet, 'csl-lf', 1), rec('burst', wallet, 'csl-lf', 1, { id: 'b' }));
    for (const intent of [0, 1, 2]) out.push(spend(wallet, 'csl-lf', 1, intent));
    for (const method of ['csl-ri', 'cml-ri']) {
      for (const r of [1, 2, 3]) {
        out.push(rec('wallet-arm', wallet, method, r), rec('burst', wallet, method, r, { id: 'b' }));
        for (const intent of [0, 1]) out.push(spend(wallet, method, r, intent, { fee: `${170000 + r * 7}` }));
      }
    }
    out.push(rec('refused', wallet, 'csl-lf', 1, { reason: 'x' }));
  }
  return out;
}

const text = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
function file(records, { gz = false, name } = {}) {
  const p = join(root, name || `s${seq++}.jsonl${gz ? '.gz' : ''}`);
  writeFileSync(p, gz ? gzipSync(text(records)) : text(records));
  return p;
}
function run(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch { /* an unusable input prints nothing */ }
  return { code: r.status, out, err: r.stderr };
}
const edit = (records, fn) => records.map((r) => fn({ ...r }));

test('equal streams: plain, gzipped and a stage directory give equal and exit 0', () => {
  const base = stream();
  const dir = join(root, 'stage');
  mkdirSync(dir);
  writeFileSync(join(dir, 'records.jsonl.gz'), gzipSync(text(base)));
  for (const b of [file(base), file(base, { gz: true }), dir]) {
    const r = run(file(base), b);
    assert.equal(r.code, 0, b);
    assert.equal(r.out.result, 'equal');
    assert.equal(r.out.seeded.differing, 0);
    assert.equal(r.out.seeded.first, null);
    assert.equal(r.out.seeded.compared, 2 * (1 + 1 + 3 + 1));
    assert.deepEqual(r.out.kinds.reference, r.out.kinds.candidate);
    assert.equal(r.out.unseeded.lines.reference, 2 * 2 * 3 * 4);
    assert.equal(r.out.unseeded.keys.reference, 2 * 2 * 3 * 4);
  }
});

test('one seeded line changed: DIFFERENT, exit 1, the first difference by line, key, intent and field names only', () => {
  const base = stream();
  const changed = edit(base, (r) => (r.wallet === 'S6' && r.kind === 'spend' && r.method === 'csl-lf' && r.intent === 1 ? { ...r, fee: '168318', size: 290 } : r));
  const r = run(file(base), file(changed));
  assert.equal(r.code, 1);
  assert.equal(r.out.result, 'DIFFERENT');
  assert.equal(r.out.seeded.differing, 1);
  const first = r.out.seeded.first;
  assert.deepEqual(first.fields, ['fee', 'size']);
  assert.equal(first.intent, 1);
  assert.deepEqual(first.key, ['spend', 'S6', 'synthetic', 'observed', 'default', 'csl-lf', 'default', 'ledger', 1, 1]);
  // S1 has six seeded lines (wallet-arm, burst, three spends, refused); S6's intent 1 is its fourth.
  assert.equal(first.seededLine, 6 + 4);
  assert.equal(JSON.stringify(first).includes('168318'), false, 'no values');
});

test('a seeded line reordered, dropped or added is DIFFERENT', () => {
  const base = stream();
  const swapped = [...base];
  [swapped[2], swapped[3]] = [swapped[3], swapped[2]];
  assert.equal(run(file(base), file(swapped)).code, 1);
  const dropped = base.filter((r) => !(r.method === 'csl-lf' && r.kind === 'spend' && r.wallet === 'S1' && r.intent === 2));
  const d = run(file(base), file(dropped));
  assert.equal(d.out.result, 'DIFFERENT');
  assert.ok(d.out.seeded.differing >= 1);
  const added = [...base, spend('S1', 'csl-lf', 1, 9)];
  const a = run(file(base), file(added));
  assert.equal(a.out.result, 'DIFFERENT');
  assert.equal(a.out.seeded.first.onlyIn, 'candidate');
});

test('an unseeded record whose content changed under equal keys passes, for csl-ri and cml-ri', () => {
  const base = stream();
  const changed = edit(base, (r) => (r.method === 'csl-ri' || r.method === 'cml-ri' ? { ...r, fee: '1', outcome: 'failed', extra: 'x' } : r));
  const r = run(file(base), file(changed));
  assert.equal(r.code, 0);
  assert.equal(r.out.result, 'equal');
  assert.equal(r.out.unseeded.equal, true);
});

test('an unseeded key whose count changed fails: a record dropped, added or duplicated, or a key renamed', () => {
  const base = stream();
  for (const method of ['csl-ri', 'cml-ri']) {
    const at = base.findIndex((r) => r.method === method && r.kind === 'spend');
    for (const [name, list] of [
      ['dropped', base.filter((_r, i) => i !== at)],
      ['duplicated', [...base.slice(0, at + 1), base[at], ...base.slice(at + 1)]],
      ['added key', [...base, spend('S1', method, 4, 0)]],
      ['intent changed', base.map((r, i) => (i === at ? { ...r, intent: 7 } : r))],
      ['repetition changed', base.map((r, i) => (i === at ? { ...r, repetition: 9 } : r))]
    ]) {
      const r = run(file(base), file(list));
      assert.equal(r.code, 1, `${method} ${name}`);
      assert.equal(r.out.unseeded.equal, false, `${method} ${name}`);
      assert.equal(r.out.seeded.differing, 0, `${method} ${name}: the seeded lines are unchanged`);
    }
  }
  for (const kind of ['wallet-arm', 'burst']) {
    const at = base.findIndex((r) => r.method === 'csl-ri' && r.kind === kind);
    assert.equal(run(file(base), file(base.filter((_r, i) => i !== at))).code, 1, kind);
  }
});

test('--wallets keeps only the named wallets on both sides', () => {
  const base = stream();
  const changed = edit(base, (r) => (r.wallet === 'S6' && r.kind === 'spend' && r.method === 'csl-lf' ? { ...r, fee: '9' } : r));
  assert.equal(run(file(base), file(changed)).code, 1);
  const s1 = run(file(base), file(changed), '--wallets', 'S1');
  assert.equal(s1.code, 0);
  assert.deepEqual(s1.out.filters, { wallets: ['S1'], maxRepetition: null });
  assert.equal(s1.out.linesKept.reference, s1.out.linesRead.reference / 2);
  assert.equal(run(file(base), file(changed), '--wallets', 'S1,S6').code, 1);
  assert.equal(run(file(base), file(changed), '--wallets', 'S6').code, 1);
  assert.equal(run(file(base), file(changed), '--wallets', 'NOPE').code, 2);
});

test('--max-repetition drops the records above it on both sides, and keeps those with no repetition number', () => {
  const base = stream();
  const rep3 = edit(base, (r) => (r.method === 'csl-ri' && r.repetition === 3 ? { ...r, repetition: 4 } : r));
  assert.equal(run(file(base), file(rep3)).code, 1);
  const r = run(file(base), file(rep3), '--max-repetition', '2');
  assert.equal(r.code, 0);
  assert.equal(r.out.linesKept.reference < r.out.linesRead.reference, true);
  // A seeded record of repetition 1 is kept by --max-repetition 1, and a record whose repetition is not a number too.
  const odd = edit(base, (r) => (r.kind === 'burst' && r.method === 'csl-lf' ? { ...r, repetition: null } : r));
  const o = run(file(odd), file(odd), '--max-repetition', '1');
  assert.equal(o.out.kinds.reference.burst, 2 + 2 * 2);
  assert.equal(run(file(base), file(base), '--max-repetition', '0').code, 2);
});

test('digests: written from a stream, compared against a stream and a changed stream, and refused under other filters', () => {
  const base = stream();
  const digest = join(root, 'ref.digest.json');
  const w = run(file(base), '--digest-out', digest);
  assert.equal(w.code, 0);
  assert.equal(w.out.result, 'digest-written');
  assert.equal(run(file(base, { gz: true }), '--digest', digest).out.result, 'equal');
  const changed = edit(base, (r) => (r.kind === 'spend' && r.method === 'csl-lf' && r.intent === 0 ? { ...r, fee: '5' } : r));
  const d = run(file(changed), '--digest', digest);
  assert.equal(d.code, 1);
  assert.equal(d.out.result, 'DIFFERENT');
  const keys = edit(base, (r) => (r.kind === 'burst' && r.method === 'cml-ri' && r.repetition === 2 ? { ...r, repetition: 5 } : r));
  assert.equal(run(file(keys), '--digest', digest).code, 1);
  const unseededContent = edit(base, (r) => (r.method === 'csl-ri' ? { ...r, fee: '3' } : r));
  assert.equal(run(file(unseededContent), '--digest', digest).code, 0);
  assert.equal(run(file(base), '--digest', digest, '--wallets', 'S1').code, 2);
  // The two-stream form writes the reference's digest too, equal to the one-stream form's.
  const both = join(root, 'both.digest.json');
  run(file(base), file(base), '--digest-out', both);
  assert.deepEqual(JSON.parse(readFile(both)), JSON.parse(readFile(digest)));
  // A digest written under a filter compares under the same filter.
  const f = join(root, 'f.digest.json');
  run(file(base), '--digest-out', f, '--wallets', 'S1');
  assert.equal(run(file(changed), '--digest', f, '--wallets', 'S1').code, 1);
  assert.equal(run(file(base), '--digest', f, '--wallets', 'S1').code, 0);
  assert.equal(run(file(base), '--digest', join(root, 'missing.json')).code, 2);
});
const readFile = (p) => readFileSync(p, 'utf8');

test('a gzip of several members is read whole', () => {
  const base = stream();
  const cut = 17;
  const p = join(root, 'multi.jsonl.gz');
  writeFileSync(p, Buffer.concat([gzipSync(text(base.slice(0, cut))), gzipSync(text(base.slice(cut, 30))), gzipSync(text(base.slice(30)))]));
  const r = run(file(base), p);
  assert.equal(r.code, 0);
  assert.equal(r.out.linesRead.candidate, base.length);
  // A stage directory whose records are a multi-member gzip too.
  const dir = join(root, 'stage-multi');
  mkdirSync(dir);
  writeFileSync(join(dir, 'records.jsonl.gz'), readFileSync(p));
  assert.equal(run(dir, file(base)).code, 0);
});

test('unusable input exits 2 and prints nothing: missing, empty, no unseeded record, a stage without joined records, bad JSON, bad options', () => {
  const base = stream();
  const refuse = (...args) => {
    const r = run(...args);
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.out, null);
    assert.ok(r.err.startsWith('compare-records:'), r.err);
  };
  refuse(file(base), join(root, 'missing.jsonl'));
  refuse(file(base), file([]));
  refuse(file([]), file(base));
  refuse(file(base), file(base.filter((r) => r.method === 'csl-lf')));
  refuse(file(base.filter((r) => r.method === 'csl-lf')), file(base));
  // cml-ri alone is enough to count.
  assert.equal(run(file(base.filter((r) => r.method !== 'csl-ri')), file(base.filter((r) => r.method !== 'csl-ri'))).code, 0);
  const empty = join(root, 'stage-empty');
  mkdirSync(empty);
  refuse(file(base), empty);
  const bad = join(root, 'bad.jsonl');
  writeFileSync(bad, '{"kind":"spend"\n');
  refuse(file(base), bad);
  const trunc = join(root, 'trunc.jsonl.gz');
  writeFileSync(trunc, gzipSync(text(base)).subarray(0, 40));
  refuse(file(base), trunc);
  refuse(file(base));
  refuse(file(base), file(base), '--nope');
  refuse(file(base), file(base), '--max-repetition', 'x');
  refuse(file(base), file(base), '--wallets');
});

test('the self-test: an unchanged copy is equal, a changed fee and a dropped unseeded spend record are each DIFFERENT', () => {
  const r = run('--self-test', file(stream(), { gz: true }));
  assert.equal(r.code, 0);
  assert.deepEqual([r.out.unchanged, r.out.feeChanged, r.out.unseededDropped, r.out.result], ['equal', 'DIFFERENT', 'DIFFERENT', 'passed']);
  // A numeric fee is changed too, and a stream with nothing to change is unusable.
  const numeric = edit(stream(), (x) => (x.kind === 'spend' && x.method === 'csl-lf' ? { ...x, fee: 168317 } : x));
  assert.equal(run('--self-test', file(numeric)).out.result, 'passed');
  assert.equal(run('--self-test', file(stream().filter((x) => x.kind !== 'spend' || x.method !== 'csl-lf'))).code, 2);
  assert.equal(run('--self-test', file(stream().filter((x) => x.kind !== 'spend' || x.method === 'csl-lf'))).code, 2);
});
