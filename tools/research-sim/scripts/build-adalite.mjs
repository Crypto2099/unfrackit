#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Builds AdaLite's send path for the adalite- study method from the wallet's
// source at its pinned commit (src/methods/adalite-source.mjs), since no
// package publishes it:
//
//   node scripts/build-adalite.mjs --clone <dir>   from a local clone that
//                                                   holds the commit (a
//                                                   shallow clone will do)
//   node scripts/build-adalite.mjs --fetch <dir>   from a fresh shallow clone
//                                                   made in <dir>, which must
//                                                   not exist: the pinned
//                                                   commit alone
//
// It checks the git object hash of every pinned path, of both manifests and
// of yarn.lock at the commit; checks that yarn.lock resolves app/package.json's
// ranges to the package versions the tool pins and has installed; extracts the
// pinned paths with git archive (never from a working tree); bundles the
// entry with the tool's pinned esbuild into OUTPUT_DIR under the tool
// (gitignored), the packages left external so that the tool's installed
// copies load; fails if the bundle reads a file outside the pinned paths or
// esbuild warns; writes a NOTICE with the source and its license beside the
// bundle; and writes BUILD_RECORD: the repository, the commit, each pinned
// object's hash, the manifests', the packages, the esbuild version, the
// compile departures (adalite-source.mjs) with every rewritten import, the
// files bundled and the bundle's SHA-256. The extracted source is removed.
// Exit code 0 when the build is written, 1 on any failure.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  ADALITE_REPO, ADALITE_COMMIT, ADALITE_RELEASE, ADALITE_SRC, ADALITE_PATHS, ADALITE_LICENSE, ADALITE_ROOT_MANIFEST, ADALITE_MANIFEST, ADALITE_LOCK,
  ADALITE_PACKAGES, OUTPUT_DIR, BUNDLE, BUILD_RECORD, ENTRY, NAMESPACE_CALLS, BANNER
} from '../src/methods/adalite-source.mjs';

const TOOL = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const git = (dir, args, opts = {}) => execFileSync('git', ['-C', dir, ...args], { encoding: opts.encoding === null ? null : 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

function usage(msg) {
  if (msg) console.error(`build-adalite: ${msg}`);
  console.error('usage: node scripts/build-adalite.mjs --clone <dir> | --fetch <dir>');
  process.exit(1);
}

function parseArgs(argv) {
  if (argv.length !== 2) usage();
  const [flag, dir] = argv;
  if (flag !== '--clone' && flag !== '--fetch') usage(`unknown option ${flag}`);
  return { mode: flag.slice(2), dir: resolve(dir) };
}

// A shallow clone of the pinned commit alone.
function freshClone(dir) {
  if (existsSync(dir)) usage(`${dir} exists; --fetch makes a new clone`);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '--quiet']);
  git(dir, ['remote', 'add', 'origin', ADALITE_REPO]);
  git(dir, ['fetch', '--quiet', '--depth', '1', 'origin', ADALITE_COMMIT]);
  return dir;
}

// Checks one path's object at the commit against its pin.
function checkObject(clone, path, type, hash) {
  let got;
  let kind;
  try {
    got = git(clone, ['rev-parse', `${ADALITE_COMMIT}:${path}`]).trim();
    kind = git(clone, ['cat-file', '-t', got]).trim();
  } catch (e) {
    throw new Error(`${path} at ${ADALITE_COMMIT}: ${String(e.stderr || e.message).trim()}`);
  }
  if (kind !== type) throw new Error(`${path} at ${ADALITE_COMMIT} is a ${kind}, pinned as a ${type}`);
  if (got !== hash) throw new Error(`${path} at ${ADALITE_COMMIT} is ${got}, pinned as ${hash}`);
  return got;
}

