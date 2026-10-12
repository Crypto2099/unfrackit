// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

import { PREPROD_PROTOCOL_MAGIC } from './wallet.mjs';

export const DEFAULT_URL = 'https://preprod.koios.rest/api/v1';

// The tool signs only for preprod: protocol magic 1 and the Testnet network
// name. Every command that reaches the chain calls this before it builds or
// signs anything.
export function assertPreprod(genesis) {
  if (String(genesis.networkmagic) !== String(PREPROD_PROTOCOL_MAGIC) || genesis.networkid !== 'Testnet') {
    throw new Error(
      `refusing to run: the endpoint reports protocol magic ${genesis.networkmagic} (${genesis.networkid}); this tool works on preprod only (magic ${PREPROD_PROTOCOL_MAGIC})`
    );
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Koios {
  constructor(base = process.env.PREPROD_SEEDER_KOIOS_URL || DEFAULT_URL) {
    this.base = base.replace(/\/$/, '');
    this.lastRequest = 0;
  }

  // Public tier, no token. Requests are spaced and a 429 (or a 5xx) is retried
  // with the server's Retry-After, else exponential backoff.
  async request(method, path, { json, body, headers } = {}) {
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastRequest + 150 - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequest = Date.now();
      const res = await fetch(this.base + path, {
        method,
        headers: { accept: 'application/json', ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: json !== undefined ? JSON.stringify(json) : body
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 6) {
        const ra = Number(res.headers.get('retry-after'));
        await sleep((Number.isFinite(ra) && ra > 0 ? ra : 2 ** attempt) * 1000);
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`Koios ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }

  async connect() {
    const [genesis] = await this.request('GET', '/genesis');
    assertPreprod(genesis);
    return genesis;
  }

  async params() {
    const [tip] = await this.request('GET', '/tip');
    const [p] = await this.request('GET', `/epoch_params?_epoch_no=${tip.epoch_no}`);
    return {
      epoch: p.epoch_no,
      minFeeA: BigInt(p.min_fee_a),
      minFeeB: BigInt(p.min_fee_b),
      maxTxSize: Number(p.max_tx_size),
      maxValSize: Number(p.max_val_size),
      coinsPerUtxoByte: String(p.coins_per_utxo_size),
      refScriptFeePerByte: Number(p.min_fee_ref_script_cost_per_byte ?? 15)
    };
  }

  // Extended UTxO records for the addresses, normalized.
  async utxos(addresses) {
    const out = [];
    const seen = new Set();
    for (let offset = 0; ; offset += 1000) {
      const page = await this.request(
        'POST',
        `/address_utxos?order=tx_hash.asc,tx_index.asc&offset=${offset}&limit=1000`,
        { json: { _addresses: addresses, _extended: true } }
      );
      for (const u of page) {
        const id = `${u.tx_hash}#${u.tx_index}`;
        if (seen.has(id) || u.is_spent === true) continue;
        seen.add(id);
        out.push({
          txHash: u.tx_hash,
          index: Number(u.tx_index),
          address: u.address,
          coin: BigInt(u.value),
          assets: (u.asset_list || []).map((a) => ({ policy: a.policy_id, name: a.asset_name || '', qty: BigInt(a.quantity) })),
          datumBytes: u.inline_datum ? u.inline_datum.bytes : null,
          datumHash: u.datum_hash || null,
          refScript: u.reference_script ? { hash: u.reference_script.hash, size: Number(u.reference_script.size || 0) } : null
        });
      }
      if (page.length < 1000) return out;
    }
  }

  // Raw CBOR body; the response is the transaction id.
  async submit(bytes) {
    const res = await this.request('POST', '/submittx', { body: bytes, headers: { 'content-type': 'application/cbor' } });
    return String(res).replace(/"/g, '');
  }

  // hash -> confirmations (0 when seen without confirmations, null when unknown)
  async status(hashes) {
    const out = new Map();
    for (let i = 0; i < hashes.length; i += 50) {
      const rows = await this.request('POST', '/tx_status', { json: { _tx_hashes: hashes.slice(i, i + 50) } });
      for (const r of rows) out.set(r.tx_hash, r.num_confirmations ?? null);
    }
    return out;
  }
}
