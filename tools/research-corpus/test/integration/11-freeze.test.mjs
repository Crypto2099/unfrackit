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
// the draw key is refused. Once it has, the snapshot rule names the last block
// of epoch N - 1, which Koios must name too, once it is 2,160 blocks deep. The
// rehearsal's retyping successor, which carries the same document digest and
// items under the same key, is refused as the final freeze: it supersedes a
// record, and the typed freeze before it is another final record signed by
// the same key.
//
// The snapshot rule is also applied, against this database and Koios, to the
// draw epoch of the stand-in transaction T10 uses, which has started.
//
// Environment: RESEARCH_CORPUS_REHEARSAL_DIR, the rehearsal's directory
// (<freeze tool home>/rehearsals/<id>); the test is skipped without it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { db, blocks, record, S1_SEEDING_TX } from './env.mjs';
import { verifyFinalFreeze, drawKey, readTx, ruleSnapshot } from '../../src/freeze.mjs';
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
    for (const n of ['freeze_tx_in_database', 'freeze_block_depth', 'label_674_is_document_digest', 'label_309_record', 'document_is_an_item', 'signed_by_study_key', 'document_names_study_key', 'record_has_no_supersedes', 'hypotheses_tx_differs', 'hypotheses_tx_in_database', 'hypotheses_block_earlier', 'hypotheses_signed_by_study_key', 'hypotheses_document_differs', 'no_other_study_record', 'first_carrier_of_the_record']) {
      assert.equal(byName[n], true, n);
    }
    assert.equal(byName.document_cites_one_study_record, false, 'the placeholder document cites no hypotheses record');
    assert.equal(byName.code_files_are_items, false, 'the placeholder items are not this code');
    assert.equal(v.ok, false);
    // The retype carries the same document under the same key, and is refused.
    const vr = await verifyFinalFreeze({ client: c, blocks, freezeTx: tx.retype, hypothesesTx: tx['core-only-freeze'], preregPath: join(DIR, 'typed-freeze', 'pre-registration.md'), studyKey: key, codeDigests: hashList(), tipBlockNo: Number(tip.block_no) });
    const byNameR = Object.fromEntries(vr.checks.map((x) => [x.name, x]));
    assert.equal(byNameR.signed_by_study_key.ok, true);
    assert.equal(byNameR.label_674_is_document_digest.ok, true);
    assert.equal(byNameR.record_has_no_supersedes.ok, false);
    assert.equal(byNameR.no_other_study_record.ok, false);
    assert.match(byNameR.no_other_study_record.detail, new RegExp(tx['typed-freeze']));
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
    // The snapshot rule for a draw epoch, against this database and Koios:
    // the typed freeze's once its epoch has started, and the stand-in's.
    const ruled = async (epochN) => {
      const last = (await c.query('SELECT block_no, encode(hash, \'hex\') AS hash FROM block WHERE epoch_no = $1 ORDER BY id DESC LIMIT 1', [epochN - 1])).rows[0];
      try {
        const rs = await ruleSnapshot({ client: c, blocks, n: epochN, koios: new Koios('preprod'), tipBlockNo: Number(tip.block_no) });
        assert.equal(rs.block.hash, last.hash, 'the last block of epoch N - 1');
        assert.equal(rs.confirmation.koios.hash, last.hash, 'Koios names the same block');
        assert.ok(rs.confirmation.db_depth >= 2160 && rs.confirmation.koios.depth >= 2160);
        return { n: epochN, block_no: Number(rs.block.block_no), hash: rs.block.hash, confirmation: rs.confirmation };
      } catch (e) {
        assert.ok(Number(tip.block_no) - Number(last.block_no) < 2160, e.message);
        assert.match(e.message, /2160 deep/);
        return { n: epochN, refused: e.message };
      }
    };
    const snapshot = started ? await ruled(n) : null;
    const st = await readTx(c, blocks, S1_SEEDING_TX);
    const standInDraw = await drawKey({ client: c, blocks, network: 'preprod', block: st.block, koios: new Koios('preprod') });
    const standInSnapshot = await ruled(standInDraw.n);
    assert.ok(standInSnapshot.hash, 'the stand-in\'s draw epoch is long past');
    record('T13', { records: each, checks: v.checks, retype_checks: vr.checks, freeze: v.freeze, hypotheses: v.hypotheses, draw, expected_n: n, tip_epoch: Number(tip.epoch_no), snapshot, stand_in: { n: standInDraw.n, snapshot: standInSnapshot } });
  } finally {
    await c.end();
  }
});
