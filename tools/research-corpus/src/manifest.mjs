// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The corpus manifest (sections 5.7 and 10.5): the snapshot block (height,
// hash, time), the published identifiers per frame and sample with their split,
// the flow tables and the code version. It names no stake address, address or
// policy of a wallet's holdings; the only transaction hashes it names are the
// two freeze records'. The raw lists, which name stake addresses, stay in the
// run directory under raw/ (mode 0600) and are never deposited; they carry no
// published identifier, so once the HMAC key is destroyed nothing links an
// identifier back to an address.
// Within each sample the identifiers are sorted, so the manifest does not carry
// the draw order (which anyone can recompute from the public rule).

import { join } from 'node:path';
import { loadKey, identifier } from './hmac.mjs';
import { writePrivate } from './paths.mjs';

export async function buildManifest({ client, run, report, hmacKeyPath, dir }) {
  const key = loadKey(hmacKeyPath || undefined);
  const rows = (
    await client.query(`
      SELECT s.frame, s.kind, s.stratum, s.sa_id, s.draw_rank, s.prevalence_member, s.split,
             c.hash_raw, c.view, coalesce(k.agree, false) AS check_61_agree,
             coalesce(fr.any_flag, false) AS franken_any
        FROM study.sample s
        JOIN study.cred c ON c.sa_id = s.sa_id
        LEFT JOIN study.check_61 k ON k.sa_id = s.sa_id
        LEFT JOIN (SELECT sa_id, bool_or(flagged) AS any_flag FROM study.franken GROUP BY sa_id) fr ON fr.sa_id = s.sa_id
       ORDER BY s.frame DESC, s.kind, s.stratum, s.draw_rank`)
  ).rows;
  const byInput = (r) => (run.settings.x15_bech32 ? r.view : r.hash_raw);
  const samples = new Map();
  const raw = ['frame,kind,stratum,sa_id,stake_address,draw_rank,prevalence_member,split,check_61_agree,franken_any'];
  for (const r of rows) {
    const id = identifier(key, byInput(r));
    const k = `${r.frame}|${r.kind}|${r.stratum}`;
    if (!samples.has(k)) samples.set(k, { frame: r.frame, kind: r.kind, stratum: r.stratum, ids: [] });
    samples.get(k).ids.push({ id, split: r.split, excluded_6_1: !r.check_61_agree, prevalence_member: r.prevalence_member });
    raw.push([r.frame, r.kind, JSON.stringify(r.stratum), r.sa_id, r.view, r.draw_rank, r.prevalence_member, r.split, r.check_61_agree, r.franken_any].join(','));
  }
  writePrivate(join(dir, 'raw', 'sample.csv'), raw.join('\n') + '\n');
  const list = [...samples.values()].map((s) => {
    s.ids.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return {
      frame: s.frame,
      kind: s.kind,
      stratum: s.stratum,
      n: s.ids.length,
      n_exploration: s.ids.filter((x) => x.split === 'exploration').length,
      n_confirmation: s.ids.filter((x) => x.split === 'confirmation').length,
      n_excluded_6_1: s.ids.filter((x) => x.excluded_6_1).length,
      ids: s.ids
    };
  });
  return {
    tool: 'research-corpus',
    network: run.network,
    run_id: run.runId,
    snapshot: { block_no: run.snapshot.block_no, hash: run.snapshot.hash, time: run.snapshot.time, slot_no: run.snapshot.slot_no, epoch_no: run.snapshot.epoch_no, chosen: run.snapshot.chosen, rule: run.snapshot.rule || null },
    freeze: freezeOf(report.freeze),
    windows: {
      recent: pickWindow(run.windows.recent),
      peak: { ...pickWindow(run.windows.peak), n_tx_rule: run.windows.peak.n_tx_rule, n_tx_valid: run.windows.peak.n_tx_valid, n_tx_view: run.windows.peak.n_tx_view }
    },
    settings: run.settings,
    flow: report.flow,
    frame_report: report.frame_report,
    draw: report.draw,
    strata: report.strata.map((s) => ({ ord: s.ord, stratum: s.stratum, part: s.part, class: s.class, policy: s.policy, asset_name: s.asset_name, n_recent: s.n_recent, n_peak: s.n_peak })),
    // Holder counts are published for candidates at or above the floor only;
    // the rule needs no more, and a thin candidate's count can be a handful.
    strata_fungible_floor: report.ft_floor.map((r) => ({ ...r, n_holders: r.n_holders >= run.settings.ft_floor ? r.n_holders : null, below_floor: !r.named && r.n_holders < run.settings.ft_floor })),
    sample_bounds: report.sample_bounds,
    split: report.split_overall,
    check_6_1: report.check_61,
    code_version: report.code_version,
    samples: list
  };
}

function freezeOf(f) {
  if (!f) return null;
  const draw = f.draw ? { e: f.draw.e, slot_no: f.draw.slot_no, first_slot: f.draw.first_slot, epoch_length: f.draw.epoch_length, k: f.draw.k, f: f.draw.f, window: f.draw.window, cutoff: f.draw.cutoff, n: f.draw.n, nonce: f.draw.nonce, readings: f.draw.readings } : null;
  return { role: f.role, tx: f.tx || null, block_no: f.block_no ?? null, block_hash: f.block_hash || null, time: f.time || null, document_sha256: f.document_sha256 || null, study_key: f.study_key || null, hypotheses: f.hypotheses || null, code_manifest_sha256: f.code_manifest_sha256 || null, draw, h: f.h };
}

function pickWindow(w) {
  return { first_block_no: w.first_block_no, last_block_no: w.last_block_no, first_time: w.first_time, last_time: w.last_time, first_epoch: w.first_epoch, last_epoch: w.last_epoch };
}
