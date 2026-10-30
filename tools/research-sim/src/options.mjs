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
export const STUDY_COMMON = Object.freeze(['plan', 'runId', 'treatment', 'treatmentPins', 'workers', 'reps', 'repsH1', 'repsVariants', 'limitMs', 'answerLimitMs', 'oracle', 'oracleWorkers', 'oracleSettings', 'validity']);
export const STUDY_DATABASE = Object.freeze(['expectNetwork', 'snapshot', 'extractionRun', 'wallets', 'wallet', 'fromStudy', 'analysisFreezeTx', 'bytes', 'immutableDir', 'immutableHost', 'set']);
export const STUDY_PLAN_OPTIONS = Object.freeze({
  synthetic: Object.freeze([...STUDY_COMMON, 'shapes']),
  preprod: Object.freeze([...STUDY_COMMON, ...STUDY_DATABASE, 'days']),
  corpus: Object.freeze([...STUDY_COMMON, ...STUDY_DATABASE])
});

// The live-fire command's two forms (study/live-fire.mjs liveFireOptions and
// the cleanup form).
export const LIVE_FIRE_RUN_OPTIONS = Object.freeze(['runId', 'extractionRun', 'purpose', 'expectNetwork', 'treatment', 'treatmentPins', 'workers', 'oracleWorkers', 'bytes', 'immutableDir', 'immutableHost', 'keepForDebug']);
export const LIVE_FIRE_CLEANUP_OPTIONS = Object.freeze(['cleanup', 'runId', 'network']);

// Options an earlier version took, refused by name wherever they appear.
export const ORACLE_LIMIT_MS_GONE = 'refusing: --oracle-limit-ms is gone: the oracle stops on its work budget (the oracle settings maxCandidateSets, maxSolves and maxSolveNodes), with a guard at guardMs';
const RETIRED = Object.freeze({ oracleLimitMs: ORACLE_LIMIT_MS_GONE });

const unique = (...lists) => [...new Set(lists.flat())];

// Per command: `flags` take no value, `values` take one, `repeat` take one and
// may be given more than once. A name appears in one list only.
export const COMMAND_OPTIONS = Object.freeze({
  hash: { flags: [], values: [], repeat: [] },
  help: { flags: [], values: [], repeat: [] },
  history: { flags: [], values: [...CONTEXT_VALUES, 'runId', 'fromStudy', 'wallets', 'analysisFreezeTx'], repeat: ['set', 'window', 'wallet'] },
  census: { flags: ['fromStudy', 'allWallets', 'explain'], values: [...CONTEXT_VALUES, 'runId', ...WALLET_VALUES], repeat: ['set', 'wallet'] },
  'near-cap': { flags: ['fromStudy', 'allWallets'], values: [...CONTEXT_VALUES, 'runId', ...WALLET_VALUES], repeat: ['set', 'wallet'] },
  collateral: { flags: ['explain'], values: [...CONTEXT_VALUES, 'runId', 'days', 'batch'], repeat: ['set'] },
  'battery-pools': { flags: [], values: ['runId', 'network', 'historyRun'], repeat: [] },
  replay: { flags: ['validity'], values: ['treatment', 'treatmentPins', 'workers', 'runId', 'plan', 'shapes', 'analysisFreezeTx', 'testReps', 'repsH1', 'repsVariants', 'limitMs'], repeat: ['history'] },
  battery: { flags: ['oracle', 'validity'], values: ['treatment', 'treatmentPins', 'workers', 'runId', 'shapes', 'analysisFreezeTx', 'methods', 'reps', 'pools', 'oracleSettings', 'oracleWorkers', 'answerLimitMs'], repeat: ['history'] },
  fidelity: { flags: [], values: ['treatment', 'treatmentPins', 'analysisFreezeTx', 'runId'], repeat: ['history'] },
  study: {
    flags: ['oracle', 'validity'],
    values: unique(STUDY_PLAN_OPTIONS.synthetic, STUDY_PLAN_OPTIONS.preprod, STUDY_PLAN_OPTIONS.corpus).filter((k) => !['oracle', 'validity', 'wallet', 'set'].includes(k)),
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
  methods: { '*': ['study', 'test'] },
  bytes: { '*': BYTES },
  plan: { replay: ['recent', 'peak', 'test'], study: ['synthetic', 'preprod', 'corpus'] }
});
const WINDOW = /^(recent|peak|snapshot|blocks:\d+-\d+)$/;
const WHOLE = ['workers', 'oracleWorkers', 'reps', 'repsH1', 'repsVariants', 'testReps', 'limitMs', 'answerLimitMs', 'days', 'batch'];

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
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(a)} for ${command}; options start with --, and a flag takes no value`);
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
