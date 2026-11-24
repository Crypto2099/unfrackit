// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Shared fixtures: a deterministic throwaway identity, a scripted Koios that
// serves the transactions the tests build, and run directories written the
// way `build` writes them (without the reference CLI's checks).

import crypto from 'node:crypto';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { Koios, NETWORKS } from '../src/koios.mjs';
import { Blockfrost } from '../src/blockfrost.mjs';
import { deriveIdentity, mnemonicFromEntropy, publicFacts } from '../src/keys.mjs';
import { prepareRun, runReport, runFiles, loadRun, prepareRebuild, rebuildReport } from '../src/build.mjs';
import { journal, journalEntry } from '../src/journal.mjs';
import { boundMetadata } from '../src/carriers.mjs';
import { decodeItem, Tagged } from '../src/cbor.mjs';
import { concat, fromHex, toHex } from '../src/util.mjs';

export const seededMnemonic = (label) => mnemonicFromEntropy(crypto.createHash('sha256').update(label).digest());

// A throwaway identity in a test home. `name` decides its network the way
// `init` does: "rehearsal" signs preprod records, any other name mainnet ones.
export function testIdentity(store, name = 'rehearsal', label = name) {
  const signingMnemonic = seededMnemonic(`${label} signing`);
  const paymentMnemonic = seededMnemonic(`${label} payment`);
  const id = deriveIdentity(signingMnemonic, paymentMnemonic);
  const pub = publicFacts(name, id);
  if (!store.hasIdentity(name)) store.createIdentity(name, { signingMnemonic, paymentMnemonic, publicJson: pub });
  return { id, pub, signingMnemonic, paymentMnemonic };
}

export function res(status, body, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

// The metadata entries of a served transaction: [{ label, bytes }].
function metadataEntries(hash, cbor) {
  try {
    const bytes = fromHex(cbor);
    const m = boundMetadata(bytes, hash);
    return m.bound ? m.entries.map((e) => ({ label: e.label, bytes: bytes.slice(e.value[0], e.value[1]) })) : [];
  } catch {
    return [];
  }
}

// db-sync's JSON for a metadata value: a byte string as "0x" and its hex.
function dbSyncJson(v) {
  if (v instanceof Uint8Array) return `0x${toHex(v)}`;
  if (typeof v === 'bigint') return Number(v);
  if (Array.isArray(v)) return v.map(dbSyncJson);
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [k instanceof Uint8Array ? `0x${toHex(k)}` : String(k), dbSyncJson(x)]));
  if (v instanceof Tagged) return dbSyncJson(v.value);
  return v;
}

// A served transaction's label-309 listing row facts, or null when it carries
// no label 309 or has no block.
function labelled(hash, t) {
  if (!t || !t.block || !t.cbor) return null;
  const e = metadataEntries(hash, t.cbor).find((x) => x.label === 309n);
  return e ? e : null;
}

export const PARAMS_ROW = { epoch_no: 320, protocol_major: 11, protocol_minor: 0, min_fee_a: 44, min_fee_b: 155381, max_tx_size: 16384, coins_per_utxo_size: '4310', nonce: null };

