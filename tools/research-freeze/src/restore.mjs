// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// `restore --identity <name>`: recreate an identity's secret files from its
// two mnemonics, typed into a real terminal from the paper backup. Losing the
// signing mnemonic ends re-typing and amendment; losing the home must not, so
// the backup is enough to sign again.
//
// The words are read without echo. Both mnemonics pass the same checks as
// `init` (24 words, BIP-39 checksum, distinct entropies, distinct keys). The
// derived keys must equal the identity's public.json when one is present;
// without one, --signing-key is required (for example the key a published
// record carries), because the name alone decides the network an identity
// signs for, and the real mnemonics typed under the rehearsal name would give
// the real key a preprod identity. A key that another identity of the home
// already has is refused. Neither mnemonic file may exist already.

import { deriveIdentity, publicFacts } from './keys.mjs';
import { askHidden, requireTty } from './tty.mjs';
import { UserError } from './util.mjs';

// The words of a typed mnemonic: lowercase, any whitespace between them, and
// the numbers of a numbered paper list ("1." or "1") dropped, which no BIP-39
// word can be confused with.
export function normalizeTyped(line) {
  return String(line)
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w && !/^\d+\.?$/.test(w))
    .join(' ');
}

function compareFacts(derived, existing) {
  const diffs = [];
  if (derived.signing_public_key !== existing.signing_public_key) diffs.push(`signing public key ${derived.signing_public_key}, public.json has ${existing.signing_public_key}`);
  if (derived.payment_key_hash !== existing.payment_key_hash) diffs.push(`payment key hash ${derived.payment_key_hash}, public.json has ${existing.payment_key_hash}`);
  for (const n of ['mainnet', 'preprod']) {
    if (derived.addresses[n] !== existing.addresses?.[n]) diffs.push(`${n} address ${derived.addresses[n]}, public.json has ${existing.addresses?.[n]}`);
  }
  if (JSON.stringify(derived.networks) !== JSON.stringify(existing.networks)) diffs.push(`networks ${derived.networks}, public.json has ${existing.networks}`);
  return diffs;
}

export async function restoreIdentity({ store, name, expectSigningKey, streams = { stdin: process.stdin, stdout: process.stdout } }) {
  requireTty('restore', streams);
  if (expectSigningKey !== undefined && !/^[0-9a-f]{64}$/.test(expectSigningKey)) throw new UserError('--signing-key must be 64 lowercase hex digits');
  const present = store.existingMnemonicFiles(name);
  if (present.length) throw new UserError(`identity "${name}" already has ${present.join(' and ')} in ${store.home}; refusing to overwrite`);
  const existing = store.hasPublic(name) ? store.readPublic(name) : null;
  if (!existing && !expectSigningKey) {
    throw new UserError(`identity "${name}" has no public.json in ${store.home}; pass --signing-key <hex> with the signing key the identity is known by, so the words are checked against it`);
  }
  streams.stdout.write(`Restoring identity "${name}" in ${store.home}. The words are not shown as you type.\n`);
  const signingMnemonic = normalizeTyped(await askHidden('Signing mnemonic (24 words, one line): ', streams));
  const paymentMnemonic = normalizeTyped(await askHidden('Payment mnemonic (24 words, one line): ', streams));
  const id = deriveIdentity(signingMnemonic, paymentMnemonic);
  const facts = publicFacts(name, id);
  if (expectSigningKey && facts.signing_public_key !== expectSigningKey) {
    throw new UserError(`the signing mnemonic gives the key ${facts.signing_public_key}, not the expected ${expectSigningKey}; nothing was written`);
  }
  if (existing) {
    const diffs = compareFacts(facts, existing);
    if (diffs.length) throw new UserError(`the mnemonics do not give this identity's public.json; nothing was written:\n  ${diffs.join('\n  ')}`);
  }
  for (const other of store.identityNames().filter((n) => n !== name && store.hasPublic(n))) {
    const p = store.readPublic(other);
    if (p.signing_public_key === facts.signing_public_key || p.payment_key_hash === facts.payment_key_hash) {
      throw new UserError(`the mnemonics give the keys of identity "${other}" in this home; one identity's keys are never restored under another name; nothing was written`);
    }
  }
  store.restoreIdentity(name, { signingMnemonic, paymentMnemonic, publicJson: existing ? null : { ...facts, restored: new Date().toISOString() } });
  return { facts, checkedAgainst: [existing ? 'public.json' : null, expectSigningKey ? '--signing-key' : null].filter(Boolean) };
}
