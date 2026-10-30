// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The battery command over snapshot files, one per header case, built from a
// constructed wallet under a temporary RESEARCH_SIM_HOME: each file's records
// hold only the batteries its header names and, on H-10's battery, only the
// three baselines; a wallet in no battery starts no job; a wallet of the
// recent random sample whose snapshot holds no native asset is counted; the
// oracle (a stub that records its calls) prices the standard battery's spends
// only; the snapshot-plan record is written for the wallets that run the
// standard battery and holds the default plan's figures; and a file the rules
// refuse stops the command before any record is written.
// Needs RESEARCH_SIM_TREATMENT_DIR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { treatment, skip, TREATMENT_DIR } from '../lib/treatment.mjs';
import { Pool } from '../../src/replay/pool.mjs';
import { runBatteries } from '../../src/replay/run.mjs';
import { cmdBattery } from '../../src/replay/commands.mjs';
import { RunOutput } from '../../src/out/records.mjs';
import { DEFAULT_PINS } from '../../src/treatment/bridge.mjs';
import { batteryPlan, STUDY_ROLES } from '../../src/arms/plan.mjs';
import { assignPopulation, countPopulation } from '../../src/battery/population.mjs';
import { encodeOutput, unspentOutput } from '../../src/history/output.mjs';
import { utxoFromCbor, utxoJson, addressTextOf } from '../../src/state/utxo.mjs';
import { HISTORY_FORMAT } from '../../src/state/history.mjs';
import { paramsFromRow } from '../../src/history/params.mjs';
import { baseAddr, keyHash, STAKE } from '../lib/txcbor.mjs';

const T = await treatment();
const pinsPath = process.env.RESEARCH_SIM_TREATMENT_PINS || DEFAULT_PINS;
const ADA = 1000000n;
const A0 = baseAddr(keyHash(0), STAKE, 0);
const POL = 'cc'.repeat(28);
const PARAMS = paramsFromRow('preprod', { epoch_no: 300, protocol_major: 10, min_fee_a: 44, min_fee_b: 155381, coins_per_utxo_size: 4310, max_val_size: 5000, max_tx_size: 16384, max_collateral_inputs: 3, collateral_percent: 150, price_mem: 0.0577, price_step: 0.0000721, min_fee_ref_script_cost_per_byte: 15, key_deposit: 2000000, pool_deposit: 500000000, drep_deposit: 500000000, gov_action_deposit: 100000000000 });
const POOLS = { t1: [5000000n], t5: [[1n, 10n]] };
const txid = (n) => n.toString(16).padStart(2, '0').repeat(32);
const sample = (recentRandom, peakRandom, recentStratum) => ({ recentRandom, peakRandom, recentStratum });

