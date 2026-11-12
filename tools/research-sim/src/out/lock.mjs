// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A run directory's lock: a file `lock` holding the process ID of the
// invocation that writes the directory. A second invocation is refused while
// that process lives; the lock of a process that has gone (a kill) is taken
// over. The study takes one on its run directory (study/study.mjs), a
// replay stage on its own (out/stage.mjs), and merge-stage on the stage it
// merges into (out/merge.mjs).

import { openSync, writeSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// The process ID of a running process that holds dir's lock, or null; the
// lock is not taken (merge-stage reads its sources this way).
export function lockHolder(dir) {
  let pid;
  try {
    pid = Number(readFileSync(join(dir, 'lock'), 'utf8').trim());
  } catch {
    return null;
  }
  return Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && alive(pid) ? pid : null;
}

// Takes dir's lock and returns the function that releases it. what: the
// run, as the refusal names it ('study run', 'replay stage'); refuse: the
// error a refusal throws.
export function takeLock(dir, { what, refuse = (m) => new Error(m) }) {
  const path = join(dir, 'lock');
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(path, 'utf8').trim() === String(process.pid)) unlinkSync(path);
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(path, 'utf8').trim());
      if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) throw refuse(`refusing: process ${pid} is running this ${what}`);
      unlinkSync(path);
    }
  }
  throw refuse(`refusing: the ${what}'s lock could not be taken`);
}
