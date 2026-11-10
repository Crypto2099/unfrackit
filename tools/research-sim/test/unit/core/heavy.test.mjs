// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The heavy synthetic wallets (src/shapes/heavy.mjs): the name grammar, the
// same wallet and stream from the same name, the exact UTxO and event counts
// and the composition, the stream's rules (time order, burst and script
// cadence, no token sent twice, ADA left for every payment), and, with the
// treatment, every intent of a small and a large heavy wallet built by
// test-largest-first with the validity checks on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { treatment, skip } from '../../lib/treatment.mjs';
import { parseHeavyName, isHeavyName, NFT_POLICY_SIZE, FT_PIECES, FT_ASSETS_PER_POLICY, PURE_ADA_SHARE } from '../../../src/shapes/heavy.mjs';
import { shapeState, shapeSettings, variantsOf, SHAPE_NAMES } from '../../../src/shapes/shapes.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { makeMethod } from '../../../src/methods/registry.mjs';
import { replay } from '../../../src/replay/engine.mjs';

test('the name grammar: thousands of UTxOs, thousands of events, a leading zero for a fraction', () => {
  assert.deepEqual(parseHeavyName('H20E05'), { k: 20, events: 500 });
  assert.deepEqual(parseHeavyName('H3E6'), { k: 3, events: 6000 });
  assert.deepEqual(parseHeavyName('H20E1'), { k: 20, events: 1000 });
  assert.deepEqual(parseHeavyName('H20E01'), { k: 20, events: 100 });
  assert.deepEqual(parseHeavyName('H1E005'), { k: 1, events: 50 });
  assert.deepEqual(parseHeavyName('H30E12'), { k: 30, events: 12000 });
  for (const bad of ['H0E5', 'H31E5', 'H20E0', 'H20E00', 'H20E000', 'H20E', 'H20', 'h20E5', 'H20E5x', 'S1', 'H1E0001', 'H020E5']) assert.equal(parseHeavyName(bad), null, bad);
  assert.equal(isHeavyName('H3E6'), true);
  assert.equal(isHeavyName('M3'), false);
  for (const n of SHAPE_NAMES) assert.equal(isHeavyName(n), false, `${n} is a fixed shape`);
});

const T = await treatment();

const digest = (x) => createHash('sha256').update(JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v instanceof Map ? [...v] : v))).digest('hex');

// A heavy wallet's source with its synthetic stream, without the cache the
// replay's loader keeps.
const sourceOf = (name) => loadSource(T, { kind: 'shape', name, stream: 'synthetic' });

test('the same name gives the same wallet and the same stream, a different name another', { skip }, () => {
  const a = shapeState(T, 'H1E02');
  const b = shapeState(T, 'H1E02');
  assert.deepEqual(a.order, b.order);
  assert.equal(digest(a.hex), digest(b.hex));
  assert.equal(digest(sourceOf('H1E02').events), digest(sourceOf('H1E02').events));
  const other = shapeState(T, 'H1E03');
  assert.notEqual(digest(a.hex), digest(other.hex));
  assert.notEqual(digest(sourceOf('H1E02').events), digest(sourceOf('H1E03').events));
  assert.throws(() => shapeState(T, 'H0E1'), /not a heavy wallet name|unknown shape/);
});

test('the wallet has exactly k thousand UTxOs: 1% pure ADA, 85% non-fungible in policies of 100, 15% fungible', { skip }, () => {
  for (const name of ['H1E02', 'H3E01', 'H20E01']) {
    const { k } = parseHeavyName(name);
    const s = shapeState(T, name);
    const us = [...s.state.utxos.values()];
    assert.equal(us.length, k * 1000, name);
    assert.equal(s.order.length, k * 1000);
    const pure = us.filter((u) => u.assets.length === 0);
    assert.equal(pure.length, Math.round(k * 1000 * PURE_ADA_SHARE), name);
    const rest = us.length - pure.length;
    const nft = us.filter((u) => u.assets.length === 1 && u.assets[0].qty === 1n);
    const ft = us.filter((u) => u.assets.length === 1 && u.assets[0].qty > 1n);
    assert.equal(nft.length + ft.length, rest, 'one token per token UTxO');
    assert.equal(ft.length, Math.round(rest * 0.15), name);
    const perPolicy = new Map();
    for (const u of nft) perPolicy.set(u.assets[0].policy, (perPolicy.get(u.assets[0].policy) || 0) + 1);
    const sizes = [...perPolicy.values()].sort((x, y) => x - y);
    assert.equal(sizes.at(-1), NFT_POLICY_SIZE);
    assert.equal(sizes.filter((n) => n !== NFT_POLICY_SIZE).length <= 1, true, 'at most one short policy');
    const pieces = new Map();
    for (const u of ft) pieces.set(`${u.assets[0].policy}.${u.assets[0].name}`, (pieces.get(`${u.assets[0].policy}.${u.assets[0].name}`) || 0) + 1);
    assert.equal(Math.max(...pieces.values()), FT_PIECES);
    assert.equal(pieces.size, Math.ceil(ft.length / FT_PIECES));
    const ftPolicies = new Set(ft.map((u) => u.assets[0].policy));
    assert.equal(ftPolicies.size, Math.ceil(pieces.size / FT_ASSETS_PER_POLICY));
    assert.equal(new Set(us.map((u) => u.ref)).size, us.length, 'unique references');
    assert.equal(new Set(us.map((u) => u.address)).size, 1, 'one address');
    assert.ok(pure.every((u) => u.coin >= 20000000n && u.coin <= 100000000n));
    assert.deepEqual(variantsOf(name), ['default', 'isolation', 'maxUnlock']);
    assert.deepEqual(shapeSettings(name), {});
  }
});

