// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A replayed intent's transaction assembled by the ledger kit: the method's
// wallet inputs and change, the intent's requested outputs and fixed parts,
// and the arm's collateral. Every fixed part keeps its original bytes; only
// what the arm decides is new. The layout is the Conway CDDL's
// (IntersectMBO/cardano-ledger at 391db20866113f08bc6317cb5c341304365986c6,
// eras/conway/impl/cddl/data/conway.cddl: transaction 16-17, body 107-128,
// witness set 760-771, redeemers 785-805).
//
// The intent is the one every method receives (withoutLeftovers below): the
// network id and an auxiliary data holding no metadata and no script are left
// out of it.
//
// The module also holds the replay helpers every adapter shares: an intent's
// list items (listItems), its required signers (requiredSigners), the wallet
// keys a replayed transaction is witnessed for (replayWitnessKeys), the
// scripts it holds (intentScripts) and a redeemer's target as a key
// (redeemerKey, targetKey); and the comparison the engine makes of every
// built transaction's redeemers with the intent's (missingRedeemers).
//
// Body:
//   0   inputs: the wallet inputs and the intent's fixed inputs, sorted by
//       transaction id then index, as a tagged set (tag 258), as CSL 13.2.1
//       encodes it
//   1   outputs: the requested outputs as their own bytes (raised where the
//       history reader raised them), then the change, each change output in
//       the array form CSL writes for an output with no datum
//   2   fee
//   3, 4, 5, 8, 9, 14, 15, 19, 20, 21, 22   the intent's fixed fields as
//       their original bytes (validity, certificates, withdrawals, mint,
//       required signers, network id, votes, proposals, treasury, donation);
//       a replayed intent carries no network id
//   7   the auxiliary-data hash, BLAKE2b-256 of the fixed auxiliary data
//   11  the script-data hash, when the witness set carries redeemers or
//       datums: 32 bytes, as the ledger's is. The ledger hashes the
//       redeemers, the datums and the language views of the cost models
//       (eras/alonzo/impl/src/Cardano/Ledger/Alonzo/Tx.hs, hashScriptIntegrity);
//       a history file carries no cost models, so this is BLAKE2b-256 over the
//       redeemers and datums alone. Its size is exact, and no check reads it.
//   13, 16, 17  the arm's collateral input, its return output and the total
//       collateral
//   18  reference inputs, the intent's, sorted, as a tagged set
// Body field 6 (protocol parameter updates) cannot appear in a Conway
// transaction, so an intent carrying it is not replayable.
//
// Witness set:
//   0   synthetic vkey witnesses, one per distinct payment key among the wallet
//       inputs, the wallet's held fixed inputs and the collateral input, and
//       one per required signer (body field 14) that is one of the wallet's
//       payment keys (replayWitnessKeys)
//       (state/utxo.mjs: real public keys from fixed seeds and fixed
//       signatures, 101 bytes each as real ones, the treatment's
//       build.mjs makeWitnessSet), then the intent's other vkey witnesses as
//       observed, as a tagged set
//   1, 2, 3, 4, 6, 7   the intent's fixed witnesses as their original bytes
//   5   the redeemers as observed, each spend redeemer's index recomputed from
//       its target input's place among the sorted inputs (the other targets do
//       not move, since their lists are fixed parts)
// The transaction is [body, witness set, true, auxiliary data or null].

import { blake2b256, blake2b224 } from '../history/blake2b.mjs';
import { decode, raw, head, encUint, encBytes, encArray, encTag, asBytes, TRUE, NULL } from '../history/cbor.mjs';
import { encodeOutput } from '../history/output.mjs';
import { addressBytes } from '../history/address.mjs';
import { redeemerTargets, redeemers as txRedeemers, certificates as txCertificates } from '../history/tx.mjs';
import { unspentOutputParts, inspectTx } from './inspect.mjs';
import { minFee } from './fee.mjs';
import { leastSelfCoveringFee } from './assemble.mjs';
import { outputMinimum, CLASSES } from './check.mjs';
import { totalCollateralFor } from '../replay/collateral.mjs';
import { cmpRef } from '../state/state.mjs';
import { NOT_REPLAYABLE } from '../methods/contract.mjs';

export class NotReplayable extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotReplayable';
    this.class = NOT_REPLAYABLE;
  }
}

