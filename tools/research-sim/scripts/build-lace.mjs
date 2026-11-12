#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Builds Lace's transaction builder for the lace- study method from the
// wallet's source at its pinned commit (src/methods/lace-source.mjs), since no
// package publishes it:
//
//   node scripts/build-lace.mjs --clone <dir>   from a local clone that holds
//                                                the commit (a partial or
//                                                sparse clone will do)
//   node scripts/build-lace.mjs --fetch <dir>   from a fresh shallow clone
//                                                made in <dir>, which must not
//                                                exist: the pinned commit
//                                                alone, without blobs outside
//                                                the pinned paths
//
// It checks the git object hash of every pinned path at the commit, extracts
// those paths with git archive (never from a working tree), bundles them with
// the tool's pinned esbuild into OUTPUT_DIR under the tool (gitignored), the
// @cardano-sdk packages left external so that the tool's installed copies
// load, copies the repository's license beside the bundle, and writes
// BUILD_RECORD: the repository, the commit, each path's hash, the license's,
// the esbuild version and the bundle's SHA-256. Nothing else is written; the
// extracted source is removed. Exit code 0 when the build is written, 1 on any
// failure.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  LACE_REPO, LACE_COMMIT, LACE_RELEASE, LACE_SRC, LACE_PATHS, LACE_LICENSE, LACE_MANIFEST, LACE_SDK,
  OUTPUT_DIR, BUNDLE, BUILD_RECORD, ENTRY
} from '../src/methods/lace-source.mjs';

const TOOL = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const git = (dir, args, opts = {}) => execFileSync('git', ['-C', dir, ...args], { encoding: opts.encoding === null ? null : 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

function usage(msg) {
  if (msg) console.error(`build-lace: ${msg}`);
  console.error('usage: node scripts/build-lace.mjs --clone <dir> | --fetch <dir>');
  process.exit(1);
}

function parseArgs(argv) {
  if (argv.length !== 2) usage();
  const [flag, dir] = argv;
  if (flag !== '--clone' && flag !== '--fetch') usage(`unknown option ${flag}`);
  return { mode: flag.slice(2), dir: resolve(dir) };
}

// A shallow clone of the pinned commit alone, its blobs fetched only for the
// pinned paths.
function freshClone(dir) {
  if (existsSync(dir)) usage(`${dir} exists; --fetch makes a new clone`);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '--quiet']);
  git(dir, ['remote', 'add', 'origin', LACE_REPO]);
  git(dir, ['config', 'remote.origin.promisor', 'true']);
  git(dir, ['config', 'remote.origin.partialclonefilter', 'blob:none']);
  git(dir, ['fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', LACE_COMMIT]);
  return dir;
}

// Checks one path's object at the commit against its pin.
function checkObject(clone, path, type, hash) {
  let got;
  let kind;
  try {
    got = git(clone, ['rev-parse', `${LACE_COMMIT}:${path}`]).trim();
    kind = git(clone, ['cat-file', '-t', got]).trim();
  } catch (e) {
    throw new Error(`${path} at ${LACE_COMMIT}: ${String(e.stderr || e.message).trim()}`);
  }
  if (kind !== type) throw new Error(`${path} at ${LACE_COMMIT} is a ${kind}, pinned as a ${type}`);
  if (got !== hash) throw new Error(`${path} at ${LACE_COMMIT} is ${got}, pinned as ${hash}`);
  return got;
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function main() {
  const { mode, dir } = parseArgs(process.argv.slice(2));
  const clone = mode === 'fetch' ? freshClone(dir) : dir;
  try {
    git(clone, ['cat-file', '-e', `${LACE_COMMIT}^{commit}`]);
  } catch {
    throw new Error(`${clone} does not hold commit ${LACE_COMMIT}`);
  }
  const objects = {};
  for (const [path, [type, hash]] of Object.entries(LACE_PATHS)) objects[path] = { type, hash: checkObject(clone, path, type, hash) };
  checkObject(clone, LACE_LICENSE[0], LACE_LICENSE[1], LACE_LICENSE[2]);
  checkObject(clone, LACE_MANIFEST[0], LACE_MANIFEST[1], LACE_MANIFEST[2]);

  // The manifest's @cardano-sdk pins, against the tool's.
  const manifest = JSON.parse(git(clone, ['show', `${LACE_COMMIT}:${LACE_MANIFEST[0]}`]));
  for (const [pkg, v] of Object.entries(LACE_SDK)) {
    if (manifest.dependencies[pkg] !== v) throw new Error(`the manifest pins ${pkg} ${manifest.dependencies[pkg]}, the tool ${v}`);
    const installed = JSON.parse(readFileSync(join(TOOL, 'node_modules', ...pkg.split('/'), 'package.json'), 'utf8')).version;
    if (installed !== v) throw new Error(`${pkg} ${installed} is installed; the build needs ${v} (npm ci)`);
  }

  const out = join(TOOL, OUTPUT_DIR);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const staging = mkdtempSync(join(out, '.source-'));
  try {
    // The pinned paths from the commit's objects, never a working tree.
    const tar = git(clone, ['archive', '--format=tar', LACE_COMMIT, '--', ...Object.keys(LACE_PATHS)], { encoding: null });
    const x = spawnSync('tar', ['-x', '-C', staging], { input: tar });
    if (x.status !== 0) throw new Error(`tar: ${String(x.stderr).trim()}`);
    const src = join(staging, LACE_SRC);
    const entry = join(src, 'unfrackit-entry.ts');
    writeFileSync(entry, ENTRY);
    const esbuild = require('esbuild');
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'es2022',
      // Lace's compiler settings (tsconfig.base.json) that change emitted
      // code: an ES2022 target, so class fields are defined, and the legacy
      // decorators.
      tsconfigRaw: { compilerOptions: { target: 'ES2022', useDefineForClassFields: true, experimentalDecorators: true } },
      external: ['@cardano-sdk/*'],
      outfile: join(out, BUNDLE),
      legalComments: 'inline',
      logLevel: 'warning',
      absWorkingDir: src
    });
    writeFileSync(join(out, 'LICENSE'), git(clone, ['show', `${LACE_COMMIT}:${LACE_LICENSE[0]}`]));
    const record = {
      repo: LACE_REPO,
      release: LACE_RELEASE,
      commit: LACE_COMMIT,
      paths: objects,
      license: { path: LACE_LICENSE[0], hash: LACE_LICENSE[2] },
      manifest: { path: LACE_MANIFEST[0], hash: LACE_MANIFEST[2] },
      sdk: LACE_SDK,
      esbuild: esbuild.version,
      bundle: { file: BUNDLE, sha256: sha256(join(out, BUNDLE)) }
    };
    writeFileSync(join(out, BUILD_RECORD), `${JSON.stringify(record, null, 2)}\n`);
    console.log(`build-lace: ${join(out, BUNDLE)} from ${LACE_COMMIT} (${Object.keys(objects).length} paths checked), sha256 ${record.bundle.sha256}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`build-lace: ${e.message}`);
  process.exit(1);
});
