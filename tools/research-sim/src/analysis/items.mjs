// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The items section 7.3 reports beside the verdicts, at 95% and with no
// decision, computed from per-wallet tables (read.mjs) of one split and one
// window, with their breakdowns:
//
//   rule-vs-own            the rule (absorption on) against L/own, both outcomes
//   rule-off-vs-layout     question 2 with absorption off, both outcomes
//   absorption             the absorption contrast's two figures
//   chains                 the rule's chained answers: shares (cluster
//                          bootstrap), the distribution of transaction counts,
//                          the whole-chain fees, and question 2's failures
//                          without the intents the rule answered with a chain
//   without-change-minimum question 1 without the intents that fail under
//                          L/layout with class change-minimum
//   without-own-other-parts question 1 without L/own's failures of class
//                          fee-minimum naming a part other than redeemers and
//                          of class balance short by exactly a deposit (D5: the
//                          deposits of any non-empty subset of the intent's
//                          certificates and proposals)
//   without-unpriced       section 6.4's broader reading: every intent whose
//                          failure in either arm names a part other than
//                          redeemers is left out of both arms, for questions 1
//                          and 2 and for the first two items
//   end-state              per arm, six end-state metrics as a weighted mean and
//                          median, over all wallets, the capped ones and the
//                          others, and the per-wallet differences of compared arms
//
// Item 8 (build times) reads timings.jsonl.gz, which the reader does not
// read; timingSummary below is the pure distribution the report applies to
// the matched rows.
//
// Breakdowns (item 9) and the peak window (item 10). Every cell of the items
// and of the four primary outcomes is also given by size group (B1 to B3,
// merged from B3 down while a cell holds under ten wallets, per cell; a merge
// that reaches B0 leaves no size cell and the breakdown is marked absent), by spend type (each outcome on the
// spends of that type, its own minimums applied to them; no end states), and
// by the fragmentation flag of the draw (wallet-level). Cells of a spend type,
// of a flag value and of the capped and uncapped populations under ten wallets
// are written with their count and no estimate. The peak window is a second
// call on the peak study's tables with another `suffix`.
//
// Every wallet table is used as given: no filter by split is applied here.
//
// Cell names. A cell's name is its random stream's seed (stats.mjs), so it is
// unique and stable. A name is
//   <base>[/<breakdown>][/<suffix>]
// with a breakdown of size/<groups>, type/<type> or frag/yes|no and the
// caller's `suffix` (for example the window). The primary outcomes and the
// absorption cells keep the names questions.mjs gives them, so the same cell
// has the same name, and so the same interval, wherever it is computed. A
// fee ratio of a "without" reading equals the main one (a spend that fails in
// either arm is never in the fee ratio's paired set); the reading is computed,
// compared wallet by wallet with the main cell and, when equal, reported under
// the main cell's name, so it has the main cell's numbers by construction.

import { bootstrap, mergeSizeGroups, MIN_CELL_WALLETS } from './stats.mjs';
import { TimingCollector } from './timings.mjs';
import { failureValue, feeValue, pairedRuns, runQuestions, studyLibraries, cellName } from './questions.mjs';
import { armIds, RULE_METHOD } from './read.mjs';
import { isDepositSubset } from './deposits.mjs';

export const LEVEL = '0.95';
const STAT = Object.freeze({ failures: 'mean', fees: 'median' });
export const END_METRICS = Object.freeze(['utxos', 'largestValueBytes', 'lockedAdaPerToken', 'conformingShare', 'conformingShareNoCoin', 'planFee']);
const OUTCOMES = Object.freeze(['failures', 'fees']);
const VALUE = Object.freeze({ failures: failureValue, fees: feeValue });

// ---- Views: a run, an arm and a table restricted to some spends.

