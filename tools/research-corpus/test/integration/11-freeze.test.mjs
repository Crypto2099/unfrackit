// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The freeze checks against real CIP-190 records: the preprod rehearsal of
// the freeze tool (tools/research-freeze in this repository), whose records
// are signed by its throwaway rehearsal identity and whose placeholder
// documents sit in the rehearsal's directory. Read-only.
//
// The rehearsal's typed freeze is checked as a final freeze with its
// core-only freeze as the hypotheses record. Everything about the records
// passes (the chunks reassemble, the bodies are canonical, every signature
// verifies under the rehearsal key, the 674 digests are the documents'), and
// the checks the rehearsal cannot meet refuse it: its placeholder document
// cites no hypotheses record, and its items are placeholders, not this code.
// The draw key's epoch rule is applied to its block; until that epoch starts
// the draw key is refused.
//
// Environment: RESEARCH_CORPUS_REHEARSAL_DIR, the rehearsal's directory
// (<freeze tool home>/rehearsals/<id>); the test is skipped without it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { db, blocks, record } from './env.mjs';
import { verifyFinalFreeze, drawKey, readTx } from '../../src/freeze.mjs';
import { hashList } from '../../src/hash.mjs';
import { q } from '../../src/db.mjs';
import { Koios } from '../../src/koios.mjs';

const DIR = process.env.RESEARCH_CORPUS_REHEARSAL_DIR;

test('T13 freeze checks on the preprod rehearsal records', { skip: !DIR || !existsSync(join(DIR || '.', 'state.json')) ? 'set RESEARCH_CORPUS_REHEARSAL_DIR' : false, timeout: 600000 }, async () => {
  const state = JSON.parse(readFileSync(join(DIR, 'state.json'), 'utf8'));
  const key = JSON.parse(readFileSync(join(DIR, '..', '..', 'identities', 'rehearsal', 'public.json'), 'utf8')).signing_public_key;
  const tx = Object.fromEntries(state.steps.map((s) => [s.label, s.txHash]));
  const c = await db();
  try {
    // Every rehearsal record parses and verifies under the rehearsal key.
    const each = {};
    for (const [label, hash] of Object.entries(tx)) {
      const t = await readTx(c, blocks, hash);
      assert.ok(t, `${label} is in the database`);
      assert.equal(t.recordError, null, `${label}: ${t.recordError}`);
      assert.ok(t.record.signatures.length >= 1);
      for (const s of t.record.signatures) assert.deepEqual([s.kid, s.valid], [key, true], `${label} signature`);
      each[label] = { tx: hash, block_no: t.block.block_no, items: t.record.digests.length, msg: t.msg };
    }
    const tip = (await q(c, blocks, 'tip_block'))[0];
    const v = await verifyFinalFreeze({
      client: c,
      blocks,
      freezeTx: tx['typed-freeze'],
      hypothesesTx: tx['core-only-freeze'],
      preregPath: join(DIR, 'typed-freeze', 'pre-registration.md'),
      studyKey: key,
      codeDigests: hashList(),
      tipBlockNo: Number(tip.block_no)
    });
    const byName = Object.fromEntries(v.checks.map((x) => [x.name, x.ok]));
    for (const n of ['freeze_tx_in_database', 'freeze_block_depth', 'label_674_is_document_digest', 'label_309_record', 'document_is_an_item', 'signed_by_study_key', 'document_names_study_key', 'hypotheses_tx_differs', 'hypotheses_tx_in_database', 'hypotheses_block_earlier', 'hypotheses_signed_by_study_key', 'hypotheses_document_differs']) {
      assert.equal(byName[n], true, n);
    }
    assert.equal(byName.document_cites_hypotheses_record, false, 'the placeholder document cites no hypotheses record');
    assert.equal(byName.code_files_are_items, false, 'the placeholder items are not this code');
    assert.equal(v.ok, false);
    // The core-only freeze as the final one is refused too.
    const v2 = await verifyFinalFreeze({ client: c, blocks, freezeTx: tx['core-only-freeze'], hypothesesTx: tx['core-only-freeze'], preregPath: join(DIR, 'core-only-freeze', 'pre-registration.md'), studyKey: key, codeDigests: hashList(), tipBlockNo: Number(tip.block_no) });
    assert.equal(v2.ok, false);
    // The draw key for the typed freeze's block.
    let draw;
    try {
      draw = await drawKey({ client: c, blocks, network: 'preprod', block: v.freezeBlock, koios: new Koios('preprod') });
    } catch (e) {
      draw = { refused: e.message };
    }
    const n = v.freezeBlock.epoch_slot_no < 432000 - 172800 ? v.freezeBlock.epoch_no + 1 : v.freezeBlock.epoch_no + 2;
    const started = Number(tip.epoch_no) >= n;
    if (started) assert.equal(draw.n, n);
    else assert.match(draw.refused, new RegExp(`epoch ${n} has not started`));
    record('T13', { records: each, checks: v.checks, freeze: v.freeze, hypotheses: v.hypotheses, draw, expected_n: n, tip_epoch: Number(tip.epoch_no) });
  } finally {
    await c.end();
  }
});
