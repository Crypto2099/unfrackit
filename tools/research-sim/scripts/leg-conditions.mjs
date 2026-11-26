#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The conditions of a machine-independence leg: that the leg's configuration
// happened. A leg whose records equal the reference's but whose condition did
// not happen proves nothing, so this reports "condition not met", which is
// not a pass. It reads a stage's done.json, run.json, wallets.json,
// machines/<label>.json and <label>.log.jsonl, the timing rows, and for the
// legs that need facts only the driver can see (L3's affinity and burners,
// L5's kill and merge) the driver's record of that stage. It never reads a
// record.
//
//   node scripts/leg-conditions.mjs <leg> <stage dir>...
//       [--reference <L1 stage dir>]... [--record <driver record>]...
//
// <leg> is L1 to L6 or qualify. The stage directories are the leg's stages
// (for L5, the merged stages); --reference and --record are matched to them
// by position, and a leg that needs one fails its condition without it.
//
// Every leg: the stage ended (done.json), no validity failure, the wallets
// as listed, and the job count as the plan gives it (the run's plan entries
// expanded for each wallet; a wallet-arm record per job). Then, by leg:
//   L1  every invocation ran 2 workers
//   L2  every invocation ran 12 workers
//   L3  the driver's record: the replay's CPU affinity was CPUs 0-5, at least
//       6 burners each used CPU time for at least a quarter of the stage's
//       wall time, and the median of per-job time ratios to the reference
//       over matched jobs is at least 1.2
//   L4  12 workers, maxJobs 1, a 4 GiB memory budget; the pool started at
//       least as many workers as jobs and made at least one admission wait;
//       recycledBySize, aloneRuns and estimatesRaised are reported
//   L5  the driver's record: the merge kept plus copied the stage's wallet
//       count; where a shard was killed, its killed invocation did not
//       finish, the resumed one left nothing remaining, the two completed
//       disjoint sets covering the shard, the resume's open entry names a
//       wallet to redo, and every worker process of the killed run exited
//       within 120 s
//   L6  the CPU model differs from the reference's and the Node version
//       equals it; run.json is byte-equal to the reference's (when the
//       repetitions differ the plan entries must differ, and the fields that
//       do not depend on them stay equal)
//   qualify  the common conditions only (the machine's own worker count)
//
// Prints one JSON line. Exit 0: every condition met; 1: "condition not met";
// 2: unusable input, with the reason on stderr.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { STUDY_ROLES, expandJobs } from '../src/arms/plan.mjs';

export const LEG_NAMES = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'qualify'];
const GIB = 1024 ** 3;
export const MIN_TIME_RATIO = 1.2;
export const MIN_BURNER_SHARE = 0.25;
export const MIN_BURNERS = 6;
export const WORKER_EXIT_LIMIT_S = 120;

export class Unusable extends Error {}

