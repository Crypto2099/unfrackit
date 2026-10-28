// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// cardano-serialization-lib, loaded only through the treatment's cslkit.mjs,
// so that this reader, the treatment and every adapter share one CSL instance
// (the treatment's adapters take CSL objects, and an object of a second
// asm.js instance points into another heap).
//
// The treatment files are not part of this repository; the operator gives the
// harness directory at run time. Before anything is imported, the SHA-256 of
// every file of the pinned list is compared with the file in that directory,
// and any difference refuses the load, naming the file. The pinned list is
// text in the `npm run hash` line format, <64 hex><two spaces><file name>.
//
// The simulator's treatment bridge pins and loads the same files; whichever
// loads first, Node's module cache makes it one module instance.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parsePins(text) {
  const pins = new Map();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line.trim());
    if (!m) continue;
    if (pins.has(m[2])) throw new Error(`the pinned list names ${m[2]} twice`);
    pins.set(m[2], m[1]);
  }
  if (!pins.size) throw new Error('the pinned list names no file');
  return pins;
}

export function checkPins(dir, pins) {
  const bad = [];
  for (const [name, want] of pins) {
    let got;
    try {
      got = createHash('sha256').update(readFileSync(join(dir, name))).digest('hex');
    } catch {
      bad.push(`${name}: missing`);
      continue;
    }
    if (got !== want) bad.push(`${name}: SHA-256 ${got}, pinned ${want}`);
  }
  if (bad.length) throw new Error(`refusing the treatment directory: ${bad.join('; ')}`);
}

export async function loadTreatmentCsl(dir, pinsText) {
  const pins = parsePins(pinsText);
  if (!pins.has('cslkit.mjs')) throw new Error('the pinned list does not name cslkit.mjs');
  checkPins(dir, pins);
  const kit = await import(pathToFileURL(join(dir, 'cslkit.mjs')).href);
  if (!kit.CSL) throw new Error('cslkit.mjs exports no CSL');
  return kit.CSL;
}

// The minimum coin of an output as it is written in the transaction: coins
// per UTxO byte times (160 plus the output's serialized size). This is the
// ledger's rule (IntersectMBO/cardano-ledger at
// 391db20866113f08bc6317cb5c341304365986c6, eras/babbage/impl/src/Cardano/
// Ledger/Babbage/TxOut.hs:678-702, babbageMinUTxOValue) and what the kit's
// minimum check computes. CSL's min_ada_for_output is not used: it measures
// the output after decoding and re-encoding it, and writes a map-form output
// without a datum or a reference script back as an array, 2 bytes shorter.
export function minAdaForOutput(outputBytes, coinsPerUtxoByte) {
  return BigInt(coinsPerUtxoByte) * (160n + BigInt(outputBytes.length));
}
