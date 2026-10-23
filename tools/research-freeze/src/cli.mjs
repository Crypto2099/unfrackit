#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import { Store } from './store.mjs';
import { newMnemonicPair, deriveIdentity, publicFacts } from './keys.mjs';
import { hashManifest, build, rebuild, checkRun, defaultIdentity } from './build.mjs';
import { requireAllPass } from './checks.mjs';
import { Cardanowall } from './cardanowall.mjs';
import { koiosFor, resolveRun, submitRun, waitRun, verifyRun, drawKey, abandonJournal, sweep } from './ops.mjs';
import { rehearse } from './rehearse.mjs';
import { restoreIdentity } from './restore.mjs';
import { dataciteCheck, ZenodoSandbox } from './registry.mjs';
import { requireTty } from './tty.mjs';
import { blockfrostFor } from './blockfrost.mjs';
import { networkOf } from './koios.mjs';
import { stringify, tada, UserError } from './util.mjs';

const USAGE = `research-freeze: build, sign, submit and verify the study's CIP-190 records.

  init [--identity <name>]                   create an identity: two 24-word mnemonics; print the public facts
  show [--identity <name>]                   print the identity's public facts
  backup [--identity <name>]                 print both mnemonics for a paper backup (interactive terminal only)
  restore --identity <name> [--signing-key <hex>]   (--signing-key is required without public.json)
                                             recreate an identity from its two typed mnemonics (interactive terminal only)
  hash <manifest> [--identity <name>] [--stage <stage>]
                                             hash every file and run the byte-form and document checks
  build <manifest> --network <n> [--stage hypotheses|final] [--hypotheses <hash> [--hypotheses-document <file>]]
        [--identity <name>] [--core-only]
                                             build, sign and check the record and its transaction; submits nothing
                                             (a freeze names its stage; the hypotheses stage is core-only; --hypotheses
                                             names the cited hypotheses record when this home has no run for it, and
                                             --hypotheses-document gives its document when the home has no record of it)
  build --rebuild <hash> --network <n> [--identity <name>]
                                             after its TTL, carry the journaled hypotheses or final freeze's signed record,
                                             byte for byte, in a new transaction with new inputs, fee and TTL; submits nothing
  check <run>                                re-run the offline checks on a run directory
  submit <run>                               submit the run's exact signed bytes (mainnet: interactive confirmation)
  wait <run>                                 wait for 15 confirmations and record the block facts
                                             (a final-stage freeze: also E, the cutoff slot and N)
  verify <run | tx-hash> --network <n> [--identity <name>]
                                             verify on chain (this tool, the SDK, the cardanowall CLI) and cross-check with Blockfrost
  drawkey <run>                              once epoch N has started, read its nonce from Koios and Blockfrost and record both
  abandon --network <n> [--identity <name>]  drop a journaled transaction whose TTL has passed and which never landed
                                             (never, on mainnet, a hypotheses or final freeze that may have been sent)
  rehearse <manifest> --network preprod [--doi <doi>] | rehearse --resume <id> --network preprod
                                             the whole sequence on preprod with placeholder files
  registry datacite <doi> [--tx <hash>]      check a DOI at DataCite and its back-link to the record
  registry zenodo-sandbox create | upload <id> <file> | link <id> --tx <hash> --embargo <YYYY-MM-DD> | publish <id> | check <id>
  sweep --to <address> --network <n> [--identity <name>]
                                             return the payment address's ADA (mainnet: interactive confirmation)

<network> is mainnet or preprod. <run> is a run directory or the transaction hash of one.
The home is $RESEARCH_FREEZE_HOME, else \${XDG_DATA_HOME:-$HOME/.local/share}/unfrackit-research-freeze.
The cardanowall CLI 0.12.0 is found on PATH or through $RESEARCH_FREEZE_CARDANOWALL.
Blockfrost project ids are read from secrets/blockfrost-<network>.token in the home.`;

function parse(argv) {
  const flags = {};
  const args = [];
  const boolean = new Set(['--core-only', '--json', '--help']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (boolean.has(a)) flags[a.slice(2)] = true;
      else {
        if (i + 1 >= argv.length) throw new UserError(`${a} needs a value`);
        flags[a.slice(2)] = argv[++i];
      }
    } else args.push(a);
  }
  return { args, flags };
}

// A closed pipe (`| head`) ends the output quietly.
process.stdout.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

const say = (s = '') => process.stdout.write(s + '\n');
const note = (s) => process.stderr.write(s + '\n');

function printFacts(p) {
  say(`identity:            ${p.name} (signs ${p.networks.join(', ')} records)`);
  say(`signing public key:  ${p.signing_public_key}`);
  say(`payment key hash:    ${p.payment_key_hash}`);
  say(`payment path:        ${p.payment_path}`);
  say(`mainnet address:     ${p.addresses.mainnet}`);
  say(`preprod address:     ${p.addresses.preprod}`);
}

