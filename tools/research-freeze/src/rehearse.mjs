// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The preprod rehearsal: the same commands as the mainnet records, run with
// the `rehearsal` identity over placeholder files generated from the freeze
// manifest, with distinct content per run.
//
// Steps, in the order the mainnet records follow:
//
// 1. hypotheses: a core-only freeze, stage hypotheses, of a placeholder
//    document alone (the pre-registration text before the live-fire checks);
// 2. final: a typed freeze, stage final, of one placeholder per manifest
//    item, whose placeholder document carries the hash table of the others,
//    the rehearsal public key, a placeholder DOI and the hypotheses record's
//    URI, so the document checks and the citation check run as they will on
//    mainnet; `wait` records the draw plan (E, the cutoff slot and N);
// 3. retype: a re-typing successor superseding the final freeze, with a
//    second placeholder identifier on the document;
// 4. scripts: a scripts record whose research-related entry names the final
//    freeze with IsSupplementTo.
//
// Each is built, checked, submitted, waited to 15 confirmations and verified.
// The state is kept in rehearsals/<id>/state.json, so an interrupted
// rehearsal resumes where it stopped. `drawkey` on the final freeze runs once
// epoch N has started, outside the rehearsal.

import fs from 'node:fs';
import path from 'node:path';
import { readManifest, recordUri, MANIFEST_FORMAT } from './manifest.mjs';
import { build } from './build.mjs';
import { submitRun, waitRun, verifyRun, koiosFor } from './ops.mjs';
import { sha256, stringify, tada, toHex, UserError } from './util.mjs';

function write(file, text) {
  fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
}

function placeholderSet({ dir, label, runId, created, items, doi, publicKey, cites = [] }) {
  fs.mkdirSync(dir, { mode: 0o700 });
  const digests = new Map();
  for (const it of items) {
    if (it.document) continue;
    const text = `Rehearsal placeholder for ${it.name} (item ${it.index + 1} of ${items.length}).\nRun ${runId}, record ${label}, created ${created}.\nThis file stands in for a frozen file in a preprod rehearsal; it is not the file itself.\n`;
    write(path.join(dir, it.name), text);
    digests.set(it.name, toHex(sha256(Buffer.from(text))));
  }
  const doc = items.find((x) => x.document);
  if (doc) {
    const lines = items.filter((x) => !x.document).map((x) => `${digests.get(x.name)}  ${x.name}`);
    const text = [
      `Rehearsal placeholder document (${label}). It is not a registration.`,
      `Run ${runId}, created ${created}.`,
      '',
      `DOI of this document: ${doi}`,
      '',
      `Signing public key (hex): ${publicKey}`,
      ...(cites.length ? ['', 'Hypotheses record, frozen before the checks:', '', ...cites] : []),
      ...(lines.length ? ['', 'SHA-256 of every other file of the record:', '', ...lines] : []),
      ''
    ].join('\n');
    write(path.join(dir, doc.name), text);
  }
  return dir;
}

function manifestFor({ kind, items, dir, doi, supersedes, related, extraDocId }) {
  const m = {
    format: MANIFEST_FORMAT,
    kind,
    items: items.map((it) => {
      const out = { path: path.join(dir, it.name), name: it.name, type: it.type || 'Text' };
      if (it.document) {
        out.document = true;
        out.type = 'StudyRegistration';
        out.ids = [{ id: doi, id_type: 'DOI', relation: 'IsPartOf' }];
        if (extraDocId) out.ids.push(extraDocId);
      }
      return out;
    })
  };
  if (kind === 'freeze' || kind === 'retype') m.doi = doi;
  if (supersedes) m.supersedes = supersedes;
  if (related) m.related = related;
  return m;
}

function scriptsItems(n = 3) {
  return Array.from({ length: n }, (_, i) => ({ index: i, name: `analysis-${i + 1}.mjs`, type: 'Software', document: false }));
}

