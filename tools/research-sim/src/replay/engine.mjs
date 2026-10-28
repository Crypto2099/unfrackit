// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The replay engine: one wallet's intent stream over one window, in one arm,
// by one method under one change policy, collateral rule and repetition.
//
// The arm's state starts from the window's start state, laid out by the arm
// (arms/arms.mjs) with its plan fees charged and recorded apart. Its change
// address, for every method and plan, is the one the source names at each
// event (replay/source.mjs): the change-address rule over the outputs the
// wallet has received on the chain up to that point, the same in every arm.
// A wallet for which the rule names no address where the replay needs one is
// refused (state/state.mjs changeAddressGap); before its first such address a
// state holds no spendable UTxO, so a plan there proposes nothing and is not
// run. The events then apply in chain order:
//   deposit              the UTxOs are added, in every arm, when they occurred
//   held-consumed        the held UTxOs leave the state
//   intent               built by the method, checked by the ledger kit and
//                        applied (below)
//   self-reorganization  counted, its reshuffle of the wallet's inputs not
//                        replayed; held UTxOs it consumed leave the state,
//                        and its reward withdrawals, when it carries any, are
//                        deposited in every arm as one UTxO of the withdrawn
//                        ADA at the change address in effect at it; its fee
//                        is charged to no arm
//   mark                 every 30 days of block time: the maintained-tidy arm
//                        re-plans and applies any proposed plan, charged
// Every arm replays the same intents in the same order, each with its builder
// leftovers left out (kit/replay.mjs withoutLeftovers): no method, feasibility
// test or check sees the observed transaction's network id or an auxiliary
// data holding no metadata and no script. An intent:
//   - phase-2-invalid: its only effect is the forfeit. The arm provides
//     collateral under its rule (the smallest eligible UTxO that can carry the
//     forfeit, ties by txid#index), loses the observed total collateral, and
//     its return output, at the change address, comes back to the wallet. No
//     eligible UTxO makes it infeasible for collateral (below).
//   - infeasible by balance (replay/feasible.mjs): recorded apart, not a
//     selector failure; the state is left as it was.
//   - a script spend sets its collateral aside before any method selects
//     (setAside): the UTxO the arm's rule chooses leaves the pool the method
//     selects from and is the collateral of every transaction the method
//     assembles. A script spend with no UTxO to set aside, or whose payment
//     the balance cannot make without it, is infeasible for collateral
//     (outcome 'infeasible-collateral', reason 'none-eligible' or 'payment'):
//     recorded apart from build failures and from infeasibility by balance,
//     never a selector failure; the state is left as it was. A method whose
//     library chooses its own collateral (the Evolution SDK's,
//     methods/contract.mjs choosesOwnCollateral) has nothing set aside: it
//     selects from the whole pool, and its transaction's collateral is the
//     library's, recorded as library-chosen. Its spend is infeasible for
//     collateral ('none-eligible') when the rule would set no UTxO aside, as
//     for every method, since no method could build it; the 'payment' reason
//     does not apply to it.
//   - otherwise the method builds it from the pool. A method's exception or a
//     failed kit check is a build failure with its class (class collateral: a
//     transaction whose collateral fails the kit's check, charged to the
//     method, whether the engine or its library chose the collateral);
//     'not-replayable' (an intent the method cannot express) is counted
//     apart. A failed kit check on a transaction carrying parts its adapter
//     wrote after the library priced it names those parts in its detail. A
//     failure leaves the state as it was, and the replay continues.
// At the first spend of each parallel burst, a separate pass builds the
// burst's intents in order from the state at its start without spending any
// output created earlier in the burst (burst feasibility, H-5 and H-6's rescue
// test), while the ordinary sequential replay continues for fees. At every
// script interaction the collateral available under every rule is recorded:
// at a spend, whether the rule would set a UTxO aside and the payment can be
// made without it (spendCollateralAvailability), so that a spend infeasible
// for collateral counts as having none; at a forfeit, whether any UTxO is
// eligible.
// In the maintained-tidy arm under the decided thresholds, each plan that
// proposes a pure-ADA-only transaction the never-propose setting would not is
// an H-6 trigger, returned with its time for the rescue test.
//
// The engine runs the kit's checks and applies each transaction; a method
// never sees the verdict before it returns. CSL objects the treatment leaves
// to finalization are released by settling the heap (kit/heap.mjs) after each
// plan and every `settleEvery` spends.

