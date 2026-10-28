// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A synthetic intent stream per shape, for the replay engine's tests: the
// shapes have no history, so their events are fixed test values stated here,
// built over the shape's own holdings, every output a real serialized output.
// The stream runs 75 days from time 0, in this order (an intent the shape's
// holdings cannot express is left out):
//
//   day  1     T1   pay 20 ADA to an external key address
//   day  2     deposit: 50 ADA, 5 ADA, an NFT of a new policy at its minimum,
//              and a 3 ADA UTxO carrying an inline datum (held)
//   day  5     T2   send the shape's first NFT (policy, then name order)
//   day  8     T3   send two NFTs of the first policy holding two or more
//   day 10     T4   send one NFT of each of the last two policies (none sent
//              before)
//   day 12     T5   send half of the fungible held on the most UTxOs
//   day 20     a parallel burst of two T1 payments, 2 ADA and 3 ADA, 30 s apart
//   day 30     mark 1
//   day 35     T6   a Plutus spend: a script input of 10 ADA with a spend
//              redeemer, a Plutus V2 script and a datum in the witness set,
//              12 ADA paid back to the script address with an inline datum;
//              collateral required
//   day 40     T6   phase-2-invalid: its only effect is a forfeit of 0.5 ADA
//   day 45     T1   pay 15 ADA, with a validity interval, a CIP-20 message
//              (label 674) and the held datum UTxO as a fixed wallet input
//   day 47     held-consumed: the deposit's held datum UTxO, when the day 45
//              spend has not consumed it, is consumed by another transaction
//   day 50     self-reorganization (counted, not replayed)
//   day 55     T8   mint 1 unit of a token under a native script policy into
//              a wallet output at its minimum, with the policy's key witness
//   day 58     T7   a stake registration certificate with its 2 ADA deposit
//   day 60     mark 2
//   day 70     T1   pay 100 ADA
//
// Ids and synthetic hashes are BLAKE2b-256 or BLAKE2b-224 of fixed texts.

import { blake2b256, blake2b224 } from '../history/blake2b.mjs';
import { encUint, encBytes, encArray, encMap, encTag, encText } from '../history/cbor.mjs';
import { encodeOutput, unspentOutput } from '../history/output.mjs';
import { addressBytes } from '../history/address.mjs';
import { utxoFromOutput, addressTextOf } from '../state/utxo.mjs';
import { spendable, holdings } from '../state/state.mjs';
import { recipientAddress } from '../battery/recipients.mjs';
import { executionFee } from '../history/params.mjs';
import { assembleReplayOnce } from '../kit/replay.mjs';
import { inspectTx } from '../kit/inspect.mjs';
import { spreadFungible } from '../battery/battery.mjs';

