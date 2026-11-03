// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Registry checks. DataCite: the production DOI's metadata carries the
// freeze's record URI as a related identifier. Zenodo sandbox: a rehearsal of
// the embargoed deposit and its back-link, through Zenodo's deposit REST API
// (developers.zenodo.org: POST /api/deposit/depositions, PUT <bucket>/<name>,
// PUT /api/deposit/depositions/:id, POST .../actions/publish,
// GET /api/records/:id), with every request and response logged and the token
// redacted.

import fs from 'node:fs';
import path from 'node:path';
import { RECORD_URI_RE, recordUri } from './manifest.mjs';
import { md5Hex, UserError } from './util.mjs';

export const DATACITE_API = 'https://api.datacite.org';
export const ZENODO_SANDBOX = 'https://sandbox.zenodo.org';

// RFC 3986 path encoding of a DOI name, keeping the slashes between segments.
export function doiPath(doi) {
  return doi.split('/').map(encodeURIComponent).join('/');
}

export async function dataciteCheck({ doi, txHash, fetchImpl = globalThis.fetch }) {
  const url = `${DATACITE_API}/dois/${doiPath(doi)}`;
  const res = await fetchImpl(url, { headers: { accept: 'application/vnd.api+json' } });
  const text = await res.text();
  const out = { url, status: res.status, resolvable: res.status === 200, backLinks: [], expectedUri: txHash ? recordUri(txHash) : null, backLinkOk: false };
  if (res.status !== 200) return out;
  const attrs = JSON.parse(text).data?.attributes || {};
  out.resourceTypeGeneral = attrs.types?.resourceTypeGeneral ?? null;
  out.url_attribute = attrs.url ?? null;
  for (const r of attrs.relatedIdentifiers || []) {
    const value = String(r.relatedIdentifier || '');
    const m = RECORD_URI_RE.exec(value.toLowerCase());
    if (m) out.backLinks.push({ value, relatedIdentifierType: r.relatedIdentifierType, relationType: r.relationType, txHash: m[1] });
  }
  out.backLinkOk = Boolean(
    txHash && out.backLinks.some((b) => b.value === out.expectedUri && b.relatedIdentifierType === 'URL' && b.relationType === 'IsSupplementedBy')
  );
  return out;
}

export class ZenodoSandbox {
  constructor({ token, store, fetchImpl = globalThis.fetch, base = ZENODO_SANDBOX }) {
    if (!token) throw new UserError('no Zenodo sandbox token: save it as secrets/zenodo-sandbox.token (mode 0600) in the home, or set RESEARCH_FREEZE_ZENODO_SANDBOX_TOKEN');
    this.token = token;
    this.fetch = fetchImpl;
    this.base = base;
    this.dir = store.mkdir('registry', 'zenodo-sandbox');
    this.logFile = path.join(this.dir, `log-${new Date().toISOString().slice(0, 10)}.jsonl`);
  }

  redact(s) {
    return String(s).split(this.token).join('[redacted]');
  }