function countRun(spends) {
  const n = { attempted: 0, built: 0, failed: 0, infeasible: 0, infeasibleCollateral: 0, notReplayable: 0, forfeit: 0, chains: 0 };
  const byClass = {};
  let unpricedFailures = 0;
  for (const s of spends.values()) {
    if (s.outcome === 'built') {
      n.built++;
      n.attempted++;
      if (s.chained) n.chains++;
    } else if (s.outcome === 'failed') {
      n.failed++;
      n.attempted++;
      byClass[s.class] = (byClass[s.class] || 0) + 1;
      if (s.unpriced.some((x) => x !== 'redeemers')) unpricedFailures++;
    } else if (s.outcome === 'not-replayable') n.notReplayable++;
    else if (s.outcome === 'infeasible') n.infeasible++;
    else if (s.outcome === 'infeasible-collateral') n.infeasibleCollateral++;
    else n.forfeit++;
  }
  return { n, byClass, unpricedFailures };
}

// The run with only the spends `keep` accepts; its counts follow.
export function restrictRun(run, keep) {
  const spends = typeof run.spends.filter === 'function' ? run.spends.filter(keep) : new Map([...run.spends].filter(([, s]) => keep(s)));
  return { ...run, spends, ...countRun(spends) };
}

const restrictArm = (arm, keep) => ({ ...arm, runs: new Map([...arm.runs].map(([rep, r]) => [rep, restrictRun(r, keep)])) });

// The table with every run restricted; summaries (end states) stay as they are.
export function restrictTable(table, keep) {
  return { ...table, arms: new Map([...table.arms].map(([id, arm]) => [id, restrictArm(arm, keep)])) };
}

// ---- The intents a "without" reading takes out of both arms of a repetition.

const failedWhere = (run, test) => new Set([...run.spends.values()].filter((s) => s.outcome === 'failed' && test(s)).map((s) => s.intent));
const namesOtherPart = (s) => s.unpriced.some((x) => x !== 'redeemers');
const union = (...sets) => new Set(sets.flatMap((s) => [...s]));

// A balance failure short by exactly a deposit the intent carries: the produced
// coin exceeds the consumed by the deposits of a non-empty subset of the
// intent's certificates and proposals (D5). A synthetic study has no history.
function shortByDeposit(s, table) {
  if (!s.conservation || !table.intents || !table.intents[s.intent]) return false;
  return isDepositSubset(s.conservation.produced - s.conservation.consumed, table.intents[s.intent].depositParts);
}

// Each takes (a, b, table): the run of the first arm, of the second, the wallet.
export const REMOVALS = Object.freeze({
  // Question 1 (a = L/layout, b = L/own).
  changeMinimum: (a) => failedWhere(a, (s) => s.class === 'change-minimum'),
  ownOtherParts: (a, b, t) => failedWhere(b, (s) => (s.class === 'fee-minimum' && namesOtherPart(s)) || (s.class === 'balance' && shortByDeposit(s, t))),
  // Any pair of arms.
  anyUnpriced: (a, b) => union(failedWhere(a, namesOtherPart), failedWhere(b, namesOtherPart)),
  // The rule (a) answered with a chain.
  ruleChain: (a) => new Set([...a.spends.values()].filter((s) => s.outcome === 'built' && s.chained).map((s) => s.intent))
});

// A wallet's outcome with the intents `removal` names left out of both arms of
// each repetition. The arms are rebuilt as paired runs, so the main outcome's
// own function (minimums included) computes the value.
function valueWithout(outcome, armA, armB, broadcast, removal, table) {
  const A = { runs: new Map() };
  const B = { runs: new Map() };
  pairedRuns(armA, armB, broadcast).forEach(([a, b], i) => {
    const gone = removal(a, b, table);
    A.runs.set(i, restrictRun(a, (s) => !gone.has(s.intent)));
    B.runs.set(i, restrictRun(b, (s) => !gone.has(s.intent)));
  });
  return VALUE[outcome](A, B, null);
}

// ---- Cell specs.

const arm = (t, method, kind) => t.arms.get(`${method}/${kind}`) || null;

