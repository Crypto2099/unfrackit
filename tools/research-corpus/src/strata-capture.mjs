// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// capture-strata: the candidate lists of parts 2 and 4 of the strata rule,
// read on the date of the hypotheses record from one CoinGecko capture.
//
// 1. CoinGecko's "Cardano Ecosystem" category, ranked by market
//    capitalization (/coins/markets?category=cardano-ecosystem&order=
//    market_cap_desc): the endpoint, the response's Date header, the time it
//    was read and the SHA-256 of the raw response are recorded. Every coin of
//    the ranking is classified from its own CoinGecko detail, whose SHA-256
//    is recorded too, so part 4 can take every stablecoin and tokenized
//    commodity in the capture however far down the ranking it sits.
// 2. Exclusions, in ranking order: ADA itself (coin id cardano); the rulings
//    of the rulings file (data/strata-rulings.json: coin id, reason, source);
//    bridged or wrapped assets, read as CoinGecko's own categories for the
//    coin (any category whose name contains "bridged" or "wrapped") or a coin
//    id or name that says bridged or wrapped; a coin whose CoinGecko
//    asset_platform_id is not cardano, whose Cardano token is therefore a
//    bridge copy of an asset first issued on another chain, unless the
//    rulings file lists it as first issued on Cardano; coins with no Cardano
//    native asset listed; and the tokens named in part 1, which come first.
//    The working definition: an asset is bridged or wrapped when its Cardano
//    token is issued by a bridge against an asset whose original issuance is
//    on another chain; a token first issued on Cardano and later bridged out
//    is not. These exclusions apply to both parts.
// 3. Part 4 or part 2. A coin is a stablecoin when one of its own CoinGecko
//    categories has "stablecoin" in its name, and a tokenized commodity when
//    one of its categories names gold, silver or a commodity ("commodity" or
//    "commodities" as a word), or when the rulings file classes it so
//    (commodities: coin id, reason, source). Stablecoins and tokenized
//    commodities form part 4; every other coin is a part 2 candidate.
// 4. Mapping: CoinGecko's Cardano contract is the policy id followed by the
//    asset name in hex, or the policy id alone, or a CIP-14 fingerprint. A
//    policy alone is resolved to the one registry subject under that policy,
//    or among several to the one whose ticker is the coin's symbol; a
//    fingerprint is resolved by computing the CIP-14 fingerprint of every
//    registry subject (CIP-14, "Specification": bech32 "asset" of the 20-byte
//    BLAKE2b of policy id || asset name).
// 5. Cross-check against the Cardano Foundation token registry
//    (github.com/cardano-foundation/cardano-token-registry, mappings/, read at
//    the commit recorded): the subject (policy id || asset name, CIP-26,
//    "Special Case: Phase-1 Monetary Policies") must have a mapping file whose
//    ticker is the coin's symbol or whose name is the coin's name, ignoring
//    case. A part 2 candidate without a matching mapping is excluded and
//    listed with the reason. The part 4 rule names no registry cross-check,
//    so a part 4 coin without a matching mapping is neither taken nor
//    excluded: it is listed under `unsettled` with its registry reading, and
//    the run refuses a strata file that lists any unsettled coin until the
//    case is decided.
//
// The output is the strata file: the named rows of part 1 as given, the part
// 2 candidates in ranking order (more than ten, so the run can skip those
// under the holder floor; at most maxCandidates), the part 4 coins in ranking
// order, every exclusion with its reason, the unsettled coins, and the
// provenance, which records the policy ids Adam K. Dean confirmed.

import { createHash } from 'node:crypto';
import { blake2b } from './blake2b.mjs';
import { encode as bech32encode } from './bech32.mjs';

const CG = 'https://api.coingecko.com/api/v3';
const REG_REPO = 'cardano-foundation/cardano-token-registry';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (t) => createHash('sha256').update(t).digest('hex');

// Confirmed by Adam K. Dean from his own knowledge on 2026-10-21; each also
// matches the Cardano Foundation token registry.
export const CONFIRMED = [
  { project: 'HOSKY', policy: 'a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235', asset_name: '484f534b59' },
  { project: 'SNEK', policy: '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f', asset_name: '534e454b' },
  { project: 'World Mobile Token X (WMTX)', policy: 'e5a42a1a1d3d1da71b0449663c32798725888d2eb0843c4dabeca05a', asset_name: '576f726c644d6f62696c65546f6b656e58' },
  { project: 'Nuvola Digital (NVL)', policy: '5b26e685cc5c9ad630bde3e3cd48c694436671f3d25df53777ca60ef', asset_name: '4e564c' }
];