// The version yarn.lock (Berry format) resolves for a package's range: the
// entry whose key lists "<name>@npm:<range>".
function lockedVersion(lock, name, range) {
  const want = `${name}@npm:${range}`;
  const blocks = lock.split(/\n(?=")/);
  for (const b of blocks) {
    const key = b.slice(0, b.indexOf('\n'));
    if (!key.endsWith(':')) continue;
    const names = key.slice(0, -1).replace(/^"|"$/g, '').split(', ');
    if (!names.includes(want)) continue;
    const m = /\n {2}version: (\S+)/.exec(b);
    if (m) return m[1];
  }
  return null;
}

// Rewrites a called namespace import of a CommonJS package as a default
// import (adalite-source.mjs NAMESPACE_CALLS), recording each site.
function namespacePlugin(srcRoot, rewrites) {
  const pattern = new RegExp(`import \\* as ([A-Za-z_$][\\w$]*) from '(${NAMESPACE_CALLS.map((p) => p.replace(/[.]/g, '\\.')).join('|')})'`, 'g');
  return {
    name: 'adalite-namespace-calls',
    setup(build) {
      build.onLoad({ filter: /\.tsx?$/ }, (args) => {
        const text = readFileSync(args.path, 'utf8');
        let changed = false;
        const out = text.replace(pattern, (whole, id, pkg, offset) => {
          changed = true;
          const line = text.slice(0, offset).split('\n').length;
          rewrites.push({ file: relative(srcRoot, args.path), line, from: whole, to: `import ${id} from '${pkg}'` });
          return `import ${id} from '${pkg}'`;
        });
        return { contents: changed ? out : text, loader: args.path.endsWith('x') ? 'tsx' : 'ts' };
      });
    }
  };
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function main() {
  const { mode, dir } = parseArgs(process.argv.slice(2));
  const clone = mode === 'fetch' ? freshClone(dir) : dir;
  try {
    git(clone, ['cat-file', '-e', `${ADALITE_COMMIT}^{commit}`]);
  } catch {
    throw new Error(`${clone} does not hold commit ${ADALITE_COMMIT}`);
  }
  const objects = {};
  for (const [path, [type, hash]] of Object.entries(ADALITE_PATHS)) objects[path] = { type, hash: checkObject(clone, path, type, hash) };
  for (const [path, type, hash] of [ADALITE_ROOT_MANIFEST, ADALITE_MANIFEST, ADALITE_LOCK]) checkObject(clone, path, type, hash);

  // The license both manifests declare.
  for (const [path] of [ADALITE_ROOT_MANIFEST, ADALITE_MANIFEST]) {
    const m = JSON.parse(git(clone, ['show', `${ADALITE_COMMIT}:${path}`]));
    if (m.license !== ADALITE_LICENSE) throw new Error(`${path} declares the license ${m.license}, pinned as ${ADALITE_LICENSE}`);
  }
  // The packages: app/package.json's range, yarn.lock's version, the tool's.
  const manifest = JSON.parse(git(clone, ['show', `${ADALITE_COMMIT}:${ADALITE_MANIFEST[0]}`]));
  const lock = git(clone, ['show', `${ADALITE_COMMIT}:${ADALITE_LOCK[0]}`]);
  const packages = {};
  for (const [pkg, v] of Object.entries(ADALITE_PACKAGES)) {
    const range = manifest.dependencies[pkg];
    if (!range) throw new Error(`${ADALITE_MANIFEST[0]} has no dependency ${pkg}`);
    const locked = lockedVersion(lock, pkg, range);
    if (locked !== v) throw new Error(`yarn.lock resolves ${pkg}@${range} to ${locked}, the tool pins ${v}`);
    const installed = JSON.parse(readFileSync(join(TOOL, 'node_modules', ...pkg.split('/'), 'package.json'), 'utf8')).version;
    if (installed !== v) throw new Error(`${pkg} ${installed} is installed; the build needs ${v} (npm ci)`);
    packages[pkg] = { range, version: v };
  }

  const out = join(TOOL, OUTPUT_DIR);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const staging = mkdtempSync(join(out, '.source-'));
  try {
    // The pinned paths from the commit's objects, never a working tree.
    const tar = git(clone, ['archive', '--format=tar', ADALITE_COMMIT, '--', ...Object.keys(ADALITE_PATHS)], { encoding: null });
    const x = spawnSync('tar', ['-x', '-C', staging], { input: tar });
    if (x.status !== 0) throw new Error(`tar: ${String(x.stderr).trim()}`);
    const src = join(staging, ADALITE_SRC);
    const entryName = 'unfrackit-entry.ts';
    writeFileSync(join(src, entryName), ENTRY);
    const esbuild = require('esbuild');
    const rewrites = [];
    const result = await esbuild.build({
      entryPoints: [join(src, entryName)],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'es2022',
      // The wallet's compiler settings that change emitted code
      // (tsconfig.json): the JSX factory of the .tsx modules the bundle
      // reaches (none of them runs on the send path).
      tsconfigRaw: { compilerOptions: { jsx: 'react', jsxFactory: 'h' } },
      external: [...Object.keys(ADALITE_PACKAGES)],
      banner: { js: BANNER },
      plugins: [namespacePlugin(src, rewrites)],
      outfile: join(out, BUNDLE),
      metafile: true,
      legalComments: 'inline',
      logLevel: 'silent',
      absWorkingDir: src
    });
    if (result.warnings.length) throw new Error(`esbuild warned: ${result.warnings.map((w) => `${w.location ? `${w.location.file}:${w.location.line} ` : ''}${w.text}`).join('; ')}`);
    // Every bundled file lies under a pinned path.
    const inside = (f) => f === entryName || Object.keys(ADALITE_PATHS).some((p) => {
      const q = relative(ADALITE_SRC, p);
      return f === q || f.startsWith(`${q}/`);
    });
    const files = Object.keys(result.metafile.inputs).sort();
    const outside = files.filter((f) => !inside(f));
    if (outside.length) throw new Error(`the bundle reads files outside the pinned paths: ${outside.join(', ')}`);
    const imports = [...new Set(Object.values(result.metafile.outputs).flatMap((o) => o.imports.map((i) => i.path)))].sort();
    const allowed = new Set([...Object.keys(ADALITE_PACKAGES), ...NAMESPACE_CALLS.filter((p) => p === 'assert')]);
    const unexpected = imports.filter((p) => !allowed.has(p));
    if (unexpected.length) throw new Error(`the bundle imports packages the tool does not pin: ${unexpected.join(', ')}`);
    writeFileSync(join(out, 'NOTICE'), [
      `${BUNDLE} is compiled from AdaLite (${ADALITE_REPO}) at ${ADALITE_COMMIT},`,
      `the paths ${Object.keys(ADALITE_PATHS).join(', ')}.`,
      `The repository holds no license file; its manifests (${ADALITE_ROOT_MANIFEST[0]}, ${ADALITE_MANIFEST[0]})`,
      `declare the ${ADALITE_LICENSE} license, copyright Vacuumlabs (the manifests' author).`,
      'The bundle is built locally for the simulator and is not distributed.',
      ''
    ].join('\n'));
    const record = {
      repo: ADALITE_REPO,
      release: ADALITE_RELEASE,
      commit: ADALITE_COMMIT,
      paths: objects,
      license: ADALITE_LICENSE,
      manifests: { [ADALITE_ROOT_MANIFEST[0]]: ADALITE_ROOT_MANIFEST[2], [ADALITE_MANIFEST[0]]: ADALITE_MANIFEST[2], [ADALITE_LOCK[0]]: ADALITE_LOCK[2] },
      packages,
      esbuild: esbuild.version,
      departures: { namespaceCalls: rewrites, banner: BANNER },
      files: files.filter((f) => f !== entryName),
      bundle: { file: BUNDLE, sha256: sha256(join(out, BUNDLE)) }
    };
    writeFileSync(join(out, BUILD_RECORD), `${JSON.stringify(record, null, 2)}\n`);
    console.log(`build-adalite: ${join(out, BUNDLE)} from ${ADALITE_COMMIT} (${Object.keys(objects).length} paths checked, ${record.files.length} files bundled, ${rewrites.length} namespace imports compiled as default imports), sha256 ${record.bundle.sha256}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`build-adalite: ${e.message}`);
  process.exit(1);
});
