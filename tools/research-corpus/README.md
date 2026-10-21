# research-corpus

A command-line tool that draws the corpus of the UnFrack.It UTxO-management research from a cardano-db-sync database: the snapshot block, the two history windows, the frames and their exclusions, the draw, the random, ADA-only and purposive samples, the exploration and confirmation split, the prior-treated and franken flags, the per-wallet profile inputs, and the corpus manifest. It also reconstructs any wallet's UTxO set at any block and checks that reconstruction three ways.

It implements the sampling and UTxO-reconstruction rules of the study's pre-registration and produces the corpus manifest and samples, with their exploration and confirmation split. The SQL is the design; the Node driver supplies parameters, runs the steps, computes published identifiers and writes the run directory.

## Where it may run

- **Preprod**: anything, at any time. All development and every test of this tool runs there.
- **Mainnet, before the final freeze**: live-fire checks only (see "Live-fire checks" below): runs that confirm the code works on real data, with a stated test value of the draw key, that print, log and write no row count or population statistic, and that each add an entry to the check log.
- **Mainnet, after the final freeze**: the study's run. The driver checks the final freeze record and the code before it reads a wallet (see "The final freeze and the draw key").

On mainnet nothing given at run time may change the sample: `--set` is refused unless every value equals its hashed default, `--strata` unless the file's bytes are the hashed `data/strata-mainnet.json`, and `--snapshot` unless it is `tip`. Node must be the pinned major, 24. Plan capture under `EXPLAIN ANALYZE`, a stand-in for the freeze, and any HMAC key other than the study's own are refused.

Before anything else, every run reads db-sync's own bookkeeping (`meta`, `schema_version`, `extra_migrations`). A database whose extra migrations show `prune` or `bootstrap` has deleted the history the study needs and is refused. `tx_in` must hold rows whatever the configuration says (db-sync records the consumed configuration as `ConsumeTxOutPreviouslySet`; without `force_tx_in` it leaves `tx_in` empty and every output would read as unspent). Probes then check that db-sync inserted what the SQL reads, and refuse a database where any is missing: multi-asset outputs and mints, label-674 metadata in recent transactions, Plutus redeemers, inline datums in recent transactions, and epoch nonces. The session must have `standard_conforming_strings` on; parameters are written as `decode('<hex>', 'hex')`, which reads the same either way. The run then checks that block ids and transaction ids increase along the chain, which every transaction-id window relies on, and stops if they do not.

## Install

Node 24 is required (`engines` in `package.json`). From this folder:

```
npm ci
npm test
node src/cli.mjs help
```

The tool has its own `package.json` and lockfile and does not touch the app's dependencies, lint or build. Its one runtime dependency is `pg` (node-postgres). The unit tests also use `@electric-sql/pglite`, an in-process PostgreSQL, so they run the real SQL files with no database server and no chain data.

## The database

cardano-db-sync 13.7.2.1 with the core `tx_out` layout (`use_address_table` false), `tx_out` set to `enable`, and multi-asset, metadata, Plutus and ledger data inserted; never `prune`, `bootstrap` or `only_utxo`. The preprod configuration and compose file used to develop this tool are in `infra/preprod/`.

The tool connects as a role that can read schema `public` and owns schema `study`; it writes nothing to `public`. Its tables live in `study`. db-sync's own snapshots dump schema `public` only, so study tables never travel inside a db-sync snapshot.

