// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A live-fire run in a process of its own, over the stand-in commands
// (live-fire-stubs.mjs) and with the gate passed, for the test that kills it
// in a stage. Arguments: one JSON array, [the run's options, the stand-ins'
// options].

import { runLiveFire } from '../../src/study/live-fire.mjs';
import { liveFireStubs } from './live-fire-stubs.mjs';

const [opts, stub] = JSON.parse(process.argv[2]);
await runLiveFire(opts, { commands: liveFireStubs(stub), gate: async () => {}, manifest: () => 'stand-in manifest\n', say: () => {} });
