// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { UserError } from './util.mjs';

export function requireTty(what, streams = { stdin: process.stdin, stdout: process.stdout }) {
  if (!streams.stdin.isTTY || !streams.stdout.isTTY) {
    throw new UserError(`${what} requires an interactive terminal on both stdin and stdout; refusing`);
  }
}

// The mainnet guard: an interactive terminal, the facts of what is about to
// be sent (`facts`, a list of [label, value] pairs), and the operator typing
// the first eight hex digits of the transaction hash.
export async function confirmMainnet(txHash, what, streams = { stdin: process.stdin, stdout: process.stdout }, facts = []) {
  requireTty(`${what} on mainnet`, streams);
  const width = Math.max(0, ...facts.map(([k]) => k.length));
  const lines = facts.map(([k, v]) => `  ${`${k}:`.padEnd(width + 1)} ${v}`);
  const rl = readline.createInterface({ input: streams.stdin, output: streams.stdout });
  try {
    const answer = await rl.question(`MAINNET ${what} of ${txHash}.\n${lines.length ? `${lines.join('\n')}\n` : ''}Type the first eight hex digits of the transaction hash to continue: `);
    if (answer.trim().toLowerCase() !== txHash.slice(0, 8)) throw new UserError('the digits did not match; nothing was sent');
  } finally {
    rl.close();
  }
}

// Read one line without echoing it: the typed characters go to a muted
// output, so a mnemonic typed here is never shown on the screen. The
// interface (which puts a terminal into raw mode) exists before the prompt
// is shown, so nothing typed after the prompt is echoed by the terminal.
export async function askHidden(question, streams = { stdin: process.stdin, stdout: process.stdout }) {
  const muted = new Writable({ write: (_chunk, _enc, cb) => cb() });
  const rl = readline.createInterface({ input: streams.stdin, output: muted, terminal: Boolean(streams.stdin.isTTY && typeof streams.stdin.setRawMode === 'function') });
  try {
    const answer = rl.question('');
    streams.stdout.write(question);
    return await answer;
  } finally {
    rl.close();
    streams.stdout.write('\n');
  }
}