export async function rehearse({ store, cli, manifestPath, resumeId, doi: doiArg, log = console.error }) {
  const network = 'preprod';
  const pub = store.readPublic('rehearsal');
  if (!pub.networks.includes('preprod')) throw new UserError('the rehearsal identity is not a preprod identity');
  let state;
  let base;
  if (resumeId) {
    base = store.path('rehearsals', resumeId);
    state = JSON.parse(fs.readFileSync(path.join(base, 'state.json'), 'utf8'));
    if (state.format !== 'research-freeze-rehearsal-v2') throw new UserError(`rehearsal ${resumeId} was made by an earlier version of this tool and cannot be resumed`);
  } else {
    const source = readManifest(manifestPath);
    if (source.kind !== 'freeze') throw new UserError('rehearse takes the freeze manifest; it generates the other records itself');
    const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
    base = store.mkdir('rehearsals', runId);
    const doi = doiArg || `10.5072/rehearsal.${runId.toLowerCase()}`;
    state = {
      format: 'research-freeze-rehearsal-v2',
      runId,
      created: new Date().toISOString(),
      doi,
      source: { items: source.items.map((x) => ({ index: x.index, name: x.name, type: x.type, document: x.document })) },
      steps: [
        { label: 'hypotheses', kind: 'freeze', stage: 'hypotheses', coreOnly: true },
        { label: 'final', kind: 'freeze', stage: 'final', coreOnly: false, after: 'hypotheses' },
        { label: 'retype', kind: 'retype', coreOnly: false, after: 'final' },
        { label: 'scripts', kind: 'scripts', coreOnly: false, after: 'final' }
      ]
    };
    fs.writeFileSync(path.join(base, 'state.json'), stringify(state, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  const save = () => store.updateRunFile(base, 'state.json', stringify(state, 2) + '\n');
  const stepBy = (label) => state.steps.find((s) => s.label === label);
  const created = () => new Date().toISOString();

  for (const step of state.steps) {
    if (step.verified) continue;
    if (!step.dir) {
      let manifest;
      if (step.stage === 'hypotheses') {
        const items = state.source.items.filter((x) => x.document).map((x) => ({ ...x, index: 0 }));
        const dir = placeholderSet({ dir: path.join(base, step.label), label: step.label, runId: state.runId, created: created(), items, doi: state.doi, publicKey: pub.signing_public_key });
        manifest = manifestFor({ kind: 'freeze', items, dir, doi: state.doi });
      } else if (step.stage === 'final') {
        const hyp = stepBy(step.after);
        const dir = placeholderSet({ dir: path.join(base, step.label), label: step.label, runId: state.runId, created: created(), items: state.source.items, doi: state.doi, publicKey: pub.signing_public_key, cites: [recordUri(hyp.txHash)] });
        manifest = manifestFor({ kind: 'freeze', items: state.source.items, dir, doi: state.doi });
      } else if (step.kind === 'retype') {
        const target = stepBy(step.after);
        manifest = manifestFor({
          kind: 'retype',
          items: state.source.items,
          dir: path.join(base, target.label),
          doi: state.doi,
          supersedes: target.txHash,
          extraDocId: { id: `10.5072/second-identifier.${state.runId.toLowerCase()}`, id_type: 'DOI', relation: 'IsPartOf' }
        });
      } else if (step.kind === 'scripts') {
        const target = stepBy(step.after);
        const items = scriptsItems();
        const dir = placeholderSet({ dir: path.join(base, step.label), label: step.label, runId: state.runId, created: created(), items, doi: state.doi, publicKey: pub.signing_public_key });
        manifest = manifestFor({ kind: 'scripts', items, dir, related: [{ uri: recordUri(target.txHash), relation: 'IsSupplementTo' }] });
        manifest.items[0].message = true;
      }
      const mpath = path.join(base, `${step.label}.manifest.json`);
      if (!fs.existsSync(mpath)) write(mpath, JSON.stringify(manifest, null, 2) + '\n');
      log(`[${step.label}] build`);
      const koios = koiosFor(store, network, { addresses: [pub.addresses.preprod] });
      const r = await build({ store, koios, cli, manifestPath: mpath, network, identityName: 'rehearsal', coreOnly: step.coreOnly, stage: step.stage, log });
      step.dir = r.dir;
      step.txHash = r.tx.hash;
      step.fee = r.tx.fee.toString();
      step.size = r.tx.size;
      step.recordBytes = r.report.record_bytes;
      step.items = r.report.items.length;
      step.checks = r.report.checks.length;
      save();
    }
    if (!step.submitted) {
      log(`[${step.label}] submit ${step.txHash}`);
      await submitRun({ store, dir: step.dir, log });
      step.submitted = true;
      save();
    }
    if (!step.confirmed) {
      log(`[${step.label}] wait for 15 confirmations`);
      step.confirmed = await waitRun({ store, dir: step.dir, log });
      if (step.confirmed.draw) log(`[${step.label}] block in epoch ${step.confirmed.draw.block_epoch} at slot ${step.confirmed.draw.block_slot} (cutoff ${step.confirmed.draw.cutoff_slot}): the draw key is the nonce of epoch ${step.confirmed.draw.nonce_epoch}`);
      save();
    }
    log(`[${step.label}] verify`);
    step.verify = await verifyRun({ store, cli, arg: step.dir, network, log });
    if (step.verify.verdict !== 'valid') throw new UserError(`[${step.label}] verify: ${step.verify.verdict} (this tool ${step.verify.own.verdict}, SDK ${step.verify.sdk.verdict}, CLI ${step.verify.cli.verdict}${step.verify.issues.length ? `; ${step.verify.issues.join('; ')}` : ''})`);
    step.verified = true;
    save();
  }

  const fees = state.steps.reduce((s, x) => s + BigInt(x.fee), 0n);
  const final = stepBy('final');
  state.summary = { fees_lovelace: fees.toString(), fees_tada: tada(fees), transactions: state.steps.length, draw: final?.confirmed?.draw || null };
  save();
  return { base, state };
}
