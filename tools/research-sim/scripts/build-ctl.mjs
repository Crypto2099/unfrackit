#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Builds the Cardano Transaction Lib balancer for the ctl- study method from
// CTL's package set at its pinned commit (src/methods/ctl-source.mjs), since
// no JavaScript registry publishes it:
//
//   node scripts/build-ctl.mjs --clone <dir>   from a local clone that holds
//                                               the commit (a partial clone
//                                               will do)
//   node scripts/build-ctl.mjs --fetch <dir>   from a fresh shallow clone
//                                               made in <dir>, which must not
//                                               exist
//
// Steps, each checked:
//   1. the pinned files at the commit, by git object hash (the package set,
//      the npm manifest and lockfile, the license);
//   2. the package set read from spago-packages.nix at the commit; the
//      balancer's entry must be the pinned one;
//   3. the compiler: the purs 0.15.8 release tarball, fetched once into
//      CACHE_DIR, its SHA-256 and the binary's checked against the pins, and
//      its --version;
//   4. every package of the set fetched at its commit into CACHE_DIR (a
//      shallow fetch of that commit alone, kept between builds), each
//      checked to hold the commit, and the src directory of each extracted
//      from the commit's objects with git archive (never a working tree);
//   5. the entry module (ENTRY_FILE) and the modules it imports, followed
//      through the extracted packages, compiled with purs compile;
//   6. the lockfile's packages installed with npm ci (production packages
//      only, no install scripts), and the compiled JavaScript bundled with
//      them by the tool's pinned esbuild into OUTPUT_DIR (gitignored) as one
//      CommonJS file; xhr2, which the provider package's HTTP driver imports
//      only when a request is made, stays external;
//   7. the licenses: CTL's beside the bundle, and the license file of every
//      compiled package and bundled npm package in LICENSES.txt;
//   8. BUILD_RECORD: the repository, the commit, each pinned file's hash, the
//      balancer's pin, the compiler, each compiled package's commit and its
//      src tree's hash, the entry's SHA-256, the bundled npm packages and
//      their versions, the esbuild version and the bundle's SHA-256.
// The extracted and compiled sources are removed. Exit code 0 when the build
// is written, 1 on any failure. The clone, the checks and the extraction are
// scripts/wallet-source.mjs, which the wallet builds share.

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync, copyFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import {
  CTL_REPO, CTL_COMMIT, CTL_RELEASE, CTL_PATHS, BALANCER, PURS, ENTRY_FILE, ENTRY_MODULE,
  OUTPUT_DIR, CACHE_DIR, BUNDLE, BUILD_RECORD
} from '../src/methods/ctl-source.mjs';
import { git, parseArgs, freshClone, requireCommit, checkObject, extractPaths, sha256 } from './wallet-source.mjs';

const TOOL = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const say = (m) => console.log(`build-ctl: ${m}`);
const sha256Of = (buf) => createHash('sha256').update(buf).digest('hex');

