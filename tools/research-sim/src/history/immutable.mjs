// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Transaction bytes from a cardano-node's ImmutableDB, read without
// modification.
//
// On-disk format, read at IntersectMBO/ouroboros-consensus commit
// a0e8f68afeac411fcc8262f9271438314a87ed02:
// - ouroboros-consensus/src/ouroboros-consensus/Ouroboros/Consensus/Storage/
//   ImmutableDB/Impl/Util.hs: chunk n is stored as <n, five digits>.chunk
//   with its indexes <n>.primary and <n>.secondary (renderFile).
// - .../ImmutableDB/Impl/Index/Secondary.hs: the secondary index is a
//   sequence of fixed-size entries, one per block of the chunk in order, each
//   blockOffset (Word64, big-endian), headerOffset (Word16), headerSize
//   (Word16), checksum (Word32, the CRC-32 of the block's bytes), headerHash
//   (32 bytes for a Cardano block) and the block's slot, or an EBB's epoch
//   (Word64): 56 bytes. A block's size is the next entry's offset less its
//   own; the last block runs to the end of the chunk file (BlockSize,
//   LastEntry).
// - .../ImmutableDB/Chunks/Internal.hs: simpleChunkInfo gives every chunk the
//   same number of slots. A Cardano node uses the Byron epoch size, 21,600
//   slots on mainnet and preprod, so a block of slot s sits in chunk
//   floor(s / 21600). The chunk size is a setting.
// - ouroboros-consensus-cardano/src/ouroboros-consensus-cardano/Ouroboros/
//   Consensus/Cardano/Node.hs:120-200 (encodeDiskHfcBlock): a block on disk
//   is the two-element list [era tag, block], tags 2 to 7 for Shelley,
//   Allegra, Mary, Alonzo, Babbage and Conway (0 and 1 are Byron's).
// A Shelley-era block is the Conway CDDL's block
// (IntersectMBO/cardano-ledger at 391db20866113f08bc6317cb5c341304365986c6,
// eras/conway/impl/cddl/data/conway.cddl:8-14): [header, transaction_bodies,
// transaction_witness_sets, auxiliary_data_set, invalid_transactions], the
// last element present from Alonzo on. A transaction is reassembled from its
// body, witness set, auxiliary data and validity with their original bytes.

import { spawn } from 'node:child_process';
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { decode, raw, asUint, CborError } from './cbor.mjs';
import { assembleTx } from './tx.mjs';

export const ENTRY_SIZE = 56;
export const ERA_TAGS = { 2: 'shelley', 3: 'allegra', 4: 'mary', 5: 'alonzo', 6: 'babbage', 7: 'conway' };

export const chunkName = (n, kind) => `${String(n).padStart(5, '0')}.${kind}`;

export function parseSecondary(buf) {
  if (buf.length % ENTRY_SIZE !== 0) throw new Error(`secondary index of ${buf.length} bytes is not a whole number of ${ENTRY_SIZE}-byte entries`);
  const out = [];
  for (let p = 0; p < buf.length; p += ENTRY_SIZE) {
    out.push({
      blockOffset: Number(buf.readBigUInt64BE(p)),
      headerOffset: buf.readUInt16BE(p + 8),
      headerSize: buf.readUInt16BE(p + 10),
      checksum: buf.readUInt32BE(p + 12),
      hash: buf.subarray(p + 16, p + 48).toString('hex'),
      slotOrEpoch: Number(buf.readBigUInt64BE(p + 48))
    });
  }
  return out;
}

