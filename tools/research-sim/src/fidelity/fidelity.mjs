// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The fidelity check: each observed spend that runs no script, rebuilt by the
// ledger kit from its observed parts, against the transaction the chain
// carried. The rebuilt transaction's minimum fee, minFeeA * |rebuilt| +
// minFeeB, must be within 2% of minFeeA * |observed| + minFeeB, both under the
// fee parameters of the observed transaction's epoch (db-sync's epoch_param,
// which every intent carries in `observed`), for at least 99% of such spends
// in each window. |tx| is the ledger's size (kit/fee.mjs). Exact byte
// equality is not required: the kit writes its own encodings (sets with tag
// 258, change in the array form, synthetic vkey witnesses), as any builder
// writes its own.
//
// The rebuild of one spend (rebuildSpend), assembled by the kit's replay
// assembly (kit/replay.mjs assembleReplayOnce) at its least self-covering fee:
// - the intent as every method of a replay receives it (withoutLeftovers):
//   without the network id and an auxiliary data holding no metadata and no
//   script, which are habits of the observed builder and not parts of the
//   spend;
// - inputs: the observed wallet inputs, and the intent's fixed inputs;
// - outputs: the requested outputs that are outputs of the observed
//   transaction, as the intent carries them (raised where the history reader
//   raised them), and every other observed wallet output as change, in the
//   kit's form. A requested output built from an inflow is left out, since
//   the observed wallet output that received the inflow carries it;
// - witnesses: the kit's (kit/replay.mjs replayWitnessKeys), one synthetic
//   vkey witness per distinct payment key of the wallet inputs, the held
//   wallet inputs and the required signers among the wallet's payment
//   credentials at the spend, and every other witness as observed, a
//   bootstrap witness of a non-wallet Byron input among them as its own
//   bytes;
// - no collateral, since a spend that runs no script needs none.
// The wallet's payment credentials at a spend are those of its UTxO set just
// before it, followed through the history file's events as the chain had
// them.
//
// A spend runs a script when it carries a Plutus redeemer or is
// phase-2-invalid (spend type T6); such spends are left out. Native scripts
// and reference scripts do not make a spend a script spend: neither adds an
// execution term, and both sides of the comparison use the same size
// formula. Self-reorganizations are not in the check: the replay does not
// rebuild them, and a history file does not carry their fixed parts. A spend
// the kit cannot assemble is counted apart with its reason, and counts
// against its window's share.
//
// Beside the check, each window records the distribution of the difference
// with the observed builder's leftovers kept (the network id and an empty
// auxiliary data, which the history file keeps), which separates the replay's
// rule on leftovers from the kit's encodings, and the traits of the spends
// outside 2% and of those more than 1% away.
//
// The results are counts and distributions per window: never a fee, a size
// or an identifier of a spend.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readHistory } from '../state/history.mjs';
import { utxoFromCbor, addressTextOf } from '../state/utxo.mjs';
import { decodeOutputBytes } from '../history/output.mjs';
import { parseAddress } from '../history/address.mjs';
import { sortAssets } from '../history/value.mjs';
import { assembleReplayOnce, withoutLeftovers, emptyAuxiliaryData } from '../kit/replay.mjs';
import { leastSelfCoveringFee } from '../kit/assemble.mjs';
import { inspectTx } from '../kit/inspect.mjs';
import { minFee } from '../kit/fee.mjs';
import { scrubText, assertClean } from '../out/records.mjs';
import { runDir, ensureDir, writeJson } from '../history/paths.mjs';
import { loadTreatment, DEFAULT_PINS } from '../treatment/bridge.mjs';
import { historyFiles } from '../replay/commands.mjs';
import { formatHashList } from '../hash.mjs';

// Within 2%: |rebuilt - observed| * 50 <= observed. The share must reach 99%:
// within * 100 >= spends * 99.
export const TOLERANCE = 0.02;
export const THRESHOLD = 0.99;
const within2 = (rebuilt, observed) => (rebuilt > observed ? rebuilt - observed : observed - rebuilt) * 50n <= observed;
const reaches99 = (within, spends) => within * 100 >= spends * 99;

