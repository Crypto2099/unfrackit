// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The simulator's output records and the private run directory.
//
// A run writes under
//   ${XDG_DATA_HOME:-$HOME/.local/share}/unfrackit-research/sim/<network>/<run-id>/
// (RESEARCH_SIM_HOME overrides the root), never in the repository:
//   run.json        what the run ran under: its command and plan, the
//                   settings, the treatment's pins, the parameters, the Node
//                   version, the analysis-freeze transaction when it was given
//   records.jsonl   the records, one JSON object per line, bigint as decimal
//                   strings
//   timings.jsonl   wall-clock times, apart from the records so that a run
//                   repeated with the same seeds writes byte-identical records
//   log.jsonl       the run's log: start, each job's end or time-out, end
// Directories are created 0700 and files 0600.
//
// Every record carries the key of the replay or battery spend it belongs to:
//   wallet      db-sync's stake-credential id (an integer), or a shape's name
//   window      'recent', 'peak', 'snapshot', or 'synthetic'
//   arm         the starting layout and its maintenance
//   variant     the planner settings varied from the decided defaults, by name
//   method      the selector, by name and version
//   change      the change policy
//   collateral  the arm's collateral rule
//   repetition  the repetition number, 1-based
// and names no stake address, address or transaction hash: assertClean
// refuses a record carrying a bech32 address or stake address anywhere, and a
// run of 64 hex digits (a transaction hash) or 56 (a credential or a key
// hash) anywhere but a field named policy, name or asset (an asset is
// 'policy.name'), so free text (a failure's detail, a refusal's reason) is
// scrubbed of them first. Intents are named by their position in the wallet's
// stream.

import { join } from 'node:path';
import { runDir, ensureDir, writeJson, JsonLines } from '../history/paths.mjs';

export const RECORD_KINDS = Object.freeze(['spend', 'plan', 'burst', 'trigger', 'wallet-arm', 'battery', 'h12', 'timeout', 'refused']);
export const KEY_FIELDS = Object.freeze(['wallet', 'window', 'arm', 'variant', 'method', 'change', 'collateral', 'repetition']);

const BECH32_ADDR = /(addr|addr_test|stake|stake_test)1[02-9ac-hj-np-z]{20,}/;
const HEX64 = /[0-9a-f]{64}/i;
const HEX56 = /[0-9a-f]{56}/i;
const TEXT_FIELDS = new Set(['detail', 'reason', 'error', 'refused']);

// A free-text field (a failure's detail, a refusal's reason) with every
// address, hash and credential in it replaced by a placeholder.
export function scrubText(t) {
  return String(t)
    .replace(new RegExp(BECH32_ADDR.source, 'g'), '<address>')
    .replace(/[0-9a-f]{64}/gi, '<hash>')
    .replace(/[0-9a-f]{56}/gi, '<hash28>');
}
function scrub(v, field) {
  if (typeof v === 'string') return TEXT_FIELDS.has(field) ? scrubText(v) : v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, field));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, k)]));
  return v;
}
const ASSET_FIELDS = new Set(['policy', 'name', 'asset']);

export class IdentifierInRecord extends Error {}

// Throws when a record names a stake address, an address, a transaction hash,
// or a credential.
export function assertClean(record, path = '') {
  const walk = (v, p, field) => {
    if (typeof v === 'string') {
      if (BECH32_ADDR.test(v)) throw new IdentifierInRecord(`record field ${p}: an address`);
      if (ASSET_FIELDS.has(field)) return;
      if (HEX64.test(v)) throw new IdentifierInRecord(`record field ${p}: a transaction hash`);
      if (HEX56.test(v)) throw new IdentifierInRecord(`record field ${p}: a credential or key hash`);

    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${p}[${i}]`, field));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k, k);
    }
  };
  walk(record, path, null);
  return record;
}

export function recordKey(k) {
  for (const f of KEY_FIELDS) if (k[f] === undefined) throw new TypeError(`record key: no ${f}`);
  if (!(Number.isSafeInteger(k.wallet) || typeof k.wallet === 'string')) throw new TypeError('record key: wallet must be a stake-credential id or a shape name');
  if (typeof k.wallet === 'string' && !/^[A-Z][A-Za-z0-9]{0,5}$/.test(k.wallet)) throw new TypeError(`record key: ${k.wallet} is not a shape name`);
  return Object.fromEntries(KEY_FIELDS.map((f) => [f, k[f]]));
}

// A record; free-text fields are scrubbed first.
export function record(kind, key, fields) {
  if (!RECORD_KINDS.includes(kind)) throw new TypeError(`unknown record kind ${kind}`);
  for (const f of ['kind', ...KEY_FIELDS]) if (f in fields) throw new TypeError(`a record's fields may not name its ${f}`);
  return assertClean({ kind, ...recordKey(key), ...scrub(fields, null) });
}

// A run's directory and its files.
export class RunOutput {
  constructor(network, runId, header) {
    this.dir = ensureDir(runDir(network, runId));
    writeJson(join(this.dir, 'run.json'), { ...header, network, runId });
    this.records = new JsonLines(join(this.dir, 'records.jsonl'));
    this.timings = new JsonLines(join(this.dir, 'timings.jsonl'));
    this.log = new JsonLines(join(this.dir, 'log.jsonl'));
    this.counts = {};
  }
  // A record; its wall-clock fields (ms, at any depth) go to timings.jsonl
  // under the record's key and number.
  write(rec) {
    assertClean(rec);
    const n = (this.n = (this.n || 0) + 1);
    const times = {};
    const strip = (v, p) => {
      if (Array.isArray(v)) return v.map((x, i) => strip(x, `${p}[${i}]`));
      if (v && typeof v === 'object') {
        const o = {};
        for (const [k, x] of Object.entries(v)) {
          if (k === 'ms' && typeof x === 'number') times[p ? `${p}.ms` : 'ms'] = x;
          else o[k] = strip(x, p ? `${p}.${k}` : k);
        }
        return o;
      }
      return v;
    };
    const clean = strip(rec, '');
    this.records.write(clean);
    if (Object.keys(times).length) this.timings.write({ n, kind: rec.kind, ...recordKey(rec), times });
    this.counts[rec.kind] = (this.counts[rec.kind] || 0) + 1;
  }
  note(entry) {
    this.log.write({ at: new Date().toISOString(), ...entry });
  }
  close() {
    this.records.close();
    this.timings.close();
    this.log.close();
  }
}
