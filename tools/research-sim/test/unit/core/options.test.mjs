// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The command line reader: every command's options, and what it refuses
// before the command runs. No database, no CSL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_OPTIONS, STUDY_PLAN_OPTIONS, LIVE_FIRE_RUN_OPTIONS, LIVE_FIRE_CLEANUP_OPTIONS, flagOf } from '../../../src/options.mjs';
import { parseArgs as fromHistory } from '../../../src/history/commands.mjs';
import { parseArgs } from '../../../src/options.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'cli.mjs');
const COMMANDS = Object.keys(COMMAND_OPTIONS);
const refused = (argv, command, re) => assert.throws(() => parseArgs(argv, command), re, `${command} ${argv.join(' ')}`);

// A value each option accepts for a command.
function sample(key, command) {
  if (key === 'plan') return command === 'study' ? 'synthetic' : 'recent';
  if (key === 'fromStudy') return 'random';
  if (key === 'methods') return 'test';
  if (key === 'bytes') return 'tx_cbor';
  if (key === 'window') return 'blocks:10-20';
  if (['workers', 'oracleWorkers', 'reps', 'repsH1', 'repsVariants', 'testReps', 'limitMs', 'answerLimitMs', 'days', 'batch'].includes(key)) return '3';
  return 'x';
}
const argvOf = (key, command, spec) => (spec.flags.includes(key) ? [flagOf(key)] : [flagOf(key), sample(key, command)]);

test('parseArgs is exported from the history commands and reads the same table', () => {
  assert.equal(fromHistory, parseArgs);
});

test('every option of every command parses, to its kind', () => {
  for (const command of COMMANDS) {
    const spec = COMMAND_OPTIONS[command];
    for (const key of [...spec.flags, ...spec.values, ...spec.repeat]) {
      const got = parseArgs(argvOf(key, command, spec), command);
      assert.equal(got[key], spec.flags.includes(key) ? true : sample(key, command), `${command} ${key}`);
      assert.deepEqual(Object.keys(got), ['_', key]);
      assert.deepEqual(got._, []);
    }
    assert.deepEqual(parseArgs([], command), { _: [] });
  }
});

test('no option is listed twice in a command, and each command is a flag, a value or a repeatable value', () => {
  for (const command of COMMANDS) {
    const spec = COMMAND_OPTIONS[command];
    const all = [...spec.flags, ...spec.values, ...spec.repeat];
    assert.equal(new Set(all).size, all.length, command);
  }
});

test('an option of another command is refused, naming the option and the command', () => {
  for (const command of COMMANDS) {
    const own = COMMAND_OPTIONS[command];
    const ownAll = new Set([...own.flags, ...own.values, ...own.repeat]);
    for (const other of COMMANDS) {
      if (other === command) continue;
      const spec = COMMAND_OPTIONS[other];
      for (const key of [...spec.flags, ...spec.values, ...spec.repeat]) {
        if (ownAll.has(key)) continue;
        refused(argvOf(key, other, spec), command, new RegExp(`unknown option ${flagOf(key)} for ${command}`));
      }
    }
  }
});

test('hash and help take no option', () => {
  refused(['--x'], 'hash', /unknown option --x for hash$/);
  refused(['--run-id', 'a'], 'help', /unknown option --run-id for help/);
  assert.deepEqual(parseArgs([], 'hash'), { _: [] });
});

test('an unknown option: a near miss is suggested, and an = is explained', () => {
  refused(['--run-id', 'x', '--from-studdy'], 'census', /unknown option --from-studdy for census; did you mean --from-study\?$/);
  refused(['--test-rep', '1'], 'replay', /unknown option --test-rep for replay; did you mean --test-reps\?/);
  refused(['--rep', '1'], 'battery', /unknown option --rep for battery; did you mean --reps\?/);
  refused(['--oracle-worker', '4'], 'battery', /did you mean --oracle-workers\?/);
  refused(['--workers=4'], 'battery', /unknown option --workers=4 for battery; did you mean --workers\?; write the option and its value as two words$/);
  refused(['--set=a=1'], 'history', /write the option and its value as two words/);
  refused(['--qqqqqqq'], 'history', /unknown option --qqqqqqq for history$/);
});

