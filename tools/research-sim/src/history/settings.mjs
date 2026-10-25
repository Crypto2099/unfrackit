// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Readings of the study's rules that the rules leave open, each a named
// setting whose default is the reading this code implements. A different
// answer changes one value. Where only the default is implemented, any other
// value is refused rather than silently ignored.
//
// Every value is recorded in each history file's header.

export const DEFAULT_SETTINGS = Object.freeze({
  // Requested outputs. 'a': every output whose address does not carry the
  // wallet's stake credential; every wallet output at a script payment
  // credential or carrying a datum or a reference script, as observed; and,
  // from the other wallet outputs, the net inflow of each native asset that
  // did not come from wallet inputs, as requested wallet outputs at their
  // minimum. 'c': the outputs to other stake credentials only.
  requested: 'a',
  // Held wallet UTxOs consumed in a window. 'a': a held UTxO leaves the state
  // when any transaction consumes it; consumed by the wallet's own spend, it
  // is a fixed input of the intent and its value implicit input. 'b': held
  // UTxOs never leave the state (the consumption is not written).
  heldConsumed: 'a',
  // Mainnet transaction bytes: 'immutable-db', the node's ImmutableDB chunk
  // files read over SSH.
  mainnetBytes: 'immutable-db',
  // The script fee held constant in a replay: 'snapshot', the execution term
  // from the observed redeemers' execution units and the reference-script
  // term from the observed reference scripts' sizes, both under the snapshot
  // parameters, computed once per intent.
  scriptFee: 'snapshot',
  // The bytes of the fixed parts: 'per-intent', the size of the observed
  // transaction less the size of the same transaction with its fixed parts
  // removed, computed once per intent.
  fixedBytes: 'per-intent',
  // Phase-2-invalid transactions. 'forfeit': an intent whose only effect is
  // the loss of the total collateral. 'skip': not written.
  phase2Invalid: 'forfeit',
  // An asset's class for spend types. 'profile': the classification applied
  // to the largest of the wallet's holding at the window's start, at its end,
  // and the units the transaction moved (the absolute net movement of the
  // wallet's outputs). 'at-spend': the holding just before the spend.
  assetClass: 'profile',
  // Value bytes: 'ledger', the ledger's serialization of the Value, from
  // db-sync's columns.
  valueBytes: 'ledger',
  // Whether ADA inflow from non-wallet inputs becomes requested outputs.
  // false: native assets only; ADA reaches the change through the implicit
  // input.
  inflowIncludesAda: false,
  // What spend types count as sent. 'outflow': requested outputs other than
  // the inflow outputs; when there are none, the inflow outputs.
  typeAssets: 'outflow',
  // Whether a requested output at a script payment credential makes a spend
  // T5 whatever it carries. 'contents': no; T5 needs a fungible asset sent.
  t5ScriptOrders: 'contents',
  // Bursts of one spend. 2: a burst has at least two spends; a lone spend
  // carries no burst.
  burstMinSpends: 2,
  // The burst gap, seconds of block time.
  burstGapSeconds: 60,
  // 30-day marks: the interval in seconds, and whether a mark at a block's
  // exact time comes before the block's events.
  markSeconds: 30 * 86400,
  markBeforeTies: true,
  // The re-encoded form of an output when db-sync's columns do not say:
  // 'auto', the map form when an inline datum or a reference script needs it,
  // the array form otherwise.
  outputForm: 'auto',
  // ImmutableDB chunk size in slots (the Byron epoch size on mainnet and
  // preprod).
  chunkSlots: 21600
});

const IMPLEMENTED = {
  requested: ['a', 'c'],
  heldConsumed: ['a', 'b'],
  mainnetBytes: ['immutable-db'],
  scriptFee: ['snapshot'],
  fixedBytes: ['per-intent'],
  phase2Invalid: ['forfeit', 'skip'],
  assetClass: ['profile', 'at-spend'],
  valueBytes: ['ledger'],
  typeAssets: ['outflow'],
  t5ScriptOrders: ['contents', 'any-script-output'],
  outputForm: ['auto']
};

export function settingsWith(overrides = {}) {
  const s = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in DEFAULT_SETTINGS)) throw new Error(`unknown setting ${k}`);
    const want = typeof DEFAULT_SETTINGS[k];
    let val = v;
    if (want === 'number') val = Number(v);
    if (want === 'boolean') val = v === true || v === 'true';
    if (want === 'number' && !Number.isFinite(val)) throw new Error(`setting ${k}: not a number`);
    if (IMPLEMENTED[k] && !IMPLEMENTED[k].includes(val)) throw new Error(`setting ${k}=${val} is not implemented (implemented: ${IMPLEMENTED[k].join(', ')})`);
    s[k] = val;
  }
  return Object.freeze(s);
}

// --set name=value pairs.
export function parseSets(list = []) {
  const o = {};
  for (const x of list) {
    const m = /^([A-Za-z0-9]+)=(.*)$/.exec(x);
    if (!m) throw new Error(`--set ${x}: expected name=value`);
    o[m[1]] = m[2];
  }
  return o;
}