import { makeState, addUtxos, removeHeld, withChangeAddress, changeAddressGap } from '../state/state.mjs';
import { utxoFromOutput } from '../state/utxo.mjs';
import { checkAndApply } from '../kit/apply.mjs';
import { inspectTx } from '../kit/inspect.mjs';
import { CLASSES } from '../kit/check.mjs';
import { walletControlledFee, minFee } from '../kit/fee.mjs';
import { outputMinimum } from '../kit/check.mjs';
import { changeOutputBytes, fixedInputValues, carriesCollateral, withoutLeftovers } from '../kit/replay.mjs';
import { checkResult, checkOptions, choosesOwnCollateral, NOT_REPLAYABLE } from '../methods/contract.mjs';
import { planState, planOnly, StopPoint } from '../treatment/run.mjs';
import { armSettings, plansAtStart, replansAtMarks, needsArrival } from '../arms/arms.mjs';
import { replaySuffices } from './feasible.mjs';
import { eligibleCollateral, collateralAvailability, checkRule, totalCollateralFor, COLLATERAL_RULES } from './collateral.mjs';
import { spendMeasures, stateMeasures, requestedIndexes, PolicyLock } from './measure.mjs';
import { blake2b224 } from '../history/blake2b.mjs';
import { decode, raw } from '../history/cbor.mjs';
import { settle } from '../kit/heap.mjs';

const sum = (xs) => xs.reduce((a, b) => a + b, 0n);
const MONTH = 30 * 86400;

// The outcome of a script spend that has no collateral to set aside, or
// cannot be paid without it.
export const INFEASIBLE_COLLATERAL = 'infeasible-collateral';

// The UTxO a script spend sets aside as its collateral under `rule` (setting
// collateralChoice 'smallest'), or null: the smallest UTxO eligible under the
// rule (replay/collateral.mjs), the spend's fixed inputs excluded, ties by
// txid#index, that can carry the total collateral of the largest fee the
// spend can have (one transaction of maxTxSize, with the intent's script fee)
// with a return output at its minimum, so that it serves every fee a
// transaction within the size limit reaches.
export function collateralToSetAside(params, state, intent, rule) {
  const fixedRefs = new Set(intent.fixed ? intent.fixed.inputs.map((x) => x.ref) : []);
  const eligible = eligibleCollateral(state, params, rule, { exclude: fixedRefs, observedFee: intent.observed ? intent.observed.fee : null });
  const scriptFee = intent.fixed ? intent.fixed.scriptFee || 0n : 0n;
  const total = totalCollateralFor(params, minFee(params, params.maxTxSize, scriptFee));
  return eligible.find((u) => carriesCollateral(params, u, state.changeAddress, total, { exactZero: false })) || null;
}

// The set-aside, applied before any method selects: for a script spend, the
// collateral under the arm's rule leaves the pool the method selects from, as
// a wallet keeps a dedicated collateral UTxO, and the method assembles every
// transaction with it (opts.collateral). Returns { ok: true, pool, collateral }
// (the state itself and null for a spend that runs no script), or { ok: false,
// reason }: 'none-eligible', no UTxO to set aside, or 'payment', the balance
// does not suffice without it (replay/feasible.mjs).
export function setAside(T, params, state, intent, rule) {
  if (!intent.collateral.required) return { ok: true, pool: state, collateral: null };
  const u = collateralToSetAside(params, state, intent, rule);
  if (!u) return { ok: false, reason: 'none-eligible' };
  if (!replaySuffices(T, state, params, intent, { aside: u.ref }).suffices) return { ok: false, reason: 'payment' };
  return { ok: true, pool: removeSpent(state, [u.ref]), collateral: u };
}

// A spend's collateral for `method`: the set-aside, or for a method whose
// library chooses its own collateral, the whole pool with no UTxO set aside
// ({ ok: true, pool, collateral: null, library: true }), or 'none-eligible'
// when the rule would set no UTxO aside.
function collateralFor(T, params, state, intent, rule, method) {
  if (!intent.collateral.required || !choosesOwnCollateral(method)) return setAside(T, params, state, intent, rule);
  if (!collateralToSetAside(params, state, intent, rule)) return { ok: false, reason: 'none-eligible' };
  return { ok: true, pool: state, collateral: null, library: true };
}

