// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The chain-facing operations shared by the commands and the rehearsal.

import fs from 'node:fs';
import path from 'node:path';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { Koios, networkOf } from './koios.mjs';
import { journal, journalEntry, journalEntries, submitJournaled, waitConfirmed, abandon, assertNoUnresolved, assertNoOtherFinal } from './journal.mjs';
import { unknownRecordsOnChain } from './targets.mjs';
import { loadRun, assertIdentityNetwork, defaultIdentity } from './build.mjs';
import { verifyAll, crossCheck, verifyDrawPlan } from './verify.mjs';
import { blockfrostFor, tokenFileName } from './blockfrost.mjs';
import { koiosBlockFacts, blockfrostBlockFacts, differences, describeDifferences, genesisDifferences, planFrom, BLOCK_FIELDS, PLAN_FIELDS } from './draw.mjs';
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

export async function submitRun({ store, dir, log = console.error, streams, koios: givenKoios, blockfrost: givenBlockfrost }) {
  const run = loadRun(dir);
  // The bytes about to be sent are the bytes the build checked: every
  // post-build assertion runs again on them first.
  assertTransaction(run.txBytes, run.txExpect);
  const network = run.report.network;
  const finalOnMainnet = network === 'mainnet' && run.report.stage === 'final';
  // The draw is keyed to one final freeze: on mainnet a second one is refused
  // once another is journaled (an abandoned one does not count). This early
  // refusal saves a prompt; `journal` checks again under the lock, right
  // before sending.
  if (finalOnMainnet) assertNoOtherFinal(journalEntries(store, network), network, run.txHash);
  const bf = givenBlockfrost !== undefined ? givenBlockfrost : finalOnMainnet ? blockfrostFor(store, network, { own: { addresses: [run.report.payment_address] } }) : null;
  if (finalOnMainnet && !bf) throw new UserError(`a mainnet final freeze is submitted only after its payment address's history is read from Koios and Blockfrost; save the mainnet project id as secrets/${tokenFileName('mainnet')}`);
  const koios = givenKoios || koiosFor(store, network, { addresses: [run.report.payment_address] });
  koios.allowTx(run.txHash);
  await koios.guard();
  if (finalOnMainnet) {
    // The journal knows only what this home sent. The chain knows every
    // record this identity paid for, so a final freeze sent from a lost home
    // shows up there.
    await bf.guard();
    const { found, replays } = await unknownRecordsOnChain({ store, koios, bf, network, address: run.report.payment_address, publicKeyHex: run.report.signing_public_key, paymentKeyHash: run.txExpect.paymentKeyHash, exclude: [run.txHash, run.report.hypotheses_record].filter(Boolean) });
    for (const h of replays) log(`${h} carries a record signed by this key in a transaction this identity did not pay for (a replay); it does not count`);
    if (found.length) {
      throw new UserError(`refusing a final freeze: the payment address's history holds transactions this home's journal does not know:\n${found.map((f) => `  ${f.tx_hash}: ${f.reason}`).join('\n')}\nOne of them may be a final freeze sent from a lost home.`);
    }
  }
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
// the transaction hash. For a final-stage freeze it also records the draw
// plan (E, the freeze block's slot, the cutoff slot and N) as Koios reports
// the facts it rests on; `verify` and `drawkey` read them again from Koios and
// Blockfrost and fail on any difference.
export async function waitRun({ store, dir, log = console.error, koios: givenKoios, waitOptions = {} }) {
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
  const txHash = fs.readFileSync(path.join(dir, 'tx.hash'), 'utf8').trim();
  const network = report.network;
  const koios = givenKoios || koiosFor(store, network, { addresses: [report.payment_address] });
  koios.allowTx(txHash);
  await koios.guard();
  const j = store.readJournal(network);
  const entry = j.current && j.current.txHash === txHash ? j.current : { network, txHash, state: 'confirmed' };
  const facts = await waitConfirmed({ koios, store, entry, log, ...waitOptions });
  // What `wait` recorded is what `verify` and `drawkey` compare against, so a
  // second `wait` never replaces it: facts that differ from the recorded ones
  // are refused, and equal ones leave the record as it was.
  const recordedBlock = (c) => ({ block_hash: c.block_hash, block_height: c.block_height, slot: c.absolute_slot, epoch: c.epoch, epoch_slot: c.epoch_slot, block_time: c.block_time });
  if (report.confirmed) {
    const d = differences(recordedBlock(facts), recordedBlock(report.confirmed), BLOCK_FIELDS.filter((f) => recordedBlock(report.confirmed)[f] !== undefined));
    if (d.length) throw new UserError(`wait already recorded other block facts for ${txHash}: ${describeDifferences(d, 'now', 'recorded')}; not replacing them (verify and drawkey will fail on the difference)`);
  } else {
    // Written before the plan, so a plan that cannot be computed does not
    // lose the confirmation.
    store.updateRunFile(dir, 'report.json', stringify({ ...report, confirmed: facts }, 2) + '\n');
  }
  const current = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
  let draw = current.draw || null;
  if (report.stage === 'final') {
    const genesis = await koios.genesis();
    const params = await koios.epochParams(facts.epoch);
    const blockFacts = { slot: facts.absolute_slot, epoch: facts.epoch, epoch_slot: facts.epoch_slot };
    const plan = { ...planFrom(genesis, blockFacts, Number(params?.protocol_major)), sources: ['koios'], cross_checked: false, recorded_by: 'wait', at: new Date().toISOString() };
    if (draw) {
      const d = differences(plan, draw, PLAN_FIELDS);
      if (d.length) throw new UserError(`wait already recorded another draw plan for ${txHash}: ${describeDifferences(d, 'now', 'recorded')}; not replacing it`);
    } else {
      draw = plan;
      store.updateRunFile(dir, 'report.json', stringify({ ...current, draw }, 2) + '\n');
    }
  }
  return { ...(current.confirmed || facts), stage: report.stage || null, draw };
}

// Whether verify needs Blockfrost: on mainnet always, because chain facts
// there are load-bearing (CIP-190 "Chain facts": a deployment for which they
// are load-bearing MUST cross-check them across independent explorers).
function blockfrostForVerify(store, network, given) {
  if (given !== undefined) return given;
  const bf = blockfrostFor(store, network);
  if (!bf && network === 'mainnet') {
    throw new UserError(`verify on mainnet cross-checks every chain fact with Blockfrost; save the mainnet project id as secrets/${tokenFileName('mainnet')} (mode 0600) in the home`);
  }
  return bf;
}

export async function verifyRun({ store, cli, arg, network, identityName, log = console.error, koios: givenKoios, blockfrost: givenBlockfrost, sdkImpl }) {
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
  let report = null;
  if (dir) {
    const run = loadRun(dir);
    txHash = run.txHash;
    report = run.report;
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
  const bf = blockfrostForVerify(store, network, givenBlockfrost);
  const koios = givenKoios || koiosFor(store, network, { addresses: address });
  koios.allowTx(txHash);
  await koios.guard();
  const result = await verifyAll({ koios, cli, network, txHash, expectedBody, expectedSigner, ...(sdkImpl ? { sdkImpl } : {}) });
  result.stage = report?.stage || null;
  result.crosscheck = bf ? await crossCheck({ koios, bf, txHash }) : { ran: false, ok: null, reason: `no Blockfrost project id for ${network} (secrets/${tokenFileName(network)})` };
  const issues = [];
  if (result.crosscheck.ran && !result.crosscheck.ok) issues.push(...result.crosscheck.issues);
  // The facts `wait` recorded from Koios alone must equal what both providers
  // report now.
  const now = result.crosscheck.koios || (result.own.block ? { block_hash: result.own.block.hash, block_height: result.own.block.height, slot: result.own.block.slot, epoch: result.own.block.epoch, epoch_slot: result.own.block.epoch_slot, block_time: result.own.block.time } : null);
  if (report?.confirmed && now) {
    const recorded = { block_hash: report.confirmed.block_hash, block_height: report.confirmed.block_height, slot: report.confirmed.absolute_slot, epoch: report.confirmed.epoch, epoch_slot: report.confirmed.epoch_slot, block_time: report.confirmed.block_time };
    const d = differences(now, recorded, BLOCK_FIELDS.filter((f) => recorded[f] !== undefined));
    if (d.length) issues.push(`the block facts differ from those "wait" recorded: ${describeDifferences(d, 'now', 'recorded')}`);
  }
  if (report?.stage === 'final' && now) {
    result.draw = await verifyDrawPlan({ koios, bf, facts: now, bfFacts: result.crosscheck.blockfrost, recorded: report.draw });
    issues.push(...result.draw.issues);
  }
  result.issues = issues;
  const verifiers = [result.own.verdict, result.sdk.verdict, result.cli.verdict];
  result.verdict = verifiers.every((v) => v === 'valid') && issues.length === 0 ? 'valid' : verifiers.includes('failed') || issues.length ? 'failed' : 'not valid';
  if (dir) {
    const run = loadRun(dir);
    store.updateRunFile(dir, 'report.json', stringify({ ...run.report, verified: { at: new Date().toISOString(), ...result } }, 2) + '\n');
  }
  log(`verified ${txHash}: ${result.verdict}`);
  return result;
}

// The draw key of a final-stage freeze: the nonce of epoch N, read from Koios
// and from Blockfrost once N has started. Both providers must agree on the
// genesis parameters, the freeze block, the plan (which must also equal the
// recorded one), and the nonce; the freeze block must be at least k blocks
// deep on both. Any disagreement or absence fails. Both readings, with their
// times, go into the run directory's drawkey.json, which is never
// overwritten.
export async function drawKey({ store, dir, log = console.error, koios: givenKoios, blockfrost: givenBlockfrost, now = () => new Date() }) {
  const run = loadRun(dir);
  const r = run.report;
  if (r.stage !== 'final') throw new UserError(`drawkey runs on the final-stage freeze only; ${run.txHash} is ${r.stage ? `stage ${r.stage}` : 'not a staged freeze'}`);
  const network = r.network;
  const bf = givenBlockfrost !== undefined ? givenBlockfrost : blockfrostFor(store, network);
  if (!bf) throw new UserError(`drawkey reads the nonce from Koios and from Blockfrost; save the ${network} project id as secrets/${tokenFileName(network)} (mode 0600) in the home`);
  const koios = givenKoios || koiosFor(store, network, { addresses: [r.payment_address] });
  koios.allowTx(run.txHash);
  bf.allowTx(run.txHash);
  await koios.guard();
  await bf.guard();
  const fail = (msg) => {
    throw new UserError(`drawkey: ${msg}`);
  };

  const gK = await koios.genesis();
  const gB = await bf.genesis();
  const gd = genesisDifferences(gK, gB);
  if (gd.length) fail(`the genesis parameters differ: ${describeDifferences(gd, 'Koios', 'Blockfrost')}`);
  const fK = await koiosBlockFacts(koios, run.txHash);
  const fB = await blockfrostBlockFacts(bf, run.txHash);
  if (!fK || !fB) fail(`the freeze block is missing: Koios ${fK ? 'has it' : 'has no block'}, Blockfrost ${fB ? 'has it' : 'has no block'}`);
  const bd = differences(fK, fB, BLOCK_FIELDS);
  if (bd.length) fail(`the freeze block differs: ${describeDifferences(bd, 'Koios', 'Blockfrost')}`);
  const pK = await koios.epochParams(fK.epoch);
  const pB = await bf.epochParams(fB.epoch);
  const plan = planFrom(gK, fK, Number(pK?.protocol_major));
  const planB = planFrom(gB, fB, Number(pB?.protocol_major_ver));
  const pd = differences(plan, planB, PLAN_FIELDS);
  if (pd.length) fail(`the draw plan differs: ${describeDifferences(pd, 'Koios', 'Blockfrost')}`);
  if (r.draw) {
    const rd = differences(plan, r.draw, PLAN_FIELDS);
    if (rd.length) fail(`the draw plan differs from the recorded one: ${describeDifferences(rd, 'now', 'recorded')}`);
  }
  const N = plan.nonce_epoch;

  const tK = await koios.tip();
  const tB = await bf.latestBlock();
  const depth = { koios: tK.height - fK.block_height + 1, blockfrost: Number(tB.height) - fB.block_height + 1 };
  // A rollback reaches at most k blocks back, so a block is immutable once
  // more than k blocks deep.
  if (depth.koios <= gK.securityParam || depth.blockfrost <= gK.securityParam) {
    fail(`the freeze block is ${depth.koios} blocks deep on Koios and ${depth.blockfrost} on Blockfrost; the draw key waits for depth k + 1 = ${gK.securityParam + 1}`);
  }
  if (tK.epoch < N || Number(tB.epoch) < N) {
    fail(`epoch ${N} has not started (Koios is at epoch ${tK.epoch}, Blockfrost at ${tB.epoch}); it starts at slot ${plan.nonce_epoch_first_slot}`);
  }

  const atK = now().toISOString();
  const nK = await koios.epochParams(N);
  const atB = now().toISOString();
  const nB = await bf.epochParams(N);
  const nonceK = typeof nK?.nonce === 'string' ? nK.nonce.toLowerCase() : null;
  const nonceB = typeof nB?.nonce === 'string' ? nB.nonce.toLowerCase() : null;
  if (!nonceK || !nonceB) fail(`the nonce of epoch ${N} is absent: Koios ${nonceK ? 'has it' : 'has none'}, Blockfrost ${nonceB ? 'has it' : 'has none'}`);
  if (!/^[0-9a-f]{64}$/.test(nonceK) || !/^[0-9a-f]{64}$/.test(nonceB)) fail(`the nonce of epoch ${N} is not 32 bytes of hex: Koios ${nonceK}, Blockfrost ${nonceB}`);
  if (nonceK !== nonceB) fail(`the nonce of epoch ${N} differs: Koios ${nonceK}, Blockfrost ${nonceB}`);
  if (Number(nK.epoch_no) !== N || Number(nB.epoch) !== N) fail(`the parameters returned are for epoch ${nK.epoch_no} (Koios) and ${nB.epoch} (Blockfrost), not ${N}`);

  const record = {
    format: 'research-freeze-drawkey-v1',
    network,
    tx_hash: run.txHash,
    uri: r.uri,
    stage: r.stage,
    nonce_epoch: N,
    nonce: nonceK,
    plan: { ...plan, sources: ['koios', 'blockfrost'] },
    block: fK,
    depth,
    readings: [
      { source: 'koios', request: `GET ${koios.base}/epoch_params?_epoch_no=${N}`, at: atK, epoch: Number(nK.epoch_no), nonce: nonceK, tip: tK },
      { source: 'blockfrost', request: `GET ${bf.base}/epochs/${N}/parameters`, at: atB, epoch: Number(nB.epoch), nonce: nonceB, tip: { height: Number(tB.height), slot: Number(tB.slot), epoch: Number(tB.epoch), hash: tB.hash } }
    ]
  };
  const file = path.join(dir, 'drawkey.json');
  if (fs.existsSync(file)) {
    const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (prior.nonce !== nonceK || prior.nonce_epoch !== N) fail(`drawkey.json already records the nonce ${prior.nonce} of epoch ${prior.nonce_epoch}, and both providers now read ${nonceK} for epoch ${N}`);
    log(`drawkey.json already records this nonce; both providers read it again unchanged`);
    return { ...prior, rechecked: record.readings };
  }
  store.addRunFile(dir, 'drawkey.json', stringify(record, 2) + '\n');
  store.updateRunFile(dir, 'report.json', stringify({ ...loadRun(dir).report, drawkey: { nonce_epoch: N, nonce: nonceK, file: 'drawkey.json', at: atB } }, 2) + '\n');
  log(`draw key of ${run.txHash}: the nonce of epoch ${N} is ${nonceK} (Koios and Blockfrost agree)`);
  return record;
}

export async function abandonJournal({ store, network, identityName, koios: givenKoios, blockfrost: givenBlockfrost }) {
  const name = identityName || defaultIdentity(network);
  const pub = store.readPublic(name);
  const koios = givenKoios || koiosFor(store, network, { addresses: [pub.addresses[network]] });
  // On mainnet the second provider must also not know the hash.
  const bf = givenBlockfrost !== undefined ? givenBlockfrost : blockfrostFor(store, network);
  if (!bf && network === 'mainnet') throw new UserError(`abandon on mainnet asks Blockfrost too; save the mainnet project id as secrets/${tokenFileName('mainnet')}`);
  await koios.guard();
  if (bf) await bf.guard();
  return abandon({ koios, store, network, address: pub.addresses[network], bf });
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
