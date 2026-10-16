# research-freeze

A command-line tool that publishes the signed Proof of Existence records of the UnFrack.It UTxO-management research pre-registration (the study) on Cardano. A record commits the SHA-256 of every file a manifest lists, under one Ed25519 signature, in the metadata of one transaction: label 309 carries a CIP-190 record and label 674 carries a CIP-20 message with the document's digest. The first record is the pre-registration freeze; later records (analysis scripts, results, a re-typing successor, an amendment) relate to it.

The tool signs everything itself: the record signature with a dedicated signing key, and the transaction's payment witness with a separate payment key. It submits through Koios and verifies every record three ways: its own reading of the raw transaction, the CardanoWall TypeScript SDK, and the CardanoWall reference CLI. The preprod rehearsal is the same sequence of commands as the mainnet freeze, with `--network preprod` and a throwaway identity.

## Install

Node 20.19 or later is required (the CardanoWall SDK's floor). From this folder:

```
npm ci
node src/cli.mjs help
npm test
```

The tool has its own `package.json` and lockfile, with every dependency pinned exactly: `@emurgo/cardano-serialization-lib-nodejs` 13.2.1, `bip39` 3.1.0, and `@cardanowall/sdk-ts`, `@cardanowall/poe-standard` and `@cardanowall/crypto-core` 0.12.0. The SDK's own dependencies are pinned through `overrides` to the versions in the SDK's release lockfile (`@noble/*`, `cbor2` 2.3.0, `zod` 4.4.3). It does not touch the dependencies, lint or build of the UnFrack.It web app in this repository.

### The CardanoWall CLI

`build`, `check` and `verify` also run the CardanoWall reference CLI, an independent Rust implementation of CIP-190. The tool refuses any version other than 0.12.0 (commit 5400a64). Install the binary outside this repository:

```
BASE=https://github.com/cardanowall/label-309-cli/releases/download/v0.12.0
curl -fsSLO "$BASE/cardanowall-v0.12.0-x86_64-unknown-linux-musl.tar.gz"
curl -fsSLO "$BASE/SHA256SUMS"
grep x86_64-unknown-linux-musl SHA256SUMS | sha256sum -c -
gh attestation verify cardanowall-v0.12.0-x86_64-unknown-linux-musl.tar.gz --repo cardanowall/label-309-cli
tar -xzf cardanowall-v0.12.0-x86_64-unknown-linux-musl.tar.gz
```

The attestation check confirms that the archive was built by the release workflow of `cardanowall/label-309-cli` at tag `v0.12.0`. Put the extracted `cardanowall` on `PATH`, or point `RESEARCH_FREEZE_CARDANOWALL` at it. Without it, `npm test` skips the CLI tests with a notice and `build` refuses to run.

## Identities and where secrets live

The home is `${XDG_DATA_HOME:-$HOME/.local/share}/unfrackit-research-freeze/`, or `RESEARCH_FREEZE_HOME`. Directories are created 0700 and files 0600; a secret is written with exclusive create and never overwritten. The tool refuses to run if the home resolves inside any git working tree, or if any directory or file in it has wider permissions.

```
identities/<name>/signing-mnemonic    identities/<name>/payment-mnemonic    identities/<name>/public.json
journal/<network>.json                runs/<network>/<tx hash>/             rehearsals/<id>/
secrets/                              tmp/
```

There are two identities. `freeze` is the real one: it signs mainnet records only. `rehearsal` is a throwaway identity that signs preprod records only, including every placeholder record of a rehearsal. The split matters because a signed record body is portable (CIP-190, "Record-level signatures (COSE_Sign1)": a verified signature binds the record body only), so a body signed by the real key on preprod could be republished on mainnet by anyone, and signing the final files on preprod would publish the exact freeze record before mainnet. `public.json` names the network each identity may sign for, and `build` refuses any other.

The `freeze` identity is created by its owner, in a real terminal, with `init --identity freeze` and then `backup --identity freeze`.

### Two mnemonics per identity

Each identity has two 24-word BIP-39 mnemonics, each generated independently of the other from 256 bits of entropy.

The signing mnemonic is a CIP-190 signing seed, not a wallet recovery phrase. Its 32-byte BIP-39 entropy, with no passphrase and no PBKDF2 step, is the CIP-190 master seed (CIP-190, "Seed and key derivation", "Master seed"). The Ed25519 secret seed is HKDF-SHA-256 of it with an empty salt, the 22-byte info string `cardano-poe-ed25519-v1` and a 32-byte output ("HKDF-SHA-256 derivation"), passed unchanged to RFC 8032 Ed25519 ("The derived keypairs"). The tool derives this key twice, through the SDK's `signerFromSeed` and through Node's own HKDF and OpenSSL's Ed25519, and refuses to sign unless the two public keys and every signature agree. It never derives the X25519 or X-Wing keys of the seed. Losing the signing mnemonic ends re-typing and amendment of the records it signed.

The payment mnemonic is an ordinary wallet phrase. Its entropy goes through the CIP-3 Icarus master-key derivation (PBKDF2-HMAC-SHA512, empty passphrase, 4096 iterations, 96 bytes, bit tweaks; CIP-3 `Icarus.md`) and then `m/1852'/1815'/0'/0/0` (CIP-1852, "Specification"). The address is the CIP-19 type-6 enterprise address of that key: the payment key hash and no delegation part, with network tag 1 on mainnet and 0 on preprod. It holds a few ADA for fees and earns no rewards.

### Why the signing key and the payment key differ

1. They come from two independently generated 256-bit entropies, one per mnemonic, so nothing relates the signing seed to the payment seed beyond the chance that two random 256-bit values are equal. The signing seed goes through HKDF-SHA-256 and RFC 8032; the payment seed goes through Icarus PBKDF2 and BIP32-Ed25519 child derivation. No wallet restore can reach the signing seed, because the signing mnemonic is never used as a wallet phrase.
2. Equal public keys would require equal scalars modulo the group order. The signing scalar is the clamped first half of SHA-512 of the HKDF output (RFC 8032 section 5.1.5); the payment scalar is the derived `kL`, used directly. From independent entropies the chance is about 2^-252.
3. `init` refuses equal entropies, computes both public keys, and refuses if they are equal or if the BLAKE2b-224 of the signing public key equals the payment key hash. `build` and `sweep` repeat the check every time they read the mnemonics, and a unit test runs it over the three public test mnemonics paired with independent payment mnemonics.
4. Even a shared key could not let one signature stand in for the other. The payment witness signs the 32-byte BLAKE2b-256 transaction-body hash. The record signature signs the canonical CBOR of `["Signature1", protected, h'', to_sign]`, which begins with the bytes `84 6a` followed by `Signature1` and is far longer than 32 bytes.

### Recovering the payment balance

The payment mnemonic alone recovers the balance: restore it in a software wallet that uses the CIP-3 Icarus derivation (a hardware wallet may derive a different key from a 24-word phrase; CIP-3 `Icarus.md`, "Trezor"). The funds sit at the enterprise address of `m/1852'/1815'/0'/0/0`, which `show` prints and which a default wallet restore does not display, because wallets list base addresses (payment key and stake key). Use a wallet that can show or import that address, or run `sweep --to <address>` from this tool. Restoring the payment mnemonic exposes nothing about the signing identity.

## Funding

Run `show --identity <name>` and send a few ADA (a few tADA on preprod) to the printed address. Every build spends all pure-ADA UTxOs at the address and returns one change output to it, so a single funding transaction covers many records. A typed record of about thirty items costs about 0.3 ADA in fees. UTxOs that carry tokens, a datum or a reference script are left untouched.

## Commands

| Command | What it does |
|---|---|
| `init [--identity <name>]` | Creates the home and the identity's two mnemonics. Prints the signing public key, the payment key hash and the mainnet and preprod addresses, never a mnemonic. Refuses if the identity exists or the two entropies are equal. The default identity is `freeze`. |
| `show [--identity <name>] [--json]` | Prints the same public facts, read from `public.json` alone. |
| `backup [--identity <name>]` | Prints both mnemonics, labeled, for a paper backup. Refuses unless stdin and stdout are an interactive terminal. |
| `hash <manifest> [--identity <name>]` | Hashes every file of the manifest and runs the byte-form and document checks below. |
| `build <manifest> --network <n> [--identity <name>] [--core-only]` | Builds and signs the record, carries it, builds and signs the transaction, runs every offline check, and writes a run directory only if all pass. Submits nothing. `--core-only` omits `research-items`. The default identity is `freeze` on mainnet and `rehearsal` on preprod. |
| `check <run>` | Runs the offline checks again on a run directory. |
| `submit <run>` | Submits the run's exact signed bytes through the journal. On mainnet it requires an interactive terminal and the operator typing the first eight hex digits of the transaction hash. |
| `wait <run>` | Polls until 15 confirmations, then records the block height, block hash, slot and block time. |
| `verify <run or tx hash> --network <n> [--json]` | Verifies on chain three ways (see Checks) and prints the block facts with links to two explorers. Accepts only the home's own transactions. |
| `abandon --network <n>` | Drops a journaled transaction, only after its TTL has passed, while Koios does not know its hash and its inputs are unspent. |
| `rehearse <manifest> --network preprod [--doi <doi>]` | Runs the whole sequence on preprod with the `rehearsal` identity. `--resume <id>` continues an interrupted rehearsal. Refuses mainnet. |
| `registry datacite <doi> [--tx <hash>]` | Fetches `https://api.datacite.org/dois/<doi>` and reports whether it resolves, its `resourceTypeGeneral`, and whether its related identifiers carry the record URI with `URL` and `IsSupplementedBy`. Exits 0 when the DOI resolves (and the back-link is present, with `--tx`), 1 when the back-link is missing, 2 when the DOI does not resolve. |
| `registry zenodo-sandbox <step>` | Rehearses the registry deposit on `https://sandbox.zenodo.org` in steps: `create` (a draft with a reserved DOI), `upload <id> <file>` (checks the MD5 Zenodo reports), `link <id> --tx <hash> --embargo <YYYY-MM-DD>` (embargoed access, CC BY 4.0, and the record URI as a related identifier with relation `isSupplementedBy`), `publish <id>`, and `check <id>` (the scheme Zenodo assigned, the DataCite export, the anonymous download). The token comes from `secrets/zenodo-sandbox.token` (0600) or `RESEARCH_FREEZE_ZENODO_SANDBOX_TOKEN`; a production Zenodo token does not work in the sandbox. Every request and response is logged under `registry/zenodo-sandbox/` with the token redacted. |
| `sweep --to <address> --network <n>` | Returns every pure-ADA UTxO at the payment address to one address, with the same journal and mainnet guard as `submit`. |

`<run>` is a run directory or the transaction hash of one. Koios is reached at `https://api.koios.rest/api/v1` or `https://preprod.koios.rest/api/v1` (public tier, no token); `RESEARCH_FREEZE_KOIOS_URL` overrides the endpoint, and the network guard still applies.

### The manifest

The manifest is a JSON file kept outside the repository. It lists the items in record order with each file's path (relative to the manifest), its `research-items` type and its identifiers, the record kind, and for later kinds the `supersedes` hash and the `related` entries. File names and paths never go on chain.

```json
{
  "format": "research-freeze-manifest-v1",
  "kind": "freeze",
  "doi": "10.5281/zenodo.00000000",
  "items": [
    { "path": "files/registration.md", "type": "StudyRegistration", "document": true,
      "ids": [{ "id": "10.5281/zenodo.00000000", "id_type": "DOI", "relation": "IsPartOf" }] },
    { "path": "files/notes.md", "type": "Text" },
    { "path": "files/source-1.mjs", "type": "Software" },
    { "path": "files/data.bin", "type": "Dataset", "binary": true }
  ]
}
```

- `kind` is `freeze`, `scripts`, `results`, `retype` or `amend`.
- `freeze`, `retype` and `amend` name exactly one item as the `document`; its digest is the CIP-20 line. `scripts` and `results` flag one or more items with `"message": true` instead.
- `freeze` needs `doi`, the reserved DOI as a lowercase bare DOI name, and the document must carry it among its identifiers.
- `retype` and `amend` need `supersedes`, the 64-digit lowercase hash of the transaction they supersede. The tool reads the superseded record from its own run directory: a `retype` carries every item of it with identical digests in the same order, and both must be signed by the same key.
- `scripts` and `results` need `related`, a list of `{ "uri", "relation", "relation_info"? }` whose `uri` is a record URI.
- `type`, `id_type` and `relation` take the DataCite Metadata Schema 4.7 values (`resourceTypeGeneral`, `relatedIdentifierType`, `relationType`), spelled exactly; anything else is refused.

## The record and the byte form it hashes

Every digest is SHA-256 over the file exactly as it sits on disk, byte for byte, with no normalization (CIP-190, "Exact-bytes scope of a PoE claim"). A text item must already be valid UTF-8 with LF line endings and no byte-order mark; a file that is not is refused rather than normalized, unless the manifest marks it `binary`.

For the `freeze` kind, `hash` and `build` also check the document against the manifest. Every line of the form `<64 lowercase hex><two spaces><file name>` must name a non-document item and carry its computed digest; every non-document item must appear exactly once; the document must not list itself; and the document must carry the identity's signing public key and the manifest's DOI. Any mismatch fails.

The label-309 value is a CIP-190 record, a canonical CBOR map (CIP-190, "Canonical CBOR (deterministic encoding)": RFC 8949 section 4.2.1, shortest integers, definite lengths, keys sorted bytewise by their encoding, no duplicates, no tags, no floats):

- `v`: 1.
- `items`: one `{ "hashes": { "sha2-256": <32 bytes> } }` per manifest item, in manifest order (CIP-190, "Item entries", "Hash algorithms").
- `sigs`: one `{ "cose_sign1": <bytes> }` (CIP-190, "Sig-entry shape").
- `supersedes`: the 32-byte transaction hash, for `retype` and `amend` only ("Supersedence").
- `research-items`: a map from each item's 32-byte digest (the same bytes as in `items[i].hashes`) to `{ "type": <text>, "ids"?: [{ "id", "id_type", "relation", "relation_info"? }] }`. DOIs are lowercase bare DOI names. Omitted with `--core-only`.
- `research-related`: for later kinds, a list of `{ "uri", "relation", "relation_info"? }`, where `uri` matches `^web\+cardano://transaction/[0-9a-f]{64}/metadata/309$` exactly (a CIP-0107 transaction-metadata URI under the CIP-0013 scheme).

The `research-` keys are top-level extension keys in CIP-190's companion-CIP namespace (`^[a-z]+-.+`; "Forward compatibility and critical extensions"). They are covered by the signature, and the tool never writes `crit`, so a default CIP-190 verifier validates the record and surfaces the keys informationally. Canonical ordering puts the top-level keys in the order `v`, `sigs`, `items`, `supersedes`, `research-items`, `research-related`.

The signature follows CIP-190, "Record-level signatures (COSE_Sign1)". `to_sign` is the 25 ASCII bytes `cardano-poe-record-sig-v1` followed by the canonical CBOR of the record without `sigs`, `Sig_structure` is `["Signature1", protected, h'', to_sign]`, and the payload is `null`, detached ("Signed payload and Sig_structure"). The protected header is `{1: -8, 4: <32-byte public key>}`, which encodes as `a2 01 27 04 58 20` and the key: algorithm -8 ("Signing algorithm") and the raw public key as `kid` (path 1, "Signer-key identification"). The unprotected header is the empty map and the COSE_Sign1 is untagged, as the conformance vector `cose/sign1-build.json` pins. CIP-8 makes `version` and `hashed` mandatory in the unprotected header ("Version", "Payload encoding"), but CIP-190 treats an absent `hashed` as false ("Signing algorithm", its paragraph on CIP-8 `hashed` mode) and makes its conformance vectors authoritative in any byte-level dispute ("Conventions and terminology"); the tool follows CIP-190 and never uses hashed mode.

The record is carried as a definite-length array of definite-length byte strings, the minimal split (every chunk 64 bytes except the last), even when the body is 64 bytes or fewer (CIP-190, "Metadata label 309 and the chunk-array transport"). The label-674 value is `{ "msg": [ "<64 lowercase hex>" ] }` (CIP-20, "Specification"). The transaction carries no other label, and no byte of it contains the string `unfrack.it` in any letter case. The auxiliary data is the untagged metadata map, one of the three forms CIP-190 accepts ("Auxiliary-data envelope forms").

Every step is done twice: once by the SDK and once by this tool's own canonical encoder, and the bytes must be identical, including the bytes-keyed `research-items` map.

The transaction spends every pure-ADA UTxO at the payment address and returns one output to it. The fee is `min_fee_a * size + min_fee_b` over the serialized signed transaction, iterated to a fixed point and checked against CSL's `min_fee`; the change must hold at least CSL's `min_ada_for_output`, or the build stops with the shortfall. The TTL is the tip slot plus 7,200 slots. The body carries the network id (1 or 0) and `auxiliary_data_hash`.

## Submission and the journal

`submit` keeps a journal per network in the home:

1. The journal entry (network, transaction hash, signed CBOR, TTL, inputs) is written before the first submission, and no second transaction is written for a network while an unresolved one is journaled.
2. Every resubmission sends the identical bytes; nothing is rebuilt automatically.
3. The transaction id Koios returns must equal the computed hash.
4. If the node answers "All inputs are spent", "already been included" or `BadInputsUTxO`, the tool looks the hash up for up to ten minutes. Seen with confirmations, the transaction counts as submitted. Not seen while its inputs are spent, the tool stops with "inputs consumed by another transaction", which is a failure.
5. Any other rejection stops with the node's message verbatim.
6. An entry can be abandoned only after its TTL has passed, while the hash is unknown to Koios and its inputs are unspent.

Koios `POST /submittx` takes the raw CBOR with `content-type: application/cbor`; success is HTTP 202 with the transaction id. Requests are spaced, and 429 and 5xx answers are retried with the server's `Retry-After`. `wait` polls until 15 confirmations, CIP-190's recommended threshold and the reference CLI's default, and records the block facts.

### What the tool queries

Before the freeze block no study query may run, so the tool sends Koios only `/genesis`, `/tip`, `/epoch_params`, `/address_utxos` for the identity's own payment address, `/submittx`, and `/tx_status`, `/tx_info` and `/tx_cbor` for its own transactions. The Koios client refuses any other address or transaction hash. It never queries another address, account, asset or transaction. The network guard runs before anything is built or signed: `/genesis` must report network magic 764824073 and `Mainnet` for `--network mainnet`, or 1 and `Testnet` for `preprod`. The SDK verifier and the reference CLI, run by `verify`, read only `/tx_cbor`, `/tx_info` and `/tip` for the same transaction; their audit trails, which `verify --json` prints, show each call.

## Checks

### Offline, inside `build` and `check`

- The transaction, from its serialized bytes through CSL's `FixedTransaction` and the SDK's byte-faithful slicer: BLAKE2b-256 of the raw body equals the transaction hash; BLAKE2b-256 of the raw auxiliary data equals the body's `auxiliary_data_hash`; the auxiliary data is exactly the expected untagged map; the metadata labels are exactly 309 and 674; every chunk is 1 to 64 bytes and they reassemble to the record body byte for byte; the 674 message is exactly the expected digest; CSL refuses a 65-byte metadata byte string; no `unfrack.it`; the size is within `max_tx_size`; the body holds only inputs, outputs, fee, TTL, `auxiliary_data_hash` and network id; the fee is `min_fee_a * size + min_fee_b` and equals CSL `min_fee`; one output to the expected address with the network tag and at least its minimum ADA; one vkey witness, from the payment key, verifying against the body hash under CSL and OpenSSL.
- The SDK's `validatePoeRecord` (default options) reports the record valid, and its `coseSign1Label309Verify` verifies the signature against the identity's key.
- `cardanowall verify --record` exits 0 with verdict `valid`, reports the identity's key as the signer and the manifest digests as the items, and echoes the `research-` keys in its report's record with no issue raised.
- `cardanowall sign prepare --signer-pubkey <key>` over the body without `sigs` gives the same `Sig_structure` byte for byte. This involves no secret.
- For the `rehearsal` identity only, `cardanowall sign record --seed-file` (the seed as hex in a 0600 file in the home's `tmp/`, removed afterward) produces the same signed body, and `cardanowall identity --seed-stdin` reports the same public key. The real identity's seed is never passed to another program.

The run directory holds the record body, the body without `sigs`, the `Sig_structure`, the COSE_Sign1, the label-309 value, the metadata in `cardano-api` detailed JSON (for reading only), the signed transaction, its hash, the CIP-0107 URI, and a report with the versions of Node, CSL, the SDK and the CLI, the pinned specification commits, the fee, the inputs, the TTL and every check.

### On chain, in `verify`

- This tool fetches the raw transaction from Koios `/tx_cbor`, never the metadata JSON view (CIP-190, "Structural validation, verifier roles, and error codes", Part B, "Pipeline", step 1), checks the transaction-hash and `auxiliary_data_hash` binding (step 2), reassembles the record and compares it with the run's bytes, validates it, verifies the signature, and reads the block height, hash, slot and time from `/tx_info`, with the confirmation depth computed as tip height minus block height plus one ("Chain facts: block time and confirmation depth").
- The SDK's `verifyTx`, against the network's Koios endpoint, in the default `signed` profile.
- `cardanowall verify <tx> --network <n> --cardano-gateway <Koios URL> --json`, in its default `signed` profile. The CLI defaults to Koios mainnet whatever `--network` says, so the tool always passes the endpoint.

Block facts come from one provider; `verify` prints links to cardanoscan.io and cexplorer.io (with the `preprod.` host on preprod) so a reader can cross-check them on two independent explorers.

### Unit tests (`npm test`)

`npm test` runs `node --test test/*.test.mjs` offline. It covers:

- the label-309 v0.10.0 conformance vectors below, copied byte for byte into `test/vectors/label-309-v0.10.0/` with label-309's Apache-2.0 `LICENSE` and a `PROVENANCE.json` recording the source commit (a51bad8d31669ccbf533bac6ec8c39dd38ff0388) and each file's SHA-256, which the first test checks;
- the signing key of the three public test mnemonics (`abandon` x23 `art`, `zoo` x23 `vote`, and the `deadbeef` mnemonic), through the SDK and through Node and OpenSSL; the CIP-3 Icarus master key; the CIP-11 key at `m/1852'/1815'/0'/2/0`; the CIP-19 type-6 addresses; refusal of equal entropies and of mnemonics other than 24 words; the key-separation check;
- all five record kinds with placeholder digests: canonical round trip through both encoders, the SDK validator, and the top-level key order; negative controls: a `research-` key in `crit` fails with `EXTENSION_UNSUPPORTED_CRITICAL`, a misspelled base key with `SCHEMA_UNKNOWN_FIELD`, and an uppercase hex digit in a record URI is refused by the builder;
- transaction building and every post-build assertion, with fake UTxOs;
- the journal state machine against a fake Koios: a lost response followed by "All inputs are spent" with the hash found (submitted), the same with the hash absent and the inputs spent (failure), 429 then success, a returned id that differs (failure), abandonment rules;
- the mainnet guard and `backup` refusing without a terminal, the refusal of a home inside a checkout or with loose permissions, the `unfrack.it` scanner, and the network guard;
- when the CLI is installed, `cardanowall verify --record` over the `poe-record/` vectors and every positive and negative `validator/` entry, in the `core` and `signed` profiles, giving the verdicts and error codes the vectors pin.

The 27 vector files used, by directory:

| Directory | Files | Count |
|---|---|---|
| `cbor/` | `canonical-decode-negative.json`, `canonical-encode-rfc8949-kat.json`, `canonical-encode-roundtrip.json` | 3 |
| `hash/` | `sha256-kat.json`, `blake2b256-kat.json` | 2 |
| `kdf/` | `hkdf-sha256-kat.json`, `hkdf-sha256-empty-salt-kat.json` | 2 |
| `sig/` | `ed25519-kat.json`, `ed25519-torsion-cctv.json` | 2 |
| `cose/` | `sig-structure.json`, `sign1-build.json`, `sign1-strict-ed25519.json`, `sign1-verify.json`, `to-sign-verbatim.json` | 5 |
| `seed-derive/` | `seed-from-zero.json`, `seed-from-ff.json`, `seed-from-deadbeef.json`, `seed-derive-negative.json` | 4 |
| `carriage/` | `aux-data-envelope-forms.json`, `chunk-array-negative.json`, `chunk-array-positive.json` | 3 |
| `cardano/` | `tx-binding.json`, `confirmation-depth.json` | 2 |
| `poe-record/` | `maximal-record-with-extension-keys.json`, `mixed-signature-record.json` | 2 |
| `validator/` | `validator-positive.json`, `validator-negative.json` | 2 |

Out of scope, because the tool emits none of these structures: sealed PoE and its KEM, AEAD, Argon2id, passphrase and Unicode vectors, the X25519 and X-Wing keys and recipient strings, Merkle commitments and leaves lists, inclusion certificates, wallet-path (CIP-30) COSE signatures including `cose/attached-detached-transform.json`, and the cross-service records.

## The preprod rehearsal and the mainnet guard

`rehearse <manifest> --network preprod` reads the mainnet freeze manifest's item names, types and document flag, and generates one placeholder text file per item, with distinct content per run. The placeholder document carries a hash table of the other placeholders, the rehearsal public key and a placeholder DOI (`--doi` supplies a sandbox DOI instead), so the document checks run as they will for the mainnet freeze. It then builds, checks, submits, waits for 15 confirmations and verifies, in order: a core-only freeze record, a typed freeze record, a re-typing successor that supersedes the typed record and adds a second placeholder identifier, and a scripts record whose `research-related` names the typed record with `IsSupplementTo`. It keeps its state in `rehearsals/<id>/state.json` and resumes with `--resume <id>`. It refuses mainnet.

On mainnet, `submit` and `sweep` require an interactive terminal on stdin and stdout and the operator typing the first eight hex digits of the transaction hash. `build` never submits.

## Specifications

The code cites these by number and section where it relies on them.

- CIP-190, Proof of Existence Transaction Metadata, at `cardano-foundation/CIPs` merge commit 58b4dd1417e139595dfabc92467d49bb3ffc0a07, with its registries and conformance vectors at `cardanowall/label-309` tag `v0.10.0` (commit a51bad8d31669ccbf533bac6ec8c39dd38ff0388). The label-309 repository is pre-1.0; its changelog states that the wire format, registries and vectors may change in backward-incompatible ways until 1.0, so both pins are fixed.
- CIP-20 (label 674 messages), CIP-10 (labels 309 and 674 are registered).
- CIP-0107 (transaction and metadata-label URIs) and CIP-0013 (the `web+cardano:` scheme).
- CIP-8 (COSE_Sign1 and `Sig_structure`, as CIP-190 uses them).
- CIP-3 with `Icarus.md` (master key from entropy), CIP-1852 (derivation path), CIP-19 (addresses, type 6, the test vectors), CIP-5 (the `addr` and `addr_test` prefixes), CIP-11 (the staking-key test vector).
- RFC 8949 section 4.2.1 (deterministic CBOR), RFC 9052 (COSE), RFC 8032 (Ed25519), RFC 5869 (HKDF), RFC 8410 (Ed25519 key encodings for OpenSSL).
- DataCite Metadata Schema 4.7 controlled lists, `schema.datacite.org/meta/kernel-4.7/include/`.
- Koios API v1.4.2; the Zenodo REST API (`developers.zenodo.org`); the DataCite REST API (`api.datacite.org`).
- The reference implementations: `cardanowall/label-309-ts` tag v0.12.0 (commit f7e9b82) and `cardanowall/label-309-cli` tag v0.12.0 (commit 5400a64).

## License

The tool's code is licensed under Apache-2.0 (see `LICENSE`). This README is licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). The vectors under `test/vectors/label-309-v0.10.0/` are copied from `cardanowall/label-309` under its Apache-2.0 license, included beside them.