// Entries of a spec: the wallets with a value, with the table kept for the
// populations and flags.
function entriesOf(tables, valueOf) {
  const out = [];
  for (const t of tables) {
    const v = valueOf(t);
    if (v !== null && v !== undefined) out.push({ id: t.wallet, group: t.group, weight: t.weight.w, v: Array.isArray(v) ? v : [v], t });
  }
  return out;
}

const sameEntries = (x, y) => x.length === y.length && x.every((e, i) => e.id === y[i].id && e.v[0] === y[i].v[0]);

// The specs of the items that compare arms and count chains, over `tables`.
// A spec is { base, meta, statistic, entries, sizeable, whole }.
function valueSpecs(tables, libraries, { primary, absorption }) {
  const specs = [];
  const add = (base, meta, statistic, valueOf, extra = {}) => {
    const spec = { base, meta, statistic, entries: entriesOf(tables, valueOf), sizeable: true, whole: true, ...extra };
    specs.push(spec);
    return spec;
  };
  // A "without" reading's spec: a fee outcome is compared with `main` and,
  // equal, takes the main cell's name.
  const addWithout = (outcome, base, mainBase, meta, valueOf, mainValueOf) => {
    const spec = add(base, meta, STAT[outcome], valueOf);
    if (outcome === 'fees') {
      const same = sameEntries(spec.entries, entriesOf(tables, mainValueOf));
      spec.meta = { ...meta, equalsMain: same };
      if (same) spec.base = mainBase;
    }
    return spec;
  };
  const ruleOn = (t) => arm(t, RULE_METHOD, 'on');
  const ruleOff = (t) => arm(t, RULE_METHOD, 'off');
  const layout = (lib) => (t) => arm(t, lib, 'layout');
  const own = (lib) => (t) => arm(t, lib, 'own');

  for (const lib of libraries) {
    for (const o of OUTCOMES) {
      const v = VALUE[o];
      const q1 = (t) => v(layout(lib)(t), own(lib)(t));
      const q2 = (t) => v(ruleOn(t), layout(lib)(t), 'a');
      const i1 = (t) => v(ruleOn(t), own(lib)(t), 'a');
      const i2 = (t) => v(ruleOff(t), layout(lib)(t), 'a');
      const q1Base = cellName('q1', o, lib, 'layout', 'own');
      const q2Base = cellName('q2', o, lib, 'on', 'layout');
      const i1Base = `rule-vs-own/${o}/${lib}/on-vs-own`;
      const i2Base = `rule-off-vs-layout/${o}/${lib}/off-vs-layout`;
      if (primary) {
        add(q1Base, { item: 'primary', question: 'q1', outcome: o, library: lib }, STAT[o], q1, { whole: false });
        add(q2Base, { item: 'primary', question: 'q2', outcome: o, library: lib }, STAT[o], q2, { whole: false });
      }
      add(i1Base, { item: 'rule-vs-own', outcome: o, library: lib }, STAT[o], i1);
      add(i2Base, { item: 'rule-off-vs-layout', outcome: o, library: lib }, STAT[o], i2);
      const wo = (A, B, removal, broadcast = null) => (t) => valueWithout(o, A(t), B(t), broadcast, removal, t);
      addWithout(o, `without-change-minimum/${o}/${lib}/layout-vs-own`, q1Base, { item: 'without-change-minimum', outcome: o, library: lib }, wo(layout(lib), own(lib), REMOVALS.changeMinimum), q1);
      addWithout(o, `without-own-other-parts/${o}/${lib}/layout-vs-own`, q1Base, { item: 'without-own-other-parts', outcome: o, library: lib }, wo(layout(lib), own(lib), REMOVALS.ownOtherParts), q1);
      addWithout(o, `without-unpriced/q1/${o}/${lib}/layout-vs-own`, q1Base, { item: 'without-unpriced', of: 'q1', outcome: o, library: lib }, wo(layout(lib), own(lib), REMOVALS.anyUnpriced), q1);
      addWithout(o, `without-unpriced/q2/${o}/${lib}/on-vs-layout`, q2Base, { item: 'without-unpriced', of: 'q2', outcome: o, library: lib }, wo(ruleOn, layout(lib), REMOVALS.anyUnpriced, 'a'), q2);
      addWithout(o, `without-unpriced/rule-vs-own/${o}/${lib}/on-vs-own`, i1Base, { item: 'without-unpriced', of: 'rule-vs-own', outcome: o, library: lib }, wo(ruleOn, own(lib), REMOVALS.anyUnpriced, 'a'), i1);
      addWithout(o, `without-unpriced/rule-off-vs-layout/${o}/${lib}/off-vs-layout`, i2Base, { item: 'without-unpriced', of: 'rule-off-vs-layout', outcome: o, library: lib }, wo(ruleOff, layout(lib), REMOVALS.anyUnpriced, 'a'), i2);
    }
    add(`chains/q2-failures-without-chain/${lib}/on-vs-layout`, { item: 'chains', part: 'q2-failures-without-chain', outcome: 'failures', library: lib }, 'mean', (t) => valueWithout('failures', ruleOn(t), layout(lib)(t), 'a', REMOVALS.ruleChain, t));
  }
  if (absorption) {
    add('absorption/fees/off-vs-on', { item: 'absorption', outcome: 'fees' }, 'median', (t) => feeValue(ruleOff(t), ruleOn(t)));
    add('absorption/failures/on-vs-off', { item: 'absorption', outcome: 'failures' }, 'mean', (t) => failureValue(ruleOn(t), ruleOff(t)));
  }
  for (const kind of ['on', 'off']) {
    const one = (t) => {
      const a = arm(t, RULE_METHOD, kind);
      const run = a && [...a.runs.values()].find((r) => !r.refused);
      return run || null;
    };
    add(`chains/${kind}/share-of-attempted`, { item: 'chains', part: 'share-of-attempted', arm: `${RULE_METHOD}/${kind}` }, 'ratio', (t) => {
      const r = one(t);
      return r && r.n.attempted > 0 ? [r.n.chains, r.n.attempted] : null;
    });
    add(`chains/${kind}/share-of-built`, { item: 'chains', part: 'share-of-built', arm: `${RULE_METHOD}/${kind}` }, 'ratio', (t) => {
      const r = one(t);
      return r && r.n.built > 0 ? [r.n.chains, r.n.built] : null;
    });
  }
  return specs;
}

