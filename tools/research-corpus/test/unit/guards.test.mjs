// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The mainnet refusals, through runPipeline itself with a stub standing in
// for a mainnet database (db-sync's meta table says mainnet, every probe
// passes, and any other query fails the test): options that would change the
// sample, a missing or mismatched freeze or code manifest, live-fire runs
// without their stated test h, case wallets outside the consented file. Also
// the code manifest comparison and the check log entry a refused live-fire
// run leaves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipeline, DEFAULT_STRATA } from '../../src/pipeline.mjs';
import { formatHashList, hashList } from '../../src/hash.mjs';
import { codeManifestErrors, mainnetOptionErrors, caseWalletErrors } from '../../src/guards.mjs';
import { checkLogPath, verifyLog } from '../../src/checklog.mjs';

const FIXTURE_STRATA = new URL('../fixtures/strata-preprod.json', import.meta.url).pathname;
const STAKE_A = 'stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw';
const STAKE_B = 'stake178phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gtcccycj5';

function stub(network) {
  return {
    async query(sql) {
      if (/FROM public\.meta m/.test(sql)) return { rows: [{ network_name: network, version: 'v', start_time: 't', schema_version: '{"id":1}', extra_migrations: '[]' }] };
      if (/AS inline_datum/.test(sql)) return { rows: [{ tx_in: true, multi_asset: true, ma_tx_out: true, ma_tx_mint: true, metadata_674: true, redeemer: true, inline_datum: true, epoch_nonce: true }] };
      if (/obj_description\(c\.oid/.test(sql)) return { rows: [] };
      if (/DELETE FROM study\.run/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql.replace(/\s+/g, ' ').slice(0, 80)}`);
    },
    async end() {}
  };
}

function withHome(fn) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'rc-guards-'));
    const prev = process.env.RESEARCH_CORPUS_HOME;
    process.env.RESEARCH_CORPUS_HOME = home;
    try {
      await fn(home);
    } finally {
      if (prev === undefined) delete process.env.RESEARCH_CORPUS_HOME;
      else process.env.RESEARCH_CORPUS_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

const run = (opts) => runPipeline({ client: stub('mainnet'), runId: 'guard-test', log: () => {}, snapshot: 'tip', strataList: DEFAULT_STRATA, ...opts });

test('mainnet refusals through runPipeline', withHome(async (home) => {
  const manifest = join(home, 'code-manifest.txt');
  writeFileSync(manifest, formatHashList().replace(/^[0-9a-f]{64}(?= {2}src\/pipeline\.mjs$)/m, '0'.repeat(64)));
  const consented = join(home, 'consented.txt');
  writeFileSync(consented, `# keys\n${STAKE_A}\n`);
  const freeze = { freezeTx: 'aa'.repeat(32), hypothesesTx: 'bb'.repeat(32), prereg: manifest, studyKey: 'cc'.repeat(32) };
  const cases = [
    [{}, /without --freeze-tx/],
    [{ set: ['guard=1000'] }, /--set changes guard/],
    [{ set: ['guard=200000'] }, /without --freeze-tx/],
    [{ strataList: FIXTURE_STRATA, strataGiven: true }, /not the hashed strata file/],
    [{ snapshot: 'ab'.repeat(32) }, /--snapshot must be tip/],
    [{ capture: true }, /no plan capture/],
    [{ standInTx: 'ab'.repeat(32) }, /stand-in for h is for test networks only/],
    [{ hmacKey: manifest }, /study key in secret\/hmac\.key/],
    [{ ...freeze }, /without --code-manifest/],
    [{ ...freeze, codeManifest: manifest }, /differs from the code manifest: differs: src\/pipeline\.mjs/],
    [{ liveFire: { purpose: 'p' } }, /needs --test-h/],
    [{ liveFire: { testH: 'ab'.repeat(32) } }, /needs --purpose/],
    [{ liveFire: { testH: 'ab'.repeat(32), purpose: 'p' }, freezeTx: 'aa'.repeat(32) }, /never a freeze or stand-in/],
    [{ liveFire: { testH: 'ab'.repeat(32), purpose: 'p' }, explain: true, capture: true }, /no plan capture/],
    [{ liveFire: { testH: 'ab'.repeat(32), purpose: 'p' }, consented, caseWallets: [STAKE_B] }, /not in the consented file/]
  ];
  for (const [opts, want] of cases) await assert.rejects(run(opts), want, JSON.stringify(opts));
  // Every refused live-fire run left one entry, with its outcome and no count.
  const v = verifyLog('mainnet');
  assert.deepEqual(v.errors, []);
  assert.equal(v.entries, 5);
  const last = readFileSync(checkLogPath('mainnet'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
  assert.equal(last.type, 'live-fire');
  assert.equal(last.outcome, 'failed');
  assert.match(last.error, /not in the consented file/);
  assert.equal(last.test_h, 'ab'.repeat(32));
  assert.match(last.wallet_level_output, /^deleted /);
}));

test('a test network takes run-time options the mainnet refuses', () => {
  assert.deepEqual(mainnetOptionErrors({ set: ['guard=200000'], strataPath: DEFAULT_STRATA, defaultStrataPath: DEFAULT_STRATA, snapshot: 'tip', nodeVersion: 'v24.1.0' }), []);
  assert.match(mainnetOptionErrors({ nodeVersion: 'v20.19.0' }).join(), /pinned to Node 24/);
  assert.match(mainnetOptionErrors({ set: ['x8_measure=units'], nodeVersion: 'v24.1.0' }).join(), /x8_measure/);
});

test('the code manifest: the hash output itself matches, and every difference is named', () => {
  assert.deepEqual(codeManifestErrors(formatHashList(), hashList()), []);
  const files = hashList();
  const text = formatHashList();
  const dropped = text.split('\n').filter((l) => !l.endsWith('  src/guards.mjs')).join('\n');
  assert.deepEqual(codeManifestErrors(dropped, files), ['not in the manifest: src/guards.mjs']);
  assert.deepEqual(codeManifestErrors(text + `${'0'.repeat(64)}  src/extra.mjs\n`, files), ['missing: src/extra.mjs']);
  assert.throws(() => codeManifestErrors('nothing here', files), /lists no files/);
});

test('case wallets must be consented keys', () => {
  assert.deepEqual(caseWalletErrors([STAKE_A], [STAKE_A, STAKE_B]), []);
  assert.equal(caseWalletErrors([STAKE_B], [STAKE_A]).length, 1);
});