// Local files (tests, or a node on this machine).
export class LocalAccess {
  constructor(dir) {
    this.dir = dir;
  }
  async readIndex(chunk) {
    const sec = readFileSync(join(this.dir, chunkName(chunk, 'secondary')));
    const size = statSync(join(this.dir, chunkName(chunk, 'chunk'))).size;
    return { secondary: sec, chunkSize: size };
  }
  async readRanges(chunk, ranges) {
    const fd = openSync(join(this.dir, chunkName(chunk, 'chunk')), 'r');
    try {
      return ranges.map(([off, len]) => {
        const b = Buffer.alloc(len);
        let got = 0;
        while (got < len) {
          const n = readSync(fd, b, got, len - got, off + got);
          if (n <= 0) throw new Error(`short read in chunk ${chunk}`);
          got += n;
        }
        return b;
      });
    } finally {
      closeSync(fd);
    }
  }
}

function runSsh(host, command, sshArgs = []) {
  return new Promise((resolve, reject) => {
    const p = spawn('ssh', ['-o', 'BatchMode=yes', ...sshArgs, host, command], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) reject(new Error(`ssh ${host}: exit ${code}: ${Buffer.concat(err).toString('utf8').trim().slice(0, 300)}`));
      else resolve(Buffer.concat(out));
    });
  });
}

// The chain database of a node on another host, read over SSH with `cat`,
// `stat` and `dd`, which only read. The directory is checked to hold nothing
// a shell would interpret.
export class SshAccess {
  constructor(host, dir, sshArgs = []) {
    if (!/^[A-Za-z0-9._@-]+$/.test(host)) throw new Error('bad ssh host');
    if (!/^\/[A-Za-z0-9._/-]+$/.test(dir)) throw new Error('bad immutable directory');
    this.host = host;
    this.dir = dir;
    this.sshArgs = sshArgs;
  }
  async readIndex(chunk) {
    const sec = `${this.dir}/${chunkName(chunk, 'secondary')}`;
    const chk = `${this.dir}/${chunkName(chunk, 'chunk')}`;
    // The chunk file's size first, on one line, then the secondary index.
    const out = await runSsh(this.host, `stat -c %s ${chk} && cat ${sec}`, this.sshArgs);
    const nl = out.indexOf(0x0a);
    const chunkSize = Number(out.subarray(0, nl).toString('ascii'));
    if (!Number.isSafeInteger(chunkSize)) throw new Error(`chunk ${chunk}: bad size`);
    return { secondary: out.subarray(nl + 1), chunkSize };
  }
  async readRanges(chunk, ranges) {
    const chk = `${this.dir}/${chunkName(chunk, 'chunk')}`;
    for (const [o, l] of ranges) if (!Number.isSafeInteger(o) || !Number.isSafeInteger(l) || o < 0 || l <= 0) throw new Error('bad range');
    const cmd = ranges.map(([o, l]) => `dd if=${chk} bs=65536 iflag=skip_bytes,count_bytes skip=${o} count=${l} status=none`).join(' && ');
    const out = await runSsh(this.host, cmd, this.sshArgs);
    const total = ranges.reduce((s, [, l]) => s + l, 0);
    if (out.length !== total) throw new Error(`chunk ${chunk}: read ${out.length} bytes, expected ${total}`);
    const parts = [];
    let p = 0;
    for (const [, l] of ranges) {
      parts.push(out.subarray(p, p + l));
      p += l;
    }
    return parts;
  }
}

