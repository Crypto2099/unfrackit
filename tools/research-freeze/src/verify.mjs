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
import { VERIFY_FLAGS } from './cardanowall.mjs';
import { koiosBlockFacts, blockfrostBlockFacts, differences, describeDifferences, genesisDifferences, planFrom, BLOCK_FIELDS, PLAN_FIELDS } from './draw.mjs';
import { equalBytes, fromHex, sha256, toHex } from './util.mjs';

const sha256Hex = (b) => toHex(sha256(b));

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

// The record of a transaction, read from its raw bytes (Koios /tx_cbor, never
// the metadata JSON view; CIP-190 Part B, "Pipeline", step 1), after the
// transaction-hash and auxiliary_data_hash binding (step 2): reassembled,
// validated, and every signature verified.
export async function recordFromChain(koios, txHash) {
  const cborHex = await koios.txCbor(txHash);
  if (!cborHex) return { verdict: 'unverifiable', issues: ['Koios /tx_cbor does not know the transaction'] };
  return recordFromBytes(txHash, cborHex);
}

// The same from transaction CBOR already fetched. A transaction without a
// label-309 value gives { verdict: 'none' }.
export function recordFromBytes(txHash, cborHex) {
  const txBytes = fromHex(cborHex);
  const parts = sliceTxComponents(txBytes);
  const binding = bindTransactionBytes({ requestedTxHashHex: txHash, txBody: parts.txBody, auxiliaryData: parts.auxiliaryData });
  if (!binding.ok) return { verdict: 'unverifiable', issues: [`binding: ${binding.message}`] };
  if (!parts.auxiliaryData) return { verdict: 'none', issues: ['no auxiliary data'], txBytes, cborHex };
  const unwrapped = unwrapAuxiliaryData(parts.auxiliaryData);
  if (!unwrapped.label309) return { verdict: 'none', issues: ['no label-309 value'], txBytes, cborHex };
  const back = reassembleLabel309Value(unwrapped.label309);
  if (!back.ok) return { verdict: 'failed', issues: [`carriage: ${back.issue.code}`] };
  const body = back.body;
  const issues = [];
  const v = validatePoeRecord(body);
  if (!v.valid) issues.push(`validator: ${v.issues.map((i) => i.code).join(', ')}`);
  const rec = decode(body, { canonical: true });
  const sigs = mapGet(rec, 'sigs') || [];
  const bodyNoSigs = new Map(rec);
  bodyNoSigs.delete('sigs');
  const noSigsBytes = encode(bodyNoSigs);
  const signers = [];
  for (const s of sigs) {
    const r = coseSign1Label309Verify({ message: mapGet(s, 'cose_sign1'), detachedRecordBodyCbor: noSigsBytes });
    if (!r.ok) issues.push(`signature: ${r.error.code}`);
    else signers.push(toHex(r.signerKey));
  }
  return {
    verdict: issues.length ? 'failed' : 'valid',
    issues,
    txBytes,
    cborHex,
    body,
    labels: unwrapped.metadataLabels,
    signers,
    items: mapGet(rec, 'items').map((it) => toHex(mapGet(mapGet(it, 'hashes'), 'sha2-256'))),
    extensionKeys: [...rec.keys()].filter((k) => typeof k === 'string' && k.includes('-'))
  };
}

