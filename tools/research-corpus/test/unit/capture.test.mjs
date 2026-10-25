// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// capture-strata against a fake CoinGecko and a fake token registry: the
// exclusions (ADA, bridged or wrapped by category or by an asset_platform_id
// other than cardano, rulings, Cardano-first rulings, no Cardano asset, the
// named tokens), part 4 (stablecoins by category, tokenized commodities by
// category or by a commodity ruling, a bridge copy of a stablecoin kept out,
// every coin of the ranking read however far past the part 2 bound, a part 4
// coin without a registry match left unsettled), the three forms of
// CoinGecko's Cardano contract (policy and name, policy alone, CIP-14
// fingerprint), the registry cross-check, and the provenance (endpoint, Date
// header, SHA-256 of the raw ranking). Registry file names in upper-case hex and tickers with stray
// spaces still match. BLAKE2b against Node's 64-byte BLAKE2b and the CIP-14
// test vectors (cardano-foundation/CIPs@befcdb75, CIP-0014, "Test Vectors").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { captureStrata, fingerprint, resolveSubject, classifyCoin, CONFIRMED } from '../../src/strata-capture.mjs';
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

test('classing by CoinGecko categories, names and the commodity rulings', () => {
  const ruled = new Map([['gold-ruled', { reason: 'a commodity ruling' }]]);
  assert.deepEqual(classifyCoin({ id: 'cardano', name: 'Cardano' }, []), { excluded: 'ADA itself' });
  assert.deepEqual(classifyCoin({ id: 'x', name: 'X' }, ['Cardano Ecosystem', 'USD Stablecoin']), { part: 4, kind: 'stablecoin', basis: 'CoinGecko category "USD Stablecoin"' });
  assert.match(classifyCoin({ id: 'x', name: 'X' }, ['Bridged-Tokens']).excluded, /bridged/);
  assert.match(classifyCoin({ id: 'x', name: 'X' }, ['Wrapped-Tokens']).excluded, /wrapped/);
  // A bridge copy of a stablecoin is out of both parts, whatever the order of
  // its categories.
  assert.match(classifyCoin({ id: 'x', name: 'X' }, ['Stablecoins', 'Bridged USDC']).excluded, /bridged/);
  assert.match(classifyCoin({ id: 'wanchain-bridged-usdc-cardano', name: 'Wanchain Bridged USDC (Cardano)' }, ['Stablecoins']).excluded, /bridged/);
  assert.deepEqual(classifyCoin({ id: 'g', name: 'G' }, ['Tokenized Gold']), { part: 4, kind: 'tokenized commodity', basis: 'CoinGecko category "Tokenized Gold"' });
  assert.equal(classifyCoin({ id: 's', name: 'S' }, ['Tokenized Silver']).kind, 'tokenized commodity');
  assert.equal(classifyCoin({ id: 'c', name: 'C' }, ['Tokenized Commodities']).kind, 'tokenized commodity');
  assert.equal(classifyCoin({ id: 'gold-ruled', name: 'R' }, ['Cardano Ecosystem'], ruled).basis, 'rulings file: a commodity ruling');
  // Words that only contain the commodity names do not count.
  assert.deepEqual(classifyCoin({ id: 'm', name: 'M' }, ['Goldfinch Ecosystem', 'Silverback Memes']), { part: 2 });
  assert.deepEqual(classifyCoin({ id: 'snek', name: 'Snek' }, ['Meme', 'Cardano Ecosystem']), { part: 2 });
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
  const coin = (id, symbol, name, contract, categories = ['Cardano Ecosystem'], platform = 'cardano') => ({ id, symbol, name, contract, categories, platform });
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
    coin('theta', 'the', 'Theta', P('e3') + '4142'),
    coin('bridgy', 'brg', 'Bridgy', P('b9') + '01', ['Cardano Ecosystem'], 'ethereum'),
    coin('cardfirst', 'cf', 'Cardano First', P('c9') + '01', ['Cardano Ecosystem'], 'base'),
    // Past the part 2 bound of 6 candidates: a part 2 coin listed by id
    // only, and part 4 coins still read.
    coin('late', 'lat', 'Late', P('d9') + '01'),
    coin('gold-token', 'gld', 'Gold Token', P('ca') + '474c44', ['Cardano Ecosystem', 'Tokenized Gold']),
    coin('ruled-gold', 'rgd', 'Ruled Gold', P('cb') + '01', ['Cardano Ecosystem']),
    coin('eth-stable', 'eus', 'Eth Stable', P('cc') + '01', ['Stablecoins'], 'ethereum'),
    coin('bridged-stable', 'bus', 'Bridged Stable', P('cd') + '01', ['Stablecoins', 'Bridged USDT']),
    coin('stable-unmapped', 'sun', 'Stable Unmapped', P('ce') + '01', ['Stablecoins'])
  ];
  const registry = new Map([
    [P('a1') + '414c50', { ticker: 'ALP', name: 'Alpha' }],
    [P('b1') + '424554', { ticker: 'BET', name: 'Beta token' }],
    [P('d1') + '44454c', { ticker: 'DEL', name: 'Delta' }],
    [P('e1') + '01', { ticker: 'OTHER', name: 'Other' }],
    [P('e2') + '01', { ticker: 'ETX', name: 'eta' }],
    [P('e3') + '4142', { ticker: 'THE ', name: 'Theta', file: P('E3') + '4142' }],
    [P('b9') + '01', { ticker: 'BRG', name: 'Bridgy' }],
    [P('c9') + '01', { ticker: 'CF', name: 'Cardano First' }],
    [P('a2') + '01', { ticker: 'SUSD', name: 'Stable USD' }],
    [P('ca') + '474c44', { ticker: 'GLD', name: 'Gold Token' }],
    [P('cb') + '01', { ticker: 'RGD', name: 'Ruled Gold' }],
    [P('cd') + '01', { ticker: 'BUS', name: 'Bridged Stable' }],
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
    return reply(JSON.stringify({ id, asset_platform_id: c.platform, categories: c.categories, detail_platforms: c.contract ? { cardano: { contract_address: c.contract } } : {} }));
  };
  const named = [{ project: 'HOSKY', stratum: 'HOSKY', class: 'FT', policy: HOSKY.policy, asset_name: HOSKY.asset_name, nft_top_exclude: false }];
  const rulings = {
    exclusions: [{ coingecko_id: 'ruled', reason: 'bridged: its Cardano token is a bridge copy', source: 'a ruling' }],
    cardano_first: [{ coingecko_id: 'cardfirst', reason: 'first issued on Cardano', source: 'a ruling' }],
    commodities: [{ coingecko_id: 'ruled-gold', reason: 'a tokenized commodity', source: 'a ruling' }]
  };
  const doc = await captureStrata({ named, rulings, maxCandidates: 6, spacingMs: 0, fetchImpl, now: () => new Date('2026-10-21T20:00:00Z') });
  assert.equal(doc.format, 'research-corpus-strata-v3');
  // Part 4, in ranking order, every coin read however far past the part 2
  // bound; a bridge copy of a stablecoin stays out; a part 4 coin without a
  // registry match is neither taken nor excluded.
  assert.deepEqual(doc.part4.map((c) => [c.rank, c.coingecko_id, c.kind]), [
    [1, 'stable-usd', 'stablecoin'],
    [2, 'gold-token', 'tokenized commodity'],
    [3, 'ruled-gold', 'tokenized commodity']
  ]);
  assert.equal(doc.part4[2].basis, 'rulings file: a tokenized commodity');
  assert.deepEqual(doc.unsettled.map((u) => [u.coingecko_id, u.registry.match]), [['stable-unmapped', 'absent']]);
  assert.match(doc.unsettled[0].question, /no registry cross-check/);
  assert.deepEqual(doc.provenance.coingecko.beyond_candidate_bound, ['late']);
  assert.equal(doc.provenance.coingecko.coins_in_ranking, coins.length);
  assert.deepEqual(doc.candidates.map((c) => [c.rank, c.coingecko_id, c.resolved_by, c.registry.match]), [
    [1, 'alpha', 'coingecko contract', 'ticker'],
    [2, 'beta', 'registry: the only subject under the policy', 'ticker'],
    [3, 'delta', 'registry: CIP-14 fingerprint', 'ticker'],
    [4, 'eta', 'coingecko contract', 'name'],
    [5, 'theta', 'coingecko contract', 'ticker'],
    [6, 'cardfirst', 'coingecko contract', 'ticker']
  ]);
  assert.equal(doc.candidates[5].cardano_first.reason, 'first issued on Cardano');
  assert.deepEqual(doc.provenance.rulings, rulings);
  assert.equal(doc.candidates[1].asset_name, '424554');
  const reasons = Object.fromEntries(doc.excluded.map((e) => [e.coingecko_id, e.reason]));
  assert.equal(reasons.cardano, 'ADA itself');
  assert.equal(reasons['stable-usd'], undefined, 'a Cardano-issued stablecoin is a part 4 coin, not an exclusion');
  assert.match(reasons['some-bridged-usdc-cardano'], /bridged/);
  assert.match(reasons['eth-stable'], /asset_platform_id is ethereum/);
  assert.equal(doc.excluded.find((e) => e.coingecko_id === 'eth-stable').part, 4);
  assert.match(reasons['bridged-stable'], /bridged \(CoinGecko category "Bridged USDT"\)/);
  assert.equal(reasons.hosky, 'named in part 1');
  assert.equal(reasons.gamma, 'no Cardano native asset listed');
  assert.match(reasons.eps, /token registry: ticker OTHER/);
  assert.match(reasons.zeta, /no mapping/);
  assert.match(reasons.ruled, /bridge copy/);
  assert.match(reasons.bridgy, /bridged: CoinGecko asset_platform_id is ethereum/);
  assert.equal(doc.provenance.coingecko.ranking[0].sha256, createHash('sha256').update(marketsText).digest('hex'));
  assert.equal(doc.provenance.coingecko.ranking[0].response_date, 'Wed, 21 Oct 2026 20:00:00 GMT');
  assert.match(doc.provenance.coingecko.ranking[0].endpoint, /category=cardano-ecosystem&order=market_cap_desc/);
  assert.equal(doc.provenance.registry.commit, 'f'.repeat(40));
  assert.deepEqual(doc.provenance.confirmed_by_adam.map((c) => c.project), ['HOSKY', 'SNEK', 'World Mobile Token X (WMTX)', 'Nuvola Digital (NVL)']);
  assert.equal(calls429, 2, 'a 429 is retried');
});
