// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Published identifiers: HMAC-SHA256 of the stake address under a 32-byte
// secret generated for the study, truncated to 16 hex characters.
// The input is read as the credential's 29-byte reward address
// (stake_address.hash_raw); the setting x15_bech32 uses its bech32 text instead.
// The key is read from secret/hmac.key in Node only; it never reaches
// PostgreSQL, a log, the run directory or the repository. The secret is
// distinct from the public draw key h.

import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { hmacKeyPath, createExclusive, assertPrivate } from './paths.mjs';

export const KEY_BYTES = 32;
export const ID_HEX = 16;

export function initSecret() {
  const path = hmacKeyPath();
  if (existsSync(path)) throw new Error(`${path} already exists; the study key is made once`);
  createExclusive(path, randomBytes(KEY_BYTES));
  return path;
}

export function loadKey(path = hmacKeyPath()) {
  assertPrivate(path);
  const key = readFileSync(path);
  if (key.length !== KEY_BYTES) throw new Error(`${path} must hold ${KEY_BYTES} bytes, found ${key.length}`);
  return key;
}

// input: a Buffer (29-byte reward address) or a string (bech32).
export function identifier(key, input) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('HMAC key must be 32 bytes');
  return createHmac('sha256', key).update(input).digest('hex').slice(0, ID_HEX);
}
