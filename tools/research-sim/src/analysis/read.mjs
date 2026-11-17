// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The analysis scripts' reader: a study run's replay stage (and, outside the
// synthetic plan, its history stage) read into per-wallet tables, one wallet
// at a time, after every refusal the stage's files allow. It computes no
// statistic and writes nothing.
//
// Layout read, under <root>/<network>/<study>/ (history/paths.mjs):
//   study.json                      plan, network, collateral rule
//   replay-<window>/                records.jsonl.gz, done.json, run.json,
//                                   wallets.json (out/stage.mjs)
//   history-<window>/               history-run.json and history/<file>.jsonl
//                                   (absent for the synthetic plan)
//   census/                         census.jsonl, census-run.json
// In the synthetic plan the records' window is 'synthetic', no wallet has a
// history file, every wallet is in size group B0 at weight 1 with split null,
// and a chained answer's fixed part comes only from a sibling record.
//
// Per wallet the reader gives (wallet table):
//   index, wallet, split, group, weight, capped, collateral, flags, minFeeA,
//   maxValSize, intents, arms
// where arms maps an arm id (`<method>/own`, `<method>/layout`,
// `unfrackit-h12/on`, `unfrackit-h12/off`) to { id, method, kind, absorb,
// runs: Map repetition -> run }. A run holds the counts by outcome, the
// failure classes, the spends by intent, the H-7 fields, the points of the
// drift slopes and the wallet-arm's summary (see reduceRun). The wallet-
// controlled fee of a built spend is the record's walletFee for one
// transaction and fee minus the intent's fixed part (its scriptFee plus
// minFeeA times fixedBytes) for a chained answer (section 6.2). The reader
// reads the fields the trunk writes and uses the ones a later change adds
// (the draw's sensitivity flags, the census row's coin, a spend's spendable
// count) when they are present, and requires none of them.

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';
import { runDir, homeDir } from '../history/paths.mjs';
import { LIBRARY_TABLE } from '../arms/plan.mjs';
import { RECORD_KINDS, KEY_FIELDS } from '../out/records.mjs';
import { COLLATERAL_RULES } from '../replay/collateral.mjs';
import { HISTORY_FORMAT } from '../state/history.mjs';
import { intentFromHistory } from '../state/intent.mjs';
import { withoutLeftovers } from '../kit/replay.mjs';
import { normalizeParams, SYNTHETIC_PARAMS } from '../kit/params.mjs';
import { depositParts } from './deposits.mjs';
import { slopesOfPoints } from './slope.mjs';
import { SpendTable } from './spends.mjs';

export class AnalysisRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'AnalysisRefusal';
  }
}
const refuse = (m) => {
  throw new AnalysisRefusal(`refusing: ${m}`);
};

export const WINDOWS = Object.freeze(['recent', 'peak']);
export const SPLITS = Object.freeze(['exploration', 'confirmation']);
export const RULE_METHOD = 'unfrackit-h12';
export const SIZE_GROUPS = Object.freeze(['B0', 'B1', 'B2', 'B3']);
export const E1_LEVELS = Object.freeze([0.5, 0.8, 0.9]);
export const E3_LOVELACE = 5_000_000n;
const OUTCOMES = Object.freeze(['built', 'failed', 'infeasible', 'infeasible-collateral', 'not-replayable', 'forfeit']);
const SHA256 = /^[0-9a-f]{64}$/;
const UNPRICED = /; parts the library did not price: (.+)$/;
const CONSERVATION = /coin: (\d+) consumed, (\d+) produced/;

const LIBRARIES = Object.freeze(LIBRARY_TABLE.map((r) => ({ method: r.method, random: r.random })));
const LIBRARY_BY_METHOD = new Map(LIBRARIES.map((l) => [l.method, l]));
export const libraryMethods = () => LIBRARIES.map((l) => l.method);

// Every arm of a wallet, in the order the tables use: each library's own then
// its layout arm, in LIBRARY_TABLE order, then the rule's two arms.
export function armIds() {
  const ids = [];
  for (const l of LIBRARIES) ids.push(`${l.method}/own`, `${l.method}/layout`);
  ids.push(`${RULE_METHOD}/on`, `${RULE_METHOD}/off`);
  return ids;
}

