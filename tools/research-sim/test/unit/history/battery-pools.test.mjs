// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Which history files the battery pools read: the recent-window files of
// exploration-split wallets in the recent frame's random sample, with the
// files that carry no split counted apart and a split without sample
// information refused. Constructed files under a temporary home; synthetic
// ids and amounts only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'bp-test-'));
process.env.RESEARCH_SIM_HOME = home;
const { cmdBatteryPools } = await import('../../../src/history/reports.mjs');
const { samplesFromRows, sampleMembership } = await import('../../../src/history/commands.mjs');
const { historyDir, runDir } = await import('../../../src/history/paths.mjs');

after(() => rmSync(home, { recursive: true, force: true }));

const POLICY = 'aa'.repeat(28);
const NAME = '01';
const KEY = `${POLICY}.${NAME}`;

// A wallet's file: a start state holding 1,000 units of one fungible, a T1
// spend of `t1` lovelace and a T5 spend of `t5` units.
function file(header, t1, t5) {
  const base = { kind: 'header', format: 'unfrackit-research-sim history 4', network: 'preprod', frame: 'recent' };
  const lines = [
    { ...base, ...header },
    { kind: 'state', at: { tx: 1 }, utxos: [{ ref: `${'0'.repeat(64)}#0`, assets: [{ policy: POLICY, name: NAME, qty: '1000' }] }] },
    { kind: 'intent', intent: { id: 2, type: 'T1', requested: [{ coin: String(t1), assets: [] }], classes: {}, observed: { walletInputs: [], walletOutputs: [] } } },
    { kind: 'intent', intent: { id: 3, type: 'T5', requested: [{ coin: '1500000', assets: [{ policy: POLICY, name: NAME, qty: String(t5) }] }], classes: { [KEY]: 'FT' }, observed: { walletInputs: [], walletOutputs: [] } } },
    { kind: 'end', at: { tx: 3 }, utxos: 1, digest: '', counts: {} }
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}
const sample = (recentRandom, peakRandom) => ({ recentRandom, peakRandom });

function setup(runId, files) {
  const dir = historyDir('preprod', runId);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}
const pools = (runId) => JSON.parse(readFileSync(join(runDir('preprod', runId), 'battery-pools.json'), 'utf8'));

test('only recent-random exploration files and files without a split feed the pools, each other kind counted', async () => {
  setup('mixed', {
    '1.recent.jsonl': file({ wallet: 1, split: 'exploration', sample: sample(true, false) }, 1000001, 10),
    '2.recent.jsonl': file({ wallet: 2, split: 'exploration', sample: sample(false, false) }, 2000002, 20),
    '3.recent.jsonl': file({ wallet: 3, split: 'exploration', sample: sample(false, true) }, 3000003, 30),
    '4.recent.jsonl': file({ wallet: 4, split: 'confirmation', sample: sample(true, false) }, 4000004, 40),
    '5.recent.jsonl': file({ wallet: 5, split: null, sample: null }, 5000005, 50),
    '6.recent.jsonl': file({ wallet: 6, split: null }, 6000006, 60)
  });
  const r = await cmdBatteryPools({ runId: 'mixed', network: 'preprod' });
  assert.deepEqual(r.print, { command: 'battery-pools', files: 6, used: 3, confirmation: 1, outsideRecentRandom: 2, withoutSplit: 2, t1: 3, t5: 3 });
  const p = pools('mixed');
  assert.deepEqual(p.t1Amounts, ['1000001', '5000005', '6000006']);
  assert.deepEqual(p.t5Shares.map((s) => s.join('/')).sort(), ['10/1000', '50/1000', '60/1000']);
  assert.equal(p.files, 6);
  assert.equal(p.used, 3);
  assert.equal(p.skippedConfirmation, 1);
  assert.equal(p.outsideRecentRandom, 2);
  assert.equal(p.withoutSplit, 2);
});

test('a file with a split and no sample information is refused, naming the rerun of history', async () => {
  setup('old', {
    '1.recent.jsonl': file({ wallet: 1, split: 'exploration', sample: sample(true, false) }, 1000001, 10),
    '2.recent.jsonl': file({ wallet: 2, split: 'exploration' }, 2000002, 20)
  });
  await assert.rejects(cmdBatteryPools({ runId: 'old', network: 'preprod' }), /2\.recent\.jsonl.*rerun history/);
  setup('old-conf', { '1.recent.jsonl': file({ wallet: 1, split: 'confirmation', sample: null }, 1, 1) });
  await assert.rejects(cmdBatteryPools({ runId: 'old-conf', network: 'preprod' }), /rerun history/);
});

test('study_samples rows reach the header field per frame', () => {
  const rows = [
    { sa_id: '1', random: true, random_recent: true, random_peak: false, stratum_recent: false, split: 'exploration', excluded: false },
    { sa_id: '2', random: true, random_recent: false, random_peak: true, stratum_recent: false, split: 'exploration', excluded: false },
    { sa_id: '3', random: false, random_recent: false, random_peak: false, stratum_recent: false, split: 'exploration', excluded: false },
    { sa_id: '4', random: false, random_recent: false, random_peak: false, stratum_recent: true, split: 'exploration', excluded: false }
  ];
  const m = samplesFromRows(rows);
  assert.deepEqual(sampleMembership(m, 1), { recentRandom: true, peakRandom: false, recentStratum: false });
  assert.deepEqual(sampleMembership(m, 2), { recentRandom: false, peakRandom: true, recentStratum: false });
  assert.deepEqual(sampleMembership(m, 3), { recentRandom: false, peakRandom: false, recentStratum: false });
  assert.deepEqual(sampleMembership(m, 4), { recentRandom: false, peakRandom: false, recentStratum: true });
  assert.equal(m.get(2).random, true);
  assert.equal(sampleMembership(m, 9), null);
  assert.equal(sampleMembership(null, 1), null);
});
