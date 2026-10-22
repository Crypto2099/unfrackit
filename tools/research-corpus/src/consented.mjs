// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The consented file's commitment (decided 2026-10-21): SHA-256 of a private
// 32-byte random salt followed by the file's bytes. The digest is an item of
// the final freeze record; the file and the salt stay private and can be
// shown to an auditor. The salt keeps the digest from confirming a guess about
// which addresses the file lists. A study run on mainnet refuses a consented
// file that does not give the committed digest.
//
// The salt sits next to the file (<file>.salt unless another path is given),
// mode 0600, created once with exclusive create, never printed.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync, openSync, writeSync, closeSync, chmodSync } from 'node:fs';
import { assertPrivate } from './paths.mjs';

export const SALT_BYTES = 32;
export const saltPathOf = (file, salt) => salt || `${file}.salt`;

export function consentedCommitment(file, salt) {
  const path = saltPathOf(file, salt);
  assertPrivate(path);
  const s = readFileSync(path);
  if (s.length !== SALT_BYTES) throw new Error(`the salt must be ${SALT_BYTES} bytes`);
  return createHash('sha256').update(Buffer.concat([s, readFileSync(file)])).digest('hex');
}

// Makes the salt if it does not exist yet; returns the commitment and whether
// the salt was made now.
export function commitConsented(file, salt) {
  const path = saltPathOf(file, salt);
  assertPrivate(file);
  let made = false;
  if (!existsSync(path)) {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeSync(fd, randomBytes(SALT_BYTES));
    } finally {
      closeSync(fd);
    }
    chmodSync(path, 0o600);
    made = true;
  }
  return { sha256: consentedCommitment(file, salt), salt_path: path, made };
}
