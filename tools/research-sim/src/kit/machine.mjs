// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Errors the machine can cause rather than the method: a RangeError (a heap
// or buffer that cannot grow, a call stack too deep) and a WebAssembly
// RuntimeError (a library whose WebAssembly memory cannot grow aborts). How
// far a worker's memory has grown depends on what it ran before and on the
// machine, so such an error is never recorded on its first appearance. Where
// the code turns an exception into a recorded outcome (a method's failure, a
// planner's refusal, an oracle evaluation's rejection, a validity check), it
// calls passMachineErrors first, which throws a machine error on as a
// MachineError; the job fails, and the pool runs it again in a fresh worker
// with recording on (replay/pool.mjs, oracle/oracle.mjs). There the catch
// records it as it records any other exception, so only an error that
// happens again in a fresh worker is recorded. Node's argument checks
// (RangeErrors with an ERR_ code, such as a buffer read past its end) are
// the input's, not the machine's, and are recorded at once.
//
// A worker runs one job at a time, so recording is a flag of the worker's
// process, set by the worker for each job.

export class MachineError extends Error {
  constructor(cause) {
    const name = cause && typeof cause.name === 'string' ? cause.name : 'Error';
    const message = cause && cause.message !== undefined ? cause.message : String(cause);
    super(`${name}: ${message}`, { cause });
    this.name = 'MachineError';
  }
}

let recording = false;

export function recordMachineErrors(on) {
  recording = on === true;
}

export const recordingMachineErrors = () => recording;

export function isMachineError(e) {
  if (!e || typeof e !== 'object') return false;
  if (e instanceof MachineError || e.name === 'MachineError') return true;
  if (typeof e.code === 'string' && e.code.startsWith('ERR_')) return false;
  if (e instanceof RangeError || e.name === 'RangeError') return true;
  return (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError) || e.name === 'RuntimeError';
}

// In a catch that records what it caught: throws a machine error on, as a
// MachineError, unless this job records them.
export function passMachineErrors(e) {
  if (e instanceof MachineError) throw e;
  if (!recording && isMachineError(e)) throw new MachineError(e);
}
