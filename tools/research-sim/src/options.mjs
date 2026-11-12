// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The options each command defines, and the reader of a command line against
// them. A plain module with no imports, so that the commands and the study
// and live-fire modules can all read its lists. Option names are camelCase
// here; the command line spells them with dashes.
//
// A command line is checked against its own command's options before the
// command runs (parseArgs): an option the command does not define, a value
// option with no value, a stray word, an option given twice (the repeatable
// ones excepted) and a value outside a closed set or not a positive whole
// number are refused with a message naming the option and the command.

// The database context of history, census, near-cap and collateral
// (history/commands.mjs makeContext).
const CONTEXT_VALUES = ['expectNetwork', 'treatment', 'treatmentPins', 'bytes', 'immutableDir', 'immutableHost', 'extractionRun', 'snapshot'];
// The wallets a command reads (history/commands.mjs resolveWallets).
const WALLET_VALUES = ['wallets'];

// What the study takes by use (study/study.mjs studyOptions refuses, per plan,
// an option the plan does not use). The lists are the union of the plans.
export const STUDY_COMMON = Object.freeze(['plan', 'runId', 'treatment', 'treatmentPins', 'workers', 'memoryBudget', 'reps', 'machine', 'shard', 'walletIndexes', 'stopBefore']);
export const STUDY_DATABASE = Object.freeze(['expectNetwork', 'snapshot', 'extractionRun', 'wallets', 'wallet', 'fromStudy', 'analysisFreezeTx', 'bytes', 'immutableDir', 'immutableHost', 'set']);
export const STUDY_PLAN_OPTIONS = Object.freeze({
  synthetic: Object.freeze([...STUDY_COMMON, 'shapes', 'collateralRule']),
  preprod: Object.freeze([...STUDY_COMMON, ...STUDY_DATABASE, 'days']),
  corpus: Object.freeze([...STUDY_COMMON, ...STUDY_DATABASE])
});

// The live-fire command's two forms (study/live-fire.mjs liveFireOptions and
// the cleanup form).
export const LIVE_FIRE_RUN_OPTIONS = Object.freeze(['runId', 'extractionRun', 'purpose', 'expectNetwork', 'treatment', 'treatmentPins', 'workers', 'bytes', 'immutableDir', 'immutableHost', 'keepForDebug']);
export const LIVE_FIRE_CLEANUP_OPTIONS = Object.freeze(['cleanup', 'runId', 'network']);

// The options that say how a run uses the machine or which part of the work
// an invocation does, never what it computes: the worker counts, the memory
// budget, the machine label, a replay's share of the wallets (--shard,
// --wallet-indexes) and the stage a study stops before. They change no
// record, so run.json keeps them apart from the options and a study or a
// replay stage resumes with other values (study/study.mjs, out/stage.mjs).
export const MACHINE_OPTIONS = Object.freeze(['workers', 'memoryBudget', 'machine', 'shard', 'walletIndexes', 'stopBefore']);

// The options that say where a replay's inputs and output are on this
// machine: the run ID, the treatment directory and pins file, the history
// files. A replay stage's run.json leaves them out, since what they name is
// recorded by content (the treatment pins, wallets.json's SHA-256).
export const LOCAL_OPTIONS = Object.freeze(['runId', 'treatment', 'treatmentPins', 'history']);

// A replay stage's machine label (--machine): letters, digits, - and _, at
// most 64; `local` when absent. The operator chooses it; it is never a host
// name or address read from the machine.
export const MACHINE_LABEL = /^[A-Za-z0-9_-]{1,64}$/;
export const MACHINE_LABEL_RULE = '--machine takes a label of letters, digits, - and _ (at most 64)';
export function machineLabel(v) {
  if (v === undefined) return 'local';
  if (typeof v !== 'string' || !MACHINE_LABEL.test(v)) throw new Error(`${MACHINE_LABEL_RULE}, not ${JSON.stringify(v)}`);
  return v;
}