function readJson(path, required = true) {
  if (!existsSync(path)) {
    if (required) throw new Unusable(`${path} does not exist`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Unusable(`${path} is not JSON (${e.message})`);
  }
}

function readLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// A stage directory's facts: done.json (null before the stage ended),
// run.json's text and parsed form, the wallet list, every invocation of every
// machine label in start order, each label's log.
export function loadStage(dir) {
  const d = resolve(dir);
  if (!existsSync(d)) throw new Unusable(`${dir} does not exist`);
  const runText = readFileSync(join(d, 'run.json'), 'utf8');
  const machinesDir = join(d, 'machines');
  const labels = existsSync(machinesDir) ? readdirSync(machinesDir).filter((f) => /\.json$/.test(f) && !/\.log\.jsonl$/.test(f)).map((f) => f.slice(0, -5)).sort() : [];
  const invocations = [];
  const logs = {};
  for (const label of labels) {
    for (const inv of readJson(join(machinesDir, `${label}.json`)).invocations || []) invocations.push({ label, ...inv });
    logs[label] = readLog(join(machinesDir, `${label}.log.jsonl`));
  }
  invocations.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  return { dir: d, done: readJson(join(d, 'done.json'), false), runText, run: JSON.parse(runText), wallets: readJson(join(d, 'wallets.json')), invocations, logs };
}

// The replay invocations of a stage (a merge records its own entry).
const replays = (s) => s.invocations.filter((i) => i.command !== 'merge-stage');

const cond = (name, ok, detail) => ({ name, ok: !!ok, detail });

// The jobs a stage's plan gives each wallet: one collateral rule, so the
// count does not depend on whether a wallet needs collateral.
export function plannedJobs(run) {
  return expandJobs(run.entries, { roles: STUDY_ROLES, needsCollateral: false, collateralRules: run.options.collateralRule ? [run.options.collateralRule] : undefined }).length;
}

function common(s) {
  const out = [];
  out.push(cond('the stage ended', s.done !== null, s.done ? `done.json, ${s.done.totals.wallets} wallets` : 'no done.json'));
  if (!s.done) return out;
  const v = s.done.totals.validity;
  out.push(cond('no validity failure', !v || v.failed === 0, v ? `${v.failed} failed of ${v.txs} transactions` : 'the stage ran without --validity'));
  const per = plannedJobs(s.run);
  const planned = per * s.wallets.length;
  const arms = s.done.counts['wallet-arm'] ?? 0;
  out.push(cond('job count as planned', s.done.totals.jobs === planned && arms === planned, `${s.done.totals.jobs} jobs and ${arms} wallet-arm records, ${planned} planned (${s.wallets.length} wallets x ${per})`));
  return out;
}

function workersEqual(s, n) {
  const w = replays(s).map((i) => i.workers);
  return cond(`${n} workers`, w.length > 0 && w.every((x) => x === n), `invocations ran ${JSON.stringify(w)}`);
}

// The wall-clock rows of a stage's jobs, by job key: the milliseconds of each
// wallet-arm timing row.
export function jobTimes(dir) {
  const f = join(resolve(dir), 'timings.jsonl.gz');
  if (!existsSync(f)) throw new Unusable(`${f} does not exist`);
  const m = new Map();
  for (const line of gunzipSync(readFileSync(f)).toString('utf8').split('\n')) {
    if (!line) continue;
    const r = JSON.parse(line);
    if (r.kind !== 'wallet-arm' || !r.times || !(r.times.ms > 0)) continue;
    m.set([r.wallet, r.window, r.arm, r.variant, r.method, r.change, r.collateral, r.repetition].join('|'), r.times.ms);
  }
  return m;
}

export function medianRatio(dir, referenceDir) {
  const a = jobTimes(dir);
  const b = jobTimes(referenceDir);
  const ratios = [];
  for (const [k, ms] of a) if (b.has(k)) ratios.push(ms / b.get(k));
  if (!ratios.length) return { matched: 0, median: null };
  ratios.sort((x, y) => x - y);
  const h = ratios.length >> 1;
  return { matched: ratios.length, median: ratios.length % 2 ? ratios[h] : (ratios[h - 1] + ratios[h]) / 2 };
}

function cpusOf(list) {
  const out = new Set();
  for (const part of String(list).split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) return null;
    for (let i = Number(m[1]); i <= Number(m[2] ?? m[1]); i++) out.add(i);
  }
  return out;
}

function l3(s, ref, rec) {
  const out = [];
  if (!rec) return [cond('the driver recorded the leg', false, 'no driver record given')];
  const cpus = cpusOf(rec.affinity);
  const want = [0, 1, 2, 3, 4, 5];
  out.push(cond('the replay ran on CPUs 0-5', cpus && cpus.size === 6 && want.every((c) => cpus.has(c)), `affinity ${JSON.stringify(rec.affinity)}`));
  out.push(workersEqual(s, 6));
  const burners = Array.isArray(rec.burners) ? rec.burners : [];
  const need = MIN_BURNER_SHARE * Number(rec.wallSeconds);
  const idle = burners.filter((b) => !(Number(b.cpuSeconds) >= need));
  out.push(cond(`${MIN_BURNERS} burners each used a quarter of the stage's wall time`, burners.length >= MIN_BURNERS && Number(rec.wallSeconds) > 0 && idle.length === 0, `${burners.length} burners, wall ${rec.wallSeconds} s, CPU seconds ${JSON.stringify(burners.map((b) => b.cpuSeconds))}`));
  if (!ref) {
    out.push(cond(`median per-job time ratio to the reference at least ${MIN_TIME_RATIO}`, false, 'no reference stage given'));
  } else {
    const r = medianRatio(s.dir, ref.dir);
    out.push(cond(`median per-job time ratio to the reference at least ${MIN_TIME_RATIO}`, r.median !== null && r.median >= MIN_TIME_RATIO, `median ${r.median === null ? 'n/a' : r.median.toFixed(3)} over ${r.matched} matched jobs`));
  }
  return out;
}

