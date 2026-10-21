// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Submission with a journal, one per network. The rules:
//
// 1. The journal entry (network, transaction hash, signed CBOR, TTL, inputs)
//    is written before the first submission, and no second transaction is
//    written for a network while an unresolved one is journaled. Every
//    read-modify-write of the journal holds an exclusive lock file.
// 2. Every resubmission sends the identical bytes; nothing is rebuilt.
// 3. A returned transaction id must equal the computed hash.
// 4. On "All inputs are spent", "already been included" or BadInputsUTxO the
//    hash is looked up for up to ten minutes. Seen: the transaction was
//    submitted. If its inputs then read as spent, one negative answer is not
//    taken as proof (CIP-190 "Structural validation, verifier roles, and error
//    codes", Part B, "Pipeline", step 1: a single provider's negative answer
//    is not authoritative): the hash is looked up for a further ten minutes
//    and in the payment address's own history, where any transaction that
//    spent those inputs must appear, because only this payment key can spend
//    them. Still not found: the entry is recorded as failed, which stays
//    unresolved until `abandon` checks the hash again.
// 5. Any other rejection stops with the node's message verbatim.
// 6. An entry may be abandoned only after its TTL has passed, while Koios
//    knows nothing of the hash (/tx_status, /tx_info and the address history)
//    and, unless it is recorded as failed, its inputs are unspent.
//
// States: unsubmitted, submitted, failed (all unresolved); confirmed and
// abandoned (resolved).

import { KoiosError } from './koios.mjs';
import { fromHex, sleep as realSleep, UserError } from './util.mjs';

export const CONFIRMATION_THRESHOLD = 15; // CIP-190 "Chain facts": RECOMMENDED >= 15 blocks
const RESOLVED = new Set(['confirmed', 'abandoned']);
const SPENT_RE = /All inputs are spent|already been included|BadInputsUTxO/i;
const MAX_RETRY_AFTER_MS = 600000;

export function isResolved(entry) {
  return !entry || RESOLVED.has(entry.state);
}

function checkNoUnresolved(j, network, exceptHash) {
  if (j.current && !isResolved(j.current) && j.current.txHash !== exceptHash) {
    const next =
      j.current.state === 'failed'
        ? 'run "wait" if it may still land, or after its TTL "abandon", which looks the hash up again'
        : 'run "submit", "wait" or, after its TTL, "abandon"';
    throw new UserError(`an unresolved ${network} transaction is journaled (${j.current.txHash}, state ${j.current.state}); ${next} before writing another`);
  }
}

export function assertNoUnresolved(store, network, exceptHash) {
  const j = store.readJournal(network);
  checkNoUnresolved(j, network, exceptHash);
  return j;
}

function retire(j) {
  if (j.current) j.history = [...(j.history || []), j.current];
  j.current = null;
}

export function journalEntry({ network, txHash, cbor, ttl, inputs, run, kind = null, stage = null, identity = null, signingPublicKey = null }) {
  return {
    network,
    txHash,
    cbor,
    ttl,
    inputs: inputs.map((u) => ({ txHash: u.txHash, index: u.index, coin: String(u.coin) })),
    run,
    kind,
    stage,
    identity,
    signing_public_key: signingPublicKey,
    state: 'unsubmitted',
    journaledAt: new Date().toISOString(),
    attempts: []
  };
}

// Every entry of a network's journal, current and retired.
export function journalEntries(store, network) {
  const j = store.readJournal(network);
  return [...(j.history || []), ...(j.current ? [j.current] : [])];
}

// Journal the entry (rule 1). Refuses while another unresolved entry exists.
export function journal(store, entry) {
  return store.updateJournal(entry.network, (j) => {
    checkNoUnresolved(j, entry.network, entry.txHash);
    if (j.current && j.current.txHash === entry.txHash) return j.current;
    retire(j);
    j.current = entry;
    return entry;
  });
}

function save(store, entry) {
  store.updateJournal(entry.network, (j) => {
    if (!j.current || j.current.txHash !== entry.txHash) throw new Error('journal changed underneath the submission');
    j.current = entry;
  });
}

async function liveInputs(koios, address) {
  return new Set((await koios.addressUtxos(address)).map((u) => `${u.txHash}#${u.index}`));
}