const FIXED_BODY = [3, 4, 5, 8, 9, 14, 15, 19, 20, 21, 22];
const FIXED_WITNESS = [1, 2, 3, 4, 6, 7];
const SET = (items) => encTag(258, encArray(items));

const inputBytes = (ref) => {
  const i = ref.indexOf('#');
  return encArray([encBytes(Buffer.from(ref.slice(0, i), 'hex')), encUint(Number(ref.slice(i + 1)))]);
};

// One change output's bytes: { address (bech32), coin, assets }.
export const changeOutputBytes = ({ address, coin, assets }) => encodeOutput({ address: addressBytes(address), coin, assets }, 'array');

// The synthetic vkey witnesses for k keys, as CSL encodes the treatment's.
const VKEYS = new Map();
export function syntheticVkeys(T, k) {
  if (VKEYS.has(k)) return VKEYS.get(k);
  const ws = T.build.makeWitnessSet(k);
  const b = Buffer.from(ws.to_bytes());
  ws.free();
  const n = decode(b);
  let items = [];
  if (k > 0) {
    const [, v] = n.entries.find(([key]) => Number(key.value) === 0);
    const arr = v.mt === 6 ? v.item : v;
    items = arr.items.map((x) => Buffer.from(raw(b, x)));
  }
  VKEYS.set(k, items);
  return items;
}

// The items of a list or a tag-258 set (hex or a Buffer), each as its bytes.
export function listItems(hexOrBuf) {
  const b = Buffer.isBuffer(hexOrBuf) ? hexOrBuf : Buffer.from(hexOrBuf, 'hex');
  const n = decode(b);
  const arr = n.mt === 6 ? n.item : n;
  if (arr.mt !== 4) throw new Error('expected a list');
  return arr.items.map((x) => Buffer.from(raw(b, x)));
}

// The redeemers' bytes with each spend redeemer's index recomputed.
function redeemerBytes(fixed, sortedInputs) {
  const original = Buffer.from(fixed.witnesses[5], 'hex');
  const n = decode(original);
  const place = new Map(sortedInputs.map((r, i) => [r, i]));
  const newIndex = (i, oldIndex) => {
    const r = fixed.redeemers[i];
    if (r.tag !== 0) return oldIndex;
    const p = place.get(r.target.ref);
    if (p === undefined) throw new Error(`a spend redeemer's target ${r.target.ref} is not an input`);
    return p;
  };
  if (n.mt === 4) {
    if (n.items.length !== fixed.redeemers.length) throw new Error('the redeemers differ from their parsed list');
    const items = n.items.map((it, i) => {
      const [tag, idx, data, exu] = it.items;
      return encArray([raw(original, tag), encUint(newIndex(i, Number(idx.value))), raw(original, data), raw(original, exu)]);
    });
    const close = n.indefinite ? Buffer.from([0xff]) : Buffer.alloc(0);
    return Buffer.concat([original.subarray(n.s, n.items.length ? n.items[0].s : n.e - close.length), ...items, close]);
  }
  if (n.mt === 5) {
    if (n.entries.length !== fixed.redeemers.length) throw new Error('the redeemers differ from their parsed list');
    const pairs = n.entries.map(([k, v], i) => [encArray([raw(original, k.items[0]), encUint(newIndex(i, Number(k.items[1].value)))]), raw(original, v)]);
    const close = n.indefinite ? Buffer.from([0xff]) : Buffer.alloc(0);
    const first = n.entries.length ? n.entries[0][0].s : n.e - close.length;
    return Buffer.concat([original.subarray(n.s, first), ...pairs.flat(), close]);
  }
  throw new Error('redeemers: expected an array or a map');
}

// The fixed inputs' resolved values: { coin, assets, cred, walletKey, held }.
export function fixedInputValues(intent) {
  if (!intent.fixed) return [];
  return intent.fixed.inputs.map((x) => {
    const p = unspentOutputParts(x.cbor);
    return { ref: x.ref, coin: p.coin, assets: p.assets, addr: p.addr, walletKey: x.walletKey || null, held: x.held || null };
  });
}

