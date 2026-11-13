// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Arms: the study replays each wallet's observed history, so there is one
// arm, `observed`: the wallet as it was, untidied. A job's variant tells
// UnFrack.It's two H-12 runs apart: `absorb-on` and `absorb-off` (the setting
// is the method's option, opts.absorb); every other job's variant is
// `default`.

export const BASE_ARMS = Object.freeze(['observed']);
export const VARIANTS = Object.freeze(['default', 'absorb-on', 'absorb-off']);

// Refuses an arm, variant or repetition the engine does not run.
export function checkArm(arm, variant, repetition) {
  if (!BASE_ARMS.includes(arm)) throw new TypeError(`unknown arm ${arm}`);
  if (!VARIANTS.includes(variant)) throw new TypeError(`unknown variant ${variant}`);
  if (!Number.isSafeInteger(repetition) || repetition < 1) throw new TypeError('repetitions are numbered from 1');
}
