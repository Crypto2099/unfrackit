// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The Yoroi wallet's send flow (yoroi-lf, methods/yoroi.mjs), built from the
// wallet's source by scripts/build-yoroi.mjs: its own change (L/own) and
// UnFrack.It's layout change on the inputs it selected (L/layout). The
// adapter covers every replay part and is deterministic; its errors map to
// the failure classes; the loader refuses a missing or altered build, naming
// the script. With the build and the treatment: every UTxO holding a
// requested token is taken, then the ADA-only UTxOs largest first, ties in
// the state's order; an ADA-only payment drops token UTxOs when the rest
// suffice; any seed gives the same bytes and L/own and L/layout hold the same
// inputs; inputs that cannot fund the layout change fail with class
// change-minimum; a first build that fails on the change output is a
// change-minimum failure under L/own although the wallet then built with a
// lowered amount, and L/layout takes that transaction's inputs; the wallet
// drops a token with an empty asset name from what it writes; a TTL, metadata
// and a datum hash replay; observed vkey witnesses are written unpriced; each
// part the send flow cannot express is not replayable under both policies;
// and the synthetic streams of S1 and M1 replay with no validity failure.
// The tests that need the build skip without it, naming the script.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { treatment, skip as noTreatment } from '../../lib/treatment.mjs';
import { classOfYoroiError, metadataEntries, TTL_BUFFER, yoroiBuildProblem, loadYoroi } from '../../../src/methods/yoroi.mjs';
import { OUTPUT_DIR, BUNDLE, BUILD_RECORD, YOROI_CSL } from '../../../src/methods/yoroi-source.mjs';
import { makeMethod } from '../../../src/methods/registry.mjs';
import { REPLAY_PARTS, REPLAY_COVERAGE, inputOrder } from '../../../src/methods/library.mjs';
import { NOT_REPLAYABLE, choosesOwnCollateral } from '../../../src/methods/contract.mjs';
import { CLASSES } from '../../../src/kit/check.mjs';
import { checkAndApply } from '../../../src/kit/apply.mjs';
import { inspectTx } from '../../../src/kit/inspect.mjs';
import { syntheticVkeys } from '../../../src/kit/replay.mjs';
import { outputBytes } from '../../../src/kit/assemble.mjs';
import { replay } from '../../../src/replay/engine.mjs';
import { loadSource } from '../../../src/replay/source.mjs';
import { SYNTHETIC_PARAMS } from '../../../src/kit/params.mjs';
import { decodeTx } from '../../../src/history/tx.mjs';
import { addressBytes } from '../../../src/history/address.mjs';
import { encodeOutput } from '../../../src/history/output.mjs';
import { encUint, encBytes, encArray, encMap, encTag, encText } from '../../../src/history/cbor.mjs';
import { blake2b256 } from '../../../src/history/blake2b.mjs';
import { constructState, policy, assetName, ADA } from '../../lib/construct.mjs';
import { replayIntent, payTo } from '../../lib/script-intents.mjs';

const P = SYNTHETIC_PARAMS;
const own = { changePolicy: 'default', seed: 1 };
const layout = { changePolicy: 'layout', seed: 1 };
const noBuild = yoroiBuildProblem() || false;
const BUILD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', OUTPUT_DIR);
const skip = noTreatment || noBuild;
const hex = (b) => Buffer.from(b).toString('hex');

test('Yoroi covers every replay part and its errors map to the failure classes', () => {
  assert.deepEqual(REPLAY_COVERAGE.yoroi, [...REPLAY_PARTS]);
  const cases = [
    ['Not enough ADA to create change output with 3 tokens. The change output requires more ADA ...', CLASSES.changeMinimum],
    ['Failed to create send transaction: Not enough ADA leftover to include non-ADA assets in a change address', CLASSES.changeMinimum],
    ['Not enough balance for transaction', CLASSES.balance],
    ['Failed to create send transaction: Insufficient input in transaction. shortage: {...}', CLASSES.balance],
    ['UTxO Balance Insufficient', CLASSES.balance],
    ['Failed to create send transaction: Maximum transaction size of 16384 exceeded. Found: 16500', CLASSES.txSize],
    ['Failed to create send transaction: Maximum value size of 5000 exceeded. Found: 5100', CLASSES.valueSize],
    ['No outputs', CLASSES.other],
    ['Failed to create send transaction: Invalid address: x', CLASSES.other]
  ];
  for (const [m, cls] of cases) assert.equal(classOfYoroiError(m), cls, m);
  assert.equal(TTL_BUFFER, 7200);
});