export const fingerprint = (subject) => bech32encode('asset', blake2b(Buffer.from(subject, 'hex'), 20));

// The class CoinGecko's own data gives a coin: { excluded: reason } for ADA
// and a bridged or wrapped asset (out of both parts), { part: 4, kind, basis }
// for a stablecoin or a tokenized commodity, or { part: 2 }. Bridged and
// wrapped are read before stablecoin, so a bridge copy of a stablecoin stays
// out. `commodities` is the rulings file's map of coin ids it classes as
// tokenized commodities.
const COMMODITY = /\b(gold|silver|commodity|commodities)\b/i;
export function classifyCoin(coin, categories, commodities = new Map()) {
  if (coin.id === 'cardano') return { excluded: 'ADA itself' };
  const cats = categories || [];
  for (const c of cats) {
    if (/bridged/i.test(c)) return { excluded: `bridged (CoinGecko category "${c}")` };
    if (/wrapped/i.test(c)) return { excluded: `wrapped (CoinGecko category "${c}")` };
  }
  if (/bridged/i.test(`${coin.id} ${coin.name}`)) return { excluded: 'bridged (CoinGecko id or name)' };
  if (/wrapped/i.test(`${coin.id} ${coin.name}`)) return { excluded: 'wrapped (CoinGecko id or name)' };
  const stable = cats.find((c) => /stablecoin/i.test(c));
  if (stable) return { part: 4, kind: 'stablecoin', basis: `CoinGecko category "${stable}"` };
  if (commodities.has(coin.id)) return { part: 4, kind: 'tokenized commodity', basis: `rulings file: ${commodities.get(coin.id).reason}` };
  const commodity = cats.find((c) => COMMODITY.test(c));
  if (commodity) return { part: 4, kind: 'tokenized commodity', basis: `CoinGecko category "${commodity}"` };
  return { part: 2 };
}

// CoinGecko's Cardano contract to a subject, with the registry's subjects.
export function resolveSubject(contract, symbol, subjects, tickerOf) {
  const c = (contract || '').trim().toLowerCase();
  if (/^[0-9a-f]{56}([0-9a-f]{2}){1,32}$/.test(c)) return { subject: c, resolved_by: 'coingecko contract' };
  if (/^[0-9a-f]{56}$/.test(c)) {
    const under = subjects.filter((s) => s.startsWith(c) && s.length > 56);
    if (subjects.includes(c)) under.push(c);
    if (under.length === 1) return { subject: under[0], resolved_by: 'registry: the only subject under the policy' };
    const byTicker = under.filter((s) => (tickerOf(s) || '').toLowerCase() === symbol.toLowerCase());
    if (byTicker.length === 1) return { subject: byTicker[0], resolved_by: 'registry: the subject under the policy whose ticker is the symbol' };
    return { subject: null, reason: `policy only, and ${under.length} registry subjects under it` };
  }
  if (/^asset1[02-9ac-hj-np-z]{38}$/.test(c)) {
    const hits = subjects.filter((s) => fingerprint(s) === c);
    if (hits.length === 1) return { subject: hits[0], resolved_by: 'registry: CIP-14 fingerprint' };
    return { subject: null, reason: `fingerprint matches ${hits.length} registry subjects` };
  }
  return { subject: null, reason: 'no Cardano native asset listed' };
}

