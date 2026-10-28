// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oracleRecord } from '../../../src/oracle/battery-hook.mjs';
import { record, assertClean } from '../../../src/out/records.mjs';

const TXID = 'ab'.repeat(32);

// A result as searchOracle returns it, with the transaction's bytes and
// input references that a record must not carry.
const result = (extra = {}) => ({
  status: 'best-at-limit',
  path: 'mip',
  paths: ['mip'],
  scope: 'spendable',
  candidates: 31,
  candidateSet: 24,
  policy: 'csl',
  fee: 190000n,
  bound: 180000n,
  tx: 'cd'.repeat(300),
  best: { fee: 190000n, txFee: 190000n, minFee: 189000n, size: 412, k: 2, inputs: [`${TXID}#0`, `${TXID}#3`], hash: 'ef'.repeat(32) },
  bestFrom: 'mip',
  bestInSpace: true,
  bestInCandidates: false,
  exhaustive: null,
  ms: 1234.5,
  wallMs: 1250,
  terminated: false,
  incumbents: [{ name: 'csl-lf', fee: 200000n, inputs: 3, result: 'feasible', oracleFee: 200000n, sameChange: true }, { name: 'csl-ri', fee: null, inputs: 2, result: 'kit', detail: `input ${TXID}#1 is short` }],
  evaluations: { evaluations: 10, cached: 2, feasible: 4, ms: 5 },
  detail: { mip: { stop: 'limit', bound: 180000, rejections: [{ detail: TXID }] } },
  settings: { afterExhaustive: 'mip-always' },
  solver: 'highs 1.15.4',
  ...extra
});

test('an oracle result becomes a record the guard accepts, without the transaction', () => {
  const r = oracleRecord(result());
  assert.equal(r.status, 'best-at-limit');
  assert.equal(r.fee, 190000n);
  assert.equal(r.stop, 'limit');
  assert.equal(r.mipBound, 180000);
  assert.equal(r.inputs, 2);
  assert.equal(r.size, 412);
  assert.equal(r.bestFrom, 'mip');
  assert.deepEqual(r.incumbents.map((i) => i.sameChange), [true, null]);
  for (const k of ['tx', 'hash', 'best']) assert.equal(k in r, false);
  assert.doesNotThrow(() => assertClean(r));
  const rec = record('battery', { wallet: 'S1', window: 'snapshot', arm: 'observed', variant: 'default', method: 'oracle', change: 'csl', collateral: 'none-needed', repetition: 1 }, { spend: 'x', oracle: r });
  assert.equal(JSON.stringify(rec, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).includes(TXID), false, 'the incumbent detail is scrubbed');
});

test('the guard still refuses the raw result', () => {
  assert.throws(() => assertClean(result()));
});

test('a result with no solution and an exhaustive path records its stop as null', () => {
  const r = oracleRecord(result({ status: 'infeasible', fee: null, best: null, tx: null, bound: null, detail: { nodes: 4 } }));
  assert.equal(r.fee, null);
  assert.equal(r.inputs, null);
  assert.equal(r.stop, null);
  assert.doesNotThrow(() => assertClean(r));
});