// A replay's shard (--shard k/n): the wallets whose index modulo n is k, with
// 0 <= k < n. Returns { k, n }; throws naming the rule.
export const SHARD_RULE = '--shard takes k/n, the wallets whose index modulo n is k, with 0 <= k < n';
export function shardOf(v) {
  const m = typeof v === 'string' ? /^(0|[1-9]\d{0,8})\/(0|[1-9]\d{0,8})$/.exec(v) : null;
  if (!m) throw new Error(`${SHARD_RULE}, not ${JSON.stringify(v)}`);
  const k = Number(m[1]);
  const n = Number(m[2]);
  if (n === 0) throw new Error(`${SHARD_RULE}: n is at least 1, not 0 in ${v}`);
  if (k >= n) throw new Error(`${SHARD_RULE}: k is below n, not ${k} in ${v}`);
  return { k, n };
}

// The workers' memory budget (--memory-budget <GiB>, replay/pool.mjs) in
// bytes: a positive number of GiB, decimals allowed; null when absent, the
// pool then taking its default.
export const MEMORY_BUDGET_RULE = '--memory-budget takes a positive number of GiB';
export function memoryBudgetOf(v) {
  if (v === undefined || v === null) return null;
  const n = typeof v === 'string' && /^(\d+(\.\d+)?|\.\d+)$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || !(n > 0)) throw new Error(`${MEMORY_BUDGET_RULE}, not ${JSON.stringify(v)}`);
  return Math.round(n * 1024 ** 3);
}

// Options an earlier version took, refused by name wherever they appear.
export const LIMIT_MS_GONE = 'refusing: --limit-ms is gone: no time limit decides a result; every replay runs to completion, and a watchdog only makes one that hangs run again';
export const ANSWER_LIMIT_MS_GONE = 'refusing: --answer-limit-ms is gone: no time limit decides a result; every method answer runs to completion, and a watchdog only makes one that hangs run again';
const RETIRED = Object.freeze({ limitMs: LIMIT_MS_GONE, answerLimitMs: ANSWER_LIMIT_MS_GONE });

const unique = (...lists) => [...new Set(lists.flat())];

// Per command: `flags` take no value, `values` take one, `repeat` take one and
// may be given more than once; `positional` commands also take words that are
// not options, in `_`. A name appears in one list only.
export const COMMAND_OPTIONS = Object.freeze({
  hash: { flags: [], values: [], repeat: [] },
  help: { flags: [], values: [], repeat: [] },
  history: { flags: [], values: [...CONTEXT_VALUES, 'runId', 'fromStudy', 'wallets', 'analysisFreezeTx'], repeat: ['set', 'window', 'wallet'] },
  census: { flags: ['fromStudy', 'allWallets', 'explain'], values: [...CONTEXT_VALUES, 'runId', ...WALLET_VALUES], repeat: ['set', 'wallet'] },
  'near-cap': { flags: ['fromStudy', 'allWallets'], values: [...CONTEXT_VALUES, 'runId', ...WALLET_VALUES], repeat: ['set', 'wallet'] },
  collateral: { flags: ['explain'], values: [...CONTEXT_VALUES, 'runId', 'days', 'batch'], repeat: ['set'] },
  replay: { flags: ['validity'], values: ['treatment', 'treatmentPins', 'workers', 'memoryBudget', 'runId', 'plan', 'shapes', 'analysisFreezeTx', 'reps', 'collateralRule', 'machine', 'shard', 'walletIndexes'], repeat: ['history'] },
  'plan-shards': { flags: [], values: ['treatment', 'treatmentPins', 'plan', 'shapes', 'reps', 'collateralRule', 'machines', 'out'], repeat: ['history'] },
  'merge-stage': { flags: [], values: ['into', 'machine'], repeat: [], positional: true },
  fidelity: { flags: [], values: ['treatment', 'treatmentPins', 'analysisFreezeTx', 'runId'], repeat: ['history'] },
  study: {
    flags: [],
    values: unique(STUDY_PLAN_OPTIONS.synthetic, STUDY_PLAN_OPTIONS.preprod, STUDY_PLAN_OPTIONS.corpus).filter((k) => !['wallet', 'set'].includes(k)),
    repeat: ['wallet', 'set']
  },
  'live-fire': {
    flags: ['keepForDebug', 'cleanup'],
    values: unique(LIVE_FIRE_RUN_OPTIONS, LIVE_FIRE_CLEANUP_OPTIONS).filter((k) => !['keepForDebug', 'cleanup'].includes(k)),
    repeat: []
  }
});

