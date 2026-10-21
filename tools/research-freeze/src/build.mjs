// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// hash, build and check: from a manifest to a run directory holding the exact
// signed transaction, written only when every offline check passes.

import fs from 'node:fs';
import path from 'node:path';
import { readManifest, recordUri } from './manifest.mjs';
import { hashItems, documentChecks, citedRecords, DOCUMENT_CHECKED_KINDS } from './hashing.mjs';
import { deriveIdentity } from './keys.mjs';
import { buildRecord, signRecord, carry, messageLines, auxiliaryData, detailedMetadataJson, topLevelKeys } from './record.mjs';
import { buildTransaction, TTL_SLOTS } from './tx.mjs';
import { checkArtifacts, requireAllPass } from './checks.mjs';
import { assertNoUnresolved, assertNoOtherFinal, journalEntries } from './journal.mjs';
import { checkTargets, checkCitedHypotheses } from './targets.mjs';
import { networkOf } from './koios.mjs';
import { versions } from './pins.mjs';
import { fromHex, stringify, toHex, UserError } from './util.mjs';

export function defaultIdentity(network) {
  return network === 'preprod' ? 'rehearsal' : 'freeze';
}

// The rehearsal identity signs preprod records only; every other identity
// signs mainnet records only. A body signed by the real key is portable
// (CIP-190 "Record-level signatures (COSE_Sign1)": a verified signature
// binds the record body only), so a preprod record signed by it could be
// republished on mainnet by anyone.
export function assertIdentityNetwork(pub, network) {
  if (!Array.isArray(pub.networks) || !pub.networks.includes(network)) {
    throw new UserError(`identity "${pub.name}" signs ${pub.networks?.join(', ')} records only, not ${network}`);
  }
}

export const STAGES = Object.freeze(['hypotheses', 'final']);

// The two-stage freeze. A freeze record names its stage: `hypotheses`, a
// core-only freeze of the pre-registration text taken before any live-fire
// query, or `final`, the freeze whose block determines the epoch whose nonce
// keys the study's draw. The stage is not on chain; it goes into the run
// directory, the journal and every report, so which run keys the draw is
// never ambiguous. No other kind has a stage.
export function checkStage({ kind, stage, coreOnly }) {
  if (kind !== 'freeze') {
    if (stage) throw new UserError(`--stage applies to freeze records only, not ${kind}`);
    return null;
  }
  if (!stage) throw new UserError('a freeze record needs --stage hypotheses or --stage final (the final freeze is the one whose block keys the draw)');
  if (!STAGES.includes(stage)) throw new UserError(`--stage must be hypotheses or final, not "${stage}"`);
  if (stage === 'hypotheses' && !coreOnly) throw new UserError('the hypotheses record is a core-only freeze; build it with --core-only');
  return stage;
}

export function hashManifest({ manifestPath, signingPublicKeyHex, stage }) {
  const manifest = readManifest(manifestPath);
  const hashed = hashItems(manifest);
  let doc = null;
  if (DOCUMENT_CHECKED_KINDS.has(manifest.kind)) {
    doc = documentChecks(manifest, hashed, signingPublicKeyHex);
  }
  if (stage === 'final' && doc) {
    // The final document cites the hypotheses record; the chain half of this
    // check (the record exists, is confirmed, and is signed by the same key)
    // runs in build, after the network guard.
    const text = new TextDecoder().decode(hashed.find((x) => x.document).bytes);
    const { hashes, uppercase } = citedRecords(text);
    doc.cited = hashes;
    for (const u of uppercase) doc.errors.push(`the document cites ${u} with uppercase hex; record URIs are written in lowercase`);
    if (!hashes.length) doc.errors.push('a final-stage document cites the hypotheses record by its URI, web+cardano://transaction/<hash>/metadata/309; this one cites none');
    doc.ok = doc.errors.length === 0;
  }
  return { manifest, hashed, doc };
}