// Quantiles by the nearest-rank rule: the smallest value with at least p of
// the values at or below it (the least value for p = 0).
export const QUANTILES = Object.freeze([0, 0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99, 1]);
export function quantiles(values) {
  if (!values.length) return null;
  const s = Float64Array.from(values).sort();
  return Object.fromEntries(QUANTILES.map((p) => [`p${Math.round(p * 100)}`, s[Math.max(0, Math.min(s.length - 1, Math.ceil(p * s.length) - 1))]]));
}

export class Apart extends Error {}

// Whether a spend runs a script: a Plutus redeemer, or phase-2-invalid.
export const runsScript = (intent) => intent.invalid !== null || !!(intent.fixed && intent.fixed.redeemers.length);

// The parts the kit rebuilds a spend from: { intent, inputs, change,
// mapFormChange }; with keepLeftovers, the intent keeps the network id and an
// empty auxiliary data.
export function rebuildParts(intent, { keepLeftovers = false } = {}) {
  const o = intent.observed;
  const it = keepLeftovers ? intent : withoutLeftovers(intent);
  const requested = it.requested.filter((r) => !r.inflow);
  if (requested.some((r) => r.index === null)) throw new Apart('a requested output that is not an output of the transaction');
  const at = new Set(requested.map((r) => r.index));
  const change = [];
  let mapFormChange = 0;
  for (const w of o.walletOutputs) {
    if (at.has(w.index)) continue;
    const d = decodeOutputBytes(Buffer.from(w.cbor, 'hex'));
    if (d.datum || d.scriptRef) throw new Apart('a change output carrying a datum or a reference script');
    if (d.form === 'map') mapFormChange++;
    change.push({ address: addressTextOf(d.address), coin: d.coin, assets: sortAssets(d.assets) });
  }
  const inputs = o.walletInputs.map((x) => utxoFromCbor(x.cbor, { origin: 'initial' }));
  return { intent: Object.freeze({ ...it, requested }), inputs, change, mapFormChange };
}

// One spend rebuilt and compared. walletCreds: the wallet's payment
// credentials at the spend (an object with has(keyHash)), for its required
// signers. Throws Apart, or the kit's error, when the kit cannot assemble it.
// { within, relative, bytes, kept: { within, relative }, traits }, `kept`
// the same comparison with the leftovers kept.
export function rebuildSpend(T, intent, { walletCreds = null } = {}) {
  const o = intent.observed;
  const P = { minFeeA: o.minFeeA, minFeeB: o.minFeeB };
  const observed = minFee(P, o.size);
  const once = (parts) => {
    const at = (fee) => {
      const a = assembleReplayOnce(T, { intent: parts.intent, inputs: parts.inputs, change: parts.change, collateral: null, fee, walletCreds });
      const size = inspectTx(a.bytes).size;
      return { ok: true, fee, size, k: a.k, need: minFee(P, size) };
    };
    const r = leastSelfCoveringFee(at, minFee(P, 0));
    const rebuilt = minFee(P, r.size);
    return { within: within2(rebuilt, observed), relative: Number(rebuilt - observed) / Number(observed), bytes: r.size - o.size, k: r.k };
  };
  const parts = rebuildParts(intent);
  const r = once(parts);
  const kept = parts.intent.fixed === intent.fixed ? r : once(rebuildParts(intent, { keepLeftovers: true }));
  const f = intent.fixed;
  return {
    within: r.within,
    relative: r.relative,
    bytes: r.bytes,
    kept: { within: kept.within, relative: kept.relative },
    traits: {
      type: intent.type,
      protocolMajor: o.protocolMajor,
      witnessDifference: r.k - o.walletWitnesses.length,
      bootstrapWitnesses: !!(f && f.witnesses[2] !== undefined),
      nativeScripts: !!(f && f.witnesses[1] !== undefined),
      otherVkeyWitnesses: !!(f && f.witnesses[0] !== undefined),
      networkIdLeftOut: !!(f && f.body[15] !== undefined),
      emptyAuxiliaryDataLeftOut: !!(f && f.auxiliaryData && emptyAuxiliaryData(f.auxiliaryData)),
      mapFormChange: parts.mapFormChange > 0,
      collateralFields: intent.collateral.observed !== null
    }
  };
}