// The package set: { name: { version, url, rev } } from spago-packages.nix,
// the file spago2nix writes and CTL's Nix build reads.
export function parsePackageSet(text) {
  const out = {};
  const re = /^ {4}"([^"]+)" = pkgs\.stdenv\.mkDerivation \{\s*name = "([^"]+)";\s*version = "([^"]+)";\s*src = pkgs\.fetchgit \{\s*url = "([^"]+)";\s*rev = "([0-9a-f]{40})";/gm;
  for (const m of text.matchAll(re)) {
    if (m[1] !== m[2]) throw new Error(`package set: entry ${m[1]} is named ${m[2]}`);
    out[m[1]] = { version: m[3], url: m[4], rev: m[5] };
  }
  const declared = (text.match(/^ {4}"[^"]+" = pkgs\.stdenv\.mkDerivation/gm) || []).length;
  if (!declared || declared !== Object.keys(out).length) throw new Error(`package set: ${declared} entries, ${Object.keys(out).length} read`);
  return out;
}

// The compiler, fetched once and checked every time.
async function compiler(cache) {
  const dir = join(cache, `purs-${PURS.version}`);
  const tarball = join(dir, 'linux64.tar.gz');
  mkdirSync(dir, { recursive: true });
  if (!existsSync(tarball) || sha256(tarball) !== PURS.tarballSha256) {
    say(`fetching ${PURS.url}`);
    const res = await fetch(PURS.url);
    if (!res.ok) throw new Error(`${PURS.url}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha256Of(buf) !== PURS.tarballSha256) throw new Error(`${PURS.url}: SHA-256 ${sha256Of(buf)}, pinned ${PURS.tarballSha256}`);
    writeFileSync(tarball, buf);
  }
  const x = spawnSync('tar', ['-xzf', tarball, '-C', dir, 'purescript/purs']);
  if (x.status !== 0) throw new Error(`tar: ${String(x.stderr).trim()}`);
  const purs = join(dir, 'purescript', 'purs');
  if (sha256(purs) !== PURS.binarySha256) throw new Error(`${purs}: SHA-256 ${sha256(purs)}, pinned ${PURS.binarySha256}`);
  chmodSync(purs, 0o755);
  const v = execFileSync(purs, ['--version'], { encoding: 'utf8' }).trim();
  if (v !== PURS.version) throw new Error(`purs --version is ${v}, pinned ${PURS.version}`);
  return purs;
}

// A child process's exit status and stderr.
function run(cmd, args) {
  return new Promise((res) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (status) => res({ status, stderr }));
  });
}

// Each package at its commit, in a shallow repository of its own, sixteen
// fetches at a time.
async function fetchPackages(cache, set) {
  const root = join(cache, 'packages');
  mkdirSync(root, { recursive: true });
  const names = Object.keys(set);
  const missing = names.filter((n) => {
    const d = join(root, n);
    if (!existsSync(join(d, '.git'))) return true;
    try {
      git(d, ['cat-file', '-e', `${set[n].rev}^{commit}`]);
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length) say(`fetching ${missing.length} of ${names.length} packages`);
  for (let i = 0; i < missing.length; i += 16) {
    await Promise.all(missing.slice(i, i + 16).map(async (n) => {
      const d = join(root, n);
      rmSync(d, { recursive: true, force: true });
      mkdirSync(d, { recursive: true });
      git(d, ['init', '--quiet']);
      git(d, ['remote', 'add', 'origin', set[n].url]);
      const r = await run('git', ['-C', d, 'fetch', '--quiet', '--depth', '1', 'origin', set[n].rev]);
      if (r.status !== 0) throw new Error(`package ${n}: git fetch ${set[n].url} ${set[n].rev}: ${r.stderr.trim()}`);
    }));
  }
  for (const n of names) requireCommit(join(root, n), set[n].rev);
  return root;
}

// The module index of the extracted packages: module name -> file.
function moduleIndex(dirs) {
  const index = new Map();
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.purs')) {
        const m = /^module\s+([\w.]+)/m.exec(readFileSync(p, 'utf8'));
        if (!m) throw new Error(`${p}: no module header`);
        if (index.has(m[1])) throw new Error(`module ${m[1]} is in both ${index.get(m[1])} and ${p}`);
        index.set(m[1], p);
      }
    }
  };
  for (const d of dirs) if (existsSync(d)) walk(d);
  return index;
}

// The files of the modules `entry` imports, transitively, the entry first.
export function importClosure(entry, index) {
  const seen = new Set();
  const files = [];
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    files.push(file);
    const src = readFileSync(file, 'utf8').replace(/\{-[\s\S]*?-\}/g, '');
    for (const m of src.matchAll(/^import\s+([A-Z][\w.]*)/gm)) {
      if (m[1] === 'Prim' || m[1].startsWith('Prim.')) continue;
      const f = index.get(m[1]);
      if (!f) throw new Error(`${file} imports ${m[1]}, which no package of the set holds`);
      visit(f);
    }
  };
  visit(entry);
  return files;
}

async function main() {
  const { mode, dir } = parseArgs('build-ctl', process.argv.slice(2));
  const clone = mode === 'fetch' ? freshClone('build-ctl', dir, CTL_REPO, CTL_COMMIT) : dir;
  requireCommit(clone, CTL_COMMIT);
  const paths = {};
  for (const [path, [type, hash]] of Object.entries(CTL_PATHS)) paths[path] = { type, hash: checkObject(clone, CTL_COMMIT, path, type, hash) };
  const set = parsePackageSet(git(clone, ['show', `${CTL_COMMIT}:spago-packages.nix`]));
  const bal = set[BALANCER.name];
  if (!bal || bal.rev !== BALANCER.rev || bal.version !== BALANCER.version || bal.url !== BALANCER.url) throw new Error(`the package set pins ${BALANCER.name} as ${JSON.stringify(bal)}, the tool ${JSON.stringify(BALANCER)}`);

  const cache = join(TOOL, CACHE_DIR);
  const purs = await compiler(cache);
  const pkgRoot = await fetchPackages(cache, set);

  const out = join(TOOL, OUTPUT_DIR);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // A fixed name: the bundle's module comments carry the paths under it, so
  // the bundle's bytes do not depend on a random directory name.
  const staging = join(out, '.source');
  mkdirSync(staging);
  try {
    // The packages' sources from their commits' objects.
    const trees = {};
    for (const [n, p] of Object.entries(set)) {
      const d = join(staging, 'packages', n);
      mkdirSync(d, { recursive: true });
      let tree = null;
      try {
        tree = git(join(pkgRoot, n), ['rev-parse', `${p.rev}:src`]).trim();
      } catch {
        tree = null;
      }
      if (tree) extractPaths(join(pkgRoot, n), p.rev, ['src'], d);
      for (const lic of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
        try {
          writeFileSync(join(d, '.license'), git(join(pkgRoot, n), ['show', `${p.rev}:${lic}`]));
          break;
        } catch {
          // The next name.
        }
      }
      trees[n] = tree;
    }
    const entrySrc = join(TOOL, ENTRY_FILE);
    const entry = join(staging, 'entry', 'Entry.purs');
    mkdirSync(dirname(entry), { recursive: true });
    copyFileSync(entrySrc, entry);
    const index = moduleIndex(Object.keys(set).map((n) => join(staging, 'packages', n, 'src')));
    const files = importClosure(entry, index);
    const used = [...new Set(files.slice(1).map((f) => relative(join(staging, 'packages'), f).split('/')[0]))].sort();
    if (!used.includes(BALANCER.name)) throw new Error('the entry does not reach the balancer');
    say(`compiling ${files.length} modules from ${used.length} packages with purs ${PURS.version}`);
    const output = join(staging, 'output');
    const c = spawnSync(purs, ['compile', '--output', output, ...files], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (c.status !== 0) throw new Error(`purs compile failed:\n${(c.stderr || '').split('\n').filter((l) => !/^\[\d+ of \d+\]/.test(l)).slice(-60).join('\n')}`);

    // The lockfile's npm packages, production only, no install scripts.
    const npmDir = join(staging, 'npm');
    mkdirSync(npmDir, { recursive: true });
    for (const f of ['package.json', 'package-lock.json']) writeFileSync(join(npmDir, f), git(clone, ['show', `${CTL_COMMIT}:${f}`]));
    const n = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: npmDir, encoding: 'utf8' });
    if (n.status !== 0) throw new Error(`npm ci: ${(n.stderr || '').trim()}`);

    const esbuild = require('esbuild');
    const result = await esbuild.build({
      entryPoints: [join(output, ENTRY_MODULE, 'index.js')],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'es2022',
      nodePaths: [join(npmDir, 'node_modules')],
      external: ['xhr2'],
      outfile: join(out, BUNDLE),
      legalComments: 'inline',
      logLevel: 'warning',
      metafile: true
    });
    // The bundled npm packages, by their manifests.
    const npmPkgs = {};
    for (const input of Object.keys(result.metafile.inputs)) {
      const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
      if (!m) continue;
      const manifest = JSON.parse(readFileSync(join(npmDir, 'node_modules', m[1], 'package.json'), 'utf8'));
      npmPkgs[m[1]] = { version: manifest.version, license: manifest.license || null };
    }

    // Licenses.
    writeFileSync(join(out, 'LICENSE'), git(clone, ['show', `${CTL_COMMIT}:LICENSE`]));
    const texts = [];
    for (const name of used) {
      const f = join(staging, 'packages', name, '.license');
      texts.push(`==== ${name} ${set[name].version} (${set[name].url} ${set[name].rev})\n\n${existsSync(f) ? readFileSync(f, 'utf8') : '(no license file in the package)\n'}`);
    }
    for (const [name, p] of Object.entries(npmPkgs).sort()) {
      const d = join(npmDir, 'node_modules', name);
      const lic = readdirSync(d).find((f) => /^licen[cs]e/i.test(f));
      texts.push(`==== npm ${name} ${p.version} (${p.license})\n\n${lic ? readFileSync(join(d, lic), 'utf8') : '(no license file in the package)\n'}`);
    }
    writeFileSync(join(out, 'LICENSES.txt'), texts.join('\n'));

    const record = {
      repo: CTL_REPO,
      release: CTL_RELEASE,
      commit: CTL_COMMIT,
      paths,
      balancer: BALANCER,
      purs: { version: PURS.version, tarballSha256: PURS.tarballSha256, binarySha256: PURS.binarySha256 },
      entry: { file: ENTRY_FILE, module: ENTRY_MODULE, sha256: sha256(entrySrc) },
      packages: Object.fromEntries(used.map((name) => [name, { version: set[name].version, url: set[name].url, rev: set[name].rev, src: trees[name] }])),
      modules: files.length,
      npm: npmPkgs,
      esbuild: esbuild.version,
      bundle: { file: BUNDLE, sha256: sha256(join(out, BUNDLE)) }
    };
    writeFileSync(join(out, BUILD_RECORD), `${JSON.stringify(record, null, 2)}\n`);
    say(`${join(out, BUNDLE)} from ${CTL_COMMIT} (${used.length} packages, ${files.length} modules), sha256 ${record.bundle.sha256}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`build-ctl: ${e.message}`);
    process.exit(1);
  });
}