// ---- End states.

const num = (x) => (x === null || x === undefined ? null : Number(x));
const conformityOf = (r) => (r.summary && r.summary.conformity ? r.summary.conformity : null);
const shareOf = (r, key) => {
  const c = conformityOf(r);
  return c && c.tokenUtxos > 0 ? c[key] / c.tokenUtxos : null;
};
export const END_VALUE = Object.freeze({
  utxos: (r) => (r.summary && r.summary.end ? r.summary.end.utxos : null),
  largestValueBytes: (r) => (r.summary && r.summary.end ? r.summary.end.largestValueBytes : null),
  lockedAdaPerToken: (r) => (r.summary && r.summary.end ? num(r.summary.end.lockedAdaPerToken) : null),
  conformingShare: (r) => shareOf(r, 'conforming'),
  conformingShareNoCoin: (r) => shareOf(r, 'conformingNoCoin'),
  // A plan that proposes nothing costs nothing; a refused plan and a state
  // with no change address have no plan fee and are counted apart.
  planFee: (r) => {
    const c = conformityOf(r);
    if (!c || c.refused !== undefined || c.noChangeAddress) return null;
    return c.proposes ? num(c.fee) : 0;
  }
});

const mean = (xs) => (xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length);
const liveRuns = (a) => (a ? [...a.runs.values()].filter((r) => !r.refused) : []);

// A wallet's end-state value of an arm: the mean over the runs that have one.
function armEnd(a, metric) {
  return mean(liveRuns(a).map(END_VALUE[metric]).filter((x) => x !== null));
}