// `bf`: the Blockfrost client when the home holds a project id; on mainnet a
// build that points at another record needs one. `hypothesesHash`: the
// hypotheses record a final freeze's document cites, named explicitly
// (`--hypotheses`), for a home that has no run directory for it.
export async function build({ store, koios, bf = null, cli, manifestPath, network, identityName, coreOnly = false, stage, hypothesesHash, log = () => {} }) {
  networkOf(network);
  const name = identityName || defaultIdentity(network);
  const pub = store.readPublic(name);
  assertIdentityNetwork(pub, network);
  assertNoUnresolved(store, network);
  if (stage === 'final') assertNoOtherFinal(journalEntries(store, network), network);
  if (hypothesesHash && stage !== 'final') throw new UserError('--hypotheses applies to a final-stage freeze only');
  if (!cli) throw new UserError('build requires the cardanowall CLI 0.12.0 for its offline checks');

  const { manifest, hashed, doc } = hashManifest({ manifestPath, signingPublicKeyHex: pub.signing_public_key, stage });
  checkStage({ kind: manifest.kind, stage, coreOnly });
  if (doc && !doc.ok) throw new UserError(`document checks failed:\n${doc.errors.map((e) => `  ${e}`).join('\n')}`);

  await koios.guard();
  if (bf) await bf.guard();
  const params = await koios.params();
  // Every record this one points at is a confirmed record of this identity.
  const keys = { publicKeyHex: pub.signing_public_key, paymentKeyHash: pub.payment_key_hash };
  const targets = await checkTargets({ store, koios, bf, network, manifest, hashed, ...keys });
  let hypotheses = null;
  if (stage === 'final') {
    hypotheses = await checkCitedHypotheses({ store, koios, bf, network, cited: doc.cited, hypothesesHash, ...keys });
    targets.push(hypotheses);
  }

  const { signingMnemonic, paymentMnemonic } = store.readMnemonics(name);
  const id = deriveIdentity(signingMnemonic, paymentMnemonic);
  const address = id.payment.address(network).to_bech32();
  if (toHex(id.signing.publicKey) !== pub.signing_public_key || toHex(id.payment.keyHash) !== pub.payment_key_hash || address !== pub.addresses[network]) {
    throw new UserError(`identity "${name}": the public file does not match the keys its mnemonics derive; refusing`);
  }

  koios.addresses.add(address);
  const utxos = await koios.addressUtxos(address);
  const p = await prepareRun({ manifest, hashed, coreOnly, id, utxos, params, network, ttl: params.tip.slot + TTL_SLOTS, paymentKeyHash: pub.payment_key_hash });
  const checks = checkArtifacts(
    {
      body: p.signed.body,
      bodyNoSigs: p.signed.bodyNoSigs,
      sigStructure: p.signed.sigStructure,
      coseSign1: p.signed.coseSign1,
      txBytes: p.tx.bytes,
      txExpect: p.txExpect,
      digests: hashed.map((h) => h.hex),
      publicKeyHex: pub.signing_public_key
    },
    { cli, store, rehearsalSeed: name === 'rehearsal' ? id.signingSeed : null }
  );
  requireAllPass(checks);

  const report = runReport({ network, name, pub, manifest, coreOnly, hashed, doc, p, params, checks, cli, extra: { stage: stage || null, hypotheses_record: hypotheses ? hypotheses.tx_hash : null, targets } });
  const dir = store.writeRun(network, p.tx.hash, runFiles(p, report));
  log(`run directory: ${dir}`);
  return { dir, report, tx: p.tx, signed: p.signed };
}

// From hashed files, keys, UTxOs and parameters to the signed record and the
// signed transaction, with what the post-build assertions expect of them. No
// I/O.
export async function prepareRun({ manifest, hashed, coreOnly, id, utxos, params, network, ttl, paymentKeyHash }) {
  const net = networkOf(network);
  const address = id.payment.address(network).to_bech32();
  const record = buildRecord({ kind: manifest.kind, hashed, coreOnly, supersedes: manifest.supersedes, related: manifest.related });
  const signed = await signRecord(record, id.signing);
  const { chunks, valueBytes } = carry(signed.body);
  const lines = messageLines(hashed, manifest.messageItems);
  const aux = auxiliaryData(chunks, lines);
  const tx = buildTransaction({ utxos, outputAddress: id.payment.address(network), signer: id.payment.privateKey, networkId: net.networkId, params, ttl, aux });
  const txExpect = {
    txHash: tx.hash,
    chunks,
    lines,
    recordBody: signed.body,
    maxTxSize: params.maxTxSize,
    networkId: net.networkId,
    ttl,
    params,
    inputs: tx.inputs,
    outputAddress: address,
    paymentKeyHash
  };
  return { signed, chunks, valueBytes, lines, tx, txExpect, ttl, address };
}

