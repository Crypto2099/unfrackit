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
//           tag's commit 12d4a1c77cc1f991231d6ffca306ceef61dbabd0). Go 1.26.10
//           or later must be on the PATH as `go` (RESEARCH_SIM_GO may name
//           the go command instead); without it the script stops and says
//           so. Modules are
//           downloaded into the toolchain's module cache and checked against
//           go.sum (go mod verify), the build runs with -mod=readonly,
//           -trimpath and -buildvcs=false and without cgo, so the
//           executable depends on the helper's source and the toolchain
//           alone, not on the repository's commit, and the release's commit
//           is checked against the module's origin as the module proxy
//           records it.
//   jvm     Maven: cardano-client-lib 0.7.3 and Scalus 1.5.0 in one shaded
//           jar (helpers/jvm/pom.xml, every dependency and plugin at an exact
//           version; the helper's Scala source compiled by scala-maven-plugin
//           with Scala 3.3.9, the version Scalus 1.5.0 is built with). Maven
//           3.9 or later as `mvn` and Java 21 or later as `java` must be on the
//           PATH (RESEARCH_SIM_MAVEN and RESEARCH_SIM_JAVA may name them
//           instead). Artifacts are downloaded into RESEARCH_SIM_MAVEN_REPO (or
//           Maven's default local repository) with strict checksums against the
//           repository's checksum files, and every resolved runtime artifact's
//           SHA-256 is checked against helpers/jvm/maven.lock; `--lock` writes
//           that file from what was resolved instead of checking it. The build
//           runs in build/helpers/jvm/target, outside the source, with a fixed
//           output timestamp (project.build.outputTimestamp), so the jar
//           depends on the source and the toolchain alone.
//   pycardano  Python: pycardano 0.19.2 (Python-Cardano/pycardano, the
//           release tag's commit 0445f30) and its runtime dependencies, in a
//           virtual environment under build/helpers/pycardano/venv. Python is
//           taken from RESEARCH_SIM_PYTHON, or python3.12 on the PATH, and
//           must be CPython 3.12. The environment is made with the venv
//           module and filled by its own pip from requirements.txt with
//           --require-hashes --no-deps --only-binary :all:, so every
//           distribution is a wheel whose SHA-256 the file pins; pip check
//           then confirms the set satisfies every dependency. main.py is
//           copied beside it, and the executable is a launcher script that
//           runs it in the environment with an empty process environment
//           and PYTHONHASHSEED=0 (python -P -s -B), so no variable of the
//           caller's reaches the library and set iteration is the same on
//           every run. The launcher names the SHA-256 of main.py and of the
//           environment's site-packages (methods/pycardano.mjs
//           environmentHash), so its own SHA-256, the helper's in the build
//           record, identifies both; the method checks both again when it
//           loads.
//   tx3     Rust: tx3-resolver, tx3-cardano and tx3-lang 0.25.0 (the release
//           tag's commit f2cadfdb80dbdb72c111ec770e3f233fcbbff2db) over
//           tx3-tir 0.19.0 (d46c33eb4419fe15b6dbee11b92f139bbe9576da). Cargo
//           and Rust 1.88 or later must be on the PATH as `cargo`
//           (RESEARCH_SIM_CARGO may name the cargo command instead). Crates
//           are downloaded into cargo's home and checked against Cargo.lock
//           (--locked), each Tx3 crate's commit is read from the
//           .cargo_vcs_info.json crates.io packages it with, and the build
//           runs in release mode with the paths of the source, cargo's home
//           and the build directory remapped, so the executable depends on
//           the helper's source and the toolchain alone. Cargo's build
//           output stays in build/helpers/tx3/target, which a rebuild keeps.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, renameSync, copyFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { TOOL, HELPER_SOURCE_DIR, HELPER_BUILD_DIR, BUILD_RECORD, HELPER_SCHEMA, helperSourceFiles, helperSourceHash } from '../src/methods/helper.mjs';
import { PYCARDANO_VERSION, PYCARDANO_COMMIT, PYCARDANO_PYTHON, SITE_PACKAGES, environmentHash, launcherText } from '../src/methods/pycardano.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const run = (cmd, args, opts) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts });

const APOLLO_MODULE = 'github.com/Salvionied/apollo/v2';
const APOLLO_VERSION = 'v2.2.1';
const APOLLO_COMMIT = '12d4a1c77cc1f991231d6ffca306ceef61dbabd0';

// Scala artifacts carry the Scala binary version after an underscore.
const SCALA_BINARY = '3';
const JVM_PINS = {
  'com.bloxbean.cardano:cardano-client-lib': '0.7.3',
  [`org.scalus:scalus-cardano-ledger_${SCALA_BINARY}`]: '1.5.0'
};

// The runtime artifacts Maven resolved, by file name in the local repository
// (artifact-version.jar), with their SHA-256: [{ file, sha256 }].
function resolvedArtifacts(mvn, src, env, repoArgs, out) {
  const cpFile = join(out, 'classpath.txt');
  run(mvn, ['-B', '-q', '-C', ...repoArgs, '-f', join(src, 'pom.xml'), `-Djvm.helper.target=${join(out, 'target')}`, 'dependency:build-classpath', '-Dmdep.includeScope=runtime', `-Dmdep.outputFile=${cpFile}`], { cwd: out, env });
  const files = readFileSync(cpFile, 'utf8').trim().split(':').filter(Boolean);
  rmSync(cpFile);
  return files.map((f) => {
    const parts = f.split('/');
    return { file: parts[parts.length - 1], sha256: sha256(readFileSync(f)) };
  });
}

const HELPERS = {
  apollo: {
    executable: 'apollo-helper',
    build(src, out) {
      const go = process.env.RESEARCH_SIM_GO || 'go';
      const env = { ...process.env, CGO_ENABLED: '0', GOFLAGS: '-mod=readonly', GOTOOLCHAIN: 'local' };
      let toolchain;
      try {
        toolchain = run(go, ['version'], { cwd: src, env }).trim();
      } catch (e) {
        if (e.code === 'ENOENT') throw new Error(`Go 1.26.10 or later must be on the PATH as \`go\` to build the apollo helper (or RESEARCH_SIM_GO must name the go command); ${go} was not found`);
        throw e;
      }
      run(go, ['mod', 'download'], { cwd: src, env });
      run(go, ['mod', 'verify'], { cwd: src, env });
      const info = JSON.parse(run(go, ['mod', 'download', '-json', `${APOLLO_MODULE}@${APOLLO_VERSION}`], { cwd: src, env }));
      const listed = JSON.parse(run(go, ['list', '-m', '-json', APOLLO_MODULE], { cwd: src, env }));
      if (listed.Version !== APOLLO_VERSION) throw new Error(`go.mod resolves ${APOLLO_MODULE} ${listed.Version}, not ${APOLLO_VERSION}`);
      if (!info.Origin || info.Origin.Hash !== APOLLO_COMMIT) throw new Error(`${APOLLO_MODULE} ${APOLLO_VERSION} comes from commit ${info.Origin ? info.Origin.Hash : '(no origin recorded)'}, not ${APOLLO_COMMIT}`);
      run(go, ['build', '-trimpath', '-buildvcs=false', '-o', join(out, this.executable), '.'], { cwd: src, env });
      return { toolchain, modules: { [APOLLO_MODULE]: { version: info.Version, sum: info.Sum, goModSum: info.GoModSum, commit: info.Origin.Hash } } };
    }
  }
};