Connection: `--host --port --database --user`, or `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`. The password comes from the file `PGPASSFILE` names (libpq's format, mode 0600). It is read when the connection opens and never printed or logged.

## Commands

| Command | What it does |
|---|---|
| `init-secret` | Creates `secret/hmac.key`, 32 random bytes, mode 0600. Prints its path, never the key. Refuses if the key exists. |
| `run --run-id <id> ...` | Runs every step and writes the run directory. A rerun with the same id resumes. |
| `verify-freeze --freeze-tx --hypotheses-tx --prereg --study-key` | Runs the final-freeze checks and prints each with its outcome, and the draw key once its epoch has started. Reads only. |
| `cleanup --run-id <id>` | Drops a live-fire run's study tables and work directory, and adds an entry to the check log saying when. Refuses any other run. |
| `check-log verify --network <n>` | Checks the check log's sequence and digest chain and lists live-fire runs whose output was kept and never cleaned up (exit 2 if either is found). |
| `check-log fix --network <n> --finding <text> --commit <sha> [--entry <seq>]` | Adds an entry naming a fix, the finding behind it and its commit. |
| `capture-strata [--out <file>] ...` | Reads CoinGecko's ranking and the token registry and writes the strata file's candidate list (see "The strata"). |
| `confirm-snapshot --run-id <id>` | Checks that the run's snapshot hash is still in the database once 2,160 more blocks exist (exit 2 if it is gone, 3 if it is too soon). |
| `a1 [--from-run <id>] [--stake <address> ...] [--node-stake <address> ...]` | Compares stake credentials' UTxO sets in the database at its tip with Koios and, for `--node-stake`, with the node's own query by address (`--node-container`, `--node-socket`, `--magic`). `--from-run` adds the first 20 credentials of a run's recent-frame draw order, the first 5 of them for the node (`--count`, `--node-count`). On mainnet it runs only as a live-fire check (`--live-fire --purpose <text>`, `--keep-for-debug`; the differing UTxO lines go to a work directory removed at the end unless kept, and the check log gets each credential's outcome as equal, explained or differs) or after the final freeze with the same freeze options as `run`. Koios is called on mainnet with the study's own token from `RESEARCH_CORPUS_KOIOS_TOKEN`, on test networks with none. |
| `health` | Table row estimates and sizes (`pg_class`), as JSON. Reads no chain data. |
| `project --timings <file> --preprod-rows <file> --mainnet-rows <file>` | Scales a preprod run's step times by mainnet row counts. |
| `hash` | SHA-256 of every hashed file, the pinned dependencies and the Node version. Also `npm run hash`. |

Options of `run`:

| Option | Meaning |
|---|---|
| `--snapshot tip` or `<block hash>` | The snapshot block. The default, `tip`, is the database tip when the run starts; stop db-sync there first so the database is that block's state. A resumed run keeps the block it recorded. Mainnet: `tip` only. |
| `--freeze-tx <hash>` | The final freeze transaction (A0). h, the draw's key, is the epoch nonce its block's epoch rule names. |
| `--hypotheses-tx <hash>` | The hypotheses freeze transaction, which the final pre-registration cites. |
| `--prereg <file>` | The final pre-registration, byte for byte as frozen. |
| `--study-key <hex>` | The freeze identity's 32-byte signing public key. |
| `--code-manifest <file>` | Mainnet: the `npm run hash` output frozen with the final freeze. Every file of the code must match it, path by path. |
| `--stand-in-tx <hash>` | Test networks only: a transaction whose block's epoch rule stands in for the freeze's. |
| `--live-fire`, `--test-h <hex>`, `--purpose <text>` | A pre-freeze check run with a stated test value of h (32 bytes), on any network. |
| `--keep-for-debug` | Live-fire only: keep the run's study tables after it ends; `cleanup` drops them later. |
| `--explain` | Plans every explainable statement with plain `EXPLAIN (FORMAT JSON)` before running it, and keeps the plans with every row estimate, width and cost removed. |
| `--strata <file>` | The strata list (default `data/strata-mainnet.json`; on mainnet that file only). |
| `--consented <file>` | A private file of bech32 stake addresses, one per line (`#` starts a comment), removed from every frame. Never commit it. |
| `--case <stake address>`, `--cases <file>` | Case wallets: the per-wallet steps also run for them, without sampling them. Only the wallets named here are case wallets, and each must also be in the consented file; the run refuses otherwise. `--cases` takes the consented file's format. |
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
  params.json                   snapshot, freeze records and the draw key, windows and tx-id bounds, settings, consented count, code version
  report.json                   every count: flow tables, draw, strata and the fungible floor, split, flags, the reconstruction check, profiles, era report
  timings.json                  wall time and rows of every step and statement, with plans when captured
  manifest.json                 the corpus manifest
  raw/sample.csv                the samples with stake addresses, without published identifiers
