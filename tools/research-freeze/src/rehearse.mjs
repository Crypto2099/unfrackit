// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The preprod rehearsal: the same commands as the mainnet freeze, run with the
// `rehearsal` identity over placeholder files generated from the manifest, one
// placeholder per manifest entry, with distinct content per run. The
// placeholder document carries a hash table of the other placeholders, the
// rehearsal public key and a placeholder DOI, so the document checks run as
// they will on hash day.
//
// Steps: a core-only freeze record and a typed freeze record; a retype record
// superseding the typed one with a second placeholder identifier; a scripts
// record relating to the typed one with IsSupplementTo. Each is built,
// checked, submitted, waited to 15 confirmations and verified three ways. The
// state is kept in rehearsals/<id>/state.json, so an interrupted rehearsal
// resumes where it stopped.

import fs from 'node:fs';
import path from 'node:path';
import { readManifest, recordUri, MANIFEST_FORMAT } from './manifest.mjs';
import { build } from './build.mjs';
import { submitRun, waitRun, verifyRun, koiosFor } from './ops.mjs';
import { sha256, stringify, tada, toHex, UserError } from './util.mjs';

function write(file, text) {
  fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
}

function placeholderSet({ dir, label, runId, created, source, doi, publicKey }) {
  fs.mkdirSync(dir, { mode: 0o700 });
  const items = source.items;
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
      `Rehearsal placeholder document. It is not a registration.`,
      `Run ${runId}, record ${label}, created ${created}.`,
      '',
      `DOI of this document: ${doi}`,
      '',
      `Signing public key (hex): ${publicKey}`,
      '',
      'SHA-256 of every other file of the record:',
      '',
      ...lines,
      ''
    ].join('\n');
    write(path.join(dir, doc.name), text);
  }
  return dir;
}

function manifestFor({ kind, source, dir, doi, supersedes, related, extraDocId }) {
  const m = {
    format: MANIFEST_FORMAT,
    kind,
    items: source.items.map((it) => {
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

function scriptsSource(n = 3) {
  return { items: Array.from({ length: n }, (_, i) => ({ index: i, name: `analysis-${i + 1}.mjs`, type: 'Software', document: false })) };
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
  } else {
    const source = readManifest(manifestPath);
    if (source.kind !== 'freeze') throw new UserError('rehearse takes the freeze manifest; it generates the later records itself');
    const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
    base = store.mkdir('rehearsals', runId);
    const doi = doiArg || `10.5072/rehearsal.${runId.toLowerCase()}`;
    state = {
      runId,
      created: new Date().toISOString(),
      doi,
      source: { items: source.items.map((x) => ({ index: x.index, name: x.name, type: x.type, document: x.document })) },
      steps: [
        { label: 'core-only-freeze', kind: 'freeze', coreOnly: true },
        { label: 'typed-freeze', kind: 'freeze', coreOnly: false },
        { label: 'retype', kind: 'retype', coreOnly: false, after: 'typed-freeze' },
        { label: 'scripts', kind: 'scripts', coreOnly: false, after: 'typed-freeze' }
      ]
    };
    fs.writeFileSync(path.join(base, 'state.json'), stringify(state, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  const save = () => store.updateRunFile(base, 'state.json', stringify(state, 2) + '\n');
  const stepBy = (label) => state.steps.find((s) => s.label === label);

  for (const step of state.steps) {
    if (step.verified) continue;
    if (!step.dir) {
      let manifest;
      if (step.kind === 'freeze') {
        const dir = placeholderSet({ dir: path.join(base, step.label), label: step.label, runId: state.runId, created: new Date().toISOString(), source: state.source, doi: state.doi, publicKey: pub.signing_public_key });
        manifest = manifestFor({ kind: 'freeze', source: state.source, dir, doi: state.doi });
      } else if (step.kind === 'retype') {
        const typed = stepBy(step.after);
        manifest = manifestFor({
          kind: 'retype',
          source: state.source,
          dir: path.join(base, typed.label),
          doi: state.doi,
          supersedes: typed.txHash,
          extraDocId: { id: `10.5072/second-identifier.${state.runId.toLowerCase()}`, id_type: 'DOI', relation: 'IsPartOf' }
        });
      } else if (step.kind === 'scripts') {
        const typed = stepBy(step.after);
        const source = scriptsSource();
        const dir = placeholderSet({ dir: path.join(base, step.label), label: step.label, runId: state.runId, created: new Date().toISOString(), source, doi: state.doi, publicKey: pub.signing_public_key });
        manifest = manifestFor({ kind: 'scripts', source, dir, related: [{ uri: recordUri(typed.txHash), relation: 'IsSupplementTo' }] });
        manifest.items[0].message = true;
      }
      const mpath = path.join(base, `${step.label}.manifest.json`);
      if (!fs.existsSync(mpath)) write(mpath, JSON.stringify(manifest, null, 2) + '\n');
      log(`[${step.label}] build`);
      const koios = koiosFor(store, network, { addresses: [pub.addresses.preprod] });
      const r = await build({ store, koios, cli, manifestPath: mpath, network, identityName: 'rehearsal', coreOnly: step.coreOnly, log });
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
      save();
    }
    log(`[${step.label}] verify`);
    step.verify = await verifyRun({ store, cli, arg: step.dir, network, log });
    step.verified = true;
    save();
  }

  const fees = state.steps.reduce((s, x) => s + BigInt(x.fee), 0n);
  state.summary = { fees_lovelace: fees.toString(), fees_tada: tada(fees), transactions: state.steps.length };
  save();
  return { base, state };
}