// The arm a record's key names, or a refusal.
export function armOf(r) {
  if (r.arm !== 'observed') refuse(`a record of the arm ${JSON.stringify(r.arm)}`);
  if (r.method === RULE_METHOD) {
    if (r.change !== 'default' || (r.variant !== 'absorb-on' && r.variant !== 'absorb-off')) refuse(`a rule record with change ${JSON.stringify(r.change)} and variant ${JSON.stringify(r.variant)}`);
    const absorb = r.variant === 'absorb-on';
    return { id: `${RULE_METHOD}/${absorb ? 'on' : 'off'}`, method: RULE_METHOD, kind: absorb ? 'on' : 'off', absorb, random: false };
  }
  const lib = LIBRARY_BY_METHOD.get(r.method);
  if (!lib) refuse(`a record of the unknown method ${JSON.stringify(r.method)}`);
  if (r.variant !== 'default') refuse(`a record of ${r.method} with the unknown variant ${JSON.stringify(r.variant)}`);
  if (r.change !== 'default' && r.change !== 'layout') refuse(`a record of ${r.method} with the unknown change ${JSON.stringify(r.change)}`);
  const kind = r.change === 'default' ? 'own' : 'layout';
  return { id: `${r.method}/${kind}`, method: r.method, kind, absorb: null, random: lib.random };
}

const sha256Of = (buf) => createHash('sha256').update(buf).digest('hex');
const readJson = (path, what) => {
  if (!existsSync(path)) refuse(`${what} is missing`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return refuse(`${what} does not parse (${e.message})`);
  }
};