test('the stream has exactly e thousand events, in time order, with the cadence of bursts, script spends, deposits and marks', { skip }, () => {
  for (const name of ['H1E01', 'H1E05', 'H3E1', 'H1E005']) {
    const { events: total } = parseHeavyName(name);
    const src = sourceOf(name);
    const ev = src.events;
    assert.equal(ev.length, total, name);
    const time = (e) => (e.kind === 'intent' ? e.intent.time.blockTime : e.kind === 'mark' ? e.blockTime : e.time.blockTime);
    for (let i = 1; i < ev.length; i++) assert.ok(time(ev[i]) >= time(ev[i - 1]), `${name}: event ${i} is before the one before`);
    assert.equal(src.windowEnd, Math.max(30, Math.ceil(total / 12)) * 86400);
    assert.ok(time(ev.at(-1)) < src.windowEnd);
    const intents = ev.filter((e) => e.kind === 'intent').map((e) => e.intent);
    const deposits = ev.filter((e) => e.kind === 'deposit');
    const marks = ev.filter((e) => e.kind === 'mark');
    assert.equal(intents.length + deposits.length + marks.length, total);
    assert.deepEqual(marks.map((e) => e.n), marks.map((_, i) => i + 1));
    // A mark falls at each multiple of 30 days, in the first slot at or after it.
    const lastSlot = 1 + Math.floor(((total - 1) * (src.windowEnd - 1)) / total);
    const due = Math.floor(lastSlot / (30 * 86400));
    assert.ok(marks.length === due || marks.length === due - 1, `${name}: ${marks.length} marks, ${due} due`);
    marks.forEach((m, i) => assert.ok(m.blockTime >= (i + 1) * 30 * 86400 && m.blockTime < (i + 1) * 30 * 86400 + 2 * 86400));
    // A deposit after every 8 intents.
    assert.ok(Math.abs(deposits.length - Math.floor(intents.length / 8)) <= 1, `${name}: ${deposits.length} deposits for ${intents.length} intents`);
    // A burst pair at every 50th intent, 30 seconds apart; a script spend at the 25th of every 100.
    const bursts = intents.filter((i) => i.burst);
    assert.equal(bursts.length % 2, 0);
    for (let i = 0; i < bursts.length; i += 2) {
      assert.equal(bursts[i].burst.index, 0);
      assert.equal(bursts[i + 1].burst.index, 1);
      assert.equal(bursts[i].burst.id, bursts[i + 1].burst.id);
      assert.equal(bursts[i + 1].time.blockTime - bursts[i].time.blockTime, 30);
      assert.equal(bursts[i].burst.parallel, true);
    }
    assert.ok(Math.abs(bursts.length / 2 - Math.floor(intents.length / 50)) <= 1, `${name}: ${bursts.length / 2} bursts for ${intents.length} intents`);
    const nScripts = intents.filter((i) => i.type === 'T6').length;
    assert.ok(Math.abs(nScripts - Math.floor((intents.length + 75) / 100)) <= 1, `${name}: ${nScripts} script spends for ${intents.length} intents`);
    const scripts = intents.filter((i) => i.type === 'T6');
    assert.ok(scripts.every((i) => i.collateral.required && i.fixed.redeemers.length === 1));
    assert.equal(new Set(scripts.map((i) => i.fixed.inputs[0].ref)).size, scripts.length, 'one script input each');
    if (total >= 500) {
      assert.ok(bursts.length >= 2, `${name}: a burst`);
      assert.ok(scripts.length >= 1, `${name}: a script spend`);
    }
    assert.equal(new Set(intents.map((i) => i.id)).size, intents.length);
    for (const t of ['T1', 'T2', 'T3', 'T4', 'T5']) if (total >= 500) assert.ok(intents.some((i) => i.type === t), `${name}: ${t}`);
  }
});

