import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CACHE_KEY,
  DEFAULT_PARAMETERS,
  NETWORKS,
  currentEpoch,
  loadProtocolParameters,
  normalize,
} from "../src/protocol-parameters.js";

// The mainnet row Koios returned for the publisher's query on 2026-10-05
// (a 284-byte response: this row inside a JSON array).
const ROW =
  '{"epoch_no":659,"min_fee_a":44,"min_fee_b":155381,"max_tx_size":16384,"max_val_size":5000,"coins_per_utxo_size":"4310","key_deposit":"2000000","pool_deposit":"500000000","price_mem":0.0577,"price_step":7.21e-05,"protocol_major":11,"collateral_percent":150,"max_collateral_inputs":3}';
const BASE_URL = "/";
// Mainnet slot time 1791135784 is in epoch 659.
const NOW_MS_659 = 1791135784 * 1000;
const FETCHED_AT = 1791135000;

function row(changes = {}) {
  return { ...JSON.parse(ROW), ...changes };
}

function file(changes = {}) {
  return { network: "mainnet", fetched_at: FETCHED_AT, ...row(changes) };
}

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    dump: () => Object.fromEntries(data),
  };
}

function cacheWith(network, parameters, fetchedAt = FETCHED_AT) {
  return memoryStorage({ [CACHE_KEY]: JSON.stringify({ [network]: { fetchedAt, parameters } }) });
}

function fetchReturning(body, status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

function fetchFailing() {
  const calls = [];
  const fn = async (url) => {
    calls.push({ url });
    throw new TypeError("Failed to fetch");
  };
  fn.calls = calls;
  return fn;
}

test("currentEpoch matches the tips measured on 2026-10-04", () => {
  assert.equal(currentEpoch("mainnet", 1791135784), 659);
  assert.equal(currentEpoch("preprod", 1791135786), 317);
  assert.equal(currentEpoch("preview", 1791135786), 1440);
});

test("currentEpoch rejects an unknown network", () => {
  assert.throws(() => currentEpoch("sanchonet", 1791135784), TypeError);
});

test("the real 284-byte Koios row normalizes", () => {
  assert.equal(Buffer.byteLength(`[${ROW}]`), 284);
  assert.deepEqual(normalize(JSON.parse(ROW)), {
    minFeeA: 44,
    minFeeB: 155381,
    maxTxSize: 16384,
    maxValSize: 5000,
    coinsPerUtxoByte: 4310,
    keyDeposit: 2000000,
    poolDeposit: 500000000,
    priceMem: 0.0577,
    priceStep: 0.0000721,
    protocolMajor: 11,
    maxCollateralInputs: 3,
    collateralPercent: 150,
    epoch: 659,
    fetchedAt: null,
  });
});

test("normalize maps fetched_at to fetchedAt", () => {
  assert.equal(normalize(file()).fetchedAt, FETCHED_AT);
});

test("normalize rejects invalid rows", () => {
  const missingMaxTx = row();
  delete missingMaxTx.max_tx_size;
  assert.throws(() => normalize(missingMaxTx), /max_tx_size/);

  const missingCollateralInputs = row();
  delete missingCollateralInputs.max_collateral_inputs;
  assert.throws(() => normalize(missingCollateralInputs), /max_collateral_inputs/);

  assert.throws(() => normalize(row({ min_fee_b: "abc" })), /min_fee_b/);
  assert.throws(() => normalize(row({ min_fee_a: -44 })), /min_fee_a/);
  assert.throws(() => normalize(row({ epoch_no: 659.5 })), /epoch_no/);
  assert.throws(() => normalize(row({ fetched_at: "yesterday" })), /fetched_at/);
  assert.throws(() => normalize(null), TypeError);
});

test("DEFAULT_PARAMETERS covers every network", () => {
  for (const network of NETWORKS) {
    const p = DEFAULT_PARAMETERS[network];
    assert.equal(p.source, "default");
    assert.equal(p.epoch, null);
    assert.equal(p.minFeeA, 44);
    assert.equal(p.maxTxSize, 16384);
    assert.equal(p.maxCollateralInputs, 3);
    assert.equal(p.collateralPercent, 150);
  }
});

test("baseUrl is required", async () => {
  await assert.rejects(loadProtocolParameters("mainnet", { fetch: fetchFailing(), storage: memoryStorage() }), TypeError);
});

test("a cache entry for the current epoch is used without a request", async () => {
  const parameters = normalize(file());
  const fetch = fetchFailing();
  const result = await loadProtocolParameters("mainnet", {
    fetch,
    storage: cacheWith("mainnet", parameters),
    now: () => NOW_MS_659,
    baseUrl: BASE_URL,
  });
  assert.equal(fetch.calls.length, 0);
  assert.equal(result.source, "cache");
  assert.equal(result.stale, false);
  assert.equal(result.fetchedAt, FETCHED_AT);
  assert.deepEqual(result.parameters, parameters);
});

test("an older cache entry is replaced from the network and written back", async () => {
  const old = normalize(file({ epoch_no: 658 }));
  const storage = cacheWith("mainnet", old, FETCHED_AT - 432000);
  const fetch = fetchReturning(file());
  const result = await loadProtocolParameters("mainnet", { fetch, storage, now: () => NOW_MS_659, baseUrl: BASE_URL });
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, "/protocol-parameters/mainnet.json");
  assert.equal(fetch.calls[0].init.cache, "no-cache");
  assert.equal(result.source, "network");
  assert.equal(result.stale, false);
  assert.equal(result.fetchedAt, FETCHED_AT);
  assert.equal(result.parameters.epoch, 659);
  const cached = JSON.parse(storage.dump()[CACHE_KEY]).mainnet;
  assert.equal(cached.fetchedAt, FETCHED_AT);
  assert.equal(cached.parameters.epoch, 659);
});

