// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Secrets live outside the repository. The directory is created with mode 0700
// and every file with mode 0600.
export function homeDir() {
  if (process.env.PREPROD_SEEDER_HOME) return path.resolve(process.env.PREPROD_SEEDER_HOME);
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'unfrackit-preprod-seeder');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

export function ensureHome() {
  const home = homeDir();
  ensureDir(home);
  ensureDir(path.join(home, 'shapes'));
  ensureDir(path.join(home, 'journal'));
  return home;
}

const mnemonicPath = (who) =>
  who === 'funder' ? path.join(homeDir(), 'funder.mnemonic') : path.join(homeDir(), 'shapes', `${who}.mnemonic`);
const journalPath = (shape) => path.join(homeDir(), 'journal', `${shape}.json`);

export function hasMnemonic(who) {
  return fs.existsSync(mnemonicPath(who));
}

export function readMnemonic(who) {
  const p = mnemonicPath(who);
  if (!fs.existsSync(p)) {
    throw new Error(who === 'funder' ? 'no funder wallet; run "init" first' : `no wallet for shape ${who} yet; "seed ${who}" creates it`);
  }
  return fs.readFileSync(p, 'utf8').trim();
}

// Never overwrites: a mnemonic that exists is the only copy of that wallet.
export function writeMnemonic(who, mnemonic) {
  ensureHome();
  fs.writeFileSync(mnemonicPath(who), mnemonic + '\n', { flag: 'wx', mode: 0o600 });
}

export function readJournal(shape) {
  const p = journalPath(shape);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

export function writeJournal(shape, data) {
  ensureHome();
  fs.writeFileSync(journalPath(shape), JSON.stringify(data), { mode: 0o600 });
}

export function removeJournal(shape) {
  fs.rmSync(journalPath(shape), { force: true });
}
