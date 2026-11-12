#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Builds the Yoroi wallet's send flow for the yoroi-lf study method from the
// wallet's source at its pinned commit (src/methods/yoroi-source.mjs), since
// no package publishes it:
//
//   node scripts/build-yoroi.mjs --clone <dir>   from a local clone that
//                                                 holds the commit
//   node scripts/build-yoroi.mjs --fetch <dir>   from a fresh shallow clone
//                                                 made in <dir>, which must not
//                                                 exist: the pinned commit
//                                                 alone, without blobs outside
//                                                 the pinned paths
//
// It checks the git object hash of every pinned path at the commit, extracts
// those paths with git archive (never from a working tree), fetches with npm
// pack the npm packages the bundle takes and checks each tarball's SHA-512
// against Yoroi's own lockfile, and bundles the send flow with the tool's
// pinned esbuild into OUTPUT_DIR under the tool (gitignored). Yoroi's modules
// are marked free of side effects, so that a module whose exports the send
// flow does not use is left out: the packages' index files re-export React,
// storage and network modules the send flow never runs. Any package the kept
// code still loads, other than Node's buffer and the CSL alias, fails the
// build. It copies the repository's license beside the bundle and writes
// BUILD_RECORD: the repository, the commit, each path's hash, the license's
// and the lockfile's, the npm packages, the CSL pin, the esbuild version, the
// modules bundled, the packages left out, and the bundle's SHA-256. Nothing
// else is written; the extracted source and the tarballs are removed. Exit
// code 0 when the build is written, 1 on any failure. The clone, the checks
// and the extraction are scripts/wallet-source.mjs, which build-lace.mjs and
// build-adalite.mjs share.

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import {
  YOROI_REPO, YOROI_COMMIT, YOROI_RELEASE, YOROI_PACKAGES, YOROI_PATHS, YOROI_LICENSE, YOROI_LOCKFILE, YOROI_NPM, YOROI_CSL, CSL_ALIAS,
  OUTPUT_DIR, BUNDLE, BUILD_RECORD, ENTRY
} from '../src/methods/yoroi-source.mjs';
import { git, parseArgs, freshClone, requireCommit, checkObject, extractPaths, sha256 } from './wallet-source.mjs';

const TOOL = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const sri512 = (buf) => `sha512-${createHash('sha512').update(buf).digest('base64')}`;

// The CSL the bundle loads at run time: the alias's version, and the tool's
// lockfile integrity for it, which must be the one Yoroi's lockfile records.
function checkCsl(yoroiLock) {
  const e = yoroiLock.packages[`node_modules/${YOROI_CSL.package}`];
  if (!e || e.version !== YOROI_CSL.version || e.integrity !== YOROI_CSL.integrity) throw new Error(`Yoroi's lockfile does not record ${YOROI_CSL.package} ${YOROI_CSL.version} with the pinned integrity`);
  const installed = JSON.parse(readFileSync(require.resolve(`${CSL_ALIAS}/package.json`), 'utf8')).version;
  if (installed !== YOROI_CSL.version) throw new Error(`${CSL_ALIAS} ${installed} is installed; the build needs ${YOROI_CSL.version} (npm ci)`);
  const toolLock = JSON.parse(readFileSync(join(TOOL, 'package-lock.json'), 'utf8')).packages[`node_modules/${CSL_ALIAS}`];
  if (!toolLock || toolLock.integrity !== YOROI_CSL.integrity) throw new Error(`the tool's lockfile does not pin ${CSL_ALIAS} at Yoroi's integrity`);
}