test("the network result is stale when the published file is behind the clock", async () => {
  const result = await loadProtocolParameters("mainnet", {
    fetch: fetchReturning(file({ epoch_no: 658 })),
    storage: memoryStorage(),
    now: () => NOW_MS_659,
    baseUrl: "https://unfrack.it/",
  });
  assert.equal(result.source, "network");
  assert.equal(result.stale, true);
});

test("a file for another network is not accepted", async () => {
  const result = await loadProtocolParameters("preview", {
    fetch: fetchReturning(file()),
    storage: memoryStorage(),
    now: () => NOW_MS_659,
    baseUrl: BASE_URL,
  });
  assert.equal(result.source, "default");
});

test("a failed request falls back to the cache, marked stale", async () => {
  const old = normalize(file({ epoch_no: 658 }));
  const result = await loadProtocolParameters("mainnet", {
    fetch: fetchFailing(),
    storage: cacheWith("mainnet", old, FETCHED_AT - 432000),
    now: () => NOW_MS_659,
    baseUrl: BASE_URL,
  });
  assert.equal(result.source, "cache");
  assert.equal(result.stale, true);
  assert.equal(result.fetchedAt, FETCHED_AT - 432000);
  assert.equal(result.parameters.epoch, 658);
});

test("an HTTP error or an invalid body falls back like a failed request", async () => {
  for (const fetch of [fetchReturning(null, 404), fetchReturning(row({ max_tx_size: "abc" }))]) {
    const result = await loadProtocolParameters("mainnet", {
      fetch,
      storage: memoryStorage(),
      now: () => NOW_MS_659,
      baseUrl: BASE_URL,
    });
    assert.equal(result.source, "default");
  }
});

test("no cache and no file gives the defaults", async () => {
  const result = await loadProtocolParameters("preprod", {
    fetch: fetchFailing(),
    storage: memoryStorage(),
    now: () => NOW_MS_659,
    baseUrl: BASE_URL,
  });
  assert.equal(result.source, "default");
  assert.equal(result.stale, true);
  assert.equal(result.fetchedAt, null);
  assert.deepEqual(result.parameters, DEFAULT_PARAMETERS.preprod);
});

test("a corrupt cache entry is ignored", async () => {
  const fetch = fetchReturning(file());
  const result = await loadProtocolParameters("mainnet", {
    fetch,
    storage: memoryStorage({ [CACHE_KEY]: "{not json" }),
    now: () => NOW_MS_659,
    baseUrl: BASE_URL,
  });
  assert.equal(fetch.calls.length, 1);
  assert.equal(result.source, "network");
});

test("a throwing localStorage gives the defaults when the request fails too", async () => {
  const throwing = {
    getItem() {
      throw new Error("SecurityError");
    },
    setItem() {
      throw new Error("SecurityError");
    },
  };
  const result = await loadProtocolParameters("mainnet", {
    fetch: fetchFailing(),
    storage: throwing,
    now: () => NOW_MS_659,
    baseUrl: BASE_URL,
  });
  assert.equal(result.source, "default");
  assert.equal(result.fetchedAt, null);

  const fromNetwork = await loadProtocolParameters("mainnet", {
    fetch: fetchReturning(file()),
    storage: throwing,
    now: () => NOW_MS_659,
    baseUrl: BASE_URL,
  });
  assert.equal(fromNetwork.source, "network");
});
