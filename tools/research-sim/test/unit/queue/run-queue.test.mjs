// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The unattended job queue (scripts/run-queue.mjs), run over small Node child
// scripts: order, resume, failure handling, limits and process groups, the
// before and after commands, pauses, the lock, validation, env files,
// interrupted jobs, signals, atomic state and the status command. No
// treatment and no database.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, '..', '..', '..', 'scripts', 'run-queue.mjs');
const JOB = join(HERE, '..', '..', 'lib', 'queue-job.mjs');
let root;
let seq = 0;
const spawned = [];

before(() => { root = mkdtempSync(join(tmpdir(), 'run-queue-')); });
after(() => {
  for (const pid of spawned) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  rmSync(root, { recursive: true, force: true });
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const groupAlive = (pid) => { try { process.kill(-pid, 0); return true; } catch { return false; } };
const waitFor = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timed out waiting');
};

// A fresh directory with a queue file; jobs are [id, ...behaviors] or objects.
function setup(jobs, extra = {}) {
  const dir = join(root, `q${seq++}`);
  mkdirSync(dir);
  const q = {
    name: 'test-queue',
    out: 'out',
    jobs: jobs.map((j) => (Array.isArray(j) ? { id: j[0], cwd: '.', argv: [process.execPath, JOB, ...j], timeoutMinutes: 1 } : j)),
    ...extra,
  };
  const file = join(dir, 'queue.json');
  writeFileSync(file, JSON.stringify(q));
  const env = { ...process.env, QUEUE_TEST_LOG: join(dir, 'order.log'), QUEUE_TEST_PIDS: join(dir, 'pids'), QUEUE_TEST_ENV_OUT: join(dir, 'env.out') };
  return { dir, file, env, out: join(dir, 'out'), q };
}
const rewrite = (s, q) => writeFileSync(s.file, JSON.stringify(q));
const run = (s, ...args) => spawnSync(process.execPath, [RUNNER, 'run', s.file, ...args], { env: s.env, encoding: 'utf8' });
const status = (s) => spawnSync(process.execPath, [RUNNER, 'status', s.file], { env: s.env, encoding: 'utf8' });
const state = (s) => JSON.parse(readFileSync(join(s.out, 'state.json'), 'utf8'));
const st = (s, id) => state(s).jobs.find((j) => j.id === id);
const order = (s) => (existsSync(join(s.dir, 'order.log')) ? readFileSync(join(s.dir, 'order.log'), 'utf8').trim().split('\n') : []);

test('jobs run in order, one at a time, with logs and a state', () => {
  const s = setup([['a'], ['b'], ['c']]);
  const r = run(s);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(order(s), ['a', 'b', 'c']);
  const d = state(s);
  assert.deepEqual(d.jobs.map((j) => j.status), ['done', 'done', 'done']);
  const att = d.jobs[0].attempts[0];
  assert.equal(att.exitCode, 0);
  assert.ok(att.pid > 0 && att.start && att.end && att.durationSeconds >= 0 && typeof att.loadAtStart === 'number');
  assert.deepEqual(att.argv, s.q.jobs[0].argv);
  assert.ok(existsSync(join(s.out, 'a', 'attempt-1', 'stdout.log')) && existsSync(join(s.out, 'a', 'attempt-1', 'stderr.log')));
  const runner = d.runners[0];
  assert.ok(runner.host.logicalCores > 0 && runner.host.node === process.version && runner.host.totalMemoryBytes > 0);
  assert.ok(!existsSync(join(s.out, 'queue.lock')));
});

test('a rerun skips done jobs', () => {
  const s = setup([['a'], ['b', 'fail'], ['c']]);
  assert.equal(run(s).status, 1);
  assert.deepEqual(order(s), ['a', 'b']);
  const q = s.q; q.jobs[1].argv = [process.execPath, JOB, 'b'];
  rewrite(s, q);
  assert.equal(run(s).status, 0);
  assert.deepEqual(order(s), ['a', 'b', 'b', 'c']);
  assert.equal(st(s, 'b').attempts.length, 2);
  assert.equal(st(s, 'a').attempts.length, 1);
});

test('a failure stops the queue; --continue-on-failure goes on', () => {
  const s = setup([['a', 'fail'], ['b']]);
  const r = run(s);
  assert.equal(r.status, 1);
  assert.deepEqual(order(s), ['a']);
  assert.equal(st(s, 'a').status, 'failed');
  assert.equal(st(s, 'a').attempts[0].exitCode, 1);
  assert.equal(st(s, 'b').status, 'pending');
  const s2 = setup([['a', 'fail'], ['b']]);
  assert.equal(run(s2, '--continue-on-failure').status, 1);
  assert.deepEqual(order(s2), ['a', 'b']);
  assert.equal(st(s2, 'b').status, 'done');
});

test('a timeout ends the job and the grandchild it started', () => {
  const s = setup([{ id: 'slow', cwd: '.', argv: [process.execPath, JOB, 'slow', 'grandchild', 'sleep:60000'], timeoutMinutes: 0.02 }]);
  const r = run(s);
  assert.equal(r.status, 1);
  assert.equal(st(s, 'slow').status, 'timeout');
  const [pid, gc] = readFileSync(join(s.dir, 'pids'), 'utf8').trim().split(' ').map(Number);
  assert.ok(!groupAlive(pid));
  assert.ok(!alive(gc));
});

test('a group that ignores SIGTERM gets SIGKILL after the grace period', () => {
  const s = setup([{ id: 'stubborn', cwd: '.', argv: [process.execPath, JOB, 's', 'ignore-term', 'grandchild:ignore-term', 'sleep:60000'], timeoutMinutes: 0.02 }]);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [RUNNER, 'run', s.file], { env: { ...s.env, RUN_QUEUE_KILL_GRACE_MS: '700' }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.ok(Date.now() - t0 >= 1800, 'waited for the grace period');
  assert.equal(st(s, 'stubborn').status, 'timeout');
  const [pid, gc] = readFileSync(join(s.dir, 'pids'), 'utf8').trim().split(' ').map(Number);
  assert.ok(!groupAlive(pid));
  assert.ok(!alive(gc));
});

test('before failing skips the job and after still runs', () => {
  const s = setup([{ id: 'j', cwd: '.', argv: [process.execPath, JOB, 'main'], timeoutMinutes: 1, before: [process.execPath, JOB, 'before', 'fail'], after: [process.execPath, JOB, 'after'] }]);
  assert.equal(run(s).status, 1);
  assert.deepEqual(order(s), ['before', 'after']);
  const att = st(s, 'j').attempts[0];
  assert.equal(st(s, 'j').status, 'failed');
  assert.equal(att.before.exitCode, 1);
  assert.equal(att.after.exitCode, 0);
  assert.equal(att.exitCode, null);
});

test('after runs after a failure and its exit is recorded; before and after run around a success', () => {
  const s = setup([
    { id: 'f', cwd: '.', argv: [process.execPath, JOB, 'main-f', 'fail'], timeoutMinutes: 1, after: [process.execPath, JOB, 'after-f', 'fail'] },
    { id: 'g', cwd: '.', argv: [process.execPath, JOB, 'main-g'], timeoutMinutes: 1, before: [process.execPath, JOB, 'before-g'], after: [process.execPath, JOB, 'after-g'] },
  ]);
  assert.equal(run(s, '--continue-on-failure').status, 1);
  assert.deepEqual(order(s), ['main-f', 'after-f', 'before-g', 'main-g', 'after-g']);
  assert.equal(st(s, 'f').attempts[0].after.exitCode, 1);
  assert.equal(st(s, 'f').status, 'failed');
  assert.equal(st(s, 'g').status, 'done');
});

test('pauseAfter exits 3 and the next run continues', () => {
  const s = setup([['a'], { id: 'b', cwd: '.', argv: [process.execPath, JOB, 'b'], timeoutMinutes: 1, pauseAfter: true }, ['c']]);
  assert.equal(run(s).status, 3);
  assert.deepEqual(order(s), ['a', 'b']);
  assert.equal(run(s).status, 0);
  assert.deepEqual(order(s), ['a', 'b', 'c']);
  // A pauseAfter job that ends the queue is not a pause.
  const s2 = setup([['a', 'sleep:1'], { id: 'z', cwd: '.', argv: [process.execPath, JOB, 'z'], timeoutMinutes: 1, pauseAfter: true }]);
  assert.equal(run(s2).status, 0);
});

test('the lock is refused while held and taken over when stale', async () => {
  const s = setup([['a']]);
  mkdirSync(s.out, { recursive: true });
  const holder = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  spawned.push(holder.pid);
  writeFileSync(join(s.out, 'queue.lock'), `${holder.pid}\n`);
  const r = run(s);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /holds/);
  assert.deepEqual(order(s), []);
  assert.match(status(s).stdout, new RegExp(`runner: running \\(process ${holder.pid}\\)`));
  holder.kill('SIGKILL');
  await new Promise((res) => holder.once('exit', res));
  assert.match(status(s).stdout, /stale lock/);
  const r2 = run(s);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /taking over/);
  assert.ok(!existsSync(join(s.out, 'queue.lock')));
});

