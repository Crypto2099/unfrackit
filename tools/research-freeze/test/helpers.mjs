// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VECTOR_DIR = new URL('./vectors/label-309-v0.10.0/', import.meta.url);

export function vector(rel) {
  return JSON.parse(fs.readFileSync(new URL(rel, VECTOR_DIR), 'utf8'));
}

export const hex = (b) => Buffer.from(b).toString('hex');
export const unhex = (h) => new Uint8Array(Buffer.from(h, 'hex'));

// A fresh home outside any git working tree.
export function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-freeze-test-'));
  fs.chmodSync(dir, 0o700);
  return path.join(dir, 'home');
}

export function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-freeze-files-'));
  return dir;
}

// The three public BIP-39 test mnemonics whose entropy is the CIP-190 seed of
// the label-309 seed-derive vectors (all-zero, all-ff, deadbeef repeated).
// They must never hold a real key.
export const VECTOR_MNEMONICS = [
  { mnemonic: `${'abandon '.repeat(23)}art`, seed: '00'.repeat(32), pub: '91d8c1a126ce8242f232e7301570256b0e1bda2c2fdff752948a006f2fa31049', file: 'seed-derive/seed-from-zero.json' },
  { mnemonic: `${'zoo '.repeat(23)}vote`, seed: 'ff'.repeat(32), pub: '7c3d14749a5659ea1057d97ca669a279f56ca8f10d5a0df1ecd374fea1cab188', file: 'seed-derive/seed-from-ff.json' },
  {
    mnemonic: 'team hospital room run swim jewel kingdom result used voice hurry text turn term satoshi stick same leave problem lava worth fine wing utility',
    seed: 'deadbeef'.repeat(8),
    pub: '0271dc3cd9299eab854989444f656b22d17689bc716ed7663a3cb0f26ccbcfa8',
    file: 'seed-derive/seed-from-deadbeef.json'
  }
];
