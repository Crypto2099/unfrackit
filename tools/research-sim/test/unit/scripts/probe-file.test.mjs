// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// scripts/probe-file.mjs: the probe file's checks and the queries the
// machine-independence driver makes of it. No treatment.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkProbe, replayArgs, repsOf, walletCount, PROBE_FORMAT } from '../../../scripts/probe-file.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'probe-file.mjs');
let root;
before(() => { root = mkdtempSync(join(tmpdir(), 'probe-file-')); });
after(() => rmSync(root, { recursive: true, force: true }));

const base = { shapes: 'S1,S6', plan: 'peak', 'collateral-rule': 'ledger', validity: true };
const probe = (stages) => ({ format: PROBE_FORMAT, stages });

test('replay flags: values, bare flags, repeated flags, and repetitions by leg', () => {
  const s = { name: 'm2', options: { ...base, shapes: 'M2' }, reps: { default: 2, L6: 10 } };
  assert.deepEqual(replayArgs(s, 'L1'), ['--shapes', 'M2', '--plan', 'peak', '--collateral-rule', 'ledger', '--validity', '--reps', '2']);
  assert.equal(repsOf(s, 'L6'), 10);
  assert.equal(repsOf(s, 'qualify'), 2);
  assert.equal(repsOf({ name: 'x', options: base }, 'L1'), 10);
  assert.deepEqual(replayArgs({ name: 'x', options: base }, 'L1').includes('--reps'), false);
  const h = { name: 'hist', options: { history: ['/a.jsonl', '/b.jsonl'], plan: 'recent', 'collateral-rule': 'ledger' }, reps: 5 };
  assert.deepEqual(replayArgs(h, 'L2'), ['--history', '/a.jsonl', '--history', '/b.jsonl', '--plan', 'recent', '--collateral-rule', 'ledger', '--reps', '5']);
});

test('the probe file is checked', () => {
  assert.doesNotThrow(() => checkProbe(probe([{ name: 'shapes', kill: true, options: base, reps: 10 }])));
  assert.throws(() => checkProbe({ format: 'other', stages: [] }), /format/);
  assert.throws(() => checkProbe(probe([])), /no stage/);
  assert.throws(() => checkProbe(probe([{ name: 'Bad Name', options: base }])), /name/);
  assert.throws(() => checkProbe(probe([{ name: 'a', options: base }, { name: 'a', options: base }])), /twice/);
  assert.throws(() => checkProbe(probe([{ name: 'a', options: { ...base, workers: 3 } }])), /--workers is set by the driver/);
  assert.throws(() => checkProbe(probe([{ name: 'a', options: { plan: 'peak' } }])), /exactly one/);
  assert.throws(() => checkProbe(probe([{ name: 'a', options: { ...base, history: 'x' } }])), /exactly one/);
  assert.throws(() => checkProbe(probe([{ name: 'a', options: base, reps: 0 }])), /reps/);
  assert.throws(() => checkProbe(probe([{ name: 'a', options: base, reps: { L9: 2 } }])), /reps/);
  assert.throws(() => checkProbe(probe([{ name: 'a', options: base, kill: 'yes' }])), /kill/);
});

test('the wallet count of shapes and of history files and directories', () => {
  mkdirSync(join(root, 'hist'));
  for (const f of ['a.jsonl', 'b.jsonl', 'c.txt']) writeFileSync(join(root, 'hist', f), '');
  writeFileSync(join(root, 'one.jsonl'), '');
  assert.equal(walletCount({ name: 'a', options: base }), 2);
  assert.equal(walletCount({ name: 'h', options: { history: [join(root, 'hist'), join(root, 'one.jsonl')] } }), 3);
});

test('the command line queries and the record writer', () => {
  const file = join(root, 'probe.json');
  writeFileSync(file, JSON.stringify(probe([{ name: 'shapes', kill: true, options: base, reps: 10 }, { name: 'm2', options: { ...base, shapes: 'M2' }, reps: { default: 2, L6: 10 } }])));
  const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8' });
  assert.equal(run('stages', file).stdout, 'shapes\nm2\n');
  assert.equal(run('reps', file, 'm2', 'L6').stdout, '10\n');
  assert.equal(run('reps', file, 'm2', 'L1').stdout, '2\n');
  assert.equal(run('kill', file, 'shapes').stdout, '1\n');
  assert.equal(run('kill', file, 'm2').stdout, '0\n');
  assert.equal(run('wallets', file, 'shapes').stdout, '2\n');
  assert.equal(run('args', file, 'shapes', 'L1').stdout.split('\n')[0], '--shapes');
  assert.equal(run('reps', file, 'nope', 'L1').status, 2);
  assert.equal(run('check', join(root, 'missing.json')).status, 2);
  const out = join(root, 'rec.json');
  assert.equal(run('record', out, 'leg=L3', 'wallSeconds=12', 'affinity="0-5"', 'burners=[{"pid":1}]', 'note=plain text').status, 0);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { leg: 'L3', wallSeconds: 12, affinity: '0-5', burners: [{ pid: 1 }], note: 'plain text' });
  assert.equal(run('get', out, 'wallSeconds').stdout, '12\n');
  assert.equal(run('get', out, 'absent').status, 2);
});