test('an invalid queue is refused before any job runs', () => {
  const good = { id: 'a', cwd: '.', argv: [process.execPath, JOB, 'a'], timeoutMinutes: 1 };
  // Each case adds bad jobs after a valid one ('first', which would run if the queue were not refused whole).
  const cases = [
    ['unknown job key', [{ ...good, bogus: 1 }], {}, /jobs\[1\]\.bogus: unknown key/],
    ['unknown queue key', [good], { extra: 1 }, /queue\.extra: unknown key/],
    ['missing timeout', [{ ...good, timeoutMinutes: undefined }], {}, /jobs\[1\]\.timeoutMinutes: required/],
    ['non-positive timeout', [{ ...good, timeoutMinutes: 0 }], {}, /jobs\[1\]\.timeoutMinutes: must be a positive/],
    ['duplicate id', [good, good], {}, /jobs\[2\]\.id: duplicate/],
    ['unsafe id', [{ ...good, id: '../x' }], {}, /jobs\[1\]\.id/],
    ['missing cwd', [{ ...good, cwd: 'nope' }], {}, /jobs\[1\]\.cwd: directory does not exist/],
    ['mistyped argv', [{ ...good, argv: 'node x' }], {}, /jobs\[1\]\.argv/],
    ['mistyped env', [{ ...good, env: { A: 1 } }], {}, /jobs\[1\]\.env\.A: must be a string/],
    ['missing envFile', [{ ...good, envFile: 'nope.env' }], {}, /jobs\[1\]\.envFile: file does not exist/],
    ['incomplete idle', [{ ...good, idle: { maxLoad1: 1 } }], {}, /jobs\[1\]\.idle\.forMinutes: required/],
    ['mistyped pauseAfter', [{ ...good, pauseAfter: 'yes' }], {}, /jobs\[1\]\.pauseAfter/],
    ['no jobs', [], { jobs: [] }, /queue\.jobs: must be a non-empty array/],
  ];
  for (const [label, bad, extra, re] of cases) {
    const s = setup([['first']]);
    const first = { id: 'first', cwd: '.', argv: [process.execPath, JOB, 'first'], timeoutMinutes: 1 };
    rewrite(s, { name: 'bad', out: 'out', jobs: [first, ...bad], ...extra });
    const r = run(s);
    assert.equal(r.status, 2, label);
    assert.match(r.stderr, re, label);
    assert.deepEqual(order(s), [], `${label}: nothing ran`);
    assert.ok(!existsSync(join(s.out, 'state.json')), label);
  }
  const s = setup([['a']]);
  writeFileSync(s.file, '{not json');
  assert.equal(run(s).status, 2);
});

