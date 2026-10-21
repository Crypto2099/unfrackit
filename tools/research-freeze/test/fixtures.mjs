// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Shared fixtures: a deterministic throwaway identity, a scripted Koios that
// serves the transactions the tests build, and run directories written the
// way `build` writes them (without the reference CLI's checks).

import crypto from 'node:crypto';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { Koios, NETWORKS } from '../src/koios.mjs';
import { deriveIdentity, mnemonicFromEntropy, publicFacts } from '../src/keys.mjs';
import { prepareRun, runReport, runFiles } from '../src/build.mjs';
import { journal, journalEntry } from '../src/journal.mjs';
import { toHex } from '../src/util.mjs';

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
    if (path === '/tx_cbor') return res(200, body._tx_hashes.filter(tx).map((h) => ({ tx_hash: h, cbor: tx(h).cbor })));
    if (path === '/tx_info') {
      return res(
        200,
        body._tx_hashes.filter((h) => tx(h) && tx(h).block).map((h) => ({ tx_hash: h, ...tx(h).block }))
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

// Journal a fabricated run and mark it confirmed, as `submit` and `wait` would.
export function journalConfirmed(store, network, run, identity) {
  journal(store, journalEntry({ network, txHash: run.hash, cbor: run.cbor, ttl: run.p.ttl, inputs: run.p.tx.inputs, run: run.dir, kind: run.report.kind, stage: run.report.stage || null, identity: identity.pub.name, signingPublicKey: identity.pub.signing_public_key }));
  store.updateJournal(network, (j) => {
    j.current.state = 'confirmed';
    j.history = [...(j.history || []), j.current];
    j.current = null;
  });
}