// Decodes a block as stored: [era tag, block]. Returns the era and, per
// transaction, its body, witness set and auxiliary data bytes and validity.
export function decodeBlock(bytes) {
  const top = decode(bytes);
  if (top.mt !== 4 || top.items.length !== 2) throw new CborError('block: expected [era, block]');
  const tag = Number(asUint(top.items[0], 'era tag'));
  if (!(tag in ERA_TAGS)) throw new CborError(`block: era tag ${tag} is not a Shelley-based era`);
  const blk = top.items[1];
  const alonzo = tag >= 5;
  if (blk.mt !== 4 || blk.items.length !== (alonzo ? 5 : 4)) throw new CborError(`block: expected ${alonzo ? 5 : 4} items`);
  const [, bodies, wits, auxSet, invalid] = blk.items;
  if (bodies.mt !== 4 || wits.mt !== 4 || bodies.items.length !== wits.items.length) throw new CborError('block: bodies and witness sets differ in number');
  if (auxSet.mt !== 5) throw new CborError('block: auxiliary data set is not a map');
  const aux = new Map(auxSet.entries.map(([k, v]) => [Number(asUint(k, 'transaction index')), raw(bytes, v)]));
  const invalidSet = new Set(alonzo ? invalid.items.map((x) => Number(asUint(x, 'invalid index'))) : []);
  const txs = bodies.items.map((b, i) => ({
    body: raw(bytes, b),
    wits: raw(bytes, wits.items[i]),
    aux: aux.has(i) ? aux.get(i) : null,
    isValid: !invalidSet.has(i)
  }));
  return { era: ERA_TAGS[tag], tag, alonzo, txs };
}

export class ImmutableReader {
  constructor(access, { chunkSlots = 21600 } = {}) {
    this.access = access;
    this.chunkSlots = chunkSlots;
    this.indexes = new Map();
  }

  async index(chunk) {
    if (!this.indexes.has(chunk)) {
      const { secondary, chunkSize } = await this.access.readIndex(chunk);
      this.indexes.set(chunk, { entries: parseSecondary(secondary), chunkSize });
    }
    return this.indexes.get(chunk);
  }

  // blocks: [{ slot, hash }]. Returns a Map from block hash to its bytes,
  // each checked against the secondary index's CRC-32.
  async readBlocks(blocks) {
    const byChunk = new Map();
    for (const b of blocks) {
      const c = Math.floor(Number(b.slot) / this.chunkSlots);
      if (!byChunk.has(c)) byChunk.set(c, []);
      byChunk.get(c).push(b);
    }
    const out = new Map();
    for (const [chunk, bs] of [...byChunk].sort((a, b) => a[0] - b[0])) {
      const { entries, chunkSize } = await this.index(chunk);
      const want = [];
      for (const b of bs) {
        const i = entries.findIndex((e) => e.hash === b.hash);
        if (i < 0) throw new Error(`block ${b.hash} (slot ${b.slot}) is not in chunk ${chunk} of the ImmutableDB`);
        const e = entries[i];
        if (e.slotOrEpoch !== Number(b.slot)) throw new Error(`block ${b.hash}: the index gives slot ${e.slotOrEpoch}, the database ${b.slot}`);
        const end = i + 1 < entries.length ? entries[i + 1].blockOffset : chunkSize;
        want.push({ b, e, off: e.blockOffset, len: end - e.blockOffset });
      }
      const got = await this.access.readRanges(chunk, want.map((w) => [w.off, w.len]));
      want.forEach((w, k) => {
        const bytes = Buffer.from(got[k]);
        if (crc32(bytes) >>> 0 !== w.e.checksum) throw new Error(`block ${w.b.hash}: CRC-32 differs from the secondary index`);
        out.set(w.b.hash, bytes);
      });
    }
    return out;
  }

  // txs: [{ txId, blockHash, slot, blockIndex }]. Returns a Map from txId to
  // the reassembled transaction bytes.
  async readTxs(txs) {
    const blocks = new Map();
    for (const t of txs) blocks.set(t.blockHash, { hash: t.blockHash, slot: t.slot });
    const bytes = await this.readBlocks([...blocks.values()]);
    const decoded = new Map();
    const out = new Map();
    for (const t of txs) {
      if (!decoded.has(t.blockHash)) decoded.set(t.blockHash, decodeBlock(bytes.get(t.blockHash)));
      const blk = decoded.get(t.blockHash);
      const part = blk.txs[t.blockIndex];
      if (!part) throw new Error(`block ${t.blockHash} has no transaction at index ${t.blockIndex}`);
      out.set(t.txId, assembleTx({ ...part, alonzo: blk.alonzo }));
    }
    return out;
  }
}
