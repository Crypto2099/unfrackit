#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The research-sim command line. Each command lives in its own module; this
// file only dispatches.

import { formatHashList } from './hash.mjs';
import { parseArgs, cmdHistory } from './history/commands.mjs';
import { cmdCensus, cmdNearCap, cmdCollateral, cmdBatteryPools } from './history/reports.mjs';

const COMMANDS = {
  hash: async () => process.stdout.write(formatHashList()),
  history: async (o) => report(await cmdHistory(o)),
  census: async (o) => report(await cmdCensus(o)),
  'near-cap': async (o) => report(await cmdNearCap(o)),
  collateral: async (o) => report(await cmdCollateral(o)),
  'battery-pools': async (o) => report(await cmdBatteryPools(o)),
  help: async () => process.stdout.write(HELP)
};

const HELP = `research-sim <command> [options]

  hash             SHA-256 of every hashed file, the pinned dependencies and the Node version
  history          history files and snapshot states for given wallets and windows
  census           the H-8 census over a set of wallets at the snapshot
  near-cap         near-cap prevalence at every epoch boundary over a set of wallets
  collateral       the collateral measurement over the recent window
  battery-pools    the T1 amounts and T5 shares of a run's history files

See the README for the options of each.
`;

// What a command prints: its summary without wallet-level data.
function report(summary) {
  if (summary && summary.print) process.stdout.write(JSON.stringify(summary.print, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
}

const [cmd, ...rest] = process.argv.slice(2);
const fn = COMMANDS[cmd || 'help'];
if (!fn) {
  process.stderr.write(`unknown command ${cmd}\n${HELP}`);
  process.exit(2);
}
try {
  await fn(parseArgs(rest));
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}
