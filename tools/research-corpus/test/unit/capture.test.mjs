// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// capture-strata against a fake CoinGecko and a fake token registry: the
// exclusions (ADA, stablecoins, bridged or wrapped, rulings, no Cardano asset,
// the named tokens), the three forms of CoinGecko's Cardano contract (policy
// and name, policy alone, CIP-14 fingerprint), the registry cross-check, and
// the provenance (endpoint, Date header, SHA-256 of the raw ranking). Registry
// file names in upper-case hex and tickers with stray spaces still match. BLAKE2b
// against Node's 64-byte BLAKE2b and the CIP-14 test vectors
// (cardano-foundation/CIPs@befcdb75, CIP-0014, "Test Vectors").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { captureStrata, fingerprint, resolveSubject, categoryExclusion, CONFIRMED } from '../../src/strata-capture.mjs';
import { blake2b } from '../../src/blake2b.mjs';

const P = (b) => b.repeat(28);
const HOSKY = CONFIRMED[0];

test('BLAKE2b and CIP-14 fingerprints', () => {
  for (const s of ['', 'abc', 'x'.repeat(128), 'y'.repeat(129), 'z'.repeat(300)]) {
    assert.equal(blake2b(Buffer.from(s)).toString('hex'), createHash('blake2b512').update(s).digest('hex'));
  }
  const vectors = [
    ['7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373', '', 'asset1rjklcrnsdzqp65wjgrg55sy9723kw09mlgvlc3'],
    ['7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc37e', '', 'asset1nl0puwxmhas8fawxp8nx4e2q3wekg969n2auw3'],
    ['1e349c9bdea19fd6c147626a5260bc44b71635f398b67c59881df209', '', 'asset1uyuxku60yqe57nusqzjx38aan3f2wq6s93f6ea'],
    ['7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373', '504154415445', 'asset13n25uv0yaf5kus35fm2k86cqy60z58d9xmde92'],
    ['1e349c9bdea19fd6c147626a5260bc44b71635f398b67c59881df209', '504154415445', 'asset1hv4p5tv2a837mzqrst04d0dcptdjmluqvdx9k3'],
    ['1e349c9bdea19fd6c147626a5260bc44b71635f398b67c59881df209', '7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373', 'asset1aqrdypg669jgazruv5ah07nuyqe0wxjhe2el6f'],
    ['7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373', '1e349c9bdea19fd6c147626a5260bc44b71635f398b67c59881df209', 'asset17jd78wukhtrnmjh3fngzasxm8rck0l2r4hhyyt'],
    ['7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373', '0000000000000000000000000000000000000000000000000000000000000000', 'asset1pkpwyknlvul7az0xx8czhl60pyel45rpje4z8w']
  ];
  for (const [p, n, f] of vectors) assert.equal(fingerprint(p + n), f);
});

test('exclusion by CoinGecko categories and names', () => {
  assert.equal(categoryExclusion({ id: 'cardano', name: 'Cardano' }, []), 'ADA itself');
  assert.match(categoryExclusion({ id: 'x', name: 'X' }, ['Cardano Ecosystem', 'USD Stablecoin']), /stablecoin/);
  assert.match(categoryExclusion({ id: 'x', name: 'X' }, ['Bridged-Tokens']), /bridged/);
  assert.match(categoryExclusion({ id: 'x', name: 'X' }, ['Wrapped-Tokens']), /wrapped/);
  assert.match(categoryExclusion({ id: 'wanchain-bridged-usdc-cardano', name: 'Wanchain Bridged USDC (Cardano)' }, []), /bridged/);
  assert.equal(categoryExclusion({ id: 'snek', name: 'Snek' }, ['Meme', 'Cardano Ecosystem']), null);
});

test('resolving a contract to a registry subject', () => {
  const subjects = [P('11') + '4142', P('22') + '01', P('22') + '02', P('33') + '0aff'];
  const tickers = new Map([[P('22') + '01', 'ONE'], [P('22') + '02', 'TWO']]);
  const t = (s) => tickers.get(s);
  assert.equal(resolveSubject(P('11') + '4142', 'ab', subjects, t).subject, P('11') + '4142');
  assert.equal(resolveSubject(P('11'), 'ab', subjects, t).subject, P('11') + '4142');
  assert.equal(resolveSubject(P('22'), 'two', subjects, t).subject, P('22') + '02');
  assert.equal(resolveSubject(P('22'), 'three', subjects, t).subject, null);
  assert.equal(resolveSubject(fingerprint(P('33') + '0aff'), 'x', subjects, t).subject, P('33') + '0aff');
  assert.equal(resolveSubject('0xdeadbeef', 'x', subjects, t).subject, null);
});

