// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The records a new record points at: the one it supersedes, the ones its
// research-related entries name, and the hypotheses record a final freeze's
// document cites. A pointer goes on chain for good, so each target must be a
// confirmed record signed by this identity on the same network, checked
// before anything is signed:
//
// - with a run directory in this home: its report records a wait to 15
//   confirmations and a verify in which all three verifiers said valid, and
//   the journal records it as confirmed;
// - in every case: Koios /tx_status reports at least 15 confirmations, and
//   the record read from the raw transaction (/tx_cbor, after the hash and
//   auxiliary_data_hash binding) validates, carries exactly one valid
//   signature, by this identity's key, and equals the run directory's body
//   when there is one.
//
// Without a run directory (the home was lost and recreated with `restore`),
// the record is read from chain alone. CIP-190 "Supersedence" makes the
// pointer a service-independent link that does not rely on an off-chain
// database, so losing a local directory must not end re-typing.

import fs from 'node:fs';
import path from 'node:path';
import { CONFIRMATION_THRESHOLD, journalEntries } from './journal.mjs';
import { recordFromChain } from './verify.mjs';
import { RECORD_URI_RE } from './manifest.mjs';
import { equalBytes, UserError } from './util.mjs';

export async function confirmedRecord({ store, koios, network, txHash, publicKeyHex, role }) {
  const where = `${role} ${txHash}`;
  const dir = store.runDir(network, txHash);
  const reportFile = path.join(dir, 'report.json');
  let report = null;
  let runBody = null;
  if (fs.existsSync(reportFile)) {
    report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    if (report.network !== network) throw new UserError(`${where} is a ${report.network} run, not ${network}`);
    if (!report.confirmed || !(Number(report.confirmed.confirmations) >= CONFIRMATION_THRESHOLD)) {
      throw new UserError(`${where}: its run directory records no wait to ${CONFIRMATION_THRESHOLD} confirmations; run "wait" and then "verify" on it first`);
    }
    const v = report.verified;
    if (!v || v.own?.verdict !== 'valid' || v.sdk?.verdict !== 'valid' || v.cli?.verdict !== 'valid') {
      throw new UserError(`${where}: its run directory records no verify in which this tool, the SDK and the reference CLI all said valid; run "verify" on it first`);
    }
    if (!journalEntries(store, network).some((e) => e.txHash === txHash && e.state === 'confirmed')) {
      throw new UserError(`${where}: the ${network} journal does not record it as confirmed`);
    }
    runBody = new Uint8Array(fs.readFileSync(path.join(dir, 'body.cbor')));
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
  if (rec.signers.length !== 1 || rec.signers[0] !== publicKeyHex) {
    throw new UserError(`${where} is signed by ${rec.signers.join(', ') || 'no valid key'}, not by this identity's ${publicKeyHex}`);
  }
  if (runBody && !equalBytes(runBody, rec.body)) throw new UserError(`${where}: the record on chain differs from the run directory's body`);
  return { tx_hash: txHash, role, source: runBody ? 'run directory and chain' : 'chain', confirmations: conf, signer: rec.signers[0], items: rec.items, stage: report?.stage || null, kind: report?.kind || null };
}

// Every target of a manifest. A retype also carries every item of the record
// it supersedes, with identical digests in the same order.
export async function checkTargets({ store, koios, network, manifest, hashed, publicKeyHex }) {
  const out = [];
  if (manifest.supersedes) {
    const t = await confirmedRecord({ store, koios, network, txHash: manifest.supersedes, publicKeyHex, role: 'the superseded record' });
    if (manifest.kind === 'retype' && t.items.join() !== hashed.map((h) => h.hex).join()) {
      throw new UserError('a retype record carries every item of the record it supersedes, with identical digests in the same order');
    }
    out.push(t);
  }
  for (const r of manifest.related || []) {
    const hash = RECORD_URI_RE.exec(r.uri)[1];
    out.push(await confirmedRecord({ store, koios, network, txHash: hash, publicKeyHex, role: `the research-related (${r.relation}) record` }));
  }
  return out.map(({ items: _items, ...t }) => t);
}
