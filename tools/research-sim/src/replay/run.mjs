// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A run: a plan's jobs over a set of wallets through the worker pool, the
// engine's output written as records (out/records.mjs).
//
// A replay run is a stage (out/stage.mjs) that writes each wallet's records
// whole as a segment of its own. For each wallet the stage has not done: its
// source is read once in the parent to decide whether the window holds a
// script interaction (which expands the collateral rules), and the jobs run
// in the pool. Each job's worker builds the job's records and writes them to
// the job's spool (out/spool.mjs); the parent commits the spools in job order
// to the wallet's segment as the jobs complete, writes the wallet's trigger
// records after them, and has the stage compress the segment and mark it
// done once every job of the wallet has completed. So a wallet's records are
// those of one thread writing every job in turn, whatever order the jobs end
// in, and the parent holds no wallet's records: of a job it keeps only
// whether it was refused and its validity summary. Several wallets are open at once (runReplays),
// so a wallet's slowest job does not leave the other workers idle, and
// wallets are done in any order. A job a machine error ends runs again
// (replay/pool.mjs), rewriting its spool, and only the attempt that completes
// is recorded. A job that reaches the pool's time limit is stopped, never run
// again: the spends it completed stay in its spool, which the worker writes as
// the job goes, and a wallet-arm record closes it with the `stopped` field
// (stoppedArm); the wallet is done like any other. An engine refusal (a wallet the rules do not settle, such as
// one with no change address) is recorded as refused; a stop point or a
// failed job stops the run and drops the segments of the wallets with a job
// not ended, so only whole wallets are marked done, and the run resumes at
// the wallets not done. When every wallet is done the stage joins the
// segments in wallet order.
//
import { rmSync } from 'node:fs';
import { record } from '../out/records.mjs';
import { spoolPaths, SpoolStream, repairSpool, Frontier } from '../out/spool.mjs';
import { loadSource } from './source.mjs';
import { replay } from './engine.mjs';
import { expandJobs } from '../arms/plan.mjs';
import { sumValidity } from '../kit/validity.mjs';
import { walletMemory } from './pool.mjs';

// The records of one replay job's result x, in the order a run writes them:
// its refusal, or its spends, bursts and wallet-arm record. The
// wallet-arm's ms is the attempt's time, which the parent measures: it is
// written here as 0, in the position the time takes, and the parent sets it
// in the timing row (spoolJob holds that row back). skipSpends: the spends
// are already written (a worker writes them as the job goes). A job stopped
// for time (x.stopped) has its spends and the wallet-arm record of
// stoppedArm; its bursts are not written, so that a stopped job's records do
// not depend on whether it was stopped at a spend boundary or killed.
export function* jobRecords(x, job, { skipSpends = false, stop = null } = {}) {
  const { key, hypotheses, opts = {} } = job;
  const { absorb } = opts;
  if (x.refused) {
    yield record('refused', key, { reason: x.refused });
    return;
  }
  if (!skipSpends) for (const s of x.spends) yield record('spend', key, s);
  if (x.stopped) {
    yield stoppedArm(job, { methodVersion: x.method.version, ...x.stopped, ...stop });
    return;
  }
  for (const b of x.bursts) yield record('burst', key, b);
  yield record('wallet-arm', key, { hypotheses, methodVersion: x.method.version, ...(absorb !== undefined ? { absorb } : {}), ...x.summary, ms: 0 });
}

// The `stopped` field's values for `at`: the job stopped before an intent
// (the spend boundary), was killed with a method's build running, or was
// killed between spends when it did not stop in time.
export const STOPPED_AT = Object.freeze({ boundary: 'spend boundary', build: 'running build', unresponsive: 'killed between spends' });

// The wallet-arm record of a job stopped at the replay's time limit. Beside
// the key's fields it holds what a finished job's holds of the job (its
// hypotheses, the method's version, absorb, capped) and no summary; `stopped`
// says what became of the job: reason ('excessive time'); attempt (which run
// of the job, from 1, a rerun after a machine error replaying the job from its
// first spend); limitMs, the limit in force; elapsedMs, the attempt's wall
// time when it stopped; at (STOPPED_AT); spends, the spend records kept, of
// planned, the window's intents (job.planned); last, the last kept spend's
// intent and t (null when none); machine, the stage's label (job.machine).
// The spends are the records already in the job's spool.
export function stoppedArm(job, { methodVersion, spends, last, at, elapsedMs, attempt, limitMs }) {
  const { absorb } = job.opts || {};
  return record('wallet-arm', job.key, {
    hypotheses: job.hypotheses,
    methodVersion: methodVersion ?? null,
    ...(absorb !== undefined ? { absorb } : {}),
    capped: !!job.capped,
    stopped: { reason: 'excessive time', attempt, limitMs, elapsedMs: Math.round(elapsedMs), at, spends, planned: job.planned, last: last ?? null, machine: job.machine ?? null },
    ms: 0
  });
}

