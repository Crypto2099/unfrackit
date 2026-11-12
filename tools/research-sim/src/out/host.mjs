// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The machine a run ran on and the workers it used, recorded beside the
// timings (a battery's run.json, a replay stage's machines/<label>.json, the
// study's log) as timing context. No record reads them: the records are the
// same on any machine and at any worker count.

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

// The physical cores /proc/cpuinfo lists: its distinct (physical id, core
// id) pairs, or null where it gives none.
export function physicalCores(cpuinfo = readText('/proc/cpuinfo')) {
  if (!cpuinfo) return null;
  const cores = new Set();
  for (const block of cpuinfo.split(/\n\s*\n/)) {
    const pkg = /^physical id\s*:\s*(\d+)$/m.exec(block);
    const core = /^core id\s*:\s*(\d+)$/m.exec(block);
    if (pkg && core) cores.add(`${pkg[1]}/${core[1]}`);
  }
  return cores.size || null;
}

// Whether the kernel runs under WSL2 (its /proc/version names it) or another
// virtual machine (/proc/cpuinfo's hypervisor flag, which /proc/version does
// not show): 'wsl2', 'vm' or 'none', or null where neither file can be read.
export function virtualization(version = readText('/proc/version'), cpuinfo = readText('/proc/cpuinfo')) {
  if (version === null && cpuinfo === null) return null;
  if (version && /WSL2/i.test(version)) return 'wsl2';
  if (cpuinfo && /^flags\s*:.*\bhypervisor\b/m.test(cpuinfo)) return 'vm';
  return 'none';
}

// A replay stage's record of the machine an invocation ran on: the host
// facts with the physical cores and the virtualization.
export function machineFacts() {
  return { ...hostFacts(), physicalCores: physicalCores(), virtualization: virtualization() };
}
