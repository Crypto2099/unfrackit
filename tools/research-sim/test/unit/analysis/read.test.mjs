// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The analysis reader: its refusals, and per-wallet tables checked by hand on
// synthetic studies written by test/lib/analysis-fixtures.mjs.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { AnalysisRefusal, checkOptions, openStudy, readStudy, readCensus, readDropList, groupWeight, armIds } from '../../../src/analysis/read.mjs';
import { writeStudy, optionsFor, fullJobs, built, failed, notReplayable, infeasible, infeasibleCollateral, forfeit, RULE, sha256, METHODS } from '../../lib/analysis-fixtures.mjs';

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'analysis-read-'));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const refusal = (re) => (e) => e instanceof AnalysisRefusal && re.test(e.message);
const plain = (m, arm, rep) => [built(0, { fee: 200000 })];

// A corpus study of one wallet over every library, with edits.
function corpus(over = {}, wallet = {}) {
  const root = tmp();
  const w = writeStudy(root, { wallets: [{ id: 101, group: 'B1', jobs: fullJobs(plain), ...wallet }], ...over });
  return { root, w, opts: optionsFor(root, w) };
}
const read = (c, o = {}) => readStudy({ ...c.opts, ...o });

test('options: every required option and each value it is checked against', () => {
  const ok = { network: 'preprod', study: 'st', window: 'recent', split: 'exploration', out: '/x' };
  assert.equal(checkOptions(ok).workers, 1);
  for (const k of ['network', 'study', 'window', 'split', 'out']) assert.throws(() => checkOptions({ ...ok, [k]: undefined }), refusal(new RegExp(`--${k}`)));
  assert.throws(() => checkOptions({ ...ok, window: 'snapshot' }), refusal(/--window/));
  assert.throws(() => checkOptions({ ...ok, split: 'all' }), refusal(/--split/));
  assert.throws(() => checkOptions({ ...ok, study: 'a/b' }), refusal(/study run id/));
  assert.throws(() => checkOptions({ ...ok, workers: 0 }), refusal(/--workers/));
  assert.throws(() => checkOptions({ ...ok, workers: 1.5 }), refusal(/--workers/));
  assert.throws(() => checkOptions({ ...ok, drop: '/no/such/file' }), refusal(/--drop/));
});

test('options: the confirmation split is refused without an analysis-freeze transaction, and a malformed hash is refused', () => {
  const ok = { network: 'preprod', study: 'st', window: 'recent', split: 'confirmation', out: '/x' };
  assert.throws(() => checkOptions(ok), refusal(/analysis-freeze-tx/));
  assert.throws(() => checkOptions({ ...ok, analysisFreezeTx: 'abc' }), refusal(/64/));
  assert.equal(checkOptions({ ...ok, analysisFreezeTx: 'b'.repeat(64) }).split, 'confirmation');
});

test('the synthetic network reads a synthetic-plan study only, and a synthetic study is read only under it', () => {
  const c = corpus();
  // A corpus study opened as synthetic: the directory is under another network name, so move the claim into study.json.
  const sj = join(c.w.studyDir, 'study.json');
  writeFileSync(sj, JSON.stringify({ ...JSON.parse(readFileSync(sj, 'utf8')), plan: 'synthetic' }));
  assert.throws(() => openStudy(c.opts), refusal(/only with --network synthetic/));
  writeFileSync(sj, JSON.stringify({ ...JSON.parse(readFileSync(sj, 'utf8')), plan: 'corpus', network: 'mainnet' }));
  assert.throws(() => openStudy(c.opts), refusal(/study.json is of the network/));
});

test('refuses a stage without done.json, one whose run.json changed, and one whose records do not hash to done.json', async () => {
  let c = corpus();
  rmSync(join(c.w.stageDir, 'done.json'));
  assert.throws(() => openStudy(c.opts), refusal(/has not ended/));
  c = corpus();
  writeFileSync(join(c.w.stageDir, 'run.json'), '{"stage":"other"}\n');
  assert.throws(() => openStudy(c.opts), refusal(/another run.json/));
  c = corpus();
  const p = join(c.w.stageDir, 'records.jsonl.gz');
  writeFileSync(p, gzipSync(Buffer.from(gunzipSync(readFileSync(p)).toString('utf8').replace('"fee":"200000"', '"fee":"200001"'))));
  await assert.rejects(read(c), refusal(/do not match done.json/));
});

