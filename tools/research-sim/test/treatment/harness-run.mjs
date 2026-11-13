// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A fresh run of the treatment harness's own runners, in a copy of the
// harness directory, so that the comparison is run against run and the
// harness's own results files are never written. The copy's treatment files
// are checked against the pins before anything runs; node_modules is linked,
// not copied.

import { mkdtempSync, readdirSync, statSync, copyFileSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parsePins, checkPins } from '../../src/history/csl.mjs';
import { DEFAULT_PINS } from '../../src/treatment/bridge.mjs';

export function harnessCopy(dir, pinsText = readFileSync(DEFAULT_PINS, 'utf8')) {
  const copy = mkdtempSync(join(tmpdir(), 'research-sim-harness-'));
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isFile()) copyFileSync(p, join(copy, f));
  }
  symlinkSync(join(dir, 'node_modules'), join(copy, 'node_modules'), 'dir');
  mkdirSync(join(copy, 'results'));
  checkPins(copy, parsePins(pinsText));
  return copy;
}

// Runs `script` in the copy and returns its results JSON.
export function runHarness(copy, script, resultFile) {
  execFileSync(process.execPath, [script], { cwd: copy, stdio: ['ignore', 'ignore', 'pipe'], timeout: 30 * 60 * 1000, maxBuffer: 1 << 26 });
  return JSON.parse(readFileSync(join(copy, 'results', resultFile), 'utf8'));
}
