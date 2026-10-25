// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The scam screen. The list's capture from a git clone built here: the
// extract's form (trimmed, lowercased, distinct, sorted, only the .json
// files directly in src/entries/, the template placeholder left out and
// counted), its SHA-256 against an independent statement of it, the license
// file found or not, a run's reading of it refused when the digest or the
// commit differs, and malformed entry files stopping the capture. Then the
// screen's SQL on PGlite: fingerprints to policies through
// multi_asset.fingerprint, the whole policy kept out of every part (a named
// row, a part 2 candidate with the next one taken, an NFT policy with the next
// one ranked, a part 4 coin under a listed policy's sibling asset), the
// descriptive report of excluded policies that hold unlisted assets, and the
// sensitivity analysis for a later list on a finished run. Also the
// recomputation of each resolved fingerprint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureRepo } from '../lib/gitfixture.mjs';
import { captureScamList, loadScamList, fingerprintOf, descendsFrom, fingerprintMismatches } from '../../src/scam-list.mjs';
import { fingerprint } from '../../src/strata-capture.mjs';
import { freshDb } from '../lib/pglite.mjs';
import { defaultSettings, sqlParams } from '../../src/params.mjs';
import { scamRecheck, runPipeline } from '../../src/pipeline.mjs';
import { mark } from '../../src/runner.mjs';

const P = (b) => b.repeat(28);
const sha = (t) => createHash('sha256').update(t).digest('hex');
const fpA = fingerprint(P('a1') + '01');
const fpB = fingerprint(P('b1') + '01');
const fpC = fingerprint(P('c1') + '02');
const fpLater = fingerprint(P('d1') + '01');
const entry = (assets) => JSON.stringify({ domains: ['scam.example'], associated_addresses: [], related_assets: assets, description: 'a campaign' }, null, 2) + '\n';

function lists() {
  const repo = fixtureRepo();
  const first = {
    'README.md': '# fixture\n',
    'src/entries/one.json': entry([fpB, ` ${fpA} `, fpA]),
    'src/entries/two.json': entry([fpA.toUpperCase(), fpC]),
    'src/entries/_allowlist.json': JSON.stringify({ allowlist: ['genuine.example'] }),
    'src/entries/template.json': entry(['asset1....']),
    'src/entries/sub/ignored.json': entry([fpLater]),
    'src/entries/notes.txt': `${fpLater}\n`
  };
  const c1 = repo.commit(first, 'first');
  const c2 = repo.commit({ ...first, 'src/entries/three.json': entry([fpLater]), LICENSE: 'MIT License\n' }, 'second');
  return { repo, c1, c2 };
}

