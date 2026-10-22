# research-corpus

A command-line tool that draws the corpus of the UnFrack.It UTxO-management research from a cardano-db-sync database: the snapshot block, the two history windows, the frames and their exclusions, the draw, the random, ADA-only and purposive samples, the exploration and confirmation split, the prior-treated and franken flags, the per-wallet profile inputs, and the corpus manifest. It also reconstructs any wallet's UTxO set at any block and checks that reconstruction three ways.

The tool implements the sampling and UTxO-reconstruction rules of the study's pre-registration. The SQL is the design; the Node driver supplies parameters, runs the steps, computes published identifiers and writes the run directory.

## Where it may run

- **Preprod**: anything, at any time. All development and every test of this tool runs there.
- **Mainnet, before the final freeze**: live-fire checks only (see "Live-fire checks" below), after the hypotheses freeze: runs that confirm the code works on real data, with a stated test value of the draw key, that print, log and write no row count or population statistic, and that each leave entries in the check log.
- **Mainnet, after the final freeze**: the study's run, once. The driver checks the final freeze record, the code and the check log, and takes the snapshot the rule fixes, before it reads a wallet (see "The final freeze and the draw key" and "The snapshot").

On mainnet nothing given at run time may change the sample: `--set` is refused unless every value equals its hashed default, `--strata` unless the file's bytes are the hashed `data/strata-mainnet.json`, `--snapshot` for the study's run in any form but `rule` (for a live-fire run, any but `tip`), and `--study-key` unless it is the key pinned in `src/params.mjs` (see "The final freeze and the draw key"). The code manifest and the check log are bound to the final freeze record, and a second study run is refused once one is recorded for the final freeze. Node must be the pinned major, 24. Plan capture under `EXPLAIN ANALYZE`, a stand-in for the freeze, and any HMAC key other than the study's own are refused. Every command that queries mainnet (`run`, `a1`, `verify-freeze`, `confirm-snapshot`, `health`) adds a start entry and an end entry to the check log; the end entry carries the outcome and the run time only. The one exception is `own-drawn`, which reads the finished study run's sample and credential tables, not the chain, and leaves no trace (see "Adam K. Dean's own wallets").

Before anything else, every run reads db-sync's own bookkeeping (`meta`, `schema_version`, `extra_migrations`). A database whose extra migrations show `prune` or `bootstrap` has deleted the history the study needs and is refused. `tx_in` must hold rows whatever the configuration says (db-sync records the consumed configuration as `ConsumeTxOutPreviouslySet`; without `force_tx_in` it leaves `tx_in` empty and every output would read as unspent). Probes then check that db-sync inserted what the SQL reads, and refuse a database where any is missing: multi-asset outputs and mints, label-674 metadata in recent transactions, Plutus redeemers, inline datums in recent transactions, and epoch nonces. The session must have `standard_conforming_strings` on; parameters are written as `decode('<hex>', 'hex')`, which reads the same either way. The run then checks that block IDs and transaction IDs increase along the chain, which every transaction-id window relies on, and stops if they do not.

## Install

Node 24 is required (`engines` in `package.json`). From this folder:

```
npm ci
npm test
node src/cli.mjs help
```

The tool has its own `package.json` and lockfile and does not touch the app's dependencies, lint or build. Its one runtime dependency is `pg` (node-postgres). The unit tests also use `@electric-sql/pglite`, an in-process PostgreSQL, so they run the real SQL files with no database server and no chain data.

## The database

