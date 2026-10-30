// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A study run in a process of its own, over the stand-in commands
// (study-stubs.mjs), for the test that kills it in a stage. Arguments: one
// JSON array, [the study's options, the stand-ins' options].

import { runStudy } from '../../src/study/study.mjs';
import { stubCommands } from './study-stubs.mjs';

const [opts, stub] = JSON.parse(process.argv[2]);
await runStudy(opts, { commands: stubCommands(stub), manifest: () => 'stand-in manifest\n', say: () => {} });
