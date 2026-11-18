// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Shared setup for the preprod integration tests of the history reader.
// They run against a preprod cardano-db-sync database through a read-only
// role and refuse any other network.
//
// Environment:
//   PGHOST PGPORT PGDATABASE PGUSER PGPASSFILE   the preprod database and its read-only role
//   RESEARCH_SIM_TREATMENT_DIR                   the treatment's harness directory (CSL comes through its cslkit.mjs)
//   RESEARCH_SIM_TREATMENT_PINS                  the SHA-256 list of the treatment files
//   RESEARCH_SIM_SEEDER_DIR                      the preprod seeder's folder (tools/preprod-seeder)
//   RESEARCH_SIM_IMMUTABLE_HOST                  the host of preprod's node chain database, over SSH
//   RESEARCH_SIM_IMMUTABLE_DIR                   its ImmutableDB directory there
//   RESEARCH_SIM_TEST_TAG                        names the results directory
//   RESEARCH_SIM_SNAPSHOT                        the snapshot block (id or hash) every test reads as of;
//                                                db-sync keeps following the chain while the tests run,
//                                                so the tests name one block rather than the tip
//
// The seeder is used only through its documented commands `address <shape>`
// and `verify <shape>`, run from its folder, and through its deterministic
// specification generator generate(<shape>), which touches no key. Results go
// to the private run directory, never the repository.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeContext } from '../../../src/history/commands.mjs';
import { runDir, writeJson } from '../../../src/history/paths.mjs';
import { decode as bech32decode, encode as bech32encode } from '../../../src/history/bech32.mjs';
import { q } from '../../../src/history/db.mjs';

export const TAG = process.env.RESEARCH_SIM_TEST_TAG || 'tests';
export const SEEDER = process.env.RESEARCH_SIM_SEEDER_DIR;
export const SHAPES = ['S1', 'S2', 'S2b', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'M1', 'M2', 'M3', 'M4', 'M5', 'M7', 'M8'];

export const SNAPSHOT = process.env.RESEARCH_SIM_SNAPSHOT || 'tip';

export async function context(opts = {}) {
  return makeContext({
    expectNetwork: 'preprod',
    snapshot: SNAPSHOT,
    treatment: process.env.RESEARCH_SIM_TREATMENT_DIR,
    treatmentPins: process.env.RESEARCH_SIM_TREATMENT_PINS,
    ...opts
  });
}

export const immutableOpts = () => ({ bytes: 'immutable', immutableHost: process.env.RESEARCH_SIM_IMMUTABLE_HOST, immutableDir: process.env.RESEARCH_SIM_IMMUTABLE_DIR });

export function record(name, value) {
  writeJson(join(runDir('preprod', TAG), 'tests', `${name}.json`), value);
}

export function seederAddresses(shape) {
  if (!SEEDER) throw new Error('set RESEARCH_SIM_SEEDER_DIR');
  const out = execFileSync('node', ['src/cli.mjs', 'address', shape], { cwd: SEEDER, encoding: 'utf8' });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

export async function specOf(shape) {
  const { generate } = await import(pathToFileURL(join(SEEDER, 'src', 'shapes.mjs')).href);
  return generate(shape);
}

// The stake address of a base address (CIP-19, "Stake Addresses").
export function stakeOf(address) {
  const b = bech32decode(address).bytes;
  return bech32encode('stake_test', Buffer.concat([Buffer.from([0xe0 | (b[0] & 15)]), b.subarray(29, 57)]));
}

export async function saIdOf(ctx, view) {
  const r = await q(ctx.client, ctx.blocks, 'wallet_by_view', { view: { type: 'text', value: view } });
  return r.length ? Number(r[0].id) : null;
}

export async function shapeWallets(ctx) {
  const out = {};
  for (const s of SHAPES) out[s] = await saIdOf(ctx, stakeOf(seederAddresses(s)[0]));
  out.funder = await saIdOf(ctx, stakeOf(seederAddresses('funder')[0]));
  return out;
}
