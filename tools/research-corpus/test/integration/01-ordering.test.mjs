// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// T1. Ordering: no block has previous_id >= id; ordering transactions by
// (block_id, block_index) equals ordering by id.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, blocks, record } from './env.mjs';
import { q } from '../../src/db.mjs';

test('T1 block and transaction ids increase along the chain', async () => {
  const c = await db();
  try {
    await c.query("SET work_mem = '1GB'");
    const r = Object.fromEntries(Object.entries((await q(c, blocks, 'order_check'))[0]).map(([k, v]) => [k, Number(v)]));
    record('T1', r);
    assert.equal(r.blocks_out_of_order, 0);
    assert.equal(r.blocks_not_after_previous, 0);
    assert.equal(r.tx_out_of_order, 0);
    assert.equal(r.tx_index_repeated, 0);
  } finally {
    await c.end();
  }
});
