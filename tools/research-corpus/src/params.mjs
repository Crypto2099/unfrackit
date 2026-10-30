// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Run parameters. The numbers fixed by the pre-registration are constants
// here. Where its text admits more than one reading, the reading is a named
// setting (x1_ to x21_) whose default is the reading this code uses until the
// research revision settles it, so a different answer changes one value, not
// the SQL.

// Fixed by the pre-registration.
export const FIXED = {
  peak_epochs: 73, // the peak window: 73 epochs of 5 days make 365 days
  peak_from_protocol_major: 4, // the peak search begins at the Mary hard fork, the first epoch with protocol_major >= 4
  recent_days: 365, // the recent window: the 365 days up to the snapshot
  guard: 200000, // the draw's guard per frame; it counts eligible keys taken in draw order
  target_a: 2400, // the random sample's requirement (a): token-holding wallets
  target_b: 1000, // requirement (b): token-holding wallets with at least spends_b_min spend events
  target_c: 600, // requirement (c): token-holding wallets holding assets_c_min or more distinct assets
  target_d: 600, // the random sample's requirement (d): fragmented wallets
  frag_min_utxos: 10, // requirement (d): a fungible asset on 10 or more of the wallet's UTxOs makes it fragmented
  spends_b_min: 5, // requirement (b): at least 5 spends in the window
  assets_c_min: 100, // requirement (c): 100 or more tokens
  ada_only_n: 1200, // the ADA-only sample's size
  strata_n: 50, // wallets per stratum
  nft_top_n: 10, // part 3 of the strata rule: the ten NFT policies
  ft_n: 10, // part 2 of the strata rule: ten CoinGecko tokens that pass the floor
  ft_floor: 1000, // part 2: a candidate held by fewer stake credentials of the recent frame at the snapshot is skipped
  sc_floor: 1000, // part 4: a stablecoin or tokenized commodity held by fewer, counted as in part 2, gives no stratum
  utxo_cap: 20000, // exclusion: more than 20,000 UTxOs is excluded
  pay_cred_cap: 200, // exclusion: more than 200 distinct payment credentials
  script_share: '0.5', // exclusion: more than half of the value
  heavy_tx: 5000, // eligible wallets with more than 5,000 transactions in the window: reported, not excluded
  split_den: 5, // the split: 20% exploration, the first floor(N / 5) of each sample
  months: 12, // the window as 12 months, for the per-month profile cut points
  power_spends_pm: 30, // profile cut points: power, 30 spends and 10 market interactions a month
  power_market_pm: 10,
  active_spends_pm: 8, // active, 8 spends or 2 market interactions a month
  active_market_pm: 2,
  typical_spends_pm: 1, // typical, 1 spend a month
  nft_heavy: 100, // descriptive flag: 100 or more distinct NFTs held
  ft_heavy: 10, // descriptive flag: 10 or more distinct fungible assets held
  dex_active: 3, // descriptive flag: 3 or more DEX interactions in the window
  sim_utxo_over: 1000, // the simulator's live-fire wallets, condition 7: more than 1,000 UTxOs at the snapshot
  security_k: 2160 // confirm the snapshot hash once 2,160 more blocks exist (mainnet's security parameter)
};

// Readings: name, default, what the default means.
export const READINGS = {
  x1_enterprise: { value: false, note: 'a wallet is its stake_address_id outputs only; true adds enterprise outputs at payment credentials owned by exactly one stake credential' },
  x2_any: { value: false, note: 'a wallet input consumes a wallet output at a key payment credential; true counts any wallet output' },
  x3_after_first: { value: false, note: 'the state at a window start is as of the last block before its first block; true uses the state after the first block' },
  x5_reward29: { value: false, note: 'draw and split hash "draw"/"split" || h || 28-byte credential; true uses the 29-byte reward address' },
  x7_prefix: { value: true, note: 'every token-holding wallet up to the stopping point joins (a prefix); false admits only wallets meeting (b) or (c) after (a)' },
  x8_measure: { value: 'distinct', note: '"100 or more tokens" counts distinct assets; alternatives units, nft' },
  x9_count_held: { value: true, note: 'held UTxOs count toward token-holding, asset counts, UTxO counts and lovelace' },
  x10_skip_random_only: { value: false, note: 'strata skip wallets in the random, ADA-only and earlier strata samples; true skips only the random sample' },
  x10_spacebudz_one: { value: false, note: 'the two SpaceBudz policies are two strata; true merges them into one' },
  x12_history: { value: true, note: 'payment credentials counted over history up to the reference block; false counts those present at it' },
  x13_all: { value: false, note: 'franken flags over key payment credentials only; true includes script credentials' },
  x14_search_bytes: { value: true, note: 'key-674 rows db-sync could not decode are searched in their bytes and counted separately' },
  x15_bech32: { value: false, note: 'the HMAC input is the 29-byte reward address; true uses its bech32 text' },
  x17_invalid_is_script: { value: true, note: 'a phase-2-invalid transaction counts as executing a script' },
  x19_count_invalid: { value: true, note: 'every tx row counts toward the peak window, phase-2-invalid included; the search begins at the first epoch with protocol_major >= 4 (Mary)' },
  x21_others_allowed: { value: true, note: 'other outputs are allowed beside the seven Evolution outputs' }
};

