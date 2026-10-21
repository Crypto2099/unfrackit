// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The records a new record points at: the one it supersedes, the ones its
// research-related entries name, and the hypotheses record a final freeze's
// document cites. A pointer goes on chain for good, so each target must be a
// confirmed record of this identity on the same network, checked before
// anything is signed:
//
// - with a run directory in this home: its report records a wait to 15
//   confirmations and a verify in which all three verifiers said valid (on
//   mainnet, cross-checked with Blockfrost), and the journal records it as
//   confirmed;
// - in every case: Koios /tx_status reports at least 15 confirmations, and
//   so does Blockfrost when a project id is present (always on mainnet), with
//   byte-identical transaction CBOR; the transaction was paid by this
//   identity (exactly one vkey witness, from its payment key), which tells
//   the original from a replay of the same signed body in someone else's
//   transaction (CIP-190, "Signature replay"); and the record read from the
//   raw transaction (/tx_cbor, after the hash and auxiliary_data_hash
//   binding) validates, carries exactly one valid signature, by this
//   identity's key, and equals the run directory's body when there is one.
//
// Without a run directory (the home was lost and recreated with `restore`),
// the record is read from chain alone. CIP-190 "Supersedence" makes the
// pointer a service-independent link that does not rely on an off-chain
// database, so losing a local directory must not end re-typing.

import fs from 'node:fs';
import path from 'node:path';
import { CONFIRMATION_THRESHOLD, journalEntries } from './journal.mjs';
import { recordFromChain, recordFromBytes } from './verify.mjs';
import { RECORD_URI_RE } from './manifest.mjs';
import { decode } from './cbor.mjs';
import { witnessedBy } from './tx.mjs';
import { equalBytes, UserError } from './util.mjs';

