// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The analyze command (pre-registration sections 7.1 to 7.7, artifact A6): one
// study's replay stages of both windows read into per-wallet tables of one
// split, every result computed from them, and the outputs written to --out.
//
//   research-sim analyze --network <name> --study <run-id>
//                        --split exploration|confirmation [--analysis-freeze-tx <hash>]
//                        [--drop <file>] [--workers <n>] --out <dir>
//   research-sim analyze --network synthetic --study <run-id> --out <dir> ...
//
// A real study's results are computed on the chosen split's wallets: the pilot
// (exploration) or every sampled wallet (confirmation). H-8's census keeps every
// eligible wallet. A synthetic-plan study takes no split: every wallet enters,
// in group B0 at weight 1, and sizing runs with those wallets as the pilot.
//
// Outputs (directory 0700, files 0600):
//   results.json   every figure, as canonical JSON; no wallet id, path, time of
//                  day, host fact or wall-clock value
//   verdicts.json, verdicts.md   questions 1 and 2 on the recent window with
//                  their answers and defaults, and the same for each
//                  sensitivity re-run
//   sizing.json    the sizing by simulation (an exploration or synthetic run)
//   timings.json   the build times and the machines that ran the stages, the
//                  only output that carries a host fact or a time
//   inputs.json    each input file by role with its SHA-256, the code
//                  manifest's SHA-256, Node's version and the options that
//                  change a figure
// Two runs over the same input files write the same bytes at any --workers.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { formatHashList } from '../hash.mjs';
import { ensureDir, writePrivate } from '../history/paths.mjs';
import { AnalysisRefusal, checkOptions, openStudy, walletTables, readCensus, SIZE_GROUPS, armIds } from './read.mjs';
import { runQuestions, studyLibraries } from './questions.mjs';
import { buildVerdicts, renderVerdicts } from './verdicts.mjs';
import { runItems } from './items.mjs';
import { runDescriptive, runCensus } from './descriptive.mjs';
import { runSizing, renderSizing } from './sizing.mjs';
import { TimingCollector, readMachines } from './timings.mjs';
import { RESAMPLES } from './stats.mjs';
import { SAMPLES as SIZING_SAMPLES, RESAMPLES as SIZING_RESAMPLES } from './sizing.mjs';

export const FORMAT = 1;
const refuse = (m) => {
  throw new AnalysisRefusal(`refusing: ${m}`);
};

// The four sensitivity re-runs of questions 1 and 2 (sections 5.2, 5.5, 5.6):
// the flags are read from the draw of the history header.
export const SENSITIVITY = Object.freeze([
  { label: 'without-franken-any', flag: 'franken_any', keep: (v) => v !== true, text: 'without wallets with any franken flag' },
  { label: 'without-franken-no-cospend', flag: 'franken_no_cospend', keep: (v) => v !== true, text: 'without wallets with two or more key payment credentials none of which co-spends' },
  { label: 'without-prior-treated', flag: 'prior_treated', keep: (v) => v !== true, text: 'without prior-treated wallets' },
  { label: 'prior-treated-only', flag: 'prior_treated', keep: (v) => v === true, text: 'on prior-treated wallets only' }
]);

// Canonical JSON: object keys sorted, BigInt as a decimal string, a number that
// is not finite as null, undefined left out, one space of indent.
export function canonicalJson(value) {
  const walk = (x) => {
    if (typeof x === 'bigint') return x.toString();
    if (typeof x === 'number') return Number.isFinite(x) ? x : null;
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      const o = {};
      for (const k of Object.keys(x).sort()) if (x[k] !== undefined) o[k] = walk(x[k]);
      return o;
    }
    return x;
  };
  return JSON.stringify(walk(value), null, 1) + '\n';
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const fileSha = (path) => sha256(readFileSync(path));

// The input files of one window's stages by role, with their SHA-256 (paths
// are not recorded).
function stageInputs(ctx, window) {
  const out = {
    [`replay-${window}/done.json`]: fileSha(join(ctx.stageDir, 'done.json')),
    [`replay-${window}/run.json`]: fileSha(join(ctx.stageDir, 'run.json')),
    [`replay-${window}/wallets.json`]: ctx.walletsSha256,
    [`replay-${window}/records`]: ctx.done.records.sha256
  };
  if (ctx.done.timings) out[`replay-${window}/timings`] = ctx.done.timings.sha256;
  if (!ctx.synthetic) out[`history-${window}/history-run.json`] = fileSha(join(ctx.historyDir, 'history-run.json'));
  return out;
}