function l4(s) {
  const inv = replays(s);
  const sum = (k) => inv.reduce((a, i) => a + ((i.pool && i.pool[k]) || 0), 0);
  const jobs = s.done ? s.done.totals.jobs : 0;
  return [
    workersEqual(s, 12),
    cond('maxJobs 1', inv.length > 0 && inv.every((i) => i.maxJobs === 1), `recorded ${JSON.stringify(inv.map((i) => i.maxJobs))}`),
    cond('a 4 GiB memory budget', inv.length > 0 && inv.every((i) => i.memoryBudgetBytes === 4 * GIB), `recorded ${JSON.stringify(inv.map((i) => i.memoryBudgetBytes))}`),
    cond('the pool started at least as many workers as jobs', sum('started') >= jobs && jobs > 0, `started ${sum('started')}, jobs ${jobs}`),
    cond('at least one admission wait', sum('admissionWaits') >= 1, `admissionWaits ${sum('admissionWaits')}, admissionPasses ${sum('admissionPasses')}`),
    cond('pool counts reported', true, `recycledBySize ${sum('recycledBySize')}, aloneRuns ${sum('aloneRuns')}, estimatesRaised ${sum('estimatesRaised')}, recycled ${sum('recycled')}`)
  ];
}

// The wallet indexes a shard k/n holds.
const shardIndexes = (k, n, wallets) => Array.from({ length: wallets }, (_, i) => i).filter((i) => i % n === k);

function segmentLabels(dir) {
  const seg = join(resolve(dir), 'segments');
  const by = {};
  for (const f of existsSync(seg) ? readdirSync(seg) : []) {
    const m = /^(\d+)\.done\.json$/.exec(f);
    if (!m) continue;
    const d = readJson(join(seg, f));
    (by[d.machine] ||= []).push(Number(m[1]));
  }
  return by;
}

function l5(s, rec) {
  const out = [];
  if (!rec) return [cond('the driver recorded the leg', false, 'no driver record given')];
  const wallets = s.wallets.length;
  const m = rec.merge || {};
  out.push(cond('the merge kept plus copied every wallet', Number.isInteger(m.kept) && Number.isInteger(m.copied) && m.kept + m.copied === wallets, `kept ${m.kept} + copied ${m.copied}, ${wallets} wallets`));
  for (const sh of rec.shards || []) {
    const tag = `shard ${sh.shard}`;
    const [k, n] = String(sh.shard).split('/').map(Number);
    const mine = shardIndexes(k, n, wallets);
    const by = segmentLabels(sh.dir);
    const have = new Set(Object.values(by).flat());
    const remaining = mine.filter((i) => !have.has(i));
    if (!sh.kill) {
      out.push(cond(`${tag}: ran to its end`, remaining.length === 0, `wallets not done ${JSON.stringify(remaining)}${sh.note ? ` (${sh.note})` : ''}`));
      continue;
    }
    const shard = loadStage(sh.dir);
    const killed = replays(shard).filter((i) => i.label === sh.label);
    const resumed = replays(shard).filter((i) => i.label === sh.resumeLabel);
    out.push(cond(`${tag}: the killed invocation did not finish`, killed.length === 1 && killed[0].finished === false && sh.killed === true, `killed ${sh.killed}, invocations under ${sh.label}: ${JSON.stringify(killed.map((i) => i.finished))}`));
    out.push(cond(`${tag}: the resume left nothing remaining`, resumed.length >= 1 && remaining.length === 0, `wallets not done ${JSON.stringify(remaining)}`));
    const a = by[sh.label] || [];
    const b = by[sh.resumeLabel] || [];
    const overlap = a.filter((i) => b.includes(i));
    const union = [...new Set([...a, ...b])].sort((x, y) => x - y);
    out.push(cond(`${tag}: the completed sets are disjoint and cover the shard`, overlap.length === 0 && a.length > 0 && b.length > 0 && JSON.stringify(union) === JSON.stringify(mine), `killed run ${JSON.stringify(a)}, resume ${JSON.stringify(b)}, shard ${JSON.stringify(mine)}`));
    const open = (shard.logs[sh.resumeLabel] || []).find((e) => e.event === 'stage-resume');
    const redone = open ? [...(open.partial || []), ...(open.redo || [])] : [];
    out.push(cond(`${tag}: the resume's open entry names a wallet to redo`, redone.length >= 1, open ? `partial ${JSON.stringify(open.partial)}, redo ${JSON.stringify(open.redo)}, kept ${open.kept}` : 'no stage-resume entry'));
    out.push(cond(`${tag}: every worker of the killed run exited within ${WORKER_EXIT_LIMIT_S} s`, sh.workersExited === true && Number(sh.workerExitSeconds) <= WORKER_EXIT_LIMIT_S, `${sh.workers} worker processes, exited ${sh.workersExited}, after ${sh.workerExitSeconds} s`));
  }
  return out;
}