```

A live-fire run's directory holds only `live-fire.json` (its check-log entry) and, with `--explain`, `plans.json`.

The manifest holds the snapshot block (height, hash, time), the final and hypotheses freeze records with the draw key and both readings of it, the windows, the flow tables, the draw summary, the strata list with its parts and counts, the fungible floor's candidates with their holder counts, each sample's bound (below), the reconstruction check counts, the split over all sampled credentials, the code version, and per frame and sample the published identifiers with their split. A published identifier is HMAC-SHA256 under the study key over the credential's 29-byte reward address, truncated to 16 hex characters; the key never reaches PostgreSQL. Identifiers are sorted within each sample, so the manifest does not carry the draw order. It names no stake address or address, and no transaction hash but the two freeze records'. `raw/` names stake addresses and stays private; it carries no published identifier (one can be recomputed while the key exists), so destroying the key at publication leaves nothing that links an identifier to an address.

The consented keys are never written to the run directory; only their count is, with how many of them would have fallen inside each sample's drawn prefix had they not been removed. Each sample also has a published bound: the draw key of the last wallet it took and the number of consented keys of the sample's kind at or below it (for a stratum, consented keys holding its assets). A reproduction that takes every eligible key of the kind up to the bound differs from the published sample by at most that number.

## Steps

Each step runs in one transaction with its row in `study.step` (run id, name, start, finish, rows) and a comment naming the run on every table it builds. A rerun skips finished steps whose tables still carry the run's mark; once one step is recomputed, every later step is too. A failed step leaves nothing behind.

| Step | File | Builds |
|---|---|---|
| (precondition) | `00-study-schema.sql` | order check; `study.run`, `study.param`, `study.step`; T(B) helpers |
| `epoch_counts`, `peak_runs` | `05-03-windows.sql` | transactions per epoch (all, phase-2-valid, the `epoch` view's count); 73-epoch runs since the Mary hard fork, ranked |
| `era_report` | `05-03-windows.sql` | fee, minimum-UTxO (Mary's `min_utxo_value`, then coins per UTxO word or byte), value-size and tx-size changes inside each window |
| `cred`, `consented_table` | `05-04-credentials.sql` | every stake credential with its header type and network tag, checked; the consented keys |
| `txo`, `txo_asset`, `asset` | `06-01-txo.sql` | the life table of every output with a stake credential; its assets; every asset's CIP-67 label |
| `activity` | `05-04-activity.sql` | receipts and spend events per window |
| `state`, `paycount` | `05-05-exclusions.sql` | UTxO count, lovelace, script-held lovelace, assets and payment credentials (all, and key credentials only) at the reference blocks |
| `frame`, `flow` | `05-04-frames.sql` | both frames with every stage, the draw and split keys; the flow table |
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

- Block ids identify blocks. T(B) is the largest transaction id at or before block B. A window [B1, B2] is the transaction-id range [first id with `block_id >= B1`, T(B2)].
- The state at a window's start is the state as of the last block before its first block; at its end, as of its last block.
- A wallet's UTxO set at block B, from the life table: `created_tx <= T(B) AND (consumed_tx IS NULL OR consumed_tx > T(B))`.
- UTxOs carrying a datum or reference script, or at a script payment credential, are flagged as held and never removed.

### The UTxO set three ways

1. The reference query: the pattern of db-sync's own UTxO-at-block query (`cardano-db-tool utxo-set`), restricted to the wallet's credential. It reads db-sync's tables only.
2. The life table at T(B).
3. Read directly: the wallet's outputs with no consuming input at all, in a database stopped at the snapshot. It is defined at the tip only.

Each UTxO is compared as one line, `<tx hash>#<index>:<lovelace>:<policy>.<name>=<qty>,...` with assets sorted by bytes; a wallet's set as the count and MD5 of its sorted lines. Node builds the same line from Koios and from the node's query, so every comparison is exact.

## The final freeze and the draw key

The study's run on mainnet takes the final freeze transaction and checks, from the database, that it carries the study's final record, and refuses with every failed check named:

- its label-674 message is exactly the SHA-256 of the final pre-registration given with `--prereg` (CIP-20, "Specification");
- its label-309 value is a CIP-190 record (CIPs at merge commit 58b4dd1417, CIP-0190, "Metadata label 309 and the chunk-array transport", "Canonical CBOR"): the chunks, as db-sync stores them in `tx_metadata.bytes`, reassemble to a canonical body with `v` 1 and items, and the body is decoded strictly;
- the record's items include the pre-registration's digest and the digest of every file of this code (`npm run hash`), and the code's files match the code manifest given with `--code-manifest`;
- every signature verifies, and one is by the study key (CIP-190, "Signed payload and Sig_structure": Ed25519 over the RFC 9052 `Sig_structure` with the protected header as published and the bytes `cardano-poe-record-sig-v1` followed by the canonical record without `sigs`; "Signer-key identification", path 1: the key is the 32-byte protected `kid`), and the pre-registration names the key;
- the pre-registration cites the hypotheses record given with `--hypotheses-tx` by its CIP-0107 URI, `web+cardano://transaction/<hash>/metadata/309`, and that transaction is in an earlier block, carries a record signed by the same key, and has a different document. The hypotheses record is refused as the final one: its document cannot cite itself;
- the freeze block is at least 2,160 blocks below the snapshot.

h, the draw key, is the epoch nonce of epoch N. E is the epoch of the final freeze block; N is E + 1 if the block's slot is earlier than E's first slot plus the epoch length less the randomness stabilisation window, and E + 2 otherwise. The window is 4k/f slots in every Praos era except Babbage, which uses 3k/f (IntersectMBO/ouroboros-consensus, `ouroboros-consensus-cardano`, `Ouroboros/Consensus/Cardano/Node.hs`, `praosRandomnessStabilisationWindow` and `partialConsensusConfigBabbage`); the run refuses a freeze block before Conway (protocol major 9). On mainnet and preprod k is 2,160, f is 0.05 and an epoch is 432,000 slots, so the cutoff is 259,200 slots into the epoch. These constants are in `src/params.mjs` and are compared with Koios `/genesis`. The nonce is read from `epoch_param.nonce` and from Koios `/epoch_params`; the run refuses if N has not started in the database or the two readings differ. On a test network, `--stand-in-tx` applies the same rule to a stand-in transaction's block.

The draw and split keys are SHA-256 of the ASCII bytes `draw` (or `split`), then the 32 bytes of h, then the 28-byte stake credential (X5). A test vector, checked by the unit tests: h `8827df62e1c5f7909885b09cb156d6f1eca8b15eb793fa4758e95c8aa79a1d00` (preprod's epoch 320 nonce) and the credential `337b62cfff6403a06a3acbc34f8c46003c69fe79a3628cefa9c47251` (the stake key of CIP-19's test vectors) give the draw key `88977a462d379bd930e77accf1a8268456042de78447381c9b226cff74846b2c` and the split key `8a31ce172bafcb7ee867a64ccc8a6e0a4f24405d98bf739b74abbd939179d2a2`.

## Live-fire checks

Before the final freeze the study's code may run against mainnet to confirm it works, under a commitment that nothing such a run shows changes the pre-registration. `run --live-fire --test-h <hex> --purpose <text>` (and `a1 --live-fire --purpose <text>`) is that run:

- h is the stated test value, recorded in the log. The run refuses a value that is an epoch nonce or block hash of the chain, and refuses a database that already holds the study's run.
- Nothing counted is printed, logged or written. The step log names each step with its time and nothing else; `study.step` stores no row counts; no report, manifest, timings or raw list is written; error text is logged with its numbers replaced by `#`.
- `--explain` plans every statement with plain `EXPLAIN` first and keeps the plans with every row estimate, width and cost removed. `EXPLAIN ANALYZE` is refused.
- The run's study tables are the wallet-level output. They are dropped when the run ends, whether it succeeded or failed, unless `--keep-for-debug` is given; `cleanup --run-id <id>` drops kept tables later.
- Each run adds one entry to `check-log/<network>.jsonl`: the date, the command, the purpose, the test h, the code's commit, the outcome (succeeded or failed, with the error), the run time, each step's outcome and time, functional checks as true or false (the probes, the order check, the peak rule against its frozen value, the section 6.1 check, the profile spend counts), per-field parse coverage (the share of rows or epochs in which each field the code reads was present: reward addresses, payment credentials, the era parameters, label-674 JSON and its `msg` array), and whether the wallet-level output was deleted, with the time, or kept. `cleanup` and `check-log fix` add their own entries.