test('capture-strata against fakes: candidates in order, every exclusion with its reason, the provenance', async () => {
  const coin = (id, symbol, name, contract, categories = ['Cardano Ecosystem']) => ({ id, symbol, name, contract, categories });
  const coins = [
    coin('cardano', 'ada', 'Cardano', null),
    coin('alpha', 'alp', 'Alpha', P('a1') + '414c50'),
    coin('stable-usd', 'susd', 'Stable USD', P('a2') + '01', ['Cardano Ecosystem', 'Stablecoins']),
    coin('some-bridged-usdc-cardano', 'usdc', 'Some Bridged USDC (Cardano)', P('a3') + '01'),
    coin('hosky', 'hosky', 'Hosky', HOSKY.policy + HOSKY.asset_name),
    coin('beta', 'bet', 'Beta', P('b1')),
    coin('gamma', 'gam', 'Gamma', null),
    coin('delta', 'del', 'Delta', fingerprint(P('d1') + '44454c')),
    coin('eps', 'eps', 'Epsilon', P('e1') + '01'),
    coin('zeta', 'zet', 'Zeta', P('f1') + '01'),
    coin('ruled', 'rul', 'Ruled', P('99') + '01'),
    coin('eta', 'eta', 'Eta', P('e2') + '01'),
    coin('theta', 'the', 'Theta', P('e3') + '4142')
  ];
  const registry = new Map([
    [P('a1') + '414c50', { ticker: 'ALP', name: 'Alpha' }],
    [P('b1') + '424554', { ticker: 'BET', name: 'Beta token' }],
    [P('d1') + '44454c', { ticker: 'DEL', name: 'Delta' }],
    [P('e1') + '01', { ticker: 'OTHER', name: 'Other' }],
    [P('e2') + '01', { ticker: 'ETX', name: 'eta' }],
    [P('e3') + '4142', { ticker: 'THE ', name: 'Theta', file: P('E3') + '4142' }],
    [HOSKY.policy + HOSKY.asset_name, { ticker: 'HOSKY', name: 'HOSKY Token' }]
  ]);
  const marketsText = JSON.stringify(coins.map((c, i) => ({ id: c.id, symbol: c.symbol, name: c.name, market_cap: 1000 - i, market_cap_rank: i + 1 })));
  const reply = (body, status = 200) => ({ status, ok: status < 400, headers: { get: (h) => (h === 'date' ? 'Wed, 21 Oct 2026 20:00:00 GMT' : null) }, text: async () => body });
  let calls429 = 0;
  const fetchImpl = async (url) => {
    if (url.includes('/coins/markets')) return reply(marketsText);
    if (url.includes('/commits/master')) return reply(JSON.stringify({ sha: 'f'.repeat(40) }));
    if (url.includes('/git/trees/')) return reply(JSON.stringify({ truncated: false, tree: [...registry.entries()].map(([s, m]) => ({ path: `mappings/${m.file || s}.json` })) }));
    if (url.includes('raw.githubusercontent.com')) {
      const s = /mappings\/([0-9a-fA-F]+)\.json/.exec(url)[1].toLowerCase();
      const m = registry.get(s);
      return reply(JSON.stringify({ subject: s, ticker: { value: m.ticker }, name: { value: m.name }, decimals: { value: 6 } }));
    }
    const id = decodeURIComponent(/\/coins\/([^?]+)\?/.exec(url)[1]);
    if (id === 'alpha' && calls429++ === 0) return { ...reply('', 429), headers: { get: (h) => (h === 'retry-after' ? '0.01' : null) } };
    const c = coins.find((x) => x.id === id);
    return reply(JSON.stringify({ id, categories: c.categories, detail_platforms: c.contract ? { cardano: { contract_address: c.contract } } : {} }));
  };
  const named = [{ project: 'HOSKY', stratum: 'HOSKY', class: 'FT', policy: HOSKY.policy, asset_name: HOSKY.asset_name, nft_top_exclude: false }];
  const doc = await captureStrata({ named, exclusions: [{ coingecko_id: 'ruled', reason: 'bridged: its Cardano token is a bridge copy', source: 'a ruling' }], maxCandidates: 40, spacingMs: 0, fetchImpl, now: () => new Date('2026-10-21T20:00:00Z') });
  assert.equal(doc.format, 'research-corpus-strata-v2');
  assert.deepEqual(doc.candidates.map((c) => [c.rank, c.coingecko_id, c.resolved_by, c.registry.match]), [
    [1, 'alpha', 'coingecko contract', 'ticker'],
    [2, 'beta', 'registry: the only subject under the policy', 'ticker'],
    [3, 'delta', 'registry: CIP-14 fingerprint', 'ticker'],
    [4, 'eta', 'coingecko contract', 'name'],
    [5, 'theta', 'coingecko contract', 'ticker']
  ]);
  assert.equal(doc.candidates[1].asset_name, '424554');
  const reasons = Object.fromEntries(doc.excluded.map((e) => [e.coingecko_id, e.reason]));
  assert.equal(reasons.cardano, 'ADA itself');
  assert.match(reasons['stable-usd'], /stablecoin/);
  assert.match(reasons['some-bridged-usdc-cardano'], /bridged/);
  assert.equal(reasons.hosky, 'named in part 1');
  assert.equal(reasons.gamma, 'no Cardano native asset listed');
  assert.match(reasons.eps, /token registry: ticker OTHER/);
  assert.match(reasons.zeta, /no mapping/);
  assert.match(reasons.ruled, /bridge copy/);
  assert.equal(doc.provenance.coingecko.ranking[0].sha256, createHash('sha256').update(marketsText).digest('hex'));
  assert.equal(doc.provenance.coingecko.ranking[0].response_date, 'Wed, 21 Oct 2026 20:00:00 GMT');
  assert.match(doc.provenance.coingecko.ranking[0].endpoint, /category=cardano-ecosystem&order=market_cap_desc/);
  assert.equal(doc.provenance.registry.commit, 'f'.repeat(40));
  assert.deepEqual(doc.provenance.confirmed_by_adam.map((c) => c.project), ['HOSKY', 'SNEK', 'World Mobile Token X (WMTX)', 'Nuvola Digital (NVL)']);
  assert.equal(calls429, 2, 'a 429 is retried');
});
