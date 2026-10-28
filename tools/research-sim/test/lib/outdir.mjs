// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Where the oracle's checks write their records: RESEARCH_SIM_ORACLE_OUT, or
// the simulator's private run directory,
// ${XDG_DATA_HOME:-$HOME/.local/share}/unfrackit-research/sim/synthetic/
// oracle-checks-<time>/, directories 0700 and files 0600, never the
// repository.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function oracleOutDir() {
  if (process.env.RESEARCH_SIM_ORACLE_OUT) {
    mkdirSync(process.env.RESEARCH_SIM_ORACLE_OUT, { recursive: true, mode: 0o700 });
    return process.env.RESEARCH_SIM_ORACLE_OUT;
  }
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const d = join(base, 'unfrackit-research', 'sim', 'synthetic', `oracle-checks-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

export const envNumber = (name, dflt) => (process.env[name] ? Number(process.env[name]) : dflt);