// Whether collateral is available under each rule at a script spend, for
// H-5 and H-6: the rule would set a UTxO aside and the payment can be made
// without it, as setAside decides. When the balance does not suffice even
// with it (`suffices` false, infeasible by balance), a UTxO to set aside is
// enough. null under the ledger-minimum rule when the intent has no observed
// fee.
export function spendCollateralAvailability(T, params, state, intent, suffices) {
  const observedFee = intent.observed ? intent.observed.fee : null;
  const out = {};
  const without = new Map();
  for (const rule of COLLATERAL_RULES) {
    if (rule === 'ledger-minimum' && observedFee === null) {
      out[rule] = null;
      continue;
    }
    const u = collateralToSetAside(params, state, intent, rule);
    if (!u) out[rule] = false;
    else if (!suffices) out[rule] = true;
    else {
      if (!without.has(u.ref)) without.set(u.ref, replaySuffices(T, state, params, intent, { aside: u.ref }).suffices);
      out[rule] = without.get(u.ref);
    }
  }
  return out;
}

// The number of the intent's fixed vkey witnesses that no fixed input's key
// accounts for (stake keys, required signers, voters): with the inputs' keys
// they are the witnesses the kit requires.
export function fixedExtraWitnesses(intent) {
  const f = intent.fixed;
  if (!f || f.witnesses[0] === undefined) return 0;
  const b = Buffer.from(f.witnesses[0], 'hex');
  const n = decode(b);
  const arr = n.mt === 6 ? n.item : n;
  const inputKeys = new Set(fixedInputValues(intent).filter((x) => x.addr.paymentKind === 'key' && !x.walletKey).map((x) => x.addr.payment));
  let extra = 0;
  for (const w of arr.items) {
    const vkey = Buffer.from(raw(b, w.items[0])).subarray(2);
    if (!inputKeys.has(blake2b224(vkey).toString('hex'))) extra++;
  }
  return extra;
}

// The arrival object of every token-carrying UTxO ('policy.name' to its
// arrival key), from the history's arrival table, for H-2's groupings.
function arrivalMap(state, table) {
  const m = new Map();
  for (const u of state.utxos.values()) {
    if (!u.assets.length) continue;
    const o = {};
    for (const a of u.assets) {
      const e = table.get(`${a.policy}.${a.name}`);
      if (e) o[`${a.policy}.${a.name}`] = e.txId;
    }
    m.set(u.ref, o);
  }
  return m;
}

const pureOnlyCount = (plan) => plan.txs.filter((t) => t.notes.includes('pure-ada-only')).length;

// An event as the replay takes it: an intent's with its builder leftovers
// left out, any other unchanged.
const REPLAYED = new WeakMap();
function replayedEvent(e) {
  if (e.kind !== 'intent') return e;
  if (!REPLAYED.has(e)) {
    const intent = withoutLeftovers(e.intent);
    REPLAYED.set(e, intent === e.intent ? e : { ...e, intent });
  }
  return REPLAYED.get(e);
}

