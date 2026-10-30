// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Transactions as they sit on chain: the parts, their original bytes, the
// hash and the size the ledger charges for.
//
// The Conway CDDL (IntersectMBO/cardano-ledger at
// 391db20866113f08bc6317cb5c341304365986c6, eras/conway/impl/cddl/data/
// conway.cddl) gives
//   transaction = [transaction_body, transaction_witness_set, bool, auxiliary_data / nil]   (lines 16-17)
// with the body a map of fields 0 to 22 (lines 107-128) and the witness set a
// map of keys 0 to 7 (lines 760-771). Transactions of the Shelley, Allegra and
// Mary eras have no validity flag: [body, witness_set, auxiliary_data / nil].
//
// The size: the ledger charges for the length of [body, witnesses, auxiliary
// data / null] as a three-element list in every era from Alonzo on, the
// validity flag left out "so that the size of transactions from Mary is
// unchanged" (eras/alonzo/impl/src/Cardano/Ledger/Alonzo/Tx.hs:377-385 and
// :482-496, sizeAlonzoTxF and toCBORForSizeComputation; Conway uses it too,
// eras/conway/impl/src/Cardano/Ledger/Conway/Tx.hs:88). In the eras before
// Alonzo that list is the transaction itself. The transaction id is the
// BLAKE2b-256 of the body's bytes.

import { decode, decodeAt, raw, setItems, asUint, asInt, asBytes, CborError, TRUE, FALSE, NULL } from './cbor.mjs';
import { blake2b256, blake2b224 } from './blake2b.mjs';
import { decodeMultiAsset } from './value.mjs';

export const BODY_FIELDS = {
  0: 'inputs',
  1: 'outputs',
  2: 'fee',
  3: 'ttl',
  4: 'certificates',
  5: 'withdrawals',
  6: 'update',
  7: 'auxiliary data hash',
  8: 'validity interval start',
  9: 'mint',
  11: 'script data hash',
  13: 'collateral inputs',
  14: 'required signers',
  15: 'network id',
  16: 'collateral return',
  17: 'total collateral',
  18: 'reference inputs',
  19: 'voting procedures',
  20: 'proposal procedures',
  21: 'current treasury value',
  22: 'donation'
};

export const WITNESS_KEYS = {
  0: 'vkey witnesses',
  1: 'native scripts',
  2: 'bootstrap witnesses',
  3: 'plutus v1 scripts',
  4: 'plutus data',
  5: 'redeemers',
  6: 'plutus v2 scripts',
  7: 'plutus v3 scripts'
};

function fieldMap(buf, node, what, known) {
  if (node.mt !== 5) throw new CborError(`${what}: expected a map at byte ${node.s}`);
  const fields = new Map();
  const order = [];
  for (const [k, v] of node.entries) {
    const key = Number(asUint(k, `${what} key`));
    if (fields.has(key)) throw new CborError(`${what}: key ${key} twice`);
    if (!(key in known)) throw new CborError(`${what}: unknown key ${key}`);
    fields.set(key, { key, keyNode: k, node: v, raw: raw(buf, v) });
    order.push(key);
  }
  return { fields, order };
}

export function decodeTx(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const top = decode(buf);
  if (top.mt !== 4 || top.indefinite || (top.items.length !== 3 && top.items.length !== 4)) {
    throw new CborError('transaction: expected a definite array of three or four items');
  }
  const [bodyNode, witsNode] = top.items;
  const alonzo = top.items.length === 4;
  let isValid = true;
  let auxNode;
  if (alonzo) {
    const f = top.items[2];
    if (f.mt !== 7 || (f.simple !== 20 && f.simple !== 21)) throw new CborError('transaction: expected the validity flag');
    isValid = f.simple === 21;
    auxNode = top.items[3];
  } else {
    auxNode = top.items[2];
  }
  const aux = auxNode.mt === 7 && auxNode.simple === 22 ? null : auxNode;
  const body = { node: bodyNode, raw: raw(buf, bodyNode), ...fieldMap(buf, bodyNode, 'body', BODY_FIELDS) };
  const wits = { node: witsNode, raw: raw(buf, witsNode), ...fieldMap(buf, witsNode, 'witness set', WITNESS_KEYS) };
  const auxRaw = aux ? raw(buf, aux) : null;
  return {
    buf,
    alonzo,
    isValid,
    body,
    wits,
    aux: aux ? { node: aux, raw: auxRaw } : null,
    hash: blake2b256(body.raw).toString('hex'),
    size: 1 + body.raw.length + wits.raw.length + (auxRaw ? auxRaw.length : 1)
  };
}

// The transaction from the parts a block stores separately (the Conway CDDL's
// block, lines 8-14: bodies, witness sets, auxiliary data by index, invalid
// indexes). `alonzo` adds the validity flag.
export function assembleTx({ body, wits, aux, isValid, alonzo }) {
  const parts = [Buffer.from([alonzo ? 0x84 : 0x83]), body, wits];
  if (alonzo) parts.push(isValid ? TRUE : FALSE);
  parts.push(aux || NULL);
  return Buffer.concat(parts);
}

