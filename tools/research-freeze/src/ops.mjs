// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The chain-facing operations shared by the commands and the rehearsal.

import fs from 'node:fs';
import path from 'node:path';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { Koios, networkOf } from './koios.mjs';
import { journal, journalEntry, journalEntries, submitJournaled, waitConfirmed, abandon, assertNoUnresolved } from './journal.mjs';
import { loadRun, assertIdentityNetwork, defaultIdentity } from './build.mjs';
import { verifyAll } from './verify.mjs';
import { confirmMainnet } from './tty.mjs';
import { deriveIdentity } from './keys.mjs';
import { TTL_SLOTS, feeFor, assertTransaction, assertSweep } from './tx.mjs';
import { stringify, tada, toHex, UserError } from './util.mjs';

export function koiosFor(store, network, { addresses = [], log } = {}) {
  return new Koios(network, { own: { addresses, txHashes: store.knownTxHashes(network) }, log });
}

// `<run>` is a run directory or a transaction hash with a run directory in
// this home.
export function resolveRun(store, arg) {
  if (/^[0-9a-f]{64}$/.test(arg)) {
    for (const network of ['mainnet', 'preprod']) {
      const d = store.runDir(network, arg);
      if (fs.existsSync(path.join(d, 'report.json'))) return d;
    }
    throw new UserError(`no run directory for ${arg} in ${store.home}`);
  }
  const d = path.resolve(arg);
  if (!fs.existsSync(path.join(d, 'report.json'))) throw new UserError(`${d} is not a run directory`);
  return d;
}

// What the operator sees above the mainnet prompt.
export function submissionFacts(run) {
  const r = run.report;
  return [
    ['network', r.network],
    ['record kind', r.kind],
    ['stage', r.stage || 'none'],
    ['research-items', r.core_only ? 'omitted (core-only)' : 'present (typed)'],
    ['items', String(r.items.length)],
    ['CIP-20 line', (r.message || []).join(', ')],
    ['signing key', r.signing_public_key],
    ['fee', `${tada(r.fee)} ADA`],
    ['inputs', `${r.inputs.length} UTxOs, ${tada(r.inputs.reduce((s, u) => s + BigInt(u.coin), 0n))} ADA`],
    ['change', `${tada(r.output_coin)} ADA to ${r.payment_address}`],
    ['TTL', `slot ${r.ttl}`]
  ];
}

export async function submitRun({ store, dir, log = console.error, streams, koios: givenKoios }) {
  const run = loadRun(dir);
  // The bytes about to be sent are the bytes the build checked: every
  // post-build assertion runs again on them first.
  assertTransaction(run.txBytes, run.txExpect);
  const network = run.report.network;
  const koios = givenKoios || koiosFor(store, network, { addresses: [run.report.payment_address] });
  koios.allowTx(run.txHash);
  await koios.guard();
  if (network === 'mainnet') await confirmMainnet(run.txHash, 'submission', streams, submissionFacts(run));
  const entry = journal(
    store,
    journalEntry({
      network,
      txHash: run.txHash,
      cbor: toHex(run.txBytes),
      ttl: run.report.ttl,
      inputs: run.report.inputs.map((u) => ({ txHash: u.tx_hash, index: u.index, coin: u.coin })),
      run: dir,
      kind: run.report.kind,
      stage: run.report.stage || null,
      identity: run.report.identity,
      signingPublicKey: run.report.signing_public_key
    })
  );
  const tip = await koios.tip();
  if (entry.state === 'unsubmitted' && tip.slot > entry.ttl) throw new UserError(`the TTL of ${run.txHash} (slot ${entry.ttl}) has passed (tip slot ${tip.slot}); abandon it and build again`);
  const r = await submitJournaled({ koios, store, entry, address: run.report.payment_address, log });
  log(`${run.txHash}: ${r.outcome}`);
  return r;
}