// A window's running totals.
function newWindow() {
  return { files: 0, wallets: new Set(), splits: {}, intents: 0, scriptSpends: 0, selfReorganizations: 0, spends: 0, rebuilt: 0, within: 0, apart: {}, relative: [], bytes: [], kept: { within: 0, relative: [] }, traits: { rebuilt: {}, outside: {}, overOnePercent: {} }, stateCheck: { files: 0, differ: 0 } };
}

function tally(into, traits) {
  for (const [k, v] of Object.entries(traits)) {
    const m = (into[k] = into[k] || {});
    const key = String(v);
    m[key] = (m[key] || 0) + 1;
  }
}

const credOfOutput = (hex) => parseAddress(decodeOutputBytes(Buffer.from(hex, 'hex')).address).payment;

// One history file (its text) into its window's totals.
export function fileFidelity(T, text, w, { analysisFreezeTx = null } = {}) {
  const h = readHistory(text, { analysisFreezeTx });
  const lines = text.split('\n').filter((l) => l.length);
  w.files++;
  w.wallets.add(h.header.wallet);
  const split = h.header.split || 'none';
  w.splits[split] = (w.splits[split] || 0) + 1;
  // The wallet's UTxO set as the chain had it, by reference, with each
  // payment credential's count.
  const refs = new Map();
  const count = new Map();
  const add = (ref, cred) => {
    if (refs.has(ref)) return;
    refs.set(ref, cred);
    count.set(cred, (count.get(cred) || 0) + 1);
  };
  const del = (ref) => {
    const c = refs.get(ref);
    if (c === undefined) return;
    refs.delete(ref);
    const n = count.get(c) - 1;
    if (n) count.set(c, n);
    else count.delete(c);
  };
  const walletCreds = { has: (keyHash) => count.has(keyHash) };
  for (const u of h.start) add(u.ref, u.cred);
  h.events.forEach((e, i) => {
    if (e.kind === 'deposit') {
      for (const u of e.utxos) add(u.ref, u.cred);
    } else if (e.kind === 'held-consumed') {
      for (const r of e.refs) del(r);
    } else if (e.kind === 'self-reorganization') {
      w.selfReorganizations++;
      const raw = JSON.parse(lines[2 + i]);
      for (const x of (raw.observed && raw.observed.walletInputs) || []) del(x.ref);
      for (const r of e.heldConsumed) del(r);
      for (const o of e.walletOutputs) add(`${e.tx}#${o.index}`, credOfOutput(o.cbor));
    } else if (e.kind === 'intent') {
      const it = e.intent;
      w.intents++;
      if (runsScript(it)) {
        w.scriptSpends++;
      } else {
        w.spends++;
        try {
          const r = rebuildSpend(T, it, { walletCreds });
          w.rebuilt++;
          if (r.within) w.within++;
          w.relative.push(r.relative);
          w.bytes.push(r.bytes);
          if (r.kept.within) w.kept.within++;
          w.kept.relative.push(r.kept.relative);
          tally(w.traits.rebuilt, r.traits);
          if (!r.within) tally(w.traits.outside, r.traits);
          if (Math.abs(r.relative) > 0.01) tally(w.traits.overOnePercent, r.traits);
        } catch (err) {
          const reason = scrubText(err.message);
          w.apart[reason] = (w.apart[reason] || 0) + 1;
        }
      }
      for (const x of it.observed.walletInputs) del(x.ref);
      if (it.fixed) for (const x of it.fixed.inputs) if (x.held) del(x.ref);
      if (it.invalid) for (const r of it.invalid.heldConsumed) del(r);
      for (const o of it.observed.walletOutputs) add(`${it.id}#${o.index}`, credOfOutput(o.cbor));
    }
  });
  // The set followed through the events must end at the file's end count.
  w.stateCheck.files++;
  if (refs.size !== h.end.utxos) w.stateCheck.differ++;
  return { network: h.header.network, window: h.header.window ? h.header.frame : 'snapshot', split: h.header.split || null };
}

const round6 = (x) => Math.round(x * 1e6) / 1e6;

