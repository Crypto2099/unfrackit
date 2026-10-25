#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The research-sim command line. Each command lives in its own module; this
// file only dispatches.

import { formatHashList } from './hash.mjs';
import { parseArgs, cmdHistory } from './history/commands.mjs';

const COMMANDS = {
  hash: async () => process.stdout.write(formatHashList()),
  history: async (o) => report(await cmdHistory(o)),
  help: async () => process.stdout.write(HELP)
};

const HELP = `research-sim <command> [options]

  hash             SHA-256 of every hashed file, the pinned dependencies and the Node version
  history          history files and snapshot states for given wallets and windows

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
