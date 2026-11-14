// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A small study directory written from a compact description, for the
// analysis scripts' tests. Synthetic ids and numbers only. writeStudy(root,
// desc) writes, under <root>/<network>/<runId>/:
//   study.json, replay-<window>/ (records.jsonl.gz, done.json, run.json,
//   wallets.json), history-<window>/ (history-run.json with `draw`, one
//   history file per wallet) and, with desc.census, census/.
// desc: { network = 'preprod', runId = 'st', window = 'recent',
//   collateralRule = 'ledger', analysisFreezeTx = null, draw, census,
//   wallets: [{ id, split = 'exploration', group = 'B1', capped = false,
//     flags = {}, minFeeA = 44, maxValSize = 5000, intents, jobs }] }.
// A synthetic study (network 'synthetic') has no history stage and no draw;
// its wallets are shapes named by id.
// A job: { method, arm: 'own' | 'layout' | 'on' | 'off', rep = 1, spends,
//   wa (fields of the wallet-arm record), refused (a reason) }.
// A spend is made with built(), failed() and the other makers below; the
// record's key and the defaults the trunk's records carry are filled in.
// desc.mutate(records) may change the record list before it is written (and
// hashed), for the refusals that need an odd record.
// intents: [{ type, scriptFee, fixedBytes, deposits, certs, proposals, newPools }]
// per intent event of the history file (default: one plain intent per intent a
// job names). certs lists certificates as { type: 0 | 7 | 16, coin } and
// proposals their deposits; they are written as the fixed body's fields 4 and
// 20, and `deposits` defaults to their sum (type 0 at the key deposit,
// 2,000,000) plus newPools pool deposits (500,000,000).

import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { LIBRARY_TABLE } from '../../src/arms/plan.mjs';
import { HISTORY_FORMAT } from '../../src/state/history.mjs';
import { encArray, encUint, encBytes, encText, encTag, NULL } from '../../src/history/cbor.mjs';

export const TX = 'a'.repeat(64);
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export const METHODS = LIBRARY_TABLE.map((r) => r.method);
export const RANDOM_METHODS = LIBRARY_TABLE.filter((r) => r.random).map((r) => r.method);
export const RULE = 'unfrackit-h12';

const base = { type: 'T1', burst: null };

export function built(intent, o = {}) {
  const fee = o.fee === undefined ? 200000n : BigInt(o.fee);
  return {
    kind: 'spend',
    intent,
    type: o.type || 'T1',
    t: o.t === undefined ? (intent + 1) * 1000 : o.t,
    burst: null,
    outcome: 'built',
    txs: o.txs || 1,
    fee: fee.toString(),
    walletFee: (o.walletFee === undefined ? fee : BigInt(o.walletFee)).toString(),
    size: 300,
    inputs: 1,
    consumedWalletInputs: o.consumed === undefined ? 1 : o.consumed,
    largestConsumedValueBytes: o.consumedBytes === undefined ? 5 : o.consumedBytes,
    changeTokenMinimum: String(o.changeMin || 0),
    consumedTokenMinimum: String(o.consumedMin || 0),
    keys: 1,
    dragged: 0,
    changeOutputs: { count: o.changeCount === undefined ? 1 : o.changeCount, bytes: 65, largestValueBytes: o.changeBytes === undefined ? 5 : o.changeBytes },
    dragBytes: 0,
    policies: [],
    collateralUsed: null,
    utxosAfter: o.utxos === undefined ? 3 : o.utxos,
    largestValueBytesAfter: o.bytesAfter === undefined ? 5 : o.bytesAfter,
    lockedAdaAfter: String(o.locked || 0),
    lockedAdaPerTokenAfter: o.perToken === undefined || o.perToken === null ? null : String(o.perToken),
    tokensAfter: o.tokens || 0,
    ...(o.extra || {})
  };
}

export const failed = (intent, cls, detail = 'kit: failed', o = {}) => ({ kind: 'spend', intent, ...base, type: o.type || 'T1', t: (intent + 1) * 1000, outcome: 'failed', class: cls, detail });
export const notReplayable = (intent, cls = 'other', detail = 'not replayable') => ({ kind: 'spend', intent, ...base, t: (intent + 1) * 1000, outcome: 'not-replayable', class: cls, detail });
export const infeasible = (intent, reason = 'no inputs') => ({ kind: 'spend', intent, ...base, t: (intent + 1) * 1000, outcome: 'infeasible', reason });
export const infeasibleCollateral = (intent) => ({ kind: 'spend', intent, ...base, t: (intent + 1) * 1000, outcome: 'infeasible-collateral' });
export const forfeit = (intent) => ({ kind: 'spend', intent, ...base, t: (intent + 1) * 1000, outcome: 'forfeit' });

