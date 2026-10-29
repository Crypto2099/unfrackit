// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Submission with a journal, one per network. The rules:
//
// 1. The journal entry (network, transaction hash, signed CBOR, TTL, inputs)
//    is written before the first submission, and no second transaction is
//    written for a network while an unresolved one is journaled. Every
//    read-modify-write of the journal holds an exclusive lock file.
// 2. Every resubmission sends the identical bytes; nothing is rebuilt
//    except by an explicit `build --rebuild` (rule 7).
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
//    nor does Blockfrost when a project id is present (always on mainnet),
//    and its inputs are unspent; or, for an entry recorded as failed, while
//    another transaction in the address history is found to have spent them.
//    On mainnet a hypotheses- or final-stage freeze whose record may have
//    left the machine is never abandoned: a broadcast body can be replayed
//    later, so the key signs no other record in its place.
// 7. Such an entry is rebuilt instead, after its TTL and under rule 6's
//    checks for it and for every transaction it replaced: a new transaction
//    carrying the same label-309 record and 674 line byte for byte takes its
//    place in the journal, and the old entry is recorded as replaced.
//
// States: unsubmitted, submitted, failed (all unresolved); confirmed,
// abandoned and replaced (resolved).

import { KoiosError } from './koios.mjs';
import { auxiliaryBytes } from './tx.mjs';
import { equalBytes, fromHex, sleep as realSleep, UserError } from './util.mjs';

export const CONFIRMATION_THRESHOLD = 15; // CIP-190 "Chain facts": RECOMMENDED >= 15 blocks
const RESOLVED = new Set(['confirmed', 'abandoned', 'replaced']);
const STAGED = new Set(['hypotheses', 'final']);
const SPENT_RE = /All inputs are spent|already been included|BadInputsUTxO/i;
const MAX_RETRY_AFTER_MS = 600000;

export function isResolved(entry) {
  return !entry || RESOLVED.has(entry.state);
}

function entriesOf(j) {
  return [...(j.history || []), ...(j.current ? [j.current] : [])];
}