The log is JSON Lines: one object per line, UTF-8, LF, keys in a fixed order, appended and never rewritten. Each entry carries its sequence number and the SHA-256 of the file before it was appended, so `check-log verify` detects an edit to any earlier line. The final freeze hashes the mainnet log as it stands.

## The strata

The strata list has three parts, processed in this order, each part's strata skipping wallets already in the frame's random, ADA-only and earlier strata samples:

1. The named projects, always included: Clay Nation and SpaceBudz (NFT, by policy), NIGHT, IAG, HOSKY and SNEK (fungible, by policy and asset name).
2. Ten fungible tokens from the CoinGecko candidates, taken in rank order, skipping any held by fewer than 1,000 stake credentials and any that is also a named token, until ten qualify. "Held by a stake credential" counts the eligible wallets of the recent frame at the snapshot, held UTxOs included, as the NFT part does. The result is computed once and used for both frames; fewer than ten is recorded, not an error.
3. The ten NFT policies held by the most eligible wallets of the recent frame at the snapshot. A policy counts only if no asset of it ever had a running supply above one: the asset's mints less its burns, summed in chain order up to the snapshot, never exceeding 1 (a CIP-25 re-mint after a burn stays an NFT; an asset ever outstanding in two units does not). Inside such a policy an asset is non-fungible by the rule of section 6.2, so a label-333 or label-444 asset is not counted, and an NFT stratum of this part takes holders of the assets the ranking counted.

`data/strata-mainnet.json` holds parts 1 and 2: the named rows, the candidates in rank order with their policy, asset name and registry cross-check, every coin the capture excluded with the reason, and the provenance. `capture-strata` writes it on the freeze date:

- It reads CoinGecko's "Cardano Ecosystem" category ranked by market capitalization and records the endpoint, the response's `Date` header, the time it was read and the SHA-256 of the raw response, and the same for each coin's detail.
- It excludes ADA itself; stablecoins and bridged or wrapped assets, read as CoinGecko's own categories for the coin (any category whose name contains "stablecoin", "bridged" or "wrapped") or a coin id or name that says bridged or wrapped; coins with no Cardano native asset; the named tokens; and any coin named in an `--exclusions` file of rulings (coin id, reason, source) for cases the categories miss.
- It maps CoinGecko's Cardano contract to a policy and asset name: given as both, given as the policy alone (resolved to the one registry subject under the policy, or among several to the one whose ticker is the coin's symbol), or given as a CIP-14 fingerprint (resolved by computing the fingerprint of every registry subject).
- It cross-checks each candidate with the Cardano Foundation token registry (`github.com/cardano-foundation/cardano-token-registry`, `mappings/`, read at one recorded commit): the subject must have a mapping whose ticker is the coin's symbol or whose name is the coin's name. A candidate without one is excluded with the reason.
- It keeps the named rows from the current file (`--named-from` names another), takes each candidate's own-source note from `--own-sources` (a map from subject to text), and records in the provenance the policy ids Adam K. Dean confirmed on 2026-10-21: HOSKY, SNEK, WMTX and NVL.
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
| `x12_history` | true | Payment credentials are counted over the stake credential's history up to the reference block. false counts those present at it. The report also counts the stage-6 removals that would stay under the cap if only key payment credentials were counted. |
| `x13_all` | false | Franken flags consider key payment credentials only. true includes script credentials. |
| `x14_search_bytes` | true | Label-674 payloads db-sync could not decode as JSON are searched in their bytes and counted separately. |
| `x15_bech32` | false | The HMAC input is the 29-byte reward address. true uses its bech32 text. |
| `x17_invalid_is_script` | true | A phase-2-invalid transaction counts as executing a script. Native-script evaluation never does. |
| `x19_count_invalid` | true | Every transaction counts toward the peak window, phase-2-invalid included, as the `epoch` view and Koios count. The search begins at the first epoch whose `protocol_major` is 4 or more (the Mary hard fork; epoch 251 on mainnet), read from `epoch_param`, never an epoch number. |
| `x21_others_allowed` | true | The seven Evolution outputs are the transaction's only pure-ADA outputs at the wallet; other outputs are allowed. |