// The wallet's mean over repetitions of the arms' difference, A minus B.
function diffEnd(armA, armB, broadcast, metric) {
  const ds = [];
  for (const [a, b] of pairedRuns(armA, armB, broadcast)) {
    const x = END_VALUE[metric](a);
    const y = END_VALUE[metric](b);
    if (x !== null && y !== null) ds.push(x - y);
  }
  return mean(ds);
}

const POPULATIONS = Object.freeze({ all: () => true, capped: (t) => t.capped === true, uncapped: (t) => t.capped !== true });

function endSpecs(tables, libraries, populations) {
  const specs = [];
  const present = armIds().filter((id) => {
    const m = id.split('/')[0];
    return (m === RULE_METHOD || libraries.includes(m)) && tables.some((t) => t.arms.has(id));
  });
  const diffs = [];
  for (const lib of libraries) {
    diffs.push({ name: `${lib}/layout-minus-own`, a: [lib, 'layout'], b: [lib, 'own'], broadcast: null });
    diffs.push({ name: `${lib}/rule-on-minus-layout`, a: [RULE_METHOD, 'on'], b: [lib, 'layout'], broadcast: 'a' });
    diffs.push({ name: `${lib}/rule-on-minus-own`, a: [RULE_METHOD, 'on'], b: [lib, 'own'], broadcast: 'a' });
  }
  diffs.push({ name: 'rule/off-minus-on', a: [RULE_METHOD, 'off'], b: [RULE_METHOD, 'on'], broadcast: null });
  for (const pop of populations) {
    const sub = tables.filter(POPULATIONS[pop]);
    for (const metric of END_METRICS) {
      for (const statistic of ['mean', 'median']) {
        for (const id of present) {
          const spec = { base: `end-state/${id}/${metric}/${statistic}/${pop}`, meta: { item: 'end-state', arm: id, metric, population: pop }, statistic, sizeable: pop === 'all', whole: true };
          spec.entries = entriesOf(sub, (t) => armEnd(t.arms.get(id) || null, metric));
          const inArm = sub.filter((t) => t.arms.has(id));
          spec.meta.apart = { noValue: inArm.length - spec.entries.length };
          if (metric === 'planFee') {
            const runs = inArm.flatMap((t) => liveRuns(t.arms.get(id)));
            spec.meta.apart.refusedRuns = runs.filter((r) => conformityOf(r) && conformityOf(r).refused !== undefined).length;
            spec.meta.apart.noChangeAddressRuns = runs.filter((r) => conformityOf(r) && conformityOf(r).noChangeAddress).length;
          }
          specs.push(spec);
        }
        for (const d of diffs) {
          const spec = { base: `end-state-difference/${d.name}/${metric}/${statistic}/${pop}`, meta: { item: 'end-state-difference', pair: d.name, metric, population: pop }, statistic, sizeable: pop === 'all', whole: true };
          spec.entries = entriesOf(sub, (t) => diffEnd(arm(t, d.a[0], d.a[1]), arm(t, d.b[0], d.b[1]), d.broadcast, metric));
          specs.push(spec);
        }
      }
    }
  }
  return specs;
}

// ---- Counts that need no interval: the rule's chains and the unpriced failures.

// The rule's chained answers in one arm: counts, transaction counts and the
// whole-chain fees, over the wallets of `tables`. Totals are raw, not
// weighted.
export function chainSummary(tables, kind) {
  const out = { wallets: 0, attempted: 0, built: 0, chained: 0, byTxs: {}, totalFee: 0n, totalWalletFee: 0n, perChain: null };
  const chains = [];
  for (const t of tables) {
    const run = liveRuns(arm(t, RULE_METHOD, kind))[0];
    if (!run) continue;
    out.wallets++;
    out.attempted += run.n.attempted;
    out.built += run.n.built;
    for (const s of run.spends.values()) {
      if (s.outcome !== 'built') continue;
      out.byTxs[s.txs] = (out.byTxs[s.txs] || 0) + 1;
      if (s.chained) {
        out.chained++;
        out.totalFee += s.fee;
        out.totalWalletFee += s.walletFee;
        chains.push(s);
      }
    }
  }
  if (chains.length) {
    const fees = chains.map((s) => s.fee);
    const min = fees.reduce((a, b) => (b < a ? b : a));
    const max = fees.reduce((a, b) => (b > a ? b : a));
    out.perChain = { meanFee: Number(out.totalFee) / chains.length, meanWalletFee: Number(out.totalWalletFee) / chains.length, minFee: min.toString(), maxFee: max.toString() };
  }
  return { ...out, totalFee: out.totalFee.toString(), totalWalletFee: out.totalWalletFee.toString() };
}