// A scripted Koios over an in-memory chain. `chain.txs` maps a hash to
// { cbor, confirmations, block } and `chain.utxos` lists the address's UTxOs.
// Every request is recorded in `calls`; `onCall` runs before each answer.
export function fakeChain(network, { utxos = [], txs = {}, tip = {}, genesis = {}, epochParams = {}, history = [], onCall = () => {}, submit } = {}) {
  const net = NETWORKS[network];
  const chain = { utxos, txs, tip: { epoch_no: 320, abs_slot: 136928566, block_height: 5319315, hash: '00'.repeat(32), block_time: 1792611766, ...tip }, history, submitted: [] };
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = url.replace('https://fake.koios/api/v1', '');
    calls.push(path.replace(/\?.*$/, ''));
    onCall(path, chain);
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    if (path === '/genesis') return res(200, [{ networkmagic: String(net.magic), networkid: net.koiosName, securityparam: '2160', activeslotcoeff: '0.05', epochlength: '432000', ...genesis }]);
    if (path === '/tip') return res(200, [chain.tip]);
    if (path.startsWith('/epoch_params')) {
      const n = Number(/_epoch_no=(\d+)/.exec(path)[1]);
      const row = epochParams[n] === undefined ? { ...PARAMS_ROW, epoch_no: n } : epochParams[n];
      return res(200, row ? [row] : []);
    }
    if (path.startsWith('/address_utxos')) return res(200, chain.utxos.map((u) => ({ tx_hash: u.txHash, tx_index: u.index, address: '', value: String(u.coin), asset_list: [] })));
    if (path.startsWith('/address_txs')) return res(200, chain.history.map((h) => ({ tx_hash: h, epoch_no: 320, block_height: 1, block_time: 1 })));
    if (path === '/submittx') {
      if (submit) return submit(init.body, chain);
      const hash = toHex(CSL.FixedTransaction.from_bytes(init.body).transaction_hash().to_bytes());
      chain.submitted.push(hash);
      return res(202, `"${hash}"`);
    }
    const tx = (h) => chain.txs[h];
    if (path === '/tx_status') return res(200, body._tx_hashes.map((h) => ({ tx_hash: h, num_confirmations: tx(h) ? tx(h).confirmations : null })));
    // `servedCbor` replaces the bytes served (null: none), not those listed.
    const served = (h) => (tx(h).servedCbor !== undefined ? tx(h).servedCbor : tx(h).cbor);
    if (path === '/tx_cbor') return res(200, body._tx_hashes.filter((h) => tx(h) && served(h) !== null).map((h) => ({ tx_hash: h, cbor: served(h) })));
    if (path === '/tx_info') {
      if (body._inputs) return res(200, body._tx_hashes.filter((h) => tx(h) && tx(h).inputs).map((h) => ({ tx_hash: h, inputs: tx(h).inputs.map((i) => ({ tx_hash: i.txHash, tx_index: i.index })) })));
      return res(
        200,
        body._tx_hashes.filter((h) => tx(h) && tx(h).block).map((h) => ({ tx_hash: h, tx_block_index: tx(h).index ?? 0, ...tx(h).block }))
      );
    }
    // Label-309 transactions by block height, as Koios's PostgREST serves
    // them: `_after_block_height` inclusive, `block_height=lte.`, `order`
    // and `limit`. A transaction with `listed: false` is not (yet) listed.
    if (path.startsWith('/tx_by_metalabel')) {
      const q = new URLSearchParams(path.split('?')[1]);
      if (q.get('_label') !== '309') throw new Error(`fake Koios: label ${q.get('_label')}`);
      const after = Number(q.get('_after_block_height'));
      const lte = Number(/^lte\.(\d+)$/.exec(q.get('block_height'))[1]);
      const desc = /desc/.test(q.get('order') || '');
      let rows = Object.entries(chain.txs)
        .filter(([h, t]) => t.listed !== false && labelled(h, t))
        .map(([h, t]) => ({ tx_hash: h, block_hash: t.block.block_hash, block_height: t.block.block_height, epoch_no: t.block.epoch_no, absolute_slot: t.block.absolute_slot, tx_timestamp: t.block.tx_timestamp }))
        .filter((r) => r.block_height >= after && r.block_height <= lte);
      rows.sort((a, b) => a.block_height - b.block_height || (a.tx_hash < b.tx_hash ? -1 : 1));
      if (desc) rows.reverse();
      rows = rows.slice(0, Number(q.get('limit') || 1000));
      return res(200, rows);
    }
    if (path === '/tx_metadata') {
      return res(
        200,
        body._tx_hashes.filter(tx).map((h) => ({
          tx_hash: h,
          metadata: tx(h).koiosMetadata !== undefined ? tx(h).koiosMetadata : Object.fromEntries(metadataEntries(h, tx(h).cbor).map((e) => [String(e.label), dbSyncJson(decodeItem(e.bytes, 0)[0])]))
        }))
      );
    }
    throw new Error(`fake Koios: unexpected ${path}`);
  };
  const koios = (own = {}) => new Koios(network, { baseUrl: 'https://fake.koios/api/v1', fetchImpl, sleepImpl: async () => {}, own, spacingMs: 0 });
  return { chain, calls, koios, fetchImpl };
}

const d = (n) => new Uint8Array(32).fill(n);

// Hashed items as hashItems returns them, from placeholder digests.
export function hashedItems(specs) {
  return specs.map((s, i) => ({ index: i, name: s.name || `f${i}`, path: `/nowhere/${s.name || `f${i}`}`, digest: s.digest || d(i + 1), hex: toHex(s.digest || d(i + 1)), size: 1, type: s.type, ids: s.ids, binary: false, document: Boolean(s.document), message: Boolean(s.message), bytes: new Uint8Array(0) }));
}