Readings with no setting, because no alternative changes the code: the guard counts eligible keys taken in draw order; only completed epochs before the snapshot's epoch can end the peak window. Two readings were decided on 2026-10-21 and are the only behavior. X11: the NFT ranking counts only policies whose assets never had a running supply above one (see "The strata"). X16: one exploration or confirmation label per stake credential, assigned once by ranking every sampled credential across all samples by its split key and taking the first floor(N/5) of the N distinct credentials as exploration, so a wallet in both frames has the same label in both and each sample is about, not exactly, 20% exploration.

The peak window may begin in Mary-era epochs (protocol major 4), before Alonzo. Their transactions have no redeemers, collateral, datums or reference scripts in db-sync and are valid, so every step reads them without special cases; the era report shows the Mary minimum-UTxO parameter (`min_utxo_value`) for those epochs and `coins_per_utxo_size` from Alonzo on, and no step compares an output with an era minimum.

The profiles are descriptive only. On 2026-10-21 they became data-driven: a clustering procedure, specified in research revision v0.3 and fitted on the exploration split, defines them. The fixed cut points above, the `profile` column and its three flags are kept as a descriptive field until v0.3 names the features and the procedure; nothing downstream should read them as the profile definition.

## Hashing

The extraction and sampling files are fixed on chain before any study query runs, because the code that draws the sample is part of what the freeze commits to. `npm run hash` prints the SHA-256 of every file under `src/`, `sql/` and `data/`, of `package.json` and `package-lock.json`, the pinned dependencies with their npm integrity, and the Node version. It refuses a file that is not UTF-8 with LF line endings and a final newline, or that has a byte-order mark. Tests, the README and `infra/` are not hashed. Its output, frozen with the final freeze, is the code manifest a mainnet run compares itself with; each listed digest must also be an item of the final freeze record.

`data/strata-mainnet.json` holds a dated capture; `capture-strata` writes it again on the freeze date, before hashing.

## Tests

`npm test` runs the unit tests: no database, no chain data. They cover the CIP-67 parser on the CIP's ten test vectors, the five registry prefixes and the CIP-68 asset names the preprod seeder generates for one of its test wallets; the classification rule; the draw and split digests from the SQL against Node's SHA-256 and against the published test vector; the frame stages, flow table, draw (the guard path and the path where all three targets are reached) and the one-label split on a small fixture; the peak search's Mary boundary; the NFT ranking (running supply, the per-wallet class, exclusions, the snapshot bound, the tie-break), the fungible floor, and the fill of every stratum against an independent statement of the rule; the final-freeze checks on records signed in the test (each refusal, the hypotheses record refused as final, a non-canonical body, an oversized chunk), the epoch rule and the draw key's two readings; the mainnet refusals through the pipeline with a stub database; the code manifest; the check log's chain and the plan stripping; `capture-strata` against a fake CoinGecko and registry, BLAKE2b against Node's and the CIP-14 vectors; A1's difference rule and CIP-19's pointer-address vectors; the Evolution fingerprint at and just beyond 0.2 percentage points; the franken flags; HMAC against a fixed key with values computed by OpenSSL; CIP-19 address decoding on the CIP's vectors; the SQL's canonical UTxO lines against Node's; and the statement splitter, the typed parameters and the hash list.

