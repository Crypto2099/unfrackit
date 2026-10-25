#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The research-sim command line. Each command lives in its own module; this
// file only dispatches.

import { formatHashList } from './hash.mjs';

const COMMANDS = {
  hash: async () => process.stdout.write(formatHashList()),
  help: async () => process.stdout.write(HELP)
};

const HELP = `research-sim <command> [options]

  hash             SHA-256 of every hashed file, the pinned dependencies and the Node version
`;

const [cmd] = process.argv.slice(2);
const fn = COMMANDS[cmd || 'help'];
if (!fn) {
  process.stderr.write(`unknown command ${cmd}\n${HELP}`);
  process.exit(2);
}
try {
  await fn();
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}