// Each npm package of the pins, as Yoroi's lockfile records it, fetched by
// npm pack into `dest` and checked against that integrity: { name: dir }.
function npmPackages(yoroiLock, dest) {
  const dirs = {};
  for (const [name, pin] of Object.entries(YOROI_NPM)) {
    const e = yoroiLock.packages[`node_modules/${name}`];
    if (!e || e.version !== pin.version || e.integrity !== pin.integrity) throw new Error(`Yoroi's lockfile records ${name} ${e ? e.version : 'nowhere'}, not ${pin.version} with the pinned integrity`);
    const out = JSON.parse(execFileSync('npm', ['pack', `${name}@${pin.version}`, '--json', '--pack-destination', dest], { cwd: dest, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const tgz = join(dest, out[0].filename);
    const got = sri512(readFileSync(tgz));
    if (got !== pin.integrity) throw new Error(`the tarball of ${name}@${pin.version} has integrity ${got}, not ${pin.integrity}`);
    const dir = join(dest, name.replace('/', '__'));
    mkdirSync(dir, { recursive: true });
    execFileSync('tar', ['-x', '-z', '-f', tgz, '-C', dir]);
    rmSync(tgz);
    dirs[name] = join(dir, 'package');
  }
  return dirs;
}

// A package directory's main module.
function mainOf(dir) {
  const main = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).main || 'index.js';
  for (const c of [main, `${main}.js`, join(main, 'index.js')]) if (existsSync(join(dir, c)) && statSync(join(dir, c)).isFile()) return join(dir, c);
  throw new Error(`no main module in ${dir}`);
}

// The bundle, from the extracted source under `staging`: { inputs, imports,
// notLoaded, esbuild }.
async function bundle(staging, npm, outFile) {
  const esbuild = require('esbuild');
  const pk = join(staging, YOROI_PACKAGES);
  const tsFile = (base) => {
    for (const c of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx'), base]) if (existsSync(c) && statSync(c).isFile()) return c;
    return null;
  };
  const mains = {
    '@emurgo/cross-csl-mobile': mainOf(npm['@emurgo/cross-csl-nodejs']),
    '@emurgo/cross-csl-core': mainOf(npm['@emurgo/cross-csl-core']),
    immer: mainOf(npm.immer)
  };
  const outside = new Set();
  const plugin = {
    name: 'yoroi',
    setup(b) {
      // @yoroi/<name>[/...] as mobile/tsconfig.json:28-52 maps it.
      b.onResolve({ filter: /^@yoroi\// }, (a) => {
        const [name, ...sub] = a.path.slice('@yoroi/'.length).split('/');
        const p = tsFile(join(pk, name, ...sub));
        return p ? { path: p, sideEffects: false } : { errors: [{ text: `cannot resolve ${a.path}` }] };
      });
      b.onResolve({ filter: /^\.\.?\// }, (a) => {
        if (!a.importer.startsWith(pk)) return undefined;
        const p = tsFile(resolve(a.resolveDir, a.path));
        return p ? { path: p, sideEffects: false } : undefined;
      });
      b.onResolve({ filter: /^(@emurgo\/cross-csl-mobile|@emurgo\/cross-csl-core|immer)$/ }, (a) => ({ path: mains[a.path] }));
      b.onResolve({ filter: /^@emurgo\/cardano-serialization-lib-nodejs$/ }, () => ({ path: CSL_ALIAS, external: true }));
      b.onResolve({ filter: /^buffer$/ }, () => ({ path: 'buffer', external: true }));
      // Any other package: left out when the kept code uses none of its
      // bindings, so that it is never loaded, and refused below otherwise.
      b.onResolve({ filter: /^[^./]/ }, (a) => {
        if (a.path.startsWith('@yoroi/')) return undefined;
        outside.add(a.path);
        return { path: a.path, external: true, sideEffects: false };
      });
    }
  };
  const entry = join(pk, 'unfrackit-entry.ts');
  writeFileSync(entry, ENTRY);
  const r = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node24',
    // Yoroi's tsconfig.json extends expo/tsconfig.base, which is not
    // installed here, so esbuild is given an empty tsconfig and its own
    // defaults apply. NODE_ENV is set as a release build of the app sets it,
    // which selects immer's production build.
    tsconfigRaw: {},
    define: { 'process.env.NODE_ENV': '"production"' },
    treeShaking: true,
    metafile: true,
    outfile: outFile,
    legalComments: 'inline',
    logLevel: 'warning',
    absWorkingDir: staging,
    plugins: [plugin]
  });
  const out = r.metafile.outputs[Object.keys(r.metafile.outputs)[0]];
  const imports = [...new Set(out.imports.map((i) => i.path))].sort();
  const unpinned = imports.filter((p) => p !== 'buffer' && p !== CSL_ALIAS);
  if (unpinned.length) throw new Error(`the bundle would load ${unpinned.join(', ')}, which the build does not pin`);
  const inputs = Object.entries(out.inputs)
    .filter(([p, v]) => v.bytesInOutput > 0 && !p.endsWith('unfrackit-entry.ts'))
    .map(([p]) => p)
    .sort();
  return { inputs, imports, notLoaded: [...outside].filter((p) => !imports.includes(p)).sort(), esbuild: esbuild.version };
}

async function main() {
  const { mode, dir } = parseArgs('build-yoroi', process.argv.slice(2));
  const clone = mode === 'fetch' ? freshClone('build-yoroi', dir, YOROI_REPO, YOROI_COMMIT) : dir;
  requireCommit(clone, YOROI_COMMIT);
  const objects = {};
  for (const [path, [type, hash]] of Object.entries(YOROI_PATHS)) objects[path] = { type, hash: checkObject(clone, YOROI_COMMIT, path, type, hash) };
  checkObject(clone, YOROI_COMMIT, YOROI_LICENSE[0], YOROI_LICENSE[1], YOROI_LICENSE[2]);
  checkObject(clone, YOROI_COMMIT, YOROI_LOCKFILE[0], YOROI_LOCKFILE[1], YOROI_LOCKFILE[2]);
  const yoroiLock = JSON.parse(git(clone, ['show', `${YOROI_COMMIT}:${YOROI_LOCKFILE[0]}`]));
  checkCsl(yoroiLock);

  const out = join(TOOL, OUTPUT_DIR);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const staging = mkdtempSync(join(out, '.source-'));
  try {
    extractPaths(clone, YOROI_COMMIT, Object.keys(YOROI_PATHS), staging);
    const npmDir = join(staging, 'npm');
    mkdirSync(npmDir);
    const npm = npmPackages(yoroiLock, npmDir);
    const b = await bundle(staging, npm, join(out, BUNDLE));
    writeFileSync(join(out, 'LICENSE'), git(clone, ['show', `${YOROI_COMMIT}:${YOROI_LICENSE[0]}`]));
    const record = {
      repo: YOROI_REPO,
      release: YOROI_RELEASE,
      commit: YOROI_COMMIT,
      paths: objects,
      license: { path: YOROI_LICENSE[0], hash: YOROI_LICENSE[2] },
      lockfile: { path: YOROI_LOCKFILE[0], hash: YOROI_LOCKFILE[2] },
      npm: YOROI_NPM,
      csl: { ...YOROI_CSL, alias: CSL_ALIAS },
      esbuild: b.esbuild,
      bundled: b.inputs,
      runtimeImports: b.imports,
      notLoaded: b.notLoaded,
      bundle: { file: BUNDLE, sha256: sha256(join(out, BUNDLE)) }
    };
    writeFileSync(join(out, BUILD_RECORD), `${JSON.stringify(record, null, 2)}\n`);
    console.log(`build-yoroi: ${join(out, BUNDLE)} from ${YOROI_COMMIT} (${Object.keys(objects).length} paths checked, ${b.inputs.length} modules bundled), sha256 ${record.bundle.sha256}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`build-yoroi: ${e.message}`);
  process.exit(1);
});
