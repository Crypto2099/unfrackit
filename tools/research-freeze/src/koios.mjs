// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Koios (API v1.4.2, public tier, no token). The client exposes only the
// requests this tool makes: /genesis, /tip, /epoch_params, /address_utxos for
// the identity's own payment address, /submittx, and /tx_status, /tx_info and
// /tx_cbor for the tool's own transactions. It refuses any other address or
// transaction hash, because before the freeze block no study query may run.

import { sleep as realSleep, UserError } from './util.mjs';

export const NETWORKS = Object.freeze({
  mainnet: { name: 'mainnet', networkId: 1, magic: 764824073, koiosName: 'Mainnet', koios: 'https://api.koios.rest/api/v1' },
  preprod: { name: 'preprod', networkId: 0, magic: 1, koiosName: 'Testnet', koios: 'https://preprod.koios.rest/api/v1' }
});

export function networkOf(name) {
  const n = NETWORKS[name];
  if (!n) throw new UserError(`--network must be mainnet or preprod, not "${name}"`);
  return n;
}

export class KoiosError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'KoiosError';
    this.status = status;
    this.body = body;
  }
}

export class Koios {
  // own: { addresses: Set<bech32>, txHashes: Set<hex> }, extended by
  // allowTx() as the tool builds transactions.
  constructor(network, { baseUrl, fetchImpl = globalThis.fetch, sleepImpl = realSleep, own = {}, spacingMs = 200, log } = {}) {
    this.network = networkOf(network);
    this.base = (baseUrl || process.env.RESEARCH_FREEZE_KOIOS_URL || this.network.koios).replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
    this.addresses = new Set(own.addresses || []);
    this.txHashes = new Set(own.txHashes || []);
    this.spacingMs = spacingMs;
    this.last = 0;
    this.log = log || (() => {});
  }

  allowTx(hash) {
    this.txHashes.add(hash);
  }

  #ownTx(hashes) {
    for (const h of hashes) {
      if (!/^[0-9a-f]{64}$/.test(h)) throw new UserError(`not a transaction hash: ${h}`);
      if (!this.txHashes.has(h)) throw new UserError(`refusing to query ${h}: it is not one of this tool's own transactions`);
    }
  }

  // Requests are spaced; 429 and 5xx are retried with the server's
  // Retry-After (seconds), else exponential backoff.
  async request(method, path, { json, body, headers, raw = false, retries = 6 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + this.spacingMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.last = Date.now();
      const res = await this.fetch(this.base + path, {
        method,
        headers: { accept: 'application/json', ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: json !== undefined ? JSON.stringify(json) : body
      });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const ra = Number(res.headers?.get?.('retry-after'));
        await this.sleep((Number.isFinite(ra) && ra > 0 ? ra : 2 ** attempt) * 1000);
        continue;
      }
      const text = await res.text();
      this.log({ method, path, status: res.status });
      if (!res.ok) throw new KoiosError(`Koios ${method} ${path}: HTTP ${res.status}: ${text.slice(0, 2000)}`, res.status, text);
      if (raw) return { status: res.status, text };
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }

  // The network guard, run before anything is built or signed.
  async guard() {
    const [g] = await this.request('GET', '/genesis');
    if (!g || String(g.networkmagic) !== String(this.network.magic) || g.networkid !== this.network.koiosName) {
      throw new UserError(
        `refusing to run: --network ${this.network.name} expects protocol magic ${this.network.magic} (${this.network.koiosName}), the endpoint ${this.base} reports ${g?.networkmagic} (${g?.networkid})`
      );
    }
    return g;
  }

  async tip() {
    const [t] = await this.request('GET', '/tip');
    return { epoch: Number(t.epoch_no), slot: Number(t.abs_slot), height: Number(t.block_height), hash: t.hash, time: Number(t.block_time) };
  }

  async params() {
    const tip = await this.tip();
    const [p] = await this.request('GET', `/epoch_params?_epoch_no=${tip.epoch}`);
    return {
      epoch: Number(p.epoch_no),
      protocolMajor: Number(p.protocol_major),
      protocolMinor: Number(p.protocol_minor),
      minFeeA: BigInt(p.min_fee_a),
      minFeeB: BigInt(p.min_fee_b),
      maxTxSize: Number(p.max_tx_size),
      coinsPerUtxoByte: BigInt(p.coins_per_utxo_size),
      tip
    };
  }

  async addressUtxos(address) {
    if (!this.addresses.has(address)) throw new UserError(`refusing to query ${address}: it is not this identity's payment address`);
    const out = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await this.request('POST', `/address_utxos?order=tx_hash.asc,tx_index.asc&offset=${offset}&limit=1000`, {
        json: { _addresses: [address], _extended: true }
      });
      for (const u of page) {
        if (u.is_spent === true) continue;
        out.push({
          txHash: u.tx_hash,
          index: Number(u.tx_index),
          address: u.address,
          coin: BigInt(u.value),
          assets: u.asset_list || [],
          datumBytes: u.inline_datum ? u.inline_datum.bytes : null,
          datumHash: u.datum_hash || null,
          refScript: u.reference_script || null
        });
      }
      if (page.length < 1000) return out;
    }
  }

  // Raw CBOR body, content-type application/cbor; success is HTTP 202 with
  // the transaction id. A rejection is HTTP 400 with the node's message,
  // surfaced verbatim (KoiosError.body). No automatic retry here: the journal
  // decides what happens next.
  async submit(bytes) {
    const r = await this.request('POST', '/submittx', { body: bytes, headers: { 'content-type': 'application/cbor' }, raw: true, retries: 0 });
    return String(r.text).trim().replace(/^"|"$/g, '');
  }

  async txStatus(hash) {
    this.#ownTx([hash]);
    const rows = await this.request('POST', '/tx_status', { json: { _tx_hashes: [hash] } });
    const row = rows.find((r) => r.tx_hash === hash);
    return row && row.num_confirmations !== null && row.num_confirmations !== undefined ? Number(row.num_confirmations) : null;
  }

  async txInfo(hash) {
    this.#ownTx([hash]);
    const rows = await this.request('POST', '/tx_info', { json: { _tx_hashes: [hash] } });
    return rows.find((r) => r.tx_hash === hash) || null;
  }

  async txCbor(hash) {
    this.#ownTx([hash]);
    const rows = await this.request('POST', '/tx_cbor', { json: { _tx_hashes: [hash] } });
    const row = rows.find((r) => r.tx_hash === hash);
    return row ? row.cbor : null;
  }
}
