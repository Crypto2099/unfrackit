// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The node's own UTxO query by address (pre-registration section 8,
// "Indexer correctness", and artifact A1), which does not depend on
// cardano-db-sync: cardano-cli of the node's release, run inside the node's
// container with `docker exec`, `query utxo --address ... --output-json`. It
// reads the node's ledger state at its tip and changes nothing.

import { execFileSync } from 'node:child_process';

export function nodeTip({ container, magic, socket }) {
  const args = ['exec', container, 'cardano-cli', 'query', 'tip', '--socket-path', socket, ...networkArgs(magic)];
  return JSON.parse(execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 1 << 20 }));
}

export function nodeUtxoByAddress({ container, magic, socket }, address) {
  if (!/^addr(_test)?1[0-9a-z]+$/.test(address)) throw new Error(`not a Shelley address: ${address}`);
  const args = ['exec', container, 'cardano-cli', 'query', 'utxo', '--address', address, '--socket-path', socket, '--output-json', ...networkArgs(magic)];
  return JSON.parse(execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 1 << 28 }));
}

function networkArgs(magic) {
  return magic === 'mainnet' ? ['--mainnet'] : ['--testnet-magic', String(magic)];
}
