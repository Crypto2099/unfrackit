#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The probe file of the machine-independence proof, and the small queries
// scripts/check-machine-independence.sh makes of it. A probe file is JSON:
//
//   { "format": "unfrackit-research-sim mi7 probe 1",
//     "stages": [
//       { "name": "shapes",            // 1 to 32 of a-z, 0-9 and '-'
//         "kill": true,                 // L5 kills one shard of this stage and resumes it
//         "options": { "shapes": "S1,S6", "plan": "peak", "collateral-rule": "ledger", "validity": true },
//         "reps": 10 },                 // a number, or { "default": 2, "L6": 10 } by leg
//       ... ] }
//
// An option is a replay flag without its dashes: a string or number gives
// `--key value`, true gives `--key`, a list repeats the flag (`history`).
// The flags the driver sets itself (workers, machine, run-id, shard, reps,
// max-jobs, memory-budget, wallet-indexes, treatment, treatment-pins) are
// refused in a stage's options. `reps` is the repetitions of a library that
// picks at random, per leg; absent, the replay's own 10 applies.
//
//   node scripts/probe-file.mjs check <probe>
//   node scripts/probe-file.mjs stages <probe>                  stage names, one per line
//   node scripts/probe-file.mjs args <probe> <stage> <leg>      the replay's stage flags, one per line
//   node scripts/probe-file.mjs reps <probe> <stage> <leg>      the repetitions the leg runs (10 when absent)
//   node scripts/probe-file.mjs kill <probe> <stage>            1 or 0
//   node scripts/probe-file.mjs wallets <probe> <stage>         the stage's wallet count
//   node scripts/probe-file.mjs get <json file> <key>           a top-level field of a JSON file
//   node scripts/probe-file.mjs record <out> key=value...       writes a JSON object (values read as JSON where they parse)

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROBE_FORMAT = 'unfrackit-research-sim mi7 probe 1';
export const DEFAULT_REPS = 10;
export const LEGS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'qualify'];
const DRIVER_FLAGS = ['workers', 'machine', 'run-id', 'shard', 'reps', 'max-jobs', 'memory-budget', 'wallet-indexes', 'treatment', 'treatment-pins'];
const NAME = /^[a-z0-9-]{1,32}$/;

export function readProbe(path) {
  let p;
  try {
    p = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path} cannot be read as JSON (${e.code || e.message})`);
  }
  return checkProbe(p);
}

export function checkProbe(p) {
  if (!p || p.format !== PROBE_FORMAT) throw new Error(`the probe file's format is not "${PROBE_FORMAT}"`);
  if (!Array.isArray(p.stages) || !p.stages.length) throw new Error('the probe file names no stage');
  const seen = new Set();
  for (const s of p.stages) {
    if (!s || typeof s.name !== 'string' || !NAME.test(s.name)) throw new Error(`a stage's name is 1 to 32 of a-z, 0-9 and "-": ${JSON.stringify(s && s.name)}`);
    if (seen.has(s.name)) throw new Error(`stage ${s.name} appears twice`);
    seen.add(s.name);
    if (!s.options || typeof s.options !== 'object' || Array.isArray(s.options)) throw new Error(`stage ${s.name}: options is an object of replay flags`);
    for (const [k, v] of Object.entries(s.options)) {
      if (DRIVER_FLAGS.includes(k)) throw new Error(`stage ${s.name}: --${k} is set by the driver, not by the probe file`);
      const ok = (x) => typeof x === 'string' || typeof x === 'number' || x === true;
      if (!(ok(v) || (Array.isArray(v) && v.length && v.every(ok)))) throw new Error(`stage ${s.name}: option ${k} is a string, a number, true or a list of those`);
    }
    if (!s.options.shapes === !s.options.history) throw new Error(`stage ${s.name}: name the wallets with exactly one of the options shapes and history`);
    if (s.kill !== undefined && typeof s.kill !== 'boolean') throw new Error(`stage ${s.name}: kill is true or false`);
    if (s.reps !== undefined) {
      const bad = (n) => !Number.isSafeInteger(n) || n < 1;
      if (typeof s.reps === 'object' && s.reps !== null && !Array.isArray(s.reps)) {
        for (const [k, n] of Object.entries(s.reps)) if ((k !== 'default' && !LEGS.includes(k)) || bad(n)) throw new Error(`stage ${s.name}: reps ${JSON.stringify(k)} must be "default" or a leg, with a positive whole number`);
      } else if (bad(s.reps)) {
        throw new Error(`stage ${s.name}: reps is a positive whole number or an object by leg`);
      }
    }
  }
  return p;
}

export function stageOf(p, name) {
  const s = p.stages.find((x) => x.name === name);
  if (!s) throw new Error(`the probe file has no stage ${name}`);
  return s;
}

export function repsOf(stage, leg) {
  const r = stage.reps;
  if (r === undefined) return DEFAULT_REPS;
  if (typeof r === 'number') return r;
  return r[leg] ?? r.default ?? DEFAULT_REPS;
}

// The stage's replay flags as an argument list, without the driver's.
export function replayArgs(stage, leg) {
  const out = [];
  for (const [k, v] of Object.entries(stage.options)) {
    for (const x of [].concat(v)) {
      out.push(`--${k}`);
      if (x !== true) out.push(String(x));
    }
  }
  if (stage.reps !== undefined) out.push('--reps', String(repsOf(stage, leg)));
  return out;
}

// The wallets a stage runs: a list of shape names, or the *.jsonl files of
// the history paths (a directory counts its files).
export function walletCount(stage) {
  const o = stage.options;
  if (o.shapes) return String(o.shapes).split(',').length;
  let n = 0;
  for (const path of [].concat(o.history)) {
    const a = resolve(String(path));
    n += statSync(a).isDirectory() ? readdirSync(a).filter((f) => f.endsWith('.jsonl')).length : 1;
  }
  return n;
}

function main(argv) {
  const [cmd, a, b, c, ...rest] = argv;
  if (cmd === 'check') {
    const p = readProbe(a);
    return `${p.stages.length} stages: ${p.stages.map((s) => s.name).join(', ')}`;
  }
  if (cmd === 'stages') return readProbe(a).stages.map((s) => s.name).join('\n');
  if (cmd === 'args') return replayArgs(stageOf(readProbe(a), b), c).join('\n');
  if (cmd === 'reps') return String(repsOf(stageOf(readProbe(a), b), c));
  if (cmd === 'kill') return stageOf(readProbe(a), b).kill ? '1' : '0';
  if (cmd === 'wallets') return String(walletCount(stageOf(readProbe(a), b)));
  if (cmd === 'get') {
    const v = JSON.parse(readFileSync(a, 'utf8'))[b];
    if (v === undefined) throw new Error(`${a} has no field ${b}`);
    return typeof v === 'string' ? v : JSON.stringify(v);
  }
  if (cmd === 'record') {
    const o = {};
    for (const kv of [b, c, ...rest].filter((x) => x !== undefined)) {
      const i = kv.indexOf('=');
      if (i < 1) throw new Error(`${kv} is not key=value`);
      let v = kv.slice(i + 1);
      try {
        v = JSON.parse(v);
      } catch {
        // a plain string
      }
      o[kv.slice(0, i)] = v;
    }
    writeFileSync(a, `${JSON.stringify(o, null, 2)}\n`);
    return '';
  }
  throw new Error('usage: probe-file.mjs check|stages|args|reps|kill|wallets|get|record ...');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const text = main(process.argv.slice(2));
    if (text) console.log(text);
  } catch (e) {
    console.error(`probe-file: ${e.message}`);
    process.exit(2);
  }
}