// source: { wallet, window, network, stakeCred, changeAddress,
// changeAddressEnd, franken, start [UTxO], events (each with the
// changeAddress in effect at it), arrival (Map), windowStart (block time) }.
// job: { key, arm, variant, repetition, method, opts, settleEvery, policyLock }.
export async function replay(T, params, source, job) {
  const t0 = performance.now();
  const { arm, variant, repetition, method, opts } = job;
  checkOptions(opts);
  checkRule(opts.collateralRule);
  const out = { spends: [], plans: [], bursts: [], triggers: [], summary: null };
  const gap = changeAddressGap(source);
  if (gap) {
    out.refused = gap;
    return out;
  }
  const settings = armSettings(arm, variant, repetition);
  let state = makeState({ network: source.network, stakeCred: source.stakeCred, changeAddress: source.changeAddress ?? null, utxos: source.start, at: { slot: null, time: source.windowStart }, franken: source.franken });
  const counts = { intents: 0, built: 0, failed: 0, infeasible: 0, infeasibleCollateral: 0, notReplayable: 0, forfeits: 0, selfReorganizations: 0, selfReorganizationsWithValue: 0, withdrawalDeposits: 0, deposits: 0, heldConsumed: 0, heldMissing: 0, marks: 0, changeAddressMoves: 0, byClass: {} };
  // The change address the source names at a point of the replay.
  const follow = (address) => {
    if (address === undefined || address === state.changeAddress) return;
    if (state.changeAddress !== null) counts.changeAddressMoves++;
    state = withChangeAddress(state, address);
  };
  const fees = { spends: 0n, walletControlled: 0n, plans: 0n, forfeits: 0n };
  let withdrawn = 0n;
  const trajectory = [];
  const lock = job.policyLock ? new PolicyLock(params) : null;
  let lastTime = source.windowStart;
  const advance = (time) => {
    if (time === null || time === undefined) return;
    if (lock) lock.add(state, time - lastTime);
    if (time > lastTime) lastTime = time;
  };
  const rel = (time) => (time === null || time === undefined ? null : time - source.windowStart);

  // Arrival keys: the history's table for the tokens held at the window
  // start, and for a token that first arrives during the window, the id of
  // the transaction that brought it (a deposit, or a spend's inflow or mint).
  const arrivalTable = new Map(source.arrival || []);
  const arrive = (assets, txId) => {
    if (txId === null || txId === undefined) return;
    for (const a of assets) if (!arrivalTable.has(`${a.policy}.${a.name}`)) arrivalTable.set(`${a.policy}.${a.name}`, { txId, flagged: false });
  };
  const doPlan = async (at, time) => {
    if (state.changeAddress === null) {
      out.plans.push({ at, t: rel(time), txs: 0, fee: 0n, size: 0, utxosAfter: state.utxos.size, notes: [], control: null, trigger: false, noChangeAddress: true });
      return;
    }
    const arrival = needsArrival(variant) ? arrivalMap(state, arrivalTable) : null;
    const p = planState(T, state, params, settings, { arrival });
    let trigger = null;
    if (arm === 'maintained-tidy' && (settings.pureAdaOnly || 'rules') === 'rules' && p.plan.txs.length) {
      const never = planOnly(T, state, params, { ...settings, pureAdaOnly: 'never' }, { arrival });
      const extra = pureOnlyCount(p.plan) - pureOnlyCount(never);
      if (extra > 0) {
        const pureFee = (pl) => sum(pl.txs.filter((t) => t.notes.includes('pure-ada-only')).map((t) => BigInt(t.fee)));
        trigger = { at, t: rel(time), reasons: [...p.plan.pure.reasonsBefore], txs: extra, fee: pureFee(p.plan) - pureFee(never) };
        out.triggers.push(trigger);
      }
    }
    const fee = sum(p.txs.map((t) => t.fee));
    fees.plans += fee;
    state = p.after;
    out.plans.push({ at, t: rel(time), txs: p.txs.length, fee, size: p.txs.reduce((s, t) => s + t.size, 0), utxosAfter: state.utxos.size, notes: [...p.plan.notes], control: p.plan.control || null, trigger: !!trigger });
    await settle();
  };

  try {
    if (plansAtStart(arm)) await doPlan('start', source.windowStart);
  } catch (e) {
    if (e instanceof StopPoint) throw e;
    out.refused = `the planner refuses the start plan: ${e.message}`;
    return out;
  }
  trajectory.push(stateMeasures(state, params).largestValueBytes);

  // The events with every intent's builder leftovers left out.
  const events = source.events.map(replayedEvent);

  // The intents of each parallel burst, in order, for its separate pass.
  const bursts = new Map();
  for (const e of events) if (e.kind === 'intent' && e.intent.burst && e.intent.burst.parallel) {
    if (!bursts.has(e.intent.burst.id)) bursts.set(e.intent.burst.id, []);
    bursts.get(e.intent.burst.id).push(e);
  }
  const passed = new Set();
  let ordinal = 0;
  let sinceSettle = 0;

  for (const e of events) {
    follow(e.changeAddress);
    if (e.kind === 'deposit') {
      advance(e.time && e.time.blockTime);
      state = addUtxos(state, e.utxos);
      arrive(e.utxos.flatMap((u) => u.assets), e.txId);
      counts.deposits++;
      continue;
    }
    if (e.kind === 'held-consumed') {
      advance(e.time && e.time.blockTime);
      const present = e.refs.filter((r) => state.utxos.has(r));
      counts.heldMissing += e.refs.length - present.length;
      state = removeHeld(state, present);
      counts.heldConsumed += present.length;
      continue;
    }
    if (e.kind === 'self-reorganization') {
      advance(e.time && e.time.blockTime);
      counts.selfReorganizations++;
      if (e.valueChange && (e.valueChange.coin !== 0n || e.valueChange.assets.length)) counts.selfReorganizationsWithValue++;
      const present = (e.heldConsumed || []).filter((r) => state.utxos.has(r));
      if (present.length) state = removeHeld(state, present);
      if (e.withdrawal) {
        state = addUtxos(state, [withdrawalDeposit(state, e)]);
        counts.withdrawalDeposits++;
        withdrawn += e.withdrawal;
      }
      continue;
    }
    if (e.kind === 'mark') {
      advance(e.blockTime);
      counts.marks++;
      if (replansAtMarks(arm)) {
        try {
          await doPlan(`mark ${e.n}`, e.blockTime);
        } catch (err) {
          if (err instanceof StopPoint) throw err;
          out.plans.push({ at: `mark ${e.n}`, t: rel(e.blockTime), refused: err.message });
        }
      }
      continue;
    }
    // An intent.
    const intent = e.intent;
    advance(intent.time.blockTime);
    const n = ordinal++;
    counts.intents++;
    const rec = { intent: n, type: intent.type, t: rel(intent.time.blockTime), burst: intent.burst ? { id: intent.burst.id, parallel: intent.burst.parallel, index: intent.burst.index } : null };

    if (intent.burst && intent.burst.parallel && !passed.has(intent.burst.id)) {
      passed.add(intent.burst.id);
      out.bursts.push({ id: intent.burst.id, t: rel(intent.time.blockTime), ...(await burstPass(T, params, state, bursts.get(intent.burst.id), method, opts)) });
    }

    if (intent.invalid) {
      if (intent.collateral.required) rec.collateralAvailable = collateralAvailability(state, params, { observedFee: intent.observed ? intent.observed.fee : null });
      const f = forfeit(params, state, intent, opts.collateralRule);
      if (!f.ok) {
        counts.infeasibleCollateral++;
        out.spends.push({ ...rec, outcome: INFEASIBLE_COLLATERAL, reason: 'none-eligible', detail: f.detail });
      } else {
        state = f.state;
        counts.forfeits++;
        fees.forfeits += f.forfeit;
        out.spends.push({ ...rec, outcome: 'forfeit', forfeit: f.forfeit, collateralUsed: { coin: f.coin, returned: f.returned } });
      }
      trajectory.push(stateMeasures(state, params).largestValueBytes);
      continue;
    }

    const feas = replaySuffices(T, state, params, intent);
    if (intent.collateral.required) rec.collateralAvailable = spendCollateralAvailability(T, params, state, intent, feas.suffices);
    if (!feas.suffices) {
      counts.infeasible++;
      out.spends.push({ ...rec, outcome: 'infeasible', reason: !feas.assets ? 'assets' : !feas.coin ? 'coin' : 'one-transaction' });
      continue;
    }

    const aside = collateralFor(T, params, state, intent, opts.collateralRule, method);
    if (!aside.ok) {
      counts.infeasibleCollateral++;
      out.spends.push({ ...rec, outcome: INFEASIBLE_COLLATERAL, reason: aside.reason });
      continue;
    }

    const r = await buildOne(T, params, state, intent, method, opts, aside);
    if (!r.ok) {
      if (r.class === NOT_REPLAYABLE) counts.notReplayable++;
      else {
        counts.failed++;
        counts.byClass[r.class] = (counts.byClass[r.class] || 0) + 1;
      }
      out.spends.push({ ...rec, outcome: r.class === NOT_REPLAYABLE ? 'not-replayable' : 'failed', class: r.class, detail: r.detail, ms: r.ms });
    } else {
      const before = state;
      state = r.state;
      arrive([...intent.requested.filter((o) => o.wallet).flatMap((o) => o.assets), ...intent.implicit.mint], e.txId);
      counts.built++;
      const fee = sum(r.txs.map((t) => t.fee));
      const last = r.txs[r.txs.length - 1];
      const wcf = walletControlledFee(params, last.fee, { scriptFee: intent.fixed ? intent.fixed.scriptFee : 0n, fixedBytes: intent.fixed ? intent.fixed.fixedBytes : 0 });
      fees.spends += fee;
      fees.walletControlled += wcf;
      const m = spendMeasures(before, intent, r.inspected, last.walletInputs, params, r.requested);
      const st = stateMeasures(state, params);
      trajectory.push(st.largestValueBytes);
      out.spends.push({
        ...rec,
        outcome: 'built',
        txs: r.txs.length,
        fee,
        walletFee: wcf,
        size: r.size,
        ...m,
        collateralUsed: r.inspected.collateralInputs.length ? { inputs: r.inspected.collateralInputs.length, total: r.inspected.totalCollateral, returned: !!r.inspected.collateralReturn, chosen: aside.library ? 'library' : 'set-aside' } : null,
        ms: r.ms,
        utxosAfter: st.utxos,
        largestValueBytesAfter: st.largestValueBytes,
        // Tests only: the transactions and the state they were built from.
        ...(job.keepTx ? { built: { txs: r.txs, before } } : {})
      });
    }
    if (job.settleEvery && ++sinceSettle >= job.settleEvery) {
      sinceSettle = 0;
      await settle();
    }
  }
  advance(source.windowEnd ?? lastTime);
  follow(source.changeAddressEnd);

  const end = stateMeasures(state, params);
  // Conformity of the end state to the arm's layout: whether the planner, at
  // the arm's settings, would propose a plan for it.
  // A state with no change address yet holds no spendable UTxO: no plan.
  let conformity;
  if (state.changeAddress === null) conformity = { proposes: false, txs: 0, fee: 0n, noChangeAddress: true };
  else {
    try {
      const own = !(arm === 'naive-tidy' || arm === 'random-tidy' || arm === 'observed');
      const p = planOnly(T, state, params, own ? settings : {}, { arrival: own && needsArrival(variant) ? arrivalMap(state, arrivalTable) : null });
      conformity = { proposes: p.txs.length > 0, txs: p.txs.length, fee: sum(p.txs.map((t) => BigInt(t.fee))) };
    } catch (e) {
      conformity = { refused: e.message };
    }
  }
  const attempted = counts.built + counts.failed;
  out.summary = {
    counts,
    fees,
    withdrawn,
    failuresPer100: attempted ? (100 * counts.failed) / attempted : null,
    bursts: { parallel: out.bursts.length, feasible: out.bursts.filter((b) => b.feasible).length },
    triggers: out.triggers.length,
    end,
    trajectory,
    conformity,
    policies: lock ? lock.result() : null,
    ms: performance.now() - t0
  };
  return out;
}