`test/integration/run-preprod.sh <tag>` runs the integration tests against a preprod database. Stop db-sync first so the tip stays at the snapshot, and start it again afterward. The seeded wallets of the preprod seeder (`tools/preprod-seeder`, draft pull request #9 in this repository) are the ground truth; the tests use only its `address` and `verify` commands and its deterministic shape generator, which touches no key.

| Test | What it checks |
|---|---|
| T1 | No block has `previous_id >= id`; transactions in (`block_id`, `block_index`) order are in id order. |
| T2 | Each shape's address maps to one stake credential, whose bech32 form and hash match the address's delegation part; one payment credential per shape. |
| T3 | The shapes at the snapshot match the seeder's specification: counts, lovelace and assets per UTxO under a one-to-one map of policies; nothing held; `verify` exits 0. |
| T4 | The rehearsal of the database check against independent sources: twenty credentials against Koios (preprod public tier, no token, 150 ms apart) and five against the node's `query utxo`, at the database tip, with every later transaction listed; a line found only in the database counts as explained only if a later transaction spends that input, and pointer addresses are left out of the node comparison. |
| T5 | Every transaction that touched each shape is one of the seeder's, with the expected outputs, burns and payers. |
| T6 | Each shape's state before and at every block of its history. |
| T7 | The reference query and the life table agree at every T6 block, the three implementations agree at the snapshot, and both agree with `cardano-db-tool utxo-set` at three slots. |
| T8 | The reference query and the life table agree for 1,000 credentials at 20 blocks. |
| T9 | Five phase-2-invalid transactions: their `tx_in` rows are the collateral inputs of their own CBOR (which Koios serves byte for byte), their body inputs are not spent by them, and the collateral return is the output at the index equal to the number of body outputs. |
| T10 | Two full runs with a guard of 1,000 and h from the stand-in's epoch rule: the flow table adds up, the consented keys are removed and are the case wallets, the shapes land where they should, no franken flag on them, the fungible floor and the one-label split follow their rules, the reconstruction check passes with the direct read, and the two runs build identical tables and manifests. |
| T11 | The label-674 UnFrack.It messages on preprod, and no seeder transaction among them. |
| T12 | The first T10 run captures every step's plan, time and rows. |
| T13 | The freeze checks on the freeze tool's preprod rehearsal records (`RESEARCH_CORPUS_REHEARSAL_DIR`): every record reassembles, is canonical and verifies under the rehearsal key; the typed freeze, checked as final with the core-only freeze as its hypotheses record, passes every record check and is refused for what a rehearsal cannot meet (its placeholder document cites no hypotheses record, and its items are not this code); the draw key's epoch rule is applied to its block. |
| T14 | Live-fire runs: a real nonce refused as the test h; a run kept for debugging, with plans, then cleaned up; a run whose tables are dropped at the end; no count printed or stored; the check log's chain intact. It runs last, since it replaces the study tables. |

Results go to `runs/preprod/<tag>/tests/`.

## Sizing a mainnet run

The heavy steps are `txo` (every output with a stake credential joined with `tx_in`) and `txo_asset` (that table joined with `ma_tx_out`); everything after them filters study tables on indexed columns, and the per-wallet steps run only for sampled and case wallets. `timings.json` holds each step's wall time and rows. `project` scales a preprod run's step times linearly by mainnet row counts over preprod row counts of each step's dominant table, both read with `health` (`pg_class` estimates, which may be read on mainnet before the freeze); it reports the per-wallet steps at preprod size, since their cost follows the sample, and it understates sorts and hashes that spill to disk at mainnet size.

On preprod (23.9 million `tx_out` rows, 10.2 million of them with a stake credential, and 18.2 million of their asset rows), a full run took about 4.5 minutes, plus 36 seconds for the order check; the life table step alone took 92 seconds.

Run the heavy steps with db-sync stopped (the snapshot requires it anyway), a work memory of 1 to 2 GB, parallel workers, and `temp_tablespaces` on a disk with free space of at least twice the study tables' size; on preprod the study tables, with their indexes, took 0.63 of the bytes of `tx_out` (4.5 GB against 7.2 GB).

## Infrastructure

`infra/preprod/compose.yaml` is the compose file the preprod database ran under, with its data root replaced by `${DBSYNC_ROOT}`; substituting the root back gives the file as run. It names secret files by path and holds no secret. `infra/preprod/db-sync-config.json` is the db-sync configuration as run (SHA-256 `3ae03f2c13fffabfdede51babc08d9cc5c2bfa446c80ebbb0c5d6a6e2018d864`). The images are pinned by digest in the compose file: cardano-db-sync 13.7.2.1, cardano-node 11.0.1, PostgreSQL 17.2. On mainnet the db-sync configuration differs only in its network files and in `tx_cbor`, which is disabled there.

## License

The tool's code is licensed under Apache-2.0 (see `LICENSE`). This README is licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
