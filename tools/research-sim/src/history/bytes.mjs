// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Where a transaction's bytes come from, and the check every read passes.
//
// - 'tx_cbor': db-sync's tx_cbor table (doc/schema.md, tx_cbor), kept when
//   db-sync runs with its tx_cbor option on, as on preprod.
// - 'immutable': the node's ImmutableDB, as immutable.mjs reads it; the
//   mainnet source, since the mainnet database runs with tx_cbor off.
//
// Every transaction read from either source must hash to db-sync's
// transaction hash (BLAKE2b-256 of the body bytes) and have the size db-sync
// records (tx.size, the ledger's size, tx.mjs); a mismatch stops the read
// with the transaction named.

import { q } from './db.mjs';
import { decodeTx } from './tx.mjs';

export class ByteMismatch extends Error {}

export function checkTx(decoded, row) {
  if (decoded.hash !== row.hash) throw new ByteMismatch(`transaction ${row.hash}: the bytes read hash to ${decoded.hash}`);
  if (decoded.size !== Number(row.size)) throw new ByteMismatch(`transaction ${row.hash}: the bytes read have size ${decoded.size}, db-sync records ${row.size}`);
}

export class TxBytes {
  constructor({ client, blocks, mode, immutable = null }) {
    if (mode !== 'tx_cbor' && mode !== 'immutable') throw new Error(`unknown byte source ${mode}`);
    if (mode === 'immutable' && !immutable) throw new Error('the immutable byte source needs an ImmutableDB reader');
    this.client = client;
    this.blocks = blocks;
    this.mode = mode;
    this.immutable = immutable;
    this.reads = 0;
  }

  // rows: tx rows of the `txs` query. Returns a Map from tx id to the decoded
  // transaction.
  async fetch(rows) {
    const out = new Map();
    if (!rows.length) return out;
    let raw;
    if (this.mode === 'tx_cbor') {
      raw = new Map();
      const got = await q(this.client, this.blocks, 'tx_cbor', { ids: { type: 'intarr', value: rows.map((r) => r.id) } });
      for (const g of got) raw.set(Number(g.tx_id), g.bytes);
    } else {
      raw = await this.immutable.readTxs(rows.map((r) => ({ txId: Number(r.id), blockHash: r.block_hash, slot: Number(r.slot_no), blockIndex: Number(r.block_index) })));
    }
    for (const r of rows) {
      const b = raw.get(Number(r.id));
      if (!b) throw new ByteMismatch(`transaction ${r.hash}: no bytes in ${this.mode}`);
      const d = decodeTx(b);
      checkTx(d, r);
      out.set(Number(r.id), d);
      this.reads++;
    }
    return out;
  }
}