// The key hashes body field 14 lists (required signers), as hex.
export function requiredSigners(fixed) {
  if (!fixed || fixed.body[14] === undefined) return [];
  return listItems(fixed.body[14]).map((b) => {
    const n = decode(b);
    return Buffer.from(raw(b, n)).subarray(b.length - 28).toString('hex');
  });
}

// The wallet's payment keys a replayed transaction carries a synthetic vkey
// witness for, the count every replay assembles with: the credentials of the
// wallet inputs, the wallet keys of the held fixed inputs, the credentials of
// the collateral inputs, and the required signers (body field 14) that are
// among the wallet's payment credentials. The caller names the collateral
// inputs (the UTxO the engine set aside, or the collateral a library chose
// itself) and the wallet's credentials (none: no required signer counts).
// A Set of key hashes (hex).
export function replayWitnessKeys(fixed, { inputs, collateral = [], walletCreds = null }) {
  const keys = new Set(inputs.map((u) => u.cred));
  if (fixed) for (const x of fixed.inputs) if (x.walletKey) keys.add(x.walletKey);
  for (const u of collateral) keys.add(u.cred);
  if (walletCreds) for (const h of requiredSigners(fixed)) if (walletCreds.has(h)) keys.add(h);
  return keys;
}

const hexOf = (b) => Buffer.from(b).toString('hex');
const PLUTUS_KEYS = [[3, 1], [6, 2], [7, 3]];

// The scripts an intent's fixed parts hold, by hash (BLAKE2b-224 of the
// language tag and the script: 0 native, 1 to 3 Plutus V1 to V3): the witness
// set's, then the reference scripts of its fixed and reference inputs. Each:
// { lang, raw (a native script's bytes, a witness-set Plutus script's item
// bytes, or null), ref (null, or { ref, size } for a reference script),
// witness, used }; `used` is the caller's to set.
export function intentScripts(fixed) {
  const m = new Map();
  const put = (hash, e) => {
    if (!m.has(hash)) m.set(hash, e);
  };
  if (fixed.witnesses[1] !== undefined) {
    for (const r of listItems(fixed.witnesses[1])) put(hexOf(blake2b224(Buffer.concat([Buffer.from([0]), r]))), { lang: 0, raw: r, ref: null, witness: true, used: false });
  }
  for (const [key, lang] of PLUTUS_KEYS) {
    if (fixed.witnesses[key] === undefined) continue;
    for (const r of listItems(fixed.witnesses[key])) {
      const content = asBytes(decode(r), 'plutus script');
      put(hexOf(blake2b224(Buffer.concat([Buffer.from([lang]), content]))), { lang, raw: r, ref: null, witness: true, used: false });
    }
  }
  for (const x of [...fixed.inputs, ...fixed.referenceInputs]) {
    const p = unspentOutputParts(x.cbor);
    if (!p.scriptRef) continue;
    const s = Buffer.from(p.scriptRef.script, 'hex');
    put(hexOf(blake2b224(Buffer.concat([Buffer.from([p.scriptRef.lang]), s]))), { lang: p.scriptRef.lang, raw: p.scriptRef.lang === 0 ? s : null, ref: { ref: x.ref, size: p.scriptRef.size }, witness: false, used: false });
  }
  return m;
}

// A redeemer's target as a key, the one definition of which part a redeemer
// serves: the tag's number and the target as the history reader records it
// (history/intent.mjs redeemerTargets): an input's txid#index, a policy, a
// certificate's or proposal's place in its list, a reward account (hex), a
// voter (its observed bytes, hex).
export function targetKey(t) {
  switch (t.kind) {
    case 'input':
      return `0:${t.ref}`;
    case 'policy':
      return `1:${t.policy}`;
    case 'certificate':
      return `2:${t.index}`;
    case 'withdrawal':
      return `3:${t.account}`;
    case 'voter':
      return `4:${t.voter}`;
    case 'proposal':
      return `5:${t.index}`;
    default:
      throw new Error(`unknown redeemer target ${t.kind}`);
  }
}
export const redeemerKey = (r) => targetKey(r.target);

