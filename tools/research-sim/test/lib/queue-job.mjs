// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A stand-in job for the queue runner's tests. Arguments: a label, then
// behaviors run in order: ok, fail, sleep:<ms>, grandchild[:ignore-term],
// ignore-term, env:<NAME>. It appends the label to $QUEUE_TEST_LOG, one line
// per start.

import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const [label, ...behaviors] = process.argv.slice(2);
if (process.env.QUEUE_TEST_LOG) appendFileSync(process.env.QUEUE_TEST_LOG, `${label}\n`);
let exit = 0;
for (const b of behaviors) {
  const [kind, arg] = b.split(':');
  if (kind === 'fail') exit = 1;
  else if (kind === 'sleep') await new Promise((r) => setTimeout(r, Number(arg)));
  else if (kind === 'ignore-term') process.on('SIGTERM', () => {});
  else if (kind === 'env') appendFileSync(process.env.QUEUE_TEST_ENV_OUT, `${arg}=${process.env[arg] ?? '<unset>'}\n`);
  else if (kind === 'grandchild') {
    const code = arg === 'ignore-term' ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)" : 'setInterval(()=>{},1000)';
    const gc = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
    writeFileSync(process.env.QUEUE_TEST_PIDS, `${process.pid} ${gc.pid}\n`);
  }
}
process.exit(exit);