// Per arm, the failures that name a part other than redeemers (section 6.4's
// unpriced parts), summed over runs, and the wallets with any.
export function unpricedCounts(tables) {
  const out = {};
  for (const id of armIds()) {
    if (!tables.some((t) => t.arms.has(id))) continue;
    let failures = 0;
    let wallets = 0;
    for (const t of tables) {
      const n = liveRuns(t.arms.get(id)).reduce((s, r) => s + r.unpricedFailures, 0);
      failures += n;
      if (n > 0) wallets++;
    }
    out[id] = { failures, wallets };
  }
  return out;
}

// ---- Breakdowns and the run.

const join = (...parts) => parts.filter(Boolean).join('/');
const spendTypes = (tables) => [...new Set(tables.flatMap((t) => [...t.arms.values()].flatMap((a) => [...a.runs.values()].flatMap((r) => [...r.spends.values()].map((s) => s.type)))))].sort();

const cellOfResult = (spec, scope, name, res, suppress) => {
  const n = spec.entries.length;
  const out = { name, ...spec.meta, statistic: spec.statistic, scope, n };
  if (suppress) return { ...out, suppressed: true, estimate: null, interval: null, resamples: 0, dropped: 0 };
  return { ...out, estimate: res.estimate, interval: res.intervals[LEVEL] || null, resamples: res.resamples, dropped: res.dropped };
};

