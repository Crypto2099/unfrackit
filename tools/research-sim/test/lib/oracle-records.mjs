// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Two runs of the oracle check (test/oracle/battery-run.mjs records) compared
// record by record, keyed by shape, spend and policy: every field of the
// earlier run must hold the same value in the later one, outside the
// wall-clock fields (WALL_FIELDS, at any depth) and `unseededMethods`
// (answers drawn from a generator no caller can seed); a field only the later
// run has must be one this build added (ADDED_FIELDS, at any depth).

import { readFileSync } from 'node:fs';

export const WALL_FIELDS = new Set(['ms', 'wallMs', 'solverMs']);
// The size-weighted work counts and the program's size at its last solve.
export const ADDED_FIELDS = new Set(['nnzSolves', 'nnzNodes', 'nnzIterations', 'nnzSolvesPlusIterations', 'nnz', 'rowsLast', 'nnzLast']);

export function loadRecords(file) {
  const m = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    const k = `${r.shape}|${r.spend}|${r.policy}`;
    if (m.has(k)) throw new Error(`${file}: ${k} twice`);
    m.set(k, r);
  }
  return m;
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// The paths at which `later` departs from `earlier`: a value that differs,
// a field the later run lacks, or a field it adds that is not in `added`.
export function departures(earlier, later, { added = ADDED_FIELDS, path = '' } = {}) {
  if (Array.isArray(earlier) && Array.isArray(later)) {
    if (earlier.length !== later.length) return [path || '(root)'];
    return earlier.flatMap((v, i) => departures(v, later[i], { added, path: `${path}[${i}]` }));
  }
  if (isObj(earlier) && isObj(later)) {
    const out = [];
    for (const k of new Set([...Object.keys(earlier), ...Object.keys(later)])) {
      if (WALL_FIELDS.has(k) || (path === '' && k === 'unseededMethods')) continue;
      const p = path ? `${path}.${k}` : k;
      if (!(k in later)) out.push(`${p} (missing)`);
      else if (!(k in earlier)) {
        if (!added.has(k)) out.push(`${p} (not an added field)`);
      } else out.push(...departures(earlier[k], later[k], { added, path: p }));
    }
    return out;
  }
  return JSON.stringify(earlier) === JSON.stringify(later) ? [] : [path || '(root)'];
}

// { compared, identical, missing [key], extra [key], errors [key], differ
// [{ key, paths }] } for two record files.
export function compareRecordFiles(earlierFile, laterFile, opts = {}) {
  const A = loadRecords(earlierFile);
  const B = loadRecords(laterFile);
  const c = { compared: 0, identical: 0, missing: [], extra: [], errors: [], differ: [] };
  for (const [k, a] of A) {
    const b = B.get(k);
    if (!b) {
      c.missing.push(k);
      continue;
    }
    if (a.error || b.error) {
      c.errors.push(k);
      continue;
    }
    c.compared++;
    const d = departures(a, b, opts);
    if (d.length) c.differ.push({ key: k, paths: d });
    else c.identical++;
  }
  for (const k of B.keys()) if (!A.has(k)) c.extra.push(k);
  return c;
}
