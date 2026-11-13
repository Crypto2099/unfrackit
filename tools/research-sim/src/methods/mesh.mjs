// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Mesh, @meshsdk/transaction 1.9.1 (MeshJS/mesh at
// c0b183eccd0c20a465778f204f8c9caf73294bd8, the npm release's gitHead; the
// repository has no 1.9.1 tag), driven through MeshTxBuilder offline as its
// users drive it: txOut for each requested output, changeAddress,
// selectUtxosFrom and complete(). Paths below are under
// packages/mesh-transaction/src/mesh-tx-builder/ at that commit.
//
// The study method, mesh-rrri: Mesh's builder given no selector, so its
// default CardanoSdkInputSelector (index.ts:95-99), whose constraint callbacks
// are replaced by exact ones (mesh-rrri below). The selector sums the requested
// outputs into one output at a placeholder address before selecting
// (coin-selection/cardano-sdk-adapter.ts:139-144, :391-408), so on a spend with
// several requested outputs the library makes its change for that one summed
// output, and calls roundRobinRandomImprove of @cardano-sdk/input-selection
// 0.14.28, which Mesh pins, with no random option, so Math.random
// (:151-154). Its source tree is the one the cjs-rrri baseline runs at 0.14.35.
//
// The builder survey's subjects, with Mesh's own constraint callbacks
// (index.ts:251-331); they are not registered and cover no replay part
// (SURVEY_COVERAGE):
//   mesh-default  no selector option, as above
//   mesh-lf       selector: new LargestFirstInputSelector()
//                 (coin-selection/largest-first-selector.ts:145-399)
//
// Random source: Math.random is replaced for the length of one build and
// restored after it: by the replay job's generator (opts.random) when given,
// as cjs-rrri draws from it, and otherwise by a mulberry32 generator seeded
// with opts.seed, so a run can be repeated and the survey's comparison with
// cjs-rrri runs on the same draws. A worker runs one job at a time, and the
// engine awaits each build before the next.
//
// The survey's witnesses (setting serialization 'own'): the builder's own
// transaction with mock signatures (MeshTxBuilder serializeMockTx,
// index.ts:112-121), one per key hash it counts, as Mesh's serializer encodes
// them.
//
// Errors to failure classes (setting unclassified 'other' for the rest):
// input-selection's UtxoBalanceInsufficient, UtxoFullyDepleted and
// MaximumInputCountExceeded as for cjs-rrri (Mesh's nested 0.14.28 copy throws
// its own InputSelectionError class, so the failure is read by its string);
// "Not enough UTxOs to cover the required value." balance; "Transaction size
// exceeds the maximum allowed size." tx-size; for mesh-rrri, a skeleton whose
// fee the collateral set aside cannot cover (cjs.mjs NoCollateral) collateral.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { MeshTxBuilder, LargestFirstInputSelector } from '@meshsdk/transaction';
import { CLASSES } from '../kit/check.mjs';
import { inspectTx, unspentOutputParts } from '../kit/inspect.mjs';
import { passMachineErrors } from '../kit/machine.mjs';
import { replayRefusal, NotReplayable } from '../kit/replay.mjs';
import { minFee } from '../kit/fee.mjs';
import { addressTextOf } from '../state/utxo.mjs';
import { addressBytes } from '../history/address.mjs';
import { makeRng } from '../shapes/rng.mjs';
import { NOT_REPLAYABLE } from './contract.mjs';
import { buildWithChange } from './change.mjs';
import { exactConstraints, NoCollateral } from './cjs.mjs';
import { inputOrder, recordsOf, keyCount, refuseUncovered, REPLAY_COVERAGE, errorText, txRecord } from './library.mjs';

const require = createRequire(import.meta.url);
export const MESH_VERSION = JSON.parse(readFileSync(join(dirname(require.resolve('@meshsdk/transaction')), '..', 'package.json'), 'utf8')).version;
if (MESH_VERSION !== '1.9.1') throw new Error(`@meshsdk/transaction ${MESH_VERSION} is installed; the survey and the study run 1.9.1`);
// The input-selection copy Mesh's builder loads, nested under it.
const requireMesh = createRequire(require.resolve('@meshsdk/transaction'));
export const MESH_CJS_VERSION = JSON.parse(readFileSync(join(dirname(requireMesh.resolve('@cardano-sdk/input-selection')), '..', '..', 'package.json'), 'utf8')).version;
if (MESH_CJS_VERSION !== '0.14.28') throw new Error(`Mesh loads @cardano-sdk/input-selection ${MESH_CJS_VERSION}; its 1.9.1 release pins 0.14.28`);

