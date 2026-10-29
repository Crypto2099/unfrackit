// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The draw key. The study's draw is keyed to the epoch nonce of epoch N, where
// E is the epoch of the block holding the final freeze transaction and
//
//   N = E + 1  if that block's slot < first slot of E + epoch length - W
//   N = E + 2  otherwise,
//
// W being the randomness stabilization window. The rule follows the Praos
// nonce evolution in IntersectMBO/ouroboros-consensus (main at 46f4dffa,
// ouroboros-consensus-protocol/.../Ouroboros/Consensus/Protocol/PolyPraos.hs):
// a block's VRF output enters the candidate nonce only when
// `slot + W < firstSlotNextEpoch` (reupdateChainDepStatePolyPraos), and at
// the epoch boundary the new epoch nonce is that candidate nonce combined
// with the last-block nonce recorded at the previous boundary
// (tickChainDepStatePolyPraos). A
// freeze before the cutoff therefore precedes blocks whose VRF outputs fix
// the nonce of E + 1; a freeze after it comes too late for E + 1, whose nonce
// is already determined, and so keys E + 2.
//
// W is read from the network's genesis parameters, never assumed: for every
// Praos era except Babbage, ouroboros-consensus-cardano/.../Cardano/Node.hs
// (lines 592-597 at that commit) sets it to
// computeRandomnessStabilisationWindow k f, which cardano-ledger's
// eras/shelley/impl/src/Cardano/Ledger/Shelley/StabilityWindow.hs defines as
// ceiling(4k / f). Babbage used 3k/f (Shelley ledger erratum 17.3). This tool
// computes W for Conway (protocol versions 9 to 11) and refuses any other
// protocol version rather than guess.

import { UserError } from './util.mjs';

export const CONWAY_PROTOCOL_MAJORS = Object.freeze([9, 10, 11]);

// An exact ratio from a decimal string such as "0.05".
export function parseDecimal(text) {
  const s = String(text).trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new UserError(`not a plain decimal: ${text}`);
  const frac = m[2] || '';
  const den = 10n ** BigInt(frac.length);
  const num = BigInt(m[1] + frac);
  if (num === 0n) throw new UserError(`the active slot coefficient must be positive: ${text}`);
  return { num, den };
}

export function sameRatio(a, b) {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  return x.num * y.den === y.num * x.den;
}

// ceiling(4k / f) with f = num/den: ceiling(4k * den / num).
export function randomnessStabilisationWindow({ securityParam, activeSlotCoeff, protocolMajor }) {
  if (!CONWAY_PROTOCOL_MAJORS.includes(protocolMajor)) {
    throw new UserError(`this tool computes the randomness stabilization window for Conway (protocol versions ${CONWAY_PROTOCOL_MAJORS.join(', ')}) only; the freeze block's epoch has protocol version ${protocolMajor}`);
  }
  if (!Number.isSafeInteger(securityParam) || securityParam <= 0) throw new UserError(`not a security parameter: ${securityParam}`);
  const { num, den } = parseDecimal(activeSlotCoeff);
  const n = 4n * BigInt(securityParam) * den;
  return Number((n + num - 1n) / num);
}

export const DRAW_RULE =
  'N = E + 1 if the freeze block\'s slot is earlier than the first slot of E plus the epoch length minus the randomness stabilization window ceiling(4k/f), else N = E + 2';