test('a value option with nothing after it, or followed by an option, is refused', () => {
  refused(['--run-id'], 'history', /--run-id needs a value for history/);
  refused(['--run-id', '--window', 'recent'], 'history', /--run-id needs a value for history/);
  refused(['--workers', '--validity'], 'replay', /--workers needs a value for replay/);
  refused(['--set'], 'history', /--set needs a value for history/);
});

test('a flag given a value leaves a stray word, which is refused', () => {
  refused(['--validity', 'true'], 'replay', /unexpected argument "true" for replay; options start with --, and a flag takes no value/);
  refused(['--explain', 'yes'], 'census', /unexpected argument "yes" for census/);
  refused(['stray'], 'history', /unexpected argument "stray" for history/);
  refused(['--run-id', 'a', 'b'], 'history', /unexpected argument "b"/);
});

test('an option given twice is refused, flags included, except the repeatable ones', () => {
  refused(['--run-id', 'a', '--run-id', 'b'], 'history', /--run-id given more than once for history/);
  refused(['--validity', '--validity'], 'replay', /--validity given more than once for replay/);
  refused(['--oracle', '--oracle'], 'battery', /--oracle given more than once/);
  refused(['--from-study', '--from-study'], 'near-cap', /--from-study given more than once/);
  refused(['--keep-for-debug', '--keep-for-debug'], 'live-fire', /given more than once/);
  assert.deepEqual(COMMANDS.flatMap((c) => COMMAND_OPTIONS[c].repeat).filter((v, i, a) => a.indexOf(v) === i).sort(), ['history', 'set', 'wallet', 'window']);
});

test('the repeatable options: a string once, an array when repeated', () => {
  assert.equal(parseArgs(['--set', 'a=1'], 'history').set, 'a=1');
  assert.deepEqual(parseArgs(['--set', 'a=1', '--set', 'b=2'], 'history').set, ['a=1', 'b=2']);
  assert.deepEqual(parseArgs(['--wallet', 'x', '--wallet', 'y', '--wallet', 'z'], 'census').wallet, ['x', 'y', 'z']);
  assert.equal(parseArgs(['--wallet', 'x'], 'near-cap').wallet, 'x');
  assert.deepEqual(parseArgs(['--window', 'recent', '--window', 'peak'], 'history').window, ['recent', 'peak']);
  assert.equal(parseArgs(['--window', 'snapshot'], 'history').window, 'snapshot');
  assert.deepEqual(parseArgs(['--history', 'a', '--history', 'b'], 'replay').history, ['a', 'b']);
  assert.deepEqual(parseArgs(['--history', 'a', '--history', 'b'], 'fidelity').history, ['a', 'b']);
  assert.deepEqual(parseArgs(['--wallet', 'a', '--wallet', 'b', '--set', 'c=1', '--set', 'd=2'], 'study'), { _: [], wallet: ['a', 'b'], set: ['c=1', 'd=2'] });
});

test('--from-study takes random or all for history and study, and is a flag for census and near-cap', () => {
  assert.equal(parseArgs(['--from-study', 'all'], 'history').fromStudy, 'all');
  assert.equal(parseArgs(['--from-study', 'random'], 'study').fromStudy, 'random');
  refused(['--from-study', 'every'], 'history', /--from-study takes random \| all, not "every" for history/);
  refused(['--from-study', 'x'], 'study', /--from-study takes random \| all/);
  refused(['--from-study'], 'history', /--from-study needs a value for history/);
  for (const c of ['census', 'near-cap']) {
    assert.equal(parseArgs(['--from-study'], c).fromStudy, true);
    assert.equal(parseArgs(['--from-study', '--run-id', 'a'], c).fromStudy, true);
    refused(['--from-study', 'all'], c, /unexpected argument "all" for /);
  }
});

test('closed values: methods, bytes, plan and window', () => {
  assert.equal(parseArgs(['--methods', 'study'], 'battery').methods, 'study');
  refused(['--methods', 'tset'], 'battery', /--methods takes study \| test, not "tset" for battery/);
  for (const c of ['history', 'census', 'near-cap', 'collateral', 'study', 'live-fire']) {
    assert.equal(parseArgs(['--bytes', 'immutable'], c).bytes, 'immutable');
    refused(['--bytes', 'cbor'], c, /--bytes takes tx_cbor \| immutable/);
  }
  for (const p of ['recent', 'peak', 'test']) assert.equal(parseArgs(['--plan', p], 'replay').plan, p);
  refused(['--plan', 'synthetic'], 'replay', /--plan takes recent \| peak \| test, not "synthetic" for replay/);
  for (const p of ['synthetic', 'preprod', 'corpus']) assert.equal(parseArgs(['--plan', p], 'study').plan, p);
  refused(['--plan', 'recent'], 'study', /--plan takes synthetic \| preprod \| corpus, not "recent" for study/);
  for (const w of ['recent', 'peak', 'snapshot', 'blocks:1-2']) assert.equal(parseArgs(['--window', w], 'history').window, w);
  for (const w of ['peek', 'blocks:1', 'blocks:a-2', 'blocks:1-2x', 'RECENT', '']) refused(['--window', w], 'history', /--window takes recent \| peak \| snapshot \| blocks:<first id>-<last id>/);
});

