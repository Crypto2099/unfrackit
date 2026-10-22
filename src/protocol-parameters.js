// Protocol parameters per network, read from the files that CI publishes to the
// site's own origin (scripts/publish-protocol-parameters.mjs), cached per epoch in
// localStorage, with built-in defaults as the last fallback.
//
// Plain ES module with no Vue or CSL imports so that `node --test` can load it.
// Values are Numbers; convert with String() where CSL wants strings.

export const NETWORKS = ["mainnet", "preprod", "preview"];

export const CACHE_KEY = "UnFrackItProtocolParameters";

// Koios field name -> camelCase field name. Every field is required.
const FIELDS = {
  min_fee_a: "minFeeA",
  min_fee_b: "minFeeB",
  max_tx_size: "maxTxSize",
  max_val_size: "maxValSize",
  coins_per_utxo_size: "coinsPerUtxoByte",
  key_deposit: "keyDeposit",
  pool_deposit: "poolDeposit",
  price_mem: "priceMem",
  price_step: "priceStep",
  protocol_major: "protocolMajor",
  max_collateral_inputs: "maxCollateralInputs",
  collateral_percent: "collateralPercent",
};

// Measured on mainnet epoch 659, preprod epoch 317 and preview epoch 1441
// (identical on all three networks for every field below).
const MEASURED = {
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
};

export const DEFAULT_PARAMETERS = Object.freeze(
  NETWORKS.reduce((all, network) => {
    all[network] = Object.freeze({ ...MEASURED, epoch: null, source: "default" });
    return all;
  }, {})
);

function assertNetwork(network) {
  if (!NETWORKS.includes(network)) {
    throw new TypeError(`Unknown network: ${network}`);
  }
}

// Current epoch from the wall clock (Unix seconds). Mainnet and preprod have
// 432000-second Shelley epochs starting at epoch 208 and 4; preview has
// 86400-second epochs from its genesis.
export function currentEpoch(network, nowSeconds = Date.now() / 1000) {
  assertNetwork(network);
  switch (network) {
    case "mainnet":
      return 208 + Math.floor((nowSeconds - 1596059091) / 432000);
    case "preprod":
      return 4 + Math.floor((nowSeconds - 1655769600) / 432000);
    default:
      return Math.floor((nowSeconds - 1666656000) / 86400);
  }
}

function isPositive(value) {
  return Number.isFinite(value) && value > 0;
}

// Map a Koios epoch_params row (or a published file, which is the same row plus
// `network` and `fetched_at`) to the camelCase shape. Throws on anything invalid.
export function normalize(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("Protocol parameters must be an object");
  }
  const parameters = {};
  for (const [from, to] of Object.entries(FIELDS)) {
    if (raw[from] === undefined || raw[from] === null) {
      throw new TypeError(`Protocol parameter ${from} is missing`);
    }
    const value = Number(raw[from]);
    if (!isPositive(value)) {
      throw new TypeError(`Protocol parameter ${from} is not a positive number: ${raw[from]}`);
    }
    parameters[to] = value;
  }
  const epoch = Number(raw.epoch_no);
  if (raw.epoch_no === null || raw.epoch_no === "" || !Number.isInteger(epoch) || epoch < 0) {
    throw new TypeError(`Protocol parameter epoch_no is not an integer: ${raw.epoch_no}`);
  }
  parameters.epoch = epoch;
  if (raw.fetched_at === undefined || raw.fetched_at === null) {
    parameters.fetchedAt = null;
  } else {
    const fetchedAt = Number(raw.fetched_at);
    if (!Number.isInteger(fetchedAt) || fetchedAt <= 0) {
      throw new TypeError(`fetched_at is not a positive integer: ${raw.fetched_at}`);
    }
    parameters.fetchedAt = fetchedAt;
  }
  return parameters;
}

// A cache entry is trusted only if it still has the normalized shape.
function validCached(entry) {
  if (!entry || typeof entry !== "object" || !entry.parameters || typeof entry.parameters !== "object") {
    return false;
  }
  const p = entry.parameters;
  return (
    Object.values(FIELDS).every((key) => isPositive(p[key])) &&
    Number.isInteger(p.epoch) &&
    p.epoch >= 0 &&
    (entry.fetchedAt === null || (Number.isInteger(entry.fetchedAt) && entry.fetchedAt > 0))
  );
}

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch (e) {
    return null;
  }
}

function readCache(storage, network) {
  try {
    const all = JSON.parse(storage.getItem(CACHE_KEY));
    const entry = all && typeof all === "object" ? all[network] : null;
    return validCached(entry) ? entry : null;
  } catch (e) {
    return null;
  }
}

function writeCache(storage, network, entry) {
  try {
    let all = null;
    try {
      all = JSON.parse(storage.getItem(CACHE_KEY));
    } catch (e) {
      all = null;
    }
    if (!all || typeof all !== "object" || Array.isArray(all)) {
      all = {};
    }
    all[network] = entry;
    storage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch (e) {
    // Private windows and blocked storage: carry on without a cache.
  }
}

// Returns { parameters, source, stale, fetchedAt } where source is "cache",
// "network" or "default". Never throws for network or storage failures.
export async function loadProtocolParameters(network, options = {}) {
  assertNetwork(network);
  const { baseUrl } = options;
  if (typeof baseUrl !== "string") {
    throw new TypeError("loadProtocolParameters needs a baseUrl");
  }
  const fetchFn = options.fetch || (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
  const storage = options.storage !== undefined ? options.storage : defaultStorage();
  const now = options.now || Date.now;
  const epochNow = currentEpoch(network, now() / 1000);

  // 1. A cache entry for the current epoch is used without any request.
  const cached = storage ? readCache(storage, network) : null;
  if (cached && cached.parameters.epoch === epochNow) {
    return { parameters: cached.parameters, source: "cache", stale: false, fetchedAt: cached.fetchedAt };
  }

  // 2. Otherwise read the published file.
  try {
    if (!fetchFn) {
      throw new Error("fetch is not available");
    }
    const response = await fetchFn(`${baseUrl}protocol-parameters/${network}.json`, { cache: "no-cache" });
    if (!response || response.status !== 200) {
      throw new Error(`HTTP ${response ? response.status : "error"}`);
    }
    const body = await response.json();
    if (body && body.network !== undefined && body.network !== network) {
      throw new Error(`File is for ${body.network}, not ${network}`);
    }
    const parameters = normalize(body);
    if (storage) {
      writeCache(storage, network, { fetchedAt: parameters.fetchedAt, parameters });
    }
    return { parameters, source: "network", stale: parameters.epoch < epochNow, fetchedAt: parameters.fetchedAt };
  } catch (e) {
    // 3. Fall back to whatever cache exists, then to the defaults.
    if (cached) {
      return {
        parameters: cached.parameters,
        source: "cache",
        stale: cached.parameters.epoch < epochNow,
        fetchedAt: cached.fetchedAt,
      };
    }
    return { parameters: DEFAULT_PARAMETERS[network], source: "default", stale: true, fetchedAt: null };
  }
}
