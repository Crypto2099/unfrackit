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

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { TOOL, HELPER_SOURCE_DIR, HELPER_BUILD_DIR, BUILD_RECORD, HELPER_SCHEMA, helperSourceFiles, helperSourceHash } from '../src/methods/helper.mjs';

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
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
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
