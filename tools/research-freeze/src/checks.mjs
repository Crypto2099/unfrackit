// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The offline checks a build must pass before its run directory is written,
// and that `check` repeats on an existing run directory.

import fs from 'node:fs';
import { coseSign1Label309Verify } from '@cardanowall/crypto-core/cose';
import { validatePoeRecord } from '@cardanowall/poe-standard';
import { decode, mapGet } from './cbor.mjs';
import { VERIFY_FLAGS } from './cardanowall.mjs';
import { assertTransaction } from './tx.mjs';
import { toHex, UserError } from './util.mjs';

function result(name, ok, detail) {
  return { name, ok: Boolean(ok), detail: detail === undefined ? undefined : String(detail) };
}

function issuesText(issues) {
  return (issues || []).map((i) => `${i.code}@${(i.path || []).join('.')}`).join(', ');
}

// a: { body, bodyNoSigs, sigStructure, coseSign1, txBytes, txExpect, digests: [hex], publicKeyHex }
export function checkArtifacts(a, { cli, store, rehearsalSeed } = {}) {
  const out = [];
  const tx = assertTransaction(a.txBytes, a.txExpect);
  for (const c of tx.checks) out.push(result(c, true));

  const v = validatePoeRecord(a.body);
  out.push(result('SDK validatePoeRecord (default options) reports valid', v.valid, v.valid ? undefined : issuesText(v.issues)));
  const sig = coseSign1Label309Verify({ message: a.coseSign1, detachedRecordBodyCbor: a.bodyNoSigs });
  out.push(result('SDK coseSign1Label309Verify verifies the signature', sig.ok && toHex(sig.signerKey) === a.publicKeyHex, sig.ok ? toHex(sig.signerKey) : sig.error?.code));

  const decoded = decode(a.body, { canonical: true });
  const items = mapGet(decoded, 'items').map((it) => toHex(mapGet(mapGet(it, 'hashes'), 'sha2-256')));
  out.push(result('the record items are the manifest digests in order', items.join() === a.digests.join()));

  if (!cli) {
    out.push(result('cardanowall CLI checks', false, 'the cardanowall CLI is not available'));
    return out;
  }
  const tmp = store.writeTempSecret(toHex(a.body));
  try {
    const r = cli.json(['verify', '--record', tmp, '--json', ...VERIFY_FLAGS]);
    const j = r.json || {};
    out.push(result('cardanowall verify --record exits 0 with verdict valid', r.status === 0 && j.verdict === 'valid', `exit ${r.status}, verdict ${j.verdict}, issues ${issuesText(j.issues)}`));
    const signer = (j.signatures || [])[0];
    out.push(result('cardanowall reports the identity\'s key as the signer', j.signatures?.length === 1 && signer?.signerPub === a.publicKeyHex && signer?.verdict === 'valid', signer?.signerPub));
    const cliItems = (j.record?.items || []).map((it) => it.hashes?.['sha2-256']);
    out.push(result('cardanowall reports the manifest digests as the items', cliItems.join() === a.digests.join()));
    const ext = Object.keys(j.record || {}).filter((k) => k.startsWith('research-'));
    const expectedExt = [...decoded.keys()].filter((k) => typeof k === 'string' && k.startsWith('research-'));
    out.push(
      result(
        'cardanowall surfaces the research- keys informationally (in the report\'s record, with no issue raised)',
        ext.sort().join() === expectedExt.sort().join() && (j.issues || []).length === 0,
        ext.length ? ext.join(', ') : 'none present'
      )
    );
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  const p = cli.json(['sign', 'prepare', '--signer-pubkey', a.publicKeyHex], { input: toHex(a.bodyNoSigs) });
  out.push(result('cardanowall sign prepare gives the same Sig_structure byte for byte', p.status === 0 && p.json?.sig_structure_hex === toHex(a.sigStructure), `exit ${p.status}`));

  if (rehearsalSeed) {
    // The rehearsal seed only, never the real identity's: a 0600 file in the
    // home's tmp directory, removed afterwards.
    const seedFile = store.writeTempSecret(toHex(rehearsalSeed));
    try {
      const s = cli.json(['sign', 'record', '--seed-file', seedFile, '--json'], { input: toHex(a.bodyNoSigs) });
      out.push(result('cardanowall sign record with the rehearsal seed produces the same signed body', s.status === 0 && s.json?.record_cbor_hex === toHex(a.body), `exit ${s.status}`));
      const id = cli.json(['identity', '--seed-stdin', '--json'], { input: toHex(rehearsalSeed) });
      out.push(result('cardanowall identity reports the same public key', id.status === 0 && id.json?.ed25519_pubkey_hex === a.publicKeyHex, id.json?.ed25519_pubkey_hex));
    } finally {
      fs.rmSync(seedFile, { force: true });
    }
  }
  return out;
}

export function requireAllPass(results) {
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new UserError(`offline checks failed:\n${failed.map((f) => `  FAIL ${f.name}${f.detail ? `: ${f.detail}` : ''}`).join('\n')}`);
  }
}