test('whole-number options: positive whole numbers only', () => {
  const byCommand = { replay: ['workers', 'testReps', 'repsH1', 'repsVariants', 'limitMs'], battery: ['workers', 'oracleWorkers', 'reps', 'answerLimitMs'], collateral: ['days', 'batch'], study: ['workers', 'oracleWorkers', 'reps', 'repsH1', 'repsVariants', 'limitMs', 'answerLimitMs'], 'live-fire': ['workers', 'oracleWorkers'] };
  for (const [command, keys] of Object.entries(byCommand)) {
    for (const k of keys) {
      assert.equal(parseArgs([flagOf(k), '12'], command)[k], '12');
      for (const bad of ['0', '-1', '1.5', '3O', 'x', '', '01', '1e3', ' 2', '99999999999999999999']) refused([flagOf(k), bad], command, new RegExp(`${flagOf(k)} takes a positive whole number, not ${JSON.stringify(bad).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} for ${command}`));
    }
  }
});

test('a value never begins with --', () => {
  refused(['--treatment', '--treatment-pins', 'p'], 'fidelity', /--treatment needs a value for fidelity/);
});

test('an option an earlier version took is refused with the reason, wherever it appears', () => {
  for (const c of ['battery', 'study', 'replay']) refused(['--oracle-limit-ms', '5000'], c, /--oracle-limit-ms is gone: the oracle stops on its work budget/);
});

test('the study and live-fire sets come from the lists their modules read', () => {
  const study = COMMAND_OPTIONS.study;
  const studyAll = new Set([...study.flags, ...study.values, ...study.repeat]);
  const planAll = new Set(Object.values(STUDY_PLAN_OPTIONS).flat());
  assert.deepEqual([...studyAll].sort(), [...planAll].sort());
  const live = COMMAND_OPTIONS['live-fire'];
  assert.deepEqual([...live.flags, ...live.values, ...live.repeat].sort(), [...new Set([...LIVE_FIRE_RUN_OPTIONS, ...LIVE_FIRE_CLEANUP_OPTIONS])].sort());
  assert.deepEqual([...live.flags].sort(), ['cleanup', 'keepForDebug']);
  assert.deepEqual([...study.flags].sort(), ['oracle', 'validity']);
});

test('census and near-cap take --wallet; collateral takes --batch; --explain is census and collateral only', () => {
  assert.ok(parseArgs(['--wallet', 'a'], 'census').wallet);
  assert.ok(parseArgs(['--wallet', 'a'], 'near-cap').wallet);
  assert.equal(parseArgs(['--batch', '500'], 'collateral').batch, '500');
  for (const c of COMMANDS) {
    const has = COMMAND_OPTIONS[c].flags.includes('explain');
    assert.equal(has, c === 'census' || c === 'collateral', c);
  }
});

test('a misspelled option of a database command stops the process before any connection or output', () => {
  const home = mkdtempSync(join(tmpdir(), 'rsim-options-'));
  try {
    const r = spawnSync(process.execPath, [CLI, 'census', '--run-id', 'x', '--from-studdy'], {
      env: { ...process.env, RESEARCH_SIM_HOME: home, PGHOST: join(home, 'no-such-socket-dir'), PGPORT: '1' },
      encoding: 'utf8'
    });
    assert.equal(r.status, 1);
    assert.equal(r.stderr, 'unknown option --from-studdy for census; did you mean --from-study?\n');
    assert.equal(r.stdout, '');
    assert.deepEqual(readdirSync(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an unknown command still prints the usage and exits 2', () => {
  const r = spawnSync(process.execPath, [CLI, 'nope'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^unknown command nope\n/);
});
