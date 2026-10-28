// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { oracleOutDir } from '../../lib/outdir.mjs';

test('the oracle checks write under RESEARCH_SIM_HOME, and RESEARCH_SIM_ORACLE_OUT overrides it', () => {
  const home = mkdtempSync(join(tmpdir(), 'research-sim-outdir-'));
  const saved = { h: process.env.RESEARCH_SIM_HOME, o: process.env.RESEARCH_SIM_ORACLE_OUT };
  try {
    delete process.env.RESEARCH_SIM_ORACLE_OUT;
    process.env.RESEARCH_SIM_HOME = home;
    const d = oracleOutDir();
    assert.equal(dirname(dirname(d)), home);
    assert.match(d, /\/synthetic\/oracle-checks-/);
    assert.equal(statSync(d).mode & 0o777, 0o700);
    process.env.RESEARCH_SIM_ORACLE_OUT = join(home, 'elsewhere');
    assert.equal(oracleOutDir(), join(home, 'elsewhere'));
  } finally {
    for (const [k, v] of [['RESEARCH_SIM_HOME', saved.h], ['RESEARCH_SIM_ORACLE_OUT', saved.o]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
