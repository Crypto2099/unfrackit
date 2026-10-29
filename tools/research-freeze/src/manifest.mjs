// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The manifest: the ordered list of files a record commits to, with each
// file's research-items typing, the record kind and, for later kinds, the
// supersedence pointer and the research-related entries. It is an input kept
// outside the repository; file names and paths in it never go on chain.

import fs from 'node:fs';
import path from 'node:path';
import { RELATED_IDENTIFIER_TYPE, RELATION_TYPE, RESOURCE_TYPE_GENERAL } from './vocab.mjs';
import { stringContainsMarker, UserError } from './util.mjs';

export const MANIFEST_FORMAT = 'research-freeze-manifest-v1';
export const KINDS = ['freeze', 'scripts', 'results', 'retype', 'amend'];

// The record URI form: a CIP-0107 `tx_metadata_tag` URI naming label 309 of
// one transaction, lowercase hex only (CIP-0107 "Transaction queries";
// CIP-0013 for the `web+cardano:` scheme).
export const RECORD_URI_RE = /^web\+cardano:\/\/transaction\/([0-9a-f]{64})\/metadata\/309$/;
export const recordUri = (txHash) => {
  if (!/^[0-9a-f]{64}$/.test(txHash)) throw new UserError(`not a lowercase 64-digit transaction hash: ${txHash}`);
  return `web+cardano://transaction/${txHash}/metadata/309`;
};

// A DOI is written as the bare DOI name, lowercase, with no resolver prefix.
export const DOI_RE = /^10\.[0-9]{4,9}\/[^\s]+$/;

function fail(msg) {
  throw new UserError(`manifest: ${msg}`);
}

function closed(obj, allowed, where) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) fail(`${where} must be an object`);
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(`${where} has an unknown field "${k}"`);
}

// Every manifest string that goes on chain: nothing this tool puts on chain
// may contain the string the study classifies prior users by.
function onChainText(s, where) {
  if (stringContainsMarker(s)) fail(`${where} contains "unfrack.it", which nothing on chain may carry`);
  return s;
}

// DataCite 4.7 (relationType "Other"; the companion's research-items and
// research-related keys): relation_info SHOULD be present when the relation
// is Other. This tool requires it.
function checkRelationInfo(r, where) {
  if (r.relation === 'Other' && r.relation_info === undefined) fail(`${where}.relation is Other, which needs relation_info to say what the relation is`);
}

function checkDoi(doi, where) {
  if (typeof doi !== 'string' || !DOI_RE.test(doi)) fail(`${where} is not a bare DOI name (10.<prefix>/<suffix>): ${doi}`);
  if (doi !== doi.toLowerCase()) fail(`${where} must be written in lowercase: ${doi}`);
}

function parseIdentifier(id, where) {
  closed(id, ['id', 'id_type', 'relation', 'relation_info'], where);
  if (typeof id.id !== 'string' || !id.id) fail(`${where}.id must be a non-empty string`);
  if (!RELATED_IDENTIFIER_TYPE.has(id.id_type)) fail(`${where}.id_type "${id.id_type}" is not a DataCite 4.7 relatedIdentifierType`);
  if (!RELATION_TYPE.has(id.relation)) fail(`${where}.relation "${id.relation}" is not a DataCite 4.7 relationType`);
  if (id.relation_info !== undefined && (typeof id.relation_info !== 'string' || !id.relation_info)) fail(`${where}.relation_info must be a non-empty string`);
  if (id.id_type === 'DOI') checkDoi(id.id, `${where}.id`);
  checkRelationInfo(id, where);
  onChainText(id.id, `${where}.id`);
  if (id.relation_info !== undefined) onChainText(id.relation_info, `${where}.relation_info`);
  const out = { id: id.id, id_type: id.id_type, relation: id.relation };
  if (id.relation_info !== undefined) out.relation_info = id.relation_info;
  return out;
}

export function parseRelated(r, where) {
  closed(r, ['uri', 'relation', 'relation_info'], where);
  if (typeof r.uri !== 'string' || !RECORD_URI_RE.test(r.uri)) {
    fail(`${where}.uri must match ^web\\+cardano://transaction/[0-9a-f]{64}/metadata/309$ exactly (lowercase): ${r.uri}`);
  }
  if (!RELATION_TYPE.has(r.relation)) fail(`${where}.relation "${r.relation}" is not a DataCite 4.7 relationType`);
  if (r.relation_info !== undefined && (typeof r.relation_info !== 'string' || !r.relation_info)) fail(`${where}.relation_info must be a non-empty string`);
  checkRelationInfo(r, where);
  if (r.relation_info !== undefined) onChainText(r.relation_info, `${where}.relation_info`);
  const out = { uri: r.uri, relation: r.relation };
  if (r.relation_info !== undefined) out.relation_info = r.relation_info;
  return out;
}