// What a redeemer redeems, as a key two transactions' redeemers are compared
// by: its target's key (targetKey), except that a certificate is named by its
// kind and the credential it carries, and a voter by its kind and hash, so
// that neither depends on its place or its encoding. certAt(i) names the
// transaction's certificate i.
const certificateIdentity = (buf, n) => {
  const c = n.items[1];
  const cred = c && c.mt === 4 && c.items.length === 2 && c.items[1].mt === 2 ? `${c.items[0].value}:${asBytes(c.items[1], 'credential').toString('hex')}` : c ? raw(buf, c).toString('hex') : '';
  return `${n.items[0].value}:${cred}`;
};
const voterIdentity = (h) => {
  const n = decode(Buffer.from(h, 'hex'));
  return `${n.items[0].value}:${asBytes(n.items[1], 'voter').toString('hex')}`;
};
function purposeKey(target, certAt) {
  if (target.kind === 'certificate') return `2:${certAt(target.index)}`;
  if (target.kind === 'voter') return `4:${voterIdentity(target.voter)}`;
  return targetKey(target);
}

// The number of the intent's redeemers that the built transaction (the
// history reader's decoding of it, kit/inspect.mjs inspectTx(...).tx) has no
// redeemer for: compared by tag and by the input, policy, reward account,
// certificate, voter or proposal each redeems (purposeKey), the transaction's
// pointers resolved as the reader resolves the observed transaction's
// (history/tx.mjs redeemerTargets). The ledger rejects a transaction that
// lacks a redeemer its Plutus scripts need: hasExactSetOfRedeemers fails with
// MissingRedeemers (eras/alonzo/impl/src/Cardano/Ledger/Alonzo/Rules/
// Utxow.hs:251-274), run by Babbage's UTXOW (eras/babbage/impl/src/Cardano/
// Ledger/Babbage/Rules/Utxow.hs:376), which Conway's runs (eras/conway/impl/
// src/Cardano/Ledger/Conway/Rules/Utxow.hs:209); the intent's redeemers are
// those its observed transaction needed, and a replay keeps every purpose
// they serve (its fixed inputs, mint, certificates, withdrawals, votes and
// proposals). The engine runs it on every method's built transaction
// (replay/engine.mjs buildOne).
export function missingRedeemers(intent, tx) {
  const f = intent.fixed;
  if (!f || !f.redeemers.length) return 0;
  const intentCerts = f.body[4] === undefined ? [] : listItems(f.body[4]).map((b) => certificateIdentity(b, decode(b)));
  const builtCerts = txCertificates(tx).map((c) => certificateIdentity(tx.buf, { items: c.items }));
  const targetOf = redeemerTargets(tx);
  const have = new Map();
  for (const r of txRedeemers(tx)) {
    const t = targetOf(r);
    if (!t) continue;
    const k = purposeKey(t, (i) => builtCerts[i]);
    have.set(k, (have.get(k) || 0) + 1);
  }
  let missing = 0;
  for (const r of f.redeemers) {
    const k = purposeKey(r.target, (i) => intentCerts[i]);
    const n = have.get(k) || 0;
    if (n > 0) have.set(k, n - 1);
    else missing++;
  }
  return missing;
}

// Builder leftovers: parts the observed transaction's builder wrote that the
// spend does not need and the ledger does not require. They are the network id
// (body field 15) and an auxiliary data holding no metadata entry and no
// script, in any of its three encodings (conway.cddl:802-833: a metadata map,
// the array [metadata, native scripts], or the tag-259 map of metadata and
// script lists), with its hash (body field 7). The replay engine leaves them
// out of every intent before any method, feasibility test or check sees it
// (replay/engine.mjs), so no method's transaction carries them unless its
// library writes them itself. The history file keeps them, and the reader's
// rebuild check (history/rebuild.mjs) rebuilds the observed transaction with
// them.

// Whether an auxiliary data (hex) holds no metadata entry and no script.
export function emptyAuxiliaryData(hexValue) {
  const n = decode(Buffer.from(hexValue, 'hex'));
  const emptyMap = (x) => x.mt === 5 && x.entries.length === 0;
  const emptyList = (x) => x.mt === 4 && x.items.length === 0;
  if (n.mt === 5) return n.entries.length === 0;
  if (n.mt === 4) return n.items.length === 2 && emptyMap(n.items[0]) && emptyList(n.items[1]);
  if (n.mt === 6 && n.tag === 259n && n.item.mt === 5) return n.item.entries.every(([k, v]) => (Number(k.value) === 0 ? emptyMap(v) : emptyList(v)));
  return false;
}