function l6(s, ref) {
  if (!ref) return [cond('a reference stage', false, 'no reference stage given')];
  const a = replays(s).at(-1) || {};
  const b = replays(ref).at(-1) || {};
  const out = [
    cond('the CPU model differs from the reference', !!a.cpuModel && !!b.cpuModel && a.cpuModel !== b.cpuModel, `${JSON.stringify(a.cpuModel)} against ${JSON.stringify(b.cpuModel)}`),
    cond('the Node version equals the reference', !!a.node && a.node === b.node, `${a.node} against ${b.node}`)
  ];
  if (s.runText === ref.runText) {
    out.push(cond('run.json byte-equal to the reference', true, 'identical'));
  } else {
    const strip = (r) => JSON.stringify({ ...r, entries: null, options: { ...r.options, reps: null } });
    const sameApartFromReps = strip(s.run) === strip(ref.run) && s.run.options.reps !== ref.run.options.reps;
    out.push(cond('run.json byte-equal to the reference', sameApartFromReps, sameApartFromReps ? `differs only in the repetitions (${ref.run.options.reps ?? 'default'} against ${s.run.options.reps ?? 'default'}) and the plan entries they set` : 'differs'));
  }
  return out;
}

// The conditions of one stage of a leg, as a list of { name, ok, detail }.
export function legConditions(leg, stageDir, { reference = null, record = null } = {}) {
  if (!LEG_NAMES.includes(leg)) throw new Unusable(`unknown leg ${leg}; the legs are ${LEG_NAMES.join(', ')}`);
  const s = loadStage(stageDir);
  const ref = reference ? loadStage(reference) : null;
  const out = common(s);
  if (!s.done) return out;
  if (leg === 'L1') out.push(workersEqual(s, 2));
  else if (leg === 'L2') out.push(workersEqual(s, 12));
  else if (leg === 'L3') out.push(...l3(s, ref, record));
  else if (leg === 'L4') out.push(...l4(s));
  else if (leg === 'L5') out.push(...l5(s, record));
  else if (leg === 'L6') out.push(...l6(s, ref));
  return out;
}

function parse(argv) {
  const [leg, ...rest] = argv;
  const o = { leg, dirs: [], references: [], records: [] };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--reference' || rest[i] === '--record') {
      if (i + 1 >= rest.length) throw new Unusable(`${rest[i]} takes a path`);
      o[rest[i] === '--reference' ? 'references' : 'records'].push(rest[++i]);
    } else if (rest[i].startsWith('--')) {
      throw new Unusable(`unknown option ${rest[i]}`);
    } else {
      o.dirs.push(rest[i]);
    }
  }
  if (!o.leg || !o.dirs.length) throw new Unusable('usage: leg-conditions.mjs <leg> <stage dir>... [--reference <dir>]... [--record <file>]...');
  return o;
}

function main(argv) {
  const o = parse(argv);
  const stages = o.dirs.map((dir, i) => {
    const record = o.records[i] ? readJson(o.records[i]) : null;
    const conditions = legConditions(o.leg, dir, { reference: o.references[i] || null, record });
    const unmet = conditions.filter((c) => !c.ok).map((c) => c.name);
    return { dir, reference: o.references[i] || null, conditions, result: unmet.length ? 'condition not met' : 'met', unmet };
  });
  const bad = stages.filter((s) => s.result !== 'met');
  return { out: { leg: o.leg, stages, result: bad.length ? 'condition not met' : 'met' }, code: bad.length ? 1 : 0 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const { out, code } = main(process.argv.slice(2));
    console.log(JSON.stringify(out));
    process.exitCode = code;
  } catch (e) {
    console.error(`leg-conditions: ${e.message}`);
    process.exitCode = 2;
  }
}
