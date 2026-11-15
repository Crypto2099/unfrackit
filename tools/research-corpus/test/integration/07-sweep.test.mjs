// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// T8. Equivalence sweep: 1,000 random preprod credentials at 20 random blocks;
// the reference query and the life table give identical sets. The draw is
// reproducible: credentials and blocks are ordered by MD5 of their id with a
// fixed salt. Credentials are drawn from those with at least one output, and
// blocks from those up to the snapshot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, blocks, record, RUN_B } from './env.mjs';
import { q } from '../../src/db.mjs';
import { digests } from '../../src/reconstruction-check.mjs';

const SALT = 'research-corpus T8';

test('T8 reference query and life table agree on 1,000 credentials at 20 blocks', { timeout: 3 * 3600 * 1000 }, async () => {
  const c = await db();
  try {
    const snap = (await c.query(`SELECT value FROM study.param WHERE run_id = $1 AND key = 'snapshot'`, [RUN_B])).rows[0].value;
    const settings = (await c.query(`SELECT value FROM study.param WHERE run_id = $1 AND key = 'settings'`, [RUN_B])).rows[0].value;
    const x1 = { x1_enterprise: { type: 'bool', value: settings.x1_enterprise } };
    const creds = (await c.query(`SELECT sa_id FROM (SELECT DISTINCT sa_id FROM study.txo) s ORDER BY md5(sa_id::text || $1) LIMIT 1000`, [SALT])).rows.map((r) => String(r.sa_id));
    const blks = (await c.query(`SELECT id FROM public.block WHERE id <= $1 ORDER BY md5(id::text || $2) LIMIT 20`, [snap.id, SALT])).rows.map((r) => Number(r.id)).sort((a, b) => a - b);
    let pairs = 0;
    let nonEmpty = 0;
    let utxos = 0;
    const perBlock = [];
    for (const b of blks) {
      const t = Number((await q(c, blocks, 't_of_block', { block_id: { type: 'int', value: b } }))[0].t);
      const ref = await digests(c, blocks, 'digest_ref', creds, { ...x1, block_id: { type: 'int', value: b } });
      const life = await digests(c, blocks, 'digest_life', creds, { ...x1, t: { type: 'int', value: t } });
      let ne = 0;
      for (const id of creds) {
        assert.deepEqual(ref.get(id), life.get(id), `credential ${id} at block ${b}`);
        pairs++;
        if (life.get(id).n > 0) {
          ne++;
          utxos += life.get(id).n;
        }
      }
      nonEmpty += ne;
      perBlock.push({ block_id: b, t, non_empty: ne });
    }
    record('T8', { credentials: creds.length, blocks: blks.length, pairs, non_empty_pairs: nonEmpty, utxos_compared: utxos, per_block: perBlock });
    assert.equal(pairs, 20000);
  } finally {
    await c.end();
  }
});