// A snapshot file: pure-ADA UTxOs and, with tokens, five token UTxOs (four
// non-fungible, one fungible).
function snapshot(wallet, header, { tokens = true } = {}) {
  const outs = [];
  for (let i = 0; i < 6; i++) outs.push({ coin: (10n + BigInt(i)) * ADA, assets: [] });
  if (tokens) {
    for (let i = 0; i < 4; i++) outs.push({ coin: 3n * ADA, assets: [{ policy: POL, name: `0${i}`.padStart(4, '4'), qty: 1n }] });
    outs.push({ coin: 4n * ADA, assets: [{ policy: POL, name: '4654', qty: 1000n }] });
  }
  const utxos = outs.map((o, i) => ({ ...utxoJson(utxoFromCbor(unspentOutput(txid(10 + i), 0, encodeOutput({ address: A0, coin: o.coin, assets: o.assets }, 'array')).toString('hex'), { origin: 'initial' })), txId: 10 + i }));
  const lines = [
    { kind: 'header', format: HISTORY_FORMAT, network: 'preprod', wallet, frame: 'recent', window: null, snapshot: { block: 1, tx: 1 }, params: PARAMS, franken: [], arrival: [], latestKeyBase: { address: addressTextOf(A0), txId: 99, index: 0 }, settings: {}, source: { bytes: 'tx_cbor' }, split: null, sample: null, ...header },
    { kind: 'state', at: { tx: 1 }, utxos },
    { kind: 'end', at: { tx: 1 }, utxos: utxos.length, digest: '00', counts: { deposit: 0, 'held-consumed': 0, intent: 0, 'self-reorganization': 0, mark: 0 } }
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

const STANDARD_ONLY = new Set(['evo-lf', 'csl-lf-pure', 'csl-ri-pure', 'unfrackit-h12']);
const BASELINES = ['cjs-rrri', 'csl-lf', 'csl-ri'];

test('the battery runs each file\'s batteries, H-10 under the baselines, the oracle on the standard battery, and the snapshot plan', { skip, timeout: 30 * 60 * 1000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'research-sim-population-'));
  const prev = process.env.RESEARCH_SIM_HOME;
  process.env.RESEARCH_SIM_HOME = home;
  const dir = join(home, 'files');
  const pool = new Pool({ treatmentDir: TREATMENT_DIR, pinsPath, size: 2 });
  try {
    const cases = [
      [1, { split: 'exploration', sample: sample(true, false, false) }, {}],
      [2, { split: 'exploration', sample: sample(false, false, true) }, {}],
      [3, { split: 'exploration', sample: sample(false, true, false) }, {}],
      [4, { split: 'exploration', sample: sample(false, false, false) }, {}],
      [5, { split: null, sample: null }, {}],
      [6, { split: 'exploration', sample: sample(true, false, false) }, { tokens: false }]
    ];
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir);
    const wallets = cases.map(([id, header, o]) => {
      const path = join(dir, `${id}.snapshot.jsonl`);
      writeFileSync(path, snapshot(id, header, o));
      return { spec: { kind: 'history', path, analysisFreezeTx: null } };
    });
    const decided = assignPopulation(wallets);
    assert.deepEqual(decided.map((w) => w.population.kind), ['standard-and-h10', 'h10-only', 'none', 'none', 'no-sample', 'standard-and-h10']);
    const calls = [];
    const oracle = {
      policyOf: (name, change) => (name === 'cjs-rrri' || name === 'csl-lf' ? 'csl' : null),
      async reference(state, intent, params, policy, { incumbents }) {
        calls.push({ spend: intent.id, policy, n: incumbents.length });
        return { status: 'built', fee: null, from: null };
      }
    };
    const out = new RunOutput('preprod', 'population-test', { command: 'test' });
    const methods = batteryPlan({ roles: STUDY_ROLES, reps: 2 });
    const totals = await runBatteries(T, pool, { wallets: decided, methods, out, pools: POOLS, oracle });
    out.close();
    const recs = readFileSync(join(out.dir, 'records.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const of = (w) => recs.filter((r) => r.wallet === w && r.kind === 'battery' && r.method !== 'oracle' && r.method !== 'none');
    const isH10 = (r) => r.spend.startsWith('h10-');

    // Recent random: both batteries; H-10 under the baselines only.
    for (const w of [1, 5, 6]) {
      const r = of(w);
      assert.ok(r.some((x) => !isH10(x)) && r.some(isH10), `wallet ${w}: both batteries`);
      assert.deepEqual([...new Set(r.filter(isH10).map((x) => x.method))].sort(), BASELINES);
      assert.ok(r.filter((x) => !isH10(x)).some((x) => STANDARD_ONLY.has(x.method)), `wallet ${w}: the standard battery runs every method`);
      assert.ok(!r.filter(isH10).some((x) => STANDARD_ONLY.has(x.method)));
    }
    // Per H-10 spend, from each layout: csl-lf 1 + csl-ri 2 + cjs-rrri 2 runs.
    const h10Spend = of(1).filter((x) => x.spend === 'h10-0.5' && x.arm === 'observed');
    assert.equal(h10Spend.length, 5);

    // Recent stratum only: H-10's battery alone, from both layouts.
    const strat = of(2);
    assert.ok(strat.length > 0 && strat.every(isH10));
    assert.deepEqual([...new Set(strat.map((x) => x.arm))].sort(), ['observed', 'tidy-once']);
    assert.deepEqual([...new Set(strat.map((x) => x.method))].sort(), BASELINES);

    // Peak random only, and a sampled wallet in neither: nothing at all.
    for (const w of [3, 4]) assert.equal(recs.filter((r) => r.wallet === w).length, 0, `wallet ${w}: no records`);

    // The oracle: standard-battery spends of the wallets that run it.
    assert.ok(calls.length > 0 && calls.every((c) => !c.spend.startsWith('h10-')));
    assert.equal(totals.oracle, calls.length);
    const oracleRecs = recs.filter((r) => r.method === 'oracle');
    assert.ok(oracleRecs.every((r) => ![2, 3, 4].includes(r.wallet) && !r.spend.startsWith('h10-')));

    // The snapshot plan: wallets that run the standard battery, one each.
    const plans = recs.filter((r) => r.kind === 'snapshot-plan');
    assert.deepEqual(plans.map((r) => r.wallet), [1, 5, 6]);
    const p = plans[0];
    assert.equal(p.method, 'snapshot-plan');
    assert.ok(p.txs >= 1 && BigInt(p.fee) > 0n);
    assert.equal(p.tokenUtxosBefore, 5);
    assert.ok(p.tokenUtxosAfter < p.tokenUtxosBefore);
    assert.ok(BigInt(p.minimumAfter) < BigInt(p.minimumBefore), 'locked ADA falls');
    assert.ok(BigInt(p.coinBefore) >= BigInt(p.minimumBefore) && BigInt(p.coinAfter) >= BigInt(p.minimumAfter));
    const none = plans.find((r) => r.wallet === 6);
    assert.deepEqual([none.tokenUtxosBefore, none.coinBefore, none.minimumBefore], [0, '0', '0']);
    assert.ok(!JSON.stringify(plans).match(/addr|[0-9a-f]{56}/));

    // The counts, and the token-holding check: wallet 6 holds none.
    assert.deepEqual(totals.population, { files: 6, 'standard-and-h10': 2, 'h10-only': 1, none: 2, 'no-sample': 1 });
    assert.deepEqual(totals.population, countPopulation(decided));
    assert.equal(totals.tokenless, 1);
    assert.equal(totals.wallets, 4);
  } finally {
    await pool.close();
    if (prev === undefined) delete process.env.RESEARCH_SIM_HOME;
    else process.env.RESEARCH_SIM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a refused file stops the command before any record is written', { skip, timeout: 5 * 60 * 1000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'research-sim-population-'));
  const prev = process.env.RESEARCH_SIM_HOME;
  process.env.RESEARCH_SIM_HOME = home;
  const dir = join(home, 'files');
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir);
    writeFileSync(join(dir, '1.snapshot.jsonl'), snapshot(1, { split: 'exploration', sample: sample(true, false, false) }));
    writeFileSync(join(dir, '2.snapshot.jsonl'), snapshot(2, { split: 'exploration', sample: { recentRandom: true, peakRandom: false } }));
    const opts = { treatment: TREATMENT_DIR, treatmentPins: pinsPath, history: dir, pools: join(home, 'pools.json'), workers: 1, runId: 'refused' };
    writeFileSync(opts.pools, JSON.stringify({ t1: ['5000000'], t5: [['1', '10']] }));
    await assert.rejects(cmdBattery(opts), /2\.snapshot\.jsonl.*rerun history/);
    assert.deepEqual(readdirSync(home).sort(), ['files', 'pools.json'], 'no run directory');
  } finally {
    if (prev === undefined) delete process.env.RESEARCH_SIM_HOME;
    else process.env.RESEARCH_SIM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
