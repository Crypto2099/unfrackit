// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The tool's home: identities, journals, run directories and tokens, kept
// outside every checkout. Directories are 0700 and files 0600; a secret is
// written with exclusive create and never overwritten.
//
//   identities/<name>/signing-mnemonic   identities/<name>/payment-mnemonic
//   identities/<name>/public.json        journal/<network>.json
//   runs/<network>/<tx hash>/            rehearsals/<id>/
//   secrets/                             tmp/

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserError } from './util.mjs';

export const IDENTITY_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const SUBDIRS = ['identities', 'journal', 'runs', 'rehearsals', 'secrets', 'tmp'];

export function homeDir(env = process.env) {
  if (env.RESEARCH_FREEZE_HOME) return path.resolve(env.RESEARCH_FREEZE_HOME);
  const base = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'unfrackit-research-freeze');
}

// The nearest ancestor (or the path itself) that contains a `.git` entry, a
// directory or a file (worktrees and submodules use a file), else null.
export function enclosingGitTree(p) {
  let cur = path.resolve(p);
  while (!fs.existsSync(cur)) cur = path.dirname(cur);
  cur = fs.realpathSync(cur);
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

function modeOf(p) {
  return fs.statSync(p).mode & 0o777;
}

function checkMode(p, max) {
  const mode = modeOf(p);
  if (mode & ~max & 0o777) {
    throw new UserError(`refusing to run: ${p} has mode ${mode.toString(8).padStart(3, '0')}, wider than ${max.toString(8).padStart(3, '0')}`);
  }
}

export class Store {
  constructor(home = homeDir()) {
    this.home = home;
  }

  // Refuse a home inside any git working tree, and any directory or file in
  // it with wider permissions than 0700 / 0600.
  assertSafe() {
    const tree = enclosingGitTree(this.home);
    if (tree) throw new UserError(`refusing to run: the home ${this.home} is inside the git working tree ${tree}; secrets must live outside every checkout`);
    if (!fs.existsSync(this.home)) return;
    const walk = (dir) => {
      checkMode(dir, 0o700);
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isSymbolicLink()) throw new UserError(`refusing to run: ${p} is a symbolic link`);
        if (e.isDirectory()) walk(p);
        else checkMode(p, 0o600);
      }
    };
    walk(this.home);
  }

  ensure() {
    this.assertSafe();
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.home, 0o700);
    for (const d of SUBDIRS) {
      const p = path.join(this.home, d);
      fs.mkdirSync(p, { recursive: true, mode: 0o700 });
      fs.chmodSync(p, 0o700);
    }
    this.assertSafe();
    return this.home;
  }

  path(...parts) {
    return path.join(this.home, ...parts);
  }

  mkdir(...parts) {
    const p = this.path(...parts);
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
    fs.chmodSync(p, 0o700);
    return p;
  }

  // ---- identities ----

  identityDir(name) {
    if (!IDENTITY_NAME_RE.test(name)) throw new UserError(`invalid identity name "${name}" (lowercase letters, digits and hyphens)`);
    return this.path('identities', name);
  }

  hasIdentity(name) {
    return fs.existsSync(this.identityDir(name));
  }

  // Exclusive creation: the identity directory must not exist, and every file
  // is created with `wx`.
  createIdentity(name, { signingMnemonic, paymentMnemonic, publicJson }) {
    this.ensure();
    const dir = this.identityDir(name);
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if (e.code === 'EEXIST') throw new UserError(`identity "${name}" already exists in ${this.home}; refusing to overwrite it`);
      throw e;
    }
    fs.chmodSync(dir, 0o700);
    fs.writeFileSync(path.join(dir, 'signing-mnemonic'), signingMnemonic + '\n', { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'payment-mnemonic'), paymentMnemonic + '\n', { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'public.json'), JSON.stringify(publicJson, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }

  readPublic(name) {
    this.assertSafe();
    const p = path.join(this.identityDir(name), 'public.json');
    if (!fs.existsSync(p)) throw new UserError(`no identity "${name}" in ${this.home}; run "init --identity ${name}"`);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  // Read only where a command needs the secret: signing, the payment witness,
  // and `backup`.
  readMnemonics(name) {
    this.assertSafe();
    const dir = this.identityDir(name);
    const read = (f) => {
      const p = path.join(dir, f);
      if (!fs.existsSync(p)) throw new UserError(`identity "${name}" is missing ${f}`);
      checkMode(p, 0o600);
      return fs.readFileSync(p, 'utf8').trim();
    };
    return { signingMnemonic: read('signing-mnemonic'), paymentMnemonic: read('payment-mnemonic') };
  }

  // ---- journal ----

  journalPath(network) {
    return this.path('journal', `${network}.json`);
  }

  readJournal(network) {
    const p = this.journalPath(network);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { network, current: null, history: [] };
  }

  writeJournal(network, journal) {
    this.ensure();
    const p = this.journalPath(network);
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(journal, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, p);
  }

  // ---- run directories ----

  runDir(network, txHash) {
    return this.path('runs', network, txHash);
  }

  // Write every file to a fresh directory, then rename it into place, so a run
  // directory exists only when all of it was written.
  writeRun(network, txHash, files) {
    this.ensure();
    this.mkdir('runs', network);
    const final = this.runDir(network, txHash);
    if (fs.existsSync(final)) throw new UserError(`a run directory for ${txHash} already exists: ${final}`);
    const tmp = `${final}.partial-${process.pid}`;
    fs.mkdirSync(tmp, { mode: 0o700 });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(tmp, name), content, { flag: 'wx', mode: 0o600 });
    }
    fs.renameSync(tmp, final);
    return final;
  }

  updateRunFile(runDir, name, content) {
    const p = path.join(runDir, name);
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, p);
  }

  knownTxHashes(network) {
    const dir = this.path('runs', network);
    const out = new Set();
    if (fs.existsSync(dir)) {
      for (const e of fs.readdirSync(dir)) if (/^[0-9a-f]{64}$/.test(e)) out.add(e);
    }
    const j = this.readJournal(network);
    if (j.current) out.add(j.current.txHash);
    for (const h of j.history || []) out.add(h.txHash);
    return out;
  }

  // ---- temporary secrets ----

  // A 0600 file inside the home's tmp directory, removed by the caller in a
  // `finally`. Used only to hand the rehearsal seed to the reference CLI.
  writeTempSecret(contents) {
    this.ensure();
    const p = this.path('tmp', `secret-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.writeFileSync(p, contents, { flag: 'wx', mode: 0o600 });
    return p;
  }

  readSecretToken(name, envValue) {
    if (envValue) return envValue.trim();
    const p = this.path('secrets', name);
    if (!fs.existsSync(p)) return null;
    checkMode(p, 0o600);
    return fs.readFileSync(p, 'utf8').trim();
  }
}
