// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Pre-registration section 6.1, the check: every sampled wallet's UTxO set at the
// snapshot from the reference query, the life table and the set read
// directly, compared by count and digest. Wallets are processed in batches by
// id, one query per implementation per batch.

import { q, qBound } from './db.mjs';

export async function digests(client, blocks, which, saIds, params) {
  const rows = await q(client, blocks, which, { ...params, sa_ids: { type: 'intarr', value: saIds } });
  return new Map(rows.map((r) => [String(r.sa_id), { n: Number(r.n), d: r.digest }]));
}

export async function check61({ client, blocks, run, params, log = () => {}, batch = 500 }) {
  const ids = (await q(client, blocks, 'sample_wallet_ids')).map((r) => String(r.sa_id));
  const tip = (await q(client, blocks, 'tip_block'))[0];
  const directValid = Number(tip.id) === run.snapshot.id;
  if (!directValid) log(`check 6.1: database tip ${tip.block_no} is not the snapshot block ${run.snapshot.block_no}; the direct read is skipped`);
  const out = [];
  for (let i = 0; i < ids.length; i += batch) {
    const part = ids.slice(i, i + batch);
    const ref = await digests(client, blocks, 'digest_ref', part, { ...params, block_id: { type: 'int', value: run.snapshot.id } });
    const life = await digests(client, blocks, 'digest_life', part, { ...params, t: { type: 'int', value: run.snapshot.t } });
    const direct = directValid ? await digests(client, blocks, 'digest_direct', part, params) : null;
    for (const id of part) {
      const r = ref.get(id);
      const l = life.get(id);
      const d = direct ? direct.get(id) : null;
      const agree = r.d === l.d && r.n === l.n && (!d || (d.d === l.d && d.n === l.n));
      out.push({ sa_id: Number(id), n_ref: r.n, d_ref: r.d, n_life: l.n, d_life: l.d, n_direct: d ? d.n : null, d_direct: d ? d.d : null, direct_valid: directValid, agree });
    }
    log(`check 6.1: ${Math.min(i + batch, ids.length)}/${ids.length} wallets`);
  }
  await qBound(client, blocks, 'check_61_load', [JSON.stringify(out)]);
  return { wallets: ids.length, direct_valid: directValid, tip_block_no: Number(tip.block_no), disagree: out.filter((x) => !x.agree).map((x) => x.sa_id) };
}
