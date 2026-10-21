// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Blockfrost (OpenAPI 0.1.93, github.com/blockfrost/openapi), the second,
// independent provider of chain facts. It is used only to cross-check what
// Koios reports, by `verify` and `drawkey`, and a disagreement fails the
// command; it is never a fallback when Koios fails. Its requests are about
// this tool's own transactions and their blocks, the transactions of the
// identity's own payment address, the genesis parameters, the tip and epoch
// parameters.
//
// The project id is read from secrets/blockfrost-<network>.token in the home
// (0600) and sent only in the `project_id` header. It never appears in a
// message, a log or a report: every error text is redacted before use.
//
// The reference CLI and the SDK accept a Blockfrost id too, but only as a
// fallback after Koios fails, and only against the mainnet host; neither is
// given one.

import { NETWORKS, parseRetryAfter } from './koios.mjs';
import { sleep as realSleep, UserError } from './util.mjs';

export const BLOCKFROST_HOSTS = Object.freeze({
  mainnet: 'https://cardano-mainnet.blockfrost.io/api/v0',
  preprod: 'https://cardano-preprod.blockfrost.io/api/v0'
});

export const tokenFileName = (network) => `blockfrost-${network}.token`;

// What each refusal means (Blockfrost OpenAPI 0.1.93 responses).
const STATUS_HINTS = {
  400: 'the request is invalid',
  402: 'the project has exceeded its daily request limit',
  403: 'the project id was not accepted for this network',
  418: 'the client is banned for exceeding the rate limit',
  425: 'the mempool is full',
  429: 'the rate limit is exceeded',
  500: 'Blockfrost reports an internal error'
};

export class BlockfrostError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'BlockfrostError';
    this.status = status;
  }
}

export class Blockfrost {
  #projectId;

  constructor(network, { projectId, baseUrl, fetchImpl = globalThis.fetch, sleepImpl = realSleep, spacingMs = 120, retries = 4, own = {} } = {}) {
    this.network = NETWORKS[network];
    if (!this.network) throw new UserError(`--network must be mainnet or preprod, not "${network}"`);
    if (!projectId) throw new UserError(`no Blockfrost project id for ${network}: save it as secrets/${tokenFileName(network)} (mode 0600) in the home`);
    this.#projectId = projectId;
    this.base = (baseUrl || BLOCKFROST_HOSTS[network]).replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
    this.spacingMs = spacingMs;
    this.retries = retries;
    this.last = 0;
    this.txHashes = new Set(own.txHashes || []);
    this.addresses = new Set(own.addresses || []);
    this.historyTxs = new Set();
    this.blocks = new Set();
    this.calls = [];
  }

  allowTx(hash) {
    this.txHashes.add(hash);
  }

  #ownTx(hash) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new UserError(`not a transaction hash: ${hash}`);
    if (!this.txHashes.has(hash) && !this.historyTxs.has(hash)) throw new UserError(`refusing to query ${hash} on Blockfrost: it is not one of this tool's own transactions`);
  }

  redact(text) {
    return String(text).split(this.#projectId).join('[redacted]');
  }

  // GET a path; null on 404. 429 and 5xx are retried after Retry-After or
  // with backoff; any other refusal throws, naming the status and its meaning.
  async request(path) {
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + this.spacingMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.last = Date.now();
      let res;
      try {
        // A redirect is refused rather than followed: fetch would carry the
        // project_id header to the redirect target.
        res = await this.fetch(this.base + path, { method: 'GET', headers: { accept: 'application/json', project_id: this.#projectId }, redirect: 'error' });
      } catch (e) {
        throw new BlockfrostError(`Blockfrost GET ${path}: ${this.redact(e.message)}`, 0);
      }
      this.calls.push({ path, status: res.status });
      if (res.status === 404) return null;
      if ((res.status === 429 || res.status >= 500) && attempt < this.retries) {
        const ra = parseRetryAfter(res.headers?.get?.('retry-after'));
        await this.sleep(ra !== null && ra > 0 ? Math.min(ra, 60000) : 2 ** attempt * 1000);
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        const hint = STATUS_HINTS[res.status] ? ` (${STATUS_HINTS[res.status]})` : '';
        throw new BlockfrostError(`Blockfrost GET ${path}: HTTP ${res.status}${hint}: ${this.redact(text).slice(0, 500)}`, res.status);
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new BlockfrostError(`Blockfrost GET ${path}: not JSON: ${this.redact(text).slice(0, 200)}`, res.status);
      }
    }
  }

  // The network guard: the project's genesis must carry the network's magic.
  async guard() {
    const g = await this.request('/genesis');
    if (!g || Number(g.network_magic) !== this.network.magic) {
      throw new UserError(`refusing to run: --network ${this.network.name} expects network magic ${this.network.magic}, Blockfrost at ${this.base} reports ${g?.network_magic}`);
    }
    this.genesisRow = g;
    return g;
  }

  async genesis() {
    const g = this.genesisRow || (await this.guard());
    return { networkMagic: Number(g.network_magic), securityParam: Number(g.security_param), activeSlotCoeff: String(g.active_slots_coefficient), epochLength: Number(g.epoch_length) };
  }

  async tx(hash) {
    this.#ownTx(hash);
    const t = await this.request(`/txs/${hash}`);
    if (t) this.blocks.add(t.block);
    return t;
  }

  async txCbor(hash) {
    this.#ownTx(hash);
    const r = await this.request(`/txs/${hash}/cbor`);
    return r ? r.cbor : null;
  }

  // Only the block of one of this tool's own transactions.
  async block(hash) {
    if (!this.blocks.has(hash)) throw new UserError(`refusing to query block ${hash} on Blockfrost: it does not hold one of this tool's own transactions`);
    return this.request(`/blocks/${hash}`);
  }

  // Every transaction of the identity's own payment address, oldest first.
  async addressTxs(address) {
    if (!this.addresses.has(address)) throw new UserError(`refusing to query ${address} on Blockfrost: it is not this identity's payment address`);
    const out = [];
    for (let page = 1; ; page++) {
      const rows = await this.request(`/addresses/${address}/transactions?page=${page}&count=100&order=asc`);
      if (!rows) return out;
      for (const t of rows) {
        out.push({ txHash: t.tx_hash, blockHeight: Number(t.block_height), blockTime: Number(t.block_time) });
        this.historyTxs.add(t.tx_hash);
      }
      if (rows.length < 100) return out;
    }
  }

  async latestBlock() {
    return this.request('/blocks/latest');
  }

  async epochParams(epochNo) {
    if (!Number.isSafeInteger(epochNo) || epochNo < 0) throw new UserError(`not an epoch number: ${epochNo}`);
    return this.request(`/epochs/${epochNo}/parameters`);
  }
}

// The client for a network, or null when the home holds no project id for it.
export function blockfrostFor(store, network, opts = {}) {
  const id = store.readSecretToken(tokenFileName(network));
  return id ? new Blockfrost(network, { ...opts, projectId: id }) : null;
}