HELPERS.jvm = {
  executable: 'jvm-helper.jar',
  build(src, out, { lock }) {
    const mvn = process.env.RESEARCH_SIM_MAVEN || 'mvn';
    const java = process.env.RESEARCH_SIM_JAVA || 'java';
    const env = { ...process.env, MAVEN_OPTS: process.env.MAVEN_OPTS || '' };
    const repo = process.env.RESEARCH_SIM_MAVEN_REPO;
    const repoArgs = repo ? [`-Dmaven.repo.local=${repo}`] : [];
    let toolchain;
    try {
      const m = run(mvn, ['-B', '-v'], { cwd: out, env }).split('\n')[0].trim();
      const j = spawnSync(java, ['-version'], { encoding: 'utf8' });
      if (j.error) throw j.error;
      toolchain = `${m}; ${String(j.stderr || j.stdout).split('\n')[0].trim()}`;
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error(`Maven 3.9 or later as \`mvn\` and Java 21 or later as \`java\` must be on the PATH to build the jvm helper (or RESEARCH_SIM_MAVEN and RESEARCH_SIM_JAVA must name them); ${e.path || 'a command'} was not found`);
      throw e;
    }
    const target = join(out, 'target');
    run(mvn, ['-B', '-q', '-C', ...repoArgs, '-f', join(src, 'pom.xml'), `-Djvm.helper.target=${target}`, 'package'], { cwd: out, env });
    const arts = resolvedArtifacts(mvn, src, env, repoArgs, out);
    const lockFile = join(src, 'maven.lock');
    const lines = arts.map((a) => `${a.file} ${a.sha256}`).sort();
    if (lock) {
      writeFileSync(lockFile, `${lines.join('\n')}\n`);
      throw new Error('wrote helpers/jvm/maven.lock from what Maven resolved; review it and run node scripts/build-helpers.mjs jvm');
    } else {
      let want;
      try {
        want = readFileSync(lockFile, 'utf8').trim().split('\n');
      } catch {
        throw new Error('helpers/jvm/maven.lock is missing; run node scripts/build-helpers.mjs jvm --lock to write it from what Maven resolves');
      }
      const have = new Set(lines);
      const missing = want.filter((l) => !have.has(l));
      const extra = lines.filter((l) => !want.includes(l));
      if (missing.length || extra.length) throw new Error(`the resolved artifacts differ from helpers/jvm/maven.lock: ${[...missing.map((l) => `locked ${l}`), ...extra.map((l) => `resolved ${l}`)].slice(0, 6).join('; ')}`);
    }
    const modules = {};
    for (const [id, version] of Object.entries(JVM_PINS)) {
      const artifact = id.split(':')[1];
      const a = arts.find((x) => x.file === `${artifact}-${version}.jar`);
      if (!a) throw new Error(`${id} ${version} was not resolved`);
      modules[id] = { version, sha256: a.sha256 };
    }
    renameSync(join(target, this.executable), join(out, this.executable));
    rmSync(target, { recursive: true, force: true });
    return { toolchain, modules, artifacts: arts.length };
  }
};

HELPERS.pycardano = {
  executable: 'pycardano-helper',
  build(src, out) {
    const python = process.env.RESEARCH_SIM_PYTHON || 'python3.12';
    const implementation = run(python, ['-I', '-c', 'import platform, sys; print(platform.python_implementation(), platform.python_version())']).trim();
    if (!implementation.startsWith(`CPython ${PYCARDANO_PYTHON}.`)) throw new Error(`${python} is ${implementation}, not CPython ${PYCARDANO_PYTHON}`);
    const venv = join(out, 'venv');
    run(python, ['-I', '-m', 'venv', venv]);
    const vpy = join(venv, 'bin', 'python');
    const pip = (...a) => run(vpy, ['-I', '-m', 'pip', '--disable-pip-version-check', '--no-input', ...a]);
    pip('install', '--require-hashes', '--no-deps', '--only-binary', ':all:', '-r', join(src, 'requirements.txt'));
    pip('check');
    const pipVersion = pip('--version').trim().split(' ')[1];
    const installed = run(vpy, ['-I', '-c', 'import importlib.metadata as m; print(m.version("pycardano"))']).trim();
    if (installed !== PYCARDANO_VERSION) throw new Error(`the environment holds pycardano ${installed}, not ${PYCARDANO_VERSION}`);
    copyFileSync(join(src, 'main.py'), join(out, 'main.py'));
    const main = sha256(readFileSync(join(out, 'main.py')));
    const env = environmentHash(join(venv, SITE_PACKAGES));
    writeFileSync(join(out, this.executable), launcherText({ main, environment: env.hash, python: implementation }));
    return { toolchain: `${implementation}, pip ${pipVersion}`, modules: { pycardano: { version: installed, commit: PYCARDANO_COMMIT } }, main, environment: env };
  }
};

