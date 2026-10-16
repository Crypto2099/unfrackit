// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Submission with a journal, one per network. The rules:
//
// 1. The journal entry (network, transaction hash, signed CBOR, TTL, inputs)
//    is written before the first submission, and no second transaction is
//    written for a network while an unresolved one is journaled.
// 2. Every resubmission sends the identical bytes; nothing is rebuilt.
// 3. A returned transaction id must equal the computed hash.
// 4. On "All inputs are spent", "already been included" or BadInputsUTxO the
//    hash is looked up for up to ten minutes. Seen with confirmations: the
//    transaction was submitted. Not seen while its inputs are spent: the inputs
//    were consumed by another transaction, which is a failure, never a success.
// 5. Any other rejection stops with the node's message verbatim.
// 6. An entry may be abandoned only after its TTL has passed, while the hash
//    is unknown to Koios and its inputs are unspent.
//
// States: unsubmitted, submitted, confirmed (resolved), failed (resolved: the
// inputs were spent by something else), abandoned (resolved).

import { KoiosError } from './koios.mjs';
import { fromHex, sleep as realSleep, UserError } from './util.mjs';

export const CONFIRMATION_THRESHOLD = 15; // CIP-190 "Chain facts": RECOMMENDED >= 15 blocks
const RESOLVED = new Set(['confirmed', 'failed', 'abandoned']);
const SPENT_RE = /All inputs are spent|already been included|BadInputsUTxO/i;

export function isResolved(entry) {
  return !entry || RESOLVED.has(entry.state);
}

export function assertNoUnresolved(store, network, exceptHash) {
  const j = store.readJournal(network);
  if (j.current && !isResolved(j.current) && j.current.txHash !== exceptHash) {
    throw new UserError(
      `an unresolved ${network} transaction is journaled (${j.current.txHash}, state ${j.current.state}); run "submit", "wait" or, after its TTL, "abandon" before writing another`
    );
  }
  return j;
}

function retire(j) {
  if (j.current) j.history = [...(j.history || []), j.current];
  j.current = null;
}

export function journalEntry({ network, txHash, cbor, ttl, inputs, run }) {
  return {
    network,
    txHash,
    cbor,
    ttl,
    inputs: inputs.map((u) => ({ txHash: u.txHash, index: u.index, coin: String(u.coin) })),
    run,
    state: 'unsubmitted',
    journaledAt: new Date().toISOString(),
    attempts: []
  };
}

// Journal the entry (rule 1). Refuses while another unresolved entry exists.
export function journal(store, entry) {
  const j = assertNoUnresolved(store, entry.network, entry.txHash);
  if (j.current && j.current.txHash === entry.txHash) return j.current;
  retire(j);
  j.current = entry;
  store.writeJournal(entry.network, j);
  return entry;
}

function save(store, entry) {
  const j = store.readJournal(entry.network);
  if (!j.current || j.current.txHash !== entry.txHash) throw new Error('journal changed underneath the submission');
  j.current = entry;
  store.writeJournal(entry.network, j);
}

async function inputsSpent(koios, address, entry) {
  const live = new Set((await koios.addressUtxos(address)).map((u) => `${u.txHash}#${u.index}`));
  return entry.inputs.every((u) => !live.has(`${u.txHash}#${u.index}`));
}

async function inputsUnspent(koios, address, entry) {
  const live = new Set((await koios.addressUtxos(address)).map((u) => `${u.txHash}#${u.index}`));
  return entry.inputs.every((u) => live.has(`${u.txHash}#${u.index}`));
}

// Rule 4: look the hash up instead of inferring anything from the refusal.
async function resolveSpentRefusal({ koios, store, entry, address, sleep, now, pollMs, windowMs, log }) {
  const deadline = now() + windowMs;
  for (;;) {
    const conf = await koios.txStatus(entry.txHash);
    if (conf !== null && conf >= 1) {
      entry.state = 'submitted';
      entry.attempts.push({ at: new Date(now()).toISOString(), result: `seen on chain with ${conf} confirmations after the node reported its inputs spent` });
      save(store, entry);
      return { outcome: 'submitted', confirmations: conf };
    }
    if (now() >= deadline) break;
    log(`the node reports the inputs spent; looking for ${entry.txHash} on chain`);
    await sleep(pollMs);
  }
  if (await inputsSpent(koios, address, entry)) {
    entry.state = 'failed';
    entry.attempts.push({ at: new Date(now()).toISOString(), result: 'inputs consumed by another transaction' });
    save(store, entry);
    throw new UserError(`inputs consumed by another transaction: ${entry.txHash} is not on chain and its inputs are spent; this is a failure`);
  }
  throw new UserError(
    `unresolved: the node reported the inputs of ${entry.txHash} spent, but after ${Math.round(windowMs / 60000)} minutes Koios shows neither the transaction nor the spend; run "submit" again later`
  );
}