test('no intent sends a token twice, a token the wallet does not hold, or more of a fungible asset than it holds', { skip }, () => {
  const name = 'H3E6';
  const src = sourceOf(name);
  const held = new Map();
  for (const u of src.start) for (const a of u.assets) held.set(`${a.policy}.${a.name}`, (held.get(`${a.policy}.${a.name}`) || 0n) + a.qty);
  const sentNft = new Set();
  const types = {};
  for (const e of src.events) {
    if (e.kind === 'deposit') {
      for (const u of e.utxos) for (const a of u.assets) held.set(`${a.policy}.${a.name}`, (held.get(`${a.policy}.${a.name}`) || 0n) + a.qty);
      continue;
    }
    if (e.kind !== 'intent') continue;
    types[e.intent.type] = (types[e.intent.type] || 0) + 1;
    for (const o of e.intent.requested) {
      for (const a of o.assets) {
        const k = `${a.policy}.${a.name}`;
        assert.ok((held.get(k) || 0n) >= a.qty, `${k} sent beyond what is held`);
        held.set(k, held.get(k) - a.qty);
        if (a.qty === 1n && !k.includes(`.${Buffer.from('Coin', 'ascii').toString('hex')}`)) {
          assert.equal(sentNft.has(k), false, `${k} sent twice`);
          sentNft.add(k);
        }
      }
    }
  }
  assert.ok(types.T2 > 100 && types.T3 > 50 && types.T4 > 50 && types.T5 > 100, JSON.stringify(types));
  assert.ok(sentNft.size > 1000);
});

test('every intent of a heavy wallet is built by test-largest-first, the transactions meeting the kit\'s checks', { skip, timeout: 5 * 60 * 1000 }, async () => {
  for (const name of ['H1E05', 'H20E01']) {
    const src = sourceOf(name);
    const intents = src.events.filter((e) => e.kind === 'intent').length;
    const method = makeMethod(T, 'test-largest-first', {});
    const x = await replay(T, src.params, src, { arm: 'observed', variant: 'default', repetition: 1, method, opts: { seed: 1, changePolicy: 'default', collateralRule: 'ledger' }, settleEvery: 25, policyLock: false, validity: true });
    assert.equal(x.refused, undefined, name);
    const c = x.summary.counts;
    assert.equal(c.intents, intents, name);
    assert.equal(c.built, intents, `${name}: ${JSON.stringify(c.byClass)}`);
    assert.equal(c.failed, 0, name);
    assert.equal(c.infeasible, 0);
    assert.equal(c.infeasibleCollateral, 0);
    assert.equal(c.notReplayable, 0);
    assert.equal(x.spends.length, intents);
  }
});

test('the heavy probe\'s queue: twelve distinct jobs the queue runner accepts, each under time -v, summarized from its files', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { probeQueue, summarize, table, WALLETS, KINDS } = await import('../../../scripts/heavy-probe.mjs');
  const { validateQueue } = await import('../../../scripts/run-queue.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'heavy-probe-'));
  try {
    const envFile = join(dir, 'probe.env');
    writeFileSync(envFile, 'export RESEARCH_SIM_HOME=/nowhere\n');
    const q = probeQueue({ snapshot: dir, envFile, dir });
    writeFileSync(join(dir, 'queue.json'), JSON.stringify(q));
    const v = validateQueue(q, join(dir, 'queue.json'));
    assert.deepEqual(v.errors, []);
    assert.equal(q.jobs.length, WALLETS.length * KINDS.length);
    assert.equal(new Set(q.jobs.map((j) => j.id)).size, q.jobs.length);
    assert.deepEqual([...new Set(KINDS.map((k) => `${k.method}/${k.arm}/${k.variant}`))].sort(), ['cjs-rrri/maintained-tidy/default', 'cjs-rrri/tidy-once/byte-optimal', 'csl-lf/observed/default', 'evo-lf/observed/default']);
    for (const j of q.jobs) {
      assert.deepEqual(j.argv.slice(0, 2), ['/usr/bin/time', '-v']);
      assert.ok(j.argv.includes('scripts/heavy-probe.mjs') && j.argv.includes('job'));
    }
    // The cheapest kind first, so a stopped probe has the most readings.
    assert.equal(q.jobs[0].id, 'H20E01-csl-lf-observed');
    assert.equal(q.jobs.at(-1).id, 'H20E05-evo-lf-observed');
    // The summary reads a time file and a RESULT line.
    const id = 'H20E01-csl-lf-observed';
    mkdirSync(join(dir, 'out', 'time'), { recursive: true });
    mkdirSync(join(dir, 'out', 'queue', id, 'attempt-1'), { recursive: true });
    writeFileSync(join(dir, 'out', 'time', `${id}.txt`), '\tCommand being timed: "node"\n\tElapsed (wall clock) time (h:mm:ss or m:ss): 0:19.92\n\tMaximum resident set size (kbytes): 767780\n\tExit status: 0\n');
    writeFileSync(join(dir, 'out', 'queue', id, 'attempt-1', 'stdout.log'), `${JSON.stringify({ k: 1 })}\n${JSON.stringify({ result: true, peakCslMiB: 54.5, peakHeapUsedMiB: 200, built: 89, failed: 0, builds: 91 })}\n`);
    const rows = summarize(dir);
    assert.equal(rows.length, 12);
    assert.deepEqual({ ...rows[0] }, { id, wall: '0:19.92', maxRssMiB: 750, exit: '0', peakCslMiB: 54.5, peakHeapMiB: 200, built: 89, failed: 0, builds: 91 });
    assert.equal(rows[1].wall, null);
    assert.match(table(rows), /^id\s+wall\s+maxRssMiB[\s\S]*H20E01-csl-lf-observed\s+0:19\.92\s+750/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