function readReport(store, network, txHash) {
  const f = path.join(store.runDir(network, txHash), 'report.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

export async function confirmedRecord({ store, koios, bf = null, network, txHash, publicKeyHex, paymentKeyHash, role }) {
  const where = `${role} ${txHash}`;
  if (network === 'mainnet' && !bf) throw new UserError(`${where}: on mainnet a target's confirmation is cross-checked with Blockfrost; save the mainnet project id as secrets/blockfrost-mainnet.token`);
  const report = readReport(store, network, txHash);
  let runBody = null;
  if (report) {
    if (report.network !== network) throw new UserError(`${where} is a ${report.network} run, not ${network}`);
    if (!report.confirmed || !(Number(report.confirmed.confirmations) >= CONFIRMATION_THRESHOLD)) {
      throw new UserError(`${where}: its run directory records no wait to ${CONFIRMATION_THRESHOLD} confirmations; run "wait" and then "verify" on it first`);
    }
    const v = report.verified;
    if (!v || v.own?.verdict !== 'valid' || v.sdk?.verdict !== 'valid' || v.cli?.verdict !== 'valid' || (v.verdict !== undefined && v.verdict !== 'valid')) {
      throw new UserError(`${where}: its run directory records no verify in which this tool, the SDK and the reference CLI all said valid; run "verify" on it first`);
    }
    // On mainnet the verify must also have cross-checked the chain facts with
    // Blockfrost; anywhere, a cross-check that disagreed rules the record out.
    if (v.crosscheck?.ran && !v.crosscheck.ok) throw new UserError(`${where}: its verify found Koios and Blockfrost in disagreement (${(v.crosscheck.issues || []).join('; ')})`);
    if (network === 'mainnet' && v.crosscheck?.ok !== true) throw new UserError(`${where}: its verify did not cross-check the chain facts with Blockfrost; run "verify" with the mainnet project id in place`);
    if (!journalEntries(store, network).some((e) => e.txHash === txHash && e.state === 'confirmed')) {
      throw new UserError(`${where}: the ${network} journal does not record it as confirmed`);
    }
    runBody = new Uint8Array(fs.readFileSync(path.join(store.runDir(network, txHash), 'body.cbor')));
  }
  // Without a run directory this is the one hash the manifest names, and the
  // record read for it must turn out to be this identity's.
  koios.allowTx(txHash);
  const conf = await koios.txStatus(txHash);
  if (conf === null || conf < CONFIRMATION_THRESHOLD) {
    throw new UserError(`${where} has ${conf === null ? 'no' : conf} confirmations on Koios; ${CONFIRMATION_THRESHOLD} are required before a record may point at it`);
  }
  const rec = await recordFromChain(koios, txHash);
  if (rec.verdict !== 'valid') throw new UserError(`${where}: the record read from chain is ${rec.verdict} (${rec.issues.join('; ')})`);
  const paid = witnessedBy(rec.txBytes, paymentKeyHash);
  if (!paid.ok) throw new UserError(`${where} was not paid by this identity: ${paid.reason}`);
  if (rec.signers.length !== 1 || rec.signers[0] !== publicKeyHex) {
    throw new UserError(`${where} is signed by ${rec.signers.join(', ') || 'no valid key'}, not by this identity's ${publicKeyHex}`);
  }
  if (runBody && !equalBytes(runBody, rec.body)) throw new UserError(`${where}: the record on chain differs from the run directory's body`);
  let blockfrost = null;
  if (bf) {
    bf.allowTx(txHash);
    const cbor = await bf.txCbor(txHash);
    const tx = await bf.tx(txHash);
    const tip = await bf.latestBlock();
    if (!cbor || !tx) throw new UserError(`${where}: Blockfrost does not know the transaction`);
    if (cbor.toLowerCase() !== rec.cborHex.toLowerCase()) throw new UserError(`${where}: the transaction CBOR differs between Koios and Blockfrost`);
    const depth = Number(tip.height) - Number(tx.block_height) + 1;
    if (!(depth >= CONFIRMATION_THRESHOLD)) throw new UserError(`${where} is ${depth} blocks deep on Blockfrost; ${CONFIRMATION_THRESHOLD} are required before a record may point at it`);
    blockfrost = depth;
  }
  return {
    tx_hash: txHash,
    role,
    source: runBody ? 'run directory and chain' : 'chain',
    confirmations: conf,
    blockfrost_depth: blockfrost,
    signer: rec.signers[0],
    items: rec.items,
    keys: [...decode(rec.body, { canonical: true }).keys()],
    stage: report?.stage || null,
    kind: report?.kind || null
  };
}

const strip = ({ items: _items, keys: _keys, ...t }) => t;

// Every target of a manifest. A retype also carries every item of the record
// it supersedes, with identical digests in the same order.
export async function checkTargets({ store, koios, bf = null, network, manifest, hashed, publicKeyHex, paymentKeyHash }) {
  const out = [];
  if (manifest.supersedes) {
    const t = await confirmedRecord({ store, koios, bf, network, txHash: manifest.supersedes, publicKeyHex, paymentKeyHash, role: 'the superseded record' });
    if (manifest.kind === 'retype' && t.items.join() !== hashed.map((h) => h.hex).join()) {
      throw new UserError('a retype record carries every item of the record it supersedes, with identical digests in the same order');
    }
    out.push(t);
  }
  for (const r of manifest.related || []) {
    const hash = RECORD_URI_RE.exec(r.uri)[1];
    out.push(await confirmedRecord({ store, koios, bf, network, txHash: hash, publicKeyHex, paymentKeyHash, role: `the research-related (${r.relation}) record` }));
  }
  return out.map(strip);
}

// The final freeze's document cites the hypotheses record by its CIP-0107 URI
// in its text, which the final freeze then hashes, so a reader can diff the
// two documents. The hypotheses record must exist on chain, be confirmed, be
// paid and signed by this identity, and have the shape of a core-only freeze
// (v, sigs and items only). Which cited URI is the hypotheses record:
//
// - with `hypothesesHash` (`build --hypotheses <hash>`), that hash, which the
//   document must cite; it is read from chain when this home has no run
//   directory for it, so a final freeze stays buildable after a home loss;
// - otherwise, the one cited URI that names a hypotheses-stage run of this
//   home.
//
// Other cited URIs are reported, not checked.
export async function checkCitedHypotheses({ store, koios, bf = null, network, cited, publicKeyHex, paymentKeyHash, hypothesesHash }) {
  let hash;
  if (hypothesesHash) {
    if (!/^[0-9a-f]{64}$/.test(hypothesesHash)) throw new UserError(`--hypotheses must be a 64-digit lowercase transaction hash: ${hypothesesHash}`);
    if (!cited.includes(hypothesesHash)) throw new UserError(`the final-stage document does not cite the hypotheses record ${hypothesesHash} (it cites ${cited.length ? cited.join(', ') : 'no record URI'})`);
    const report = readReport(store, network, hypothesesHash);
    if (report && report.stage !== 'hypotheses') throw new UserError(`${hypothesesHash} is a ${report.stage ? `${report.stage}-stage` : report.kind} run of this home, not the hypotheses record`);
    hash = hypothesesHash;
  } else {
    const hyps = cited.filter((h) => readReport(store, network, h)?.stage === 'hypotheses');
    if (hyps.length !== 1) {
      throw new UserError(
        hyps.length === 0
          ? `the final-stage document cites no hypotheses-stage record of this home on ${network} (it cites ${cited.length ? cited.join(', ') : 'no record URI'}); its text must cite the hypotheses record as web+cardano://transaction/<hash>/metadata/309, and a home without that run names it with --hypotheses <hash>`
          : `the final-stage document cites ${hyps.length} hypotheses-stage records (${hyps.join(', ')}); it must cite exactly one`
      );
    }
    hash = hyps[0];
  }
  const t = await confirmedRecord({ store, koios, bf, network, txHash: hash, publicKeyHex, paymentKeyHash, role: 'the hypotheses record the document cites' });
  if (t.keys.join() !== 'v,sigs,items') throw new UserError(`the hypotheses record ${hash} is not a core-only freeze record (its top-level keys are ${t.keys.join(', ')})`);
  return { ...strip(t), other_cited: cited.filter((h) => h !== hash) };
}

// Records signed by this identity that sit on chain at its payment address
// but are not in this home's journal. A restored home's journal may predate
// a record the lost home sent, the final freeze included; the address
// history shows every transaction this identity paid for, so it is read from
// Koios and, when a project id is present (always on mainnet), from
// Blockfrost, and every transaction in either history that the journal does
// not know is opened. One that this identity paid for and that carries a
// label-309 record signed by its key is reported; so is one that neither
// provider can return or that cannot be read, since nothing can be said about
// it. Anyone can send a transaction to the address, including a replay of one
// of this identity's signed bodies; a record in a transaction this identity
// did not pay for is listed as a replay and does not count.
export async function unknownRecordsOnChain({ store, koios, bf = null, network, address, publicKeyHex, paymentKeyHash, exclude = [] }) {
  const known = new Set([...journalEntries(store, network).map((e) => e.txHash), ...exclude]);
  const hashes = new Set((await koios.addressTxs(address)).map((t) => t.txHash));
  if (bf) for (const t of await bf.addressTxs(address)) hashes.add(t.txHash);
  // A transaction either provider lists for the address is read from both.
  for (const h of hashes) {
    koios.historyTxs.add(h);
    if (bf) bf.historyTxs.add(h);
  }
  const found = [];
  const replays = [];
  for (const h of hashes) {
    if (known.has(h)) continue;
    const kCbor = await koios.txCbor(h);
    const bCbor = bf ? await bf.txCbor(h) : null;
    if (kCbor && bCbor && kCbor.toLowerCase() !== bCbor.toLowerCase()) {
      found.push({ tx_hash: h, reason: 'its CBOR differs between Koios and Blockfrost' });
      continue;
    }
    const cbor = kCbor || bCbor;
    if (!cbor) {
      found.push({ tx_hash: h, reason: 'neither provider returns its CBOR' });
      continue;
    }
    const rec = recordFromBytes(h, cbor);
    if (rec.verdict === 'none') continue;
    if (rec.verdict === 'unverifiable') {
      found.push({ tx_hash: h, reason: `it cannot be read: ${rec.issues.join('; ')}` });
      continue;
    }
    if (!rec.signers?.includes(publicKeyHex)) continue;
    if (witnessedBy(rec.txBytes, paymentKeyHash).ok) found.push({ tx_hash: h, reason: 'this identity paid for it, and it carries a label-309 record signed by this identity\'s key' });
    else replays.push(h);
  }
  return { found, replays };
}
