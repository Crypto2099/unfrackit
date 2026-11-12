#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Builds one helper of the methods whose library runs in another language
// (src/methods/helper.mjs):
//
//   node scripts/build-helpers.mjs <name>
//
// from its source under helpers/<name>/ (its code, its lockfile) into
// build/helpers/<name>/ (gitignored), and writes the build record there
// (build.json): the helper's name, the bridge's schema, the SHA-256 of each
// source file and of the source as a whole (helper.mjs helperSourceHash), the
// toolchain, the pinned modules as the toolchain resolved them, and the
// executable's SHA-256. The method refuses to load a build whose record does
// not match the tree. Exit code 0 when the build is written, 1 on any failure.
//
// Helpers:
//   apollo  Go: Apollo v2.2.1 (github.com/Salvionied/apollo/v2, the release
//           tag's commit 12d4a1c77cc1f991231d6ffca306ceef61dbabd0). Go is
//           taken from RESEARCH_SIM_GO, or `go` on the PATH; modules are
//           downloaded into the toolchain's module cache and checked against
//           go.sum (go mod verify), the build runs with -mod=readonly and
//           -trimpath and without cgo, and the release's commit is checked
//           against the module's origin as the module proxy records it.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { TOOL, HELPER_SOURCE_DIR, HELPER_BUILD_DIR, BUILD_RECORD, HELPER_SCHEMA, helperSourceFiles, helperSourceHash } from '../src/methods/helper.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const run = (cmd, args, opts) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts });

const APOLLO_MODULE = 'github.com/Salvionied/apollo/v2';
const APOLLO_VERSION = 'v2.2.1';
const APOLLO_COMMIT = '12d4a1c77cc1f991231d6ffca306ceef61dbabd0';

const HELPERS = {
  apollo: {
    executable: 'apollo-helper',
    build(src, out) {
      const go = process.env.RESEARCH_SIM_GO || 'go';
      const env = { ...process.env, CGO_ENABLED: '0', GOFLAGS: '-mod=readonly', GOTOOLCHAIN: 'local' };
      const toolchain = run(go, ['version'], { cwd: src, env }).trim();
      run(go, ['mod', 'download'], { cwd: src, env });
      run(go, ['mod', 'verify'], { cwd: src, env });
      const info = JSON.parse(run(go, ['mod', 'download', '-json', `${APOLLO_MODULE}@${APOLLO_VERSION}`], { cwd: src, env }));
      const listed = JSON.parse(run(go, ['list', '-m', '-json', APOLLO_MODULE], { cwd: src, env }));
      if (listed.Version !== APOLLO_VERSION) throw new Error(`go.mod resolves ${APOLLO_MODULE} ${listed.Version}, not ${APOLLO_VERSION}`);
      if (!info.Origin || info.Origin.Hash !== APOLLO_COMMIT) throw new Error(`${APOLLO_MODULE} ${APOLLO_VERSION} comes from commit ${info.Origin ? info.Origin.Hash : '(no origin recorded)'}, not ${APOLLO_COMMIT}`);
      run(go, ['build', '-trimpath', '-o', join(out, this.executable), '.'], { cwd: src, env });
      return { toolchain, modules: { [APOLLO_MODULE]: { version: info.Version, sum: info.Sum, goModSum: info.GoModSum, commit: info.Origin.Hash } } };
    }
  }
};

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !HELPERS[args[0]]) {
    console.error(`usage: node scripts/build-helpers.mjs <${Object.keys(HELPERS).join(' | ')}>`);
    process.exit(1);
  }
  const name = args[0];
  const h = HELPERS[name];
  const src = join(TOOL, HELPER_SOURCE_DIR, name);
  const out = join(TOOL, HELPER_BUILD_DIR, name);
  const sourceHash = helperSourceHash(name);
  const files = Object.fromEntries(helperSourceFiles(name).map((f) => [f, sha256(readFileSync(join(src, f)))]));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const facts = h.build(src, out);
  if (helperSourceHash(name) !== sourceHash) throw new Error(`the source under ${HELPER_SOURCE_DIR}/${name} changed during the build (a lockfile the toolchain rewrote?)`);
  const exe = join(out, h.executable);
  chmodSync(exe, 0o755);
  const record = { name, schema: HELPER_SCHEMA, sourceHash, files, ...facts, executable: h.executable, sha256: sha256(readFileSync(exe)) };
  writeFileSync(join(out, BUILD_RECORD), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`build-helpers: ${exe}, sha256 ${record.sha256} (source ${sourceHash.slice(0, 12)}, ${record.toolchain})`);
}

try {
  main();
} catch (e) {
  console.error(`build-helpers: ${String((e.stderr && e.stderr.toString().trim()) || e.message)}`);
  process.exit(1);
}
