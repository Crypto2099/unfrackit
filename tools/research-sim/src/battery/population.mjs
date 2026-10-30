// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Which batteries a snapshot file's wallet runs, from its history header's
// split and sample membership (history/commands.mjs sampleMembership):
//   recent random sample                the standard battery and H-10's
//   recent purposive stratum only       H-10's alone
//   any other sampled wallet            none
//   no split and no sample              both (a test network's wallets, a
//                                       live-fire pick, a synthetic shape:
//                                       nothing names a sample)
// A header with a split and no sample, or a sample that lacks either
// recentRandom or recentStratum (written before the strata were recorded), is
// refused: the file says nothing reliable about the wallet's sample.

import { openSync, readSync, closeSync } from 'node:fs';

export const POPULATION_KINDS = Object.freeze(['standard-and-h10', 'h10-only', 'none', 'no-sample']);

const BOTH = Object.freeze({ standard: true, h10: true });
const NONE = Object.freeze({ standard: false, h10: false });

// header: { split, sample }; name: the file's name for the refusal.
export function batteriesOf(header, name = 'the file') {
  const split = header.split ?? null;
  const sample = header.sample ?? null;
  if (sample === null) {
    if (split !== null) throw new Error(`${name}: the header names a split but not the wallet's sample membership; rerun history for this run`);
    return { kind: 'no-sample', batteries: BOTH };
  }
  if (typeof sample.recentRandom !== 'boolean' || typeof sample.recentStratum !== 'boolean') throw new Error(`${name}: the header's sample lacks the recent stratum membership; rerun history for this run`);
  if (sample.recentRandom) return { kind: 'standard-and-h10', batteries: BOTH };
  if (sample.recentStratum) return { kind: 'h10-only', batteries: { standard: false, h10: true } };
  return { kind: 'none', batteries: NONE };
}

// A history file's header line, read without the rest of the file.
export function readHeader(path) {
  const fd = openSync(path, 'r');
  try {
    let text = '';
    const buf = Buffer.alloc(1 << 16);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      text += buf.toString('utf8', 0, n);
      const i = text.indexOf('\n');
      if (i >= 0) return JSON.parse(text.slice(0, i));
    }
    return JSON.parse(text);
  } finally {
    closeSync(fd);
  }
}

// The wallets of a battery run with their batteries: [{ spec, population }].
// Every file is decided before any is run; a refusal throws for the first
// file, so no record is written. Shapes carry no sample.
export function assignPopulation(wallets) {
  return wallets.map((w) => {
    if (w.spec.kind !== 'history') return { ...w, population: { kind: 'no-sample', batteries: BOTH } };
    const name = w.spec.path.split('/').pop();
    const h = readHeader(w.spec.path);
    return { ...w, population: batteriesOf(h, name) };
  });
}

// The counts a run reports: files per kind; no wallet is named.
export function countPopulation(wallets) {
  const c = { files: wallets.length, 'standard-and-h10': 0, 'h10-only': 0, none: 0, 'no-sample': 0 };
  for (const w of wallets) c[(w.population || { kind: 'no-sample' }).kind]++;
  return c;
}