// What a worker answers for a replay job (replay/worker.mjs): the job's
// records written to its spool (job.spool), with the wallet-arm's timing row
// held back, and what the parent reads besides: whether the job was refused,
// its validity summary, and for a job stopped for time, its `stopped` field.
// stream: the job's spool when the worker has been writing it as the job goes
// (its spends written), in which case it is closed here; stop: the values the
// worker adds to a stopped job's record (attempt, limitMs, elapsedMs, at).
export function spoolJob(x, job, { stream = null, stop = null } = {}) {
  const hold = (rec) => rec.kind === 'wallet-arm';
  const s = stream || new SpoolStream(job.spool, { hold });
  let stopped = null;
  try {
    for (const rec of jobRecords(x, job, { skipSpends: !!stream, stop })) {
      if (rec.kind === 'wallet-arm' && rec.stopped) stopped = rec.stopped;
      s.add(rec);
    }
  } finally {
    s.close();
  }
  const spooled = s.close();
  if (x.refused) return { refused: true, spooled };
  if (stopped) return { refused: false, validity: x.validity || null, spooled, stopped };
  return { refused: false, validity: x.summary.validity || null, spooled };
}

// The job's whole run in a worker: its spends written to its spool as they
// are made; stopAt (Date.now()): the time the job stops at a spend boundary,
// absent for none; attempt, limitMs: which attempt this is and the limit,
// which the stopped record names; onBuild: told when a build starts and ends.
// Returns spoolJob's answer.
export async function runJob(T, source, job, method, { stopAt, attempt = 1, limitMs = null, onBuild }) {
  const started = performance.now();
  const stream = new SpoolStream(job.spool, { hold: (rec) => rec.kind === 'wallet-arm', eager: true });
  try {
    const x = await replay(T, source.params, source, { ...job, method, ...(stopAt !== undefined ? { stopAt } : {}), onBuild, onSpend: (s) => stream.add(record('spend', job.key, s)) });
    x.method = { name: method.name, version: method.version, deterministic: method.deterministic };
    return spoolJob(x, job, { stream, stop: { at: STOPPED_AT.boundary, elapsedMs: performance.now() - started, attempt, limitMs } });
  } finally {
    stream.close();
  }
}

// A job the pool killed at its time limit, finished in the parent: its spool
// is made whole (repairSpool) and closed with the wallet-arm record of
// stoppedArm. killed: { at, attempt, limitMs, info: { methodVersion } }, ms:
// the attempt's time. Returns what spoolJob does for a stopped job.
export function spoolKilled(job, killed, ms) {
  const kept = repairSpool(job.spool);
  const s = new SpoolStream(job.spool, { hold: (rec) => rec.kind === 'wallet-arm', resume: kept });
  const at = killed.at === 'build' ? STOPPED_AT.build : STOPPED_AT.unresponsive;
  const rec = stoppedArm(job, { methodVersion: killed.info && killed.info.methodVersion, spends: kept.spends, last: kept.last, at, elapsedMs: ms, attempt: killed.attempt, limitMs: killed.limitMs });
  try {
    s.add(rec);
  } finally {
    s.close();
  }
  return { refused: false, validity: null, spooled: s.close(), stopped: rec.stopped };
}

// The options a replay job gives its method (checked by the engine): the seed
// is the repetition, in every arm, so that arms of one repetition share it;
// the absorption setting, where the job has one (UnFrack.It's rule), is
// opts.absorb, which the wallet-arm record shows.
export function replayJobOpts(j) {
  return { seed: j.repetition, changePolicy: j.change, collateralRule: j.collateral === 'none-needed' ? 'ledger' : j.collateral, ...(j.absorb !== undefined ? { absorb: j.absorb } : {}) };
}

const needsCollateral = (source) => source.events.some((e) => e.kind === 'intent' && e.intent.collateral.required);

// The cap on a replay run's open wallets at a worker count: twice the
// workers. Each wallet still running holds at least one worker, so no more
// than the worker count of wallets can be held open by their slowest jobs,
// and the rest of the cap keeps wallets whose jobs are queued or that are
// closing. An open wallet holds its spool on disk and its segment's two
// files open.
export const openWalletCap = (workers) => 2 * workers;