// A carried report's figures: the file's content without wall-clock fields, the
// path or the wallet source, with the file's SHA-256. Refused when the text names a stake address.
const CARRY_DROP = new Set(['seconds', 'timing', 'plans', 'walletSource', 'snapshot']);
function carried(path, what) {
  if (!existsSync(path)) refuse(`${what} is missing: the carried report is read from the study run`);
  const buf = readFileSync(path);
  const body = JSON.parse(buf.toString('utf8'));
  const strip = (x) => (Array.isArray(x) ? x.map(strip) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([k]) => !CARRY_DROP.has(k)).map(([k, v]) => [k, strip(v)])) : x);
  const figures = strip(body);
  if (/stake(_test)?1[0-9a-z]{20}/.test(JSON.stringify(figures))) refuse(`${what} names a stake address`);
  return { sha256: sha256(buf), figures };
}

// What the stage's draw and the wallets read say about who entered (section 7.7),
// without a wallet id: the draw's counts, the files and wallets by stage, the
// kept wallets by size group, capped ones and the replay's refusals per arm.
function flowOf(ctx, tables, window) {
  const byGroup = {};
  const refused = {};
  let capped = 0;
  for (const t of tables) {
    byGroup[t.group] = (byGroup[t.group] || 0) + 1;
    if (t.capped) capped++;
    for (const [id, arm] of t.arms) {
      const r = [...arm.runs.values()].filter((run) => run.refused).length;
      if (!refused[id]) refused[id] = { wallets: 0, walletsRefused: 0, refusedRuns: 0 };
      refused[id].wallets++;
      if (r > 0) refused[id].walletsRefused++;
      refused[id].refusedRuns += r;
    }
  }
  const hr = ctx.historyRun;
  return {
    window,
    draw: ctx.draw || null,
    historyFiles: hr ? (hr.runs || []).filter((r) => r.window === window).length : null,
    stage: { wallets: ctx.flow.stage, dropped: ctx.flow.dropped, otherSplit: ctx.flow.otherSplit, kept: ctx.flow.kept },
    keptByGroup: Object.fromEntries(Object.keys(byGroup).sort().map((g) => [g, byGroup[g]])),
    capped,
    refusedByArm: Object.fromEntries(Object.keys(refused).sort((a, b) => armIds().indexOf(a) - armIds().indexOf(b)).map((k) => [k, refused[k]]))
  };
}

// A window's tables read, the timings collected, the stream ended.
async function readWindow(ctx, say) {
  ctx.timings = new TimingCollector();
  const tables = [];
  for await (const t of walletTables(ctx)) tables.push(t);
  say(`read ${ctx.options.window}: ${ctx.flow.stage} wallets in the stage, ${tables.length} kept`);
  const summary = ctx.timings.summary();
  ctx.timings = null;
  return { tables, timings: summary, machines: readMachines(ctx.stageDir), flow: flowOf(ctx, tables, ctx.options.window) };
}

// The questions on a table set, and for the recent window the verdicts.
async function questionsOn(tables, opts, suffix = '') {
  return runQuestions(tables, { workers: opts.workers, resamples: opts.resamples, suffix });
}

// The sample's A_k by size group, for the sizing's targets: the draw's groups in
// a real study, the pilot's own wallets in a synthetic one.
function sampleCounts(ctx, tables) {
  if (ctx.synthetic) {
    const c = {};
    for (const t of tables) c[t.group] = (c[t.group] || 0) + 1;
    return c;
  }
  return Object.fromEntries(SIZE_GROUPS.map((g) => [g, ctx.draw.groups[g].nTaken]));
}

export const ANALYZE_OPTIONS = Object.freeze(['network', 'study', 'split', 'analysisFreezeTx', 'drop', 'workers', 'out', 'resamples', 'sizingSamples', 'sizingResamples']);

