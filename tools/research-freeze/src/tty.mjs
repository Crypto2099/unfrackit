// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import readline from 'node:readline/promises';
import { UserError } from './util.mjs';

export function requireTty(what, streams = { stdin: process.stdin, stdout: process.stdout }) {
  if (!streams.stdin.isTTY || !streams.stdout.isTTY) {
    throw new UserError(`${what} requires an interactive terminal on both stdin and stdout; refusing`);
  }
}

// The mainnet guard: an interactive terminal and the operator typing the
// first eight hex digits of the transaction hash.
export async function confirmMainnet(txHash, what, streams = { stdin: process.stdin, stdout: process.stdout }) {
  requireTty(`${what} on mainnet`, streams);
  const rl = readline.createInterface({ input: streams.stdin, output: streams.stdout });
  try {
    const answer = await rl.question(`MAINNET ${what} of ${txHash}.\nType the first eight hex digits of the transaction hash to continue: `);
    if (answer.trim().toLowerCase() !== txHash.slice(0, 8)) throw new UserError('the digits did not match; nothing was sent');
  } finally {
    rl.close();
  }
}