export const refOf = (txid, index) => `${txid}#${index}`;

function inputList(buf, node) {
  return setItems(node).map((x) => {
    if (x.mt !== 4 || x.items.length !== 2) throw new CborError(`input: expected [id, index] at byte ${x.s}`);
    const id = asBytes(x.items[0], 'transaction id');
    if (id.length !== 32) throw new CborError('transaction id of the wrong length');
    const txid = id.toString('hex');
    const index = Number(asUint(x.items[1], 'output index'));
    return { txid, index, ref: refOf(txid, index), raw: raw(buf, x) };
  });
}

export const inputs = (tx) => (tx.body.fields.has(0) ? inputList(tx.buf, tx.body.fields.get(0).node) : []);
export const collateralInputs = (tx) => (tx.body.fields.has(13) ? inputList(tx.buf, tx.body.fields.get(13).node) : []);
export const referenceInputs = (tx) => (tx.body.fields.has(18) ? inputList(tx.buf, tx.body.fields.get(18).node) : []);

export function outputs(tx) {
  if (!tx.body.fields.has(1)) return [];
  const n = tx.body.fields.get(1).node;
  if (n.mt !== 4) throw new CborError('outputs: expected an array');
  return n.items.map((o, index) => ({ index, node: o, raw: raw(tx.buf, o) }));
}

export const fee = (tx) => asUint(tx.body.fields.get(2).node, 'fee');
export const totalCollateral = (tx) => (tx.body.fields.has(17) ? asUint(tx.body.fields.get(17).node, 'total collateral') : null);
export const donation = (tx) => (tx.body.fields.has(22) ? asUint(tx.body.fields.get(22).node, 'donation') : 0n);

export function collateralReturn(tx) {
  if (!tx.body.fields.has(16)) return null;
  const f = tx.body.fields.get(16);
  return { node: f.node, raw: f.raw };
}

export function mint(tx) {
  if (!tx.body.fields.has(9)) return [];
  return decodeMultiAsset(tx.body.fields.get(9).node, true);
}

// Withdrawals: [{ account (hex reward address), coin, raw }] in wire order.
export function withdrawals(tx) {
  if (!tx.body.fields.has(5)) return [];
  const n = tx.body.fields.get(5).node;
  if (n.mt !== 5) throw new CborError('withdrawals: expected a map');
  return n.entries.map(([k, v]) => ({ account: asBytes(k, 'reward account').toString('hex'), coin: asUint(v, 'withdrawal'), raw: raw(tx.buf, k) }));
}

// The ledger's order of reward accounts (two reward addresses' bytes): by
// network, then credential, a script credential before a key
// (libs/cardano-ledger-core/src/Cardano/Ledger/Credential.hs:98-101), then
// the hash. The order of a transaction's withdrawals, which their redeemer
// pointers index (history/intent.mjs redeemerTargets), and the order the CSL
// adapter adds them in (methods/csl.mjs), so that CSL's redeemer indexes are
// the ledger's.
export function compareRewardAccounts(a, b) {
  const na = a[0] & 15;
  const nb = b[0] & 15;
  if (na !== nb) return na - nb;
  const sa = a[0] >> 4 === 15 ? 0 : 1;
  const sb = b[0] >> 4 === 15 ? 0 : 1;
  if (sa !== sb) return sa - sb;
  return Buffer.compare(a.subarray(1), b.subarray(1));
}

// Certificates in order, each { type, items, raw }.
export function certificates(tx) {
  if (!tx.body.fields.has(4)) return [];
  return setItems(tx.body.fields.get(4).node).map((c) => {
    if (c.mt !== 4 || !c.items.length) throw new CborError(`certificate: expected an array at byte ${c.s}`);
    return { type: Number(asUint(c.items[0], 'certificate type')), items: c.items, raw: raw(tx.buf, c) };
  });
}

export function proposals(tx) {
  if (!tx.body.fields.has(20)) return [];
  return setItems(tx.body.fields.get(20).node).map((p) => {
    if (p.mt !== 4 || p.items.length !== 4) throw new CborError('proposal procedure: expected four items');
    return { deposit: asUint(p.items[0], 'proposal deposit'), raw: raw(tx.buf, p) };
  });
}

// Voters of the voting procedures, in wire order: [{ kind, hash, raw }], kind
// being the CDDL's voter tag (0 committee hot key, 1 committee hot script,
// 2 DRep key, 3 DRep script, 4 stake pool).
export function voters(tx) {
  if (!tx.body.fields.has(19)) return [];
  const n = tx.body.fields.get(19).node;
  if (n.mt !== 5) throw new CborError('voting procedures: expected a map');
  return n.entries.map(([k]) => {
    if (k.mt !== 4 || k.items.length !== 2) throw new CborError('voter: expected a pair');
    return { kind: Number(asUint(k.items[0], 'voter kind')), hash: asBytes(k.items[1], 'voter hash').toString('hex'), raw: raw(tx.buf, k) };
  });
}