export function runReport({ network, name, pub, manifest, coreOnly, hashed, doc, p, params, checks, cli, extra = {} }) {
  return {
    format: 'research-freeze-run-v1',
    created: new Date().toISOString(),
    network,
    identity: name,
    signing_public_key: pub.signing_public_key,
    payment_address: p.address,
    kind: manifest.kind,
    ...extra,
    core_only: coreOnly,
    supersedes: manifest.supersedes || null,
    related: manifest.related || null,
    tx_hash: p.tx.hash,
    uri: recordUri(p.tx.hash),
    record_bytes: p.signed.body.length,
    record_top_level_keys: topLevelKeys(p.signed.body),
    label_309_chunks: p.chunks.length,
    label_309_value_bytes: p.valueBytes.length,
    message: p.lines,
    tx_size: p.tx.size,
    fee: p.tx.fee.toString(),
    ttl: p.ttl,
    tip_at_build: params.tip,
    protocol: { epoch: params.epoch, major: params.protocolMajor, minor: params.protocolMinor, min_fee_a: params.minFeeA.toString(), min_fee_b: params.minFeeB.toString(), max_tx_size: params.maxTxSize, coins_per_utxo_size: params.coinsPerUtxoByte.toString() },
    inputs: p.tx.inputs.map((u) => ({ tx_hash: u.txHash, index: u.index, coin: u.coin.toString() })),
    output_coin: p.tx.outCoin.toString(),
    items: hashed.map((h) => ({ name: h.name, sha256: h.hex, size: h.size, type: h.type || null, ids: h.ids || null, document: h.document })),
    document_checks: doc,
    checks,
    versions: versions(cli)
  };
}

export function runFiles(p, report) {
  return {
    'body.cbor': p.signed.body,
    'body-without-sigs.cbor': p.signed.bodyNoSigs,
    'sig-structure.cbor': p.signed.sigStructure,
    'cose-sign1.cbor': p.signed.coseSign1,
    'label-309-value.cbor': p.valueBytes,
    'metadata.json': JSON.stringify(detailedMetadataJson(p.chunks, p.lines), null, 2) + '\n',
    'tx.signed.cbor': p.tx.bytes,
    'tx.hash': p.tx.hash + '\n',
    'uri.txt': recordUri(p.tx.hash) + '\n',
    'expect.json': stringify({ ...p.txExpect, recordBody: undefined, chunks: p.chunks.map(toHex), inputs: p.tx.inputs }, 2) + '\n',
    'report.json': stringify(report, 2) + '\n'
  };
}

export function loadRun(dir) {
  const read = (f) => new Uint8Array(fs.readFileSync(path.join(dir, f)));
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
  const e = JSON.parse(fs.readFileSync(path.join(dir, 'expect.json'), 'utf8'));
  const body = read('body.cbor');
  const txExpect = {
    ...e,
    chunks: e.chunks.map((c) => fromHex(c)),
    recordBody: body,
    params: { minFeeA: BigInt(e.params.minFeeA), minFeeB: BigInt(e.params.minFeeB), maxTxSize: e.params.maxTxSize, coinsPerUtxoByte: BigInt(e.params.coinsPerUtxoByte) },
    inputs: e.inputs.map((u) => ({ ...u, coin: BigInt(u.coin) }))
  };
  return {
    dir,
    report,
    body,
    bodyNoSigs: read('body-without-sigs.cbor'),
    sigStructure: read('sig-structure.cbor'),
    coseSign1: read('cose-sign1.cbor'),
    txBytes: read('tx.signed.cbor'),
    txHash: fs.readFileSync(path.join(dir, 'tx.hash'), 'utf8').trim(),
    txExpect
  };
}

export function checkRun({ store, cli, dir }) {
  const run = loadRun(dir);
  const name = run.report.identity;
  let rehearsalSeed = null;
  if (name === 'rehearsal') {
    const { signingMnemonic, paymentMnemonic } = store.readMnemonics(name);
    rehearsalSeed = deriveIdentity(signingMnemonic, paymentMnemonic).signingSeed;
  }
  return checkArtifacts(
    {
      body: run.body,
      bodyNoSigs: run.bodyNoSigs,
      sigStructure: run.sigStructure,
      coseSign1: run.coseSign1,
      txBytes: run.txBytes,
      txExpect: run.txExpect,
      digests: run.report.items.map((i) => i.sha256),
      publicKeyHex: run.report.signing_public_key
    },
    { cli, store, rehearsalSeed }
  );
}