// Works for record runs and sweep runs alike: it needs only the report and
// the transaction hash.
export async function waitRun({ store, dir, log = console.error }) {
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
  const txHash = fs.readFileSync(path.join(dir, 'tx.hash'), 'utf8').trim();
  const network = report.network;
  const koios = koiosFor(store, network, { addresses: [report.payment_address] });
  koios.allowTx(txHash);
  await koios.guard();
  const j = store.readJournal(network);
  const entry = j.current && j.current.txHash === txHash ? j.current : { network, txHash, state: 'confirmed' };
  const facts = await waitConfirmed({ koios, store, entry, log });
  store.updateRunFile(dir, 'report.json', stringify({ ...report, confirmed: facts }, 2) + '\n');
  return facts;
}

export async function verifyRun({ store, cli, arg, network, identityName, log = console.error, koios: givenKoios }) {
  let dir = null;
  let txHash = arg;
  if (!/^[0-9a-f]{64}$/.test(arg)) {
    dir = resolveRun(store, arg);
  } else if (fs.existsSync(path.join(store.runDir(network, arg), 'report.json'))) {
    dir = store.runDir(network, arg);
  }
  let expectedBody = null;
  let expectedSigner = null;
  let address = [];
  if (dir) {
    const run = loadRun(dir);
    txHash = run.txHash;
    expectedBody = run.body;
    expectedSigner = run.report.signing_public_key;
    if (run.report.network !== network) throw new UserError(`${txHash} is a ${run.report.network} run, not ${network}`);
    address = [run.report.payment_address];
  }
  if (!store.knownTxHashes(network).has(txHash)) throw new UserError(`refusing to verify ${txHash}: it is not one of this home's own ${network} transactions`);
  if (!expectedSigner) {
    // No run directory: the journal says which key built it, else the identity.
    const entry = journalEntries(store, network).find((e) => e.txHash === txHash);
    expectedSigner = entry?.signing_public_key || store.readPublic(identityName || defaultIdentity(network)).signing_public_key;
  }
  const koios = givenKoios || koiosFor(store, network, { addresses: address });
  koios.allowTx(txHash);
  await koios.guard();
  const result = await verifyAll({ koios, cli, network, txHash, expectedBody, expectedSigner });
  if (dir) {
    const run = loadRun(dir);
    store.updateRunFile(dir, 'report.json', stringify({ ...run.report, verified: { at: new Date().toISOString(), ...result } }, 2) + '\n');
  }
  log(`verified ${txHash}`);
  return result;
}

export async function abandonJournal({ store, network, identityName }) {
  const name = identityName || defaultIdentity(network);
  const pub = store.readPublic(name);
  const koios = koiosFor(store, network, { addresses: [pub.addresses[network]] });
  await koios.guard();
  return abandon({ koios, store, network, address: pub.addresses[network] });
}

