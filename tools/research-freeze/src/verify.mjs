// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// On-chain verification of one of this tool's transactions, three ways: this
// tool's own reading of the raw transaction from Koios /tx_cbor (never the
// metadata JSON view; CIP-190 "Structural validation, verifier roles, and
// error codes", Part B, "Pipeline", step 1), the SDK's verifyTx, and the
// cardanowall CLI's `verify`, all in the default `signed` profile.

import { sliceTxComponents, unwrapAuxiliaryData, bindTransactionBytes, verifyTx } from '@cardanowall/sdk-ts/verifier';
import { reassembleLabel309Value, validatePoeRecord } from '@cardanowall/poe-standard';
import { coseSign1Label309Verify } from '@cardanowall/crypto-core/cose';
import { decode, encode, mapGet } from './cbor.mjs';
import { networkOf } from './koios.mjs';
import { CONFIRMATION_THRESHOLD } from './journal.mjs';
import { equalBytes, fromHex, toHex } from './util.mjs';

export function explorerLinks(network, txHash) {
  const p = network === 'preprod' ? 'preprod.' : '';
  return [`https://${p}cardanoscan.io/transaction/${txHash}`, `https://${p}cexplorer.io/tx/${txHash}`];
}

// CIP-190 "Chain facts: block time and confirmation depth":
// depth = tip height - block height + 1, so the tip block has depth 1.
export function confirmationDepth(tipHeight, blockHeight) {
  if (tipHeight < blockHeight) throw new Error('inconsistent heights: the tip is below the block');
  return tipHeight - blockHeight + 1;
}

export async function ownVerify({ koios, txHash, expectedBody }) {
  const issues = [];
  const cborHex = await koios.txCbor(txHash);
  if (!cborHex) return { verdict: 'unverifiable', issues: ['Koios /tx_cbor does not know the transaction'] };
  const txBytes = fromHex(cborHex);
  const parts = sliceTxComponents(txBytes);
  const binding = bindTransactionBytes({ requestedTxHashHex: txHash, txBody: parts.txBody, auxiliaryData: parts.auxiliaryData });
  if (!binding.ok) return { verdict: 'unverifiable', issues: [`binding: ${binding.message}`] };
  const unwrapped = unwrapAuxiliaryData(parts.auxiliaryData);
  const back = reassembleLabel309Value(unwrapped.label309);
  if (!back.ok) return { verdict: 'failed', issues: [`carriage: ${back.issue.code}`] };
  const body = back.body;
  if (expectedBody && !equalBytes(body, expectedBody)) issues.push('the on-chain record body differs from the run directory\'s body');
  const v = validatePoeRecord(body);
  if (!v.valid) issues.push(`validator: ${v.issues.map((i) => i.code).join(', ')}`);
  const rec = decode(body, { canonical: true });
  const sigs = mapGet(rec, 'sigs') || [];
  const bodyNoSigs = (() => {
    const m = new Map(rec);
    m.delete('sigs');
    return m;
  })();
  const noSigsBytes = encode(bodyNoSigs);
  const signers = [];
  for (const s of sigs) {
    const r = coseSign1Label309Verify({ message: mapGet(s, 'cose_sign1'), detachedRecordBodyCbor: noSigsBytes });
    if (!r.ok) issues.push(`signature: ${r.error.code}`);
    else signers.push(toHex(r.signerKey));
  }
  const info = await koios.txInfo(txHash);
  const tip = await koios.tip();
  const depth = info ? confirmationDepth(tip.height, Number(info.block_height)) : null;
  return {
    verdict: issues.length ? 'failed' : depth !== null && depth >= CONFIRMATION_THRESHOLD ? 'valid' : 'pending',
    issues,
    labels: unwrapped.metadataLabels,
    signers,
    items: mapGet(rec, 'items').map((it) => toHex(mapGet(mapGet(it, 'hashes'), 'sha2-256'))),
    extensionKeys: [...rec.keys()].filter((k) => typeof k === 'string' && k.includes('-')),
    body_matches_run: expectedBody ? equalBytes(body, expectedBody) : null,
    block: info
      ? { height: Number(info.block_height), hash: info.block_hash, slot: Number(info.absolute_slot), time: Number(info.tx_timestamp), time_iso: new Date(Number(info.tx_timestamp) * 1000).toISOString(), epoch: Number(info.epoch_no) }
      : null,
    confirmations: depth,
    tip
  };
}

export async function sdkVerify({ network, txHash, koiosUrl }) {
  const report = await verifyTx({ txHash, cardanoNetwork: network, cardanoGatewayChain: [koiosUrl], confirmationDepthThreshold: CONFIRMATION_THRESHOLD });
  return {
    verdict: report.verdict,
    exitCode: report.exitCode,
    issues: report.issues.map((i) => `${i.code}@${i.path.join('.')}:${i.severity}`),
    signers: (report.signatures || []).map((s) => `${s.signerPub || s.signer_pub || ''}:${s.verdict}`),
    confirmationDepth: report.confirmationDepth,
    block_time: report.block_time,
    auditTrail: (report.auditTrail || []).map((a) => `${a.method} ${a.url} ${a.status}`)
  };
}

export function cliVerify({ cli, network, txHash, koiosUrl }) {
  const r = cli.json(['verify', txHash, '--network', network, '--cardano-gateway', koiosUrl, '--json']);
  const j = r.json || {};
  return {
    exit: r.status,
    verdict: j.verdict,
    profile: j.profile,
    issues: (j.issues || []).map((i) => `${i.code}@${(i.path || []).join('.')}:${i.severity}`),
    signers: (j.signatures || []).map((s) => `${s.signerPub}:${s.verdict}`),
    items: (j.record?.items || []).map((it) => it.hashes?.['sha2-256']),
    extensionKeys: Object.keys(j.record || {}).filter((k) => k.includes('-')),
    confirmationDepth: j.confirmationDepth,
    block_time: j.block_time,
    auditTrail: (j.auditTrail || []).map((a) => `${a.method} ${a.url} ${a.status}`),
    stderr: r.status === 0 ? undefined : (r.stderr || '').slice(0, 2000)
  };
}

export async function verifyAll({ koios, cli, network, txHash, expectedBody }) {
  const net = networkOf(network);
  const own = await ownVerify({ koios, txHash, expectedBody });
  const sdk = await sdkVerify({ network, txHash, koiosUrl: koios.base });
  const cliR = cli ? cliVerify({ cli, network, txHash, koiosUrl: koios.base }) : { verdict: 'not run', note: 'cardanowall CLI not available' };
  return { network: net.name, txHash, own, sdk, cli: cliR, explorers: explorerLinks(network, txHash) };
}