function checkNoUnresolved(j, network, exceptHash) {
  if (j.current && !isResolved(j.current) && j.current.txHash !== exceptHash) {
    const next = keepsRecord(entriesOf(j), j.current)
      ? `its record cannot be abandoned: ${keptRecordNext(j.current)}`
      : j.current.state === 'failed'
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

export function journalEntry({ network, txHash, cbor, ttl, inputs, run, kind = null, stage = null, identity = null, signingPublicKey = null, replaces = null }) {
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
    ...(replaces ? { replaces } : {}),
    state: 'unsubmitted',
    journaledAt: new Date().toISOString(),
    attempts: []
  };
}

// Every entry of a network's journal, current and retired.
export function journalEntries(store, network) {
  return entriesOf(store.readJournal(network));
}

// Whether a submission of the entry may have left this machine, whatever
// the answer: a lost response can hide an accepted submission.
// `submitJournaled` records `sentAt` before its first request, so a process
// killed while the request was in flight still counts. Any recorded attempt,
// or a state that only a submission reaches, counts as well.
export function wasSent(entry) {
  return Boolean(entry.sentAt) || (entry.attempts || []).length > 0 || ['submitted', 'failed', 'confirmed'].includes(entry.state);
}

// The entry and the entries it replaced, newest first: the transactions
// that carry the same signed record.
export function carriersOf(entries, entry) {
  const out = [entry];
  for (let e = entry; e.replaces; ) {
    e = entries.find((x) => x.txHash === e.replaces);
    if (!e || out.includes(e)) break;
    out.push(e);
  }
  return out;
}

// On mainnet the record of a hypotheses- or final-stage freeze is kept once
// it may have left this machine in any transaction that carries it: the
// entry is never abandoned, and the key signs no other record in its place,
// because a broadcast body can be replayed later. An entry that was built
// and journaled but never sent, and never replaced a sent one, stays
// abandonable.
export function keepsRecord(entries, entry) {
  return entry.network === 'mainnet' && STAGED.has(entry.stage) && carriersOf(entries, entry).some(wasSent);
}

// What to do with a kept record instead of abandoning it. `submit` sends
// the journaled bytes again only while no answer has accepted them; after an
// HTTP 202 it sends nothing more, and for a failed entry it looks the hash
// up again.
function keptRecordNext(entry) {
  const submit =
    entry.state === 'unsubmitted' ? ', or "submit" again to send the same bytes' : entry.state === 'failed' ? ', or "submit" again to look the hash up' : '';
  return (
    `before its TTL (slot ${entry.ttl}), run "wait" if it may still land${submit}; once the TTL has passed without it landing, ` +
    `"build --rebuild ${entry.txHash} --network ${entry.network}" builds a new transaction around the same signed record and 674 line, and "submit" sends it in this one's place`
  );
}

export function assertAbandonable(entries, entry) {
  if (!keepsRecord(entries, entry)) return;
  const sent = carriersOf(entries, entry).filter(wasSent).map((e) => e.txHash);
  throw new UserError(
    `${entry.txHash} carries a ${entry.stage}-stage freeze record that may have left this machine (sent in ${sent.join(', ')}); on mainnet that record is never abandoned for a newly signed one, because a broadcast body can be replayed later. ` +
      `Instead: ${keptRecordNext(entry)}`
  );
}

// The draw is keyed to one final freeze: on mainnet, another final-stage
// entry that was neither abandoned nor replaced rules out a second one. A
// replaced entry does not count because the entry replacing it carries the
// same record and counts instead. `except`: a hash or a list of hashes.
export function blockingFinal(entries, except) {
  const skip = new Set([].concat(except ?? []));
  return entries.find((e) => e.stage === 'final' && !skip.has(e.txHash) && e.state !== 'abandoned' && e.state !== 'replaced') || null;
}

export function assertNoOtherFinal(entries, network, except) {
  if (network !== 'mainnet') return;
  const other = blockingFinal(entries, except);
  if (other) throw new UserError(`a final-stage freeze is already journaled on mainnet (${other.txHash}, state ${other.state}); the draw is keyed to one final freeze, so a second is refused`);
}

// A rebuilt entry takes the place of the unresolved entry it `replaces`,
// which is retired as replaced, only when that entry is still in the state
// `expect` recorded when the caller checked that it cannot land, it is a
// staged freeze signed by the same key, the new transaction carries
// byte for byte the same auxiliary data (the label-309 record and the 674
// line), and, unless the old entry failed because another transaction
// spent its inputs, the new one spends every input of the old one, so at
// most one of the two can land.
function replaceCurrent(j, entry, expect) {
  const old = j.current;
  if (!old || old.txHash !== entry.replaces || isResolved(old)) {
    throw new UserError(`${entry.txHash} replaces ${entry.replaces}, which is not the unresolved ${entry.network} transaction of the journal${old && !isResolved(old) ? ` (that is ${old.txHash})` : ''}; refusing`);
  }
  if (!expect || expect.txHash !== old.txHash || expect.state !== old.state || (expect.sentAt || null) !== (old.sentAt || null) || (expect.attempts || []).length !== (old.attempts || []).length) {
    throw new UserError(`the journal entry of ${old.txHash} changed while it was checked, or was not checked; run "submit" again`);
  }
  if (!STAGED.has(old.stage) || old.stage !== entry.stage || old.signing_public_key !== entry.signing_public_key) {
    throw new UserError(`${entry.txHash} is not the same staged freeze as ${old.txHash} (stage ${entry.stage} and ${old.stage}); refusing to replace it`);
  }
  const before = auxiliaryBytes(fromHex(old.cbor));
  const after = auxiliaryBytes(fromHex(entry.cbor));
  if (!before || !after || !equalBytes(before, after)) {
    throw new UserError(`${entry.txHash} does not carry the record of ${old.txHash} byte for byte (its label-309 value or its 674 line differs); a rebuild carries the same signed record, so it is refused`);
  }
  const spends = new Set(entry.inputs.map((u) => `${u.txHash}#${u.index}`));
  if (old.state !== 'failed' && !old.inputs.every((u) => spends.has(`${u.txHash}#${u.index}`))) {
    throw new UserError(`${entry.txHash} does not spend every input of ${old.txHash}, so both could land; refusing to replace it`);
  }
  old.replacedFrom = old.state;
  old.state = 'replaced';
  old.replacedBy = entry.txHash;
  old.replacedAt = new Date().toISOString();
  retire(j);
}

// Journal the entry (rule 1). Refuses while another unresolved entry exists,
// and, for a mainnet final freeze, while another final freeze is journaled.
// Both checks run inside the locked read-modify-write, immediately before
// the first submission, so nothing that happened while the operator was at
// the prompt can slip past them. An entry that `replaces` another first
// takes that one's place (see replaceCurrent); `replacing` is the replaced
// entry as the caller found it.
export function journal(store, entry, { replacing = null } = {}) {
  return store.updateJournal(entry.network, (j) => {
    if (entry.replaces && !(j.current && j.current.txHash === entry.txHash)) replaceCurrent(j, entry, replacing);
    checkNoUnresolved(j, entry.network, entry.txHash);
    if (entry.stage === 'final') assertNoOtherFinal(entriesOf(j), entry.network, entry.txHash);
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
    if (!entry.sentAt) {
      // Written before the request leaves: from here on the bytes may be
      // out, whatever answer comes back or fails to.
      entry.sentAt = at;
      save(store, entry);
    }
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

// The transaction in the payment address's history, other than the entry's
// own, that spent one of the entry's inputs, or null. Only this payment key
// can spend those inputs, so such a transaction is in that history.
async function spenderOf(koios, address, entry) {
  const wanted = new Set(entry.inputs.map((u) => `${u.txHash}#${u.index}`));
  const history = await koios.addressTxs(address);
  for (const t of [...history].reverse()) {
    if (t.txHash === entry.txHash) continue;
    const inputs = await koios.txInputs(t.txHash);
    if (inputs && inputs.some((i) => wanted.has(i))) return t.txHash;
  }
  return null;
}

async function assertUnknown({ koios, bf, address, entry, txHash, verb }) {
  const who = txHash === entry.txHash ? 'it' : entry.txHash;
  koios.allowTx(txHash);
  if ((await koios.txStatus(txHash)) !== null) throw new UserError(`${txHash} is known to Koios /tx_status; ${who} cannot be ${verb}`);
  if ((await koios.txInfo(txHash)) !== null) throw new UserError(`${txHash} is known to Koios /tx_info; ${who} cannot be ${verb}`);
  if (await inAddressHistory(koios, address, txHash)) throw new UserError(`${txHash} is in the payment address's transaction history; ${who} cannot be ${verb}`);
  // One provider's negative answers are not authoritative (CIP-190 Part B,
  // "Pipeline", step 1): the second provider must not know the hash either.
  if (bf) {
    bf.allowTx(txHash);
    if ((await bf.tx(txHash)) !== null) throw new UserError(`${txHash} is known to Blockfrost; ${who} cannot be ${verb}`);
  }
}

// Rule 6's checks that a journaled transaction can no longer land: its TTL
// has passed, neither Koios nor Blockfrost (when given) knows its hash, and
// its inputs are unspent; or, for an entry recorded as failed, another
// transaction in the address history spent them. `earlier`: the hashes of
// transactions the entry replaced, carrying the same record, none of which
// may be known either. `bf` is the Blockfrost client when the home holds a
// project id (the callers require one on mainnet).
export async function assertCannotLand({ koios, bf = null, entry, address, earlier = [], verb = 'abandoned' }) {
  const tip = await koios.tip();
  if (tip.slot <= entry.ttl) throw new UserError(`the TTL of ${entry.txHash} (slot ${entry.ttl}) has not passed (tip slot ${tip.slot})`);
  for (const txHash of [entry.txHash, ...earlier]) await assertUnknown({ koios, bf, address, entry, txHash, verb });
  let spentBy = null;
  if (entry.state === 'failed') {
    // A failed entry's inputs read as spent while its hash is unknown. Most
    // likely a provider is inconsistent, so it is released only when the
    // transaction that did spend those inputs is found.
    spentBy = await spenderOf(koios, address, entry);
    if (!spentBy) throw new UserError(`the inputs of ${entry.txHash} read as spent, but no other transaction in the payment address's history spends them; it cannot be ${verb}`);
  } else if (!(await inputsUnspent(koios, address, entry))) {
    throw new UserError(`the inputs of ${entry.txHash} are not all unspent; it cannot be ${verb} (run "submit" to look the hash up)`);
  }
  return { spentBy };
}

// Rule 6. On mainnet a staged freeze whose record may have left this
// machine is refused before anything is asked of a provider, and again
// inside the locked write, where a submission begun meanwhile would show.
export async function abandon({ koios, store, network, address, bf = null }) {
  const entry = store.readJournal(network).current;
  if (!entry || isResolved(entry)) throw new UserError(`no unresolved ${network} transaction is journaled`);
  assertAbandonable(journalEntries(store, network), entry);
  const { spentBy } = await assertCannotLand({ koios, bf, entry, address });
  return store.updateJournal(network, (j) => {
    if (!j.current || j.current.txHash !== entry.txHash || j.current.state !== entry.state) throw new UserError('the journal changed while abandon was checking; run it again');
    assertAbandonable(entriesOf(j), j.current);
    j.current.state = 'abandoned';
    j.current.abandonedFrom = entry.state;
    j.current.abandonedAt = new Date().toISOString();
    if (spentBy) j.current.inputsSpentBy = spentBy;
    if (bf) j.current.abandonCheckedWith = ['koios', 'blockfrost'];
    const out = j.current;
    retire(j);
    return out;
  });
}

// The entry a rebuild replaces: the journal's unresolved entry, which must
// be a hypotheses- or final-stage freeze. Nothing is asked of a provider.
export function rebuildTarget(store, network, txHash) {
  const entry = store.readJournal(network).current;
  if (!entry || entry.txHash !== txHash || isResolved(entry)) {
    throw new UserError(`${txHash} is not the unresolved ${network} transaction of the journal${entry && !isResolved(entry) ? ` (that is ${entry.txHash})` : ''}; only that one can be rebuilt`);
  }
  if (!STAGED.has(entry.stage)) throw new UserError(`${txHash} is ${entry.kind ? `a ${entry.kind}` : 'an unstaged'} transaction; only a hypotheses- or final-stage freeze is rebuilt around its signed record (abandon this one instead)`);
  return entry;
}

// Rule 7's checks, run by `build --rebuild` and again by `submit` of the
// rebuilt run: neither the entry nor any transaction it replaced can land
// (rule 6's checks, for each of them). Returns the entry as it was found,
// for `journal` to compare under the lock.
export async function assertRebuildable({ koios, bf = null, store, network, txHash, address }) {
  const entry = rebuildTarget(store, network, txHash);
  const earlier = carriersOf(journalEntries(store, network), entry).slice(1).map((e) => e.txHash);
  const { spentBy } = await assertCannotLand({ koios, bf, entry, address, earlier, verb: 'rebuilt' });
  return { entry, earlier, spentBy };
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
