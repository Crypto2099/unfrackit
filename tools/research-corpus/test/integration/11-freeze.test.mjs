// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The freeze checks against real CIP-190 records: the preprod rehearsal of
// the freeze tool (tools/research-freeze in this repository), whose records
// are signed by its throwaway rehearsal identity and whose placeholder
// documents sit in the rehearsal's directory. Read-only.
//
// The rehearsal's two freezes are its steps labeled hypotheses and final
// (the two-stage rehearsals from 2026-10-21 on) or core-only-freeze and
// typed-freeze (the rehearsal of 2026-10-16). The chain orders the records:
// scanning the rehearsal key's records from the hypotheses step's block
// (--from-block, since the key signs every rehearsal), the hypotheses step is
// the hypotheses record and the final step the final one. Everything about
// the records passes (the chunks reassemble, the bodies are canonical, every
// signature verifies under the rehearsal key, the 674 digests are the
// documents', the final document lists its other items), and the checks the
// rehearsal cannot meet refuse it: its placeholder document lists no code
// manifest or check-log prefix, and its items are placeholders, not this
// code. The final document cites the hypotheses record exactly when its text
// carries that record's URI (the two-stage rehearsals do, the 2026-10-16 one
// does not), and the hypotheses record is then reported with the hypotheses
// document's digest. The retype and the hypotheses step are refused as the
// final freeze: the chain's final is the final step. A scan that starts
// after the final step finds another hypotheses record and refuses it too.
// The draw key's epoch rule is applied to its block; until that epoch starts
// the draw key is refused. Once it has, the snapshot rule names the last
// block of epoch N - 1 before its cutoff, which Koios must name too, once the
// first block of N is 2,160 blocks deep.
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
import { verifyFinalFreeze, drawKey, readTx, ruleSnapshot, sha256hex } from '../../src/freeze.mjs';
import { hashList } from '../../src/hash.mjs';
import { q } from '../../src/db.mjs';
import { Koios } from '../../src/koios.mjs';

const DIR = process.env.RESEARCH_CORPUS_REHEARSAL_DIR;
// The labels of the hypotheses and final steps, newest rehearsal format first.
const HYPOTHESES_STEP = ['hypotheses', 'core-only-freeze'];
const FINAL_STEP = ['final', 'typed-freeze'];