async function inputsSpent(koios, address, entry) {
  const live = await liveInputs(koios, address);
  return entry.inputs.every((u) => !live.has(`${u.txHash}#${u.index}`));
}

async function inputsUnspent(koios, address, entry) {
  const live = await liveInputs(koios, address);
  return entry.inputs.every((u) => live.has(`${u.txHash}#${u.index}`));
}

// One lookup of the hash: /tx_status, then /tx_info. Null when neither knows it.
async function lookOnce(koios, txHash) {
  const conf = await koios.txStatus(txHash);
  if (conf !== null && conf >= 1) return `/tx_status reports ${conf} confirmations`;
  const info = await koios.txInfo(txHash);
  if (info && info.block_height !== null && info.block_height !== undefined) return `/tx_info places it in block ${info.block_height}`;
  return null;
}

// Look the hash up every `pollMs` for `windowMs`.
async function lookFor({ koios, entry, sleep, now, pollMs, windowMs, log, why }) {
  const deadline = now() + windowMs;
  for (;;) {
    const seen = await lookOnce(koios, entry.txHash);
    if (seen) return seen;
    if (now() >= deadline) return null;
    log(`${why}; looking for ${entry.txHash} on chain`);
    await sleep(pollMs);
  }
}

async function inAddressHistory(koios, address, txHash) {
  return (await koios.addressTxs(address)).some((t) => t.txHash === txHash);
}

function markSubmitted(store, entry, now, how) {
  entry.state = 'submitted';
  entry.attempts.push({ at: new Date(now()).toISOString(), result: `found on chain: ${how}` });
  save(store, entry);
  return { outcome: 'submitted', how };
}

function failedMessage(entry, when) {
  return (
    `recorded as failed, and unresolved: the inputs of ${entry.txHash} read as spent, and Koios did not find the transaction ` +
    `(/tx_status, /tx_info and the payment address's history) ${when}. Either another transaction consumed the inputs, ` +
    `or Koios has not caught up. The journal keeps the entry unresolved: run "wait" if it may still land, or after its TTL (slot ${entry.ttl}) ` +
    `run "abandon", which looks the hash up again before releasing the journal`
  );
}

// Rule 4: look the hash up instead of inferring anything from the refusal.
async function resolveSpentRefusal({ koios, store, entry, address, sleep, now, pollMs, windowMs, log }) {
  const seen = await lookFor({ koios, entry, sleep, now, pollMs, windowMs, log, why: 'the node reports the inputs spent' });
  if (seen) return markSubmitted(store, entry, now, seen);
  if (!(await inputsSpent(koios, address, entry))) {
    throw new UserError(
      `unresolved: the node reported the inputs of ${entry.txHash} spent, but after ${Math.round(windowMs / 60000)} minutes Koios shows neither the transaction nor the spend; run "submit" again later`
    );
  }
  // The inputs read as spent and the hash is still unknown. A lagging Koios
  // instance, or an inclusion just after the last poll, looks exactly like
  // this, so nothing is decided from it yet.
  const again = await lookFor({ koios, entry, sleep, now, pollMs, windowMs, log, why: 'the inputs read as spent but the transaction is not found yet' });
  if (again) return markSubmitted(store, entry, now, again);
  if (await inAddressHistory(koios, address, entry.txHash)) return markSubmitted(store, entry, now, 'it is in the payment address\'s transaction history');
  entry.state = 'failed';
  entry.attempts.push({ at: new Date(now()).toISOString(), result: 'inputs read as spent; the hash was not found by /tx_status, /tx_info or the address history' });
  save(store, entry);
  throw new UserError(failedMessage(entry, `within ${Math.round((2 * windowMs) / 60000)} minutes`));
}

