// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The CardanoWall reference CLI (github.com/cardanowall/label-309-cli, tag
// v0.12.0, commit 5400a64), an independent Rust implementation used as a
// second verifier. Found on PATH or through RESEARCH_FREEZE_CARDANOWALL. The
// binary must be the one in the release's x86_64-unknown-linux-musl archive,
// identified by its SHA-256 as well as by the version it reports.
//
// The CLI reads settings from its environment (CARDANOWALL_CONFIRMATION_DEPTH_
// THRESHOLD, CARDANOWALL_CARDANO_GATEWAY, CARDANOWALL_DENY_HOSTS_REPLACE,
// CARDANOWALL_SEED and others) and from ~/.cardanowall/config.toml, each of
// which changes what `verify` checks. It therefore runs with a minimal
// environment: PATH, HOME set to an empty directory, and
// CARDANOWALL_CONFIG_PATH pointing at an empty file in it. `verify` is also
// given its profile and threshold explicitly.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserError } from './util.mjs';

export const CLI_VERSION = '0.12.0';
export const CLI_COMMIT = '5400a64';
// SHA-256 of `cardanowall` in cardanowall-v0.12.0-x86_64-unknown-linux-musl.tar.gz
// of the v0.12.0 release (the archive matches the release's SHA256SUMS and
// its build attestation for cardanowall/label-309-cli).
export const CLI_SHA256 = 'ac43f67ee3ef4372836e358613f255a61f7997ef9021972da41b74b767efcc2c';

// The default profile and the CIP-190 recommended confirmation threshold,
// passed explicitly to every `verify`.
export const VERIFY_FLAGS = Object.freeze(['--profile', 'signed', '--threshold', '15']);

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

let isolatedHome = null;

// An empty HOME, created once per process and removed when it exits, with an
// empty config.toml for CARDANOWALL_CONFIG_PATH.
function emptyHome() {
  if (isolatedHome && fs.existsSync(isolatedHome)) return isolatedHome;
  isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'research-freeze-cardanowall-'));
  fs.chmodSync(isolatedHome, 0o700);
  fs.writeFileSync(path.join(isolatedHome, 'config.toml'), '', { mode: 0o600 });
  const dir = isolatedHome;
  process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return isolatedHome;
}

// The whole environment the CLI sees.
export function cliEnv() {
  const home = emptyHome();
  return { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, CARDANOWALL_CONFIG_PATH: path.join(home, 'config.toml') };
}

export function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export class Cardanowall {
  constructor(bin, { sha256 = CLI_SHA256 } = {}) {
    this.bin = bin;
    const digest = fileSha256(bin);
    if (digest !== sha256) {
      throw new UserError(`refusing ${bin}: its SHA-256 is ${digest}, not the ${sha256} of cardanowall ${CLI_VERSION} from the release archive`);
    }
    const v = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 30000, env: cliEnv() });
    const out = (v.stdout || '').trim();
    const m = /^cardanowall (\S+) \(git ([0-9a-f]+)/.exec(out);
    if (v.status !== 0 || !m || m[1] !== CLI_VERSION || !m[2].startsWith(CLI_COMMIT)) {
      throw new UserError(`refusing ${bin}: it reports "${out}", this tool requires cardanowall ${CLI_VERSION} (git ${CLI_COMMIT})`);
    }
    this.version = out;
    this.sha256 = digest;
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
    const r = spawnSync(this.bin, ['--no-color', ...args], { encoding: 'utf8', input, timeout, maxBuffer: 64 * 1024 * 1024, env: cliEnv() });
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