// `expectedSigner`: the signing key of the identity that built the
// transaction, from the run directory or the journal. A valid signature by
// any other key fails.
export async function ownVerify({ koios, txHash, expectedBody, expectedSigner }) {
  const r = await recordFromChain(koios, txHash);
  if (!r.body) return { verdict: r.verdict, issues: r.issues };
  const issues = [...r.issues];
  if (expectedBody && !equalBytes(r.body, expectedBody)) issues.push('the on-chain record body differs from the run directory\'s body');
  if (expectedSigner && (r.signers.length !== 1 || r.signers[0] !== expectedSigner)) {
    issues.push(`signer: the record is signed by ${r.signers.join(', ') || 'no valid key'}, not by this home's identity ${expectedSigner}`);
  }
  const info = await koios.txInfo(txHash);
  const tip = await koios.tip();
  const depth = info ? confirmationDepth(tip.height, Number(info.block_height)) : null;
  return {
    verdict: issues.length ? 'failed' : depth !== null && depth >= CONFIRMATION_THRESHOLD ? 'valid' : 'pending',
    issues,
    labels: r.labels,
    signers: r.signers,
    expected_signer: expectedSigner || null,
    items: r.items,
    extensionKeys: r.extensionKeys,
    body_matches_run: expectedBody ? equalBytes(r.body, expectedBody) : null,
    block: info
      ? { height: Number(info.block_height), hash: info.block_hash, slot: Number(info.absolute_slot), epoch: Number(info.epoch_no), epoch_slot: Number(info.epoch_slot), time: Number(info.tx_timestamp), time_iso: new Date(Number(info.tx_timestamp) * 1000).toISOString() }
      : null,
    confirmations: depth,
    tip,
    tx_cbor_sha256: sha256Hex(r.txBytes)
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
  const r = cli.json(['verify', txHash, '--network', network, '--cardano-gateway', koiosUrl, '--json', ...VERIFY_FLAGS]);
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

export async function verifyAll({ koios, cli, network, txHash, expectedBody, expectedSigner, sdkImpl = sdkVerify }) {
  const net = networkOf(network);
  const own = await ownVerify({ koios, txHash, expectedBody, expectedSigner });
  const sdk = await sdkImpl({ network, txHash, koiosUrl: koios.base });
  const cliR = cli ? cliVerify({ cli, network, txHash, koiosUrl: koios.base }) : { verdict: 'not run', note: 'cardanowall CLI not available' };
  return { network: net.name, txHash, own, sdk, cli: cliR, explorers: explorerLinks(network, txHash) };
}

// Chain facts from two independent providers, compared field by field
// (CIP-190 "Chain facts: block time and confirmation depth": verifiers are
// RECOMMENDED to resolve them from at least two independent explorers and to
// surface divergence, and a deployment for which they are load-bearing MUST
// cross-check them). Koios and Blockfrost must return byte-identical
// transaction CBOR and the same block hash, height, slot, epoch, epoch slot
// and time. Any difference fails; neither provider stands in for the other.
export async function crossCheck({ koios, bf, txHash }) {
  await bf.guard();
  bf.allowTx(txHash);
  const issues = [];
  const kCbor = await koios.txCbor(txHash);
  const bCbor = await bf.txCbor(txHash);
  if (!kCbor || !bCbor) issues.push(`transaction CBOR: Koios ${kCbor ? 'has it' : 'does not have it'}, Blockfrost ${bCbor ? 'has it' : 'does not have it'}`);
  else if (kCbor.toLowerCase() !== bCbor.toLowerCase()) issues.push('the transaction CBOR differs between Koios and Blockfrost');
  const kf = await koiosBlockFacts(koios, txHash);
  const bfacts = await blockfrostBlockFacts(bf, txHash);
  if (!kf || !bfacts) issues.push(`block facts: Koios ${kf ? 'has them' : 'has none'}, Blockfrost ${bfacts ? 'has them' : 'has none'}`);
  else {
    const d = differences(kf, bfacts, BLOCK_FIELDS);
    if (d.length) issues.push(`block facts differ: ${describeDifferences(d, 'Koios', 'Blockfrost')}`);
  }
  const kTip = await koios.tip();
  const bTip = await bf.latestBlock();
  return {
    ran: true,
    ok: issues.length === 0,
    issues,
    at: new Date().toISOString(),
    koios: kf,
    blockfrost: bfacts,
    tx_cbor_sha256: kCbor ? sha256Hex(fromHex(kCbor)) : null,
    depth: { koios: kf ? kTip.height - kf.block_height + 1 : null, blockfrost: bfacts && bTip ? Number(bTip.height) - bfacts.block_height + 1 : null },
    blockfrost_calls: bf.calls.map((c) => `GET ${c.path} ${c.status}`)
  };
}

// The draw plan of a final-stage freeze from Koios, and from Blockfrost when
// it is available; the two must agree, and so must the plan `wait` recorded.
export async function verifyDrawPlan({ koios, bf, facts, bfFacts, recorded }) {
  const issues = [];
  const gK = await koios.genesis();
  const pK = await koios.epochParams(facts.epoch);
  const plan = planFrom(gK, facts, Number(pK?.protocol_major));
  const sources = ['koios'];
  if (bf && bfFacts) {
    const gB = await bf.genesis();
    const gd = genesisDifferences(gK, gB);
    if (gd.length) issues.push(`genesis parameters differ: ${describeDifferences(gd, 'Koios', 'Blockfrost')}`);
    const pB = await bf.epochParams(bfFacts.epoch);
    const planB = planFrom(gB, bfFacts, Number(pB?.protocol_major_ver));
    const d = differences(plan, planB, PLAN_FIELDS);
    if (d.length) issues.push(`the draw plan differs: ${describeDifferences(d, 'Koios', 'Blockfrost')}`);
    sources.push('blockfrost');
  }
  if (recorded) {
    const d = differences(plan, recorded, PLAN_FIELDS);
    if (d.length) issues.push(`the draw plan differs from the one "wait" recorded: ${describeDifferences(d, 'now', 'recorded')}`);
  }
  return { ...plan, sources, cross_checked: sources.length === 2, issues };
}