// The parts a library's adapter wrote on its transaction after the library
// priced it (the result's library.unpriced), by name, for a failed check's
// detail; empty when there are none.
const unpricedText = (r) => (r.library && r.library.unpriced && r.library.unpriced.length ? `; parts the library did not price: ${r.library.unpriced.join(', ')}` : '');

// One intent by the method from the pool the set-aside leaves (setAside, or
// the whole pool for a library that chooses its own collateral), checked by
// the kit against the whole state and applied.
async function buildOne(T, params, state, intent, method, opts, aside) {
  const t0 = performance.now();
  let r;
  try {
    r = checkResult(method, await method.build(aside.pool, intent, params, aside.collateral ? { ...opts, collateral: aside.collateral } : opts));
  } catch (e) {
    if (e instanceof StopPoint) throw e;
    r = { ok: false, class: CLASSES.other, detail: String(e && (e.message || e)) };
  }
  const ms = performance.now() - t0;
  if (!r.ok) return { ok: false, class: r.class, detail: r.detail, ms };
  const last = r.txs[r.txs.length - 1];
  const inspected = inspectTx(last.bytes);
  // The collateral of a script spend is the UTxO set aside, and no other,
  // unless the method's library chooses its own (aside.library), which the
  // kit's check alone judges.
  if (aside.collateral) {
    for (const t of r.txs) {
      const c = t === last ? inspected.collateralInputs : inspectTx(t.bytes).collateralInputs;
      if (c.length !== 1 || c[0].ref !== aside.collateral.ref) return { ok: false, class: CLASSES.other, detail: `${method.name}: a transaction's collateral is not the UTxO set aside`, ms };
    }
  }
  const requested = requestedIndexes(intent, inspected);
  const fixedIns = fixedInputValues(intent);
  const heldInputs = fixedIns.filter((x) => x.held && state.utxos.has(x.ref)).map((x) => x.ref);
  const applied = checkAndApply(state, params, r.txs, {
    implicit: intent.implicit,
    scriptFee: intent.fixed ? intent.fixed.scriptFee : 0n,
    fixed: intent.fixed,
    extraWitnesses: fixedExtraWitnesses(intent),
    requested,
    heldInputs
  });
  if (!applied.ok) return { ok: false, class: applied.failure.cls, detail: `kit: ${applied.failure.check}: ${applied.failure.detail}${unpricedText(r)}`, ms };
  return { ok: true, txs: r.txs, state: applied.state, inspected, requested, size: applied.checks[applied.checks.length - 1].facts.size, ms };
}