// Runs the items on one split's tables of one window.
//   { libraries, cells: [{ name, item, ..., statistic, scope: { kind, label }, n,
//     estimate, interval: [lo, hi] | null, resamples, dropped, suppressed? }],
//     counts: { <scope>: { chains: { on, off }, unpriced } } }
// `scope` is { kind: 'main' } or a breakdown { kind: 'size'|'type'|'frag',
// label }. Cells come in a fixed order, so equal tables give equal bytes at any
// worker count.
export async function runItems(tables, { workers = 1, resamples, libraries = studyLibraries(tables), suffix = '', flag = 'fragmented' } = {}) {
  const opts = { workers, levels: [Number(LEVEL)], ...(resamples === undefined ? {} : { resamples }) };
  const planned = []; // { spec, scope, name, suppress }
  const absent = [];
  const counts = {};
  const nm = (base, seg = '') => join(base, seg, suffix);
  const plan = (spec, scope, seg, suppress) => planned.push({ spec, scope, name: nm(spec.base, seg), suppress: suppress && spec.entries.length < MIN_CELL_WALLETS });

  // The whole sample.
  const mainSpecs = [...valueSpecs(tables, libraries, { primary: true, absorption: true }), ...endSpecs(tables, libraries, Object.keys(POPULATIONS))];
  for (const spec of mainSpecs) if (spec.whole) plan(spec, { kind: 'main' }, '', !!spec.meta.population && spec.meta.population !== 'all');
  counts.main = { chains: { on: chainSummary(tables, 'on'), off: chainSummary(tables, 'off') }, unpriced: unpricedCounts(tables) };

  // By size group: merged per cell from B3 down.
  for (const spec of mainSpecs) {
    if (!spec.sizeable) continue;
    const per = {};
    for (const e of spec.entries) per[e.group] = (per[e.group] || 0) + 1;
    const merged = mergeSizeGroups(per);
    for (const cell of merged.cells) {
      const sub = { ...spec, entries: spec.entries.filter((e) => cell.groups.includes(e.group)) };
      plan(sub, { kind: 'size', label: cell.label }, `size/${cell.label}`, false);
    }
    // A merge that reaches B0 leaves only the whole-sample cell; the breakdown is marked absent.
    if (merged.wholeOnly && !absent.some((a) => a.name === nm(spec.base, 'size'))) absent.push({ name: nm(spec.base, 'size'), ...spec.meta, statistic: spec.statistic, scope: { kind: 'size', label: null }, n: spec.entries.length, absent: true, reason: 'the ten-wallet merge reaches B0, so only the whole-sample cell is reported', estimate: null, interval: null, resamples: 0, dropped: 0 });
  }

  // By spend type and by the flag: the same items on filtered tables, the
  // primary outcomes and the absorption cells through runQuestions.
  const questionCells = [];
  const scopes = [];
  for (const type of spendTypes(tables)) scopes.push({ kind: 'type', label: type, tables: tables.map((t) => restrictTable(t, (s) => s.type === type)), end: false });
  if (tables.some((t) => typeof t.flags[flag] === 'boolean')) {
    for (const yes of [true, false]) scopes.push({ kind: 'frag', label: yes ? 'yes' : 'no', tables: tables.filter((t) => t.flags[flag] === yes), end: true });
  }
  for (const sc of scopes) {
    const seg = `${sc.kind}/${sc.label}`;
    const specs = [...valueSpecs(sc.tables, libraries, { primary: false, absorption: false }), ...(sc.end ? endSpecs(sc.tables, libraries, ['all']) : [])];
    for (const spec of specs) plan(spec, { kind: sc.kind, label: sc.label }, seg, true);
    counts[seg] = { chains: { on: chainSummary(sc.tables, 'on'), off: chainSummary(sc.tables, 'off') }, unpriced: unpricedCounts(sc.tables) };
    questionCells.push({ sc, seg });
  }

  // One bootstrap for the planned cells, one name once.
  const live = planned.filter((p) => !p.suppress);
  const byName = new Map();
  for (const p of live) if (!byName.has(p.name)) byName.set(p.name, { name: p.name, statistic: p.spec.statistic, wallets: p.spec.entries.map(({ id, group, weight, v }) => ({ id, group, weight, v })) });
  const results = new Map((await bootstrap([...byName.values()], opts)).map((r) => [r.name, r]));
  const cells = planned.map((p) => cellOfResult(p.spec, p.scope, p.name, results.get(p.name), p.suppress));
  cells.push(...absent);

  for (const { sc, seg } of questionCells) {
    const res = await runQuestions(sc.tables, { workers, ...(resamples === undefined ? {} : { resamples }), libraries, suffix: join(seg, suffix) });
    for (const c of [...res.cells, res.absorption.fees, res.absorption.failures]) {
      const base = { name: c.name, item: c.question ? 'primary' : 'absorption', ...(c.question ? { question: c.question, outcome: c.outcome, library: c.library } : { outcome: c.name.includes('/fees/') ? 'fees' : 'failures' }), statistic: c.name.includes('/fees/') ? 'median' : 'mean', scope: { kind: sc.kind, label: sc.label }, n: c.n };
      if (c.n < MIN_CELL_WALLETS) cells.push({ ...base, suppressed: true, estimate: null, interval: null, resamples: 0, dropped: 0 });
      else cells.push({ ...base, estimate: c.estimate, interval: c.intervals[LEVEL] || null, resamples: c.resamples, dropped: c.dropped });
    }
  }
  return { libraries, cells, counts };
}

// ---- Item 8's distribution: the times of rows { method, kind, type, ms }.

// Per library and arm (`<method>/<kind>`) and per method and spend type, the
// distribution of the spend records' times in ms.
export function timingSummary(rows) {
  const c = new TimingCollector();
  for (const r of rows) c.add(r);
  const { byArm, byMethodAndType } = c.summary();
  return { byArm, byMethodAndType };
}
