// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Mainnet time projections from a preprod run. Each step is scaled linearly by
// the row count of the db-sync table that dominates it: preprod seconds times
// mainnet rows over preprod rows. The row counts come from pg_class.reltuples
// on each database (the `health` command), a storage fact that may be read on
// mainnet before the freeze; no mainnet query plan is read. Steps over the
// sample only (the per-wallet steps) are scaled by the ratio of sampled
// wallets and of their history instead, which preprod cannot measure, so they
// are reported at preprod size with that caveat. Linear scaling understates
// the sort and hash steps that spill to disk at mainnet size.

export const DRIVER = {
  epoch_counts: 'tx',
  peak_runs: null,
  era_report: null,
  cred: 'stake_address',
  consented_table: null,
  txo: 'tx_out',
  txo_asset: 'ma_tx_out',
  asset: 'multi_asset',
  activity: 'tx_out',
  state: 'tx_out',
  paycount: 'tx_out',
  frame: 'stake_address',
  flow: 'stake_address',
  draw: 'stake_address',
  strata_list_table: null,
  ft_floor: 'ma_tx_out',
  nft_top: 'ma_tx_out',
  strata: 'ma_tx_out',
  split: 'sample',
  unfrackit_tx: 'tx_metadata',
  prior_flags: 'sample',
  franken: 'sample',
  check_61_table: 'sample',
  script_tx: 'redeemer',
  profile: 'sample'
};

// rows: { table: approx_rows } for each database.
export function project(timings, preprodRows, mainnetRows) {
  const out = [];
  let total = 0;
  for (const t of timings) {
    if (t.kind !== 'step') continue;
    const table = DRIVER[t.name];
    const s = t.ms / 1000;
    let factor = 1;
    let basis = 'constant (small tables)';
    if (table && table !== 'sample') {
      const a = Number(preprodRows[table]);
      const b = Number(mainnetRows[table]);
      if (!(a > 0) || !(b > 0)) throw new Error(`missing row count for ${table}`);
      factor = b / a;
      basis = `${table}: ${b.toLocaleString('en-US')} / ${a.toLocaleString('en-US')} rows`;
    } else if (table === 'sample') {
      basis = 'sampled wallets only; preprod size';
    }
    const proj = s * factor;
    total += proj;
    out.push({ step: t.name, preprod_s: Math.round(s * 10) / 10, factor: Math.round(factor * 100) / 100, mainnet_s: Math.round(proj), basis });
  }
  return { steps: out, total_s: Math.round(total) };
}

// health.sql's table listing as JSON lines or an array of { relname, approx_rows }.
export function rowsFromHealth(doc) {
  const rows = {};
  for (const r of doc) rows[r.relname] = Number(r.approx_rows);
  return rows;
}