// Closed value sets, by command where the command matters.
const BYTES = ['tx_cbor', 'immutable'];
const FROM_STUDY = ['random', 'all'];
const CLOSED = Object.freeze({
  fromStudy: { '*': FROM_STUDY },
  bytes: { '*': BYTES },
  plan: { replay: ['recent', 'peak'], 'plan-shards': ['recent', 'peak'], study: ['synthetic', 'preprod', 'corpus'] },
  collateralRule: { '*': ['ledger', 'practice'] }
});
const WINDOW = /^(recent|peak|snapshot|blocks:\d+-\d+)$/;
const WHOLE = ['workers', 'reps', 'days', 'batch'];

export const flagOf = (k) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
const camelOf = (s) => s.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_x, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// The option of the command within edit distance 2 of `name` (dashed, no
// leading dashes), or null.
function closest(name, known) {
  let best = null;
  let bestD = 3;
  for (const k of known) {
    const d = editDistance(name, k);
    if (d < bestD) {
      best = k;
      bestD = d;
    }
  }
  return best;
}

function checkValue(key, v, command) {
  const closed = CLOSED[key] && (CLOSED[key][command] || CLOSED[key]['*']);
  if (closed && !closed.includes(v)) throw new Error(`${flagOf(key)} takes ${closed.join(' | ')}, not ${JSON.stringify(v)} for ${command}`);
  if (key === 'window' && !WINDOW.test(v)) throw new Error(`${flagOf(key)} takes recent | peak | snapshot | blocks:<first id>-<last id>, not ${JSON.stringify(v)} for ${command}`);
  if (WHOLE.includes(key) && !(/^[1-9]\d*$/.test(v) && Number.isSafeInteger(Number(v)))) throw new Error(`${flagOf(key)} takes a positive whole number, not ${JSON.stringify(v)} for ${command}`);
  if (key === 'machine' && !MACHINE_LABEL.test(v)) throw new Error(`${MACHINE_LABEL_RULE}, not ${JSON.stringify(v)} for ${command}`);
  if (key === 'memoryBudget') {
    try {
      memoryBudgetOf(v);
    } catch (e) {
      throw new Error(`${e.message} for ${command}`);
    }
  }
  if (key === 'shard') {
    try {
      shardOf(v);
    } catch (e) {
      throw new Error(`${e.message} for ${command}`);
    }
  }
}

// Reads a command line against the options of `command`. The result is
// { _: [] } and the camelCase keys: a flag is true, a value is its string, and
// a repeatable option is a string when given once and an array when repeated.
// Throws an Error naming the option and the command.
export function parseArgs(argv, command) {
  const spec = COMMAND_OPTIONS[command];
  if (!spec) throw new Error(`unknown command ${command}`);
  const flags = new Set(spec.flags);
  const repeat = new Set(spec.repeat);
  const known = new Set([...spec.flags, ...spec.values, ...spec.repeat].map(flagOf).map((f) => f.slice(2)));
  const opts = { _: [] };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      if (spec.positional) {
        opts._.push(a);
        continue;
      }
      throw new Error(`unexpected argument ${JSON.stringify(a)} for ${command}; options start with --, and a flag takes no value`);
    }
    const name = a.slice(2);
    const key = camelOf(name);
    if (Object.hasOwn(RETIRED, key)) throw new Error(RETIRED[key]);
    if (!known.has(name)) {
      const near = closest(name.split('=')[0], known);
      const eq = name.includes('=') ? '; write the option and its value as two words' : '';
      throw new Error(`unknown option ${a} for ${command}${near ? `; did you mean --${near}?` : ''}${eq}`);
    }
    if (seen.has(key) && !repeat.has(key)) throw new Error(`${a} given more than once for ${command}`);
    seen.add(key);
    if (flags.has(key)) {
      opts[key] = true;
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value for ${command}`);
    i++;
    checkValue(key, v, command);
    opts[key] = key in opts ? [].concat(opts[key], v) : v;
  }
  return opts;
}