  async request(method, url, { json, body, headers = {}, auth = true } = {}) {
    const h = { ...headers };
    if (auth) h.authorization = `Bearer ${this.token}`;
    if (json !== undefined) h['content-type'] = 'application/json';
    const res = await this.fetch(url, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : body, redirect: 'manual' });
    const text = await res.text();
    const entry = {
      at: new Date().toISOString(),
      method,
      url: this.redact(url),
      request_headers: Object.fromEntries(Object.entries(h).map(([k, v]) => [k, k === 'authorization' ? 'Bearer [redacted]' : this.redact(v)])),
      request_body: json !== undefined ? JSON.parse(this.redact(JSON.stringify(json))) : body ? `<${body.length} bytes>` : null,
      status: res.status,
      response_body: this.redact(text).slice(0, 20000)
    };
    fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, json: parsed, text, headers: res.headers };
  }

  stateFile(id) {
    return path.join(this.dir, `deposition-${id}.json`);
  }

  saveState(id, state) {
    fs.writeFileSync(this.stateFile(id), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  }

  readState(id) {
    const p = this.stateFile(id);
    if (!fs.existsSync(p)) throw new UserError(`no saved state for deposition ${id}`);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  // A draft with a reserved DOI.
  async create() {
    const r = await this.request('POST', `${this.base}/api/deposit/depositions`, { json: { metadata: { prereserve_doi: true } } });
    if (r.status !== 201) throw new UserError(`Zenodo sandbox refused to create a draft: HTTP ${r.status}: ${this.redact(r.text).slice(0, 1000)}`);
    const state = { id: r.json.id, doi: r.json.metadata?.prereserve_doi?.doi, bucket: r.json.links?.bucket, created: r.json.created };
    if (!state.doi || !state.bucket) throw new UserError('the draft carries no reserved DOI or no bucket link');
    this.saveState(state.id, state);
    return state;
  }

  async upload(id, file) {
    const state = this.readState(id);
    const bytes = fs.readFileSync(file);
    const name = path.basename(file);
    const r = await this.request('PUT', `${state.bucket}/${encodeURIComponent(name)}`, { body: bytes, headers: { 'content-type': 'application/octet-stream' } });
    if (r.status !== 200 && r.status !== 201) throw new UserError(`upload refused: HTTP ${r.status}: ${this.redact(r.text).slice(0, 1000)}`);
    const md5 = md5Hex(bytes);
    state.file = { name, size: bytes.length, md5, reported: r.json?.checksum ?? null };
    this.saveState(id, state);
    if (state.file.reported !== `md5:${md5}`) throw new UserError(`Zenodo reports ${state.file.reported} for ${name}, the local MD5 is ${md5}`);
    return state.file;
  }

  // Metadata: embargoed access with a future embargo date, CC BY 4.0, and the
  // record URI as a related identifier with relation isSupplementedBy.
  async link(id, { txHash, embargoDate, title }) {
    const state = this.readState(id);
    const uri = recordUri(txHash);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(embargoDate) || new Date(`${embargoDate}T00:00:00Z`) <= new Date()) throw new UserError('--embargo must be a future date, YYYY-MM-DD');
    const metadata = {
      upload_type: 'publication',
      publication_type: 'other',
      title: title || 'Research freeze tool rehearsal (placeholder document, not a registration)',
      creators: [{ name: 'Dean, Adam K.' }],
      description: 'A placeholder deposit made by a preprod rehearsal of a research freeze tool.',
      access_right: 'embargoed',
      embargo_date: embargoDate,
      license: 'cc-by-4.0',
      prereserve_doi: true,
      related_identifiers: [{ identifier: uri, relation: 'isSupplementedBy' }]
    };
    const r = await this.request('PUT', `${this.base}/api/deposit/depositions/${id}`, { json: { metadata } });
    if (r.status !== 200) throw new UserError(`metadata refused: HTTP ${r.status}: ${this.redact(r.text).slice(0, 2000)}`);
    const rel = r.json?.metadata?.related_identifiers || [];
    state.link = { uri, accepted: rel, embargo_date: embargoDate };
    this.saveState(id, state);
    return state.link;
  }

  async publish(id) {
    const state = this.readState(id);
    const r = await this.request('POST', `${this.base}/api/deposit/depositions/${id}/actions/publish`);
    if (r.status !== 202) throw new UserError(`publish refused: HTTP ${r.status}: ${this.redact(r.text).slice(0, 2000)}`);
    state.published = { record_id: r.json?.record_id, doi: r.json?.doi, state: r.json?.state };
    this.saveState(id, state);
    return state.published;
  }

  // The checks of a published sandbox record, all anonymous except the
  // file-checksum read.
  async check(id) {
    const state = this.readState(id);
    const recid = state.published?.record_id || id;
    const rec = await this.request('GET', `${this.base}/api/records/${recid}`, { auth: false });
    const related = rec.json?.metadata?.related_identifiers || [];
    const exp = await this.request('GET', `${this.base}/records/${recid}/export/datacite-json`, { auth: false });
    const dc = exp.json || {};
    const dcRel = (dc.relatedIdentifiers || dc.data?.attributes?.relatedIdentifiers || []).find((x) => x.relatedIdentifier === state.link?.uri);
    const anon = state.file ? await this.request('GET', `${this.base}/records/${recid}/files/${encodeURIComponent(state.file.name)}?download=1`, { auth: false }) : null;
    return {
      record_status: rec.status,
      related_identifiers: related,
      zenodo_scheme: related.find((x) => x.identifier === state.link?.uri)?.scheme ?? null,
      datacite_export_status: exp.status,
      datacite_related: dcRel || null,
      datacite_ok: Boolean(dcRel && dcRel.relatedIdentifierType === 'URL' && dcRel.relationType === 'IsSupplementedBy'),
      anonymous_download_status: anon ? anon.status : null,
      embargo_holds: anon ? anon.status !== 200 : null,
      md5: state.file ? { local: state.file.md5, reported: state.file.reported, equal: state.file.reported === `md5:${state.file.md5}` } : null
    };
  }
}