// The intent with its builder leftovers left out, the same object when it has
// none. The fixed bytes (the observed bytes of the fixed parts) lose theirs:
// field 15's key and value, field 7's key and 34-byte value, and the auxiliary
// data less the one byte of the null that replaces it. The body map's head
// does not change: a Conway body has at most 21 keys, so a definite head is
// one byte with or without them, and an indefinite one has no count.
const LEFTOVERS = new WeakMap();
export function withoutLeftovers(intent) {
  const f = intent.fixed;
  if (!f) return intent;
  if (LEFTOVERS.has(intent)) return LEFTOVERS.get(intent);
  const network = f.body[15] !== undefined;
  const aux = !!f.auxiliaryData && emptyAuxiliaryData(f.auxiliaryData);
  let out = intent;
  if (network || aux) {
    const body = { ...f.body };
    let gone = 0;
    if (network) {
      gone += 1 + f.body[15].length / 2;
      delete body[15];
    }
    if (aux) gone += 1 + 34 + f.auxiliaryData.length / 2 - 1;
    const fixed = Object.freeze({ ...f, body: Object.freeze(body), auxiliaryData: aux ? null : f.auxiliaryData, fixedBytes: f.fixedBytes - gone });
    out = Object.freeze({ ...intent, fixed });
  }
  LEFTOVERS.set(intent, out);
  return out;
}

// Why the kit cannot assemble an intent's transaction, or null when it can.
export function replayRefusal(intent) {
  const fixed = intent.fixed;
  if (fixed && fixed.body[6] !== undefined) return 'body field 6 (protocol parameter updates) cannot appear in a Conway transaction';
  return null;
}

// parts: { intent, inputs [UTxO records], change [{ address, coin, assets }],
// collateral null | { utxo, returnAddress, total }, fee, walletCreds (the
// wallet's payment credentials, for required signers) }.
export function assembleReplayOnce(T, parts) {
  const { intent, inputs, change, collateral, fee, walletCreds = null } = parts;
  const fixed = intent.fixed;
  const refusal = replayRefusal(intent);
  if (refusal) throw new NotReplayable(refusal);
  const allRefs = [...inputs.map((u) => u.ref), ...(fixed ? fixed.inputs.map((x) => x.ref) : [])];
  if (new Set(allRefs).size !== allRefs.length) throw new Error('replay: an input is given twice');
  const sorted = allRefs.slice().sort(cmpRef);
  const keys = replayWitnessKeys(fixed, { inputs, collateral: collateral ? [collateral.utxo] : [], walletCreds });

  const body = [];
  const put = (k, v) => body.push([k, v]);
  put(0, SET(sorted.map(inputBytes)));
  const outs = [...intent.requested.map((o) => Buffer.from(o.cbor, 'hex')), ...change.map(changeOutputBytes)];
  put(1, encArray(outs));
  put(2, encUint(fee));
  let ret = null;
  if (fixed) for (const k of FIXED_BODY) if (fixed.body[k] !== undefined) put(k, Buffer.from(fixed.body[k], 'hex'));
  const aux = fixed && fixed.auxiliaryData ? Buffer.from(fixed.auxiliaryData, 'hex') : null;
  if (aux) put(7, encBytes(blake2b256(aux)));
  const wits = [];
  let reds = null;
  if (fixed && fixed.witnesses[5] !== undefined) reds = redeemerBytes(fixed, sorted);
  const datums = fixed && fixed.witnesses[4] !== undefined ? Buffer.from(fixed.witnesses[4], 'hex') : null;
  if (reds || datums) put(11, encBytes(blake2b256(Buffer.concat([reds || Buffer.alloc(0), datums || Buffer.alloc(0)]))));
  if (collateral) {
    const u = collateral.utxo;
    put(13, SET([inputBytes(u.ref)]));
    const retCoin = u.coin - collateral.total;
    if (retCoin > 0n || u.assets.length) {
      ret = { address: collateral.returnAddress, coin: retCoin, assets: u.assets };
      put(16, changeOutputBytes(ret));
    }
    put(17, encUint(collateral.total));
  }
  if (fixed && fixed.referenceInputs.length) put(18, SET(fixed.referenceInputs.map((x) => x.ref).sort(cmpRef).map(inputBytes)));
  body.sort((a, b) => a[0] - b[0]);
  const bodyBytes = Buffer.concat([head(5, body.length), ...body.flatMap(([k, v]) => [encUint(k), v])]);

  const others = fixed && fixed.witnesses[0] !== undefined ? listItems(fixed.witnesses[0]) : [];
  const vk = [...syntheticVkeys(T, keys.size), ...others];
  if (vk.length) wits.push([0, SET(vk)]);
  if (fixed) for (const k of FIXED_WITNESS) if (fixed.witnesses[k] !== undefined) wits.push([k, Buffer.from(fixed.witnesses[k], 'hex')]);
  if (reds) wits.push([5, reds]);
  wits.sort((a, b) => a[0] - b[0]);
  const witBytes = Buffer.concat([head(5, wits.length), ...wits.flatMap(([k, v]) => [encUint(k), v])]);
  const bytes = Buffer.concat([Buffer.from([0x84]), bodyBytes, witBytes, TRUE, aux || NULL]).toString('hex');
  return { bytes, k: keys.size, collateralReturn: ret };
}