// A parallel burst's separate pass: every intent built in order from the
// state at the burst's start, each later one without the outputs of the
// earlier ones (their wallet inputs are gone, their outputs never arrive),
// each at the change address the source names at it.
async function burstPass(T, params, start, events, method, opts) {
  let s = start;
  let built = 0;
  for (const { intent, changeAddress } of events) {
    if (changeAddress !== undefined) s = withChangeAddress(s, changeAddress);
    if (intent.invalid) {
      const f = forfeit(params, s, intent, opts.collateralRule);
      if (!f.ok) break;
      s = removeSpent(s, [f.ref]);
      built++;
      continue;
    }
    if (!replaySuffices(T, s, params, intent).suffices) break;
    const aside = collateralFor(T, params, s, intent, opts.collateralRule, method);
    if (!aside.ok) break;
    const r = await buildOne(T, params, s, intent, method, opts, aside);
    if (!r.ok) break;
    const heldIns = fixedInputValues(intent).filter((x) => x.held && s.utxos.has(x.ref)).map((x) => x.ref);
    s = removeSpent(s, [...r.txs.flatMap((t) => t.walletInputs), ...heldIns]);
    built++;
  }
  return { spends: events.length, built, feasible: built === events.length };
}

// A self-reorganization's withdrawals as the UTxO every arm receives: the
// withdrawn ADA at the change address in effect, under the transaction's id
// and the index after its last output, a reference no output of the chain
// has, so it can never meet an observed UTxO in any arm.
export function withdrawalDeposit(state, e) {
  const bytes = changeOutputBytes({ address: state.changeAddress, coin: e.withdrawal, assets: [] });
  return utxoFromOutput(e.tx, (e.walletOutputs || []).length, bytes, { franken: state.franken, origin: 'deposit' });
}

