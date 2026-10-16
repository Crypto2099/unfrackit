// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The pinned cardanowall CLI (0.12.0) over the record and validator vectors:
// its `verify --record` verdicts and error codes must be the ones the vectors
// expect. Skipped, with a notice, when the CLI is not installed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validatePoeRecord } from '@cardanowall/poe-standard';
import { Cardanowall, findCli } from '../src/cardanowall.mjs';
import { vector, tempDir } from './helpers.mjs';

const bin = findCli();
const skip = bin ? false : 'the cardanowall CLI 0.12.0 is not installed (PATH or RESEARCH_FREEZE_CARDANOWALL); skipping its checks';
if (skip) process.stderr.write(`NOTICE: ${skip}\n`);

function verifyRecord(cli, dir, hex, profile) {
  const f = path.join(dir, `${Math.random().toString(16).slice(2)}.hex`);
  fs.writeFileSync(f, hex);
  const r = cli.json(['verify', '--record', f, '--json', '--no-fetch', '--profile', profile]);
  return { exit: r.status, report: r.json || {}, errors: [...new Set((r.json?.issues || []).filter((i) => i.severity === 'error').map((i) => i.code))].sort() };
}

const sdkDefaultErrors = (hex) => {
  const r = validatePoeRecord(new Uint8Array(Buffer.from(hex, 'hex')));
  return r.valid ? [] : [...new Set(r.issues.filter((i) => i.severity === 'error').map((i) => i.code))].sort();
};

test('cardanowall reports version 0.12.0 at commit 5400a64', { skip }, () => {
  const cli = new Cardanowall(bin);
  assert.match(cli.version, /^cardanowall 0\.12\.0 \(git 5400a64/);
});

test('cardanowall verify --record over the validator corpora gives the pinned verdicts and codes', { skip }, () => {
  const cli = new Cardanowall(bin);
  const dir = tempDir();
  let n = 0;
  for (const file of ['validator/validator-positive.json', 'validator/validator-negative.json']) {
    for (const v of vector(file).vectors) {
      // A vector that names validator options (a supported critical
      // extension, tighter bounds) assumes a configuration the CLI does not
      // expose; the CLI is then held to the default-configured validator.
      const expected = v.validator_options ? sdkDefaultErrors(v.cbor_hex) : [...v.expected_error_codes].sort();
      for (const profile of ['core', 'signed']) {
        const r = verifyRecord(cli, dir, v.cbor_hex, profile);
        assert.deepEqual(r.errors, expected, `${file} ${v.name} (${profile})`);
        assert.equal(r.report.verdict, expected.length ? 'failed' : 'valid', `${v.name} verdict`);
        assert.equal(r.exit, expected.length ? 1 : 0, `${v.name} exit`);
        n++;
      }
    }
  }
  assert.equal(n, 188);
});

test('cardanowall verify --record over the poe-record vectors', { skip }, () => {
  const cli = new Cardanowall(bin);
  const dir = tempDir();
  const max = vector('poe-record/maximal-record-with-extension-keys.json');
  const r = verifyRecord(cli, dir, max.cbor_hex, 'signed');
  assert.deepEqual(r.errors, ['EXTENSION_UNSUPPORTED_CRITICAL'], 'the record lists x-note in crit; a default verifier implements no critical extension');
  assert.deepEqual(r.errors, sdkDefaultErrors(max.cbor_hex));
  const mixed = vector('poe-record/mixed-signature-record.json');
  for (const v of mixed.vectors) {
    const m = verifyRecord(cli, dir, v.cbor_hex, 'signed');
    assert.equal(m.exit, 0, v.name);
    assert.equal(m.report.verdict, 'valid', v.name);
    const sigs = m.report.signatures.map((s) => ({ index: s.index, signer_type: s.signerType, signer_pub_hex: s.signerPub, ok: s.verdict === 'valid' }));
    assert.deepEqual(sigs, v.expected_signer_verdicts, v.name);
  }
});