// VKey witnesses: [{ vkey, keyHash, raw }] in wire order.
export function vkeyWitnesses(tx) {
  if (!tx.wits.fields.has(0)) return [];
  return setItems(tx.wits.fields.get(0).node).map((w) => {
    if (w.mt !== 4 || w.items.length !== 2) throw new CborError('vkey witness: expected [vkey, signature]');
    const vkey = asBytes(w.items[0], 'vkey');
    return { vkey: vkey.toString('hex'), keyHash: blake2b224(vkey).toString('hex'), raw: raw(tx.buf, w) };
  });
}

// Redeemers in either form the Conway CDDL allows (lines 785-805): an array
// of [tag, index, data, ex_units] or a map of [tag, index] to [data,
// ex_units]. Each: { tag, index, data (hex), exUnits: [mem, steps] }.
export function redeemers(tx) {
  if (!tx.wits.fields.has(5)) return [];
  const n = tx.wits.fields.get(5).node;
  const exu = (x) => {
    if (x.mt !== 4 || x.items.length !== 2) throw new CborError('ex_units: expected [mem, steps]');
    return [asUint(x.items[0], 'mem'), asUint(x.items[1], 'steps')];
  };
  if (n.mt === 4) {
    return n.items.map((r) => {
      if (r.mt !== 4 || r.items.length !== 4) throw new CborError('redeemer: expected four items');
      return { tag: Number(asUint(r.items[0], 'tag')), index: Number(asUint(r.items[1], 'index')), data: raw(tx.buf, r.items[2]).toString('hex'), exUnits: exu(r.items[3]) };
    });
  }
  if (n.mt === 5) {
    return n.entries.map(([k, v]) => {
      if (k.mt !== 4 || k.items.length !== 2 || v.mt !== 4 || v.items.length !== 2) throw new CborError('redeemer map entry: bad shape');
      return { tag: Number(asUint(k.items[0], 'tag')), index: Number(asUint(k.items[1], 'index')), data: raw(tx.buf, v.items[0]).toString('hex'), exUnits: exu(v.items[1]) };
    });
  }
  throw new CborError('redeemers: expected an array or a map');
}

// The item a redeemer pointer ({ tag, index }) of the transaction points at,
// in the ledger's order of each list: inputs as a Set of TxIn (by transaction
// id bytes, then index), policies as Map keys (by bytes), reward accounts by
// network, then credential, then hash (compareRewardAccounts); voters by
// constructor (committee, DRep, pool, eras/conway/impl/src/Cardano/Ledger/
// Conway/Governance/Procedures.hs:351-355) and credential; certificates and
// proposals in their listed order. Each target is { kind: 'input', ref },
// { kind: 'policy', policy }, { kind: 'certificate', index },
// { kind: 'withdrawal', account }, { kind: 'voter', voter (its bytes, hex) }
// or { kind: 'proposal', index }; null for a pointer past its list or an
// unknown tag. The history reader records an intent's redeemers by these
// targets (history/intent.mjs), and the kit reads a built transaction's
// redeemers by them (kit/replay.mjs missingRedeemers).
export function redeemerTargets(tx) {
  const ins = inputs(tx).sort((a, b) => (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.index - b.index));
  const policies = [...new Set(mint(tx).map((a) => a.policy))].sort();
  const wds = withdrawals(tx).sort((a, b) => compareRewardAccounts(Buffer.from(a.account, 'hex'), Buffer.from(b.account, 'hex')));
  const RANK = { 1: 0, 0: 1, 3: 2, 2: 3, 4: 4 };
  const vs = voters(tx).sort((a, b) => RANK[a.kind] - RANK[b.kind] || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  const nCerts = certificates(tx).length;
  const nProps = proposals(tx).length;
  return (r) => {
    switch (r.tag) {
      case 0:
        return ins[r.index] ? { kind: 'input', ref: ins[r.index].ref } : null;
      case 1:
        return policies[r.index] ? { kind: 'policy', policy: policies[r.index] } : null;
      case 2:
        return r.index < nCerts ? { kind: 'certificate', index: r.index } : null;
      case 3:
        return wds[r.index] ? { kind: 'withdrawal', account: wds[r.index].account } : null;
      case 4:
        return vs[r.index] ? { kind: 'voter', voter: Buffer.from(vs[r.index].raw).toString('hex') } : null;
      case 5:
        return r.index < nProps ? { kind: 'proposal', index: r.index } : null;
      default:
        return null;
    }
  };
}

export const hasField = (tx, k) => tx.body.fields.has(k);
export const intOf = asInt;
export { decodeAt };
