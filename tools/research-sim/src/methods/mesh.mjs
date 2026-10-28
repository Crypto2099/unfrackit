// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Mesh, for the builder survey and the comparison with cjs-rrri only; it is
// not a baseline. @meshsdk/transaction 1.9.1 (MeshJS/mesh at
// c0b183eccd0c20a465778f204f8c9caf73294bd8, the npm release's gitHead; the
// repository has no 1.9.1 tag), driven through MeshTxBuilder offline as its
// users drive it: txOut for each requested output, changeAddress,
// selectUtxosFrom and complete(), with Mesh's own constraint callbacks
// (packages/mesh-transaction/src/mesh-tx-builder/index.ts:251-331).
//
//   mesh-default  no selector option, so CardanoSdkInputSelector
//                 (index.ts:95-99), which sums the requested outputs into one
//                 output at a placeholder address before selecting
//                 (coin-selection/cardano-sdk-adapter.ts:139-143 and
//                 :391-408) and calls roundRobinRandomImprove of
//                 @cardano-sdk/input-selection 0.14.28, which Mesh pins, with
//                 no random option, so Math.random (:124-198)
//   mesh-lf       selector: new LargestFirstInputSelector()
//                 (coin-selection/largest-first-selector.ts:145-399)
//
// Random source: Math.random is replaced by a mulberry32 generator seeded
// with opts.seed for the length of one build and restored after it, so a run
// can be repeated and compared with cjs-rrri on the same draws.
//
// Witnesses (setting serialization 'own'): the builder's own transaction with
// mock signatures (MeshTxBuilder serializeMockTx, index.ts:112-121), one per
// key hash it counts, as Mesh's serializer encodes them.
//
// Errors to failure classes, for the survey's table (setting unclassified
// 'other' for the rest): input-selection's UtxoBalanceInsufficient,
// UtxoFullyDepleted and MaximumInputCountExceeded as for cjs-rrri; "Not enough
// UTxOs to cover the required value." balance; "Transaction size exceeds the
// maximum allowed size." tx-size.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { MeshTxBuilder, LargestFirstInputSelector } from '@meshsdk/transaction';
import { CLASSES } from '../kit/check.mjs';
import { inspectTx } from '../kit/inspect.mjs';
import { makeRng } from '../shapes/rng.mjs';
import { inputOrder, recordsOf, keyCount, refuseUncovered, REPLAY_COVERAGE, errorText, txRecord } from './library.mjs';

const require = createRequire(import.meta.url);
export const MESH_VERSION = JSON.parse(readFileSync(join(dirname(require.resolve('@meshsdk/transaction')), '..', 'package.json'), 'utf8')).version;
if (MESH_VERSION !== '1.9.1') throw new Error(`@meshsdk/transaction ${MESH_VERSION} is installed; the survey runs 1.9.1`);

const FAILURES = Object.freeze({
  'UTxO Balance Insufficient': CLASSES.balance,
  'UTxO Fully Depleted': CLASSES.changeMinimum,
  'Maximum Input Count Exceeded': CLASSES.maxInputs
});

export function classOfMeshError(e) {
  if (e && typeof e.failure === 'string' && FAILURES[e.failure]) return FAILURES[e.failure];
  const m = errorText(e);
  if (/^Not enough UTxOs to cover the required value\./.test(m)) return CLASSES.balance;
  if (/^Transaction size exceeds the maximum allowed size\./.test(m)) return CLASSES.txSize;
  return CLASSES.other;
}

export const meshAmount = (coin, assets) => [{ unit: 'lovelace', quantity: coin.toString() }, ...assets.map((a) => ({ unit: `${a.policy}${a.name}`, quantity: a.qty.toString() }))];

export function meshUtxo(u) {
  const [txHash, i] = u.ref.split('#');
  return { input: { txHash, outputIndex: Number(i) }, output: { address: u.address, amount: meshAmount(u.coin, u.assets) } };
}

// The run's parameters in Mesh's Protocol form (packages/mesh-common/src/types/
// protocol.ts), the prices as Mesh's numbers.
export const meshParams = (params) => ({
  epoch: params.epoch ?? 0,
  minFeeA: Number(params.minFeeA),
  minFeeB: Number(params.minFeeB),
  coinsPerUtxoSize: Number(params.coinsPerUtxoByte),
  maxTxSize: params.maxTxSize,
  maxValSize: params.maxValSize,
  keyDeposit: Number(params.keyDeposit),
  poolDeposit: Number(params.poolDeposit),
  maxCollateralInputs: params.maxCollateralInputs,
  collateralPercent: params.collateralPercent,
  ...(params.priceMem ? { priceMem: Number(params.priceMem[0]) / Number(params.priceMem[1]) } : {}),
  ...(params.priceStep ? { priceStep: Number(params.priceStep[0]) / Number(params.priceStep[1]) } : {})
});

const refsOfTx = (bytes) => inspectTx(bytes).inputs.map((x) => x.ref);

export function meshMethod({ selector = 'default' } = {}) {
  if (selector !== 'default' && selector !== 'largest-first') throw new Error(`mesh: unknown selector ${selector}`);
  const name = selector === 'default' ? 'mesh-default' : 'mesh-lf';
  return {
    name,
    version: `@meshsdk/transaction ${MESH_VERSION} ${selector === 'default' ? 'CardanoSdkInputSelector' : 'LargestFirstInputSelector'}`,
    deterministic: selector !== 'default',
    async build(state, intent, params, opts) {
      refuseUncovered(name, REPLAY_COVERAGE.mesh, intent);
      if (opts.changePolicy !== 'default') return { ok: false, class: CLASSES.other, detail: 'Mesh is surveyed at its own change only' };
      const b = new MeshTxBuilder({ params: meshParams(params), ...(selector === 'default' ? {} : { selector: new LargestFirstInputSelector() }) });
      for (const o of intent.requested) b.txOut(o.address, meshAmount(o.coin, o.assets));
      b.changeAddress(state.changeAddress);
      b.selectUtxosFrom(inputOrder(state).map(meshUtxo));
      const saved = Math.random;
      let draws = 0;
      if (selector === 'default') {
        if (!Number.isSafeInteger(opts.seed)) throw new Error(`${name}: a seed is required`);
        const rng = makeRng(opts.seed);
        Math.random = () => {
          draws++;
          return rng.next();
        };
      }
      let unsigned;
      try {
        unsigned = await b.complete();
      } catch (e) {
        return { ok: false, class: classOfMeshError(e), detail: `complete: ${errorText(e)}` };
      } finally {
        Math.random = saved;
      }
      const bytes = b.serializeMockTx();
      const refs = refsOfTx(bytes);
      if (JSON.stringify(refsOfTx(unsigned)) !== JSON.stringify(refs)) throw new Error(`${name}: the mock-signed transaction has other inputs than the built one`);
      const inputs = recordsOf(state, refs);
      const k = keyCount(inputs);
      const t = inspectTx(bytes);
      return { ok: true, kind: 'single', txs: [txRecord(bytes, refs, t.fee, t.size, k)], library: { draws, vkeys: t.vkeys.length } };
    }
  };
}