// `raw` is the parsed JSON; `baseDir` resolves relative paths.
export function parseManifest(raw, baseDir) {
  closed(raw, ['format', 'kind', 'doi', 'items', 'supersedes', 'related', 'note'], 'the manifest');
  if (raw.format !== MANIFEST_FORMAT) fail(`format must be "${MANIFEST_FORMAT}"`);
  if (!KINDS.includes(raw.kind)) fail(`kind must be one of ${KINDS.join(', ')}`);
  const kind = raw.kind;
  if (!Array.isArray(raw.items) || raw.items.length === 0) fail('items must be a non-empty array');

  const names = new Set();
  const items = raw.items.map((it, i) => {
    const where = `items[${i}]`;
    closed(it, ['path', 'name', 'type', 'ids', 'binary', 'document', 'message'], where);
    if (typeof it.path !== 'string' || !it.path) fail(`${where}.path must be a non-empty string`);
    const abs = path.resolve(baseDir, it.path);
    const name = it.name ?? path.basename(abs);
    if (typeof name !== 'string' || !name || /\s/.test(name)) fail(`${where}.name must be a file name without spaces`);
    if (names.has(name)) fail(`two items share the file name "${name}"`);
    names.add(name);
    if (it.type !== undefined && !RESOURCE_TYPE_GENERAL.has(it.type)) fail(`${where}.type "${it.type}" is not a DataCite 4.7 resourceTypeGeneral`);
    let ids;
    if (it.ids !== undefined) {
      if (!Array.isArray(it.ids) || it.ids.length === 0) fail(`${where}.ids must be a non-empty array when present`);
      if (it.type === undefined) fail(`${where} has ids but no type`);
      ids = it.ids.map((x, j) => parseIdentifier(x, `${where}.ids[${j}]`));
    }
    for (const f of ['binary', 'document', 'message']) {
      if (it[f] !== undefined && typeof it[f] !== 'boolean') fail(`${where}.${f} must be true or false`);
    }
    return { index: i, path: abs, name, type: it.type, ids, binary: it.binary === true, document: it.document === true, message: it.message === true };
  });

  const documents = items.filter((x) => x.document);
  if (documents.length > 1) fail('at most one item may be the document');
  if (['freeze', 'retype', 'amend'].includes(kind) && documents.length !== 1) fail(`a ${kind} record names exactly one item as the document ("document": true)`);
  if (documents.length === 1 && documents[0].binary) fail('the document must be a text item');
  if (items.some((x) => x.message && x.document)) fail('the document is the message line already; do not also flag it "message"');
  if (documents.length === 1 && items.some((x) => x.message)) fail('when a document is named, the CIP-20 message carries only its digest; no other item may be flagged "message"');
  const messageItems = documents.length === 1 ? documents : items.filter((x) => x.message);
  if (messageItems.length === 0) fail(`a ${kind} record needs at least one item flagged "message": true (its digest is the CIP-20 line)`);

  // A freeze, and an amendment whose document is a study registration (a new
  // version of the pre-registration), name the document's DOI; the document
  // must carry it, and so must the document item's identifiers.
  let doi;
  const needsDoi = kind === 'freeze' || (kind === 'amend' && documents[0].type === 'StudyRegistration');
  if (needsDoi) {
    if (raw.doi === undefined) fail(kind === 'freeze' ? 'a freeze record needs the reserved DOI ("doi")' : 'an amend record whose document is a StudyRegistration needs the new version\'s DOI ("doi")');
    checkDoi(raw.doi, 'doi');
    doi = raw.doi;
    const docIds = documents[0].ids || [];
    if (!docIds.some((x) => x.id_type === 'DOI' && x.id === doi)) fail('the document item must carry the manifest DOI as an identifier with id_type DOI');
  } else if (raw.doi !== undefined) {
    checkDoi(raw.doi, 'doi');
    doi = raw.doi;
  }

  let supersedes;
  if (kind === 'retype' || kind === 'amend') {
    if (typeof raw.supersedes !== 'string' || !/^[0-9a-f]{64}$/.test(raw.supersedes)) fail(`a ${kind} record needs "supersedes", the 64-digit lowercase hash of the transaction it supersedes`);
    supersedes = raw.supersedes;
  } else if (raw.supersedes !== undefined) {
    fail(`a ${kind} record carries no supersedes (supersedes is kept for re-typing and amendment)`);
  }

  let related;
  if (raw.related !== undefined) {
    if (kind === 'freeze') fail('a freeze record carries no research-related entries');
    if (!Array.isArray(raw.related) || raw.related.length === 0) fail('related must be a non-empty array when present');
    related = raw.related.map((r, i) => parseRelated(r, `related[${i}]`));
  }
  if ((kind === 'scripts' || kind === 'results') && !related) fail(`a ${kind} record relates to the freeze through "related"`);

  return { kind, doi, items, supersedes, related, messageItems: messageItems.map((x) => x.index) };
}

export function readManifest(file) {
  const abs = path.resolve(file);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new UserError(`cannot read the manifest ${abs}: ${e.message}`);
  }
  return parseManifest(raw, path.dirname(abs));
}
