// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Koios, for the cross-checks of artifact A1 (pre-registration sections 5.1
// and 10.5) and for the second reading of the genesis parameters and the
// epoch nonce that keys the draw. Requests are spaced at least 150 ms apart and a 429 (or a
// 5xx) is retried after the server's Retry-After, else with exponential
// backoff. On mainnet the study's own registered-tier token is sent, read from
// RESEARCH_CORPUS_KOIOS_TOKEN; on test networks no token is sent at all. The
// token embedded in the app is never used.

import { performance } from 'node:perf_hooks';

const BASE = {
  mainnet: 'https://api.koios.rest/api/v1',
  preprod: 'https://preprod.koios.rest/api/v1',
  preview: 'https://preview.koios.rest/api/v1'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Koios {
  constructor(network, { spacingMs = 150, log = () => {} } = {}) {
    if (!BASE[network]) throw new Error(`no Koios endpoint for ${network}`);
    this.network = network;
    this.base = BASE[network];
    this.spacingMs = Math.max(150, spacingMs);
    this.last = 0;
    this.log = log;
    this.requests = 0;
    if (network === 'mainnet') {
      this.token = process.env.RESEARCH_CORPUS_KOIOS_TOKEN || null;
      if (!this.token) throw new Error('mainnet Koios needs RESEARCH_CORPUS_KOIOS_TOKEN (the study token)');
    } else this.token = null;
  }

  async request(method, path, json) {
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + this.spacingMs - performance.now();
      if (wait > 0) await sleep(wait);
      this.last = performance.now();
      this.requests++;
      const headers = { accept: 'application/json' };
      if (json !== undefined) headers['content-type'] = 'application/json';
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      const res = await fetch(this.base + path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
      if ((res.status === 429 || res.status >= 500) && attempt < 6) {
        const ra = Number(res.headers.get('retry-after'));
        const ms = (Number.isFinite(ra) && ra > 0 ? ra : 2 ** attempt) * 1000;
        this.log(`koios ${res.status}, retrying in ${ms} ms`);
        await sleep(ms);
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`Koios ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
      return JSON.parse(text);
    }
  }

  async genesis() {
    const [g] = await this.request('GET', '/genesis?select=networkmagic,securityparam,activeslotcoeff,epochlength');
    return g;
  }

  async epochNonce(epochNo) {
    const rows = await this.request('GET', `/epoch_params?_epoch_no=${Number(epochNo)}&select=epoch_no,nonce`);
    const r = rows.find((x) => Number(x.epoch_no) === Number(epochNo));
    return { nonce: r ? r.nonce : null, read_at: new Date().toISOString() };
  }

  async lastBlockOfEpoch(epochNo) {
    const rows = await this.request('GET', `/blocks?epoch_no=eq.${Number(epochNo)}&order=block_height.desc&limit=1&select=hash,block_height,epoch_no,abs_slot`);
    return rows[0] || null;
  }

  async tip() {
    const [t] = await this.request('GET', '/tip');
    return { block_no: Number(t.block_no ?? t.block_height), hash: t.hash, slot: Number(t.abs_slot), epoch: Number(t.epoch_no) };
  }

  // A stake address's UTxO set, extended (asset lists), paged.
  async accountUtxos(stakeAddress) {
    const out = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await this.request('POST', `/account_utxos?order=tx_hash.asc,tx_index.asc&offset=${offset}&limit=1000`, { _stake_addresses: [stakeAddress], _extended: true });
      out.push(...page);
      if (page.length < 1000) return out;
    }
  }

  // Transactions touching a stake address after a block height.
  async accountTxsAfter(stakeAddress, blockHeight) {
    const out = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await this.request('GET', `/account_txs?_stake_address=${encodeURIComponent(stakeAddress)}&_after_block_height=${blockHeight}&offset=${offset}&limit=1000`);
      out.push(...page);
      if (page.length < 1000) break;
    }
    return out.filter((t) => Number(t.block_height) > blockHeight);
  }

  async txInfo(hashes) {
    return this.request('POST', '/tx_info', { _tx_hashes: hashes, _inputs: true, _metadata: false, _assets: true, _withdrawals: false, _certs: false, _scripts: false, _bytecode: false });
  }
}
