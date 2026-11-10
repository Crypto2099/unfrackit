// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The machine a run ran on and the workers it used, recorded beside the
// timings (run.json, the study's log) as timing context. No record reads
// them: the records are the same on any machine and at any worker count.

import os from 'node:os';
import { readFileSync } from 'node:fs';

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function hostFacts() {
  const release = readText('/etc/os-release');
  const version = readText('/proc/version');
  const cpus = os.cpus();
  return {
    cpuModel: cpus[0]?.model ?? null,
    logicalCores: cpus.length,
    totalMemoryBytes: os.totalmem(),
    os: (release && /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(release)?.[1]) ?? null,
    osRelease: os.release(),
    platform: os.platform(),
    wsl: version ? /microsoft|wsl/i.test(version) : null,
    node: process.version,
    v8: process.versions.v8
  };
}

// workers: the replay or battery workers; oracleWorkers: the battery's
// oracle workers, when it runs the oracle.
export function machineRecord({ workers, oracleWorkers = 0 }) {
  return { workers, oracleWorkers, ...hostFacts() };
}
