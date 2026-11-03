// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The specification and reference-implementation versions the record format
// is pinned to, written into every run report.

import fs from 'node:fs';

export const PINS = Object.freeze({
  cip190: 'cardano-foundation/CIPs CIP-0190 at merge commit 58b4dd1417e139595dfabc92467d49bb3ffc0a07',
  label309: 'cardanowall/label-309 tag v0.10.0 (commit a51bad8d31669ccbf533bac6ec8c39dd38ff0388)',
  vectors: 'cardanowall/label-309 conformance vectors at commit a51bad8d31669ccbf533bac6ec8c39dd38ff0388',
  sdk: 'cardanowall/label-309-ts tag v0.12.0 (commit f7e9b82)',
  cli: 'cardanowall/label-309-cli tag v0.12.0 (commit 5400a64)'
});

function pkgVersion(name) {
  try {
    return JSON.parse(fs.readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

export function versions(cli) {
  return {
    tool: pkgVersion('..'),
    node: process.version,
    'cardano-serialization-lib-nodejs': pkgVersion('@emurgo/cardano-serialization-lib-nodejs'),
    'sdk-ts': pkgVersion('@cardanowall/sdk-ts'),
    'poe-standard': pkgVersion('@cardanowall/poe-standard'),
    'crypto-core': pkgVersion('@cardanowall/crypto-core'),
    bip39: pkgVersion('bip39'),
    cardanowall: cli ? cli.version : 'not available',
    cardanowall_sha256: cli ? cli.sha256 : null,
    pins: PINS
  };
}