// A run directory written as `build` writes it, from placeholder items, with
// fake UTxOs; `extra` goes into the report (stage, confirmed, verified...).
export async function fabricateRun(store, { network = 'preprod', identity, kind = 'freeze', coreOnly = false, items, supersedes, related, extra = {}, tipSlot = 1000, utxoTag = 'a' }) {
  const hashed = items || hashedItems([{ type: 'StudyRegistration', document: true, ids: [{ id: '10.5281/zenodo.1', id_type: 'DOI', relation: 'IsPartOf' }] }, { type: 'Software' }]);
  const messageItems = hashed.filter((h) => h.document).map((h) => h.index);
  const manifest = { kind, messageItems: messageItems.length ? messageItems : [0], supersedes, related, doi: '10.5281/zenodo.1' };
  const params = { epoch: 320, protocolMajor: 11, protocolMinor: 0, minFeeA: 44n, minFeeB: 155381n, maxTxSize: 16384, coinsPerUtxoByte: 4310n, tip: { slot: tipSlot, epoch: 320, height: 1, hash: '00', time: 1 } };
  const utxos = [{ txHash: utxoTag.repeat(64).slice(0, 64), index: 0, coin: 20000000n, assets: [], datumBytes: null, datumHash: null, refScript: null }];
  const p = await prepareRun({ manifest, hashed, coreOnly, id: identity.id, utxos, params, network, ttl: tipSlot + 7200, paymentKeyHash: identity.pub.payment_key_hash });
  const report = runReport({ network, name: identity.pub.name, pub: identity.pub, manifest, coreOnly, hashed, doc: null, p, params, checks: [], cli: null, extra });
  const dir = store.writeRun(network, p.tx.hash, runFiles(p, report));
  return { dir, p, report, hash: p.tx.hash, cbor: toHex(p.tx.bytes), body: p.signed.body };
}

// A rebuilt run directory written as `build --rebuild` writes it (without
// the reference CLI's checks): the journal's current entry's record in a new
// transaction over `utxos` (by default the entry's own inputs), built at
// `tipSlot`.
export function fabricateRebuild(store, { network = 'mainnet', identity, tipSlot, utxos }) {
  const entry = store.readJournal(network).current;
  const old = loadRun(store.runDir(network, entry.txHash));
  const params = { epoch: 320, protocolMajor: 11, protocolMinor: 0, minFeeA: 44n, minFeeB: 155381n, maxTxSize: 16384, coinsPerUtxoByte: 4310n, tip: { slot: tipSlot, epoch: 320, height: 1, hash: '00', time: 1 } };
  const spend = utxos || entry.inputs.map((u) => ({ txHash: u.txHash, index: u.index, coin: BigInt(u.coin), assets: [], datumBytes: null, datumHash: null, refScript: null }));
  const p = prepareRebuild({ run: old, sentCbor: entry.cbor, utxos: spend, payment: identity.id.payment, params, network, ttl: tipSlot + 7200, paymentKeyHash: identity.pub.payment_key_hash, mustSpend: entry.state === 'failed' ? [] : entry.inputs });
  const report = rebuildReport({ old: old.report, p, params, checks: [], cli: null });
  const dir = store.writeRun(network, p.tx.hash, runFiles(p, report));
  return { dir, p, report, hash: p.tx.hash, cbor: toHex(p.tx.bytes) };
}

// Journal a fabricated run and mark it confirmed, as `submit` and `wait` would.
export function journalConfirmed(store, network, run, identity) {
  journal(store, journalEntry({ network, txHash: run.hash, cbor: run.cbor, ttl: run.p.ttl, inputs: run.p.tx.inputs, run: run.dir, kind: run.report.kind, stage: run.report.stage || null, identity: identity.pub.name, signingPublicKey: identity.pub.signing_public_key }));
  store.updateJournal(network, (j) => {
    j.current.state = 'confirmed';
    j.history = [...(j.history || []), j.current];
    j.current = null;
  });
}

// A block in the shapes each provider reports it.
export function blockOf({ hash = 'bb'.repeat(32), height = 5319000, slot = 136700000, epoch = 320, epochSlot = 101600, time = 1792380000 } = {}) {
  return {
    koios: { block_hash: hash, block_height: height, absolute_slot: slot, epoch_no: epoch, epoch_slot: epochSlot, tx_timestamp: time },
    blockfrost: { hash, height, slot, epoch, epoch_slot: epochSlot, time },
    plain: { hash, height, slot, epoch, epochSlot, time }
  };
}

export const TEST_PROJECT_ID = 'preprodTESTprojectID0123456789abcdef';

