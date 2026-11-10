// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A stand-in job for the queue runner's tests. Arguments: a label, then
// behaviors run in order: ok, fail, sleep:<ms>, grandchild[:ignore-term],
// ignore-term, ready, env:<NAME>. It appends the label to $QUEUE_TEST_LOG, one
// line per start. ignore-term appends the time of each SIGTERM it ignores to
// $QUEUE_TEST_TERM; grandchild:ignore-term returns once the grandchild has its
// own handler in place; ready writes the time to $QUEUE_TEST_READY, so that a
// test can tell a SIGTERM that came before the job's handlers from one after.

import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const [label, ...behaviors] = process.argv.slice(2);
if (process.env.QUEUE_TEST_LOG) appendFileSync(process.env.QUEUE_TEST_LOG, `${label}\n`);
let exit = 0;
for (const b of behaviors) {
  const [kind, arg] = b.split(':');
  if (kind === 'fail') exit = 1;
  else if (kind === 'sleep') await new Promise((r) => setTimeout(r, Number(arg)));
  else if (kind === 'ignore-term') {
    process.on('SIGTERM', () => {
      if (process.env.QUEUE_TEST_TERM) appendFileSync(process.env.QUEUE_TEST_TERM, `${Date.now()}\n`);
    });
  } else if (kind === 'ready') writeFileSync(process.env.QUEUE_TEST_READY, `${Date.now()}\n`);
  else if (kind === 'env') appendFileSync(process.env.QUEUE_TEST_ENV_OUT, `${arg}=${process.env[arg] ?? '<unset>'}\n`);
  else if (kind === 'grandchild') {
    const ignoring = arg === 'ignore-term';
    const code = ignoring ? "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)" : 'setInterval(()=>{},1000)';
    const gc = spawn(process.execPath, ['-e', code], { stdio: ['ignore', ignoring ? 'pipe' : 'ignore', 'ignore'] });
    writeFileSync(process.env.QUEUE_TEST_PIDS, `${process.pid} ${gc.pid}\n`);
    if (ignoring) await new Promise((r) => gc.stdout.once('data', r));
  }
}
process.exit(exit);