// A job of every library's two arms and the rule's two arms: make(method,
// arm, rep) gives its spends. reps applies to the libraries that pick at
// random; each deterministic arm has one run.
export function fullJobs(make, { reps = 2, methods = METHODS } = {}) {
  const jobs = [];
  for (const m of methods) {
    const random = RANDOM_METHODS.includes(m);
    for (const arm of ['own', 'layout']) for (let rep = 1; rep <= (random ? reps : 1); rep++) jobs.push({ method: m, arm, rep, spends: make(m, arm, rep) });
  }
  for (const arm of ['on', 'off']) jobs.push({ method: RULE, arm, rep: 1, spends: make(RULE, arm, 1) });
  return jobs;
}

const START = { t: 0, utxos: 3, largestValueBytes: 5, lockedAda: '0', lockedAdaPerToken: null, tokens: 0 };

function keyOf(wallet, window, collateral, job) {
  const rule = job.method === RULE;
  return {
    wallet,
    window,
    arm: 'observed',
    variant: rule ? (job.arm === 'on' ? 'absorb-on' : 'absorb-off') : 'default',
    method: job.method,
    change: !rule && job.arm === 'layout' ? 'layout' : 'default',
    collateral,
    repetition: job.rep || 1
  };
}

function walletArm(key, w, job) {
  const spends = job.spends || [];
  const attempted = spends.filter((s) => s.outcome === 'built' || s.outcome === 'failed').length;
  const failedN = spends.filter((s) => s.outcome === 'failed').length;
  return {
    kind: 'wallet-arm',
    ...key,
    hypotheses: ['Q1'],
    methodVersion: 'test',
    ...(job.method === RULE ? { absorb: job.arm === 'on' } : {}),
    counts: { intents: spends.length },
    failuresPer100: attempted ? (100 * failedN) / attempted : 0,
    start: { ...START },
    end: { utxos: 3, largestValueBytes: 5, lockedAda: '0', lockedAdaPerToken: null, tokens: 0 },
    capped: !!w.capped,
    trajectory: [],
    conformity: { proposes: true, txs: 1, fee: '200000', tokenUtxos: 0, conforming: 0, conformingNoCoin: 0 },
    validity: {},
    ...(job.wa || {})
  };
}

const PARAMS = (network, w) => ({ network, epoch: 100, protocolMajor: 10, minFeeA: w.minFeeA === undefined ? 44 : w.minFeeA, minFeeB: 155381, coinsPerUtxoByte: 4310, maxValSize: w.maxValSize === undefined ? 5000 : w.maxValSize, maxTxSize: 16384, maxCollateralInputs: 3, collateralPercent: 150, priceMem: [577, 10000], priceStep: [721, 10000000], keyDeposit: 2000000, poolDeposit: 500000000 });

const KEY_DEPOSIT = 2000000n;
const POOL_DEPOSIT = 500000000n;
const credential = encArray([encUint(0), encBytes(Buffer.alloc(28, 7))]);
function certificate(c) {
  if (c.type === 0) return encArray([encUint(0), credential]);
  if (c.type === 7) return encArray([encUint(7), credential, encUint(c.coin)]);
  if (c.type === 16) return encArray([encUint(16), credential, encUint(c.coin), NULL]);
  throw new Error(`fixture certificate type ${c.type}`);
}
const proposal = (deposit) => encArray([encUint(deposit), encBytes(Buffer.alloc(29, 9)), encArray([encUint(6)]), encArray([encText('x'), encBytes(Buffer.alloc(32, 1))])]);

function intentEvent(i, it) {
  const body = {};
  let sum = 0n;
  if (it.certs && it.certs.length) {
    body[4] = encTag(258, encArray(it.certs.map(certificate))).toString('hex');
    for (const c of it.certs) sum += c.type === 0 ? KEY_DEPOSIT : BigInt(c.coin);
  }
  if (it.proposals && it.proposals.length) {
    body[20] = encTag(258, encArray(it.proposals.map(proposal))).toString('hex');
    for (const p of it.proposals) sum += BigInt(p);
  }
  sum += BigInt(it.newPools || 0) * POOL_DEPOSIT;
  const deposits = it.deposits !== undefined ? it.deposits : sum;
  const fixed = it.scriptFee || it.fixedBytes || Object.keys(body).length ? { inputs: [], referenceInputs: [], body, witnesses: {}, redeemers: [], auxiliaryData: null, scriptFee: String(it.scriptFee || 0), fixedBytes: it.fixedBytes || 0, refScriptBytes: 0 } : null;
  return {
    kind: 'intent',
    txId: i,
    intent: {
      id: `i${i}`,
      source: 'replay',
      type: it.type || 'T1',
      time: { slot: i, blockTime: (i + 1) * 1000, blockIndex: 0, epoch: 100, block: i },
      requested: [],
      implicit: { withdrawals: '0', refunds: '0', deposits: String(deposits), donation: '0', mint: [], burn: [] },
      fixed,
      collateral: { required: false, observed: null },
      invalid: null,
      burst: null,
      observed: { tx: TX, size: 300, fee: '200000', epoch: 100, protocolMajor: 10, minFeeA: '44', minFeeB: '155381', walletInputs: [], walletOutputs: [], walletWitnesses: [] },
      classes: null,
      derived: it.newPools ? { poolDeposits: { registrations: it.newPools, newPools: it.newPools } } : null
    }
  };
}

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const put = (path, data) => {
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600);
};