// The command line's options, checked and normalized. Nothing is read but the
// --drop file's existence. `window` is not a command-line option (a run reads
// both windows' stages); it is the window one openStudy call reads, 'recent'
// when not given. A synthetic study takes no --split: every wallet enters.
export function checkOptions(o = {}) {
  const need = (k) => {
    if (o[k] === undefined || o[k] === null || o[k] === '') refuse(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
    return o[k];
  };
  const network = need('network');
  if (!/^[a-z]+$/.test(network)) refuse(`bad network name ${network}`);
  const synthetic = network === 'synthetic';
  const study = need('study');
  try {
    runDir(network, study);
  } catch (e) {
    refuse(e.message);
  }
  if (String(study).includes('/')) refuse(`the study run id must name a study run, not a stage: ${study}`);
  const window = o.window === undefined || o.window === null ? 'recent' : o.window;
  if (!WINDOWS.includes(window)) refuse(`the window must be one of ${WINDOWS.join(', ')}, not ${window}`);
  let split = null;
  if (synthetic) {
    if (o.split !== undefined && o.split !== null) refuse('--network synthetic takes no --split: every wallet of a synthetic study enters');
  } else {
    split = need('split');
    if (!SPLITS.includes(split)) refuse(`--split must be one of ${SPLITS.join(', ')}, not ${split}`);
  }
  const freeze = o.analysisFreezeTx === undefined || o.analysisFreezeTx === null ? null : String(o.analysisFreezeTx);
  if (freeze !== null && !SHA256.test(freeze)) refuse('--analysis-freeze-tx must be a transaction hash of 64 lowercase hex digits');
  if (split === 'confirmation' && freeze === null) refuse('--split confirmation needs --analysis-freeze-tx: the confirmation split is read only after the analysis scripts are frozen');
  const workers = o.workers === undefined ? 1 : Number(o.workers);
  if (!Number.isSafeInteger(workers) || workers < 1) refuse(`--workers must be a positive whole number, not ${o.workers}`);
  const out = need('out');
  const drop = o.drop === undefined || o.drop === null ? null : String(o.drop);
  if (drop !== null && !existsSync(drop)) refuse('--drop names a file that does not exist');
  return { network, study, window, split, analysisFreezeTx: freeze, workers, out, drop, root: o.root || homeDir() };
}

// The wallet ids of a --drop file: a JSON array or one id per line. The
// file is private, and no id from it reaches an output.
export function readDropList(path) {
  const text = readFileSync(path, 'utf8');
  let ids;
  if (/^\s*\[/.test(text)) {
    try {
      ids = JSON.parse(text);
    } catch (e) {
      return refuse(`--drop file does not parse (${e.message})`);
    }
  } else {
    ids = text.split('\n').map((l) => l.trim()).filter((l) => l.length && !l.startsWith('#'));
  }
  if (!Array.isArray(ids) || ids.some((x) => !(typeof x === 'string' || Number.isSafeInteger(x)) || String(x).trim() === '')) refuse('--drop file is not a list of wallet ids');
  return new Set(ids.map((x) => String(x).trim()));
}

// The weight D_k / A_k of a size group in a frame's draw (section 7.1), as
// the pair and the ratio. A sampled wallet ('random') weighs by the sample's
// groups, a pilot wallet by the pilot's own (`draw.pilot`).
export function groupWeight(draw, group, kind = 'random') {
  const part = draw && kind === 'pilot' ? draw.pilot : draw;
  if (kind === 'pilot' && draw && !draw.pilot) refuse('the draw holds no pilot groups');
  const g = part && part.groups ? part.groups[group] : undefined;
  if (!g) refuse(`the draw holds no ${kind === 'pilot' ? 'pilot ' : ''}group ${group}`);
  if (!Number.isSafeInteger(g.nDrawn) || !Number.isSafeInteger(g.nTaken) || g.nTaken < 1 || g.nDrawn < g.nTaken) refuse(`the draw's ${kind === 'pilot' ? 'pilot ' : ''}group ${group} has D=${g.nDrawn}, A=${g.nTaken}`);
  return { nDrawn: g.nDrawn, nTaken: g.nTaken, w: g.nDrawn / g.nTaken };
}

// A history file's header, read from its first line alone (a wallet of the
// other split is not parsed any further).
export function peekHeader(text) {
  const at = text.indexOf('\n');
  let header;
  try {
    header = JSON.parse(at < 0 ? text : text.slice(0, at));
  } catch (e) {
    return refuse(`a history file's first line does not parse (${e.message})`);
  }
  if (!header || header.kind !== 'header') refuse('a history file has no header');
  return header;
}

// A history file read for what the analysis needs: the header, the end
// record and, per intent event in order, the fixed part of its fee (d), the
// implicit deposits it carries (their total and one entry per certificate,
// proposal and new pool) and its type. Nothing here loads CSL.
export function parseHistoryFile(text, { analysisFreezeTx = null } = {}) {
  const lines = text.split('\n').filter((l) => l.length).map((l) => JSON.parse(l));
  if (!lines.length || lines[0].kind !== 'header') refuse('a history file has no header');
  const header = lines[0];
  if (header.format !== HISTORY_FORMAT) refuse(`a history file of format ${header.format}, expected ${HISTORY_FORMAT}`);
  if (header.split === 'confirmation' && !analysisFreezeTx) refuse(`the history file of wallet ${header.wallet} is in the confirmation split, and no analysis-freeze transaction was given`);
  const end = lines[lines.length - 1];
  if (end.kind !== 'end') refuse(`the history file of wallet ${header.wallet} has no end record`);
  const params = normalizeParams(header.params);
  const intents = [];
  for (const e of lines.slice(1, -1)) {
    if (e.kind !== 'intent') continue;
    const it = withoutLeftovers(intentFromHistory(e.intent));
    const d = it.fixed ? it.fixed.scriptFee + params.minFeeA * BigInt(it.fixed.fixedBytes) : 0n;
    // The deposits one by one; when they do not add up to the history reader's
    // total (a key deposit that differs from the header's), the total stands as
    // the one deposit.
    let parts = depositParts(it, params);
    if (parts.reduce((a, b) => a + b, 0n) !== it.implicit.deposits) parts = it.implicit.deposits > 0n ? [it.implicit.deposits] : [];
    intents.push({ type: it.type, d, scriptFee: it.fixed ? it.fixed.scriptFee : 0n, fixedBytes: it.fixed ? it.fixed.fixedBytes : 0, deposits: it.implicit.deposits, depositParts: parts });
  }
  if (end.counts && end.counts.intent !== undefined && end.counts.intent !== intents.length) refuse(`the history file of wallet ${header.wallet} has ${intents.length} intent events, its end record says ${end.counts.intent}`);
  return { header, params, end, intents };
}

// A gzip stream of JSON lines as parsed lines, hashed as they go. The generator
// ends by checking the decompressed bytes against the digest of done.json.
async function* gzLines(path, digest, what) {
  const hash = createHash('sha256');
  const dec = new StringDecoder('utf8');
  let bytes = 0;
  let lines = 0;
  let rest = '';
  const gz = createReadStream(path).pipe(createGunzip());
  for await (const chunk of gz) {
    hash.update(chunk);
    bytes += chunk.length;
    rest += dec.write(chunk);
    let at;
    let from = 0;
    while ((at = rest.indexOf('\n', from)) >= 0) {
      const line = rest.slice(from, at);
      from = at + 1;
      lines++;
      yield JSON.parse(line);
    }
    rest = rest.slice(from);
  }
  rest += dec.end();
  if (rest.length) refuse(`the stage's ${what} do not end with a line break`);
  if (!digest || hash.digest('hex') !== digest.sha256 || bytes !== digest.bytes || lines !== digest.lines) refuse(`the stage's decompressed ${what} do not match done.json (SHA-256, bytes or lines)`);
}
const recordLines = (path, done) => gzLines(path, done.records, 'records');

// The timing rows of a stage, in step with the wallets: take(i) gives the rows
// of wallet i (the stream is ordered by wallet index), end() reads the rest and
// so checks the stream against done.json.
class TimingCursor {
  constructor(path, digest) {
    this.it = gzLines(path, digest, 'timings')[Symbol.asyncIterator]();
    this.head = undefined;
  }
  async fill() {
    if (this.head === undefined) {
      const r = await this.it.next();
      this.head = r.done ? null : r.value;
    }
  }
  async take(index) {
    const rows = [];
    for (;;) {
      await this.fill();
      if (this.head === null || this.head.walletIndex > index) return rows;
      if (this.head.walletIndex === index) rows.push(this.head);
      this.head = undefined;
    }
  }
  async end() {
    for (;;) {
      await this.fill();
      if (this.head === null) return;
      this.head = undefined;
    }
  }
}

// The study opened: every refusal that needs no wallet. Returns the context
// the wallet stream and the census reader use.
export function openStudy(rawOptions) {
  const o = checkOptions(rawOptions);
  const synthetic = o.network === 'synthetic';
  const studyDir = join(o.root, o.network, o.study);
  const study = readJson(join(studyDir, 'study.json'), 'study.json');
  if (study.network !== o.network) refuse(`study.json is of the network ${study.network}, not ${o.network}`);
  if (synthetic && study.plan !== 'synthetic') refuse('--network synthetic reads a synthetic-plan study; this study\'s plan is ' + study.plan);
  if (!synthetic && study.plan === 'synthetic') refuse('a synthetic-plan study is read only with --network synthetic');
  const rule = study.collateralRule && study.collateralRule.rule;
  if (!COLLATERAL_RULES.includes(rule)) refuse(`study.json names no known collateral rule (${JSON.stringify(rule)})`);

  const stageDir = join(studyDir, `replay-${o.window}`);
  if (!existsSync(join(stageDir, 'done.json'))) refuse(`the replay stage replay-${o.window} has no done.json: it has not ended`);
  const done = readJson(join(stageDir, 'done.json'), 'done.json');
  if (!existsSync(join(stageDir, 'run.json'))) refuse('the replay stage has no run.json');
  if (sha256Of(readFileSync(join(stageDir, 'run.json'))) !== done.runSha256) refuse('done.json belongs to another run.json');
  const walletsText = readFileSync(join(stageDir, 'wallets.json'));
  const entries = readJson(join(stageDir, 'wallets.json'), 'wallets.json');
  if (!Array.isArray(entries) || entries.length !== done.wallets) refuse('wallets.json does not list the wallets done.json counts');
  if (!existsSync(join(stageDir, 'records.jsonl.gz'))) refuse('the replay stage has no records.jsonl.gz');
  for (const e of entries) {
    if (synthetic ? typeof e.shape !== 'string' : typeof e.file !== 'string' || !SHA256.test(String(e.sha256))) refuse('a wallets.json entry does not fit the plan');
  }

  let historyRun = null;
  let draw = null;
  const historyDir = join(studyDir, `history-${o.window}`);
  if (!synthetic) {
    historyRun = readJson(join(historyDir, 'history-run.json'), 'history-run.json');
    if (!historyRun.draw || typeof historyRun.draw !== 'object') refuse('history-run.json holds no draw: the study tables were not read');
    draw = historyRun.draw[o.window];
    if (!draw) refuse(`the draw holds no frame ${o.window}`);
    if (!draw.pilot || typeof draw.pilot !== 'object') refuse(`the draw of frame ${o.window} holds no pilot groups`);
    for (const g of SIZE_GROUPS) for (const [what, part] of [['sample', draw], ['pilot', draw.pilot]]) if (!part.groups || !part.groups[g]) refuse(`the draw's ${what} holds no group ${g}`);
    if (historyRun.analysisFreezeTx && o.analysisFreezeTx && historyRun.analysisFreezeTx !== o.analysisFreezeTx) refuse('history-run.json names another analysis-freeze transaction than --analysis-freeze-tx');
    if (o.split === 'confirmation' && historyRun.analysisFreezeTx !== o.analysisFreezeTx) refuse('history-run.json does not name the analysis-freeze transaction given');
  }
  return {
    options: o,
    synthetic,
    studyDir,
    stageDir,
    historyDir,
    study,
    collateralRule: rule,
    done,
    entries,
    walletsSha256: sha256Of(walletsText),
    historyRun,
    draw,
    drop: o.drop ? readDropList(o.drop) : new Set()
  };
}

function flagsOf(draw) {
  const out = {};
  if (!draw) return out;
  for (const k of Object.keys(draw).sort()) if (typeof draw[k] === 'boolean' && k !== 'capped') out[k] = draw[k];
  return out;
}

// The wallet ids a wallets.json entry names: a file `<id>.<window>.jsonl` or a shape.
const walletOfEntry = (e) => (e.shape !== undefined ? e.shape : e.file.split('.')[0]);

// Strings that recur in every record (spend types, failure classes) kept once.
const interned = new Map();
const intern = (x) => {
  if (typeof x !== 'string') return x;
  let v = interned.get(x);
  if (v === undefined) interned.set(x, (v = x));
  return v;
};
const NO_NAMES = Object.freeze([]);

// A run (one arm, one repetition) reduced to the values the computations read.
// spends: the spend records in order; arm: the wallet-arm record or null;
// refusedReason: the refused record's reason or null; feeFor(intent): the fixed
// part of a chained answer's fee. maxValSize decides E1. A run holds:
//   refused, n (counts by outcome), byClass, unpricedFailures,
//   spends (by intent: intent, type, outcome; built: txs, chained, fee,
//     walletFee, spendable; failed or not replayable: class, unpriced,
//     conservation),
//   h7 (E1 at 0.5, 0.8, 0.9, E2, E3, worse), slopes (the three drift
//     slopes), summary ({ capped, end { utxos, largestValueBytes,
//     lockedAdaPerToken }, conformity }).
// Nothing else of a record is kept: the tables of every wallet are held at once.
function reduceRun({ spends, armRecord, refusedReason, maxValSize, feeFor }) {
  const run = {
    refused: refusedReason,
    n: { attempted: 0, built: 0, failed: 0, infeasible: 0, infeasibleCollateral: 0, notReplayable: 0, forfeit: 0, chains: 0 },
    byClass: {},
    unpricedFailures: 0,
    spends: new SpendTable(spends.length),
    h7: null,
    slopes: null,
    summary: null
  };
  if (armRecord) {
    const a = armRecord;
    const big = (x) => (x === null || x === undefined ? null : BigInt(x));
    run.summary = {
      capped: a.capped === true,
      end: a.end ? { utxos: a.end.utxos, largestValueBytes: a.end.largestValueBytes, lockedAdaPerToken: big(a.end.lockedAdaPerToken) } : null,
      conformity: a.conformity ? { ...a.conformity, fee: big(a.conformity.fee) } : null
    };
  }
  const e1 = Object.fromEntries(E1_LEVELS.map((x) => [x, false]));
  let changeCount = 0;
  let consumed = 0;
  let changeMin = 0n;
  let consumedMin = 0n;
  let builtN = 0;
  const pts = armRecord && armRecord.start ? { t: [Number(armRecord.start.t || 0)], utxos: [armRecord.start.utxos], largestValueBytes: [armRecord.start.largestValueBytes], lockedAdaPerToken: [armRecord.start.lockedAdaPerToken === null || armRecord.start.lockedAdaPerToken === undefined ? null : BigInt(armRecord.start.lockedAdaPerToken)] } : null;
  let last = -1;
  for (const r of spends) {
    if (!OUTCOMES.includes(r.outcome)) refuse(`a spend record with the unknown outcome ${JSON.stringify(r.outcome)}`);
    if (!Number.isSafeInteger(r.intent) || r.intent <= last) refuse(`spend records of one run out of order at intent ${r.intent}`);
    last = r.intent;
    const s = { intent: r.intent, type: intern(r.type), outcome: r.outcome };
    if (r.outcome === 'built') {
      const fee = BigInt(r.fee);
      const chained = r.txs > 1;
      s.txs = r.txs;
      s.chained = chained;
      s.fee = fee;
      s.walletFee = chained ? fee - feeFor(r.intent, 'chain') : r.walletFee === r.fee ? fee : BigInt(r.walletFee);
      if (r.spendableUtxos !== undefined) s.spendable = r.spendableUtxos;
      if (chained) run.n.chains++;
      run.n.built++;
      run.n.attempted++;
      builtN++;
      const changeBytes = r.changeOutputs.largestValueBytes;
      for (const x of E1_LEVELS) if (changeBytes > x * maxValSize && r.largestConsumedValueBytes <= x * maxValSize) e1[x] = true;
      changeCount += r.changeOutputs.count;
      consumed += r.consumedWalletInputs;
      changeMin += BigInt(r.changeTokenMinimum);
      consumedMin += BigInt(r.consumedTokenMinimum);
      if (pts) {
        pts.t.push(r.t);
        pts.utxos.push(r.utxosAfter);
        pts.largestValueBytes.push(r.largestValueBytesAfter);
        pts.lockedAdaPerToken.push(r.lockedAdaPerTokenAfter === null ? null : BigInt(r.lockedAdaPerTokenAfter));
      }
    } else if (r.outcome === 'failed' || r.outcome === 'not-replayable') {
      s.class = intern(r.class);
      const m = UNPRICED.exec(r.detail || '');
      s.unpriced = m ? m[1].split(', ').map(intern) : NO_NAMES;
      const c = CONSERVATION.exec(r.detail || '');
      s.conservation = c ? { consumed: BigInt(c[1]), produced: BigInt(c[2]) } : null;
      if (r.outcome === 'failed') {
        run.n.failed++;
        run.n.attempted++;
        run.byClass[s.class] = (run.byClass[s.class] || 0) + 1;
        if (s.unpriced.some((n) => n !== 'redeemers')) run.unpricedFailures++;
      } else run.n.notReplayable++;
    } else if (r.outcome === 'infeasible') run.n.infeasible++;
    else if (r.outcome === 'infeasible-collateral') run.n.infeasibleCollateral++;
    else run.n.forfeit++;
    run.spends.add(s);
  }
  if (armRecord && armRecord.start) {
    const net = changeCount - consumed;
    const minNet = changeMin - consumedMin;
    run.h7 = {
      builtSpends: builtN,
      e1,
      e2: { net, worse: net >= 10 && net >= armRecord.start.utxos },
      e3: { net: minNet, worse: minNet >= E3_LOVELACE }
    };
    run.h7.worse = e1[0.8] || run.h7.e2.worse || run.h7.e3.worse;
    run.slopes = slopesOfPoints(pts);
  }
  return run;
}

// One wallet's records (and history file) reduced to its table. Refusals of
// section "Inputs" of the analysis brief: unknown keys, missing arms,
// disagreeing collateral or capped flags, a missing group, a history file
// that does not match wallets.json. A wallet in --drop, and one of the other
// split, is not reduced: the result is { index, wallet, skip: 'dropped' |
// 'otherSplit' } (its history file is still checked against wallets.json and
// its header read; the done.json hash covers its records).
export function reduceWallet(ctx, index, records) {
  const entry = ctx.entries[index];
  const id = walletOfEntry(entry);
  const o = ctx.options;
  if (ctx.drop.has(id)) return { index, wallet: id, skip: 'dropped' };
  let hist = null;
  if (!ctx.synthetic) {
    const path = join(ctx.historyDir, 'history', entry.file);
    if (!existsSync(path)) refuse(`wallet ${index}: its history file is missing`);
    const bytes = readFileSync(path);
    if (sha256Of(bytes) !== entry.sha256) refuse(`wallet ${index}: its history file does not match wallets.json's SHA-256`);
    const text = bytes.toString('utf8');
    const head = peekHeader(text);
    if (head.format !== HISTORY_FORMAT) refuse(`a history file of format ${head.format}, expected ${HISTORY_FORMAT}`);
    if (head.split === 'confirmation' && !o.analysisFreezeTx) refuse(`the history file of wallet ${head.wallet} is in the confirmation split, and no analysis-freeze transaction was given`);
    if (String(head.wallet) !== id) refuse(`wallet ${index}: its history file's wallet differs from its name`);
    if (head.frame !== o.window) refuse(`wallet ${index}: its history file is of the frame ${head.frame}`);
    if (head.split !== 'exploration' && head.split !== 'confirmation') refuse(`wallet ${index}: its history header names no split`);
    if (head.split === 'confirmation' && ctx.historyRun.analysisFreezeTx !== o.analysisFreezeTx) refuse(`wallet ${index}: a confirmation-split wallet, and history-run.json does not name the analysis-freeze transaction given`);
    if (!head.draw) refuse(`wallet ${index}: its history header has no draw`);
    const kind = head.draw.kind;
    if (kind !== 'random' && kind !== 'pilot') refuse(`wallet ${index}: its history header's draw has the kind ${JSON.stringify(kind)}, not random or pilot`);
    if ((kind === 'pilot') !== (head.split === 'exploration')) refuse(`wallet ${index}: its split ${head.split} and its draw kind ${kind} disagree`);
    if (head.split !== o.split) return { index, wallet: id, skip: 'otherSplit' };
    hist = parseHistoryFile(text, { analysisFreezeTx: o.analysisFreezeTx });
  }
  const header = hist ? hist.header : null;
  const params = hist ? hist.params : SYNTHETIC_PARAMS;
  const stageWindow = ctx.synthetic ? 'synthetic' : o.window;

  const jobs = new Map();
  const collaterals = new Set();
  for (const r of records) {
    if (!RECORD_KINDS.includes(r.kind)) refuse(`a record of the unknown kind ${JSON.stringify(r.kind)}`);
    for (const k of KEY_FIELDS) if (r[k] === undefined) refuse(`a ${r.kind} record without ${k}`);
    if (r.window !== stageWindow) refuse(`a record of the window ${JSON.stringify(r.window)}, expected ${stageWindow}`);
    if (String(r.wallet) !== id) refuse(`wallet ${index}: a record of another wallet`);
    const arm = armOf(r);
    if (!Number.isSafeInteger(r.repetition) || r.repetition < 1) refuse(`a record with repetition ${r.repetition}`);
    collaterals.add(r.collateral);
    const key = `${arm.id}#${r.repetition}`;
    let j = jobs.get(key);
    if (!j) jobs.set(key, (j = { arm, repetition: r.repetition, spends: [], bursts: 0, armRecord: null, refused: null }));
    if (r.kind === 'spend') j.spends.push(r);
    else if (r.kind === 'burst') j.bursts++;
    else if (r.kind === 'wallet-arm') {
      if (j.armRecord) refuse(`wallet ${index}: two wallet-arm records for ${key}`);
      j.armRecord = r;
      if (arm.method === RULE_METHOD && r.absorb !== undefined && r.absorb !== arm.absorb) refuse(`wallet ${index}: a rule record whose absorb differs from its variant`);
    } else j.refused = r.reason;
  }
  if (collaterals.size !== 1) refuse(`wallet ${index}: its jobs disagree on collateral`);
  const collateral = [...collaterals][0];
  if (collateral !== ctx.collateralRule && collateral !== 'none-needed') refuse(`wallet ${index}: collateral ${JSON.stringify(collateral)} differs from the study's rule ${ctx.collateralRule}`);

  // Completeness: every library's two arms and the rule's two arms, each at
  // its repetitions. The synthetic plan may run a subset of the libraries.
  const reps = new Map();
  for (const j of jobs.values()) {
    if (!reps.has(j.arm.id)) reps.set(j.arm.id, new Set());
    reps.get(j.arm.id).add(j.repetition);
  }
  const want = ctx.synthetic ? armIds().filter((a) => reps.has(a)) : armIds();
  const randomN = new Set();
  for (const a of want) {
    const have = reps.get(a);
    if (!have) refuse(`wallet ${index}: arm ${a} is missing`);
    const method = a.split('/')[0];
    const lib = LIBRARY_BY_METHOD.get(method);
    const n = have.size;
    for (let r = 1; r <= n; r++) if (!have.has(r)) refuse(`wallet ${index}: arm ${a} lacks repetition ${r}`);
    if (!lib || !lib.random) {
      if (n !== 1) refuse(`wallet ${index}: arm ${a} has ${n} repetitions, a deterministic arm has one`);
    } else randomN.add(n);
  }
  if (randomN.size > 1) refuse(`wallet ${index}: the random libraries' arms have different repetition counts`);
  if (ctx.synthetic) {
    // The paired arms of a library come together.
    for (const l of LIBRARIES) if (reps.has(`${l.method}/own`) !== reps.has(`${l.method}/layout`)) refuse(`wallet ${index}: ${l.method} has one of its two arms`);
    if (reps.has(`${RULE_METHOD}/on`) !== reps.has(`${RULE_METHOD}/off`)) refuse(`wallet ${index}: the rule has one of its two arms`);
  }

  // capped: header, history end and every wallet-arm agree.
  const cappedSeen = new Set();
  if (header) {
    cappedSeen.add(!!(header.draw && header.draw.capped));
    cappedSeen.add(hist.end.capped === true);
  }
  for (const j of jobs.values()) if (j.armRecord) cappedSeen.add(j.armRecord.capped === true);
  if (cappedSeen.size > 1) refuse(`wallet ${index}: the header, the history end and the wallet-arm records disagree on capped`);
  const capped = cappedSeen.size ? [...cappedSeen][0] : false;

  // The size group and weight.
  let group = 'B0';
  let weight = { nDrawn: 1, nTaken: 1, w: 1 };
  let flags = {};
  if (header) {
    group = header.draw.sizeGroup;
    weight = groupWeight(ctx.draw, group, header.draw.kind);
    flags = flagsOf(header.draw);
  }

  // The fixed part of a fee: sibling single-transaction records give d =
  // fee - walletFee for their intent; the history gives it where there is one.
  const sibling = new Map();
  for (const j of jobs.values()) {
    for (const r of j.spends) {
      if (r.outcome !== 'built' || r.txs !== 1) continue;
      const d = BigInt(r.fee) - BigInt(r.walletFee);
      if (sibling.has(r.intent) && sibling.get(r.intent) !== d) refuse(`wallet ${index}: intent ${r.intent} is built with two different fixed fee parts`);
      sibling.set(r.intent, d);
      if (hist) {
        const it = hist.intents[r.intent];
        if (!it) refuse(`wallet ${index}: a spend of intent ${r.intent}, which the history file does not hold`);
        if (it.d !== d) refuse(`wallet ${index}: intent ${r.intent}'s record gives a fixed fee part of ${d}, the history gives ${it.d}`);
      }
    }
  }
  const feeFor = (intent) => {
    if (hist) {
      const it = hist.intents[intent];
      if (!it) refuse(`wallet ${index}: a chained answer of intent ${intent}, which the history file does not hold`);
      return it.d;
    }
    if (!sibling.has(intent)) refuse(`wallet ${index}: a chained answer of intent ${intent} with no single-transaction record of the intent to give its fixed fee part`);
    return sibling.get(intent);
  };

  const arms = new Map();
  for (const a of armIds()) {
    if (!reps.has(a)) continue;
    const [method, kind] = a.split('/');
    arms.set(a, { id: a, method, kind, absorb: method === RULE_METHOD ? kind === 'on' : null, runs: new Map() });
  }
  const maxValSize = params.maxValSize;
  for (const j of [...jobs.values()].sort((x, y) => x.repetition - y.repetition)) {
    arms.get(j.arm.id).runs.set(j.repetition, reduceRun({ spends: j.spends, armRecord: j.armRecord, refusedReason: j.refused, maxValSize, feeFor }));
  }
  return {
    index,
    wallet: id,
    split: header ? header.split : null,
    kind: header ? header.draw.kind : null,
    group,
    weight,
    capped,
    collateral,
    flags,
    minFeeA: params.minFeeA,
    maxValSize,
    intents: hist ? hist.intents : null,
    arms
  };
}

// The wallets of the replay stage in index order, each reduced to its table,
// the wallets of --drop left out and (in a real study) the wallets of the
// other split left out; the counts of what was left out are in ctx.flow when
// the stream ends. The stream's end checks the decompressed records against
// done.json, so a caller treats nothing as read until the loop has ended.
// With ctx.timings (a TimingCollector) the spend records' times of the kept
// wallets are matched by wallet index and record number and added to it, with
// the label ctx.machineOf(index) gives (the machine that completed the wallet).
export async function* walletTables(ctx) {
  const flow = { stage: 0, dropped: 0, otherSplit: 0, kept: 0 };
  ctx.flow = flow;
  const cursor = ctx.timings ? new TimingCursor(join(ctx.stageDir, 'timings.jsonl.gz'), ctx.done.timings) : null;
  if (ctx.timings && !ctx.done.timings) refuse('the replay stage has no timings digest in done.json');
  let index = -1;
  let current = null;
  let records = [];
  const finish = async () => {
    flow.stage++;
    const t = reduceWallet(ctx, index, records);
    const rows = cursor ? await cursor.take(index) : null;
    if (t.skip) {
      flow[t.skip]++;
      return null;
    }
    flow.kept++;
    if (rows) {
      for (const row of rows) {
        const rec = records[row.n - 1];
        if (!rec || rec.kind !== 'spend' || row.kind !== 'spend') continue;
        if (typeof row.times.ms !== 'number') continue;
        const arm = armOf(rec);
        ctx.timings.add({ method: arm.method, kind: arm.kind, type: rec.type, ms: row.times.ms, spendable: rec.spendableUtxos, machine: ctx.machineOf ? ctx.machineOf(index) : null, inputs: rec.inputs, outcome: rec.outcome });
      }
    }
    return t;
  };
  for await (const r of recordLines(join(ctx.stageDir, 'records.jsonl.gz'), ctx.done)) {
    const w = String(r.wallet);
    if (w !== current) {
      if (current !== null) {
        const t = await finish();
        if (t) yield t;
      }
      index++;
      if (index >= ctx.entries.length) refuse('the records name more wallets than wallets.json lists');
      if (w !== walletOfEntry(ctx.entries[index])) refuse(`the records' wallet ${index} is not the one wallets.json lists`);
      current = w;
      records = [];
    }
    records.push(r);
  }
  if (current !== null) {
    const t = await finish();
    if (t) yield t;
  }
  if (index + 1 !== ctx.entries.length) refuse('the records name fewer wallets than wallets.json lists');
  if (cursor) await cursor.end();
}

// Every wallet table, collected. For the tests and small studies; a study
// of many wallets is walked with walletTables.
export async function readStudy(rawOptions) {
  const ctx = openStudy(rawOptions);
  const wallets = [];
  for await (const t of walletTables(ctx)) wallets.push(t);
  return { ctx, wallets, flow: ctx.flow, draw: ctx.draw, historyRun: ctx.historyRun };
}

// The census rows of the study (census/census.jsonl and census-run.json),
// with `coin` as a BigInt where the row carries it.
export function readCensus(ctx) {
  const dir = join(ctx.studyDir, 'census');
  const run = readJson(join(dir, 'census-run.json'), 'census-run.json');
  const path = join(dir, 'census.jsonl');
  if (!existsSync(path) || !statSync(path).isFile()) refuse('census.jsonl is missing');
  const rows = readFileSync(path, 'utf8').split('\n').filter((l) => l.length).map((l) => {
    const r = JSON.parse(l);
    for (const k of ['wallet', 'utxos', 'tokenUtxos', 'largestValueBytes', 'nearCap50', 'nearCap80', 'nearCap90', 'lockedAda', 'excessAda']) if (r[k] === undefined) refuse(`a census row without ${k}`);
    return { ...r, lockedAda: BigInt(r.lockedAda), excessAda: BigInt(r.excessAda), coin: r.coin === undefined || r.coin === null ? null : BigInt(r.coin) };
  });
  return { valueLimit: run.valueLimit, rows };
}