const ADA = 1000000n;
const DAY = 86400;
const hash32 = (s) => blake2b256(Buffer.from(`unfrackit-research-sim stream ${s}`, 'ascii')).toString('hex');
const hash28 = (s) => blake2b224(Buffer.from(`unfrackit-research-sim stream ${s}`, 'ascii')).toString('hex');
const key = (a) => `${a.policy}.${a.name}`;
const cmpKey = (a, b) => (a.policy < b.policy ? -1 : a.policy > b.policy ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// The minimum coin of an output at its own width.
function atMinimum(params, build) {
  let coin = ADA;
  for (let i = 0; i < 8; i++) {
    const b = build(coin);
    const min = params.coinsPerUtxoByte * (160n + BigInt(b.length));
    if (min === coin) return { coin, bytes: b };
    coin = min;
  }
  throw new Error('the minimum coin did not settle');
}

function requestedOut(address, bytes, coin, assets, extra = {}) {
  return { cbor: bytes.toString('hex'), address, coin, assets, datum: extra.datum || null, scriptRef: null, raised: null, wallet: !!extra.wallet, scriptPayment: !!extra.scriptPayment, index: extra.index ?? null, from: null, inflow: !!extra.inflow };
}

function payOut(params, address, coin, assets) {
  const a = addressBytes(address);
  if (coin === null) {
    const m = atMinimum(params, (c) => encodeOutput({ address: a, coin: c, assets }, 'array'));
    return requestedOut(address, m.bytes, m.coin, assets);
  }
  return requestedOut(address, encodeOutput({ address: a, coin, assets }, 'array'), coin, assets);
}

const ZERO = () => ({ withdrawals: 0n, refunds: 0n, deposits: 0n, donation: 0n, mint: [], burn: [] });

// Fixed bytes: the kit's assembly with the fixed parts less the same without
// them, over one stand-in input and no change, as the history reader computes
// it from an observed transaction.
function fixedBytesOf(T, intent) {
  const stand = { ref: `${'00'.repeat(32)}#0`, cred: '00'.repeat(28) };
  const a = assembleReplayOnce(T, { intent, inputs: [stand], change: [], collateral: null, fee: 200000n });
  const b = assembleReplayOnce(T, { intent: { ...intent, fixed: null }, inputs: [stand], change: [], collateral: null, fee: 200000n });
  return inspectTx(a.bytes).size - inspectTx(b.bytes).size;
}

export function syntheticStream(T, shape, params, { kind = 'synthetic' } = {}) {
  if (kind !== 'synthetic') throw new Error(`unknown stream ${kind}`);
  const state = shape.state;
  const name = shape.name;
  const change = state.changeAddress;
  const changeBytes = addressBytes(change);
  const net = changeBytes[0] & 15;
  const ext = (i) => recipientAddress('synthetic', 200 + i);
  const events = [];
  let n = 0;
  const time = (t) => ({ slot: t, blockTime: t, blockIndex: 0, epoch: params.epoch, block: t });
  const intent = (t, type, requested, over = {}) => {
    const id = hash32(`${name} ${n++}`);
    events.push({
      kind: 'intent',
      txId: n,
      intent: {
        id,
        source: 'replay',
        type,
        time: time(t),
        requested,
        implicit: ZERO(),
        fixed: null,
        collateral: { required: false, observed: null },
        invalid: null,
        burst: null,
        observed: { tx: id, size: 0, fee: 300000n, epoch: params.epoch, protocolMajor: null, minFeeA: params.minFeeA, minFeeB: params.minFeeB, walletInputs: [], walletOutputs: [], walletWitnesses: [] },
        classes: {},
        derived: null,
        meta: null,
        ...over
      }
    });
  };
  const view = holdings(spendable(state));
  const assets = [...view.assets.values()].sort(cmpKey);
  const classes = T.planner.classifyAssets([...state.utxos.values()]);
  const nfts = assets.filter((h) => classes.get(key(h)).cls === 'nft');
  const fts = assets.filter((h) => classes.get(key(h)).cls === 'ft');
  const byPolicy = new Map();
  for (const h of nfts) {
    if (!byPolicy.has(h.policy)) byPolicy.set(h.policy, []);
    byPolicy.get(h.policy).push(h);
  }
  const policies = [...byPolicy.keys()].sort();
  const tok = (h, qty = 1n) => ({ policy: h.policy, name: h.name, qty });

  intent(1 * DAY, 'T1', [payOut(params, ext(0), 20n * ADA, [])]);

  // Deposits, at the change address.
  const depTx = hash32(`${name} deposit`);
  const newPolicy = hash28(`${name} deposit policy`);
  const heldDatum = encodeOutput({ address: changeBytes, coin: 3n * ADA, assets: [], datum: { kind: 'inline', cbor: 'd87980' } }, 'map');
  const nftOut = atMinimum(params, (c) => encodeOutput({ address: changeBytes, coin: c, assets: [{ policy: newPolicy, name: '4e4654', qty: 1n }] }, 'array'));
  const depOuts = [
    encodeOutput({ address: changeBytes, coin: 50n * ADA, assets: [] }, 'array'),
    encodeOutput({ address: changeBytes, coin: 5n * ADA, assets: [] }, 'array'),
    nftOut.bytes,
    heldDatum
  ];
  const depUtxos = depOuts.map((b, i) => utxoFromOutput(depTx, i, b, { origin: 'deposit' }));
  events.push({ kind: 'deposit', tx: depTx, txId: n++, time: time(2 * DAY), utxos: depUtxos });
  const heldRef = depUtxos[3].ref;

  if (nfts.length) intent(5 * DAY, 'T2', [payOut(params, ext(1), null, [tok(nfts[0])])]);
  // T3 takes the first two NFTs of the first policy holding two or more; T4
  // the last NFT of each of the last two policies that still hold one.
  const sent = new Set(nfts.length ? [key(nfts[0])] : []);
  const two = policies.find((p) => byPolicy.get(p).filter((h) => !sent.has(key(h))).length >= 2);
  if (two) {
    const ts = byPolicy.get(two).filter((h) => !sent.has(key(h))).slice(0, 2);
    for (const h of ts) sent.add(key(h));
    intent(8 * DAY, 'T3', [payOut(params, ext(2), null, ts.map((h) => tok(h)))]);
  }
  const left = policies.map((p) => byPolicy.get(p).filter((h) => !sent.has(key(h)))).filter((l) => l.length);
  if (left.length >= 2) intent(10 * DAY, 'T4', [payOut(params, ext(3), null, [tok(left.at(-2).at(-1)), tok(left.at(-1).at(-1))].sort(cmpKey))]);
  const f = spreadFungible(fts);
  if (f && f.qty >= 2n) intent(12 * DAY, 'T5', [payOut(params, ext(4), null, [tok(f, f.qty / 2n)])]);

  // A parallel burst of two payments.
  intent(20 * DAY, 'T1', [payOut(params, ext(5), 2n * ADA, [])], { burst: { id: 'b1', parallel: true, index: 0 } });
  intent(20 * DAY + 30, 'T1', [payOut(params, ext(6), 3n * ADA, [])], { burst: { id: 'b1', parallel: true, index: 1 } });

  events.push({ kind: 'mark', n: 1, blockTime: 30 * DAY });

  // A Plutus spend.
  const scriptHash = hash28(`${name} script`);
  const scriptAddr = Buffer.concat([Buffer.from([0x70 | net]), Buffer.from(scriptHash, 'hex')]);
  const scriptAddrText = addressTextOf(scriptAddr);
  const datumHash = blake2b256(Buffer.from('d87980', 'hex')).toString('hex');
  const scriptTx = hash32(`${name} script input`);
  const scriptIn = { ref: `${scriptTx}#0`, cbor: unspentOutput(scriptTx, 0, encodeOutput({ address: scriptAddr, coin: 10n * ADA, assets: [], datum: { kind: 'hash', hash: datumHash } }, 'array')).toString('hex') };
  const backOut = encodeOutput({ address: scriptAddr, coin: 12n * ADA, assets: [], datum: { kind: 'inline', cbor: 'd87980' } }, 'map');
  const exUnits = [200000n, 80000000n];
  const redeemers = [{ tag: 0, target: { kind: 'input', ref: scriptIn.ref }, data: 'd87980', exUnits }];
  const t6Fixed = {
    inputs: [scriptIn],
    referenceInputs: [],
    body: {},
    witnesses: {
      4: encArray([Buffer.from('d87980', 'hex')]).toString('hex'),
      5: encArray([encArray([encUint(0), encUint(0), Buffer.from('d87980', 'hex'), encArray([encUint(exUnits[0]), encUint(exUnits[1])])])]).toString('hex'),
      6: encArray([encBytes(Buffer.alloc(300, 0x4d))]).toString('hex')
    },
    redeemers,
    auxiliaryData: null,
    scriptFee: executionFee(params, exUnits[0], exUnits[1]),
    fixedBytes: 0,
    refScriptBytes: 0
  };
  const t6 = { requested: [requestedOut(scriptAddrText, backOut, 12n * ADA, [], { datum: { kind: 'inline', cbor: 'd87980' }, scriptPayment: true })], fixed: t6Fixed };
  t6Fixed.fixedBytes = fixedBytesOf(T, { ...t6, implicit: ZERO() });
  intent(35 * DAY, 'T6', t6.requested, { fixed: t6Fixed, collateral: { required: true, observed: null } });

  // A phase-2-invalid script spend.
  intent(40 * DAY, 'T6', [], { collateral: { required: true, observed: null }, invalid: { forfeit: ADA / 2n, heldConsumed: [] } });

  // A payment with a validity interval, a message and a held fixed input.
  const aux = encTag(259, encMap([[encUint(0), encMap([[encUint(674), encMap([[encText('msg'), encArray([encText('stream test')])]])]])]]));
  const heldCred = depUtxos[3].cred;
  const t1Fixed = {
    inputs: [{ ref: heldRef, cbor: depUtxos[3].cbor, held: 'datum', walletKey: heldCred }],
    referenceInputs: [],
    body: { 3: encUint(4000000).toString('hex'), 8: encUint(3000000).toString('hex') },
    witnesses: {},
    redeemers: [],
    auxiliaryData: aux.toString('hex'),
    scriptFee: 0n,
    fixedBytes: 0,
    refScriptBytes: 0
  };
  const t1 = { requested: [payOut(params, ext(7), 15n * ADA, [])], fixed: t1Fixed };
  t1Fixed.fixedBytes = fixedBytesOf(T, { ...t1, implicit: ZERO() });
  intent(45 * DAY, 'T1', t1.requested, { fixed: t1Fixed });
  events.push({ kind: 'held-consumed', tx: hash32(`${name} held`), txId: n++, time: time(47 * DAY), refs: [heldRef], whenPresent: true });

  events.push({ kind: 'self-reorganization', tx: hash32(`${name} reorg`), txId: n++, time: time(50 * DAY), burst: null, heldConsumed: [], valueChange: { coin: 0n, assets: [] } });

  // A mint under a native script policy (one key), into the wallet.
  const mintKey = Buffer.alloc(32, 0x6b);
  const nativeScript = encArray([encUint(0), encBytes(blake2b224(mintKey))]);
  const mintPolicy = blake2b224(Buffer.concat([Buffer.from([0]), nativeScript])).toString('hex');
  const minted = [{ policy: mintPolicy, name: '4d494e54', qty: 1n }];
  const mintOut = atMinimum(params, (c) => encodeOutput({ address: changeBytes, coin: c, assets: minted }, 'array'));
  const mintFixed = {
    inputs: [],
    referenceInputs: [],
    body: { 9: encMap([[encBytes(Buffer.from(mintPolicy, 'hex')), encMap([[encBytes(Buffer.from('4d494e54', 'hex')), encUint(1)]])]]).toString('hex') },
    witnesses: { 0: encArray([encArray([encBytes(mintKey), encBytes(Buffer.alloc(64, 0x6c))])]).toString('hex'), 1: encArray([nativeScript]).toString('hex') },
    redeemers: [],
    auxiliaryData: null,
    scriptFee: 0n,
    fixedBytes: 0,
    refScriptBytes: 0
  };
  const t8 = { requested: [requestedOut(change, mintOut.bytes, mintOut.coin, minted, { wallet: true, inflow: true })], fixed: mintFixed };
  mintFixed.fixedBytes = fixedBytesOf(T, { ...t8, implicit: { ...ZERO(), mint: minted } });
  intent(55 * DAY, 'T8', t8.requested, { fixed: mintFixed, implicit: { ...ZERO(), mint: minted } });

  // A stake registration.
  const stakeCred = state.stakeCred;
  const cert = encArray([encUint(0), encArray([encUint(0), encBytes(Buffer.from(stakeCred, 'hex'))])]);
  const certFixed = { inputs: [], referenceInputs: [], body: { 4: encArray([cert]).toString('hex') }, witnesses: {}, redeemers: [], auxiliaryData: null, scriptFee: 0n, fixedBytes: 0, refScriptBytes: 0 };
  certFixed.fixedBytes = fixedBytesOf(T, { requested: [], fixed: certFixed, implicit: ZERO() });
  intent(58 * DAY, 'T7', [], { fixed: certFixed, implicit: { ...ZERO(), deposits: params.keyDeposit } });

  events.push({ kind: 'mark', n: 2, blockTime: 60 * DAY });
  intent(70 * DAY, 'T1', [payOut(params, ext(8), 100n * ADA, [])]);

  // Arrival keys for H-2's groupings, as fixed test values: each token's key
  // is the position, in the shape's generated order, of the first UTxO that
  // holds it.
  const arrival = new Map();
  shape.order.forEach((ref, i) => {
    for (const a of state.utxos.get(ref).assets) if (!arrival.has(key(a))) arrival.set(key(a), { txId: i, flagged: false });
  });
  return { events, windowEnd: 75 * DAY, arrival };
}