// rulings: { exclusions, cardano_first, commodities }, each a list of
// { coingecko_id, reason, source }.
export async function captureStrata({ named, rulings = {}, ownSources = {}, maxCandidates = 40, spacingMs = 15000, fetchImpl = fetch, now = () => new Date(), tool = null, log = () => {} }) {
  const exclusions = rulings.exclusions || [];
  const cardanoFirst = new Map((rulings.cardano_first || []).map((r) => [r.coingecko_id, r]));
  const commodities = new Map((rulings.commodities || []).map((r) => [r.coingecko_id, r]));
  if (!Array.isArray(named) || !named.length) throw new Error('capture-strata needs the named rows of part 1');
  let last = 0;
  const get = async (url, { spaced = false } = {}) => {
    for (let attempt = 0; ; attempt++) {
      if (spaced) {
        const wait = last + spacingMs - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
      }
      const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
      if ((res.status === 429 || res.status >= 500) && attempt < 8) {
        const ra = Number(res.headers.get('retry-after'));
        const ms = (Number.isFinite(ra) && ra > 0 ? ra : 60) * 1000;
        log(`${res.status} from ${url.split('?')[0]}; retrying in ${ms / 1000} s`);
        await sleep(ms);
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return { text, date: res.headers.get('date'), read_at: now().toISOString(), sha256: sha(text) };
    }
  };

  // 1. The ranking.
  const markets = [];
  const rankingPages = [];
  for (let page = 1; ; page++) {
    const url = `${CG}/coins/markets?vs_currency=usd&category=cardano-ecosystem&order=market_cap_desc&per_page=250&page=${page}`;
    const r = await get(url, { spaced: page > 1 });
    const rows = JSON.parse(r.text);
    rankingPages.push({ endpoint: url, response_date: r.date, read_at: r.read_at, sha256: r.sha256 });
    markets.push(...rows);
    if (rows.length < 250) break;
  }

  // The registry at one commit.
  const commit = JSON.parse((await get(`https://api.github.com/repos/${REG_REPO}/commits/master`)).text).sha;
  const treeR = await get(`https://api.github.com/repos/${REG_REPO}/git/trees/${commit}?recursive=1`);
  const tree = JSON.parse(treeR.text);
  if (tree.truncated) throw new Error('the registry tree listing is truncated');
  // Mapping file names are the subject in hex, in either case; subjects are
  // compared in lowercase and fetched by the file's own name.
  const fileOf = new Map();
  for (const t of tree.tree) {
    const m = /^mappings\/([0-9a-fA-F]+)\.json$/.exec(t.path);
    if (m) fileOf.set(m[1].toLowerCase(), t.path);
  }
  const subjects = [...fileOf.keys()];
  const mappingCache = new Map();
  const mapping = async (subject) => {
    if (!mappingCache.has(subject)) {
      if (!fileOf.has(subject)) mappingCache.set(subject, null);
      else mappingCache.set(subject, JSON.parse((await get(`https://raw.githubusercontent.com/${REG_REPO}/${commit}/${fileOf.get(subject)}`)).text));
    }
    return mappingCache.get(subject);
  };
  const tickers = new Map();
  const tickerOf = (s) => tickers.get(s);

  const namedFt = new Set(named.filter((r) => r.class === 'FT').map((r) => r.policy + r.asset_name));
  const confirmed = new Map(CONFIRMED.map((c) => [c.policy + c.asset_name, c]));
  const ruling = new Map(exclusions.map((e) => [e.coingecko_id, e]));
  const candidates = [];
  const part4 = [];
  const excluded = [];
  const unsettled = [];
  const beyondBound = [];
  const details = [];
  // Every coin of the ranking is read: part 4 takes every stablecoin and
  // tokenized commodity in the capture. Part 2 stops growing at maxCandidates;
  // a part 2 coin after that is listed in the provenance by its id only.
  for (let i = 0; i < markets.length; i++) {
    const coin = markets[i];
    const base = { market_position: i + 1, coingecko_id: coin.id, symbol: coin.symbol, name: coin.name, market_cap: coin.market_cap, market_cap_rank: coin.market_cap_rank };
    if (coin.id === 'cardano') {
      excluded.push({ ...base, reason: 'ADA itself' });
      continue;
    }
    if (ruling.has(coin.id)) {
      excluded.push({ ...base, reason: ruling.get(coin.id).reason, source: ruling.get(coin.id).source || null });
      continue;
    }
    const url = `${CG}/coins/${encodeURIComponent(coin.id)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`;
    const d = await get(url, { spaced: true });
    details.push({ coingecko_id: coin.id, endpoint: url, response_date: d.date, read_at: d.read_at, sha256: d.sha256 });
    const detail = JSON.parse(d.text);
    const categories = Array.isArray(detail.categories) ? detail.categories.filter((c) => typeof c === 'string') : [];
    const cls = classifyCoin(coin, categories, commodities);
    if (cls.excluded) {
      excluded.push({ ...base, categories, reason: cls.excluded });
      continue;
    }
    const isPart4 = cls.part === 4;
    if (!isPart4 && candidates.length >= maxCandidates) {
      beyondBound.push(coin.id);
      continue;
    }
    const platform = detail.asset_platform_id ?? null;
    base.asset_platform_id = platform;
    base.categories = categories;
    const part = isPart4 ? { part: 4, kind: cls.kind, basis: cls.basis } : { part: 2 };
    if (platform !== 'cardano' && !cardanoFirst.has(coin.id)) {
      excluded.push({ ...base, ...part, reason: `bridged: CoinGecko asset_platform_id ${platform === null ? 'is empty' : `is ${platform}`}, so the Cardano token is not the original issuance` });
      continue;
    }
    const contract = detail.detail_platforms?.cardano?.contract_address || detail.platforms?.cardano || null;
    if (!contract) {
      excluded.push({ ...base, ...part, reason: 'no Cardano native asset listed' });
      continue;
    }
    if (/^[0-9a-f]{56}$/i.test(contract.trim())) {
      for (const s of subjects.filter((x) => x.startsWith(contract.trim().toLowerCase()))) {
        const m = await mapping(s);
        tickers.set(s, m?.ticker?.value ? String(m.ticker.value).trim() : null);
      }
    }
    const res = resolveSubject(contract, coin.symbol, subjects, tickerOf);
    if (!res.subject) {
      excluded.push({ ...base, ...part, contract, reason: res.reason });
      continue;
    }
    const policy = res.subject.slice(0, 56);
    const assetName = res.subject.slice(56);
    if (namedFt.has(policy + assetName)) {
      excluded.push({ ...base, ...part, policy, asset_name: assetName, reason: 'named in part 1' });
      continue;
    }
    const m = await mapping(res.subject);
    const ticker = m?.ticker?.value ?? null;
    const regName = m?.name?.value ?? null;
    const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    const match = !m ? 'absent' : same(ticker, coin.symbol) ? 'ticker' : same(regName, coin.name) ? 'name' : 'differs';
    const registry = { subject: res.subject, ticker, name: regName, decimals: m?.decimals?.value ?? null, match };
    const registryReason = `token registry: ${match === 'absent' ? 'no mapping for the subject' : `ticker ${ticker} and name ${regName} differ from CoinGecko's`}`;
    if (match === 'absent' || match === 'differs') {
      if (isPart4) {
        unsettled.push({ ...base, ...part, policy, asset_name: assetName, contract, resolved_by: res.resolved_by, registry, question: `${registryReason}; the part 4 rule names no registry cross-check, so whether this coin is a part 4 candidate is not decided` });
      } else {
        excluded.push({ ...base, policy, asset_name: assetName, reason: registryReason });
      }
      continue;
    }
    const conf = confirmed.get(policy + assetName);
    const row = {
      ...base,
      cardano_first: cardanoFirst.has(coin.id) ? cardanoFirst.get(coin.id) : undefined,
      project: `${coin.name} (${coin.symbol.toUpperCase()})`,
      stratum: `${coin.name} (${coin.symbol.toUpperCase()})`,
      policy,
      asset_name: assetName,
      contract,
      resolved_by: res.resolved_by,
      registry,
      own_source: ownSources[res.subject] || (conf ? 'confirmed by Adam K. Dean' : 'not verified')
    };
    if (isPart4) part4.push({ rank: part4.length + 1, kind: cls.kind, basis: cls.basis, ...row });
    else candidates.push({ rank: candidates.length + 1, ...row });
  }
  if (candidates.length <= 10) log(`warning: only ${candidates.length} candidates; the run needs ten that pass the floor`);

  return {
    format: 'research-corpus-strata-v3',
    note: 'Part 1 (named) is always included; part 2 takes the candidates in rank order, skipping any held by fewer than 1,000 stake credentials of the recent frame at the snapshot, until ten qualify; part 3 is computed by the run; part 4 takes every stablecoin and tokenized commodity listed that is held by at least 1,000 of them. A file that lists any unsettled coin is refused by the run.',
    named,
    candidates,
    part4,
    excluded,
    unsettled,
    provenance: {
      captured_at: now().toISOString(),
      tool: tool ? `research-corpus capture-strata at ${tool}` : 'research-corpus capture-strata',
      coingecko: { category: 'cardano-ecosystem', ranking: rankingPages, details, rate_spacing_ms: spacingMs, coins_in_ranking: markets.length, max_candidates: maxCandidates, beyond_candidate_bound: beyondBound },
      registry: { repository: `github.com/${REG_REPO}`, commit, tree_sha256: treeR.sha256, subjects: subjects.length },
      rulings,
      confirmed_by_adam: CONFIRMED.map((c) => ({ ...c, date: '2026-10-21', note: 'policy id confirmed by Adam K. Dean from his own knowledge; also matches the Cardano Foundation token registry' }))
    }
  };
}