// The replayed transaction at its minimum fee. `changeFor(fee)` returns
// { ok, change } or a failure; `collateralFor(fee)` returns null (no script),
// { ok: true, collateral } or a failure. The fee rises until it covers the
// size it produces (the fee's and the change coin's encodings are part of the
// size), as kit/assemble.mjs does.
export function assembleReplayAtMinimumFee(T, params, { intent, inputs, changeFor, collateralFor = () => null, walletCreds = null }) {
  const scriptFee = intent.fixed ? intent.fixed.scriptFee || 0n : 0n;
  const at = (fee) => {
    const ch = changeFor(fee);
    if (!ch.ok) return ch;
    const co = collateralFor(fee);
    if (co && !co.ok) return co;
    const a = assembleReplayOnce(T, { intent, inputs, change: ch.change, collateral: co ? co.collateral : null, fee, walletCreds });
    const t = inspectTx(a.bytes);
    return { ok: true, bytes: a.bytes, fee, size: t.size, serializedSize: t.serializedSize, k: a.k, change: ch.change, collateral: co ? co.collateral : null, hash: t.hash, need: minFee(params, t.size, scriptFee) };
  };
  return leastSelfCoveringFee(at, minFee(params, 0, scriptFee));
}

// Whether UTxO `u` can carry `total` lovelace of collateral: its return
// output, at the return address, meets its minimum, or is exactly zero with
// no tokens (when exactZero).
export function carriesCollateral(params, u, returnAddress, total, { exactZero = true } = {}) {
  if (u.coin < total) return false;
  const retCoin = u.coin - total;
  if (retCoin === 0n && !u.assets.length) return exactZero;
  const b = changeOutputBytes({ address: returnAddress, coin: retCoin, assets: u.assets });
  return retCoin >= outputMinimum(params, b.length);
}

// The collateral for a fee from a list of eligible UTxOs, smallest first: the
// first that can carry it.
export function collateralFrom(params, eligible, returnAddress) {
  return (fee) => {
    const total = totalCollateralFor(params, fee);
    for (const u of eligible) if (carriesCollateral(params, u, returnAddress, total)) return { ok: true, collateral: { utxo: u, returnAddress, total } };
    return { ok: false, class: CLASSES.collateral, detail: `no eligible collateral UTxO covers ${total} lovelace of collateral with its return output` };
  };
}

// A replayed spend's collateral for a fee, as every method's skeletons and
// final transaction take it: null when the intent runs no script, otherwise
// the UTxO the engine set aside before selection (replay/engine.mjs,
// setAside), its return output at the return address. The engine chose it to
// carry the collateral of the largest fee a transaction within the size limit
// can have, so it fails only for a fee above that.
export function setAsideCollateralFor(params, intent, collateral, returnAddress) {
  if (!intent.collateral.required) return () => null;
  if (!collateral) throw new Error('a script spend needs the collateral the engine sets aside');
  return (fee) => {
    const total = totalCollateralFor(params, fee);
    if (carriesCollateral(params, collateral, returnAddress, total)) return { ok: true, collateral: { utxo: collateral, returnAddress, total } };
    return { ok: false, class: CLASSES.collateral, detail: `the collateral set aside does not cover ${total} lovelace of collateral with its return output` };
  };
}