test('env files: parsing, precedence and a refused line', () => {
  const s = setup([]);
  writeFileSync(join(s.dir, 'q.env'), '# comment\n\nexport A=queue-file\nB=queue-file\nC=queue-file\nD=queue-file\nQUOTED="x y"\nEXPAND=$HOME/${X}\n');
  writeFileSync(join(s.dir, 'j.env'), 'export C=job-file\nD=job-file\n');
  const job = {
    id: 'e', cwd: '.', timeoutMinutes: 1, envFile: 'j.env', env: { D: 'job-env' },
    argv: [process.execPath, JOB, 'e', ...['A', 'B', 'C', 'D', 'QUOTED', 'EXPAND', 'INHERITED'].map((n) => `env:${n}`)],
  };
  rewrite(s, { name: 'envq', out: 'out', envFile: 'q.env', env: { B: 'queue-env' }, jobs: [job] });
  const r = spawnSync(process.execPath, [RUNNER, 'run', s.file], { env: { ...s.env, INHERITED: 'from-parent', A: 'from-parent' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const lines = readFileSync(join(s.dir, 'env.out'), 'utf8').trim().split('\n');
  assert.deepEqual(lines, ['A=queue-file', 'B=queue-env', 'C=job-file', 'D=job-env', 'QUOTED="x y"', 'EXPAND=$HOME/${X}', 'INHERITED=from-parent']);
  const names = st(s, 'e').attempts[0].envNamesFromQueue;
  assert.deepEqual(names, ['A', 'B', 'C', 'D', 'EXPAND', 'QUOTED']);
  assert.ok(!readFileSync(join(s.out, 'state.json'), 'utf8').includes('job-file'), 'no value in the state');
  writeFileSync(join(s.dir, 'j.env'), 'export C=ok\nthis is not an assignment\n');
  const r2 = run(s);
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /jobs\[0\]\.envFile: .*j\.env:2: not KEY=VALUE/);
});

test('a job recorded running with a dead process is interrupted until --rerun-interrupted', () => {
  const s = setup([['a'], ['b']]);
  mkdirSync(s.out, { recursive: true });
  writeFileSync(join(s.out, 'state.json'), JSON.stringify({
    schema: 1, queue: 'test-queue', runners: [],
    jobs: [{ id: 'a', status: 'done', attempts: [{ n: 1 }] }, { id: 'b', status: 'running', attempts: [{ n: 1, pid: 2147483000, livePid: 2147483000, start: new Date().toISOString() }] }],
  }));
  const r = run(s);
  assert.equal(r.status, 4);
  assert.deepEqual(order(s), []);
  assert.equal(st(s, 'b').status, 'interrupted');
  assert.match(status(s).stdout, /b {2}interrupted/);
  const r2 = run(s, '--rerun-interrupted');
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(order(s), ['b']);
  assert.equal(st(s, 'b').attempts.length, 2);
  assert.equal(st(s, 'b').status, 'done');
});

test('SIGTERM to the runner records interrupted, stops the job group and releases the lock', async () => {
  const s = setup([['a', 'grandchild', 'sleep:60000'], ['b']]);
  const p = spawn(process.execPath, [RUNNER, 'run', s.file], { env: s.env, stdio: 'ignore' });
  spawned.push(p.pid);
  const exited = new Promise((res) => p.once('exit', (code) => res(code)));
  await waitFor(() => existsSync(join(s.dir, 'pids')) && readFileSync(join(s.dir, 'pids'), 'utf8').includes(' '));
  const [pid, gc] = readFileSync(join(s.dir, 'pids'), 'utf8').trim().split(' ').map(Number);
  p.kill('SIGTERM');
  assert.equal(await exited, 4);
  assert.equal(st(s, 'a').status, 'interrupted');
  assert.equal(st(s, 'b').status, 'pending');
  assert.ok(!groupAlive(pid));
  assert.ok(!alive(gc));
  assert.ok(!existsSync(join(s.out, 'queue.lock')));
  assert.equal(run(s).status, 4);
});

test('state.json is never half-written', async () => {
  const s = setup(Array.from({ length: 12 }, (_, i) => [`j${i}`, 'sleep:30']));
  const p = spawn(process.execPath, [RUNNER, 'run', s.file], { env: s.env, stdio: 'ignore' });
  spawned.push(p.pid);
  const exited = new Promise((res) => p.once('exit', (code) => res(code)));
  let reads = 0;
  let finished = false;
  exited.then(() => { finished = true; });
  while (!finished) {
    const f = join(s.out, 'state.json');
    if (existsSync(f)) { JSON.parse(readFileSync(f, 'utf8')); reads += 1; }
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(await exited, 0);
  assert.ok(reads > 10, `read the state ${reads} times during the run`);
});

test('status prints a line per job and the runner', () => {
  const s = setup([['a'], ['b', 'fail'], ['c']]);
  assert.match(status(s).stdout, /a {2}pending {2}attempts 0/);
  run(s);
  const r = status(s);
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[1], /^a {2}done {2}attempts 1 {2}last [\d.]+ s {2}exit 0$/);
  assert.match(lines[2], /^b {2}failed {2}attempts 1 .* exit 1$/);
  assert.match(lines[3], /^c {2}pending {2}attempts 0/);
  assert.match(lines[4], /^runner: none$/);
});

test('idle: a threshold that cannot be met fails after maxWaitMinutes; a met one runs', () => {
  const s = setup([{ id: 'w', cwd: '.', argv: [process.execPath, JOB, 'w'], timeoutMinutes: 1, idle: { maxLoad1: 1000000, forMinutes: 10, maxWaitMinutes: 0.005 } }]);
  const r = run(s);
  assert.equal(r.status, 1);
  assert.deepEqual(order(s), []);
  assert.equal(st(s, 'w').status, 'failed');
  assert.match(st(s, 'w').attempts[0].note, /did not stay at or under/);
  const s2 = setup([{ id: 'w', cwd: '.', argv: [process.execPath, JOB, 'w'], timeoutMinutes: 1, idle: { maxLoad1: 1000000, forMinutes: 0, maxWaitMinutes: 1 } }]);
  assert.equal(run(s2).status, 0);
});

test('--detach starts a runner in its own session and prints its pid', async () => {
  const s = setup([['a', 'sleep:200'], ['b']]);
  const r = run(s, '--detach');
  assert.equal(r.status, 0, r.stderr);
  const pid = Number(r.stdout.trim());
  assert.ok(pid > 0);
  spawned.push(pid);
  await waitFor(() => existsSync(join(s.out, 'state.json')) && state(s).jobs.every((j) => j.status === 'done'));
  await waitFor(() => !alive(pid));
  assert.ok(readFileSync(join(s.out, 'runner.log'), 'utf8').includes('every job is done'));
});