// Whole-number options that decide a figure: --resamples (10,000), --sizing-samples
// (1,000), --sizing-resamples (1,000). Written to inputs.json.
function counts(o) {
  const pick = (k, dflt) => {
    if (o[k] === undefined || o[k] === null) return dflt;
    const n = Number(o[k]);
    if (!Number.isSafeInteger(n) || n < 1) refuse(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be a positive whole number, not ${o[k]}`);
    return n;
  };
  return { resamples: pick('resamples', RESAMPLES), sizingSamples: pick('sizingSamples', SIZING_SAMPLES), sizingResamples: pick('sizingResamples', SIZING_RESAMPLES) };
}

// The recent window: read, questions, items, H-7/H-9/H-11, the sensitivity re-runs and
// the sizing. Returns only results, flow, timings summary and stage inputs.
async function analyzeRecent(ctxRecent, base, n, census, synthetic, say) {
  let sizing = null;
  let verdicts = null;
  const w = await readWindow(ctxRecent, say);
  const tables = w.tables;
  const libraries = studyLibraries(tables);
  say('questions 1 and 2');
  const questions = await questionsOn(tables, { workers: base.workers, resamples: n.resamples });
  verdicts = buildVerdicts(questions);
  say('items beside the verdicts');
  const items = await runItems(tables, { workers: base.workers, resamples: n.resamples });
  say('H-7, H-9 and H-11');
  const d = await runDescriptive(tables, null, { workers: base.workers, resamples: n.resamples, window: 'recent' });
  const recent = { questions, items, h7: d.h7, h9: d.h9, h11: d.h11 };
  const censusResult = census ? runCensus(census.rows) : null;

  say('sensitivity re-runs');
  const sens = {};
  const sensVerdicts = {};
  for (const f of SENSITIVITY) {
    const has = tables.some((t) => typeof t.flags[f.flag] === 'boolean');
    if (!has) {
      sens[f.label] = { filter: f.text, flag: f.flag, absent: true };
      continue;
    }
    const kept = tables.filter((t) => f.keep(t.flags[f.flag]));
    const q = await questionsOn(kept, { workers: base.workers, resamples: n.resamples }, `sens/${f.label}`);
    sens[f.label] = { filter: f.text, flag: f.flag, wallets: kept.length, questions: q };
    sensVerdicts[f.label] = { filter: f.text, ...buildVerdicts(q) };
  }
  verdicts = { ...verdicts, sensitivity: sensVerdicts };

  if (synthetic || base.split === 'exploration') {
    say('sizing');
    sizing = await runSizing(tables, sampleCounts(ctxRecent, tables), { workers: base.workers, samples: n.sizingSamples, resamples: n.sizingResamples, libraries });
  }
  return { wallets: tables.length, libraries, flow: w.flow, timings: { timings: w.timings, machines: w.machines }, recent, census: censusResult, sensitivity: sens, verdicts, sizing, files: stageInputs(ctxRecent, 'recent') };
}

// The peak window: read, then questions 1 and 2, items and H-7/H-9/H-11 with the 'peak' suffix.
async function analyzePeak(ctxPeak, base, n, say) {
  const w = await readWindow(ctxPeak, say);
  say('peak window: questions 1 and 2, items, H-7, H-9 and H-11');
  const questions = await questionsOn(w.tables, { workers: base.workers, resamples: n.resamples }, 'peak');
  const items = await runItems(w.tables, { workers: base.workers, resamples: n.resamples, suffix: 'peak' });
  const d = await runDescriptive(w.tables, null, { workers: base.workers, resamples: n.resamples, window: 'peak' });
  return { flow: w.flow, timings: { timings: w.timings, machines: w.machines }, peak: { questions, items, h7: d.h7, h9: d.h9, h11: d.h11 }, files: stageInputs(ctxPeak, 'peak') };
}

// The command. `o` is the parsed command line (options.mjs) or an object with the same keys
// (and `root`, `quiet` for tests). Returns { print } with counts only.
export async function cmdAnalyze(o) {
  const t0 = performance.now();
  const say = o.quiet ? () => {} : (m) => process.stderr.write(`[analyze ${((performance.now() - t0) / 1000).toFixed(0)}s] ${m}\n`);
  const base = checkOptions({ ...o, window: undefined });
  const n = counts(o);
  const outDir = base.out;
  if (existsSync(outDir) && readdirSync(outDir).length > 0) refuse(`--out ${outDir} is not empty`);
  const synthetic = base.network === 'synthetic';

  const ctxRecent = openStudy({ ...o, window: 'recent' });
  const peakStage = join(ctxRecent.studyDir, 'replay-peak');
  if (synthetic && !existsSync(join(peakStage, 'done.json'))) say('no replay-peak stage in this synthetic study: the peak window is skipped');
  const ctxPeak = synthetic && !existsSync(join(peakStage, 'done.json')) ? null : openStudy({ ...o, window: 'peak' });
  const carriedReports = synthetic ? null : { collateral: carried(join(ctxRecent.studyDir, 'collateral', 'collateral.json'), 'collateral.json'), nearCap: carried(join(ctxRecent.studyDir, 'near-cap', 'near-cap.json'), 'near-cap.json') };
  const census = synthetic ? null : readCensus(ctxRecent);

  const results = { format: FORMAT, network: base.network, split: base.split, libraries: null, resamples: n.resamples, recent: null, peak: null, census: null, sensitivity: null, flow: {}, carried: carriedReports ? { collateral: carriedReports.collateral, nearCap: carriedReports.nearCap } : null };
  const files = {};
  const timings = { format: FORMAT, windows: {} };

  // Each window's tables and timing rows live inside its own function, so they are
  // unreachable once it returns and only one window is in memory at a time.
  const recent = await analyzeRecent(ctxRecent, base, n, census, synthetic, say);
  const { libraries, verdicts, sizing } = recent;
  results.libraries = libraries;
  results.flow.recent = recent.flow;
  timings.windows.recent = recent.timings;
  results.recent = recent.recent;
  results.census = recent.census;
  results.sensitivity = recent.sensitivity;
  const walletsRecent = recent.wallets;
  Object.assign(files, recent.files);

  if (ctxPeak) {
    const peak = await analyzePeak(ctxPeak, base, n, say);
    results.flow.peak = peak.flow;
    timings.windows.peak = peak.timings;
    results.peak = peak.peak;
    Object.assign(files, peak.files);
  }

  // ---- Outputs.
  if (census) {
    files['census/census.jsonl'] = fileSha(join(ctxRecent.studyDir, 'census', 'census.jsonl'));
    files['census/census-run.json'] = fileSha(join(ctxRecent.studyDir, 'census', 'census-run.json'));
  }
  files['study.json'] = fileSha(join(ctxRecent.studyDir, 'study.json'));
  if (carriedReports) {
    files['collateral/collateral.json'] = carriedReports.collateral.sha256;
    files['near-cap/near-cap.json'] = carriedReports.nearCap.sha256;
  }
  const inputs = {
    format: FORMAT,
    options: { network: base.network, study: base.study, split: base.split, analysisFreezeTx: base.analysisFreezeTx, resamples: n.resamples, sizingSamples: n.sizingSamples, sizingResamples: n.sizingResamples },
    drop: base.drop ? { sha256: fileSha(base.drop), wallets: ctxRecent.drop.size } : null,
    files: Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]])),
    codeManifestSha256: sha256(formatHashList()),
    node: process.version
  };
  const header = base.split ? `Computed on the ${base.split} split${base.split === 'exploration' ? ' (the pilot)' : ''} of the study, ${walletsRecent} wallets in the recent window.` : `Computed on a synthetic study, ${walletsRecent} wallets.`;
  let md = renderVerdicts(verdicts);
  md = md.replace('# Verdicts\n', `# Verdicts\n\n${header}\n`);
  for (const v of Object.values(verdicts.sensitivity)) md += `\n# Sensitivity: ${v.filter}\n\n` + renderVerdicts(v).replace('# Verdicts\n\n', '');
  for (const s of Object.values(results.sensitivity)) if (s.absent) md += `\n# Sensitivity: ${s.filter}\n\nThe draw holds no ${s.flag} flag for these wallets, so the re-run is not computed.\n`;
  ensureDir(outDir);
  writePrivate(join(outDir, 'results.json'), canonicalJson(results));
  writePrivate(join(outDir, 'verdicts.json'), canonicalJson(verdicts));
  writePrivate(join(outDir, 'verdicts.md'), md);
  if (sizing) writePrivate(join(outDir, 'sizing.json'), renderSizing(sizing));
  writePrivate(join(outDir, 'timings.json'), canonicalJson(timings));
  writePrivate(join(outDir, 'inputs.json'), canonicalJson(inputs));
  say('written');
  return { print: { command: 'analyze', network: base.network, split: base.split, wallets: walletsRecent, out: outDir, files: ['results.json', 'verdicts.json', 'verdicts.md', ...(sizing ? ['sizing.json'] : []), 'timings.json', 'inputs.json'], seconds: Math.round((performance.now() - t0) / 1000) } };
}