// A window's totals as its record.
export function windowRecord(w) {
  const q = quantiles(w.relative);
  const n = w.relative.length;
  return {
    files: w.files,
    wallets: w.wallets.size,
    splits: w.splits,
    intents: w.intents,
    scriptSpends: w.scriptSpends,
    selfReorganizations: w.selfReorganizations,
    spends: w.spends,
    rebuilt: w.rebuilt,
    within: w.within,
    outside: w.rebuilt - w.within,
    apart: w.apart,
    share: w.spends ? w.within / w.spends : null,
    shareOfRebuilt: w.rebuilt ? w.within / w.rebuilt : null,
    reaches: w.spends ? reaches99(w.within, w.spends) : null,
    relativeDifference: q && {
      quantiles: Object.fromEntries(Object.entries(q).map(([k, v]) => [k, round6(v)])),
      mean: round6(w.relative.reduce((a, b) => a + b, 0) / n),
      zero: w.relative.filter((x) => x === 0).length,
      above: w.relative.filter((x) => x > 0).length,
      below: w.relative.filter((x) => x < 0).length
    },
    byteDifference: quantiles(w.bytes),
    leftoversKept: w.rebuilt ? { within: w.kept.within, quantiles: Object.fromEntries(Object.entries(quantiles(w.kept.relative)).map(([k, v]) => [k, round6(v)])) } : null,
    traits: w.traits,
    stateCheck: w.stateCheck
  };
}

// The check over history files: { network, windows: { <window>: record } },
// windows in the order first met. Every file must be of one network.
export function fidelityOfFiles(T, paths, { analysisFreezeTx = null } = {}) {
  const windows = new Map();
  let network = null;
  let confirmation = 0;
  for (const p of paths) {
    const text = readFileSync(p, 'utf8');
    const head = JSON.parse(text.slice(0, text.indexOf('\n')));
    const key = head.window ? head.frame : 'snapshot';
    if (!windows.has(key)) windows.set(key, newWindow());
    const r = fileFidelity(T, text, windows.get(key), { analysisFreezeTx });
    if (network !== null && r.network !== network) throw new Error(`history files of two networks: ${network} and ${r.network}`);
    network = r.network;
    if (r.split === 'confirmation') confirmation++;
  }
  return { network, confirmationFiles: confirmation, windows: Object.fromEntries([...windows].map(([k, w]) => [k, windowRecord(w)])) };
}

const list = (x) => (x === undefined ? [] : [].concat(x));

//   fidelity --treatment <dir> [--treatment-pins <file>]
//            --history <file or directory>... [--run-id <id>]
//            [--analysis-freeze-tx <hash>]
// Reads no database. Writes run.json and fidelity.json under the private run
// directory (history/paths.mjs runDir) and prints counts only. A
// confirmation-split file is refused unless --analysis-freeze-tx is given, as
// in replay.
export async function cmdFidelity(opts) {
  if (!opts.treatment) throw new Error('--treatment <dir> names the treatment directory (the kit\'s synthetic witnesses come from its CSL)');
  const pinsPath = opts.treatmentPins ? resolve(opts.treatmentPins) : DEFAULT_PINS;
  const T = await loadTreatment(opts.treatment, readFileSync(pinsPath, 'utf8'));
  const files = historyFiles(list(opts.history));
  if (!files.length) throw new Error('name the history files: --history <file or directory>');
  const analysisFreezeTx = opts.analysisFreezeTx || null;
  const t0 = Date.now();
  const result = fidelityOfFiles(T, files, { analysisFreezeTx });
  const runId = opts.runId || `fidelity-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const dir = ensureDir(runDir(result.network, runId));
  writeJson(join(dir, 'run.json'), {
    command: 'fidelity',
    options: Object.fromEntries(Object.entries(opts).filter(([k]) => k !== '_')),
    treatmentPins: Object.fromEntries(T.pins),
    node: process.version,
    manifest: formatHashList(),
    network: result.network,
    runId,
    files: files.length,
    confirmationFiles: result.confirmationFiles,
    analysisFreezeTx
  });
  writeJson(join(dir, 'fidelity.json'), assertClean({ network: result.network, runId, tolerance: TOLERANCE, threshold: THRESHOLD, windows: result.windows }));
  const print = Object.fromEntries(Object.entries(result.windows).map(([k, w]) => [k, { files: w.files, spends: w.spends, rebuilt: w.rebuilt, within: w.within, apart: Object.values(w.apart).reduce((a, b) => a + b, 0), share: w.share, reaches: w.reaches }]));
  return { print: { runId, dir, seconds: (Date.now() - t0) / 1000, windows: print } };
}
