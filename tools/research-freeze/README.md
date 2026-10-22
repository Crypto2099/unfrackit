# research-freeze

A command-line tool that publishes the signed Proof of Existence records of the UnFrack.It UTxO-management research pre-registration (the study) on Cardano. A record commits the SHA-256 of every file a manifest lists, under one Ed25519 signature, in the metadata of one transaction: label 309 carries a CIP-190 record and label 674 carries a CIP-20 message with the document's digest. The pre-registration is frozen in two stages: a hypotheses record before any live-fire check of the study's code against mainnet, and the final freeze after those checks, whose block determines the epoch whose nonce keys the study's draw. Later records (analysis scripts, results, a re-typing successor, an amendment) relate to the final freeze.

The tool signs everything itself: the record signature with a dedicated signing key, and the transaction's payment witness with a separate payment key. It submits through Koios and verifies every record three ways: its own reading of the raw transaction, the CardanoWall TypeScript SDK, and the CardanoWall reference CLI. Chain facts that matter (the freeze block, the draw plan and the nonce) are read from Koios and from Blockfrost and compared. The preprod rehearsal is the same sequence of commands as the mainnet records, with `--network preprod` and a throwaway identity.

## Install

Node 20.19 or later is required (the CardanoWall SDK's floor). From this folder:

```
npm ci
node src/cli.mjs help
npm test
```

The tool has its own `package.json` and lockfile, with every dependency pinned exactly: `@emurgo/cardano-serialization-lib-nodejs` 13.2.1, `bip39` 3.1.0, and `@cardanowall/sdk-ts`, `@cardanowall/poe-standard` and `@cardanowall/crypto-core` 0.12.0. The SDK's own dependencies are pinned through `overrides` to the versions in the SDK's release lockfile (`@noble/*`, `cbor2` 2.3.0, `zod` 4.4.3). It does not touch the dependencies, lint or build of the UnFrack.It web app in this repository.

### The CardanoWall CLI

`build`, `check` and `verify` also run the CardanoWall reference CLI, an independent Rust implementation of CIP-190. The tool refuses any binary other than the `cardanowall` of the v0.12.0 release's `x86_64-unknown-linux-musl` archive: it must report version 0.12.0 (commit 5400a64) and its SHA-256 must be `ac43f67ee3ef4372836e358613f255a61f7997ef9021972da41b74b767efcc2c`. Install the binary outside this repository:

```
BASE=https://github.com/cardanowall/label-309-cli/releases/download/v0.12.0
curl -fsSLO "$BASE/cardanowall-v0.12.0-x86_64-unknown-linux-musl.tar.gz"
curl -fsSLO "$BASE/SHA256SUMS"
grep x86_64-unknown-linux-musl SHA256SUMS | sha256sum -c -
gh attestation verify cardanowall-v0.12.0-x86_64-unknown-linux-musl.tar.gz --repo cardanowall/label-309-cli
tar -xzf cardanowall-v0.12.0-x86_64-unknown-linux-musl.tar.gz
```

The attestation check confirms that the archive was built by the release workflow of `cardanowall/label-309-cli` at tag `v0.12.0`. Put the extracted `cardanowall` on `PATH`, or point `RESEARCH_FREEZE_CARDANOWALL` at it. Without it, `npm test` skips the CLI tests with a notice and `build` refuses to run.

The CLI reads settings from its environment (for example `CARDANOWALL_CONFIRMATION_DEPTH_THRESHOLD`, `CARDANOWALL_CARDANO_GATEWAY`, `CARDANOWALL_DENY_HOSTS_REPLACE`, `CARDANOWALL_SEED`) and from `~/.cardanowall/config.toml`, and each can change what `verify` checks. The tool therefore runs it with a minimal environment: `PATH`, `HOME` set to an empty temporary directory, and `CARDANOWALL_CONFIG_PATH` pointing at an empty file in it. Every `verify` is also given `--profile signed --threshold 15` explicitly.

## Identities and where secrets live

The home is `${XDG_DATA_HOME:-$HOME/.local/share}/unfrackit-research-freeze/`, or `RESEARCH_FREEZE_HOME`. Directories are created 0700 and files 0600; a secret is written with exclusive create and never overwritten. The tool refuses to run if the home resolves inside any git working tree, or if any directory or file in it has wider permissions. The rehearsal seed handed to the reference CLI goes to a 0600 file in `tmp/` that is removed afterward; at startup the tool also removes any such file whose process is gone, which a killed process leaves behind, and likewise the temporary copies `restore` writes into an identity directory before renaming them.

```
identities/<name>/signing-mnemonic    identities/<name>/payment-mnemonic    identities/<name>/public.json
journal/<network>.json (and .lock)    runs/<network>/<tx hash>/             rehearsals/<id>/
secrets/                              tmp/
```

There are two identities. `freeze` is the real one: it signs mainnet records only. `rehearsal` is a throwaway identity that signs preprod records only, including every placeholder record of a rehearsal. The split matters because a signed record body is portable (CIP-190, "Record-level signatures (COSE_Sign1)": a verified signature binds the record body only), so a body signed by the real key on preprod could be republished on mainnet by anyone, and signing the final files on preprod would publish the exact freeze record before mainnet. `public.json` names the network each identity may sign for, and `build` refuses any other.

The `freeze` identity is created by its owner, in a real terminal, with `init --identity freeze` and then `backup --identity freeze`.

### Restoring an identity

`restore --identity <name>` recreates an identity's two mnemonic files from the paper backup. It runs only on an interactive terminal, reads each mnemonic as one typed line without echoing it (the numbers of a numbered list are ignored), and applies the same checks as `init`: 24 words, the BIP-39 checksum, distinct entropies and distinct keys. It refuses if either mnemonic file exists, and it writes both files (and `public.json` when needed) under temporary names first, so a failed write leaves no mnemonic file behind. If the identity's `public.json` survived, the derived keys and addresses must equal it, and it is left as it was. Without it, `--signing-key <hex>` is required, and the derived signing key must equal that key, known from elsewhere (for example the one a published record carries); `public.json` is then written anew, with the networks the name implies. The requirement exists because the name alone decides the network an identity signs for: the real mnemonics typed under the name `rehearsal` would otherwise give the real key a preprod identity, whose records could be copied to mainnet. For the same reason, a key this home already records under another identity name, or for a network the name does not sign for (in another identity's `public.json`, a journal entry or a run report), is refused, and a `--signing-key` is checked against those records before any word is asked for.

The mnemonics alone recreate the keys, not the history: back up the home's `runs/` and `journal/` with the paper backup, because they hold every signed transaction and the journal.

### What a restored home knows

A home restored from the mnemonics alone, or with a `runs/` and `journal/` backup older than the last record, knows less than the home it replaces:

- It can recompute the keys, and it can read from chain every transaction this identity paid for, because each one spent UTxOs of the identity's own payment address and so appears in that address's history. From each it can read the record, its signer, and the payment witness that shows this identity paid for it.
- It cannot know a record's stage, which is not on chain; the reports of `wait` and `verify`; builds that were never submitted; or a transaction submitted from the lost home that is still waiting in a mempool.

For these, the tool reads the chain: a `supersedes` or `related` target without a run directory is read from chain (see the manifest), `build --stage final --hypotheses <hash>` names the hypotheses record the final document cites, with `--hypotheses-document <file>` to show its stage when the home has no record of it, and before a mainnet final freeze is submitted, the address history is read for records this identity paid for that the journal does not know (see The two-stage freeze).

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
| `restore --identity <name> [--signing-key <hex>]` | Recreates the identity's mnemonic files from the two typed mnemonics (see Restoring an identity). Refuses unless stdin and stdout are an interactive terminal, never overwrites a mnemonic file, and needs `--signing-key` when the identity has no `public.json`. |
| `hash <manifest> [--identity <name>] [--stage <stage>]` | Hashes every file of the manifest and runs the byte-form and document checks below; with `--stage final`, also lists the record URIs the document cites. |
| `build <manifest> --network <n> [--stage hypotheses\|final] [--hypotheses <hash> [--hypotheses-document <file>]] [--identity <name>] [--core-only]` | Builds and signs the record, carries it, builds and signs the transaction, runs every offline check, and writes a run directory only if all pass. Submits nothing. `--core-only` omits `research-items`. A `freeze` names its stage (see The two-stage freeze); no other kind takes one. `--hypotheses` names the hypotheses record a final freeze's document cites, for a home without its run directory, and `--hypotheses-document` gives that record's document when the home has neither its run directory nor its journal entry. The default identity is `freeze` on mainnet and `rehearsal` on preprod. |
| `check <run>` | Runs the offline checks again on a run directory. |
| `submit <run>` | Submits the run's exact signed bytes through the journal. On mainnet it requires an interactive terminal and the operator typing the first eight hex digits of the transaction hash. |
| `wait <run>` | Polls until 15 confirmations, then records the block height, block hash, slot, epoch, epoch slot and block time as Koios reports them. For a final-stage freeze it also records the draw plan: the epoch E, the block's slot, the cutoff slot and N. |
| `verify <run or tx hash> --network <n> [--identity <name>] [--json]` | Verifies on chain three ways and cross-checks the chain facts with Blockfrost (see Checks), and prints the block facts with links to two explorers. Accepts only the home's own transactions, and fails unless the record is signed by the key that built it (from the run directory, else the journal, else the identity). For a final-stage freeze it recomputes the draw plan from both providers and compares it with the one `wait` recorded. |
| `drawkey <run>` | For the final-stage freeze, once epoch N has started: reads N's nonce from Koios and from Blockfrost, fails on any disagreement or absence, and writes both readings with their times into the run directory's `drawkey.json` (see The two-stage freeze and the draw key). |
| `abandon --network <n>` | Drops a journaled transaction, only after its TTL has passed, while neither Koios (`/tx_status`, `/tx_info`, the address history) nor Blockfrost (when a project ID is present; always on mainnet) knows its hash, and while its inputs are unspent; or, for an entry recorded as failed, once another transaction in the address history is found to have spent them. |
| `rehearse <manifest> --network preprod [--doi <doi>]` | Runs the sequence of the mainnet records on preprod with the `rehearsal` identity: a hypotheses-stage freeze, a final-stage freeze citing it, a re-typing successor and a scripts record. `--resume <id>` continues an interrupted rehearsal. Refuses mainnet. |
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
- `freeze` needs `doi`, the reserved DOI as a lowercase bare DOI name, and the document must carry it among its identifiers. So does an `amend` whose document is typed `StudyRegistration` (a new version of the registration, with its own DOI).
- `retype` and `amend` need `supersedes`, the 64-digit lowercase hash of the transaction they supersede. A `retype` carries every item of it with identical digests in the same order.
- `scripts` and `results` need `related`, a list of `{ "uri", "relation", "relation_info"? }` whose `uri` is a record URI.
- A pointer goes on chain for good, so before anything is signed, the record that `supersedes` names and every record a `related` URI names must be a confirmed record of the same identity on the same network. With a run directory in this home, its report must record a `wait` to 15 confirmations and a `verify` in which this tool, the SDK and the reference CLI all said `valid`, and the journal must record it as confirmed. In every case Koios `/tx_status` must report at least 15 confirmations, and so must Blockfrost, with byte-identical transaction CBOR, when a project ID is present (on mainnet it is required); the transaction must carry a witness from this identity's payment key that verifies over its body hash, which tells the original from a replay of the same signed body in someone else's transaction (CIP-190, "Signature replay"); and the record read from the raw transaction (`/tx_cbor`, after the hash and `auxiliary_data_hash` binding) must validate, carry exactly one valid signature, by this identity's key, and equal the run directory's body when there is one. Without a run directory (a lost home recreated with `restore`), the record is read from chain alone, so re-typing does not depend on a local directory (CIP-190, "Supersedence": a pointer that does not rely on an off-chain database).
- `type`, `id_type` and `relation` take the DataCite Metadata Schema 4.7 values (`resourceTypeGeneral`, `relatedIdentifierType`, `relationType`), spelled exactly; anything else is refused. A `relation` of `Other` needs `relation_info` saying what the relation is.
- No string that goes on chain (an identifier, a `relation_info`, the DOI) may contain `unfrack.it` in any letter case.

## The record and the byte form it hashes

Every digest is SHA-256 over the file exactly as it sits on disk, byte for byte, with no normalization (CIP-190, "Exact-bytes scope of a PoE claim"). A text item must already be valid UTF-8 with LF line endings and no byte-order mark; a file that is not is refused rather than normalized, unless the manifest marks it `binary`.

For the `freeze` and `amend` kinds, `hash` and `build` also check the document against the manifest (an amendment is a new document version with its own hash table; a `retype` carries the superseded record's digests unchanged). Every line of the form `<64 lowercase hex><two spaces><file name>` must name a non-document item and carry its computed digest; every non-document item must appear exactly once; the document must not list itself; and the document must carry the identity's signing public key and the manifest's DOI, each as a whole token: the DOI not run into a longer DOI (`10.5281/zenodo.1700000` does not match inside `10.5281/zenodo.17000001`), and the key not run into other hex digits. Any mismatch fails.

The label-309 value is a CIP-190 record, a canonical CBOR map (CIP-190, "Canonical CBOR (deterministic encoding)": RFC 8949 section 4.2.1, shortest integers, definite lengths, keys sorted bytewise by their encoding, no duplicates, no tags, no floats):

- `v`: 1.
- `items`: one `{ "hashes": { "sha2-256": <32 bytes> } }` per manifest item, in manifest order (CIP-190, "Item entries", "Hash algorithms").
- `sigs`: one `{ "cose_sign1": <bytes> }` (CIP-190, "Sig-entry shape").
- `supersedes`: the 32-byte transaction hash, for `retype` and `amend` only ("Supersedence").
- `research-items`: a map from each item's 32-byte digest (the same bytes as in `items[i].hashes`) to `{ "type": <text>, "ids"?: [{ "id", "id_type", "relation", "relation_info"? }] }`. DOIs are lowercase bare DOI names. Omitted with `--core-only`.
- `research-related`: for later kinds, a list of `{ "uri", "relation", "relation_info"? }`, where `uri` matches `^web\+cardano://transaction/[0-9a-f]{64}/metadata/309$` exactly (a CIP-0107 transaction-metadata URI under the CIP-0013 scheme).

The `research-` keys are top-level extension keys in CIP-190's companion-CIP namespace (`^[a-z]+-.+`; "Forward compatibility and critical extensions"). They are covered by the signature, and the tool never writes `crit`, so a default CIP-190 verifier validates the record and surfaces the keys informationally. Canonical ordering puts the top-level keys in the order `v`, `sigs`, `items`, `supersedes`, `research-items`, `research-related`.

The signature follows CIP-190, "Record-level signatures (COSE_Sign1)". `to_sign` is the 25 ASCII bytes `cardano-poe-record-sig-v1` followed by the canonical CBOR of the record without `sigs`, `Sig_structure` is `["Signature1", protected, h'', to_sign]`, and the payload is `null`, detached ("Signed payload and Sig_structure"). The protected header is `{1: -8, 4: <32-byte public key>}`, which encodes as `a2 01 27 04 58 20` and the key: algorithm -8 ("Signing algorithm") and the raw public key as `kid` (path 1, "Signer-key identification"). The unprotected header is the empty map and the COSE_Sign1 is untagged, as the conformance vector `cose/sign1-build.json` pins. CIP-8 makes `version` and `hashed` mandatory in the unprotected header ("Version", "Payload encoding"), but CIP-190 treats an absent `hashed` as false ("Signing algorithm", its paragraph on CIP-8 `hashed` mode) and makes its conformance vectors authoritative in any byte-level dispute ("Conventions and terminology"); the tool follows CIP-190 and never uses hashed mode.

The record is carried as a definite-length array of definite-length byte strings, the minimal split (every chunk 64 bytes except the last), even when the body is 64 bytes or fewer (CIP-190, "Metadata label 309 and the chunk-array transport"). The label-674 value is `{ "msg": [ "<64 lowercase hex>" ] }` (CIP-20, "Specification"). The transaction carries no other label. The string `unfrack.it`, in any letter case, appears in no byte of the transaction, no byte of the reassembled record (a string can straddle two chunks, whose headers would split it in the transaction bytes), and no text string of the record or the metadata. The auxiliary data is the untagged metadata map, one of the three forms CIP-190 accepts ("Auxiliary-data envelope forms").

Every step is done twice: once by the SDK and once by this tool's own canonical encoder, and the bytes must be identical, including the bytes-keyed `research-items` map.

The transaction spends every pure-ADA UTxO at the payment address and returns one output to it. The fee is `min_fee_a * size + min_fee_b` over the serialized signed transaction, iterated to a fixed point and checked against CSL's `min_fee`; the change must hold at least CSL's `min_ada_for_output`, or the build stops with the shortfall. The TTL is the tip slot plus 7,200 slots. The body carries the network ID (1 or 0) and `auxiliary_data_hash`.

## The two-stage freeze and the draw key

The pre-registration is frozen twice, with the same `freeze` kind and the same signing key:

1. The hypotheses record, `build --stage hypotheses --core-only`, hashes the pre-registration text with its hypotheses, falsification criteria, thresholds and sample rules final, before the first live-fire query. It must be core-only.
2. The final freeze, `build --stage final`, hashes everything the pre-registration lists, including the log of the checks. Its document cites the hypotheses record by its record URI, `web+cardano://transaction/<hash>/metadata/309`, in its own text, so the hash of the final document covers the citation and a reader can diff the two texts. There is no on-chain link between the two records and no record kind beyond `freeze`.

The stage is not on chain. It goes into the run directory's report, the journal entry, the output of `build`, `wait`, `verify` and `rehearse`, and the mainnet prompt, so it is never ambiguous which run keys the draw. Before a final freeze is signed, `build` requires that exactly one record URI in its document names a hypotheses-stage run of this home on the same network, and that this record passes the same checks as a `supersedes` target: a recorded `wait` to 15 confirmations and a `verify` with three `valid` verdicts (cross-checked with Blockfrost on mainnet), a confirmed journal entry, at least 15 confirmations, a payment witness from this identity, and the record read from the raw transaction signed by the same key and equal to the run's body. It must also have the shape of a core-only freeze (`v`, `sigs` and `items` only). A home without that run, after a loss, names the record with `--hypotheses <hash>`: the document must cite it, and it is read from chain with the same checks. The shape alone cannot tell a hypotheses record from a core-only final freeze, so the named record must also be shown to be the hypotheses stage: by this home's run directory or journal entry for it when either exists (and then its stage must be `hypotheses`), and otherwise by its own document, passed with `--hypotheses-document <file>`, whose SHA-256 must be the record's CIP-20 line and whose text must cite no transaction in this identity's payment address history; a document passed when the run directory or journal entry already settles the stage is reported as unused. A final freeze's document always cites the hypotheses record; the hypotheses document comes first and cites none. Other record URIs in the final document are listed in the report and not checked.

On mainnet only one final freeze may exist, because the draw is keyed to it:

- `build` refuses a final freeze while another final freeze is journaled, unless that one was abandoned.
- `submit` refuses it too, early, and again inside the locked journal write immediately before the first submission, so another final freeze journaled while the operator was at the prompt still stops this one.
- Before the prompt, `submit` reads the payment address's history from Koios and from Blockfrost (a project ID is required) and looks at every transaction in either history that the journal does not know, or knows only as abandoned (an entry abandoned on wrong provider answers may have landed), other than this run and the hypotheses record. Each is first read only far enough to decide who paid for it: its body must hash to its transaction hash, and this identity paid for it when its witness set holds a witness from this identity's payment key that verifies over the body hash. That reading uses an iterative CBOR walker that accepts any well-formed encoding (indefinite lengths, tags, non-canonical integers) at any nesting depth that fits in a transaction. A transaction this identity did not pay for is skipped without reading anything else of it, so what someone else sends to the address (a payment with malformed or deeply nested label-309 metadata, deeply nested Plutus data, indefinite-length encodings, a replay of one of this identity's signed bodies) does not stop the submission. It stops on a transaction this identity paid for that carries a label-309 record signed by its key (a final freeze sent from a lost home would look like this) or a label-309 value that cannot be parsed or does not validate, and on a provider fault: the two providers returning different bytes, neither returning any, only one returning any, so one provider's bytes never decide alone (the other may not have indexed a fresh transaction yet; submitting again later clears it), or returning bytes that are not the requested transaction.

The draw key is the epoch nonce of epoch N. With E the epoch of the block holding the final freeze transaction:

- N = E + 1 if that block's slot is earlier than the first slot of E plus the epoch length minus the randomness stabilization window W;
- N = E + 2 otherwise.

The rule follows the Praos nonce evolution in `IntersectMBO/ouroboros-consensus` (read at main, commit 46f4dffa639b7732b1e058524078313e7b99080c): a block's VRF output enters the candidate nonce only while `slot + W < firstSlotNextEpoch` (`reupdateChainDepStatePolyPraos` in `ouroboros-consensus-protocol/src/ouroboros-consensus-protocol/Ouroboros/Consensus/Protocol/PolyPraos.hs`), and at the epoch boundary the new epoch nonce combines that candidate nonce with the last-block nonce recorded at the previous boundary (`tickChainDepStatePolyPraos`, same file). Once a block is past the cutoff of E, the nonce of E + 1 is therefore already determined. W comes from the network's genesis parameters, never from a constant: for every Praos era except Babbage, `ouroboros-consensus-cardano/src/ouroboros-consensus-cardano/Ouroboros/Consensus/Cardano/Node.hs` (lines 592 to 597) sets it to `computeRandomnessStabilisationWindow k f`, which `IntersectMBO/cardano-ledger` defines in `eras/shelley/impl/src/Cardano/Ledger/Shelley/StabilityWindow.hs` (master, commit a575cec5c8d549f8249a215f2110765ea3de4804) as ceiling(4k/f). Babbage used 3k/f (Shelley ledger erratum 17.3). The tool reads k (`securityparam`, `security_param`), f (`activeslotcoeff`, `active_slots_coefficient`, as an exact ratio) and the epoch length from `/genesis` on each provider, computes W only for Conway (protocol versions 9 to 11, read from the epoch parameters of E) and refuses any other protocol version. On mainnet and preprod, k = 2160 and f = 0.05, so W = 172,800 slots and the cutoff falls 259,200 slots (three days) into a 432,000-slot epoch.

- `wait` records the plan from Koios: E, the block's slot and epoch slot, the first slot of E, k, f, W, the cutoff slot, N and the first slot of N. These come from one provider. A later `wait` never replaces them: it refuses facts or a plan that differ from the recorded ones and leaves equal ones as they were. The confirmation is written before the plan is computed, so a plan that cannot be computed does not lose it.
- `verify` recomputes the plan from Koios and from Blockfrost (Blockfrost is required on mainnet), fails if the two differ, and fails if either differs from the plan `wait` recorded.
- `drawkey <run>` runs once epoch N has started. It reads the genesis parameters, the freeze block, the epoch parameters of E and the tip from both providers, and fails unless they agree, the plan equals the recorded one, the freeze block is at least k + 1 blocks deep on both (a rollback reaches at most k blocks back), and both tips are in epoch N or later. It then reads N's nonce from Koios `/epoch_params?_epoch_no=<N>` and Blockfrost `/epochs/<N>/parameters`, and fails if either is absent, is not 32 bytes of hex, or differs from the other. It writes `drawkey.json` into the run directory with the nonce, the plan, the block, both depths, and both readings with the request, the time and the tip of each; the file is never overwritten, and a later run reads both providers again and fails if they no longer give the recorded nonce.

## Submission and the journal

`submit` keeps a journal per network in the home:

1. The journal entry (network, transaction hash, signed CBOR, TTL, inputs, record kind, stage and signing key) is written before the first submission, and no second transaction is written for a network while an unresolved one is journaled. Every read-modify-write of a journal holds an exclusive lock file (`journal/<network>.lock`); a second invocation that finds it refuses rather than racing. Each new journal is flushed to disk before it is renamed into place, and the directory is flushed after the rename.
2. Every resubmission sends the identical bytes; nothing is rebuilt automatically.
3. The transaction ID Koios returns must equal the computed hash.
4. If the node answers "All inputs are spent", "already been included" or `BadInputsUTxO`, the tool looks the hash up (`/tx_status`, then `/tx_info`) for up to ten minutes. Found, the transaction counts as submitted. If its inputs then read as spent, the tool still decides nothing from one negative answer (CIP-190, "Structural validation, verifier roles, and error codes", Part B, "Pipeline", step 1): it looks the hash up for a further ten minutes and then in the payment address's own transaction history (`/address_txs`), where any transaction that spent those inputs must appear, because only this payment key can spend them. Still not found, the entry is recorded as `failed`. A failed entry stays unresolved: `build` refuses until `wait` sees the transaction land or `abandon` releases it.
5. Any other rejection stops with the node's message verbatim.
6. An entry can be abandoned only after its TTL has passed, while Koios knows nothing of its hash (`/tx_status`, `/tx_info` and the address history) and neither does Blockfrost when a project ID is present (on mainnet it is required), and while its inputs are unspent. A failed entry's inputs read as spent while its hash is unknown, which most often means an inconsistent provider, so one negative answer more does not release it: another transaction in the address history must be found to have spent those inputs (Koios `/tx_info` with its inputs), and the journal records which one.

Koios `POST /submittx` takes the raw CBOR with `content-type: application/cbor`; success is HTTP 202 with the transaction ID. Requests are spaced, and 429 and 5xx answers are retried after the server's `Retry-After` (seconds or an HTTP date, capped at ten minutes for a resubmission), or with backoff when it sends none. `wait` polls until 15 confirmations, CIP-190's recommended threshold and the reference CLI's default; a `/tx_info` answer without the block means "not yet". It records the confirmation count and the block facts Koios reports; those come from one provider, and `verify` reads them again from two (see Checks).

### What the tool queries

Before the freeze block no study query may run, so the tool sends Koios only `/genesis`, `/tip`, `/epoch_params`, `/address_utxos` and `/address_txs` for the identity's own payment address, `/submittx`, and `/tx_status`, `/tx_info` and `/tx_cbor` for its own transactions and for the transactions the address history lists. The Koios client refuses any other address or transaction hash. It never queries another address, account, asset or transaction, with one exception: a `supersedes` or `related` target that has no run directory in this home is looked up by the hash the manifest names, and the build stops unless the record found there is signed by this identity. The network guard runs before anything is built or signed: `/genesis` must report network magic 764824073 and `Mainnet` for `--network mainnet`, or 1 and `Testnet` for `preprod`. The SDK verifier and the reference CLI, run by `verify`, read only `/tx_cbor`, `/tx_info` and `/tip` for the same transaction; their audit trails, which `verify --json` prints, show each call.

Blockfrost receives only `GET /genesis`, `/addresses/<address>/transactions` for the identity's own payment address, `/txs/<hash>` and `/txs/<hash>/cbor` for the tool's own transactions and those of that address history, `/blocks/<hash>` for the blocks holding them, `/blocks/latest`, and `/epochs/<n>/parameters`. Its client refuses any other address, transaction or block, refuses redirects (a followed redirect would carry the `project_id` header to another host), and the requests `verify` made are listed in its report.

### Blockfrost

Blockfrost is the second, independent provider of chain facts. It is a cross-check, never a fallback: `verify` and `drawkey` read the same facts from Koios and from Blockfrost and fail on any difference, and neither provider stands in for the other when it fails. The project ID for each network is read from `secrets/blockfrost-<network>.token` in the home (mode 0600, refused if wider) and sent only in the `project_id` header to `https://cardano-mainnet.blockfrost.io/api/v0` or `https://cardano-preprod.blockfrost.io/api/v0` (Blockfrost OpenAPI 0.1.93). It is never printed, logged or written to a report: every error text is redacted before use. A `/genesis` guard checks the network magic before anything else. 404 means absent; 429 and 5xx are retried after `Retry-After` or with backoff; 402, 403 and 418 stop with what they mean. On mainnet, `verify` refuses to run without the project ID, because chain facts there are load-bearing (CIP-190, "Chain facts: block time and confirmation depth": a deployment for which they are load-bearing MUST cross-check them across independent explorers). On preprod, `verify` runs the cross-check when a project ID is present and reports it as not run otherwise. `drawkey` needs it on every network; on mainnet so do `abandon`, the submission of a final freeze, and any `build` that points at another record. The SDK and the reference CLI accept a Blockfrost ID only as a fallback after Koios fails, and only against the mainnet host, so neither is given one.

## Checks

### Offline, inside `build` and `check`

- The transaction, from its serialized bytes through CSL's `FixedTransaction` and the SDK's byte-faithful slicer: BLAKE2b-256 of the raw body equals the transaction hash; BLAKE2b-256 of the raw auxiliary data equals the body's `auxiliary_data_hash`; the auxiliary data is exactly the expected untagged map; the metadata labels are exactly 309 and 674; every chunk is 1 to 64 bytes, and they reassemble to the record body byte for byte; the 674 message is exactly the expected digest; CSL refuses a 65-byte metadata byte string; no `unfrack.it` in the transaction bytes, the reassembled record or any text string; the size is within `max_tx_size`; the body holds only inputs, outputs, fee, TTL, `auxiliary_data_hash` and network ID; the fee is `min_fee_a * size + min_fee_b` and equals CSL `min_fee`; one output to the expected address with the network tag and at least its minimum ADA; one vkey witness, from the payment key, verifying against the body hash under CSL and OpenSSL.
- The SDK's `validatePoeRecord` (default options) reports the record valid, and its `coseSign1Label309Verify` verifies the signature against the identity's key.
- `cardanowall verify --record --profile signed --threshold 15` exits 0 with verdict `valid`, reports the identity's key as the signer and the manifest digests as the items, and echoes the `research-` keys in its report's record with no issue raised.
- `cardanowall sign prepare --signer-pubkey <key>` over the body without `sigs` gives the same `Sig_structure` byte for byte. This involves no secret.
- For the `rehearsal` identity only, `cardanowall sign record --seed-file` (the seed as hex in a 0600 file in the home's `tmp/`, removed afterward) produces the same signed body, and `cardanowall identity --seed-stdin` reports the same public key. The real identity's seed is never passed to another program.

The run directory holds the record body, the body without `sigs`, the `Sig_structure`, the COSE_Sign1, the label-309 value, the metadata in `cardano-api` detailed JSON (for reading only), the signed transaction, its hash, the CIP-0107 URI, and a report with the versions of Node, CSL, the SDK and the CLI, the pinned specification commits, the fee, the inputs, the TTL and every check.

### On chain, in `verify`

- This tool fetches the raw transaction from Koios `/tx_cbor`, never the metadata JSON view (CIP-190, "Structural validation, verifier roles, and error codes", Part B, "Pipeline", step 1), checks the transaction-hash and `auxiliary_data_hash` binding (step 2), reassembles the record and compares it with the run's bytes, validates it, verifies the signature and requires its signer to be the key that built the transaction, and reads the block height, hash, slot and time from `/tx_info`, with the confirmation depth computed as tip height minus block height plus one ("Chain facts: block time and confirmation depth").
- The SDK's `verifyTx`, against the network's Koios endpoint, in the default `signed` profile.
- `cardanowall verify <tx> --network <n> --cardano-gateway <Koios URL> --json --profile signed --threshold 15`. The CLI defaults to Koios mainnet whatever `--network` says, so the tool always passes the endpoint.
- The cross-check (see Blockfrost): Koios and Blockfrost must return byte-identical transaction CBOR and the same block hash, height, slot, epoch, epoch slot and time. The block facts must also equal those `wait` recorded, and for a final-stage freeze the draw plan from each provider must equal the other and the recorded one. Both providers' answers and depths go into the report.

`verify` is `valid` only when all three verifiers say `valid` and no cross-check or comparison found a difference; its verdict is written into the run directory's report. It also prints links to cardanoscan.io and cexplorer.io (with the `preprod.` host on preprod).

### Unit tests (`npm test`)

`npm test` runs `node --test test/*.test.mjs` offline, in temporary homes that are removed when the run ends. It covers:

- the label-309 v0.10.0 conformance vectors below, copied byte for byte into `test/vectors/label-309-v0.10.0/` with label-309's Apache-2.0 `LICENSE` and a `PROVENANCE.json` recording the source commit (a51bad8d31669ccbf533bac6ec8c39dd38ff0388) and each file's SHA-256, which the first test checks;
- the signing key of the three public test mnemonics (`abandon` x23 `art`, `zoo` x23 `vote`, and the `deadbeef` mnemonic), through the SDK and through Node and OpenSSL; the CIP-3 Icarus master key; the CIP-11 key at `m/1852'/1815'/0'/2/0`; the CIP-19 type-6 addresses; a throwaway 24-word payment mnemonic whose key at `m/1852'/1815'/0'/0/0` matches the one `cardano-signer` 1.32.0 derives (24 words is where CIP-3 `Icarus.md` notes that derivations diverge); refusal of equal entropies and of mnemonics other than 24 words; the key-separation check;
- `signRecord` itself over the four `cose/sign1-build.json` record vectors (the `Sig_structure`, the signature, the COSE_Sign1 and the `sigs` entry), and each `research-items` typing sitting under its own item's digest;
- all five record kinds with placeholder digests: canonical round trip through both encoders, the SDK validator, and the top-level key order; negative controls: a `research-` key in `crit` fails with `EXTENSION_UNSUPPORTED_CRITICAL`, a misspelled base key with `SCHEMA_UNKNOWN_FIELD`, and an uppercase hex digit in a record URI is refused by the builder;
- transaction building and every post-build assertion, with fake UTxOs, including a record string split across two chunks; the sweep assertions;
- the order inside `submit` (network guard, mainnet prompt and its facts, journal, TTL, submission) and `sweep` on mainnet, and inside `build` (the identity's network, then the network guard, before any mnemonic is read);
- the reference CLI's isolation: a binary with the right version string but another SHA-256 is refused, and a threshold of 1 in the operator's environment does not reach it;
- the two-stage freeze: the stage rules; the final document's citation (none, uppercase, one); the cited hypotheses record (not a hypotheses run, unconfirmed, fewer than 15 confirmations, another key, two cited); `build` refusing an unconfirmed one after the network guard; the draw plan `wait` records on either side of the cutoff; `verify` agreeing with both providers, and failing on a block placed elsewhere or a plan or block fact that differs from the recorded one; `verify` on mainnet without a project ID; `verify` failing when the providers disagree on the genesis parameters; one final freeze on mainnet, refused at `build`, early at `submit`, and inside the locked journal write when another final was journaled while the prompt was open, an abandoned final not counting; the chain scan before a mainnet final (an unknown record this identity paid for, listed by either provider, refuses, and so does an abandoned final that landed; so does one that this identity paid for in any witness encoding: an indefinite witness set and list, chunked key and signature strings, its witness after another one; so does an identity-paid label-309 value that fails parsing or validation; differing bytes from the two providers, bytes from only one of them, bytes that are not well-formed or not the requested transaction, and a transaction neither provider returns refuse; an identity-paid transaction without label 309 does not; the run's own transaction, the hypotheses record, funding transactions, a replay paid by someone else, a stranger's payment with the label-309 value `{"v": 1}`, a payment with an indefinite-length inputs array, payments whose metadata or whose Plutus data under witness key 4 nest about 16 KB deep, and this identity's record with a forged witness signature do not); no mainnet final, and no mainnet `abandon`, without a project ID; `--hypotheses` (cited, a 64-digit lowercase hash, on chain, paid and signed by this identity, core-only, its stage shown by a run directory, a journal entry or its document's digest and citations, refused on a non-final build); `wait` keeping its first record, refusing other block facts or another plan, and keeping the confirmation when the plan cannot be computed;
- the draw plan: W = ceiling(4k/f) from the genesis parameters (172,800 slots on mainnet, a ceiling case, refusal outside Conway), the cutoff at 259,200 slots into a mainnet epoch, N = E + 1 just before it and E + 2 at it;
- `drawkey`: both nonces agreeing (both readings written with their times, never rewritten); a nonce disagreement, a nonce absent on either provider, epoch N not started, a block exactly k deep on either provider, a genesis disagreement, Blockfrost contradicting itself between `/txs` and `/blocks`, parameters for another epoch, a recomputed plan that differs from the recorded one, and a block disagreement, each failing with nothing written; depth k + 1 accepted; refusal for a run that is not final-stage and without a project ID;
- the Blockfrost client and the cross-check against a fake server: the host by network and the ID only in the header; agreement; a different block hash, slot or CBOR; a 404; 402, 403 and 418 with the ID redacted; 429 retried after `Retry-After` and exhausted; the network guard; the own-address and own-transaction allowlists; redirects refused; the token file and its mode;
- the targets of `supersedes` and `related`: a confirmed, verified, journaled record passes; a run without a `wait`, without three `valid` verdicts or without a confirmed journal entry, fewer than 15 confirmations, items out of order for a `retype`, an unsubmitted build or an unknown hash, a record signed by another key, a replay of this identity's signed body in a transaction someone else paid for, and on mainnet a missing or shallow Blockfrost confirmation, differing CBOR, or a verify that did not cross-check are refused; with the run directory gone the record is read from chain; `build` refuses an unconfirmed target after the network guard and before reading any key; this tool's on-chain verdicts (`valid`, `pending`, `failed` for another body or another signer, `unverifiable`);
- `restore`: refused without a terminal, never over an existing mnemonic file, checked against `public.json` and `--signing-key`, `--signing-key` required without `public.json`, another identity's keys refused, a `--signing-key` already recorded for another network or name refused before any word is asked for, swapped, short and mistyped mnemonics refused, raw mode set before each prompt and the words not echoed, and a failed write leaving no mnemonic file behind;
- the journal state machine against a fake Koios: a lost response followed by "All inputs are spent" with the hash found (submitted); a transaction that lands just after the last poll of the first window, and a lagging `/tx_status` instance (both found, never failed); the hash never found while the inputs read as spent (failed, and unresolved); 429 then success; `Retry-After`; a returned ID that differs (failure); the journal lock; the abandonment rules for unsubmitted and failed entries (a failed one released only when another transaction is found to have spent its inputs, and never while Blockfrost knows its hash); the single-final rule inside the locked journal write; a missing `/tx_info` row while waiting;
- the CBOR walker that decides the payer: exact spans and joined byte-string chunks for 12,000 random well-formed items (non-shortest heads, indefinite strings, arrays and maps, tags, floats, simple values) embedded between random bytes; nesting far deeper than a transaction holds; only `Error` throws on bytes that are not well-formed; label 309 found in all three auxiliary-data forms;
- the mainnet guard and `backup` refusing without a terminal, the refusal of a home inside a checkout or with loose permissions, the removal of temporary secrets and restore copies left by a killed process, the `unfrack.it` scanner and the manifest's refusal of it, the token-bounded DOI and key checks, `relation_info` for `Other`, the amendment's document checks, and the network guard;
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

`rehearse <manifest> --network preprod` reads the mainnet freeze manifest's item names, types and document flag, and generates placeholder text files with distinct content per run. It then builds, checks, submits, waits for 15 confirmations and verifies, in order:

1. a hypotheses-stage, core-only freeze of a placeholder document alone, which carries the rehearsal public key and a placeholder DOI (`--doi` supplies a sandbox DOI instead);
2. a final-stage, typed freeze of one placeholder per manifest item, whose placeholder document carries the hash table of the others, the key, the DOI and the hypotheses record's URI, so the document checks and the citation check run as they will on mainnet; `wait` records its draw plan;
3. a re-typing successor that supersedes the final freeze and adds a second placeholder identifier;
4. a scripts record whose `research-related` names the final freeze with `IsSupplementTo`.

It keeps its state in `rehearsals/<id>/state.json` and resumes with `--resume <id>`. It refuses mainnet. `drawkey` on the final freeze runs once epoch N has started, outside the rehearsal.

On mainnet, `submit` and `sweep` require an interactive terminal on stdin and stdout and the operator typing the first eight hex digits of the transaction hash. Above the prompt, `submit` shows the network, the record kind, the stage, whether `research-items` is present, the item count, the CIP-20 line (the document's digest), the signing key, the fee, the inputs, the change and the TTL; `sweep` shows the source and target addresses, the amount, the fee, the inputs and the TTL. Before a sweep is written or shown, its bytes pass the same kind of assertions as a record transaction: no auxiliary data, the body fields, the network ID, the TTL, the inputs, one ADA-only output to the target, the exact fee, and one payment witness verifying under CSL and OpenSSL. `build` never submits.

## Specifications

The code cites these by number and section where it relies on them.

- CIP-190, Proof of Existence Transaction Metadata, at `cardano-foundation/CIPs` merge commit 58b4dd1417e139595dfabc92467d49bb3ffc0a07, with its registries and conformance vectors at `cardanowall/label-309` tag `v0.10.0` (commit a51bad8d31669ccbf533bac6ec8c39dd38ff0388). The label-309 repository is pre-1.0; its changelog states that the wire format, registries and vectors may change in backward-incompatible ways until 1.0, so both pins are fixed.
- CIP-20 (label 674 messages), CIP-10 (labels 309 and 674 are registered).
- CIP-0107 (transaction and metadata-label URIs) and CIP-0013 (the `web+cardano:` scheme).
- CIP-8 (COSE_Sign1 and `Sig_structure`, as CIP-190 uses them).
- CIP-3 with `Icarus.md` (master key from entropy), CIP-1852 (derivation path), CIP-19 (addresses, type 6, the test vectors), CIP-5 (the `addr` and `addr_test` prefixes), CIP-11 (the staking-key test vector).
- RFC 8949 section 4.2.1 (deterministic CBOR), RFC 9052 (COSE), RFC 8032 (Ed25519), RFC 5869 (HKDF), RFC 8410 (Ed25519 key encodings for OpenSSL).
- DataCite Metadata Schema 4.7 controlled lists, `schema.datacite.org/meta/kernel-4.7/include/`.
- The Praos nonce evolution and the randomness stabilization window: `IntersectMBO/ouroboros-consensus` at commit 46f4dffa639b7732b1e058524078313e7b99080c (`PolyPraos.hs`, `Node.hs` lines 592 to 597) and `IntersectMBO/cardano-ledger` at commit a575cec5c8d549f8249a215f2110765ea3de4804 (`StabilityWindow.hs`).
- Koios API v1.4.2; Blockfrost OpenAPI 0.1.93 (`blockfrost/openapi`); the Zenodo REST API (`developers.zenodo.org`); the DataCite REST API (`api.datacite.org`).
- The reference implementations: `cardanowall/label-309-ts` tag v0.12.0 (commit f7e9b82) and `cardanowall/label-309-cli` tag v0.12.0 (commit 5400a64).

## License

The tool's code is licensed under Apache-2.0 (see `LICENSE`). This README is licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). The vectors under `test/vectors/label-309-v0.10.0/` are copied from `cardanowall/label-309` under its Apache-2.0 license, included beside them.