function printChecks(results) {
  for (const r of results) say(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail && !r.ok ? `: ${r.detail}` : ''}`);
}

function needNetwork(flags) {
  if (!flags.network) throw new UserError('--network mainnet|preprod is required');
  return networkOf(flags.network).name;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { args, flags } = parse(rest);
  const store = new Store();
  store.assertSafe();
  // Temporary secrets left by a killed process are removed before anything else.
  for (const f of store.cleanTmp()) note(`removed a temporary file left by an earlier run: ${f}`);

  switch (cmd) {
    case 'init': {
      const name = flags.identity || 'freeze';
      store.ensure();
      if (store.hasIdentity(name)) throw new UserError(`identity "${name}" already exists; refusing`);
      const pair = newMnemonicPair();
      const id = deriveIdentity(pair.signingMnemonic, pair.paymentMnemonic);
      const facts = publicFacts(name, id);
      store.createIdentity(name, { ...pair, publicJson: { ...facts, created: new Date().toISOString() } });
      say(`created identity "${name}" in ${store.home}`);
      printFacts(facts);
      say(`Run "backup --identity ${name}" in a terminal to write both mnemonics down.`);
      return;
    }
    case 'show': {
      const p = store.readPublic(flags.identity || 'freeze');
      if (flags.json) say(JSON.stringify(p, null, 2));
      else printFacts(p);
      return;
    }
    case 'backup': {
      const name = flags.identity || 'freeze';
      requireTty('backup');
      const p = store.readPublic(name);
      const m = store.readMnemonics(name);
      say(`Paper backup of identity "${name}" (signing public key ${p.signing_public_key}).`);
      say('');
      say('SIGNING MNEMONIC. It controls the signing identity: every record signed by this key, and every');
      say('future re-typing or amendment. It is a CIP-190 signing seed, not a wallet recovery phrase.');
      say('NEVER restore it into a wallet or type it into any other program.');
      say('');
      say(m.signingMnemonic.split(' ').map((w, i) => `${String(i + 1).padStart(2)}. ${w}`).join('\n'));
      say('');
      say(`PAYMENT MNEMONIC. It controls only the small balance at ${p.addresses.mainnet}`);
      say(`(preprod ${p.addresses.preprod}). It may be restored in any software wallet to recover that balance;`);
      say(`the funds sit at the enterprise address of ${p.payment_path}, which a default wallet restore does not show.`);
      say('');
      say(m.paymentMnemonic.split(' ').map((w, i) => `${String(i + 1).padStart(2)}. ${w}`).join('\n'));
      say('');
      say(`"restore --identity ${name}" recreates this identity from these words. Keep runs/ and journal/ of the home backed up with them.`);
      return;
    }
    case 'restore': {
      if (!flags.identity) throw new UserError('restore --identity <name> [--signing-key <hex>]');
      const r = await restoreIdentity({ store, name: flags.identity, expectSigningKey: flags['signing-key'] });
      say(`restored identity "${flags.identity}" in ${store.home}${r.checkedAgainst.length ? ` (checked against ${r.checkedAgainst.join(' and ')})` : ''}`);
      printFacts(r.facts);
      say('Keep runs/ and journal/ of the home backed up with the paper backup: they hold the signed bytes and the journal of every record.');
      return;
    }
    case 'hash': {
      if (!args[0]) throw new UserError('hash <manifest>');
      const pub = store.readPublic(flags.identity || (flags.network ? defaultIdentity(flags.network) : 'freeze'));
      const { manifest, hashed, doc } = hashManifest({ manifestPath: args[0], signingPublicKeyHex: pub.signing_public_key, stage: flags.stage });
      say(`kind ${manifest.kind}, ${hashed.length} items (SHA-256 over the file bytes as on disk):`);
      for (const h of hashed) say(`${h.hex}  ${h.name}${h.document ? '  (document)' : ''}${h.binary ? '  (binary)' : ''}`);
      if (doc) {
        say(doc.ok ? `document checks: ok (${doc.hashLines} hash lines, signing key ${pub.signing_public_key}${manifest.doi ? `, DOI ${manifest.doi}` : ''})` : 'document checks FAILED:');
        for (const e of doc.errors) say(`  ${e}`);
        if (doc.cited) say(`record URIs the document cites: ${doc.cited.length ? doc.cited.join(', ') : 'none'}`);
        if (!doc.ok) process.exitCode = 1;
      }
      return;
    }
    case 'build': {
      if (flags.rebuild !== undefined) {
        if (args.length || flags.stage || flags['core-only'] || flags.hypotheses || flags['hypotheses-document']) {
          throw new UserError('build --rebuild <hash> --network <n> takes no manifest and no other build option: it carries the record of the journaled transaction unchanged');
        }
        const network = needNetwork(flags);
        const name = flags.identity || defaultIdentity(network);
        const pub = store.readPublic(name);
        const cli = Cardanowall.require();
        const koios = koiosFor(store, network, { addresses: [pub.addresses[network]] });
        const r = await rebuild({ store, koios, bf: blockfrostFor(store, network), cli, network, identityName: name, replaces: flags.rebuild, log: note });
        say(`rebuilt the ${r.report.stage}-stage freeze record of ${r.report.replaces} on ${network} into ${r.tx.hash}: the same signed record and 674 line, new inputs, fee and TTL`);
        say(`  transaction ${r.tx.size} bytes; fee ${tada(r.tx.fee)} ADA; TTL slot ${r.report.ttl}`);
        say(`  ${r.report.uri}`);
        say(`  ${r.report.checks.length} offline checks passed; run directory ${r.dir}`);
        say(`Nothing was submitted. "submit" on the new run journals it in place of ${r.report.replaces}.`);
        return;
      }
      if (!args[0]) throw new UserError('build <manifest> --network <n>');
      const network = needNetwork(flags);
      const name = flags.identity || defaultIdentity(network);
      const pub = store.readPublic(name);
      const cli = Cardanowall.require();
      const koios = koiosFor(store, network, { addresses: [pub.addresses[network]] });
      const r = await build({ store, koios, bf: blockfrostFor(store, network), cli, manifestPath: args[0], network, identityName: name, coreOnly: Boolean(flags['core-only']), stage: flags.stage, hypothesesHash: flags.hypotheses, hypothesesDocument: flags['hypotheses-document'], log: note });
      say(`built ${r.report.kind}${r.report.stage ? `, stage ${r.report.stage}` : ''}${r.report.core_only ? ' (core-only)' : ''} record on ${network}: ${r.tx.hash}`);
      if (r.report.hypotheses_record) say(`  its document cites the hypotheses record ${r.report.hypotheses_record}, confirmed and signed by the same key`);
      say(`  record ${r.report.record_bytes} bytes in ${r.report.label_309_chunks} chunks; transaction ${r.tx.size} bytes; fee ${tada(r.tx.fee)} ADA; TTL slot ${r.report.ttl}`);
      say(`  ${r.report.uri}`);
      say(`  ${r.report.checks.length} offline checks passed; run directory ${r.dir}`);
      say('Nothing was submitted.');
      return;
    }
    case 'check': {
      if (!args[0]) throw new UserError('check <run>');
      const dir = resolveRun(store, args[0]);
      const results = checkRun({ store, cli: Cardanowall.require(), dir });
      printChecks(results);
      requireAllPass(results);
      say(`${results.length} offline checks passed`);
      return;
    }
    case 'submit': {
      if (!args[0]) throw new UserError('submit <run>');
      await submitRun({ store, dir: resolveRun(store, args[0]), log: note });
      return;
    }
    case 'wait': {
      if (!args[0]) throw new UserError('wait <run>');
      const facts = await waitRun({ store, dir: resolveRun(store, args[0]), log: note });
      say(stringify(facts, 2));
      if (facts.draw) {
        const d = facts.draw;
        say(`final-stage freeze in epoch E = ${d.block_epoch} at slot ${d.block_slot}; cutoff slot ${d.cutoff_slot} (window ${d.stabilisation_window} slots): the draw key is the nonce of epoch N = ${d.nonce_epoch}, which starts at slot ${d.nonce_epoch_first_slot}`);
        say('These facts come from Koios alone; "verify" and "drawkey" read them again from Koios and Blockfrost.');
      }
      return;
    }
    case 'verify': {
      if (!args[0]) throw new UserError('verify <run | tx-hash> --network <n>');
      const network = needNetwork(flags);
      const r = await verifyRun({ store, cli: Cardanowall.optional(), arg: args[0], network, identityName: flags.identity, log: note });
      if (flags.json) {
        say(stringify(r, 2));
        return;
      }
      say(`${r.txHash} on ${r.network}${r.stage ? `, stage ${r.stage}` : ''}: ${r.verdict}`);
      say(`  this tool: ${r.own.verdict}${r.own.issues.length ? ` (${r.own.issues.join('; ')})` : ''}; signer ${r.own.signers.join(', ')}; labels ${r.own.labels.join(', ')}`);
      if (r.own.block) say(`  block ${r.own.block.height} ${r.own.block.hash}, slot ${r.own.block.slot}, ${r.own.block.time_iso} (Koios); ${r.own.confirmations} confirmations`);
      say(`  SDK verifyTx: ${r.sdk.verdict}${r.sdk.issues.length ? ` (${r.sdk.issues.join('; ')})` : ''}`);
      say(`  cardanowall verify: ${r.cli.verdict}${r.cli.exit !== undefined ? ` (exit ${r.cli.exit})` : ''}${r.cli.issues?.length ? ` (${r.cli.issues.join('; ')})` : ''}`);
      if (r.crosscheck.ran) {
        say(`  Blockfrost cross-check: ${r.crosscheck.ok ? 'agrees' : 'DISAGREES'} (transaction CBOR, block hash, height, slot, epoch, epoch slot, time); depth ${r.crosscheck.depth.koios} on Koios, ${r.crosscheck.depth.blockfrost} on Blockfrost`);
      } else say(`  Blockfrost cross-check: not run (${r.crosscheck.reason})`);
      if (r.draw) say(`  draw plan: E = ${r.draw.block_epoch}, slot ${r.draw.block_slot}, cutoff ${r.draw.cutoff_slot}, N = ${r.draw.nonce_epoch} (${r.draw.sources.join(' and ')})`);
      for (const i of r.issues) say(`  ISSUE ${i}`);
      for (const e of r.explorers) say(`  ${e}`);
      if (r.verdict !== 'valid') process.exitCode = 1;
      return;
    }
    case 'drawkey': {
      if (!args[0]) throw new UserError('drawkey <run>');
      const r = await drawKey({ store, dir: resolveRun(store, args[0]), log: note });
      say(stringify(r, 2));
      return;
    }
    case 'abandon': {
      const network = needNetwork(flags);
      const e = await abandonJournal({ store, network, identityName: flags.identity });
      say(`abandoned ${e.txHash}`);
      return;
    }
    case 'rehearse': {
      const network = needNetwork(flags);
      if (network !== 'preprod') throw new UserError('rehearse runs on preprod only');
      const { base, state } = await rehearse({ store, cli: Cardanowall.require(), manifestPath: args[0], resumeId: flags.resume, doi: flags.doi, log: note });
      say(`rehearsal ${state.runId} in ${base}`);
      for (const s of state.steps) {
        say(`  ${s.label}: ${s.txHash}, fee ${tada(s.fee)} ADA, ${s.size} bytes; this tool ${s.verify.own.verdict}, SDK ${s.verify.sdk.verdict}, CLI ${s.verify.cli.verdict}; ${s.verify.verdict}`);
      }
      say(`  fees ${state.summary.fees_tada} tADA over ${state.summary.transactions} transactions`);
      const d = state.summary.draw;
      if (d) say(`  the final freeze is in epoch ${d.block_epoch} at slot ${d.block_slot} (cutoff ${d.cutoff_slot}); run "drawkey" on it once epoch ${d.nonce_epoch} starts at slot ${d.nonce_epoch_first_slot}`);
      return;
    }
    case 'registry': {
      const [which, sub, ...more] = args;
      if (which === 'datacite') {
        if (!sub) throw new UserError('registry datacite <doi> [--tx <hash>]');
        const r = await dataciteCheck({ doi: sub, txHash: flags.tx });
        say(stringify(r, 2));
        process.exitCode = r.status === 200 ? (flags.tx ? (r.backLinkOk ? 0 : 1) : 0) : 2;
        return;
      }
      if (which === 'zenodo-sandbox') {
        const token = store.readSecretToken('zenodo-sandbox.token', process.env.RESEARCH_FREEZE_ZENODO_SANDBOX_TOKEN);
        const z = new ZenodoSandbox({ token, store });
        let r;
        if (sub === 'create') r = await z.create();
        else if (sub === 'upload') r = await z.upload(more[0], more[1]);
        else if (sub === 'link') r = await z.link(more[0], { txHash: flags.tx, embargoDate: flags.embargo });
        else if (sub === 'publish') r = await z.publish(more[0]);
        else if (sub === 'check') r = await z.check(more[0]);
        else throw new UserError('registry zenodo-sandbox create | upload <id> <file> | link <id> --tx <hash> --embargo <date> | publish <id> | check <id>');
        say(stringify(r, 2));
        return;
      }
      throw new UserError('registry datacite | zenodo-sandbox');
    }
    case 'sweep': {
      const network = needNetwork(flags);
      if (!flags.to) throw new UserError('sweep --to <address> --network <n>');
      const r = await sweep({ store, network, identityName: flags.identity, to: flags.to, log: note });
      say(r.outcome);
      return;
    }
    default:
      say(USAGE);
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 4;
  }
}

main().catch((e) => {
  process.stderr.write(`error: ${e.message}\n`);
  if (!(e instanceof UserError) && process.env.RESEARCH_FREEZE_DEBUG) process.stderr.write(`${e.stack}\n`);
  process.exit(e instanceof UserError ? e.exitCode : 1);
});

