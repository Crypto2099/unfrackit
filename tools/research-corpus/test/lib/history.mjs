// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Every transaction that created or consumed an output of a wallet, from the
// life table, with its block, mints and burns, metadata, and the credentials
// of its inputs and outputs (tests T5, T6 and T11).

export async function history(c, sa) {
  const r = await c.query(
    `WITH ev AS (
       SELECT created_tx AS tx, 1 AS created, 0 AS consumed FROM study.txo WHERE sa_id = $1
       UNION ALL
       SELECT consumed_tx, 0, 1 FROM study.txo WHERE sa_id = $1 AND consumed_tx IS NOT NULL)
     SELECT ev.tx, encode(t.hash, 'hex') AS hash, t.block_id, b.block_no, b.slot_no, b.time::text AS time,
            sum(created) AS n_created, sum(consumed) AS n_consumed,
            (SELECT count(*) FROM public.ma_tx_mint m WHERE m.tx_id = ev.tx AND m.quantity = -1) AS n_burn_one,
            (SELECT count(*) FROM public.ma_tx_mint m WHERE m.tx_id = ev.tx) AS n_mint_rows,
            (SELECT count(*) FROM public.tx_metadata x WHERE x.tx_id = ev.tx) AS n_metadata,
            (SELECT count(*) FROM public.tx_in i WHERE i.tx_in_id = ev.tx) AS n_inputs,
            (SELECT array_agg(DISTINCT o.stake_address_id) FROM public.tx_in i JOIN public.tx_out o ON o.tx_id = i.tx_out_id AND o.index = i.tx_out_index
              WHERE i.tx_in_id = ev.tx) AS input_creds,
            (SELECT array_agg(DISTINCT o.stake_address_id) FROM public.tx_out o WHERE o.tx_id = ev.tx) AS output_creds
       FROM ev JOIN public.tx t ON t.id = ev.tx JOIN public.block b ON b.id = t.block_id
      GROUP BY ev.tx, t.hash, t.block_id, b.block_no, b.slot_no, b.time ORDER BY ev.tx`,
    [sa]
  );
  return r.rows.map((x) => ({
    tx: Number(x.tx),
    hash: x.hash,
    block_id: Number(x.block_id),
    block_no: Number(x.block_no),
    slot_no: Number(x.slot_no),
    time: x.time,
    n_created: Number(x.n_created),
    n_consumed: Number(x.n_consumed),
    n_burn_one: Number(x.n_burn_one),
    n_mint_rows: Number(x.n_mint_rows),
    n_metadata: Number(x.n_metadata),
    n_inputs: Number(x.n_inputs),
    input_creds: (x.input_creds || []).map((v) => (v === null ? null : Number(v))),
    output_creds: (x.output_creds || []).map((v) => (v === null ? null : Number(v)))
  }));
}