// The survey's subjects cover no replay part: the survey runs payment intents
// only.
export const SURVEY_COVERAGE = Object.freeze([]);

const FAILURES = Object.freeze({
  'UTxO Balance Insufficient': CLASSES.balance,
  'UTxO Fully Depleted': CLASSES.changeMinimum,
  'Maximum Input Count Exceeded': CLASSES.maxInputs
});

export function classOfMeshError(e) {
  if (e instanceof NoCollateral) return CLASSES.collateral;
  if (e && e.name === 'InputSelectionError' && typeof e.failure === 'string' && FAILURES[e.failure]) return FAILURES[e.failure];
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
    // The default selector's Math.random is a generator seeded with
    // opts.seed for the build.
    seeded: true,
    async build(state, intent, params, opts) {
      refuseUncovered(name, SURVEY_COVERAGE, intent);
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

// ---- The study method, mesh-rrri.
//
// The library, at c0b183ec. complete() (index.ts:191-249) sets each requested
// output's minimum coin where it has none (sanitizeOutputs, :1011-1027), then
// selectUtxos (:251-330) hands its selector the inputs already in the builder
// (txIn: the preselected inputs), its outputs, the implicit value it derives
// from its own body (withdrawals, its own deposits and refunds for its
// certificates and proposals, mints; :257-262, :1280-1343), the candidates
// (selectUtxosFrom less those already inputs, :365-376) and the change
// address, with its four callbacks. CardanoSdkInputSelector.select
// (coin-selection/cardano-sdk-adapter.ts:124-197) sums the outputs into one
// (:139-144), converts the preselected inputs, the candidates and the
// implicit value to cardano-js-sdk's types (:146-149, :499-518), and runs
// roundRobinRandomImprove with a change-address resolver that puts every
// change output at the change address (:152-154, :200-217) and the callbacks
// bridged to the library's constraints (BuilderCallbacksSdkBridge, :34-122:
// the cost of a skeleton at a placeholder fee of 1,000,000,000, the selection
// limit as one input more or fewer than the skeleton's as the skeleton fits
// maxTxSize or not). The builder then adds the selected inputs, the change
// outputs and the fee to its body (updateByTxPrototype, index.ts:332-363) and
// serializes it with an empty auxiliary data and its hash when it carries no
// metadata (packages/mesh-core-cst/src/serializer/index.ts:716-720,
// :1576-1581): the tag-259 empty map, d90103a0, 38 bytes with field 7 over a
// transaction without one. Seeded as above.
//
// The call, as a dapp makes it for a payment: new MeshTxBuilder({ params })
// with no selector, txOut(address, value) for each requested output,
// changeAddress, selectUtxosFrom with the wallet's spendable UTxOs in the
// state's order, complete(). Before complete(), the builder's own selector is
// wrapped (exactSelector): the wrapper calls it with the builder's
// preselected inputs, outputs, candidates and change address as given, and
// replaces two things only: the four callbacks, by exact ones, and the
// implicit value, by the intent's (below), the builder's own being zero since
// it is given no certificate, withdrawal, mint or proposal.
//
// The exact callbacks (coin-selection/coin-selection-interface.ts:34-39) are
// cardano-js-sdk's exact constraints (cjs.mjs exactConstraints) on the
// transaction the kit assembles from the skeleton with Mesh's auxiliary data
// (asMeshWrites), so the fee the library settles on is the least fee of the
// transaction it is written into, and the size limit is that transaction's:
//   computeMinimumCost(p)          the least self-covering fee of the
//                                  skeleton's transaction: the builder's
//                                  preselected inputs and p.newInputs, the
//                                  requested outputs and p.change, the fixed
//                                  parts, the collateral set aside, Mesh's
//                                  auxiliary data; plus the intent's script fee
//   computeMinimumCoinQuantity(o)  CSL's min_ada_for_output for the output at
//                                  the wallet's change address in place of the
//                                  library's stub address
//   tokenBundleSizeExceedsLimit(a) the bundle's Value at the widest coin over
//                                  maxValSize
//   maxSizeExceed(p)               the skeleton's transaction at p.fee over
//                                  maxTxSize
// Mesh's own callbacks differ: its fee is that of its own serialization of a
// clone of the builder, its minimum coin is taken at the library's stub
// address, and its bundle test serializes the tokens with no coin
// (index.ts:264-320, :1749-1794).
//
// The replay path. Every intent is a replayed one (source 'replay'); its
// transaction is assembled by the ledger kit (kit/replay.mjs
// assembleReplayOnce) as cjs-rrri's is: the wallet inputs and the fixed
// inputs, the requested outputs as their own bytes, the change, the fee, the
// fixed parts as their original bytes, synthetic witnesses for the wallet's
// keys and the other vkey witnesses as observed, the collateral set aside.
// Mesh's own part of the transaction is its auxiliary data: when the intent
// carries none, the transaction carries Mesh's empty one (asMeshWrites), which
// each build checks against the transaction Mesh serialized; when it carries
// metadata, the intent's own bytes stand, as every replay writes them. The
// parts reach Mesh's selection as follows:
//   fixed inputs     txIn with each input's value, address and reference
//                    script size (index.ts:874-1010 asks a fetcher for an
//                    input without them), so the builder hands them to its
//                    selector as preselected inputs (cardano-sdk-adapter.ts:
//                    146-148, :158-160), whose value counts toward every
//                    target; never offered as candidates
//   withdrawals,     the intent's, in Mesh's ImplicitValue
//   refunds,         (coin-selection-interface.ts:11-16): withdrawals,
//   deposits,        reclaimDeposit, and deposit, a donation added to deposit
//   donation         (no field holds one; as cjs-rrri does), which Mesh's
//                    selector converts as its builder's own (:499-518)
//   mint, burn       ImplicitValue.mint, a burn as a negative quantity, as the
//                    builder's getTotalMint sums its mints (index.ts:1329-1343)
//   requested        txOut with the output's address and value: the selector
//   outputs          reads nothing else of them (makeAggregatedCSDKOOutput,
//                    :391-408); the kit writes each as its own bytes, so a
//                    datum, a script reference and a raised coin pass through
//   collateral       the UTxO the engine set aside, in every skeleton the
//                    callbacks price and in the transaction
// Only what the kit cannot write makes an intent not replayable (body field 6,
// kit/replay.mjs replayRefusal).
//
// Change policies: 'default' (L/own) writes the change Mesh's builder wrote;
// 'layout' (L/layout) makes the same call, reads the wallet inputs from the
// transaction Mesh serialized, drops its change, and builds UnFrack.It's
// layout change on those inputs (methods/change.mjs), assembled at its exact
// fee by the kit with the intent's parts, without Mesh's auxiliary data, as
// every layout path is. When those inputs cannot fund that change, class
// change-minimum (setting substitutedChange 'fail'). No other policy is
// accepted.

// Mesh's auxiliary data when it writes no metadata.
export const MESH_EMPTY_AUX = 'd90103a0';

// The intent as the transaction Mesh's builder writes carries it: with Mesh's
// empty auxiliary data when it has none of its own.
export function asMeshWrites(intent) {
  const f = intent.fixed;
  if (f && f.auxiliaryData) return intent;
  const fixed = f ? { ...f, auxiliaryData: MESH_EMPTY_AUX } : { inputs: [], referenceInputs: [], body: {}, witnesses: {}, redeemers: [], auxiliaryData: MESH_EMPTY_AUX, scriptFee: 0n, fixedBytes: 0, refScriptBytes: 0 };
  return { ...intent, fixed };
}

// A value in Mesh's Asset form and back.
const LOVELACE = (u) => u === 'lovelace' || u === '';
export function valueOfMesh(amount) {
  let coin = 0n;
  const assets = [];
  for (const a of amount || []) {
    if (LOVELACE(a.unit)) coin += BigInt(a.quantity);
    else assets.push({ policy: a.unit.slice(0, 56), name: a.unit.slice(56), qty: BigInt(a.quantity) });
  }
  assets.sort((x, y) => (x.policy < y.policy ? -1 : x.policy > y.policy ? 1 : x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  return { coin, assets };
}
const tokenMapOfMesh = (amount) => new Map((amount || []).filter((a) => !LOVELACE(a.unit)).map((a) => [a.unit, BigInt(a.quantity)]));

// The intent's implicit values in Mesh's ImplicitValue.
export function meshImplicitValue(imp) {
  const mint = new Map();
  const add = (a, sign) => {
    const unit = `${a.policy}${a.name}`;
    mint.set(unit, (mint.get(unit) || 0n) + sign * BigInt(a.qty));
  };
  for (const a of imp.mint) add(a, 1n);
  for (const a of imp.burn) add(a, -1n);
  return {
    withdrawals: BigInt(imp.withdrawals),
    deposit: BigInt(imp.deposits) + BigInt(imp.donation),
    reclaimDeposit: BigInt(imp.refunds),
    mint: [...mint].filter(([, q]) => q !== 0n).map(([unit, q]) => ({ unit, quantity: q.toString() }))
  };
}

// A fixed input's text address for Mesh: bech32, or hex for one bech32 does
// not write (a Byron address), as cjs-rrri gives it.
const addressText = (bytes) => {
  try {
    return addressTextOf(bytes);
  } catch {
    return Buffer.from(bytes).toString('hex');
  }
};

const refOfMeshUtxo = (u) => `${u.input.txHash}#${u.input.outputIndex}`;
const refOfMeshTxIn = (x) => `${x.txIn.txHash}#${x.txIn.txIndex}`;

// The exact callbacks in Mesh's form, over cardano-js-sdk's exact
// constraints: a skeleton of Mesh's (TransactionPrototype: newInputs, change,
// fee) as that library's (inputs with the preselected ones, change, fee).
export function exactMeshCallbacks(c, preselectedRefs) {
  const stub = (ref) => {
    const i = ref.lastIndexOf('#');
    return [{ txId: ref.slice(0, i), index: Number(ref.slice(i + 1)) }];
  };
  const txOut = (o) => {
    const v = valueOfMesh(o.amount);
    return { address: o.address, value: { coins: v.coin, assets: v.assets.length ? tokenMapOfMesh(o.amount) : undefined } };
  };
  const skeleton = (p) => ({ inputs: new Set([...preselectedRefs, ...[...p.newInputs].map(refOfMeshUtxo)].map(stub)), change: p.change.map(txOut), fee: p.fee });
  return {
    computeMinimumCost: async (p) => c.computeMinimumCost(skeleton(p)),
    computeMinimumCoinQuantity: (o) => c.computeMinimumCoinQuantity(txOut(o)),
    tokenBundleSizeExceedsLimit: (bundle) => c.tokenBundleSizeExceedsLimit(bundle ? tokenMapOfMesh(bundle) : undefined),
    maxSizeExceed: async (p) => {
      const sk = skeleton(p);
      return (await c.computeSelectionLimit(sk)) < sk.inputs.size;
    }
  };
}

// Mesh's own selector wrapped: the callbacks and the implicit value replaced,
// everything else as the builder gives it. `seen` records the call.
export function exactSelector(inner, { constraints, implicitValue }) {
  const seen = {};
  return {
    seen,
    async select(preselected, outputs, builderImplicit, utxos, changeAddress) {
      const own = builderImplicit;
      if (own.withdrawals !== 0n || own.deposit !== 0n || own.reclaimDeposit !== 0n || own.mint.length) throw new Error('mesh-rrri: the builder derived an implicit value from a body given none');
      seen.preselected = preselected.map(refOfMeshTxIn);
      seen.outputs = outputs.length;
      seen.candidates = utxos.length;
      seen.result = await inner.select(preselected, outputs, implicitValue, utxos, changeAddress, exactMeshCallbacks(constraints, seen.preselected));
      return seen.result;
    }
  };
}

const sameValue = (a, b) => a.coin === b.coin && JSON.stringify(a.assets.map((x) => [x.policy, x.name, String(x.qty)])) === JSON.stringify(b.assets.map((x) => [x.policy, x.name, String(x.qty)]));

export function meshStudyMethod(T) {
  const name = 'mesh-rrri';
  return {
    name,
    version: `@meshsdk/transaction ${MESH_VERSION} CardanoSdkInputSelector (@cardano-sdk/input-selection ${MESH_CJS_VERSION} roundRobinRandomImprove)`,
    deterministic: false,
    // Its draws come from opts.random or a generator seeded with opts.seed,
    // through Math.random.
    seeded: true,
    async build(state, intent, params, opts) {
      refuseUncovered(name, REPLAY_COVERAGE.mesh, intent);
      const layout = opts.changePolicy === 'layout';
      if (opts.changePolicy !== 'default' && !layout) return { ok: false, class: CLASSES.other, detail: 'Mesh\'s default takes its own change or the layout change only' };
      if (intent.source !== 'replay') throw new Error(`${name}: builds replayed intents only`);
      const refusal = replayRefusal(intent);
      if (refusal) return { ok: false, class: NOT_REPLAYABLE, detail: refusal };
      let random = opts.random;
      if (!random) {
        if (!Number.isSafeInteger(opts.seed)) throw new Error(`${name}: a seed is required`);
        const rng = makeRng(opts.seed);
        random = () => rng.next();
      }
      const collateral = opts.collateral || null;
      const written = asMeshWrites(intent);
      const trace = { costs: [], bundles: [] };
      const constraints = exactConstraints(T, { state, params, intent: written, trace, collateral });
      const fixedRefs = new Set(intent.fixed ? intent.fixed.inputs.map((x) => x.ref) : []);
      let b;
      let selector;
      let unsigned;
      let draws = 0;
      const saved = Math.random;
      try {
        b = new MeshTxBuilder({ params: meshParams(params) });
        selector = exactSelector(b.selector, { constraints, implicitValue: meshImplicitValue(intent.implicit) });
        b.selector = selector;
        for (const o of intent.requested) b.txOut(o.address, meshAmount(o.coin, o.assets));
        for (const x of intent.fixed ? intent.fixed.inputs : []) {
          const p = unspentOutputParts(x.cbor);
          b.txIn(p.txid, p.index, meshAmount(p.coin, p.assets), addressText(p.address), p.scriptRef ? p.scriptRef.size : 0);
        }
        b.changeAddress(state.changeAddress);
        b.selectUtxosFrom(inputOrder(state).filter((u) => !fixedRefs.has(u.ref)).map(meshUtxo));
        Math.random = () => {
          draws++;
          return random();
        };
        unsigned = await b.complete();
      } catch (e) {
        passMachineErrors(e);
        if (e instanceof NotReplayable) return { ok: false, class: NOT_REPLAYABLE, detail: e.message };
        return { ok: false, class: classOfMeshError(e), detail: `complete: ${errorText(e)}` };
      } finally {
        Math.random = saved;
        constraints.free();
      }
      // What Mesh wrote: its inputs, its outputs after the requested ones (its
      // change), its fee and its auxiliary data.
      const t = inspectTx(unsigned);
      const refs = t.inputs.map((x) => x.ref);
      for (const r of fixedRefs) if (!refs.includes(r)) return { ok: false, class: CLASSES.other, detail: `the library left out the fixed input ${r}` };
      const inputs = recordsOf(state, refs.filter((r) => !fixedRefs.has(r)));
      const walletRefs = inputs.map((u) => u.ref);
      if (t.outputs.length < intent.requested.length) throw new Error(`${name}: Mesh wrote ${t.outputs.length} outputs for ${intent.requested.length} requested`);
      const change = t.outputs.slice(intent.requested.length).map((o) => ({ address: state.changeAddress, coin: o.coin, assets: o.assets }));
      const proto = selector.seen.result;
      if (proto.change.length !== change.length || proto.change.some((c, i) => !sameValue(valueOfMesh(c.amount), change[i]))) throw new Error(`${name}: the change Mesh wrote is not the change its selector returned`);
      const changeBytes = addressBytes(state.changeAddress);
      if (!t.outputs.slice(intent.requested.length).every((o) => o.address.equals(changeBytes))) throw new Error(`${name}: Mesh wrote change away from the change address`);
      if (!intent.fixed || !intent.fixed.auxiliaryData) {
        const aux = t.tx.aux ? Buffer.from(t.tx.aux.raw).toString('hex') : null;
        if (aux !== MESH_EMPTY_AUX) throw new Error(`${name}: Mesh wrote the auxiliary data ${aux}, not the ${MESH_EMPTY_AUX} the callbacks priced`);
      }
      // Mesh's own serialization, for the tests: the transaction complete()
      // returned, unsigned.
      const library = { fee: t.fee, draws, change: change.length, outputs: selector.seen.outputs, preselected: selector.seen.preselected.length, meshTx: unsigned };
      if (layout) {
        const r = buildWithChange(T, { state, params, inputs, intent, policy: 'layout', collateral });
        if (!r.ok) return { ok: false, class: r.class, detail: `layout change on the library's inputs: ${r.detail}` };
        return { ok: true, kind: 'single', txs: [txRecord(r.bytes, walletRefs, r.fee, r.size, r.k)], library };
      }
      for (const o of change) if (o.coin < 0n) return { ok: false, class: CLASSES.other, detail: `the library returned an output with coin ${o.coin}` };
      const a = constraints.replay.at(refs, change, t.fee);
      if (!a.ok) return { ok: false, class: a.class, detail: a.detail };
      return { ok: true, kind: 'single', txs: [txRecord(a.bytes, walletRefs, t.fee, a.size, a.k)], library: { ...library, finalMinFee: minFee(params, a.size, written.fixed.scriptFee || 0n), costs: trace.costs.length } };
    }
  };
}
