// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A stand-in for the replay worker (src/replay/worker.mjs) that speaks its
// messages and runs the job through the real runJob (src/replay/run.mjs), so
// that the spool, the validity file beside it and the stopped record are the
// ones a worker leaves; only the engine is a stand-in (runJob's replayFn). The
// stand-in engine takes the engine's contract: before each step it stops if
// performance.now() has reached job.stopAt, it tells job.onBuild when a build
// starts and ends, and it hands job.onSpend each spend with its checks.
// job.script is a list of steps, each one spend:
//   { build: ms, checks }               a build blocking the process for ms
//   { buildUntilDeadline: ms, checks }  a build ending ms after the limit
//   { idleUntilDeadline: ms, checks }   a short build, then a wait that does
//                                       not block, ending ms after the limit
// job.dieAfter: [n, spends]: on attempt n the process exits after `spends`
// spends (job.counter counts the attempts across workers).

import { appendFileSync, readFileSync } from 'node:fs';
import { runJob } from '../../src/replay/run.mjs';

process.on('disconnect', () => process.exit(0));

const method = { name: 'm', version: 'v1', deterministic: true };
const block = (until) => {
  while (performance.now() < until) {
    // a synchronous build
  }
};

async function fakeReplay(_T, _params, _source, job) {
  const out = { spends: [], bursts: [], summary: null };
  const kept = [];
  for (const [k, step] of job.script.entries()) {
    if (job.stopAt !== undefined && performance.now() >= job.stopAt) {
      out.stopped = { spends: out.spends.length, last: out.spends.length ? { intent: out.spends.at(-1).intent, t: out.spends.at(-1).t } : null };
      out.validity = kept.length ? kept.reduce((a, c) => (c ? sum(a, c) : a), null) : null;
      return out;
    }
    job.onBuild(true);
    if (step.buildUntilDeadline !== undefined) block(job.stopAt + step.buildUntilDeadline);
    else block(performance.now() + (step.build ?? 50));
    job.onBuild(false);
    if (step.idleUntilDeadline !== undefined) await new Promise((r) => setTimeout(r, Math.max(0, job.stopAt + step.idleUntilDeadline - performance.now())));
    const spend = { intent: k, type: 'T1', t: 10 * (k + 1), burst: null, outcome: 'built', fee: 170000n, ms: 1 };
    out.spends.push(spend);
    kept.push(step.checks || null);
    job.onSpend(spend, step.checks || null);
    if (job.dieAfter && job.attemptNo === job.dieAfter[0] && out.spends.length === job.dieAfter[1]) process.exit(3);
  }
  out.summary = { counts: { intents: job.script.length }, ms: 3 };
  return out;
}

const sum = (a, b) => {
  if (!a) return { ...b };
  const t = { ...a, controls: { ...a.controls }, notApplicable: { ...a.notApplicable } };
  for (const k of ['txs', 'cslRead', 'cslOutputBytes', 'cslReencoded', 'failed']) t[k] += b[k];
  for (const k of Object.keys(t.controls)) t.controls[k] += b.controls[k];
  if (b.failures) t.failures = [...(a.failures || []), ...b.failures];
  return t;
};

process.on('message', async ({ id, job, stopAfterMs, attempt, limitMs }) => {
  const received = performance.now();
  let attemptNo = attempt;
  if (job.counter) {
    appendFileSync(job.counter, 'x\n');
    attemptNo = readFileSync(job.counter, 'utf8').trim().split('\n').length;
  }
  process.send({ id, event: 'info', info: { methodVersion: method.version } });
  process.send({ id, event: 'building', on: false });
  const stopAt = stopAfterMs === undefined ? undefined : received + stopAfterMs;
  const result = await runJob(null, { params: {} }, { ...job, attemptNo }, method, { stopAt, received, attempt, limitMs, onBuild: (on) => process.send({ id, event: 'building', on }), replayFn: fakeReplay });
  process.send({ id, event: 'done', result, memory: { rss: process.memoryUsage().rss } });
});
process.send({ event: 'ready' });