export const NETWORK_TAG = { mainnet: 1, preprod: 0, preview: 0 };

// The freeze identity's Ed25519 signing public key: the 32-byte protected-header
// kid of every record the study signs (CIP-190, "Signer-key identification",
// path 1). A kid authenticates no name by itself (CIP-190, "Reporting signature
// results"), so the study names its key here, in the public source. On
// mainnet every command that reads the study's records
// uses this key and refuses any other --study-key, so a second identity cannot
// yield a second valid final; test networks take --study-key, since
// rehearsals sign with other keys.
export const STUDY_KEY = '8e050bfd8d687a27025f9bd5805a13501329dac58092f1c702ff626dc0780cfe';

// The names under which the final pre-registration lists the code manifest
// (the `npm run hash` output) and the frozen check-log prefix, in its lines of
// <64 lowercase hex><two spaces><name>; each must appear exactly once.
export const FREEZE_ITEM_NAMES = { code_manifest: 'code-manifest.txt', check_log: 'check-log.jsonl' };

// Genesis parameters the draw key's epoch rule reads (the security parameter
// k, the active slot coefficient f and the epoch length in slots). A run
// compares them with Koios /genesis for the database's network and refuses on
// any difference.
export const GENESIS = {
  mainnet: { k: 2160, f: '0.05', epoch_length: 432000 },
  preprod: { k: 2160, f: '0.05', epoch_length: 432000 },
  preview: { k: 432, f: '0.05', epoch_length: 86400 }
};

// The peak window as frozen, computed from Koios epoch_info on
// 2026-10-21 with the search beginning at the Mary hard fork. A mainnet run
// compares the rule's result from db-sync with it and reports any
// disagreement; the rule's result is used either way.
export const FROZEN_PEAK = { mainnet: { first_epoch: 286, last_epoch: 358, n_tx: 37431658 } };

const T = {
  int: (v) => ({ type: 'int', value: v }),
  num: (v) => ({ type: 'num', value: v }),
  bool: (v) => ({ type: 'bool', value: v }),
  text: (v) => ({ type: 'text', value: v }),
  bytea: (v) => ({ type: 'bytea', value: v })
};

// The typed parameter map the SQL files read, from a run's resolved values
// (snapshot, windows, h) and its settings (fixed values and readings,
// with any overrides already applied).
export function sqlParams(run) {
  const p = {};
  for (const [k, v] of Object.entries(run.settings)) {
    if (typeof v === 'boolean') p[k] = T.bool(v);
    else if (typeof v === 'number') p[k] = T.int(v);
    else if (k === 'script_share') p[k] = T.num(v);
    else p[k] = T.text(v);
  }
  p.peak_epochs_less_one = T.int(run.settings.peak_epochs - 1);
  p.network_tag = T.int(NETWORK_TAG[run.network]);
  if (run.snapshot) {
    p.snap_block = T.int(run.snapshot.id);
    p.snap_tx = T.int(run.snapshot.t);
  }
  if (run.h) p.h = T.bytea(run.h);
  const w = run.windows;
  if (w && w.recent) {
    p.recent_lo = T.int(w.recent.lo);
    p.recent_hi = T.int(w.recent.hi);
    p.recent_t_start = T.int(w.recent.t_start);
    p.recent_first_epoch = T.int(w.recent.first_epoch);
    p.recent_last_epoch = T.int(w.recent.last_epoch);
  }
  if (w && w.peak) {
    p.peak_lo = T.int(w.peak.lo);
    p.peak_hi = T.int(w.peak.hi);
    p.peak_t_start = T.int(w.peak.t_start);
    p.peak_t_end = T.int(w.peak.hi);
    p.peak_first_epoch = T.int(w.peak.first_epoch);
    p.peak_last_epoch = T.int(w.peak.last_epoch);
  }
  return p;
}

export function defaultSettings() {
  const s = { ...FIXED };
  for (const [k, v] of Object.entries(READINGS)) s[k] = v.value;
  return s;
}

// --set name=value overrides, typed by the default's type.
export function applyOverrides(settings, overrides) {
  const out = { ...settings };
  for (const o of overrides) {
    const m = /^([a-z0-9_]+)=(.*)$/.exec(o);
    if (!m) throw new Error(`--set expects name=value, got ${o}`);
    const [, k, raw] = m;
    if (!(k in out)) throw new Error(`unknown setting ${k}`);
    const cur = out[k];
    if (typeof cur === 'boolean') {
      if (raw !== 'true' && raw !== 'false') throw new Error(`${k} takes true or false`);
      out[k] = raw === 'true';
    } else if (typeof cur === 'number') {
      if (!/^\d+$/.test(raw)) throw new Error(`${k} takes a whole number`);
      out[k] = Number(raw);
    } else {
      if (k === 'x8_measure' && !['distinct', 'units', 'nft'].includes(raw)) throw new Error('x8_measure takes distinct, units or nft');
      if (k === 'script_share' && !/^0?\.\d+$/.test(raw)) throw new Error('script_share takes a decimal below 1');
      out[k] = raw;
    }
  }
  return out;
}
