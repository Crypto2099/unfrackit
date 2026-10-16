// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// hash, build and check: from a manifest to a run directory holding the exact
// signed transaction, written only when every offline check passes.

import fs from 'node:fs';
import path from 'node:path';
import { readManifest, recordUri } from './manifest.mjs';
import { hashItems, documentChecks } from './hashing.mjs';
import { deriveIdentity } from './keys.mjs';
import { buildRecord, signRecord, carry, messageLines, auxiliaryData, detailedMetadataJson, topLevelKeys } from './record.mjs';
import { buildTransaction, TTL_SLOTS } from './tx.mjs';
import { checkArtifacts, requireAllPass } from './checks.mjs';
import { assertNoUnresolved } from './journal.mjs';
import { networkOf } from './koios.mjs';
import { decode, mapGet } from './cbor.mjs';
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

export function hashManifest({ manifestPath, signingPublicKeyHex }) {
  const manifest = readManifest(manifestPath);
  const hashed = hashItems(manifest);
  let doc = null;
  if (manifest.kind === 'freeze') {
    doc = documentChecks(manifest, hashed, signingPublicKeyHex);
  }
  return { manifest, hashed, doc };
}

// The record a retype or amend record supersedes, from this home's own run
// directory: a retype carries every item of it with identical digests, and
// both are signed by the same key.
function checkSuperseded(store, network, manifest, hashed, publicKeyHex) {
  const dir = store.runDir(network, manifest.supersedes);
  const file = path.join(dir, 'body.cbor');
  if (!fs.existsSync(file)) throw new UserError(`the superseded record ${manifest.supersedes} has no run directory in this home (${dir}); its items and signer cannot be checked`);
  const body = decode(new Uint8Array(fs.readFileSync(file)), { canonical: true });
  const items = mapGet(body, 'items').map((it) => toHex(mapGet(mapGet(it, 'hashes'), 'sha2-256')));
  const cose = decode(mapGet(mapGet(body, 'sigs')[0], 'cose_sign1'));
  const signer = toHex(mapGet(decode(cose[0]), 4));
  if (signer !== publicKeyHex) throw new UserError(`the superseded record is signed by ${signer}, not by this identity's ${publicKeyHex}`);
  if (manifest.kind === 'retype' && items.join() !== hashed.map((h) => h.hex).join()) {
    throw new UserError('a retype record carries every item of the record it supersedes, with identical digests in the same order');
  }
  return { items, signer };
}

export async function build({ store, koios, cli, manifestPath, network, identityName, coreOnly = false, log = () => {} }) {
  const net = networkOf(network);
  const name = identityName || defaultIdentity(network);
  const pub = store.readPublic(name);
  assertIdentityNetwork(pub, network);
  assertNoUnresolved(store, network);
  if (!cli) throw new UserError('build requires the cardanowall CLI 0.12.0 for its offline checks');

  const { manifest, hashed, doc } = hashManifest({ manifestPath, signingPublicKeyHex: pub.signing_public_key });
  if (doc && !doc.ok) throw new UserError(`document checks failed:\n${doc.errors.map((e) => `  ${e}`).join('\n')}`);
  if (manifest.supersedes) checkSuperseded(store, network, manifest, hashed, pub.signing_public_key);

  await koios.guard();
  const params = await koios.params();

  const { signingMnemonic, paymentMnemonic } = store.readMnemonics(name);
  const id = deriveIdentity(signingMnemonic, paymentMnemonic);
  const address = id.payment.address(network).to_bech32();
  if (toHex(id.signing.publicKey) !== pub.signing_public_key || toHex(id.payment.keyHash) !== pub.payment_key_hash || address !== pub.addresses[network]) {
    throw new UserError(`identity "${name}": the public file does not match the keys its mnemonics derive; refusing`);
  }

  const record = buildRecord({ kind: manifest.kind, hashed, coreOnly, supersedes: manifest.supersedes, related: manifest.related });
  const signed = await signRecord(record, id.signing);
  const { chunks, valueBytes } = carry(signed.body);
  const lines = messageLines(hashed, manifest.messageItems);
  const aux = auxiliaryData(chunks, lines);

  koios.addresses.add(address);
  const utxos = await koios.addressUtxos(address);
  const ttl = params.tip.slot + TTL_SLOTS;
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
    paymentKeyHash: pub.payment_key_hash
  };
  const checks = checkArtifacts(
    {
      body: signed.body,
      bodyNoSigs: signed.bodyNoSigs,
      sigStructure: signed.sigStructure,
      coseSign1: signed.coseSign1,
      txBytes: tx.bytes,
      txExpect,
      digests: hashed.map((h) => h.hex),
      publicKeyHex: pub.signing_public_key
    },
    { cli, store, rehearsalSeed: name === 'rehearsal' ? id.signingSeed : null }
  );
  requireAllPass(checks);

  const report = {
    format: 'research-freeze-run-v1',
    created: new Date().toISOString(),
    network,
    identity: name,
    signing_public_key: pub.signing_public_key,
    payment_address: address,
    kind: manifest.kind,
    core_only: coreOnly,
    supersedes: manifest.supersedes || null,
    related: manifest.related || null,
    tx_hash: tx.hash,
    uri: recordUri(tx.hash),
    record_bytes: signed.body.length,
    record_top_level_keys: topLevelKeys(signed.body),
    label_309_chunks: chunks.length,
    label_309_value_bytes: valueBytes.length,
    message: lines,
    tx_size: tx.size,
    fee: tx.fee.toString(),
    ttl,
    tip_at_build: params.tip,
    protocol: { epoch: params.epoch, major: params.protocolMajor, minor: params.protocolMinor, min_fee_a: params.minFeeA.toString(), min_fee_b: params.minFeeB.toString(), max_tx_size: params.maxTxSize, coins_per_utxo_size: params.coinsPerUtxoByte.toString() },
    inputs: tx.inputs.map((u) => ({ tx_hash: u.txHash, index: u.index, coin: u.coin.toString() })),
    output_coin: tx.outCoin.toString(),
    items: hashed.map((h) => ({ name: h.name, sha256: h.hex, size: h.size, type: h.type || null, ids: h.ids || null, document: h.document })),
    document_checks: doc,
    checks,
    versions: versions(cli)
  };
  const dir = store.writeRun(network, tx.hash, {
    'body.cbor': signed.body,
    'body-without-sigs.cbor': signed.bodyNoSigs,
    'sig-structure.cbor': signed.sigStructure,
    'cose-sign1.cbor': signed.coseSign1,
    'label-309-value.cbor': valueBytes,
    'metadata.json': JSON.stringify(detailedMetadataJson(chunks, lines), null, 2) + '\n',
    'tx.signed.cbor': tx.bytes,
    'tx.hash': tx.hash + '\n',
    'uri.txt': recordUri(tx.hash) + '\n',
    'expect.json': stringify({ ...txExpect, recordBody: undefined, chunks: chunks.map(toHex), inputs: tx.inputs }, 2) + '\n',
    'report.json': stringify(report, 2) + '\n'
  });
  log(`run directory: ${dir}`);
  return { dir, report, tx, signed };
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