HELPERS.tx3 = {
  executable: 'tx3-helper',
  keep: ['target'],
  build(src, out) {
    const cargo = process.env.RESEARCH_SIM_CARGO || 'cargo';
    const env = { ...process.env };
    let toolchain;
    try {
      toolchain = `${run(cargo, ['--version'], { cwd: src, env }).trim()}; ${run('rustc', ['--version'], { cwd: src, env }).trim()}`;
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error(`cargo and Rust 1.88 or later must be on the PATH as \`cargo\` to build the tx3 helper (or RESEARCH_SIM_CARGO must name the cargo command); ${cargo} was not found`);
      throw e;
    }
    run(cargo, ['fetch', '--locked'], { cwd: src, env });
    const meta = JSON.parse(run(cargo, ['metadata', '--locked', '--format-version', '1'], { cwd: src, env }));
    const modules = {};
    for (const [name, pin] of Object.entries(TX3_CRATES)) {
      const found = meta.packages.filter((p) => p.name === name);
      if (found.length !== 1 || found[0].version !== pin.version) throw new Error(`Cargo.lock resolves ${name} to ${found.map((p) => p.version).join(', ') || 'nothing'}, not ${pin.version}`);
      const vcs = JSON.parse(readFileSync(join(dirname(found[0].manifest_path), '.cargo_vcs_info.json'), 'utf8'));
      if (vcs.git.sha1 !== pin.commit) throw new Error(`${name} ${pin.version} was packaged from commit ${vcs.git.sha1}, not ${pin.commit}`);
      const lock = readFileSync(join(src, 'Cargo.lock'), 'utf8').split('[[package]]').find((b) => b.includes(`name = "${name}"\nversion = "${pin.version}"`));
      const checksum = lock && /checksum = "([0-9a-f]{64})"/.exec(lock);
      modules[name] = { version: pin.version, commit: vcs.git.sha1, checksum: checksum ? checksum[1] : null };
    }
    const target = join(out, 'target');
    const home = process.env.CARGO_HOME || join(homedir(), '.cargo');
    const remap = [[src, '/helper'], [home, '/cargo'], [target, '/target']].map(([from, to]) => `--remap-path-prefix=${from}=${to}`).join('\x1f');
    run(cargo, ['build', '--release', '--locked', '--target-dir', target], { cwd: src, env: { ...env, CARGO_ENCODED_RUSTFLAGS: remap } });
    copyFileSync(join(target, 'release', this.executable), join(out, this.executable));
    return { toolchain, modules };
  }
};

const TX3_CRATES = {
  'tx3-resolver': { version: '0.25.0', commit: 'f2cadfdb80dbdb72c111ec770e3f233fcbbff2db' },
  'tx3-cardano': { version: '0.25.0', commit: 'f2cadfdb80dbdb72c111ec770e3f233fcbbff2db' },
  'tx3-lang': { version: '0.25.0', commit: 'f2cadfdb80dbdb72c111ec770e3f233fcbbff2db' },
  'tx3-tir': { version: '0.19.0', commit: 'd46c33eb4419fe15b6dbee11b92f139bbe9576da' }
};

function main() {
  const all = process.argv.slice(2);
  const lock = all.includes('--lock');
  const args = all.filter((a) => a !== '--lock');
  if (args.length !== 1 || !HELPERS[args[0]] || (lock && args[0] !== 'jvm')) {
    console.error(`usage: node scripts/build-helpers.mjs <${Object.keys(HELPERS).join(' | ')}> (jvm also takes --lock)`);
    process.exit(1);
  }
  const name = args[0];
  const h = HELPERS[name];
  const src = join(TOOL, HELPER_SOURCE_DIR, name);
  const out = join(TOOL, HELPER_BUILD_DIR, name);
  const sourceHash = helperSourceHash(name);
  const files = Object.fromEntries(helperSourceFiles(name).map((f) => [f, sha256(readFileSync(join(src, f)))]));
  // The previous build is removed, but for what the helper keeps between
  // builds (cargo's build directory).
  mkdirSync(out, { recursive: true });
  for (const e of readdirSync(out)) if (!(h.keep || []).includes(e)) rmSync(join(out, e), { recursive: true, force: true });
  const facts = h.build(src, out, { lock });
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