cardano-db-sync 13.7 (13.7.2.1 or 13.7.3.0; the later release's only schema change is a unique constraint on `epoch_state`, which the tool does not read) with the core `tx_out` layout (`use_address_table` false), `tx_out` set to `enable`, and multi-asset, metadata, Plutus and ledger data inserted; never `prune`, `bootstrap` or `only_utxo`. The preprod configuration and compose file used to develop this tool are in `infra/preprod/`.

The tool connects as a role that can read schema `public` and owns schema `study`; it writes nothing to `public`. Its tables live in `study`. db-sync's own snapshots dump schema `public` only, so study tables never travel inside a db-sync snapshot.

Connection: `--host --port --database --user`, or `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`. The password comes from the file `PGPASSFILE` names (libpq's format, mode 0600). It is read when the connection opens and never printed or logged.

## Commands

| Command | What it does |
|---|---|
| `init-secret` | Creates `secret/hmac.key`, 32 random bytes, mode 0600. Prints its path, never the key. Refuses if the key exists. |
| `run --run-id <id> ...` | Runs every step and writes the run directory. A rerun with the same id resumes. |
| `verify-freeze --prereg [--study-key] [--freeze-tx] [--hypotheses-tx]` | Finds the hypotheses record and the final freeze on chain, runs the final-freeze checks and prints each with its outcome, the draw key once its epoch has started, and the snapshot the rule fixes once it is deep enough for the run. Takes `--code-manifest` (required on mainnet), `--drawkey` and, on test networks, `--study-key` and `--from-block`, as `run` does. Reads only. |
| `cleanup --run-id <id>` | Drops a live-fire run's study tables and work directory, or removes an `a1` live-fire run's work directory, and adds an entry to the check log saying when, closing the run's start entries if it was interrupted. Refuses any other run. |
| `cleanup --start-seq <n> --network <n>` | Closes the start entry of a command killed before its end entry (one with no live-fire run to clean up, such as `health`, `verify-freeze` or `confirm-snapshot`) by adding a `start-closed` entry that names it. It closes that start only: unlike a run's cleanup, it settles none of the run's other starts, kept output or failed deletions, and it states nothing about what the command wrote. |
| `own-drawn --list <file> --run <id>` | Prints how many of the listed stake addresses (one bech32 stake address per line, `#` starts a comment) fell in each drawn sample of a run, and in all samples together. Only for the finished study run of a final freeze, or a finished test run on a test network; never a live-fire run or a run in progress. Writes nothing to the run directory, the manifest or the check log. |
| `check-log verify --network <n>` | Checks the check log's sequence and digest chain, and lists start entries never closed (an interrupted run), live-fire runs whose output was kept and never cleaned up, and failed deletions (exit 2 if any is found). A later clean finish of the same run ID settles them for that ID: a live-fire run that ends with its output deleted, or a query of the same name and run ID that succeeds. Anything else is closed by `cleanup`. |
| `check-log fix --network <n> --finding <text> --commit <sha> [--entry <seq>]` | Adds an entry naming a fix, the finding behind it and its commit. |
| `capture-strata [--out <file>] [--rulings <file>] ...` | Reads CoinGecko's ranking and the token registry and writes the strata file's candidate list (see "The strata"). |
| `confirm-snapshot --run-id <id>` | For a snapshot fixed by rule, applies the rule again in the database and in Koios: the same block, with the first block of epoch N at least 2,160 blocks deep in both. For another snapshot, checks that it is still on chain and at least 2,160 blocks deep in both. Exit 2 if it is gone or the rule names another block, 3 if it is too soon or Koios cannot confirm it. |
| `a1 [--from-run <id>] [--stake <address> ...] [--node-stake <address> ...]` | Compares stake credentials' UTxO sets in the database at its tip with Koios and, for `--node-stake`, with the node's own query by address (`--node-container`, `--node-socket`, `--magic`). `--from-run` adds the first 20 credentials of a run's recent-frame draw order, the first 5 of them for the node (`--count`, `--node-count`). On mainnet it runs only as a live-fire check (`--live-fire --purpose <text> --expect-network mainnet --hypotheses-tx`, `--keep-for-debug`; the differing UTxO lines go to a work directory removed at the end unless kept, and the check log gets a start entry and an end entry with each credential's outcome as equal, explained or differs) or after the final freeze with the same freeze options as `run`. Koios is called on mainnet with the study's own token from `RESEARCH_CORPUS_KOIOS_TOKEN`, on test networks with none. |
| `health` | Table row estimates and sizes (`pg_class`), as JSON. Reads no chain data. |
| `project --timings <file> --preprod-rows <file> --mainnet-rows <file>` | Scales a preprod run's step times by mainnet row counts. |
| `hash` | SHA-256 of every hashed file, the pinned dependencies and the Node version. Also `npm run hash`. |

Options of `run`:

| Option | Meaning |
|---|---|
| `--snapshot tip`, `rule` or `<block hash>` | The snapshot block. A run on the final freeze always takes the block the rule fixes (see "The snapshot") and refuses any other. Otherwise the default, `tip`, is the database tip when the run starts (stop db-sync there first so the database is that block's state); `rule` applies the rule to the stand-in's draw epoch; a hash names a block. A resumed run keeps the block it recorded. A live-fire run on mainnet: `tip` only. |
| `--freeze-tx <hash>` | The final freeze transaction, which must be the one the chain names (see "The final freeze and the draw key"). h, the draw's key, is the epoch nonce its block's epoch rule names. |
| `--hypotheses-tx <hash>` | Optional: the hypotheses freeze transaction, which must be the one the chain names. |
| `--from-block <height>` | Test networks only: start the scan for the study key's records at this block, after earlier rehearsals signed by the same key. |
| `--prereg <file>` | The final pre-registration, byte for byte as frozen. |
| `--study-key <hex>` | Test networks: the freeze identity's 32-byte signing public key. On mainnet the key is the pinned one (see "The final freeze and the draw key"), the option may be left out, and any other key is refused. |
| `--code-manifest <file>` | The study run on mainnet: the `npm run hash` output frozen with the final freeze. Every file of the code must match it, path by path, and its SHA-256 must be an item of the final record. |
| `--drawkey <file>` | Mainnet: the freeze tool's `drawkey.json` for the final freeze, which records the nonce of epoch N as Koios and Blockfrost read it; its network, epoch and nonce must agree with the database and with Koios read now. |
| `--stand-in-tx <hash>` | Test networks only: a transaction whose block's epoch rule stands in for the freeze's. |
| `--live-fire`, `--test-h <hex>`, `--purpose <text>` | A pre-freeze check run with a stated test value of h (32 bytes), on any network. It also needs `--expect-network`, so its gate is logged before the first query, and on mainnet `--hypotheses-tx`. |
| `--keep-for-debug` | Live-fire only: keep the run's study tables after it ends; `cleanup` drops them later. |
| `--explain` | Plans every explainable statement with plain `EXPLAIN (FORMAT JSON)` before running it, and keeps the plans with every row estimate, width and cost removed. |
| `--strata <file>` | The strata list (default `data/strata-mainnet.json`; on mainnet that file only). |
| `--case <stake address>`, `--cases <file>` | Case wallets: the per-wallet steps also run for them, whether or not they are drawn, and they stay in the frames like any other wallet. `--cases` takes one bech32 stake address per line, `#` starting a comment. The run directory counts them and never names them, and the check log replaces `--case` values with `<address>`. |
| `--hmac-key <file>` | Test networks only: an HMAC key other than `secret/hmac.key`. |
| `--set name=value` | Overrides a setting. A resumed run must use the settings it started with. On mainnet, refused unless the value is the default. |
| `--redo <step>` or `all` | Recomputes a step and every step after it. |
| `--capture` | Runs every explainable statement under `EXPLAIN (ANALYZE, BUFFERS)` and keeps the plans. Test networks only, never in a live-fire run. |
| `--expect-network <name>` | Refuses any other database. |
| `--work-mem`, `--maintenance-work-mem`, `--parallel-workers`, `--temp-tablespaces` | Session settings for the heavy steps (defaults 1GB, 1GB, 4, the server's). |

## Outputs

Data never enters the repository. Everything is written under `${XDG_DATA_HOME:-$HOME/.local/share}/unfrackit-research/` (`RESEARCH_CORPUS_HOME` overrides it), directories 0700 and files 0600:

```
secret/hmac.key                 the study's HMAC key (init-secret)
check-log/<network>.jsonl       the check log of live-fire runs, cleanups and fixes
runs/<network>/<run-id>/
  params.json                   snapshot, freeze records and the draw key, windows and tx-id bounds, settings, case-wallet counts, code version
  report.json                   every count: flow tables, draw, strata and the fungible floor, split, flags, the reconstruction check, profiles, era report
  timings.json                  wall time and rows of every step and statement, with plans when captured
  manifest.json                 the corpus manifest
  raw/sample.csv                the samples with stake addresses, without published identifiers
```

A live-fire run's directory holds only `live-fire.json` (its end entry) and, with `--explain`, `plans.json`.

The manifest holds the snapshot block (height, hash, time, and for a snapshot fixed by rule its epoch and the depths at which the database and Koios confirmed it), the final and hypotheses freeze records with the draw key and every reading of it, the code manifest's digest, the windows, the flow tables, the draw summary, the strata list with its parts and counts, the fungible floor's candidates (holder counts for those at or above the floor, "below floor" otherwise), each sample's bound (below), the reconstruction check counts (without the case-wallet counts, which stay in `report.json`, since case wallets can be drawn), the split over all sampled credentials, the code version, and per frame and sample the published identifiers with their split. A published identifier is HMAC-SHA256 under the study key over the credential's 29-byte reward address, truncated to 16 hex characters; the key never reaches PostgreSQL. Identifiers are sorted within each sample, so the manifest does not carry the draw order. It names no stake address or address, and no transaction hash but the two freeze records'. `raw/` names stake addresses and stays private; it carries no published identifier (one can be recomputed while the key exists), so destroying the key at publication leaves nothing that links an identifier to an address.

Each sample has a published bound, the draw key of the last wallet it took.

## Steps

Each step runs in one transaction with its row in `study.step` (run ID, name, start, finish, rows) and a comment naming the run on every table it builds. A rerun skips finished steps whose tables still carry the run's mark; once one step is recomputed, every later step is too. A failed step leaves nothing behind.

| Step | File | Builds |
|---|---|---|
| (precondition) | `00-study-schema.sql` | order check; `study.run`, `study.param`, `study.step`; T(B) helpers |
| `epoch_counts`, `peak_runs` | `05-03-windows.sql` | transactions per epoch (all, phase-2-valid, the `epoch` view's count); 73-epoch runs since the Mary hard fork, ranked |
| `era_report` | `05-03-windows.sql` | fee, minimum-UTxO (Mary's `min_utxo_value`, then coins per UTxO word or byte), value-size and tx-size changes inside each window |
| `cred` | `05-04-credentials.sql` | every stake credential with its header type and network tag, checked |
| `txo`, `txo_asset`, `asset` | `06-01-txo.sql` | the life table of every output with a stake credential; its assets; every asset's CIP-67 label |
| `activity` | `05-04-activity.sql` | receipts and spend events per window |
| `state`, `paycount` | `05-05-exclusions.sql` | UTxO count, lovelace, script-held lovelace, assets and payment credentials (all, and key credentials only) at the reference blocks |
| `frame`, `flow` | `05-04-frames.sql` | both frames with every stage, the draw and split keys; the flow table, whose first stage starts from the stake credentials with at least one transaction output at or before the snapshot (db-sync's `stake_address` has no transaction ID, so a credential's first appearance is read from its outputs, in the life table `study.txo`, which holds exactly the outputs with a stake credential up to the snapshot), so the count does not depend on when the run happens |
| `draw` | `05-04-draw.sql` | draw order with running counts; the stopping points; the random and ADA-only samples |
| `strata_list_table`, `ft_floor`, `nft_top`, `strata` | `05-04-strata.sql` | the named rows and the CoinGecko candidates; the fungible floor and the ten candidates taken; the frozen NFT query's ten policies; the strata samples |
| `split`, `sample_wallets` | `05-08-split.sql` | one exploration or confirmation label per sampled credential; the sampled and case wallets |
| `check_61_table` | `06-01-check.sql` | the three-way check of every sampled wallet at the snapshot; `excluded_6_1` on every sample row |
| `unfrackit_tx`, `prior_flags` | `05-06-prior-treated.sql` | label-674 UnFrack.It messages; UnFrack.It and Evolution flags per wallet |
| `franken` | `05-05-franken.sql` | franken flags per payment credential |
| `script_tx`, `profile` | `05-09-profile-inputs.sql` | spends, market interactions (DEX, marketplace, other), holdings, and the descriptive profile and flags |

Every count over the sample after `check_61_table` leaves out the wallets the check excluded, and the split counts report them beside the rest.

`lib-cip67.sql` holds the CIP-67 label parser and the classification rule; `06-01-utxo-at-block.sql` the three UTxO-set queries.

### Conventions

- Block IDs identify blocks. T(B) is the largest transaction ID at or before block B. A window [B1, B2] is the transaction-ID range [first ID with `block_id >= B1`, T(B2)].
- The state at a window's start is the state as of the last block before its first block; at its end, as of its last block.
- A wallet's UTxO set at block B, from the life table: `created_tx <= T(B) AND (consumed_tx IS NULL OR consumed_tx > T(B))`.
- UTxOs carrying a datum or reference script, or at a script payment credential, are flagged as held and never removed.

### The UTxO set three ways

1. The reference query: the pattern of db-sync's own UTxO-at-block query (`cardano-db-tool utxo-set`), restricted to the wallet's credential. It reads db-sync's tables only.
2. The life table at T(B).
3. Read directly: the wallet's outputs with no consuming input at all, in a database stopped at the snapshot. It is defined at the tip only, so a run whose snapshot is not the database tip skips it and records `direct_valid` false; the other two still decide the check. The study's run on mainnet is such a run, since its snapshot is fixed by rule and lies well below the tip, so on mainnet the section 6.1 check runs two implementations, the reference query and the life table.

Each UTxO is compared as one line, `<tx hash>#<index>:<lovelace>:<policy>.<name>=<qty>,...` with assets sorted by bytes; a wallet's set as the count and MD5 of its sorted lines. Node builds the same line from Koios and from the node's query, so every comparison is exact.

## The final freeze and the draw key

The study key is the freeze identity's Ed25519 signing public key, `8e050bfd8d687a27025f9bd5805a13501329dac58092f1c702ff626dc0780cfe`, pinned as `STUDY_KEY` in `src/params.mjs`. A record's key names nobody by itself (CIP-190, "Reporting signature results"), so the study names its key in the tool's public source. On mainnet `run`, `verify-freeze` and `a1` read the study's records under this key and refuse any other `--study-key`, so a second freeze identity cannot produce a second valid final freeze. On a test network, where rehearsals sign with other keys, `--study-key` names the key.

The chain alone decides which records are the study's. The run reads every label-309 record that verifies under the study key, in transaction order:

- the hypotheses record is the study key's first record on chain; every transaction carrying its signed content is that record, and the first of them is its first carrier;
- the final record is the first later record signed by the study key, without `supersedes`, whose signed content (the body without `sigs`) differs from the hypotheses record's. A replay of either, with or without added co-signatures, is the same record (CIP-190, "Security and Privacy Considerations", "Signature replay"), and a record with `supersedes` retypes an earlier one (CIP-190, "Supersedence") and is never the final;
- the final freeze transaction is the first transaction carrying the final record's signed content with a label-674 message of exactly the SHA-256 of the final pre-registration given with `--prereg` (CIP-20, "Specification"). A copy without that line, or anyone's 674 line naming the digest, neither counts nor blocks it; a complete copy that lands first is the final freeze.

`--freeze-tx` and `--hypotheses-tx` decide nothing: each must be the transaction the chain names (for the hypotheses record, its first carrier), and the refusal names the chain's. On mainnet the scan starts at genesis. On a test network, where one key signs many rehearsals, `--from-block` starts it later.

Two operational rules follow for the key holder on mainnet. Between the hypotheses record and the final freeze the study key signs nothing else. A hypotheses or final record, once broadcast, is never abandoned and replaced by a newly signed one: a transaction that does not land is resubmitted with the same bytes, because anyone may replay a broadcast body later (CIP-190, "Signature replay"). The second rule also applies to bodies signed before the hypotheses record. If a rule is broken and the other body reaches the chain, the chain's order takes it as one of the two records: landing ahead of the hypotheses record, it becomes the hypotheses record and turns the real one into the final record; landing between the two, it becomes the final record. The tool then refuses the intended final freeze and any published later, because no carrier of the chain's final record carries that document's label-674 line. The key holder cannot name the body that counts instead, because the tool cannot tell a replayed draft from a record published on purpose. A choice between records would be a choice between finals, and so between draws.

The run then checks, from the database, that the final freeze transaction carries the study's final record, and refuses with every failed check named:

- its label-309 value is a CIP-190 record (CIPs at merge commit 58b4dd1417, CIP-0190, "Metadata label 309 and the chunk-array transport", "Canonical CBOR"): the chunks, as db-sync stores them in `tx_metadata.bytes`, reassemble to a canonical body with `v` 1 and items, and the body is decoded strictly;
- every signature verifies, and one is by the study key (CIP-190, "Signed payload and Sig_structure": Ed25519 over the RFC 9052 `Sig_structure` with the protected header as published and the bytes `cardano-poe-record-sig-v1` followed by the canonical record without `sigs`; "Signer-key identification", path 1: the key is the 32-byte protected `kid`), and the pre-registration names the key;
- the record's items include the pre-registration's digest and the digest of every file of this code (`npm run hash`);
- the pre-registration lists every other item of the record exactly once, as the freeze tool requires, in lines of `<64 lowercase hex><two spaces><name>`; every such line names an item, and the pre-registration does not list itself. CIP-190 items carry no names (CIP-0190, "Item entries"), so the list says which item is which, and only one item of a record can be its document, since two documents would each have to contain the other's digest;
- the list names exactly one code manifest, as `code-manifest.txt`, and exactly one check-log prefix, as `check-log.jsonl` (the names are in `src/params.mjs`). The code manifest given with `--code-manifest` must be the named one, and the code's files must match it, path by path. On mainnet the named prefix must be a prefix of the check log ending at a line (the log as it stood at the final freeze; it only grows), every later entry must be dated after the final freeze block, so no run made before the freeze can sit outside it, and the first live-fire run in the log (a start entry, written only once a run has passed its gate) must be later than the hypotheses record's block;
- the pre-registration cites the chain's hypotheses record by the CIP-0107 URI `web+cardano://transaction/<hash>/metadata/309` of any transaction carrying its signed content, and the pre-registration is not an item of the hypotheses record. Both are read from the signed content, never from a carrier's label-674 line, which a copy may leave out or change, so a copy of the hypotheses record that lands ahead of the key holder's own blocks nothing, and a document citing the key holder's transaction passes;
- the freeze block is at least 2,160 blocks below the database tip.

One study run is allowed per final freeze, and a second is refused: the snapshot is fixed by rule and confirmed beyond rollback before the run reads it, so a second run could only repeat the first. A run that stopped resumes under its own run ID.

h, the draw key, is the epoch nonce of epoch N. E is the epoch of the final freeze block; N is E + 1 if the block's slot is earlier than E's first slot plus the epoch length less the randomness stabilization window, and E + 2 otherwise. The window is 4k/f slots in every Praos era except Babbage, which uses 3k/f (IntersectMBO/ouroboros-consensus, `ouroboros-consensus-cardano`, `Ouroboros/Consensus/Cardano/Node.hs`, `praosRandomnessStabilisationWindow` and `partialConsensusConfigBabbage`); the run refuses a freeze block before Conway (protocol major 9). On mainnet and preprod k is 2,160, f is 0.05 and an epoch is 432,000 slots, so the cutoff is 259,200 slots into the epoch. These constants are in `src/params.mjs` and are compared with Koios `/genesis`. The nonce is read from `epoch_param.nonce` and from Koios `/epoch_params`, and on mainnet also from the freeze tool's `drawkey.json` given with `--drawkey`, which records the readings of Koios and of Blockfrost for epoch N; the file is matched on network, epoch and nonce, and the transaction it was written for is recorded with the readings, since a complete copy of the record landing first would make another transaction the final freeze with the same draw epoch. The run refuses if N has not started in the database or any reading differs. On a test network, `--stand-in-tx` applies the same rule to a stand-in transaction's block.

The draw and split keys are SHA-256 of the ASCII bytes `draw` (or `split`), then the 32 bytes of h, then the 28-byte stake credential. A test vector, checked by the unit tests: h `8827df62e1c5f7909885b09cb156d6f1eca8b15eb793fa4758e95c8aa79a1d00` (preprod's epoch 320 nonce) and the credential `337b62cfff6403a06a3acbc34f8c46003c69fe79a3628cefa9c47251` (the stake key of CIP-19's test vectors) give the draw key `88977a462d379bd930e77accf1a8268456042de78447381c9b226cff74846b2c` and the split key `8a31ce172bafcb7ee867a64ccc8a6e0a4f24405d98bf739b74abbd939179d2a2`.

## The snapshot

The study run's snapshot is fixed by rule: the last block of epoch N - 1 whose slot is earlier than N - 1's randomness stabilization cutoff (its first slot plus the epoch length less 4k/f, with k, f and the epoch length the genesis constants above), N being the draw epoch. A block feeds the candidate nonce that becomes epoch N's nonce only while its slot is before that cutoff (IntersectMBO/ouroboros-consensus at d94473e212, `ouroboros-consensus-protocol`, `Ouroboros/Consensus/Protocol/PolyPraos.hs`, `praosStateCandidateNonce`), so the nonce is fixed there and any node can read it from then on. With this rule the frames are fixed no later than the key. The snapshot is at or after the final freeze block when N is E + 1 (the freeze is before E's cutoff, and is the snapshot block itself when it lands in the last block before the cutoff) and when N is E + 2; nothing is read before the freeze and the nonce is still unknown then. The run refuses a snapshot before the freeze block. Nobody chooses the snapshot at run time, and the run refuses any other. Wallet state is read as of that block, whatever the database tip: every step bounds its reads by the snapshot's block ID or T(B). Before the run reads a wallet it checks that the database holds the first block of epoch N at least 2,160 blocks below its tip, so no rollback can add a block before the cutoff, and that Koios names the same snapshot block and the same first block of epoch N, at least 2,160 blocks below Koios's tip; it refuses otherwise, and the manifest records both depths. `confirm-snapshot` repeats the check later. Because the snapshot is below the tip, the direct read of the reconstruction check is skipped (see "The UTxO set three ways"). On a test network `--snapshot rule` applies the same rule to a stand-in's draw epoch.

## Live-fire checks

Before the final freeze the study's code may run against mainnet to confirm it works, under a commitment that nothing such a run shows changes the pre-registration. `run --live-fire --test-h <hex> --purpose <text> --expect-network <name>` (and `a1 --live-fire --purpose <text> --expect-network <name>`) is that run:

- On mainnet it needs `--hypotheses-tx`: the hypotheses freeze must be in the database with a record signed by the study key, because the hypotheses are frozen before the first live-fire query.
- The gate (connection, probes, the refusals, the hypotheses record on mainnet, the run's own row) is logged in `check-log/<network>.jsonl` as a query: a start entry before the first database query, and an end entry with its outcome. Only a run that passes the gate gets a live-fire start entry (run ID, command, purpose, test h, code); the run's end entry names it. A refused attempt is a failed query, never a live-fire run, so it cannot fall before the hypotheses record as one. A run that is interrupted (killed, disconnected) leaves its starts unclosed, which `check-log verify` reports until `cleanup --run-id` closes them or the same run ID is run again to a clean finish, which settles its live-fire starts and its gates'. A gate killed before the run recorded itself is settled the same way, or closed with `cleanup --start-seq`, which closes that one start and nothing else of the run.
- h is the stated test value. The run refuses a value that is an epoch nonce or block hash of the chain, and refuses a database that already holds the study's run. Every run and `cleanup` holds a PostgreSQL advisory lock for its session, so two never rebuild the study schema's tables at once.
- Nothing counted is printed, logged or written. The step log names each step with its time and nothing else; `study.step` stores no row counts; no report, manifest, timings or raw list is written. Error text is logged with every bech32 string (in either case), every hex run of 20 or more characters (with any `\x`, `0x` or `_` before it) and any shorter hex after `\x` or `0x` replaced, and, unless the error is one of the code's own refusals, every number, with any unit after it, and every other word holding a digit, except snake_case names such as settings, tables and columns. The logged command line replaces the values of `--stake`, `--node-stake` and `--case` with `<address>`.
- `--explain` plans every statement with plain `EXPLAIN` first and keeps each plan reduced to its shape: node types, relations and indexes, join and scan kinds, conditions, keys and outputs. Row estimates, widths, costs, planned workers and partitions and the JIT flags are dropped. `EXPLAIN ANALYZE` is refused.
- The run's study tables are the wallet-level output. They are dropped when the run ends, whether it succeeded or failed, unless `--keep-for-debug` is given; `cleanup --run-id <id>` drops kept tables later. A kept run still drops the aggregate tables it built (`flow`, `draw_summary`, `ft_floor`, `nft_top`, `unfrackit_tx`, each only while it carries the run's mark), and the tables it keeps are read only to debug the step that failed. A refused invocation drops nothing: only a run this invocation created or resumed as live-fire, and still recorded as one, is ever dropped.
- The end entry holds the outcome (succeeded or failed, with the error), the run time, each step's outcome and time, functional checks as true or false (the probes, the order check, the peak rule against its frozen value, the section 6.1 check, the profile spend counts), per-field parse coverage as true or false (whether every row or epoch had the field present and parsed: reward addresses, payment credentials, the era parameters, label-674 JSON), and whether the wallet-level output was deleted, with the time, kept, or never written. `cleanup` and `check-log fix` add their own entries.

The log is JSON Lines: one object per line, UTF-8, LF, keys in a fixed order, appended and never rewritten. Each entry carries its sequence number and the SHA-256 of the file before it was appended, so `check-log verify` detects an edit to any earlier line. The final freeze hashes the mainnet log as it stands; the study run then checks that exactly one prefix of the log is an item of the record named in the pre-registration, and that every later entry postdates the freeze block.

## Adam K. Dean's own wallets

Adam K. Dean's own wallets are not excluded: they stay in every frame and are drawn like any other. After the draw, `own-drawn --list <file> --run <id>`, on the finished study run of the final freeze, reads a private list of his stake addresses and prints, to the terminal only, how many of them fell in each drawn sample and in all samples together, so he can state the number and a sensitivity analysis can leave them out. It writes nothing to the run directory, the manifest or the check log, and the list never enters the repository.

## The strata

The strata list has three parts, processed in this order, each part's strata skipping wallets already in the frame's random, ADA-only and earlier strata samples:

1. The named projects, always included: Clay Nation and SpaceBudz (NFT, by policy), NIGHT, IAG, HOSKY and SNEK (fungible, by policy and asset name).
2. Ten fungible tokens from the CoinGecko candidates, taken in rank order, skipping any held by fewer than 1,000 stake credentials and any that is also a named token, until ten qualify. "Held by a stake credential" counts the eligible wallets of the recent frame at the snapshot, held UTxOs included, as the NFT part does. The result is computed once and used for both frames; fewer than ten is recorded, not an error.
3. The ten NFT policies held by the most eligible wallets of the recent frame at the snapshot, on merit: no policy is barred apart from the named ones, so a Clay Nation collaboration or look-alike policy enters if it ranks. A policy counts only if no asset of it ever had a running supply above one: the asset's mints less its burns, summed in chain order up to the snapshot, never exceeding 1 (a CIP-25 re-mint after a burn stays an NFT; an asset ever outstanding in two units does not). Inside such a policy an asset is non-fungible by the rule of section 6.2, so a label-333 or label-444 asset is not counted, and an NFT stratum of this part takes holders of the assets the ranking counted.

`data/strata-mainnet.json` holds parts 1 and 2: the named rows, the candidates in rank order with their policy, asset name and registry cross-check, every coin the capture excluded with the reason, and the provenance. `capture-strata` writes it on the freeze date:

- It reads CoinGecko's "Cardano Ecosystem" category ranked by market capitalization and records the endpoint, the response's `Date` header, the time it was read and the SHA-256 of the raw response, and the same for each coin's detail.
- It excludes ADA itself; any coin the rulings file excludes (`data/strata-rulings.json` by default, `--rulings` names another: coin ID, reason, source); stablecoins and bridged or wrapped assets, read as CoinGecko's own categories for the coin (any category whose name contains "stablecoin", "bridged" or "wrapped") or a coin ID or name that says bridged or wrapped; any coin whose CoinGecko `asset_platform_id` is not `cardano`, because its Cardano token is then not the original issuance, unless the rulings file lists it as first issued on Cardano; coins with no Cardano native asset; and the named tokens. The working definition: an asset is bridged or wrapped when its Cardano token is issued by a bridge against an asset whose original issuance is on another chain; a token first issued on Cardano and later bridged out is not. The rulings file excludes FET, AGIX, NTX, RJV, CGV, PBX, OCC and XNK as bridged and keeps WMTX, RISE, COPI and L4VA as first issued on Cardano (Adam K. Dean's rulings of 2026-10-21); the floor guards against a market capitalization that overstates a token's Cardano holding.
- It maps CoinGecko's Cardano contract to a policy and asset name: given as both, given as the policy alone (resolved to the one registry subject under the policy, or among several to the one whose ticker is the coin's symbol), or given as a CIP-14 fingerprint (resolved by computing the fingerprint of every registry subject).
- It cross-checks each candidate with the Cardano Foundation token registry (`github.com/cardano-foundation/cardano-token-registry`, `mappings/`, read at one recorded commit): the subject must have a mapping whose ticker is the coin's symbol or whose name is the coin's name. A candidate without one is excluded with the reason.
- It keeps the named rows from the current file (`--named-from` names another), takes each candidate's own-source note from `--own-sources` (a map from subject to text), and records in the provenance the policy IDs Adam K. Dean confirmed on 2026-10-21: HOSKY, SNEK, WMTX and NVL.
- `--max-candidates` (default 40) bounds the list; `--spacing-ms` (default 15,000) spaces the CoinGecko requests, and a 429 or 5xx is retried after the server's `Retry-After`.

## Settings

The numbers the pre-registration fixes (73 epochs, the Mary hard fork as the start of the peak search, 365 days, the guard of 200,000, the targets 2,400, 1,000 and 600, the 1,200 ADA-only wallets, 50 per stratum, ten NFT policies, ten fungible tokens and their floor of 1,000 holders, the exclusion caps 20,000 UTxOs, 200 payment credentials and half the value, the profile cut points) are fixed settings in `src/params.mjs`.

Where the pre-registration's text admits more than one reading, the reading is a setting named `x1_` to `x21_`, and its default is the reading this code uses. A different answer changes one value through `--set`, not the SQL.

| Setting | Default | Meaning of the default, and of the alternative |
|---|---|---|
| `x1_enterprise` | false | A wallet's outputs are those with its `stake_address_id`. true adds enterprise outputs at key payment credentials owned by exactly one stake credential. |
| `x2_any` | false | A spend consumes a wallet output at a key payment credential; a DEX order at a script address carrying the wallet's stake key, consumed by a third party, is not the wallet's spend. true counts any wallet output. Both counts are kept. |
| `x3_after_first` | false | The state at a window's start is as of the block before its first block. true uses the state after the first block. |
| `x5_reward29` | false | The draw and split hash `"draw"` (or `"split"`), then the 32 bytes of h, then the 28-byte credential. true hashes the 29-byte reward address instead. |
| `x7_prefix` | true | Every token-holding wallet up to the stopping point joins the random sample, a prefix of draw order. false admits only wallets meeting (b) or (c) after (a) is reached. |
| `x8_measure` | distinct | "100 or more tokens" counts distinct assets; `units` sums quantities; `nft` counts non-fungible assets. |
| `x9_count_held` | true | Held UTxOs count toward token-holding, asset counts, UTxO counts and lovelace. |
| `x10_skip_random_only` | false | A stratum skips wallets already in the frame's random, ADA-only and earlier strata samples. true skips only the random sample. |
| `x10_spacebudz_one` | false | The two SpaceBudz policies are two strata of 50. true merges them into one. |
| `x12_history` | true | Payment credentials are counted over the stake credential's history up to the reference block. false counts those present at it. Either way the cap counts key payment credentials only (script payment credentials are contracts the wallet used), and the report counts the wallets an all-credential count would have removed. |
| `x13_all` | false | Franken flags consider key payment credentials only. true includes script credentials. |
| `x14_search_bytes` | true | Label-674 payloads db-sync could not decode as JSON are searched in their bytes and counted separately. |
| `x15_bech32` | false | The HMAC input is the 29-byte reward address. true uses its bech32 text. |
| `x17_invalid_is_script` | true | A phase-2-invalid transaction counts as executing a script. Native-script evaluation never does. |
| `x19_count_invalid` | true | Every transaction counts toward the peak window, phase-2-invalid included, as the `epoch` view and Koios count. The search begins at the first epoch whose `protocol_major` is 4 or more (the Mary hard fork; epoch 251 on mainnet), read from `epoch_param`, never an epoch number. |
| `x21_others_allowed` | true | The seven Evolution outputs are the transaction's only pure-ADA outputs at the wallet; other outputs are allowed. |

Readings with no setting, because no alternative changes the code: the guard counts eligible keys taken in draw order; only completed epochs before the snapshot's epoch can end the peak window. Two more readings are fixed. The NFT ranking counts only policies whose assets never had a running supply above one (see "The strata"). The split gives one exploration or confirmation label per stake credential, assigned once by ranking every sampled credential across all samples by its split key and taking the first floor(N/5) of the N distinct credentials as exploration, so a wallet in both frames has the same label in both and each sample is about, not exactly, 20% exploration.

The peak window may begin in Mary-era epochs (protocol major 4), before Alonzo. Their transactions have no redeemers, collateral, datums or reference scripts in db-sync and are valid, so every step reads them without special cases; the era report shows the Mary minimum-UTxO parameter (`min_utxo_value`) for those epochs and `coins_per_utxo_size` from Alonzo on, and no step compares an output with an era minimum.

The profiles are descriptive only. The pre-registration defines them by a clustering procedure fitted on the exploration split, which this tool does not implement. The fixed cut points above, the `profile` column and its three flags are a descriptive field, not the profile definition.

## Hashing

The extraction and sampling files are fixed on chain before any study query runs, because the code that draws the sample is part of what the freeze commits to. `npm run hash` prints the SHA-256 of every file under `src/`, `sql/` and `data/`, of `package.json` and `package-lock.json`, the pinned dependencies with their npm integrity, and the Node version. It refuses a file that is not UTF-8 with LF line endings and a final newline, or that has a byte-order mark. Tests, the README and `infra/` are not hashed. Its output, frozen with the final freeze, is the code manifest a mainnet run compares itself with; each listed digest must also be an item of the final freeze record.

`data/strata-mainnet.json` holds a dated capture; `capture-strata` writes it again on the freeze date, before hashing. `data/strata-rulings.json` holds the rulings it applies.

## Tests

`npm test` runs the unit tests: no database, no chain data. They cover the CIP-67 parser on the CIP's ten test vectors, the five registry prefixes and the CIP-68 asset names the preprod seeder generates for one of its test wallets; the classification rule; the draw and split digests from the SQL against Node's SHA-256 and against the published test vector; the frame stages, flow table, draw (the guard path and the path where all three targets are reached) and the one-label split on a small fixture; the peak search's Mary boundary; the NFT ranking (running supply, including an asset nobody holds, the per-wallet class, exclusions, the snapshot bound, the tie-break), the fungible floor, and the fill of every stratum against an independent statement of the rule; the final-freeze checks on records signed in the test (each refusal; the transactions named or found on chain; the hypotheses record refused as final; a superseding record; a second final record, a second hypotheses record, a replayed one and a stray record of the key, the chain deciding each; replays, retypes, co-signed copies, bare copies, strangers' 674 lines and carriers whose 674 line holds the digest among other lines, none of which blocks or replaces the final, and a complete copy that does; a bare copy of the hypotheses record landing ahead of the key holder's, with the document citing either; an abandoned body replayed ahead of the hypotheses record; records sharing a block, ordered by transaction; one record carrying two document digests; the document's list of items, an item listed twice, its one code manifest and one check-log prefix; two freeze identities on one chain, under the pinned key and under the test-network flag; `--from-block`; the log's entries after the prefix; the hypotheses URI matched whole; a non-canonical body; an oversized chunk), the epoch rule, the snapshot rule before the cutoff with its depth from the first block of epoch N and Koios's first block of N compared by hash, a rule snapshot that is the freeze block itself, the flow table's first stage counting no credential first seen after the snapshot and giving, from the life table, the count `tx_out` gives, the draw key's readings and the freeze tool's `drawkey.json`; the mainnet refusals through the pipeline with PGlite holding a study run (which a refused live-fire run leaves intact, logged as a failed gate and never as a live-fire run), a second study run, another study key, a mainnet live-fire run whose hypotheses record another key signed, `verify-freeze` and `a1` refusing `--from-block` and another study key and `verify-freeze` refusing a missing code manifest, each before a chain table is read, the study run's wiring of the code manifest, the check log, `drawkey.json` and the snapshot rule on chain tables in PGlite, as far as the stored rule snapshot, `own-drawn` and its refusal of live-fire and unfinished runs, `cleanup` of an interrupted run and of an `a1` run; the key-credential cap; the code manifest; the check log's chain, unclosed starts, failed deletions, their settling by a later clean run and not by another run's or another query's, `cleanup --start-seq` closing its one start and leaving the run's kept output and other starts reported, error and command redaction and the plan reduction; `capture-strata` against a fake CoinGecko and registry, BLAKE2b against Node's and the CIP-14 vectors; `a1`'s difference rule and CIP-19's pointer-address vectors; the Evolution fingerprint at and just beyond 0.2 percentage points; the franken flags; HMAC against a fixed key with values computed by OpenSSL; CIP-19 address decoding on the CIP's vectors; the SQL's canonical UTxO lines against Node's; and the statement splitter, the typed parameters and the hash list.

`test/integration/run-preprod.sh <tag>` runs the integration tests against a preprod database. Stop db-sync first so the tip stays at the snapshot, and start it again afterward. The seeded wallets of the preprod seeder (`tools/preprod-seeder`, draft pull request #9 in this repository) are the ground truth; the tests use only its `address` and `verify` commands and its deterministic shape generator, which touches no key.

| Test | What it checks |
|---|---|
| T1 | No block has `previous_id >= id`; transactions in (`block_id`, `block_index`) order are in id order. |
| T2 | Each shape's address maps to one stake credential, whose bech32 form and hash match the address's delegation part; one payment credential per shape. |
| T3 | The shapes at the snapshot match the seeder's specification: counts, lovelace and assets per UTxO under a one-to-one map of policies; nothing held; `verify` exits 0. |
| T4 | The rehearsal of the database check against independent sources: twenty credentials against Koios (preprod public tier, no token, 150 ms apart) and five against the node's `query utxo`, at the database tip, with every later transaction listed; a line found only in the database counts as explained only if a later transaction spends that input, and pointer addresses are left out of the node comparison. |
| T5 | Every transaction that touched each shape is one of the seeder's, with the expected outputs, burns and payers. |
| T6 | Each shape's state before and at every block of its history. |
| T7 | The reference query and the life table agree at every T6 block, the three implementations agree at the snapshot, and both agree with `cardano-db-tool utxo-set` at three slots (reported as not run if the pinned db-sync image's tool fails). |
| T8 | The reference query and the life table agree for 1,000 credentials at 20 blocks. |
| T9 | Five phase-2-invalid transactions: their `tx_in` rows are the collateral inputs of their own CBOR (which Koios serves byte for byte), their body inputs are not spent by them, and the collateral return is the output at the index equal to the number of body outputs. |
| T10 | Two full runs with a guard of 1,000 and h from the stand-in's epoch rule: the flow table adds up, the case wallets stay in the frames and are named in no published file, `own-drawn` counts them in the samples and writes nothing, the shapes land where they should, no franken flag on them, the fungible floor and the one-label split follow their rules, the reconstruction check passes with the direct read, and the two runs build identical tables and manifests. |
| T11 | The label-674 UnFrack.It messages on preprod, and no seeder transaction among them. |
| T12 | The first T10 run captures every step's plan, time and rows. |
| T13 | The freeze checks on the freeze tool's preprod rehearsal records (`RESEARCH_CORPUS_REHEARSAL_DIR`): every record reassembles, is canonical and verifies under the rehearsal key; scanning from the core-only freeze's block, the chain names the core-only freeze the hypotheses record and the typed freeze the final, with or without the transactions named; the typed freeze passes every record check and the document's list, and is refused for what a rehearsal cannot meet (its placeholder document cites no hypotheses record and lists no code manifest or check-log prefix, and its items are not this code); the retype and the core-only freeze are refused as not the chain's final; a scan from after the typed freeze finds another hypotheses record; the draw key's epoch rule is applied to the typed freeze's block, and the snapshot rule, once epoch N has started, and for the stand-in's draw epoch, names the last block of epoch N - 1 before its cutoff, which Koios names too. |
| T15 | A full run at the stand-in's rule snapshot, below the tip: the snapshot is the last block of epoch N - 1 before its cutoff, the recent window ends there, the reconstruction check passes with two implementations, the published 6.1 counts carry no case-wallet figure, the shapes land in the recent frame, and `own-drawn` reads the finished run. |
| T14 | Live-fire runs: a real nonce refused as the test h; a refused run under T10's run id leaves that run's tables; refused attempts are failed gate queries, never live-fire runs; a run kept for debugging, with plans, without its aggregate tables, then cleaned up; a run whose tables are dropped at the end; no count printed or stored; every start entry closed and the check log's chain intact. It runs last, since it replaces the study tables. |

Results go to `runs/preprod/<tag>/tests/`.

## Sizing a mainnet run

The heavy steps are `txo` (every output with a stake credential joined with `tx_in`) and `txo_asset` (that table joined with `ma_tx_out`); everything after them filters study tables on indexed columns, and the per-wallet steps run only for sampled and case wallets. `timings.json` holds each step's wall time and rows. `project` scales a preprod run's step times linearly by mainnet row counts over preprod row counts of each step's dominant table, both read with `health` (`pg_class` estimates, which may be read on mainnet before the freeze; each reading is logged in the check log); it reports the per-wallet steps at preprod size, since their cost follows the sample, and it understates sorts and hashes that spill to disk at mainnet size.

On preprod (23.9 million `tx_out` rows, 10.2 million of them with a stake credential, and 18.2 million of their asset rows), a full run took about 4.5 minutes, plus 36 seconds for the order check; the life table step alone took 92 seconds.

Run the heavy steps with a work memory of 1 to 2 GB, parallel workers, and `temp_tablespaces` on a disk with free space of at least twice the study tables' size; on preprod the study tables, with their indexes, took 0.63 of the bytes of `tx_out` (4.5 GB against 7.2 GB).

## Infrastructure

`infra/preprod/compose.yaml` is the compose file the preprod database ran under, with its data root replaced by `${DBSYNC_ROOT}`; substituting the root back gives the file as run. It names secret files by path and holds no secret. `infra/preprod/db-sync-config.json` is the db-sync configuration as run (SHA-256 `3ae03f2c13fffabfdede51babc08d9cc5c2bfa446c80ebbb0c5d6a6e2018d864`). The images are pinned by digest in the compose file: cardano-db-sync 13.7.2.1, cardano-node 11.0.1, PostgreSQL 17.2. On mainnet the db-sync configuration differs only in its network files and in `tx_cbor`, which is disabled there.

## License

The tool's code is licensed under Apache-2.0 (see `LICENSE`). This README is licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