test('T13 freeze checks on the preprod rehearsal records', { skip: !DIR || !existsSync(join(DIR || '.', 'state.json')) ? 'set RESEARCH_CORPUS_REHEARSAL_DIR' : false, timeout: 600000 }, async () => {
  const state = JSON.parse(readFileSync(join(DIR, 'state.json'), 'utf8'));
  const key = JSON.parse(readFileSync(join(DIR, '..', '..', 'identities', 'rehearsal', 'public.json'), 'utf8')).signing_public_key;
  const tx = Object.fromEntries(state.steps.map((s) => [s.label, s.txHash]));
  const hypStep = HYPOTHESES_STEP.find((l) => tx[l]);
  const finalStep = FINAL_STEP.find((l) => tx[l]);
  assert.ok(hypStep && finalStep, `the rehearsal's steps name a hypotheses and a final freeze: ${Object.keys(tx).join(', ')}`);
  const finalDoc = join(DIR, finalStep, 'pre-registration.md');
  const citesHypotheses = readFileSync(finalDoc, 'utf8').includes(`web+cardano://transaction/${tx[hypStep]}/metadata/309`);
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
    const fromBlock = (await readTx(c, blocks, tx[hypStep])).block.block_no;
    const base = { client: c, blocks, preregPath: finalDoc, studyKey: key, codeDigests: hashList(), tipBlockNo: Number(tip.block_no), fromBlock };
    const v = await verifyFinalFreeze({ ...base, freezeTx: tx[finalStep], hypothesesTx: tx[hypStep] });
    const byName = Object.fromEntries(v.checks.map((x) => [x.name, x.ok]));
    for (const n of ['hypotheses_record_on_chain', 'hypotheses_tx_is_the_chains', 'final_record_on_chain', 'final_tx_carries_the_document', 'freeze_tx_is_the_chains', 'freeze_tx_in_database', 'freeze_block_depth', 'label_674_is_document_digest', 'label_309_record', 'document_is_an_item', 'signed_by_study_key', 'record_has_no_supersedes', 'document_names_study_key', 'document_lists_every_other_item', 'hypotheses_block_earlier', 'hypotheses_document_differs']) {
      assert.equal(byName[n], true, n);
    }
    for (const n of ['document_names_one_code_manifest', 'document_names_one_check_log', 'code_files_are_items']) assert.equal(byName[n], false, `${n}: what a rehearsal cannot meet`);
    assert.equal(byName.document_cites_hypotheses_record, citesHypotheses, 'the document cites the hypotheses record when its text carries the URI');
    assert.equal(v.ok, false);
    // The hypotheses record as reported: its items from the signed content,
    // and the document's digest from the carrier the final document cites.
    assert.equal(v.hypotheses.items_sha256.length, each[hypStep].items);
    assert.equal(v.hypotheses.cited_tx, citesHypotheses ? tx[hypStep] : null);
    assert.equal(v.hypotheses.document_sha256, citesHypotheses ? sha256hex(readFileSync(join(DIR, hypStep, 'pre-registration.md'))) : null);
    // Found from the chain alone, without naming either transaction.
    const found = await verifyFinalFreeze(base);
    assert.equal(found.freeze.tx, tx[finalStep]);
    assert.equal(found.hypotheses.tx, tx[hypStep]);
    // The retype and the hypotheses step are not the chain's final.
    const vr = await verifyFinalFreeze({ ...base, freezeTx: tx.retype });
    assert.equal(Object.fromEntries(vr.checks.map((x) => [x.name, x])).freeze_tx_is_the_chains.ok, false);
    assert.match(vr.checks.find((x) => x.name === 'freeze_tx_is_the_chains').detail, new RegExp(tx[finalStep]));
    const v2 = await verifyFinalFreeze({ ...base, freezeTx: tx[hypStep], preregPath: join(DIR, hypStep, 'pre-registration.md') });
    assert.equal(v2.ok, false);
    // A scan starting after the final step has another hypotheses record.
    const later = await verifyFinalFreeze({ ...base, freezeTx: tx[finalStep], hypothesesTx: tx[hypStep], fromBlock: v.freeze.block_no + 1 });
    assert.equal(Object.fromEntries(later.checks.map((x) => [x.name, x.ok])).hypotheses_tx_is_the_chains, false);
    // The draw key for the final step's block.
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
    // the final step's once its epoch has started, and the stand-in's.
    const ruled = async (epochN) => {
      // The last block of epoch N - 1 before its cutoff, and the first block
      // of epoch N, read here with their own SQL.
      const last = (await c.query(`SELECT block_no, encode(hash, 'hex') AS hash FROM block WHERE epoch_no = $1 AND epoch_slot_no < $2 ORDER BY id DESC LIMIT 1`, [epochN - 1, 432000 - 172800])).rows[0];
      const firstN = (await c.query('SELECT block_no FROM block WHERE epoch_no = $1 ORDER BY id LIMIT 1', [epochN])).rows[0];
      try {
        const rs = await ruleSnapshot({ client: c, blocks, network: 'preprod', n: epochN, koios: new Koios('preprod'), tipBlockNo: Number(tip.block_no) });
        assert.equal(rs.block.hash, last.hash, 'the last block of epoch N - 1 before its cutoff');
        assert.equal(rs.confirmation.koios.hash, last.hash, 'Koios names the same block');
        assert.equal(rs.confirmation.first_block_of_n.block_no, Number(firstN.block_no));
        assert.ok(rs.confirmation.db_depth >= 2160 && rs.confirmation.koios.depth >= 2160);
        return { n: epochN, block_no: Number(rs.block.block_no), hash: rs.block.hash, rule: rs.rule, confirmation: rs.confirmation };
      } catch (e) {
        assert.ok(!firstN || Number(tip.block_no) - Number(firstN.block_no) < 2160, e.message);
        assert.match(e.message, /2160 deep|does not yet hold/);
        return { n: epochN, refused: e.message };
      }
    };
    const snapshot = started ? await ruled(n) : null;
    const st = await readTx(c, blocks, S1_SEEDING_TX);
    const standInDraw = await drawKey({ client: c, blocks, network: 'preprod', block: st.block, koios: new Koios('preprod') });
    const standInSnapshot = await ruled(standInDraw.n);
    assert.ok(standInSnapshot.hash, 'the stand-in\'s draw epoch is long past');
    record('T13', { steps: { hypotheses: hypStep, final: finalStep }, cites_hypotheses: citesHypotheses, records: each, from_block: fromBlock, checks: v.checks, retype_checks: vr.checks, freeze: v.freeze, hypotheses: v.hypotheses, draw, expected_n: n, tip_epoch: Number(tip.epoch_no), snapshot, stand_in: { n: standInDraw.n, snapshot: standInSnapshot } });
  } finally {
    await c.end();
  }
});