test('the metadata of an auxiliary data in each of its three forms, and a script in it refused', () => {
  const md = encMap([[encUint(674), encMap([[encText('msg'), encArray([encText('hi')])]])]]);
  const want = [[674n, hex(encMap([[encText('msg'), encArray([encText('hi')])]]))]];
  const forms = [md, encArray([md, encArray([])]), encTag(259, encMap([[encUint(0), md]]))];
  for (const f of forms) assert.deepEqual(metadataEntries(hex(f)).map(([l, b]) => [l, hex(b)]), want);
  assert.throws(() => metadataEntries(hex(encArray([md, encArray([encArray([encUint(1), encBytes(Buffer.alloc(28))])])]))), /holding a script/);
  assert.throws(() => metadataEntries(hex(encTag(259, encMap([[encUint(0), md], [encUint(1), encArray([encBytes(Buffer.alloc(28))])]])))), /holding a script/);
});

test('the loader refuses a missing build and names the script', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yoroi-build-'));
  try {
    assert.match(yoroiBuildProblem(dir), /missing/);
    assert.throws(() => loadYoroi(dir), /scripts\/build-yoroi\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the loader refuses a build whose bundle or record differs from the pins', { skip: noBuild }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'yoroi-build-'));
  try {
    cpSync(BUILD_DIR, dir, { recursive: true });
    assert.equal(yoroiBuildProblem(dir), null);
    appendFileSync(join(dir, BUNDLE), '\n');
    assert.match(yoroiBuildProblem(dir), /differs from the pins \(the bundle's SHA-256\)/);
    assert.throws(() => loadYoroi(dir), /scripts\/build-yoroi\.mjs/);
    cpSync(join(BUILD_DIR, BUNDLE), join(dir, BUNDLE));
    const rec = JSON.parse(readFileSync(join(dir, BUILD_RECORD), 'utf8'));
    writeFileSync(join(dir, BUILD_RECORD), JSON.stringify({ ...rec, commit: '0'.repeat(40) }));
    assert.match(yoroiBuildProblem(dir), /differs from the pins \(commit 0{40}\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const T = await treatment();
const tokenPay = (i, coin, assets) => {
  const p = payTo(T, i, coin);
  return { ...p, assets, cbor: outputBytes(T, { address: p.address, coin, assets }).toString('hex') };
};
const pos = (s, refs) => refs.map((r) => inputOrder(s).findIndex((u) => u.ref === r));

test('yoroi-lf is made by name from the build, deterministic, given the collateral set aside, and refuses another change policy and a battery intent', { skip }, async () => {
  const m = makeMethod(T, 'yoroi-lf');
  assert.equal(m.version, `Yoroi v7.0.5 (d8e3d3f) createSendTx over cardano-serialization-lib ${YOROI_CSL.version}`);
  assert.deepEqual([m.deterministic, m.seeded, choosesOwnCollateral(m)], [true, true, false]);
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const it = replayIntent('y0', 10, { type: 'T1', requested: [payTo(T, 0, 3n * ADA)] });
  assert.equal((await m.build(s, it, P, own)).ok, true);
  const r = await m.build(s, it, P, { changePolicy: 'ladder', seed: 1 });
  assert.deepEqual([r.ok, r.class], [false, CLASSES.other]);
  assert.match(r.detail, /its own change or the layout change only/);
  await assert.rejects(async () => m.build(s, { ...it, source: 'battery' }, P, own), /replayed intents only/);
});

test('every UTxO holding a requested token, then the ADA-only UTxOs largest first, ties in the state\'s order; the same bytes for any seed and the same inputs under both changes', { skip }, async () => {
  const m = makeMethod(T, 'yoroi-lf');
  const x = { policy: policy('x'), name: assetName('x') };
  const y = { policy: policy('y'), name: assetName('y') };
  const s = constructState(T, [{ coin: 1500000n, assets: [{ ...x, qty: 3n }] }, { coin: 1500000n, assets: [{ ...x, qty: 2n }] }, { coin: 5n * ADA, assets: [{ ...y, qty: 1n }] }, { coin: 3n * ADA }, { coin: 9n * ADA }, { coin: 9n * ADA }]);
  // The state's order (txid#index) of these labels: 3 ADA, the two x
  // UTxOs, the y UTxO, the two 9 ADA UTxOs.
  assert.deepEqual(inputOrder(s).map((u) => u.coin), [3n * ADA, 1500000n, 1500000n, 5n * ADA, 9n * ADA, 9n * ADA]);
  const it = replayIntent('y1', 10, { type: 'T2', requested: [tokenPay(0, 2n * ADA, [{ ...x, qty: 4n }])] });
  const a = await m.build(s, it, P, own);
  const a2 = await m.build(s, it, P, { ...own, seed: 2 });
  const b = await m.build(s, it, P, layout);
  assert.equal(a.ok, true, a.detail);
  assert.equal(a.txs[0].bytes, a2.txs[0].bytes);
  // Both x UTxOs (helpers.ts:253-268), then the first of the two 9 ADA
  // UTxOs (sortUtxosByAda, a stable sort; :365-420).
  assert.deepEqual(pos(s, a.txs[0].walletInputs).sort(), [1, 2, 4]);
  assert.equal(b.ok, true, b.detail);
  assert.deepEqual(new Set(b.txs[0].walletInputs), new Set(a.txs[0].walletInputs));
  for (const r of [a, b]) assert.equal(checkAndApply(s, P, r.txs).ok, true);
  // CSL's change with prefer_pure_change: the token change at its minimum
  // and the ADA left as a separate output.
  const outs = inspectTx(a.txs[0].bytes).outputs;
  assert.equal(outs.length, 3);
  assert.deepEqual(outs.map((o) => o.assets.length), [1, 1, 0]);
});

test('an ADA-only payment leaves token UTxOs out when the ADA-only ones cover the outputs, the fee estimate and 1 ADA', { skip }, async () => {
  const m = makeMethod(T, 'yoroi-lf');
  const y = { policy: policy('y'), name: assetName('y') };
  const s = constructState(T, [{ coin: 50n * ADA, assets: [{ ...y, qty: 1n }] }, { coin: 9n * ADA }, { coin: 3200000n }]);
  // The selection takes 9 and 3.2 ADA, short of 11 ADA, the estimate, 0.1
  // ADA and 1 ADA, then the token UTxO; dropping it leaves 12.2 ADA, which
  // covers 11 ADA, the estimate and 1 ADA (createSendTx.ts:338-416).
  const it = replayIntent('y2', 10, { type: 'T1', requested: [payTo(T, 0, 11n * ADA)] });
  const r = await m.build(s, it, P, own);
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(r.txs[0].walletInputs.map((ref) => s.utxos.get(ref).coin).sort(), [3200000n, 9n * ADA]);
  assert.equal(checkAndApply(s, P, r.txs).ok, true);
});

test('inputs that cannot fund the layout change fail with class change-minimum, where the wallet burns the leftover into its fee', { skip }, async () => {
  const m = makeMethod(T, 'yoroi-lf');
  const s = constructState(T, [{ coin: 3500000n }]);
  const it = replayIntent('y3', 10, { type: 'T1', requested: [payTo(T, 0, 3n * ADA)] });
  const a = await m.build(s, it, P, own);
  assert.equal(a.ok, true, a.detail);
  assert.equal(inspectTx(a.txs[0].bytes).fee, 500000n);
  assert.equal(checkAndApply(s, P, a.txs).ok, true);
  const b = await m.build(s, it, P, layout);
  assert.deepEqual([b.ok, b.class], [false, CLASSES.changeMinimum]);
  assert.match(b.detail, /under the pure-ADA minimum/);
});

test('a first build that fails on the change output fails L/own with class change-minimum although the wallet then lowers the amount; L/layout takes that transaction\'s inputs', { skip }, async () => {
  const m = makeMethod(T, 'yoroi-lf');
  const z = (i) => ({ policy: policy('z'), name: assetName(`z${i}`), qty: 1n });
  const s = constructState(T, [{ coin: 2n * ADA }, { coin: 3n * ADA, assets: [z(1), z(2), z(3)] }]);
  const it = replayIntent('y4', 10, { type: 'T1', requested: [payTo(T, 0, 3700000n)] });
  const a = await m.build(s, it, P, own);
  assert.deepEqual([a.ok, a.class], [false, CLASSES.changeMinimum]);
  assert.match(a.detail, /Not enough ADA to create change output with 3 tokens.*the wallet then lowered the first output's ADA/);
  // The lowered transaction holds both UTxOs; UnFrack.It's change on them
  // with the full 3.7 ADA falls short.
  const b = await m.build(s, it, P, layout);
  assert.deepEqual([b.ok, b.class], [false, CLASSES.changeMinimum]);
  assert.match(b.detail, /layout change on the wallet's inputs: the inputs fall \d+ lovelace short/);
});

test('the wallet drops a token whose asset name is empty: a requested output without it fails with class other, and an input holding it gives a transaction the kit fails', { skip }, async () => {
  const m = makeMethod(T, 'yoroi-lf');
  const e = { policy: policy('e'), name: '' };
  const s = constructState(T, [{ coin: 5n * ADA, assets: [{ ...e, qty: 10n }] }, { coin: 9n * ADA }]);
  const out = await m.build(s, replayIntent('y5', 10, { type: 'T2', requested: [tokenPay(0, 2n * ADA, [{ ...e, qty: 4n }])] }), P, own);
  assert.deepEqual([out.ok, out.class], [false, CLASSES.other]);
  assert.match(out.detail, /^requested output 0: the wallet wrote coin 2000000 and assets \[\]/);
  // builder.ts amountsToValue skips a token id with no name, so the input's
  // value as the wallet gives it to CSL lacks the token, which then leaves
  // the transaction.
  const it = replayIntent('y6', 10, { type: 'T1', requested: [payTo(T, 0, 12n * ADA)] });
  const a = await m.build(s, it, P, own);
  assert.equal(a.ok, true, a.detail);
  const applied = checkAndApply(s, P, a.txs);
  assert.deepEqual([applied.ok, applied.failure.cls, applied.failure.detail], [false, CLASSES.balance, 'assets are not conserved']);
  const b = await m.build(s, it, P, layout);
  assert.equal(b.ok, true, b.detail);
  assert.equal(checkAndApply(s, P, b.txs).ok, true);
});

// One intent replayed through the engine with the validity checks on.
async function replayOne(state, intent, changePolicy) {
  const source = { wallet: 'constructed', window: 'synthetic', network: 'synthetic', stakeCred: state.stakeCred, changeAddress: state.changeAddress, changeAddressEnd: state.changeAddress, franken: new Set(), start: [...state.utxos.values()], events: [{ kind: 'intent', txId: 1, intent }], windowStart: 0, windowEnd: 20, params: P };
  const r = await replay(T, P, source, { arm: 'observed', variant: 'default', repetition: 1, method: makeMethod(T, 'yoroi-lf'), opts: { seed: 1, changePolicy, collateralRule: 'ledger' }, settleEvery: 25, keepTx: true, validity: true });
  return { spend: r.spends[0], validity: r.summary.validity };
}

const CIP20 = encMap([[encUint(674), encMap([[encText('msg'), encArray([encText('a payment memo')])]])]]);

test('a TTL, metadata in the Shelley and Conway forms and a datum hash replay under both changes, and the wallet writes the TTL and each label as the intent holds them', { skip }, async () => {
  const s = constructState(T, [{ coin: 30n * ADA }, { coin: 7n * ADA }]);
  const ttl = 123456789n;
  const datumHash = blake2b256(Buffer.from('a datum')).toString('hex');
  const p = payTo(T, 1, 4n * ADA);
  const withDatum = { ...p, datum: { kind: 'hash', hash: datumHash }, cbor: hex(encodeOutput({ address: addressBytes(p.address), coin: 4n * ADA, assets: [], datum: { kind: 'hash', hash: datumHash } }, 'array')) };
  for (const aux of [CIP20, encTag(259, encMap([[encUint(0), CIP20]]))]) {
    const it = replayIntent('y7', 10, { type: 'T1', requested: [payTo(T, 0, 5n * ADA), withDatum], fixed: { body: { 3: hex(encUint(ttl)) }, auxiliaryData: hex(aux) } });
    for (const cp of ['default', 'layout']) {
      const { spend, validity } = await replayOne(s, it, cp);
      assert.equal(spend.outcome, 'built', `${cp}: ${spend.class} ${spend.detail}`);
      assert.equal(validity.failed, 0, JSON.stringify(validity.details));
      const t = decodeTx(Buffer.from(spend.built.txs[0].bytes, 'hex'));
      assert.equal(hex(t.body.fields.get(3).raw), hex(encUint(ttl)), cp);
      assert.deepEqual(metadataEntries(hex(t.aux.raw)).map(([l, b]) => [l, hex(b)]), metadataEntries(hex(CIP20)).map(([l, b]) => [l, hex(b)]), cp);
      assert.equal(inspectTx(spend.built.txs[0].bytes).outputs[1].datum.hash, datumHash, cp);
    }
  }
});

test('observed vkey witnesses are written after the build and named as unpriced', { skip }, async () => {
  const m = makeMethod(T, 'yoroi-lf');
  const s = constructState(T, [{ coin: 20n * ADA }]);
  const other = syntheticVkeys(T, 3)[2];
  const it = replayIntent('y8', 10, { type: 'T1', requested: [payTo(T, 0, 3n * ADA)], fixed: { witnesses: { 0: hex(Buffer.concat([Buffer.from([0x81]), other])) } } });
  const r = await m.build(s, it, P, own);
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(r.library.unpriced, ['observed vkey witnesses']);
  assert.equal(inspectTx(r.txs[0].bytes).vkeys.length, 2);
});

test('each part the send flow cannot express is not replayable under both changes', { skip }, async () => {
  const m = makeMethod(T, 'yoroi-lf');
  const s = constructState(T, [{ coin: 30n * ADA }]);
  const pay = payTo(T, 0, 3n * ADA);
  const ref = `${'ab'.repeat(32)}#0`;
  const other = { ref, cbor: '' };
  const cases = [
    ['fixed inputs', { fixed: { inputs: [other] } }, /fixed inputs/],
    ['reference inputs', { fixed: { referenceInputs: [other] } }, /reference inputs/],
    ['certificates', { fixed: { body: { 4: hex(encArray([])) } } }, /body field 4/],
    ['withdrawals', { fixed: { body: { 5: hex(encMap([])) } } }, /body field 5/],
    ['field 6', { fixed: { body: { 6: hex(encArray([])) } } }, /field 6/],
    ['a validity start', { fixed: { body: { 8: hex(encUint(5)) } } }, /body field 8/],
    ['the mint', { fixed: { body: { 9: hex(encMap([])) } } }, /body field 9/],
    ['required signers', { fixed: { body: { 14: hex(encArray([])) } } }, /body field 14/],
    ['votes', { fixed: { body: { 19: hex(encMap([])) } } }, /body field 19/],
    ['a donation', { fixed: { body: { 22: hex(encUint(1)) } } }, /body field 22/],
    ['native scripts', { fixed: { witnesses: { 1: hex(encArray([])) } } }, /witness-set key 1/],
    ['bootstrap witnesses', { fixed: { witnesses: { 2: hex(encArray([])) } } }, /witness-set key 2/],
    ['datums', { fixed: { witnesses: { 4: hex(encArray([])) } } }, /witness-set key 4/],
    ['a TTL under the buffer', { fixed: { body: { 3: hex(encUint(TTL_BUFFER - 1)) } } }, /under the wallet's buffer/],
    ['a script in the auxiliary data', { fixed: { auxiliaryData: hex(encArray([CIP20, encArray([encArray([encUint(1), encBytes(Buffer.alloc(28))])])])) } }, /holding a script/],
    ['a text the JSON form reads as bytes', { fixed: { auxiliaryData: hex(encMap([[encUint(1), encText('0xab')]])) } }, /auxiliary data: the metadata the wallet encodes/],
    ['an integer beyond 2^53', { fixed: { auxiliaryData: hex(encMap([[encUint(1), encUint(2n ** 60n + 1n)]])) } }, /auxiliary data: the metadata the wallet encodes/],
    ['collateral', { collateral: true }, /collateral/],
    ['an inline datum', { requested: [{ ...pay, datum: { kind: 'inline', cbor: '00' } }] }, /inline datum/],
    ['a reference script', { requested: [{ ...pay, scriptRef: '8200' }] }, /reference script/]
  ];
  for (const [label, over, re] of cases) {
    const it = replayIntent('y9', 10, { type: 'T1', requested: [pay], ...over });
    for (const opts of [own, layout]) {
      const r = await m.build(s, it, P, opts);
      assert.deepEqual([r.ok, r.class], [false, NOT_REPLAYABLE], `${label} ${opts.changePolicy}: ${r.detail}`);
      assert.match(r.detail, re, label);
    }
  }
});

test('the synthetic streams of S1 and M1 replay under both changes with no validity failure and no class other', { skip, timeout: 4 * 60 * 1000 }, async () => {
  for (const name of ['S1', 'M1']) {
    const source = loadSource(T, { kind: 'shape', name, stream: 'synthetic' });
    for (const changePolicy of ['default', 'layout']) {
      const r = await replay(T, source.params, source, { arm: 'observed', variant: 'default', repetition: 1, method: makeMethod(T, 'yoroi-lf'), opts: { seed: 1, changePolicy, collateralRule: 'ledger' }, settleEvery: 25, validity: true });
      assert.equal(r.summary.validity.failed, 0, `${name} ${changePolicy}`);
      assert.ok(r.spends.some((x) => x.outcome === 'built'), `${name} ${changePolicy}`);
      assert.ok(!r.spends.some((x) => x.class === CLASSES.other), `${name} ${changePolicy}: ${JSON.stringify(r.spends.filter((x) => x.class === CLASSES.other).map((x) => x.detail))}`);
    }
  }
});