test('refuses a history file that does not match wallets.json, or is missing', async () => {
  let c = corpus();
  const f = join(c.w.historyDir, 'history', '101.recent.jsonl');
  writeFileSync(f, readFileSync(f, 'utf8') + '\n');
  await assert.rejects(read(c), refusal(/does not match wallets.json/));
  c = corpus();
  rmSync(join(c.w.historyDir, 'history', '101.recent.jsonl'));
  await assert.rejects(read(c), refusal(/history file is missing/));
});

test('refuses a record of an unknown kind, arm, variant, change or method', async () => {
  const bad = [
    [/unknown kind/, (r) => (r[0].kind = 'mystery')],
    [/arm "wallet"/, (r) => (r[0].arm = 'wallet')],
    [/unknown variant/, (r) => (r[0].variant = 'absorb-on')],
    [/unknown change/, (r) => (r[0].change = 'wide')],
    [/unknown method/, (r) => (r[0].method = 'csl-xx')],
    [/rule record/, (r) => (r.find((x) => x.method === RULE).variant = 'default')]
  ];
  for (const [re, mut] of bad) {
    const c = corpus({ mutate: mut });
    await assert.rejects(read(c), refusal(re), String(re));
  }
});

test('refuses a wallet missing a library, a rule arm or a repetition, and a deterministic arm with two', async () => {
  const jobs = fullJobs(plain);
  let c = corpus({}, { jobs: jobs.filter((j) => j.method !== 'cml-lf') });
  await assert.rejects(read(c), refusal(/arm cml-lf\/own is missing/));
  c = corpus({}, { jobs: jobs.filter((j) => !(j.method === RULE && j.arm === 'off')) });
  await assert.rejects(read(c), refusal(/unfrackit-h12\/off is missing/));
  c = corpus({}, { jobs: jobs.filter((j) => !(j.method === 'csl-ri' && j.arm === 'layout' && j.rep === 2)) });
  await assert.rejects(read(c), refusal(/different repetition counts/));
  c = corpus({}, { jobs: [...jobs, { method: 'csl-lf', arm: 'own', rep: 2, spends: plain() }] });
  await assert.rejects(read(c), refusal(/deterministic arm has one/));
});

