// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The CardanoWall reference CLI (github.com/cardanowall/label-309-cli, tag
// v0.12.0, commit 5400a64), an independent Rust implementation used as a
// second verifier. Found on PATH or through RESEARCH_FREEZE_CARDANOWALL; any
// version other than 0.12.0 is refused.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { UserError } from './util.mjs';

export const CLI_VERSION = '0.12.0';
export const CLI_COMMIT = '5400a64';

export function findCli(env = process.env) {
  const candidates = [];
  if (env.RESEARCH_FREEZE_CARDANOWALL) candidates.push(env.RESEARCH_FREEZE_CARDANOWALL);
  for (const dir of (env.PATH || '').split(path.delimiter)) if (dir) candidates.push(path.join(dir, 'cardanowall'));
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      // keep looking
    }
  }
  return null;
}

export class Cardanowall {
  constructor(bin) {
    this.bin = bin;
    const v = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 30000 });
    const out = (v.stdout || '').trim();
    const m = /^cardanowall (\S+) \(git ([0-9a-f]+)/.exec(out);
    if (v.status !== 0 || !m || m[1] !== CLI_VERSION || !m[2].startsWith(CLI_COMMIT)) {
      throw new UserError(`refusing ${bin}: it reports "${out}", this tool requires cardanowall ${CLI_VERSION} (git ${CLI_COMMIT})`);
    }
    this.version = out;
  }

  static require(env = process.env) {
    const bin = findCli(env);
    if (!bin) throw new UserError(`the cardanowall CLI ${CLI_VERSION} is required: put it on PATH or set RESEARCH_FREEZE_CARDANOWALL`);
    return new Cardanowall(bin);
  }

  static optional(env = process.env) {
    const bin = findCli(env);
    return bin ? new Cardanowall(bin) : null;
  }

  run(args, { input, timeout = 300000 } = {}) {
    const r = spawnSync(this.bin, ['--no-color', ...args], { encoding: 'utf8', input, timeout, maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw r.error;
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  json(args, opts) {
    const r = this.run(args, opts);
    let parsed = null;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      // left null; the caller reports the raw output
    }
    return { ...r, json: parsed };
  }
}