export function drawPlan({ slot, epoch, epochSlot, securityParam, activeSlotCoeff, epochLength, protocolMajor }) {
  for (const [k, v] of Object.entries({ slot, epoch, epochSlot, epochLength })) {
    if (!Number.isSafeInteger(v) || v < 0) throw new UserError(`draw plan: ${k} is not a slot or epoch number: ${v}`);
  }
  if (epochSlot >= epochLength || epochSlot > slot) throw new UserError(`draw plan: epoch slot ${epochSlot} is inconsistent with slot ${slot} and epoch length ${epochLength}`);
  const window = randomnessStabilisationWindow({ securityParam, activeSlotCoeff, protocolMajor });
  if (window >= epochLength) throw new UserError(`draw plan: the stabilization window ${window} is not shorter than the epoch (${epochLength} slots)`);
  const firstSlot = slot - epochSlot;
  const cutoff = firstSlot + epochLength - window;
  const nonceEpoch = slot < cutoff ? epoch + 1 : epoch + 2;
  return {
    block_slot: slot,
    block_epoch: epoch,
    epoch_slot: epochSlot,
    epoch_first_slot: firstSlot,
    epoch_length: epochLength,
    security_param: securityParam,
    active_slot_coefficient: activeSlotCoeff,
    protocol_major: protocolMajor,
    stabilisation_window: window,
    cutoff_slot: cutoff,
    nonce_epoch: nonceEpoch,
    nonce_epoch_first_slot: firstSlot + (nonceEpoch - epoch) * epochLength,
    rule: DRAW_RULE
  };
}

// The plan's numbers, the part two providers must agree on.
export const PLAN_FIELDS = ['block_slot', 'block_epoch', 'epoch_slot', 'epoch_first_slot', 'epoch_length', 'security_param', 'protocol_major', 'stabilisation_window', 'cutoff_slot', 'nonce_epoch', 'nonce_epoch_first_slot'];
export const BLOCK_FIELDS = ['block_hash', 'block_height', 'slot', 'epoch', 'epoch_slot', 'block_time'];

export function differences(a, b, fields) {
  const out = [];
  for (const f of fields) if (String(a?.[f]) !== String(b?.[f])) out.push({ field: f, a: a?.[f] ?? null, b: b?.[f] ?? null });
  return out;
}

// The block of one of the tool's own transactions, as each provider reports it.
export async function koiosBlockFacts(koios, txHash) {
  const info = await koios.txInfo(txHash);
  if (!info || !info.block_hash) return null;
  return { block_hash: info.block_hash, block_height: Number(info.block_height), slot: Number(info.absolute_slot), epoch: Number(info.epoch_no), epoch_slot: Number(info.epoch_slot), block_time: Number(info.tx_timestamp) };
}

export async function blockfrostBlockFacts(bf, txHash) {
  const t = await bf.tx(txHash);
  if (!t) return null;
  const b = await bf.block(t.block);
  if (!b) return null;
  const inner = differences({ hash: t.block, height: t.block_height, slot: t.slot, time: t.block_time }, b, ['hash', 'height', 'slot', 'time']);
  if (inner.length) throw new UserError(`Blockfrost contradicts itself about the block of ${txHash}: ${inner.map((d) => `${d.field} ${d.a} (/txs) vs ${d.b} (/blocks)`).join('; ')}`);
  return { block_hash: b.hash, block_height: Number(b.height), slot: Number(b.slot), epoch: Number(b.epoch), epoch_slot: Number(b.epoch_slot), block_time: Number(b.time) };
}

export function genesisDifferences(a, b) {
  const out = differences(a, b, ['networkMagic', 'securityParam', 'epochLength']);
  if (!sameRatio(a.activeSlotCoeff, b.activeSlotCoeff)) out.push({ field: 'activeSlotCoeff', a: a.activeSlotCoeff, b: b.activeSlotCoeff });
  return out;
}

// The plan from one provider's view: its genesis, its block facts and its
// protocol version for epoch E.
export function planFrom(genesis, facts, protocolMajor) {
  return drawPlan({
    slot: facts.slot,
    epoch: facts.epoch,
    epochSlot: facts.epoch_slot,
    securityParam: genesis.securityParam,
    activeSlotCoeff: genesis.activeSlotCoeff,
    epochLength: genesis.epochLength,
    protocolMajor
  });
}

export function describeDifferences(list, aName, bName) {
  return list.map((d) => `${d.field}: ${aName} ${d.a}, ${bName} ${d.b}`).join('; ');
}