function removeSpent(s, refs) {
  const gone = new Set(refs);
  const keep = [...s.utxos.values()].filter((u) => !gone.has(u.ref));
  return makeState({ network: s.network, stakeCred: s.stakeCred, changeAddress: s.changeAddress, utxos: keep, at: s.at, franken: s.franken });
}

// A phase-2-invalid intent's forfeit under the arm's collateral rule.
export function forfeit(params, state, intent, rule) {
  const loss = intent.invalid.forfeit;
  const eligible = eligibleCollateral(state, params, rule, { observedFee: intent.observed ? intent.observed.fee : null });
  for (const u of eligible) {
    if (u.coin < loss) continue;
    const retCoin = u.coin - loss;
    let ret = null;
    if (retCoin > 0n || u.assets.length) {
      const b = changeOutputBytes({ address: state.changeAddress, coin: retCoin, assets: u.assets });
      if (retCoin < outputMinimum(params, b.length)) continue;
      ret = b;
    }
    let s = removeSpent(state, [u.ref]);
    const held = intent.invalid.heldConsumed.filter((r) => s.utxos.has(r));
    if (held.length) s = removeHeld(s, held);
    if (ret) {
      const idx = intent.observed && intent.observed.walletOutputs.length ? intent.observed.walletOutputs[0].index : 0;
      s = addUtxos(s, [utxoFromOutput(intent.id, idx, ret, { franken: s.franken, origin: 'built' })]);
    }
    return { ok: true, state: s, forfeit: loss, coin: u.coin, returned: !!ret, ref: u.ref };
  }
  return { ok: false, detail: `no UTxO eligible under the ${rule} rule carries the forfeit of ${loss} lovelace` };
}