// Submit the journaled bytes (rules 2 to 5).
export async function submitJournaled({ koios, store, entry, address, sleep = realSleep, now = Date.now, pollMs = 20000, windowMs = 600000, maxAttempts = 6, log = () => {} }) {
  if (entry.state === 'submitted' || entry.state === 'confirmed') return { outcome: entry.state };
  if (entry.state === 'failed') {
    // Nothing is sent again: the entry's inputs read as spent. Look again.
    const seen = (await lookOnce(koios, entry.txHash)) || ((await inAddressHistory(koios, address, entry.txHash)) ? 'it is in the payment address\'s transaction history' : null);
    if (seen) return markSubmitted(store, entry, now, seen);
    throw new UserError(failedMessage(entry, 'on this look either'));
  }
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
      // A lost response, a timeout, or 429/5xx: the identical bytes go again,
      // after the server's Retry-After when it sent one.
      entry.attempts.push({ at, result: `no usable response: ${e.message.slice(0, 500)}` });
      save(store, entry);
      if (attempt >= maxAttempts) throw new UserError(`no usable response from Koios after ${attempt} attempts; the journal keeps ${entry.txHash}; run "submit" again`);
      const retryAfter = e instanceof KoiosError && e.retryAfterMs !== null && e.retryAfterMs !== undefined ? Math.min(e.retryAfterMs, MAX_RETRY_AFTER_MS) : null;
      await sleep(retryAfter !== null ? retryAfter : e instanceof KoiosError && e.status === 429 ? 5000 : 2000 * attempt);
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
  const entry = store.readJournal(network).current;
  if (!entry || isResolved(entry)) throw new UserError(`no unresolved ${network} transaction is journaled`);
  const tip = await koios.tip();
  if (tip.slot <= entry.ttl) throw new UserError(`the TTL of ${entry.txHash} (slot ${entry.ttl}) has not passed (tip slot ${tip.slot})`);
  koios.allowTx(entry.txHash);
  if ((await koios.txStatus(entry.txHash)) !== null) throw new UserError(`${entry.txHash} is known to Koios /tx_status; it cannot be abandoned`);
  if ((await koios.txInfo(entry.txHash)) !== null) throw new UserError(`${entry.txHash} is known to Koios /tx_info; it cannot be abandoned`);
  if (await inAddressHistory(koios, address, entry.txHash)) throw new UserError(`${entry.txHash} is in the payment address's transaction history; it cannot be abandoned`);
  if (entry.state !== 'failed' && !(await inputsUnspent(koios, address, entry))) {
    throw new UserError(`the inputs of ${entry.txHash} are not all unspent; it cannot be abandoned (run "submit" to look the hash up)`);
  }
  return store.updateJournal(network, (j) => {
    if (!j.current || j.current.txHash !== entry.txHash || j.current.state !== entry.state) throw new UserError('the journal changed while abandon was checking; run it again');
    j.current.state = 'abandoned';
    j.current.abandonedFrom = entry.state;
    j.current.abandonedAt = new Date().toISOString();
    const out = j.current;
    retire(j);
    return out;
  });
}

// Poll until the threshold, then record what Koios reports for the block.
// These facts come from one provider; `verify` reads them again from Koios
// and from Blockfrost and fails on any difference.
export async function waitConfirmed({ koios, store, entry, threshold = CONFIRMATION_THRESHOLD, sleep = realSleep, pollMs = 20000, timeoutMs = 3600000, now = Date.now, log = () => {} }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const conf = await koios.txStatus(entry.txHash);
    log(`${entry.txHash}: ${conf === null ? 'not yet on chain' : `${conf} confirmations`}`);
    if (conf !== null && conf >= threshold) {
      const info = await koios.txInfo(entry.txHash);
      // /tx_status and /tx_info may be answered by different Koios instances;
      // a missing row means "not yet", never a block.
      if (info && info.block_hash) {
        const facts = {
          confirmations: conf,
          at: new Date(now()).toISOString(),
          source: 'koios',
          block_height: Number(info.block_height),
          block_hash: info.block_hash,
          absolute_slot: Number(info.absolute_slot),
          epoch: Number(info.epoch_no),
          epoch_slot: Number(info.epoch_slot),
          block_time: Number(info.tx_timestamp),
          tx_size: info.tx_size,
          fee: info.fee
        };
        if (entry.state !== 'confirmed') {
          store.updateJournal(entry.network, (j) => {
            if (j.current && j.current.txHash === entry.txHash) {
              j.current.state = 'confirmed';
              j.current.confirmed = facts;
              retire(j);
            }
          });
        }
        return facts;
      }
      log(`${entry.txHash}: /tx_info has no block for it yet`);
    }
    if (now() > deadline) throw new UserError(`timed out waiting for ${threshold} confirmations of ${entry.txHash}`);
    await sleep(pollMs);
  }
}
