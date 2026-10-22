// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Synthetic CIP-190 records signed here with a fresh Ed25519 key, stored as
// db-sync stores them (the label-309 chunk array inside a single-label
// metadata map), and a small chain of db-sync tables to hold them.

import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { encode } from './cbor-encode.mjs';

export const sha = (b) => createHash('sha256').update(b).digest('hex');

export function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, pub: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url') };
}

// A signed record body. `tamper` changes the body after signing; `cosigners`
// add signatures over the same content.
export function record(digests, key, { tamper = false, unsorted = false, supersedes = null, cosigners = [] } = {}) {
  const items = digests.map((d) => ({ hashes: { 'sha2-256': Buffer.from(d, 'hex') } }));
  const body0 = supersedes ? { v: 1, items, supersedes: Buffer.from(supersedes, 'hex') } : { v: 1, items };
  const toSign = Buffer.concat([Buffer.from('cardano-poe-record-sig-v1'), encode(body0)]);
  const cose = (k) => {
    const prot = encode(new Map([[1, -8], [4, k.pub]]));
    return encode([prot, {}, null, sign(null, encode(['Signature1', prot, Buffer.alloc(0), toSign]), k.privateKey)]);
  };
  const signedItems = tamper ? [...items, { hashes: { 'sha2-256': Buffer.alloc(32, 7) } }] : items;
  return encode({ ...body0, items: signedItems, sigs: [key, ...cosigners].map((k) => ({ cose_sign1: cose(k) })) }, { sortKeys: !unsorted });
}

export const metadataBytes = (body, size = 64) => {
  const chunks = [];
  for (let i = 0; i < body.length; i += size) chunks.push(body.subarray(i, i + size));
  return encode(new Map([[309, chunks]]));
};

// db-sync's block, tx, tx_metadata and epoch_param, as far as the freeze
// checks read them, in `db` (a fresh PGlite when none is given).
export async function chain(db = null) {
  db = db || (await PGlite.create());
  await db.exec(`
    CREATE TABLE public.block (id bigint PRIMARY KEY, block_no bigint, slot_no bigint, epoch_no int, epoch_slot_no int, time timestamp, hash bytea);
    CREATE TABLE public.tx (id bigint PRIMARY KEY, hash bytea, block_id bigint);
    CREATE TABLE public.tx_metadata (id serial PRIMARY KEY, key numeric, json jsonb, bytes bytea, tx_id bigint);
    CREATE TABLE public.epoch_param (epoch_no int PRIMARY KEY, nonce bytea, protocol_major int);
  `);
  let n = 0;
  const block = async ({ blockNo, slot, epoch, epochSlot, time = '2026-10-01 00:00:00' }) => {
    n++;
    await db.query(`INSERT INTO public.block VALUES ($1, $2, $3, $4, $5, $6::timestamp, decode($7, 'hex'))`, [n, blockNo, slot, epoch, epochSlot, time, sha(`block ${n}`)]);
    return { id: n, hash: sha(`block ${n}`) };
  };
  // A block with one transaction carrying a record and, or, a 674 line.
  const add = async ({ blockNo, slot, epoch, epochSlot, body, msg, time }) => {
    const b = await block({ blockNo, slot, epoch, epochSlot, time });
    const hash = sha(`tx ${b.id}`);
    await db.query(`INSERT INTO public.tx VALUES ($1, decode($2, 'hex'), $1)`, [b.id, hash]);
    if (body) await db.query(`INSERT INTO public.tx_metadata (key, json, bytes, tx_id) VALUES (309, NULL, $1, $2)`, [body, b.id]);
    if (msg) await db.query(`INSERT INTO public.tx_metadata (key, json, bytes, tx_id) VALUES (674, $1, '\\x00'::bytea, $2)`, [JSON.stringify({ msg: Array.isArray(msg) ? msg : [msg] }), b.id]);
    return hash;
  };
  return { db, add, block };
}