export function writeStudy(root, desc) {
  const network = desc.network || 'preprod';
  const synthetic = network === 'synthetic';
  const runId = desc.runId || 'st';
  const window = desc.window || 'recent';
  const rule = desc.collateralRule || 'ledger';
  const studyDir = join(root, network, runId);
  const stageDir = join(studyDir, `replay-${window}`);
  const historyDir = join(studyDir, `history-${window}`);
  mkdirSync(join(historyDir, 'history'), { recursive: true });
  mkdirSync(stageDir, { recursive: true });
  put(join(studyDir, 'study.json'), JSON.stringify({ command: 'study', plan: synthetic ? 'synthetic' : 'corpus', network, runId, stages: [`replay-${window}`], collateralRule: { rule, source: '--collateral-rule' } }, null, 2) + '\n');

  const draw = desc.draw === undefined ? { quotaScale: '1', sampleN: 100, historyCap: 1000, groups: { B0: { quota: null, nDrawn: 100, nTaken: 10 }, B1: { quota: 50, nDrawn: 40, nTaken: 20 }, B2: { quota: 10, nDrawn: 10, nTaken: 5 }, B3: { quota: 2, nDrawn: 2, nTaken: 2 } } } : desc.draw;
  const entries = [];
  const records = [];
  for (const w of desc.wallets) {
    const id = String(w.id);
    const jobs = w.jobs || [];
    const nIntents = w.intents ? w.intents.length : Math.max(0, ...jobs.flatMap((j) => (j.spends || []).map((s) => s.intent + 1)));
    const intents = w.intents || Array.from({ length: nIntents }, () => ({}));
    if (synthetic) entries.push({ shape: id });
    else {
      const name = `${id}.${window}.jsonl`;
      const header = {
        kind: 'header',
        format: HISTORY_FORMAT,
        network,
        wallet: Number(id),
        frame: window,
        split: w.split === undefined ? 'exploration' : w.split,
        sample: null,
        draw: { sizeGroup: w.group || 'B1', nWindowTx: 10, capped: !!w.capped, historyHi: 100, ...(w.flags || {}) },
        window: null,
        snapshot: null,
        params: PARAMS(network, w),
        franken: [],
        settings: {}
      };
      const text = jsonl([header, { kind: 'state', at: { tx: 0 }, utxos: [] }, ...intents.map((it, i) => intentEvent(i, it)), { kind: 'end', at: { tx: 1 }, utxos: 0, digest: '', capped: w.historyCapped === undefined ? !!w.capped : w.historyCapped, counts: { intent: intents.length } }]);
      put(join(historyDir, 'history', name), text);
      entries.push({ file: name, sha256: sha256(Buffer.from(text)) });
    }
    for (const job of jobs) {
      const key = keyOf(synthetic ? id : Number(id), synthetic ? 'synthetic' : window, w.collateral || rule, job);
      if (job.refused) {
        records.push({ kind: 'refused', ...key, reason: job.refused });
        continue;
      }
      for (const s of job.spends || []) records.push({ ...s, ...key });
      records.push(walletArm(key, w, job));
    }
  }
  if (desc.mutate) desc.mutate(records);
  const text = jsonl(records);
  const gz = gzipSync(Buffer.from(text));
  put(join(stageDir, 'records.jsonl.gz'), gz);
  put(join(stageDir, 'wallets.json'), JSON.stringify(entries, null, 2) + '\n');
  const runText = JSON.stringify({ stage: 'test' }) + '\n';
  put(join(stageDir, 'run.json'), runText);
  put(join(stageDir, 'done.json'), JSON.stringify({ runSha256: sha256(Buffer.from(runText)), wallets: entries.length, records: { sha256: sha256(Buffer.from(text)), bytes: Buffer.byteLength(text), lines: records.length, gzipBytes: gz.length }, counts: {} }, null, 2) + '\n');
  if (!synthetic) put(join(historyDir, 'history-run.json'), JSON.stringify({ network, runId, studyTables: 'read', draw: draw === null ? null : { [window]: draw }, analysisFreezeTx: desc.analysisFreezeTx || null, confirmationWallets: desc.wallets.filter((w) => w.split === 'confirmation').length, runs: [] }, null, 2) + '\n');
  if (desc.census) {
    mkdirSync(join(studyDir, 'census'), { recursive: true });
    put(join(studyDir, 'census', 'census.jsonl'), jsonl(desc.census));
    put(join(studyDir, 'census', 'census-run.json'), JSON.stringify({ valueLimit: 5000 }) + '\n');
  }
  return { studyDir, stageDir, historyDir, network, runId, window };
}

// The options of a read of a fixture written by writeStudy.
export const optionsFor = (root, w, o = {}) => ({ network: w.network, study: w.runId, window: w.window, split: 'exploration', out: '/nonexistent-out', root, ...o });
