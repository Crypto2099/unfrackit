// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The treatment for the tests that need it: RESEARCH_SIM_TREATMENT_DIR names
// the harness directory, and RESEARCH_SIM_TREATMENT_PINS a pins file (the
// simulator's own data/treatment-pins.txt by default). Without the directory
// these tests are skipped.

import { readFileSync } from 'node:fs';
import { loadTreatment } from '../../src/treatment/bridge.mjs';

export const TREATMENT_DIR = process.env.RESEARCH_SIM_TREATMENT_DIR || null;
export const skip = TREATMENT_DIR ? false : 'set RESEARCH_SIM_TREATMENT_DIR to the treatment directory';

export async function treatment() {
  if (!TREATMENT_DIR) return null;
  const pins = process.env.RESEARCH_SIM_TREATMENT_PINS ? readFileSync(process.env.RESEARCH_SIM_TREATMENT_PINS, 'utf8') : undefined;
  return loadTreatment(TREATMENT_DIR, pins);
}
