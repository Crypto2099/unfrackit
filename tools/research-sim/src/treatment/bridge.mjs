// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The bridge to the treatment: UnFrack.It's planner and its H-12 selection
// rule, imported unchanged from the directory the operator names.
//
// The treatment files are not part of this repository. Before any of them is
// imported, the SHA-256 of every file is compared with the pinned list
// (data/treatment-pins.txt, or a list the caller passes), and any difference,
// missing file or unpinned treatment file refuses the load, naming the file.
// cardano-serialization-lib is loaded only through the treatment's cslkit.mjs,
// so the simulator, the treatment and every adapter share one CSL instance:
// the treatment's adapters take CSL objects, and an object of a second asm.js
// instance points into another heap. The history reader loads the same files
// (history/csl.mjs); Node's module cache makes them one instance.
//
// Protocol parameters reach the treatment as its parameters object
// (cslkit.mjs resolveParams). The treatment cannot take a parameter set whose
// minimum-UTxO rule is not coins per byte (protocol major under 7) or whose
// largest fee is 2^32 lovelace or more; resolveParams refuses both, and the
// bridge refuses any parameter the treatment would read differently from the
// run's. It reads no other parameter: it spends no UTxO carrying a reference
// script (those are held) and builds no script, certificate or governance
// action, so the reference-script price and the governance deposits cannot
// change what it builds.

import { readFileSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parsePins, checkPins } from '../history/csl.mjs';

export const TREATMENT_FILES = Object.freeze(['planner2.mjs', 'labels.mjs', 'adapter2.mjs', 'build.mjs', 'build2.mjs', 'cslkit.mjs', 'conform.mjs', 'apply.mjs', 'select2.mjs', 'select2-csl.mjs', 'package.json', 'package-lock.json']);

const MODULES = Object.freeze({
  cslkit: 'cslkit.mjs',
  labels: 'labels.mjs',
  planner: 'planner2.mjs',
  adapter: 'adapter2.mjs',
  build: 'build.mjs',
  build2: 'build2.mjs',
  conform: 'conform.mjs',
  apply: 'apply.mjs',
  select: 'select2.mjs',
  selectCsl: 'select2-csl.mjs'
});

export const DEFAULT_PINS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'treatment-pins.txt');

let loaded = null;

// Loads the treatment from `dir`, checked against the pins (their text; the
// simulator's own list by default). One treatment per process.
export async function loadTreatment(dir, pinsText = readFileSync(DEFAULT_PINS, 'utf8')) {
  const abs = resolvePath(dir);
  const pins = parsePins(pinsText);
  for (const f of TREATMENT_FILES) if (!pins.has(f)) throw new Error(`the pinned list does not name the treatment file ${f}`);
  for (const f of pins.keys()) if (!TREATMENT_FILES.includes(f)) throw new Error(`the pinned list names ${f}, which is not a treatment file`);
  checkPins(abs, pins);
  if (loaded) {
    if (loaded.dir !== abs) throw new Error(`a treatment from ${loaded.dir} is already loaded`);
    for (const [f, d] of pins) if (loaded.pins.get(f) !== d) throw new Error('the treatment is already loaded under other pins');
    return loaded;
  }
  const mods = {};
  for (const [k, f] of Object.entries(MODULES)) mods[k] = await import(pathToFileURL(join(abs, f)).href);
  const T = Object.freeze({ dir: abs, pins, CSL: mods.cslkit.CSL, ...mods });
  if (!T.CSL) throw new Error('cslkit.mjs exports no CSL');
  loaded = T;
  return T;
}

// The run's parameters as the treatment's parameters object. Every field the
// treatment reads must come back with the run's value.
export function treatmentParams(T, params) {
  const p = T.cslkit.resolveParams({
    protocolMajor: params.protocolMajor,
    minFeeA: params.minFeeA,
    minFeeB: params.minFeeB,
    maxTxSize: params.maxTxSize,
    maxValSize: params.maxValSize,
    coinsPerUtxoByte: params.coinsPerUtxoByte,
    keyDeposit: params.keyDeposit,
    poolDeposit: params.poolDeposit,
    priceMem: params.priceMem,
    priceStep: params.priceStep,
    maxCollateralInputs: params.maxCollateralInputs,
    collateralPercent: params.collateralPercent
  });
  for (const k of Object.keys(T.cslkit.DEFAULT_PARAMS)) {
    if (String(p[k]) !== String(params[k])) throw new Error(`the treatment would read protocol parameter ${k} as ${String(p[k])}, the run's is ${String(params[k])}`);
  }
  return p;
}