// Return every pure-ADA UTxO of the payment address to `to`: one output, no
// change, no metadata. Same journal and mainnet guard as `submit`.
export async function sweep({ store, network, identityName, to, log = console.error, streams, koios: givenKoios }) {
  const net = networkOf(network);
  const name = identityName || defaultIdentity(network);
  const pub = store.readPublic(name);
  assertIdentityNetwork(pub, network);
  assertNoUnresolved(store, network);
  let target;
  try {
    target = CSL.Address.from_bech32(to);
  } catch {
    throw new UserError(`not a bech32 address: ${to}`);
  }
  if (target.network_id() !== net.networkId) throw new UserError(`${to} is not a ${network} address`);
  const koios = givenKoios || koiosFor(store, network, { addresses: [pub.addresses[network]] });
  await koios.guard();
  const params = await koios.params();
  const { signingMnemonic, paymentMnemonic } = store.readMnemonics(name);
  const id = deriveIdentity(signingMnemonic, paymentMnemonic);
  if (id.payment.address(network).to_bech32() !== pub.addresses[network]) throw new UserError('the public file does not match the payment mnemonic');
  const utxos = await koios.addressUtxos(pub.addresses[network]);
  const ttl = params.tip.slot + TTL_SLOTS;
  const tx = buildSweep({ utxos, target, signer: id.payment.privateKey, networkId: net.networkId, params, ttl });
  // The same kind of post-build assertions as a record transaction, on the
  // exact bytes, before anything is written or shown for confirmation.
  assertSweep(tx.bytes, { txHash: tx.hash, maxTxSize: params.maxTxSize, networkId: net.networkId, ttl, params, inputs: tx.inputs, outputAddress: to, paymentKeyHash: pub.payment_key_hash });
  log(`sweep ${tx.hash}: ${tx.inputs.length} UTxOs, ${tada(tx.outCoin)} ADA to ${to}, fee ${tada(tx.fee)}`);
  const dir = store.writeRun(network, tx.hash, {
    'tx.signed.cbor': tx.bytes,
    'tx.hash': tx.hash + '\n',
    'report.json': stringify({ format: 'research-freeze-sweep-v1', network, identity: name, payment_address: pub.addresses[network], to, tx_hash: tx.hash, fee: tx.fee, ttl, inputs: tx.inputs.map((u) => ({ tx_hash: u.txHash, index: u.index, coin: u.coin })), output_coin: tx.outCoin }, 2) + '\n'
  });
  koios.allowTx(tx.hash);
  if (network === 'mainnet') {
    await confirmMainnet(tx.hash, 'sweep', streams, [
      ['network', network],
      ['from', pub.addresses[network]],
      ['to', to],
      ['amount', `${tada(tx.outCoin)} ADA`],
      ['fee', `${tada(tx.fee)} ADA`],
      ['inputs', `${tx.inputs.length} UTxOs`],
      ['TTL', `slot ${ttl}`]
    ]);
  }
  const entry = journal(store, journalEntry({ network, txHash: tx.hash, cbor: toHex(tx.bytes), ttl, inputs: tx.inputs, run: dir, kind: 'sweep', identity: name }));
  return submitJournaled({ koios, store, entry, address: pub.addresses[network], log });
}

export function buildSweep({ utxos, target, signer, networkId, params, ttl }) {
  const pure = utxos.filter((u) => !u.assets.length && !u.datumBytes && !u.datumHash && !u.refScript);
  if (!pure.length) throw new UserError('nothing to sweep: the payment address holds no pure-ADA UTxO');
  const total = pure.reduce((s, u) => s + u.coin, 0n);
  let fee = 200000n;
  for (let i = 0; i < 10; i++) {
    const ins = CSL.TransactionInputs.new();
    for (const u of pure) ins.add(CSL.TransactionInput.new(CSL.TransactionHash.from_hex(u.txHash), u.index));
    const outs = CSL.TransactionOutputs.new();
    const output = CSL.TransactionOutput.new(target, CSL.Value.new(CSL.BigNum.from_str((total - fee).toString())));
    outs.add(output);
    const body = CSL.TransactionBody.new_tx_body(ins, outs, CSL.BigNum.from_str(fee.toString()));
    body.set_ttl(CSL.BigNum.from_str(String(ttl)));
    body.set_network_id(networkId === 1 ? CSL.NetworkId.mainnet() : CSL.NetworkId.testnet());
    const hash = CSL.FixedTransaction.new_from_body_bytes(body.to_bytes()).transaction_hash();
    const vkeys = CSL.Vkeywitnesses.new();
    vkeys.add(CSL.make_vkey_witness(hash, signer));
    const ws = CSL.TransactionWitnessSet.new();
    ws.set_vkeys(vkeys);
    const bytes = CSL.Transaction.new(body, ws).to_bytes();
    const need = feeFor(params, bytes.length);
    if (need === fee) {
      const minAda = BigInt(CSL.min_ada_for_output(output, CSL.DataCost.new_coins_per_byte(CSL.BigNum.from_str(params.coinsPerUtxoByte.toString()))).to_str());
      if (total - fee < minAda) throw new UserError(`the swept output would fall below its minimum ADA of ${minAda} lovelace`);
      return { bytes, hash: toHex(hash.to_bytes()), fee, inputs: pure, outCoin: total - fee };
    }
    fee = need;
  }
  throw new Error('fee did not settle');
}