test('the list: the extract\'s form and digest, the license file, the commit', () => {
  const { repo, c1, c2 } = lists();
  try {
    const one = captureScamList({ clone: repo.dir, rev: c1, now: () => new Date('2026-10-25T00:00:00Z') });
    const want = [fpA, fpB, fpC].sort().map((x) => `${x}\n`).join('');
    assert.equal(one.extract.text, want);
    assert.equal(one.record.extract.sha256, sha(want));
    assert.deepEqual(one.record.source, { repository: 'github.com/Tastenkunst/eternl-guard', folder: 'src/entries', commit: c1, commit_time: '2026-01-01T00:00:00+00:00' });
    assert.deepEqual([one.record.extract.n_fingerprints, one.record.extract.n_entry_files, one.record.extract.n_mentions, one.record.extract.n_invalid], [3, 4, 6, 1]);
    assert.deepEqual(one.extract.invalid.map((x) => [x.path, x.value]), [['src/entries/template.json', 'asset1....']]);
    assert.deepEqual(one.record.license, { present: false, files: [] });
    // HEAD is the later commit, with a license file and one more fingerprint.
    const two = captureScamList({ clone: repo.dir });
    assert.equal(two.record.source.commit, c2);
    assert.equal(two.record.extract.n_fingerprints, 4);
    assert.deepEqual(two.record.license, { present: true, files: [{ path: 'LICENSE', sha256: sha('MIT License\n') }] });
    assert.equal(descendsFrom(repo.dir, c2, c1), true);
    assert.equal(descendsFrom(repo.dir, c1, c2), false);
    // A run reads it again; a digest or a commit that differs is refused.
    const dir = mkdtempSync(join(tmpdir(), 'rc-scam-'));
    try {
      const path = join(dir, 'record.json');
      writeFileSync(path, JSON.stringify(one.record));
      assert.deepEqual(loadScamList(path, repo.dir).fingerprints, [fpA, fpB, fpC].sort());
      writeFileSync(path, JSON.stringify({ ...one.record, extract: { ...one.record.extract, sha256: sha('other') } }));
      assert.throws(() => loadScamList(path, repo.dir), /has SHA-256/);
      writeFileSync(path, JSON.stringify({ ...one.record, source: { ...one.record.source, commit: 'f'.repeat(40) } }));
      assert.throws(() => loadScamList(path, repo.dir), /is not in the clone/);
      writeFileSync(path, JSON.stringify({ ...one.record, source: { ...one.record.source, repository: 'github.com/someone/else' } }));
      assert.throws(() => loadScamList(path, repo.dir), /must name github\.com\/Tastenkunst\/eternl-guard/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('the list: an entry file that is not JSON, or whose related_assets is not a list of strings, stops the capture', () => {
  for (const [bad, want] of [['{ "related_assets": [', /not valid UTF-8 JSON/], [JSON.stringify({ related_assets: fpA }), /is not an array/], [JSON.stringify({ related_assets: [{ asset: fpA }] }), /not a string/]]) {
    const repo = fixtureRepo();
    try {
      repo.commit({ 'src/entries/ok.json': entry([fpA]), 'src/entries/bad.json': bad });
      assert.throws(() => captureScamList({ clone: repo.dir }), want);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  }
  assert.match(fingerprintOf(fpA.slice(0, 10) + fpA.slice(10).toUpperCase()).reason, /mixed case/);
  assert.match(fingerprintOf('addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x').reason, /prefix addr|payload/);
  assert.equal(fingerprintOf(fpA.toUpperCase()).fingerprint, fpA);
});

test('a run refuses a scam-list record given without the clone to read it from', async () => {
  await assert.rejects(runPipeline({ runId: 'x', scamList: 'record.json', log: () => {} }), /--scam-list needs --scam-clone/);
});

test('a fingerprint db-sync stored that differs from CIP-14 of policy and name is caught', () => {
  const rows = [{ fingerprint: fpA, policy: P('a1'), name: '01' }, { fingerprint: fpB, policy: P('a1'), name: '02' }];
  assert.deepEqual(fingerprintMismatches(rows), [rows[1]]);
});

// The screen's SQL on a small chain: multi_asset with db-sync's fingerprint
// column, the life table, the frame, and the strata steps.
async function screenDb(fingerprints) {
  const { db, runBlock, rows, blocks } = await freshDb();
  await db.exec(`
    CREATE TABLE public.multi_asset (id bigint PRIMARY KEY, policy bytea, name bytea, fingerprint varchar);
    CREATE TABLE public.ma_tx_mint (id serial PRIMARY KEY, ident bigint, quantity numeric, tx_id bigint);
    CREATE TABLE study.frame (frame text, sa_id bigint, eligible boolean);
    CREATE TABLE study.txo (tx_out_id bigint PRIMARY KEY, created_tx bigint, consumed_tx bigint, sa_id bigint, script_pay boolean);
    CREATE TABLE study.txo_asset (tx_out_id bigint, ident bigint, quantity numeric);
    CREATE TABLE study.asset (ident bigint PRIMARY KEY, policy bytea, name bytea, label integer);
    CREATE TABLE study.draw_order (frame text, sa_id bigint, k bigint);
    CREATE TABLE study.sample (frame text, kind text, stratum text, sa_id bigint, draw_rank bigint, prevalence_member boolean, split text, excluded_6_1 boolean, fragmented boolean,
                               PRIMARY KEY (frame, kind, stratum, sa_id));
  `);
  for (let w = 1; w <= 6; w++) await db.query(`INSERT INTO study.frame VALUES ('recent', $1, true)`, [w]);
  let ident = 0;
  let out = 0;
  const asset = async (policy, name, { qty = 1, holders = [] } = {}) => {
    ident++;
    await db.query(`INSERT INTO public.multi_asset VALUES ($1, decode($2, 'hex'), decode($3, 'hex'), $4)`, [ident, policy, name, fingerprint(policy + name)]);
    await db.query(`INSERT INTO study.asset VALUES ($1, decode($2, 'hex'), decode($3, 'hex'), NULL)`, [ident, policy, name]);
    await db.query(`INSERT INTO public.ma_tx_mint (ident, quantity, tx_id) VALUES ($1, $2, 1)`, [ident, qty]);
    for (const w of holders) {
      out++;
      await db.query(`INSERT INTO study.txo VALUES ($1, 1, NULL, $2, false)`, [out, w]);
      await db.query(`INSERT INTO study.txo_asset VALUES ($1, $2, $3)`, [out, ident, qty === 1 ? 1 : 10]);
    }
  };
  // a1: a named FT (listed, a1/01) and a part 4 coin under the same policy
  // (a1/02, unlisted). b1/01: part 2's first candidate, listed. f1/01: the
  // next candidate. c1: an NFT policy with three holders, one asset of it
  // listed (c1/02), so it is screened and e1 ranks. d1/01: part 4's second
  // coin, which only the later list names.
  await asset(P('a1'), '01', { qty: 1000, holders: [1, 2] });
  await asset(P('a1'), '02', { qty: 1000, holders: [3, 4, 5] });
  await asset(P('b1'), '01', { qty: 1000, holders: [1, 2, 3] });
  await asset(P('f1'), '01', { qty: 1000, holders: [4] });
  await asset(P('c1'), '01', { holders: [1] });
  await asset(P('c1'), '02', { holders: [2] });
  await asset(P('c1'), '03', { holders: [3] });
  await asset(P('e1'), '01', { holders: [4] });
  await asset(P('e1'), '02', { holders: [5] });
  await asset(P('d1'), '01', { qty: 1000, holders: [6] });
  await runBlock('strata_fn');
  await runBlock('strata_list_table');
  await db.query(blocks.get('strata_list_load').statements[0], [JSON.stringify([{ ord: 1, stratum: 'Named A', project: 'a', class: 'FT', policy: P('a1'), asset_name: '01', nft_top_exclude: false }])]);
  await db.query(blocks.get('strata_candidate_load').statements[0], [JSON.stringify([
    { rank: 1, stratum: 'Cand B', project: 'b', policy: P('b1'), asset_name: '01' },
    { rank: 2, stratum: 'Cand F', project: 'f', policy: P('f1'), asset_name: '01' }
  ])]);
  await db.query(blocks.get('strata_sc_load').statements[0], [JSON.stringify([
    { rank: 1, stratum: 'Stable A2', project: 's', kind: 'stablecoin', policy: P('a1'), asset_name: '02' },
    { rank: 2, stratum: 'Stable D', project: 'd', kind: 'stablecoin', policy: P('d1'), asset_name: '01' }
  ])]);
  await runBlock('scam_list_table');
  await db.query(blocks.get('scam_fp_load').statements[0], [JSON.stringify(fingerprints)]);
  const params = sqlParams({ network: 'preprod', settings: { ...defaultSettings(), ft_floor: 1, sc_floor: 1, ft_n: 1, nft_top_n: 1 }, snapshot: { id: 1, t: 100 }, h: '00'.repeat(32), windows: { recent: { lo: 1, hi: 100, t_start: 0, first_epoch: 1, last_epoch: 1 }, peak: { lo: 1, hi: 100, t_start: 0, first_epoch: 1, last_epoch: 1 } } });
  for (const step of ['scam_policy', 'ft_floor', 'sc_floor', 'nft_top', 'strata']) await runBlock(step, params);
  return { db, rows, blocks, params };
}

test('the screen keeps every listed policy out of every part, and the next candidate takes its place', async () => {
  const unresolved = fingerprint(P('99') + '01');
  const { db, rows, blocks, params } = await screenDb([fpA, fpB, fpC, unresolved].sort());
  const { fill } = await import('../../src/sqlfile.mjs');
  const q = async (name) => (await db.query(fill(blocks.get(name).statements[0], params))).rows;
  assert.deepEqual((await rows(`SELECT encode(policy, 'hex') AS p FROM study.scam_policy ORDER BY 1`)).map((r) => r.p.slice(0, 2)), ['a1', 'b1', 'c1']);
  const counts = (await q('scam_counts'))[0];
  assert.deepEqual([counts.n_fingerprints, counts.n_resolved, counts.n_unresolved, counts.n_policies].map(Number), [4, 3, 1, 3]);
  const strata = (await rows(`SELECT stratum, part, encode(policy, 'hex') AS p FROM study.strata_all ORDER BY ord`)).map((r) => [r.stratum, r.part, r.p.slice(0, 2)]);
  assert.deepEqual(strata, [['Cand F', 'coingecko', 'f1'], ['nft-top-01', 'nft-top', 'e1'], ['Stable D', 'stable-commodity', 'd1']]);
  assert.deepEqual((await rows(`SELECT rank, screened, qualifies, taken FROM study.ft_floor ORDER BY rank`)).map((r) => [r.rank, r.screened, r.qualifies, r.taken]), [[1, true, false, false], [2, false, true, true]]);
  assert.deepEqual((await rows(`SELECT rank, screened, taken FROM study.sc_floor ORDER BY rank`)).map((r) => [r.rank, r.screened, r.taken]), [[1, true, false], [2, false, true]]);
  assert.deepEqual((await q('scam_screened_rows')).map((r) => [r.part, Number(r.rank), r.stratum]), [['coingecko', 1, 'Cand B'], ['named', 1, 'Named A'], ['stable-commodity', 1, 'Stable A2']]);
  // Descriptive: a1 holds a2, an unlisted asset of three eligible holders; c1
  // two unlisted assets of one holder each; b1 nothing unlisted.
  assert.deepEqual((await q('scam_policy_report')).map((r) => [r.policy.slice(0, 2), Number(r.n_listed), Number(r.n_unlisted), Number(r.n_unlisted_holders)]), [['a1', 1, 1, 3], ['c1', 1, 2, 2]]);
});

test('with no list the screen excludes nothing', async () => {
  const { rows } = await screenDb([]);
  assert.deepEqual((await rows(`SELECT stratum FROM study.strata_all ORDER BY ord`)).map((r) => r.stratum), ['Named A', 'Cand B', 'nft-top-01', 'Stable A2', 'Stable D']);
});

test('scam-recheck: the strata a later list flags, on a finished run, without changing it', async () => {
  const { repo, c1 } = lists();
  const home = mkdtempSync(join(tmpdir(), 'rc-recheck-'));
  const prev = process.env.RESEARCH_CORPUS_HOME;
  process.env.RESEARCH_CORPUS_HOME = home;
  try {
    const first = captureScamList({ clone: repo.dir, rev: c1 });
    const later = captureScamList({ clone: repo.dir });
    const { db, rows } = await screenDb(first.extract.fingerprints);
    const path = join(home, 'later.json');
    writeFileSync(path, JSON.stringify(later.record));
    const param = (key, value) => db.query(`INSERT INTO study.param VALUES ('r1', $1, $2::jsonb)`, [key, JSON.stringify(value)]);
    await db.query(`INSERT INTO study.run VALUES ('r1', 'preprod')`);
    await param('mode', 'test');
    await param('scam_list', { commit: c1, extract_sha256: first.record.extract.sha256 });
    await assert.rejects(scamRecheck({ client: db, runId: 'r1', recordPath: path, clone: repo.dir, network: 'preprod' }), /has not finished/);
    await param('finished', { at: 'now' });
    await assert.rejects(scamRecheck({ client: db, runId: 'r1', recordPath: path, clone: repo.dir, network: 'preprod' }), /does not belong to run r1/);
    await db.exec(`COMMENT ON TABLE study.strata_all IS '${mark('r1')}'`);
    const before = await rows(`SELECT * FROM study.strata_all ORDER BY ord`);
    const r = await scamRecheck({ client: db, runId: 'r1', recordPath: path, clone: repo.dir, network: 'preprod' });
    assert.deepEqual(r.strata_flagged, ['Stable D']);
    assert.deepEqual(r.strata_kept, ['Cand F', 'nft-top-01']);
    assert.equal(r.later_descends_from_frozen, true);
    assert.equal(r.later.commit, later.record.source.commit);
    assert.deepEqual(await rows(`SELECT * FROM study.strata_all ORDER BY ord`), before);
    await db.query(`UPDATE study.param SET value = '"live-fire"' WHERE run_id = 'r1' AND key = 'mode'`);
    await assert.rejects(scamRecheck({ client: db, runId: 'r1', recordPath: path, clone: repo.dir, network: 'preprod' }), /a live-fire run/);
  } finally {
    if (prev === undefined) delete process.env.RESEARCH_CORPUS_HOME;
    else process.env.RESEARCH_CORPUS_HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }
});
