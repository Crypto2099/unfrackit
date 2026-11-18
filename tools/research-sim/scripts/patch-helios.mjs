#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Applies the one change to the installed @helios-lang/ledger that
// src/methods/helios-source.mjs describes (`npm ci` runs it as postinstall):
//
//   node scripts/patch-helios.mjs
//
// The file's SHA-256 must be the pinned original (or already the pinned
// patched file, which leaves it as it is) before the change, and the pinned
// patched one after it; any other content stops the script with exit code 1
// and writes nothing. Making the Helios method refuses unless the installed
// file hashes to the patched pin.

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { HELIOS_LEDGER_TX_PATH, HELIOS_TX_ORIGINAL_SHA256, HELIOS_TX_PATCHED_SHA256, presumeScriptValidation } from '../src/methods/helios-source.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
try {
  const file = createRequire(import.meta.url).resolve(HELIOS_LEDGER_TX_PATH);
  const text = readFileSync(file, 'utf8');
  const before = sha(text);
  if (before === HELIOS_TX_PATCHED_SHA256) {
    console.log(`${file} is already patched (${before})`);
  } else {
    if (before !== HELIOS_TX_ORIGINAL_SHA256) throw new Error(`${file} hashes to ${before}, not the pinned ${HELIOS_TX_ORIGINAL_SHA256}`);
    const patched = presumeScriptValidation(text);
    const after = sha(patched);
    if (after !== HELIOS_TX_PATCHED_SHA256) throw new Error(`the patched file hashes to ${after}, not the pinned ${HELIOS_TX_PATCHED_SHA256}`);
    writeFileSync(file, patched);
    console.log(`${file} patched: ${before} to ${after}`);
  }
} catch (e) {
  console.error(`patch-helios: ${e.message}`);
  process.exit(1);
}