// A scripted Blockfrost. `txs` maps a hash to { cbor, block } with `block`
// from blockOf(...).blockfrost; `epochParams[n]` is a row, or null for 404;
// `override[path]` answers a path with { status, body, headers }.
export function fakeBlockfrost(network, { txs = {}, tip = {}, genesis = {}, epochParams = {}, override = {}, history = [] } = {}) {
  const net = NETWORKS[network];
  const calls = [];
  const headers = [];
  const redirects = [];
  const state = { txs, history, tip: { height: 5319315, slot: 136928566, epoch: 320, hash: '00'.repeat(32), time: 1792611766, ...tip } };
  const fetchImpl = async (url, init) => {
    const p = url.replace('https://fake.blockfrost/api/v0', '');
    calls.push(p);
    headers.push(init.headers);
    redirects.push(init.redirect);
    const o = typeof override[p] === 'function' ? override[p]() : override[p];
    if (o) return res(o.status, o.body ?? '{}', o.headers || {});
    if (p === '/genesis') return res(200, { network_magic: net.magic, security_param: 2160, active_slots_coefficient: 0.05, epoch_length: 432000, ...genesis });
    if (p === '/blocks/latest') return res(200, state.tip);
    let m;
    if ((m = /^\/addresses\/([a-z0-9_]+)\/transactions\?page=(\d+)/.exec(p))) {
      return res(200, m[2] === '1' ? state.history.map((h, i) => ({ tx_hash: h, tx_index: 0, block_height: 1 + i, block_time: 1 })) : []);
    }
    if ((m = /^\/txs\/([0-9a-f]{64})\/cbor$/.exec(p))) {
      // `servedCbor` replaces the bytes served (null: none), not those listed.
      const t = state.txs[m[1]];
      const served = t && t.servedCbor !== undefined ? t.servedCbor : t?.cbor;
      return served ? res(200, { cbor: served }) : res(404, { status_code: 404 });
    }
    if ((m = /^\/txs\/([0-9a-f]{64})$/.exec(p))) {
      const t = state.txs[m[1]];
      if (!t || !t.block) return res(404, { status_code: 404 });
      return res(200, { hash: m[1], block: t.block.hash, block_height: t.block.height, block_time: t.block.time, slot: t.block.slot, index: t.index ?? 0 });
    }
    // The label-309 listing, newest first (block height, then index in the
    // block), 100 per page, with db-sync's single-label metadata CBOR. A
    // transaction with `listed: false` is not (yet) listed; `listingMetadata`
    // replaces what the listing shows of it.
    if ((m = /^\/metadata\/txs\/labels\/309\/cbor\?count=100&page=(\d+)&order=desc$/.exec(p))) {
      const rows = Object.entries(state.txs)
        .map(([h, t]) => ({ h, t, e: t.listed !== false && labelled(h, t) }))
        .filter((x) => x.e)
        .sort((a, b) => b.t.block.height - a.t.block.height || (b.t.index ?? 0) - (a.t.index ?? 0))
        .map((x) => ({ tx_hash: x.h, cbor_metadata: null, metadata: x.t.listingMetadata !== undefined ? x.t.listingMetadata : toHex(concat(Uint8Array.of(0xa1, 0x19, 0x01, 0x35), x.e.bytes)) }));
      const page = Number(m[1]);
      return res(200, rows.slice((page - 1) * 100, page * 100));
    }
    if ((m = /^\/blocks\/([0-9a-f]{64})\/txs\?count=100&page=(\d+)&order=asc$/.exec(p))) {
      const hashes = Object.entries(state.txs)
        .filter(([, t]) => t.block && t.block.hash === m[1])
        .sort((a, b) => (a[1].index ?? 0) - (b[1].index ?? 0))
        .map(([h]) => h);
      const page = Number(m[2]);
      return hashes.length ? res(200, hashes.slice((page - 1) * 100, page * 100)) : res(404, { status_code: 404 });
    }
    if ((m = /^\/blocks\/([0-9a-f]{64})$/.exec(p))) {
      const t = Object.values(state.txs).find((x) => x.block && x.block.hash === m[1]);
      return t ? res(200, { ...t.block, ...(t.blockOverride || {}) }) : res(404, { status_code: 404 });
    }
    if ((m = /^\/epochs\/(\d+)\/parameters$/.exec(p))) {
      const n = Number(m[1]);
      const row = epochParams[n] === undefined ? { epoch: n, protocol_major_ver: 11, nonce: null } : epochParams[n];
      return row ? res(200, row) : res(404, { status_code: 404 });
    }
    throw new Error(`fake Blockfrost: unexpected ${p}`);
  };
  const bf = (own = {}, opts = {}) => new Blockfrost(network, { projectId: TEST_PROJECT_ID, baseUrl: 'https://fake.blockfrost/api/v0', fetchImpl, sleepImpl: async () => {}, spacingMs: 0, own, ...opts });
  return { state, calls, headers, redirects, bf, fetchImpl };
}