// Submit the journaled bytes (rules 2 to 5).
export async function submitJournaled({ koios, store, entry, address, sleep = realSleep, now = Date.now, pollMs = 20000, windowMs = 600000, maxAttempts = 6, log = () => {} }) {
  if (entry.state === 'submitted' || entry.state === 'confirmed') return { outcome: entry.state };
  if (isResolved(entry)) throw new UserError(`the journaled transaction ${entry.txHash} is ${entry.state}; it cannot be submitted`);
  const bytes = fromHex(entry.cbor, { lower: true });
  for (let attempt = 1; ; attempt++) {
    const at = new Date(now()).toISOString();
    let id;
    try {
      id = await koios.submit(bytes);
    } catch (e) {
      if (e instanceof KoiosError && e.status === 400) {
        const message = e.body || e.message;
        entry.attempts.push({ at, result: `HTTP 400: ${message.slice(0, 2000)}` });
        save(store, entry);
        if (SPENT_RE.test(message)) return resolveSpentRefusal({ koios, store, entry, address, sleep, now, pollMs, windowMs, log });
        throw new UserError(`the node rejected ${entry.txHash}:\n${message}`);
      }
      // A lost response, a timeout, or 429/5xx after the client's own retries:
      // the identical bytes go again.
      entry.attempts.push({ at, result: `no usable response: ${e.message.slice(0, 500)}` });
      save(store, entry);
      if (attempt >= maxAttempts) throw new UserError(`no usable response from Koios after ${attempt} attempts; the journal keeps ${entry.txHash}; run "submit" again`);
      const ra = e instanceof KoiosError && e.status === 429 ? 5000 : 2000 * attempt;
      await sleep(ra);
      continue;
    }
    if (id !== entry.txHash) {
      entry.attempts.push({ at, result: `accepted with a different id ${id}` });
      save(store, entry);
      throw new UserError(`Koios returned the id ${id} for a transaction whose computed hash is ${entry.txHash}; not counting it as submitted`);
    }
    entry.state = 'submitted';
    entry.attempts.push({ at, result: 'HTTP 202, id matches' });
    save(store, entry);
    return { outcome: 'submitted' };
  }
}

// Rule 6.
export async function abandon({ koios, store, network, address }) {
  const j = store.readJournal(network);
  const entry = j.current;
  if (!entry || isResolved(entry)) throw new UserError(`no unresolved ${network} transaction is journaled`);
  const tip = await koios.tip();
  if (tip.slot <= entry.ttl) throw new UserError(`the TTL of ${entry.txHash} (slot ${entry.ttl}) has not passed (tip slot ${tip.slot})`);
  koios.allowTx(entry.txHash);
  if ((await koios.txStatus(entry.txHash)) !== null) throw new UserError(`${entry.txHash} is known to Koios; it cannot be abandoned`);
  if (!(await inputsUnspent(koios, address, entry))) throw new UserError(`the inputs of ${entry.txHash} are not all unspent; it cannot be abandoned`);
  entry.state = 'abandoned';
  entry.abandonedAt = new Date().toISOString();
  retire(j);
  store.writeJournal(network, j);
  return entry;
}

// Poll until the threshold, then record the block facts.
export async function waitConfirmed({ koios, store, entry, threshold = CONFIRMATION_THRESHOLD, sleep = realSleep, pollMs = 20000, timeoutMs = 3600000, now = Date.now, log = () => {} }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const conf = await koios.txStatus(entry.txHash);
    log(`${entry.txHash}: ${conf === null ? 'not yet on chain' : `${conf} confirmations`}`);
    if (conf !== null && conf >= threshold) {
      const info = await koios.txInfo(entry.txHash);
      const facts = {
        confirmations: conf,
        block_height: info.block_height,
        block_hash: info.block_hash,
        absolute_slot: info.absolute_slot,
        block_time: info.tx_timestamp,
        epoch: info.epoch_no,
        tx_size: info.tx_size,
        fee: info.fee
      };
      if (entry.state !== 'confirmed') {
        const j = store.readJournal(entry.network);
        if (j.current && j.current.txHash === entry.txHash) {
          j.current.state = 'confirmed';
          j.current.confirmed = facts;
          retire(j);
          store.writeJournal(entry.network, j);
        }
      }
      return facts;
    }
    if (now() > deadline) throw new UserError(`timed out waiting for ${threshold} confirmations of ${entry.txHash}`);
    await sleep(pollMs);
  }
}