test('refuses jobs that disagree on collateral, a collateral that is not the study\'s rule, and disagreeing capped flags', async () => {
  let c = corpus({ mutate: (r) => (r[0].collateral = 'practice') });
  await assert.rejects(read(c), refusal(/disagree on collateral/));
  c = corpus({}, { collateral: 'practice' });
  await assert.rejects(read(c), refusal(/differs from the study's rule/));
  c = corpus({}, { collateral: 'none-needed' });
  assert.equal((await read(c)).wallets[0].collateral, 'none-needed');
  c = corpus({}, { capped: true, historyCapped: false });
  await assert.rejects(read(c), refusal(/disagree on capped/));
  c = corpus({ mutate: (r) => (r.find((x) => x.kind === 'wallet-arm').capped = true) });
  await assert.rejects(read(c), refusal(/disagree on capped/));
  c = corpus({}, { capped: true });
  assert.equal((await read(c)).wallets[0].capped, true);
});

test('refuses a group the draw lacks, a draw that is null and a frame the draw lacks', async () => {
  let c = corpus({}, { group: 'B3' });
  const hr = join(c.w.historyDir, 'history-run.json');
  const j = JSON.parse(readFileSync(hr, 'utf8'));
  delete j.draw.recent.groups.B3;
  writeFileSync(hr, JSON.stringify(j));
  await assert.rejects(read(c), refusal(/no group B3/));
  c = corpus({ draw: null });
  assert.throws(() => openStudy(c.opts), refusal(/holds no draw/));
  c = corpus();
  const j2 = JSON.parse(readFileSync(join(c.w.historyDir, 'history-run.json'), 'utf8'));
  writeFileSync(join(c.w.historyDir, 'history-run.json'), JSON.stringify({ ...j2, draw: { peak: j2.draw.recent } }));
  assert.throws(() => openStudy(c.opts), refusal(/no frame recent/));
  assert.throws(() => groupWeight({ groups: { B1: { nDrawn: 3, nTaken: 0 } } }, 'B1'), refusal(/D=3, A=0/));
});

test('the confirmation split: a confirmation wallet is refused without the freeze transaction, and the run must name the same one', async () => {
  const freeze = 'c'.repeat(64);
  const wallets = [{ id: 101, jobs: fullJobs(plain) }, { id: 102, split: 'confirmation', jobs: fullJobs(plain) }];
  let root = tmp();
  let w = writeStudy(root, { wallets });
  await assert.rejects(readStudy(optionsFor(root, w)), refusal(/confirmation split, and no analysis-freeze/));
  root = tmp();
  w = writeStudy(root, { wallets, analysisFreezeTx: freeze });
  assert.throws(() => openStudy(optionsFor(root, w, { analysisFreezeTx: 'd'.repeat(64) })), refusal(/another analysis-freeze/));
  const exp = await readStudy(optionsFor(root, w, { analysisFreezeTx: freeze }));
  assert.deepEqual(exp.wallets.map((x) => x.wallet), ['101']);
  assert.equal(exp.flow.otherSplit, 1);
  const conf = await readStudy(optionsFor(root, w, { split: 'confirmation', analysisFreezeTx: freeze }));
  assert.deepEqual(conf.wallets.map((x) => x.wallet), ['102']);
  assert.equal(conf.flow.otherSplit, 1);
  root = tmp();
  w = writeStudy(root, { wallets: [wallets[0]] });
  assert.throws(() => openStudy(optionsFor(root, w, { split: 'confirmation', analysisFreezeTx: freeze })), refusal(/does not name the analysis-freeze/));
});

test('a wallet in --drop is left out and counted, by id from a JSON list or a text file', async () => {
  const c = corpus({}, {});
  const list = join(c.root, 'drop.txt');
  writeFileSync(list, '# private\n101\n');
  assert.deepEqual([...readDropList(list)], ['101']);
  const r = await read(c, { drop: list });
  assert.equal(r.wallets.length, 0);
  assert.equal(r.flow.dropped, 1);
  writeFileSync(list, '[101, "7"]');
  assert.deepEqual([...readDropList(list)], ['101', '7']);
  writeFileSync(list, '[{"a":1}]');
  assert.throws(() => readDropList(list), refusal(/not a list of wallet ids/));
});

test('refuses records of more or fewer wallets than wallets.json lists, and out of order', async () => {
  let root = tmp();
  let w = writeStudy(root, { wallets: [{ id: 101, jobs: fullJobs(plain) }, { id: 102, jobs: fullJobs(plain) }] });
  const wj = join(w.stageDir, 'wallets.json');
  const entries = JSON.parse(readFileSync(wj, 'utf8'));
  writeFileSync(wj, JSON.stringify([entries[1], entries[0]]));
  await assert.rejects(readStudy(optionsFor(root, w)), refusal(/not the one wallets.json lists/));
  root = tmp();
  w = writeStudy(root, { wallets: [{ id: 101, jobs: fullJobs(plain) }] });
  const done = JSON.parse(readFileSync(join(w.stageDir, 'done.json'), 'utf8'));
  writeFileSync(join(w.stageDir, 'done.json'), JSON.stringify({ ...done, wallets: 2 }));
  assert.throws(() => openStudy(optionsFor(root, w)), refusal(/does not list the wallets/));
});

// The hand-computed tables, synthetic plan: a random library at 2 repetitions
// (csl-ri), a deterministic one (csl-lf) and the rule, three wallets.
const SYN_METHODS = ['csl-lf', 'csl-ri'];
function synthetic() {
  const root = tmp();
  const w1 = {
    id: 'S1',
    jobs: [
      {
        method: 'csl-lf',
        arm: 'own',
        spends: [
          built(0, { fee: 200000, walletFee: 150000 }),
          failed(1, 'change-minimum', 'kit: change-minimum: low'),
          failed(2, 'fee-minimum', 'kit: fee-minimum: low; parts the library did not price: foo, redeemers'),
          failed(3, 'balance', 'kit: conservation: coin: 5000000 consumed, 7000000 produced'),
          infeasible(4),
          infeasibleCollateral(5),
          forfeit(6),
          notReplayable(7),
          built(8, { fee: 210000 })
        ]
      },
      { method: 'csl-lf', arm: 'layout', spends: [built(0, { fee: 200000, walletFee: 150000 })] },
      {
        method: 'csl-ri',
        arm: 'own',
        rep: 1,
        spends: [
          built(0, { walletFee: 150000, changeCount: 8, consumed: 1, changeBytes: 4500, consumedBytes: 100, changeMin: 3000000, consumedMin: 500000, utxos: 10, bytesAfter: 4500, locked: 9000000, perToken: 900000, tokens: 10 }),
          built(1, { changeCount: 8, consumed: 1, changeMin: 3000000, consumedMin: 500000, utxos: 17, bytesAfter: 4500 })
        ]
      },
      { method: 'csl-ri', arm: 'own', rep: 2, spends: [built(0, { utxos: 4, walletFee: 150000 })] },
      { method: 'csl-ri', arm: 'layout', rep: 1, spends: [built(0, { walletFee: 150000 })] },
      { method: 'csl-ri', arm: 'layout', rep: 2, spends: [built(0, { walletFee: 150000 })] },
      { method: RULE, arm: 'on', spends: [built(0, { txs: 2, fee: 500000, walletFee: 300000 })] },
      { method: RULE, arm: 'off', spends: [failed(0, 'tx-size')] }
    ]
  };
  const w2 = { id: 'S2', jobs: [{ method: 'csl-lf', arm: 'own', spends: [] }, { method: 'csl-lf', arm: 'layout', spends: [] }, { method: 'csl-ri', arm: 'own', rep: 1, spends: [] }, { method: 'csl-ri', arm: 'own', rep: 2, spends: [] }, { method: 'csl-ri', arm: 'layout', rep: 1, spends: [] }, { method: 'csl-ri', arm: 'layout', rep: 2, spends: [] }, { method: RULE, arm: 'on', refused: 'no change address' }, { method: RULE, arm: 'off', refused: 'no change address' }] };
  const w = writeStudy(root, { network: 'synthetic', wallets: [w1, w2] });
  return { root, w, opts: optionsFor(root, w) };
}

test('synthetic study: outcomes, classes, unpriced names and the conservation shortfall of one deterministic run', async () => {
  const s = synthetic();
  const r = await readStudy(s.opts);
  assert.deepEqual(r.wallets.map((x) => [x.wallet, x.group, x.weight.w, x.split, x.capped]), [['S1', 'B0', 1, null, false], ['S2', 'B0', 1, null, false]]);
  const run = r.wallets[0].arms.get('csl-lf/own').runs.get(1);
  assert.deepEqual(run.n, { attempted: 5, built: 2, failed: 3, infeasible: 1, infeasibleCollateral: 1, notReplayable: 1, forfeit: 1, chains: 0 });
  assert.deepEqual(run.byClass, { 'change-minimum': 1, 'fee-minimum': 1, balance: 1 });
  assert.equal(run.unpricedFailures, 1);
  assert.deepEqual(run.spends.get(2).unpriced, ['foo', 'redeemers']);
  assert.deepEqual(run.spends.get(1).unpriced, []);
  assert.deepEqual(run.spends.get(3).conservation, { consumed: 5000000n, produced: 7000000n });
  assert.equal(run.spends.get(4).reason, 'no inputs');
  assert.equal(run.spends.get(0).walletFee, 150000n);
  assert.equal(run.spends.get(8).walletFee, 210000n);
  assert.deepEqual([...run.spends.keys()], [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test('synthetic study: a chained answer takes its fixed fee part from a sibling record of the same intent', async () => {
  const s = synthetic();
  const r = await readStudy(s.opts);
  // csl-lf/own built intent 0 at fee 200000, walletFee 150000: d = 50000. The chain's fee 500000 less d is 450000.
  const chain = r.wallets[0].arms.get(`${RULE}/on`).runs.get(1);
  assert.equal(chain.spends.get(0).chained, true);
  assert.equal(chain.spends.get(0).fee, 500000n);
  assert.equal(chain.spends.get(0).walletFee, 450000n);
  assert.equal(chain.n.chains, 1);
  assert.equal(chain.n.built, 1);
  const off = r.wallets[0].arms.get(`${RULE}/off`).runs.get(1);
  assert.deepEqual(off.n, { attempted: 1, built: 0, failed: 1, infeasible: 0, infeasibleCollateral: 0, notReplayable: 0, forfeit: 0, chains: 0 });
});

test('synthetic study: a chained answer with no sibling stops the run naming the wallet and intent', async () => {
  const root = tmp();
  const w = writeStudy(root, { network: 'synthetic', wallets: [{ id: 'S1', jobs: [{ method: 'csl-lf', arm: 'own', spends: [] }, { method: 'csl-lf', arm: 'layout', spends: [] }, { method: RULE, arm: 'on', spends: [built(3, { txs: 2, fee: 500000, walletFee: 300000 })] }, { method: RULE, arm: 'off', spends: [] }] }] });
  await assert.rejects(readStudy(optionsFor(root, w)), refusal(/wallet 0: a chained answer of intent 3 with no single-transaction record/));
});

test('synthetic study: H-7 fields of a random library, E1 at 0.5, 0.8 and 0.9, E2 and E3 at their boundaries, and the slope points', async () => {
  const s = synthetic();
  const r = await readStudy(s.opts);
  const ri = r.wallets[0].arms.get('csl-ri/own');
  const a = ri.runs.get(1);
  // maxValSize 5000 (synthetic). Spend 0 writes a change output of 4500 bytes from inputs of at most 100: 4500 > 0.5 x 5000 and > 0.8 x 5000, but not > 0.9 x 5000 = 4500.
  assert.deepEqual(a.h7.e1, { 0.5: true, 0.8: true, 0.9: false });
  // E2: 8 + 8 change outputs less 1 + 1 consumed inputs is 14, at least 10 and at least the 3 UTxOs at the start.
  assert.deepEqual(a.h7.e2, { net: 14, worse: true });
  // E3: 6,000,000 of change minimum less 1,000,000 consumed is exactly 5,000,000.
  assert.deepEqual(a.h7.e3, { net: 5000000n, worse: true });
  assert.equal(a.h7.worse, true);
  assert.deepEqual(a.points.t, [0, 1000, 2000]);
  assert.deepEqual(a.points.utxos, [3, 10, 17]);
  assert.deepEqual(a.points.lockedAdaPerToken, [null, 900000n, null]);
  const b = ri.runs.get(2);
  assert.deepEqual(b.h7.e1, { 0.5: false, 0.8: false, 0.9: false });
  assert.deepEqual(b.h7.e2, { net: 0, worse: false });
  assert.equal(b.h7.worse, false);
  assert.deepEqual([...ri.runs.keys()], [1, 2]);
  assert.equal(r.wallets[0].arms.get('csl-lf/own').runs.size, 1);
});

test('synthetic study: a refused rule job has no summary and no h7, and the arm ids are those present', async () => {
  const s = synthetic();
  const r = await readStudy(s.opts);
  const refused = r.wallets[1].arms.get(`${RULE}/on`).runs.get(1);
  assert.equal(refused.refused, 'no change address');
  assert.equal(refused.summary, null);
  assert.equal(refused.h7, null);
  assert.deepEqual([...r.wallets[0].arms.keys()], armIds().filter((a) => a.startsWith('csl-lf/') || a.startsWith('csl-ri/') || a.startsWith(RULE)));
  const sum = r.wallets[0].arms.get('csl-lf/own').runs.get(1).summary;
  assert.equal(sum.capped, false);
  assert.equal(sum.start.lockedAda, 0n);
  assert.equal(sum.conformity.fee, 200000n);
});

test('synthetic study: a library with only one of its arms is refused', async () => {
  const root = tmp();
  const w = writeStudy(root, { network: 'synthetic', wallets: [{ id: 'S1', jobs: [{ method: 'csl-lf', arm: 'own', spends: [] }] }] });
  await assert.rejects(readStudy(optionsFor(root, w)), refusal(/has one of its two arms/));
});

// A corpus study with history files: weights from the draw, the flags of the
// header's draw, a chained answer with its fixed part from the history, and
// that part checked against a sibling record.
test('corpus study: size groups, weights D/A and the draw flags, a chain priced from the history, and the fixed part checked against a sibling', async () => {
  const root = tmp();
  const make = (m, arm) => {
    if (m === 'csl-lf' && arm === 'own') return [built(0, { fee: 344000, walletFee: 200000 }), built(1)];
    if (m === RULE && arm === 'on') return [built(0, { txs: 3, fee: 700000, walletFee: 100000 }), built(1)];
    return [built(0, { fee: 344000, walletFee: 200000 }), built(1)];
  };
  const intents = [{ scriptFee: 100000, fixedBytes: 1000, deposits: 2000000 }, {}];
  const w = writeStudy(root, {
    wallets: [
      { id: 101, group: 'B1', flags: { fragmented: true, frankenAny: false }, intents, jobs: fullJobs(make) },
      { id: 102, group: 'B2', capped: true, intents, jobs: fullJobs(make) },
      { id: 103, group: 'B3', intents, jobs: fullJobs(make) }
    ]
  });
  const r = await readStudy(optionsFor(root, w));
  // draw: B1 40 drawn and 20 taken, B2 10 and 5, B3 2 and 2.
  assert.deepEqual(r.wallets.map((x) => [x.wallet, x.group, x.weight.w, x.capped]), [['101', 'B1', 2, false], ['102', 'B2', 2, true], ['103', 'B3', 1, false]]);
  assert.deepEqual(r.wallets[0].flags, { fragmented: true, frankenAny: false });
  assert.deepEqual(r.wallets[1].flags, {});
  assert.deepEqual(r.wallets.map((x) => x.split), ['exploration', 'exploration', 'exploration']);
  // d = 100000 + 44 x 1000 = 144000; the sibling gives 344000 - 200000 = 144000. The chain's fee 700000 less d is 556000.
  const chain = r.wallets[0].arms.get(`${RULE}/on`).runs.get(1).spends.get(0);
  assert.equal(chain.walletFee, 556000n);
  assert.equal(r.wallets[0].intents[0].d, 144000n);
  assert.equal(r.wallets[0].intents[0].deposits, 2000000n);
  assert.equal(r.wallets[0].minFeeA, 44n);
  assert.equal(r.wallets[0].arms.get('cjs-rrri/own').runs.size, 2);
  assert.equal(r.wallets[0].arms.size, 48);
  assert.equal(r.flow.kept, 3);
  assert.equal(r.historyRun.analysisFreezeTx, null);
});

test('corpus study: a sibling record that disagrees with the history\'s fixed fee part stops the run', async () => {
  const root = tmp();
  const intents = [{ scriptFee: 100000, fixedBytes: 1000 }];
  const w = writeStudy(root, { wallets: [{ id: 101, intents, jobs: fullJobs(() => [built(0, { fee: 344000, walletFee: 199000 })]) }] });
  await assert.rejects(readStudy(optionsFor(root, w)), refusal(/gives a fixed fee part of 145000, the history gives 144000/));
});

test('corpus study: two sibling records of one intent with different fixed fee parts stop the run', async () => {
  const root = tmp();
  const w = writeStudy(root, { wallets: [{ id: 101, intents: [{ scriptFee: 1000 }], jobs: fullJobs((m, arm) => [built(0, { fee: 200000, walletFee: m === 'csl-lf' && arm === 'own' ? 199000 : 200000 })]) }] });
  await assert.rejects(readStudy(optionsFor(root, w)), refusal(/two different fixed fee parts/));
});

test('census rows are read with the coin when present and without it', async () => {
  const row = { wallet: '1', utxos: 4, tokenUtxos: 2, largestValueBytes: 90, nearCap50: false, nearCap80: false, nearCap90: false, lockedAda: '3000000', excessAda: '1000000' };
  let c = corpus({ census: [row, { ...row, wallet: '2', coin: '50000000' }] });
  const census = readCensus(openStudy(c.opts));
  assert.equal(census.valueLimit, 5000);
  assert.deepEqual(census.rows.map((r) => [r.coin, r.lockedAda]), [[null, 3000000n], [50000000n, 3000000n]]);
  c = corpus({ census: [{ wallet: '1' }] });
  assert.throws(() => readCensus(openStudy(c.opts)), refusal(/census row without/));
});

// The real stage of the synthetic-plan replay named in the brief: a smoke test
// of the reader, skipped when the stage is not on this machine.
const REAL_ROOT = join(process.env.HOME || '/', '.local/share/unfrackit-research-sim/homes/r4-mesh/check3/head3');
const realStage = join(REAL_ROOT, 'synthetic/cmp-study/replay-recent/done.json');
test('smoke: the real synthetic-plan stage reads to nine wallets with the libraries it ran', { skip: !existsSync(realStage) }, async () => {
  const r = await readStudy({ network: 'synthetic', study: 'cmp-study', window: 'recent', split: 'exploration', out: '/x', root: REAL_ROOT });
  assert.equal(r.wallets.length, 9);
  const ids = new Set(r.wallets.flatMap((w) => [...w.arms.keys()]));
  for (const m of ['csl-lf', 'csl-ri', 'cjs-rrri', 'evo-lf', 'blaze-wd', 'lucid-lf', 'mesh-rrri']) assert.ok(ids.has(`${m}/own`) && ids.has(`${m}/layout`), m);
  assert.ok(ids.has(`${RULE}/on`) && ids.has(`${RULE}/off`));
  const spends = r.wallets.reduce((n, w) => n + [...w.arms.values()].reduce((m, a) => m + [...a.runs.values()].reduce((k, run) => k + run.spends.size, 0), 0), 0);
  assert.equal(spends, 2178);
});

test('the fixture builder\'s hash helper and method list are the plan\'s', () => {
  assert.equal(sha256(Buffer.from('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(METHODS.length, 23);
  assert.equal(armIds().length, 48);
  assert.ok(SYN_METHODS.every((m) => METHODS.includes(m)));
});
