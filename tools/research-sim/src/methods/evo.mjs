// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The Evolution SDK baseline, evo-lf: @evolution-sdk/evolution 0.6.0
// (IntersectMBO/evolution-sdk at c4139df12e099dbd4742d3e2c10dc52f50a4bd41,
// packages/evolution/src/sdk/builders/), its transaction builder at its
// defaults: no coinSelection option, so largest-first, and no unfrack option.
// The builder is made with no wallet and no provider (makeTxBuilder,
// TransactionBuilder.ts:1783-1792) and given the change address, the available
// UTxOs and the run's protocol parameters at build time (BuildOptions,
// :472-601). It serves H-7 and H-12 only, so it takes no change substitution.
//
// The library, at that commit:
//   CoinSelection.ts:67-113, largestFirstSelection: every available UTxO
//   sorted by its lovelace alone, descending, with a comparator that returns 0
//   for equal lovelace (JavaScript's stable sort keeps the given order among
//   them), taken in that order until the required assets are covered; a UTxO
//   holding a requested token is reached only through that order. It throws
//   CoinSelectionError when a unit is still short.
//   phases/Selection.ts:58-86: no option resolves to largestFirstSelection;
//   the names "random-improve" and "optimal" throw "not yet implemented".
//   phases/ChangeCreation.ts:261-379: every leftover asset goes into one
//   change output; when its lovelace is under that output's minimum the
//   builder selects again, up to three attempts, then fails when the leftover
//   carries tokens. The builder's ProtocolParameters (TransactionBuilder.ts:
//   302-323) carry no value-size limit, so a change output over it is built as
//   one output and the kit's value-size check fails it; the adapter never
//   splits it.
//   internal/txBuilder.ts:1119-1321: the fee is priced with one fake vkey
//   witness per distinct payment key hash among the inputs, and sizes are the
//   serialized length (:1071-1072), validity flag included.
//
// Witnesses (setting serialization 'own'): the transaction the library returns
// with its own fake witnesses (TransactionResult toTransactionWithFakeWitnesses),
// one 32-byte key and 64-byte signature per distinct payment key, as the
// library serializes them.
//
// Errors to failure classes (setting unclassified 'other' for the rest):
//   TransactionBuilderError caused by CoinSelectionError       balance
//   "Cannot balance transaction: Native assets present in leftover but
//   insufficient lovelace" (ChangeCreation.ts:306-324)          change-minimum
//   "Cannot create valid change: Insufficient funds" (the ADA-only leftover
//   under its minimum with no fallback, :326-345)               change-minimum
//   "Transaction size (...) exceeds protocol maximum" (internal/build.ts:
//   119-127)                                                    tx-size

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as E from '@evolution-sdk/evolution';
import { makeTxBuilder } from '@evolution-sdk/evolution/sdk/builders/TransactionBuilder';
import { CLASSES } from '../kit/check.mjs';
import { unspentOutputParts, inspectTx } from '../kit/inspect.mjs';
import { inputOrder, recordsOf, keyCount, batteryOnly, errorText, txRecord } from './library.mjs';

export const EVO_VERSION = JSON.parse(readFileSync(createRequire(import.meta.url).resolve('@evolution-sdk/evolution/package.json'), 'utf8')).version;
if (EVO_VERSION !== '0.6.0') throw new Error(`@evolution-sdk/evolution ${EVO_VERSION} is installed; the baseline is 0.6.0`);

export function classOfEvoError(e) {
  const m = errorText(e);
  if (e && e.cause && e.cause._tag === 'CoinSelectionError') return CLASSES.balance;
  if (/^Cannot balance transaction: Native assets present in leftover but insufficient lovelace/.test(m)) return CLASSES.changeMinimum;
  if (/^Cannot create valid change: Insufficient funds/.test(m)) return CLASSES.changeMinimum;
  if (/^Transaction size \(\d+ bytes\) exceeds protocol maximum/.test(m)) return CLASSES.txSize;
  return CLASSES.other;
}

// The library's chain descriptor for the run's network; the synthetic shapes
// carry mainnet addresses.
const chainOf = (network) => (network === 'preprod' ? E.preprod : E.mainnet);

const UTXOS = new WeakMap();
export function evoUtxo(u) {
  let x = UTXOS.get(u);
  if (!x) {
    const p = unspentOutputParts(u.cbor);
    const out = E.TxOut.fromCBORHex(p.outputRaw.toString('hex'));
    x = new E.UTxO.UTxO({ transactionId: E.TransactionHash.fromHex(p.txid), index: BigInt(p.index), address: out.address, assets: out.assets, datumOption: out.datumOption, scriptRef: out.scriptRef });
    UTXOS.set(u, x);
  }
  return x;
}

// The fee parameters the builder takes (the deprecated protocolParameters
// form, which needs no cost models; the battery path builds no script).
export const evoProtocolParameters = (params) => ({
  minFeeCoefficient: params.minFeeA,
  minFeeConstant: params.minFeeB,
  coinsPerUtxoByte: params.coinsPerUtxoByte,
  maxTxSize: params.maxTxSize
});

const refOfInput = (i) => `${E.TransactionHash.toHex(i.transactionId)}#${i.index}`;

// unfrack: the library's unfrack option ({} for its defaults), for the
// builder survey only; the baseline runs without it.
export function evoMethod({ unfrack = null } = {}) {
  const name = unfrack ? 'evo-unfrack' : 'evo-lf';
  return {
    name,
    version: `@evolution-sdk/evolution ${EVO_VERSION} largest-first${unfrack ? ', unfrack' : ''}`,
    deterministic: true,
    async build(state, intent, params, opts) {
      batteryOnly(name, intent);
      if (opts.changePolicy !== 'default') return { ok: false, class: CLASSES.other, detail: 'the Evolution SDK baseline takes no change substitution' };
      let b = makeTxBuilder({ chain: chainOf(state.network) });
      for (const o of intent.requested) {
        const out = E.TxOut.fromCBORHex(o.cbor);
        b = b.payToAddress({ address: out.address, assets: out.assets });
      }
      const options = {
        changeAddress: E.Address.fromBech32(state.changeAddress),
        availableUtxos: inputOrder(state).map(evoUtxo),
        protocolParameters: evoProtocolParameters(params)
      };
      if (unfrack) options.unfrack = unfrack;
      let r;
      try {
        r = await b.buildEither(options);
      } catch (e) {
        return { ok: false, class: classOfEvoError(e), detail: `build: ${errorText(e)}` };
      }
      if (r._tag === 'Left') {
        const e = r.left;
        const cause = e && e.cause && e.cause.message ? ` (${e.cause.message})` : '';
        return { ok: false, class: classOfEvoError(e), detail: `build: ${errorText(e).split('\n')[0]}${cause}` };
      }
      const tx = await r.right.toTransactionWithFakeWitnesses();
      const refs = tx.body.inputs.map(refOfInput);
      const inputs = recordsOf(state, refs);
      const vkeys = tx.witnessSet.vkeyWitnesses ? tx.witnessSet.vkeyWitnesses.length : 0;
      const k = keyCount(inputs);
      if (vkeys !== k) throw new Error(`${name}: the library's fake witness set has ${vkeys} vkey witnesses for ${k} payment keys`);
      const bytes = E.Transaction.toCBORHex(tx);
      return { ok: true, kind: 'single', txs: [txRecord(bytes, refs, tx.body.fee, inspectTx(bytes).size, k)] };
    }
  };
}
