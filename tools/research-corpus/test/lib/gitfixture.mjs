// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A git repository built in a temporary folder from git's plumbing commands
// (hash-object, mktree, commit-tree), standing in for a clone of the scam
// list's repository. Each commit is a full tree given as { path: text }, so a
// test controls every byte; commit-tree writes the commit object with fixed
// dates and no signature, and update-ref points a branch at it.

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid'
};

export function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'rc-git-'));
  const git = (args, input) => execFileSync('git', ['-C', dir, ...args], { input, env: ENV, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main']);
  // A tree object for { name: text | subtree }.
  const tree = (node) => {
    const lines = Object.entries(node)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, v]) => (typeof v === 'string' ? `100644 blob ${git(['hash-object', '-w', '--stdin'], v)}\t${name}` : `040000 tree ${tree(v)}\t${name}`));
    return git(['mktree'], lines.join('\n') + '\n');
  };
  const nest = (files) => {
    const root = {};
    for (const [path, text] of Object.entries(files)) {
      const parts = path.split('/');
      let n = root;
      for (const p of parts.slice(0, -1)) n = n[p] = n[p] || {};
      n[parts.at(-1)] = text;
    }
    return root;
  };
  let parent = null;
  let k = 0;
  const commit = (files, message = 'fixture') => {
    const date = `2026-0${1 + (k++ % 9)}-01T00:00:00Z`;
    const args = ['commit-tree', tree(nest(files)), '-m', message, ...(parent ? ['-p', parent] : [])];
    const sha = execFileSync('git', ['-C', dir, ...args], { env: { ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, encoding: 'utf8' }).trim();
    git(['update-ref', 'refs/heads/main', sha]);
    parent = sha;
    return sha;
  };
  return { dir, commit };
}
