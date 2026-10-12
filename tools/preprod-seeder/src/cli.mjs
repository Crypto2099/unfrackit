#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import { SHAPE_NAMES, SHAPE_NOTES, canonicalShape, generate } from './shapes.mjs';
import { Koios } from './koios.mjs';
import { newMnemonic, walletFromMnemonic } from './wallet.mjs';
import * as store from './store.mjs';
import { policiesFor, ownedPolicies, funderWallet, shapeWallet, dryRun, pickFunding, compareWithShape } from './ops.mjs';
import { planSeed, planSweep } from './plan.mjs';
import { fromHex, toHex } from './util.mjs';

const USAGE = `preprod-seeder: lay out preprod test wallets in fixed UTxO shapes. Preprod only.

  init                      create the home directory and the funder wallet; print its address
  shapes                    list the 17 shapes
  address <shape|funder>    print an address (every address for a multi-key shape)
  mnemonic <shape|funder>   print the 24-word mnemonic, for restoring into a preprod extension
  budget [shapes...]        dry run: transactions, tADA locked and tADA in fees; submits nothing
  seed <shape> [--no-wait]  create the shape wallet if absent, mint, and lay out its UTxOs
  verify <shape>            compare the shape wallet's UTxOs with the specification
  sweep <shape> [--no-wait] burn the tokens the tool minted, return all ADA and any other token to the funder
  reset <shape>             sweep, then seed

Secrets are kept in $PREPROD_SEEDER_HOME, else \${XDG_DATA_HOME:-$HOME/.local/share}/unfrackit-preprod-seeder.
Chain access is Koios preprod; PREPROD_SEEDER_KOIOS_URL overrides the endpoint, and the tool refuses any
endpoint that is not preprod.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s = '') => console.log(s);

function tada(lovelace) {
  const n = BigInt(lovelace);
  const whole = n / 1000000n;
  const frac = (n % 1000000n).toString().padStart(6, '0');
  return `${whole.toLocaleString('en-US')}.${frac}`;
}

async function connect() {
  const koios = new Koios();
  await koios.connect();
  const params = await koios.params();
  return { koios, params };
}

function addressesOf(who) {
  if (who === 'funder') return funderWallet().keys.map((k) => k.bech32);
  const shape = generate(who);
  return shapeWallet(shape).keys.map((k) => k.bech32);
}

function whoArg(arg) {
  if (!arg) throw new Error('name a shape or "funder"');
  return arg.toLowerCase() === 'funder' ? 'funder' : canonicalShape(arg);
}

async function cmdInit() {
  const home = store.ensureHome();
  if (!store.hasMnemonic('funder')) store.writeMnemonic('funder', newMnemonic());
  const w = funderWallet();
  say(`Home: ${home}`);
  say('Fund this preprod address from your own testnet wallet or the preprod faucet:');
  say(w.keys[0].bech32);
}

function cmdShapes() {
  for (const n of SHAPE_NAMES) say(`${n.padEnd(4)} ${SHAPE_NOTES[n]}`);
}

function cmdAddress(arg) {
  for (const a of addressesOf(whoArg(arg))) say(a);
}

function cmdMnemonic(arg) {
  const who = whoArg(arg);
  console.error('PREPROD ONLY: this mnemonic controls test funds with no value. Never restore it into a mainnet wallet.');
  say(store.readMnemonic(who));
}

async function cmdBudget(args) {
  const names = args.length ? args.map(canonicalShape) : SHAPE_NAMES;
  const { params } = await connect();
  say(`Protocol parameters from epoch ${params.epoch}: max tx ${params.maxTxSize} bytes, max value ${params.maxValSize} bytes, ${params.coinsPerUtxoByte} lovelace per UTxO byte.`);
  say();
  const rows = [['Shape', 'UTxOs', 'Txs', 'tADA locked', 'tADA fees', 'Max tx bytes', 'Max value bytes']];
  let txs = 0;
  let locked = 0n;
  let fees = 0n;
  for (const n of names) {
    const { shape, plan } = dryRun(n, params);
    rows.push([n, String(plan.outputs), String(plan.txs.length), tada(plan.locked), tada(plan.fees), String(plan.maxTxSize), String(plan.maxValueBytes)]);
    txs += plan.txs.length;
    locked += plan.locked;
    fees += plan.fees;
    if (shape.utxos.length !== plan.outputs) throw new Error(`${n}: plan covers ${plan.outputs} of ${shape.utxos.length} UTxOs`);
  }
  if (names.length > 1) rows.push(['Total', '', String(txs), tada(locked), tada(fees), '', '']);
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  for (const r of rows) say(r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join('  '));
  say();
  say('Every transaction is within the maximum size, every output within the maximum value size and above its minimum coin. Nothing was submitted.');
}

async function waitFor(koios, hashes, label) {
  const deadline = Date.now() + 45 * 60 * 1000;
  for (;;) {
    const st = await koios.status(hashes);
    const done = hashes.filter((h) => (st.get(h) ?? 0) >= 1).length;
    process.stderr.write(`\r${label}: ${done}/${hashes.length} transactions confirmed   `);
    if (done === hashes.length) {
      process.stderr.write('\n');
      return;
    }
    if (Date.now() > deadline) throw new Error(`${label}: timed out waiting for confirmation`);
    await sleep(20000);
  }
}

// Submit in order. A transaction that spends an unconfirmed output can be
// refused while its parent is still propagating, so that case is retried.
// A resubmission of a transaction the node already holds (after a lost
// response, or on resuming a journal) is refused because its inputs are
// spent; only the journal's own transactions spend these inputs, so that
// refusal counts as submitted, and the confirmation wait or `verify` that
// follows shows whether it landed.
async function submitAll(koios, txs) {
  const st = await koios.status(txs.map((t) => t.hash));
  for (let i = 0; i < txs.length; i++) {
    const t = txs[i];
    if (st.get(t.hash) !== null && st.get(t.hash) !== undefined) continue;
    for (let attempt = 0; ; attempt++) {
      try {
        const id = await koios.submit(fromHex(t.cbor));
        if (id !== t.hash) throw new Error(`submitted ${t.hash} but the node returned ${id}`);
        break;
      } catch (e) {
        if (/All inputs are spent|already been included/i.test(e.message)) break;
        if (attempt < 6 && /BadInputs|UTxO|unknown|not found/i.test(e.message)) await sleep(5000);
        else throw e;
      }
    }
    process.stderr.write(`\rsubmitted ${i + 1}/${txs.length}   `);
  }
  process.stderr.write('\n');
}

async function cmdSeed(arg, flags) {
  const name = canonicalShape(arg);
  const { koios, params } = await connect();
  const shape = generate(name);
  if (!store.hasMnemonic('funder')) throw new Error('no funder wallet; run "init" first');
  if (!store.hasMnemonic(name)) store.writeMnemonic(name, newMnemonic());
  const funder = funderWallet();
  const sw = shapeWallet(shape);
  const policyOf = policiesFor(funder.root, name, shape.policies);

  let journal = store.readJournal(name);
  if (!journal) {
    const held = await koios.utxos(sw.keys.map((k) => k.bech32));
    if (held.length) {
      throw new Error(`the ${name} wallet already holds ${held.length} UTxOs; run "verify ${name}", or "sweep ${name}" to start over`);
    }
    const { plan: estimate } = dryRun(name, params);
    const need = estimate.locked + estimate.fees + estimate.minPure + 2000000n;
    const have = await koios.utxos([funder.keys[0].bech32]);
    const pick = pickFunding(have, need);
    if (pick.short) {
      throw new Error(`the funder needs ${tada(need)} tADA of pure-ADA UTxOs and holds ${tada(pick.total)}; send at least ${tada(pick.short)} more to ${funder.keys[0].bech32}`);
    }
    const plan = planSeed({
      shape,
      policyOf,
      shapeKeys: sw.keys,
      funder: { address: funder.keys[0].address, sk: funder.keys[0].sk },
      funding: pick.picked.map((u) => ({ txHash: u.txHash, index: u.index, coin: u.coin })),
      params
    });
    journal = { shape: name, txs: plan.txs.map((t) => ({ hash: t.hash, cbor: toHex(t.bytes) })) };
    store.writeJournal(name, journal);
    say(`${name}: ${plan.txs.length} transactions, ${tada(plan.locked)} tADA laid out, ${tada(plan.fees)} tADA in fees.`);
  } else {
    say(`${name}: resuming an interrupted seed (${journal.txs.length} transactions).`);
  }
  await submitAll(koios, journal.txs);
  if (flags.has('--no-wait')) {
    say('Submitted. Run "verify" once the transactions have confirmed.');
    return;
  }
  await waitFor(koios, journal.txs.map((t) => t.hash), name);
  store.removeJournal(name);
  say(`${name} seeded. Addresses:`);
  for (const k of sw.keys) say(k.bech32);
}

async function cmdVerify(arg) {
  const name = canonicalShape(arg);
  const { koios } = await connect();
  const shape = generate(name);
  const funder = funderWallet();
  const sw = shapeWallet(shape);
  const policyOf = policiesFor(funder.root, name, shape.policies);
  const actual = await koios.utxos(sw.keys.map((k) => k.bech32));
  const r = compareWithShape(shape, policyOf, sw.keys, actual);
  say(`${name}: specified ${r.expectedCount} UTxOs, found ${r.actualCount}.`);
  if (r.ok) {
    say('The wallet matches the specification.');
    return 0;
  }
  say(`${r.missing.reduce((s, [, n]) => s + n, 0)} specified UTxOs are missing, ${r.unexpected.reduce((s, [, n]) => s + n, 0)} found UTxOs are not in the specification, ${r.stray} are at unknown addresses or carry an unknown datum.`);
  for (const [k, n] of r.missing.slice(0, 5)) say(`  missing x${n}: ${k.slice(0, 160)}`);
  for (const [k, n] of r.unexpected.slice(0, 5)) say(`  unexpected x${n}: ${k.slice(0, 160)}`);
  return 1;
}

async function cmdSweep(arg, flags) {
  const name = canonicalShape(arg);
  const { koios, params } = await connect();
  const shape = generate(name);
  const funder = funderWallet();
  const sw = shapeWallet(shape);
  const held = await koios.utxos(sw.keys.map((k) => k.bech32));
  if (!held.length) {
    say(`${name} holds nothing.`);
    return;
  }
  const plan = planSweep({
    utxos: held,
    signerOf: new Map(sw.keys.map((k) => [k.bech32, k.sk])),
    funderAddr: funder.keys[0].address,
    params,
    owned: ownedPolicies(funder.root)
  });
  say(`${name}: sweeping ${held.length} UTxOs in ${plan.txs.length} transactions, ${tada(plan.fees)} tADA in fees. Tokens under the tool's own policies are burned; all ADA and any other token go to the funder.`);
  const txs = plan.txs.map((t) => ({ hash: t.hash, cbor: toHex(t.bytes) }));
  await submitAll(koios, txs);
  if (flags.has('--no-wait')) return;
  await waitFor(koios, txs.map((t) => t.hash), name);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const args = rest.filter((a) => !a.startsWith('--'));
  switch (cmd) {
    case 'init':
      return cmdInit();
    case 'shapes':
      return cmdShapes();
    case 'address':
      return cmdAddress(args[0]);
    case 'mnemonic':
      return cmdMnemonic(args[0]);
    case 'budget':
      return cmdBudget(args);
    case 'seed':
      return cmdSeed(args[0], flags);
    case 'verify':
      process.exitCode = await cmdVerify(args[0]);
      return;
    case 'sweep':
      return cmdSweep(args[0], flags);
    case 'reset':
      await cmdSweep(args[0], flags);
      return cmdSeed(args[0], flags);
    default:
      say(USAGE);
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