// The most jobs a replay run has in the pool at once at a worker count:
// twice the workers, so that while a job waits in the pool for memory the
// pool's admission has later jobs that may start (replay/pool.mjs).
export const poolJobCap = (workers) => 2 * workers;

// wallets: [{ spec }], in the stage's wallet order; plan: the window's
// entries; roles: role -> method name (a test plan's entries name role
// 'test'); out: the stage (out/stage.mjs openStage) over the same wallets;
// watchdogMs: the replay's time limit (the pool's default when absent); maxOpen:
// the most wallets open at once (openWalletCap of the pool's size when
// absent). A wallet the stage has done is skipped, and so is one outside the
// invocation's share of the wallets (out/stage.mjs runs). The jobs' spools
// are under out.dir/spool/<wallet index>/, removed when the run ends.
// Returns the stage's totals, every done wallet's summed: { wallets, jobs,
// refused } and, with validity, their validity counts; and `stopped`, the jobs
// stopped for time, only when a job was (a wallet's totals name it only then).
//
// Several wallets run at once. The run keeps one queue of the jobs not yet
// handed to the pool, in (wallet index, job index) order, and hands the pool
// a job whenever fewer than poolJobCap(pool.size) of its jobs are in the
// pool; the pool starts them in that order but may start one ahead of
// another that waits for memory. It opens the next wallet it runs (in
// index order) whenever fewer than twice pool.size jobs are queued and fewer
// than maxOpen wallets are open, so the workers are not left idle behind a
// wallet's slowest job. A wallet closes when its last job ends: its trigger
// records after its jobs', then the stage compresses its segment and writes
// its done file (out/stage.mjs complete), off the main thread's path, one
// wallet at a time, while the other wallets' jobs run. Wallets close in any
// order; the stage joins their segments in index order at its end. A failed
// job, or a close that fails, stops the run: no job is handed to the pool
// after it, the wallets already closing finish closing, and every open wallet
// with a job not ended is dropped, without a done file, so that a resume runs
// it again.
export async function runReplays(T, pool, { wallets, plan, roles, out, watchdogMs, settleEvery = 25, methodOptions = {}, collateralRules, validity = false, maxOpen = openWalletCap(pool.size) }) {
  if (wallets.length !== out.n) throw new Error(`the stage lists ${out.n} wallets, not the ${wallets.length} given`);
  if (!Number.isSafeInteger(maxOpen) || maxOpen < 1) throw new Error('the cap on open wallets is a positive whole number');
  const workers = pool.size;
  const todo = wallets.flatMap((_w, wi) => (out.runs(wi) ? [wi] : []));
  const inPool = poolJobCap(workers);
  if (todo.length) out.note({ event: 'window', workers, queue: 2 * workers, inPool, maxOpen, wallets: todo.length });
  // Jobs not handed to the pool, in (wallet, job) order: wallets open in
  // index order, each appending its jobs in job order.
  const queue = [];
  // The open wallets: those with a job not ended, and those closing.
  const open = new Set();
  let nextWallet = 0;
  // The jobs handed to the pool and not ended.
  let running = 0;
  let failure = null;
  let closing = Promise.resolve();
  let wake = null;
  const signal = () => {
    const w = wake;
    wake = null;
    if (w) w();
  };
  // A wallet dropped by a failure: what it committed is not marked done.
  const drop = (st) => {
    st.dropped = true;
    st.frontier.stop();
    st.seg.close();
    open.delete(st);
  };
  const fail = (e) => {
    if (!failure) {
      failure = e;
      queue.length = 0;
      for (const st of [...open]) if (!st.closing) drop(st);
    }
    signal();
  };

  const openWallet = (wi) => {
    const w = wallets[wi];
    const start = new Date();
    const source = loadSource(T, w.spec);
    if (source.split === 'confirmation') out.note({ event: 'confirmation-split wallet run', wallet: source.wallet, analysisFreezeTx: source.analysisFreezeTx });
    const jobs = expandJobs(plan, { roles, needsCollateral: needsCollateral(source), ...(collateralRules ? { collateralRules } : {}) });
    // What the pool's memory estimate reads of the wallet (pool.mjs).
    const memory = walletMemory(source);
    // What a stopped job's record says of the wallet's window: its intents.
    const planned = source.events.filter((e) => e.kind === 'intent').length;
    const seg = out.segment(wi);
    const dir = seg.dir;
    const st = {
      index: wi,
      wallet: source.wallet,
      start,
      seg,
      totals: { jobs: 0, refused: 0 },
      validities: [],
      frontier: new Frontier(jobs.length, (_i, spooled) => seg.commit(spooled)),
      left: jobs.length,
      closing: false,
      dropped: false
    };
    open.add(st);
    for (const [i, j] of jobs.entries()) {
      const key = { wallet: source.wallet, window: source.window, arm: j.arm, variant: j.variant, method: j.method, change: j.change, collateral: j.collateral, repetition: j.repetition };
      const job = {
        source: w.spec,
        memory,
        arm: j.arm,
        variant: j.variant,
        repetition: j.repetition,
        method: { name: j.method, options: methodOptions[j.method] || {} },
        opts: replayJobOpts(j),
        settleEvery,
        validity,
        key,
        hypotheses: j.hypotheses,
        spool: spoolPaths(dir, i),
        planned,
        capped: !!source.capped,
        machine: out.label ?? null
      };
      const at = { wallet: source.wallet, arm: j.arm, variant: j.variant, method: j.method, change: j.change, collateral: j.collateral, repetition: j.repetition };
      queue.push({ st, i, j, key, job, at });
    }
    if (!jobs.length) close(st);
  };

  // A job's end: its result kept, its spool committed in job order, and the
  // wallet closed after its last job.
  const ended = (q, r) => {
    const { st, i, j, key } = q;
    if (st.dropped) return;
    st.totals.jobs++;
    if (!r.ok) {
      out.note({ event: 'replay error', wallet: st.wallet, arm: j.arm, variant: j.variant, method: j.method, repetition: j.repetition, error: r.error, stop: r.stop });
      if (r.stop) throw new Error(`stop point: ${r.error}`);
      throw new Error(`replay failed: ${r.error}`);
    }
    // A job the pool killed at its time limit has no result: its spool is
    // finished here.
    const x = r.killed ? spoolKilled(q.job, r.killed, r.ms) : r.result;
    if (x.stopped) st.totals.stopped = (st.totals.stopped || 0) + 1;
    if (x.refused) st.totals.refused++;
    else {
      if (x.validity) {
        st.validities.push(x.validity);
        noteValidity(out, key, x.validity);
      }
    }
    if (x.spooled.held) x.spooled.held.times.ms = r.ms;
    st.frontier.done(i, x.spooled);
    if (--st.left === 0) close(st);
  };

  const dispatch = () => {
    while (!failure && running < inPool && queue.length) {
      const q = queue.shift();
      running++;
      pool.replay(q.job, { watchdogMs, note: (e) => out.note({ ...e, ...q.at }) }).then((r) => {
        running--;
        try {
          ended(q, r);
        } catch (e) {
          fail(e);
        }
        signal();
      }, (e) => {
        running--;
        if (!q.st.dropped) fail(e);
        signal();
      });
    }
  };

  // A wallet whose jobs have all ended: the stage completes its segment,
  // after the closes before it.
  const close = (st) => {
    st.closing = true;
    let ready = false;
    try {
      if (!st.frontier.complete) throw new Error('a job of the wallet was not committed');
      if (validity) st.totals.validity = sumValidity(st.validities);
      st.validities = null;
      ready = true;
    } catch (e) {
      drop(st);
      fail(e);
    }
    if (!ready) return;
    closing = closing.then(async () => {
      try {
        await out.complete(st.index, st.seg, { wallet: st.wallet, totals: st.totals, start: st.start });
      } catch (e) {
        st.dropped = true;
        fail(e);
      }
      open.delete(st);
      signal();
    });
  };

  try {
    for (;;) {
      if (!failure) {
        try {
          dispatch();
          while (!failure && nextWallet < todo.length && open.size < maxOpen && queue.length < 2 * workers) {
            openWallet(todo[nextWallet++]);
            dispatch();
          }
        } catch (e) {
          fail(e);
        }
      }
      if (failure) break;
      if (nextWallet === todo.length && open.size === 0) break;
      await new Promise((resolve) => {
        wake = resolve;
      });
    }
    await closing;
    if (failure) throw failure;
  } finally {
    // After a failure the pool may still be running jobs of dropped wallets,
    // writing to their spools; the resume removes what is left.
    try {
      rmSync(out.spool, { recursive: true, force: true });
    } catch (e) {
      if (!failure) throw e;
    }
  }
  return out.finish();
}

// One log note per failure of a validity summary, naming the record's key and
// the transaction's position.
export function noteValidity(out, key, v) {
  for (const f of v.failures || []) out.note({ event: 'validity failure', ...key, ...f });
  if (v.failed > (v.failures || []).length) out.note({ event: 'validity failures not detailed', ...key, count: v.failed - (v.failures || []).length });
}
