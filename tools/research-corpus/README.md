# research-corpus

A command-line tool that draws the corpus of the UnFrack.It UTxO-management research from a cardano-db-sync database: the snapshot block, the two history windows, the frames and their exclusions, the draw, the random, ADA-only and purposive samples, the exploration and confirmation split, the prior-treated and franken flags, the per-wallet profile inputs, and the corpus manifest. It also reconstructs any wallet's UTxO set at any block and checks that reconstruction three ways.

It implements the sampling and UTxO-reconstruction rules of the study's pre-registration and produces the corpus manifest and samples, with their exploration and confirmation split. The SQL is the design; the Node driver supplies parameters, runs the steps, computes published identifiers and writes the run directory.

## Where it may run

- **Preprod**: anything, at any time. All development and every test of this tool runs there.
- **Mainnet**: nothing before the freeze transaction is on chain. The driver refuses a mainnet database unless it is given the freeze transaction's hash, finds that transaction's block in the database, and the snapshot block's height is greater. It refuses plan capture (`EXPLAIN`, which reads planner statistics) on mainnet, a stand-in for the freeze block, and any HMAC key other than the study's own.

Before anything else, every run reads db-sync's own bookkeeping (`meta`, `schema_version`, `extra_migrations`). A database whose extra migrations show `prune` or `bootstrap` has deleted the history the study needs and is refused; with `consumed`, `tx_in` must still be populated. The run then checks that block ids and transaction ids increase along the chain, which every transaction-id window relies on, and stops if they do not.

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
| `confirm-snapshot --run-id <id>` | Checks that the run's snapshot hash is still in the database once 2,160 more blocks exist (exit 2 if it is gone, 3 if it is too soon). |
| `a1 [--from-run <id>] [--stake <address> ...] [--node-stake <address> ...]` | Compares stake credentials' UTxO sets in the database at its tip with Koios and, for `--node-stake`, with the node's own query by address (`--node-container`, `--node-socket`, `--magic`). `--from-run` adds the first 20 credentials of a run's recent-frame draw order, the first 5 of them for the node (`--count`, `--node-count`). On mainnet, Koios is called with the study's own token from `RESEARCH_CORPUS_KOIOS_TOKEN`; on test networks with none. |
| `health` | Table row estimates and sizes (`pg_class`), as JSON. Reads no chain data. |
| `project --timings <file> --preprod-rows <file> --mainnet-rows <file>` | Scales a preprod run's step times by mainnet row counts. |
| `hash` | SHA-256 of every hashed file, the pinned dependencies and the Node version. Also `npm run hash`. |

Options of `run`:

| Option | Meaning |
|---|---|
| `--snapshot tip` or `<block hash>` | The snapshot block. The default, `tip`, is the database tip when the run starts; stop db-sync there first so the database is that block's state. A resumed run keeps the block it recorded. |
| `--freeze-tx <hash>` | Mainnet: the freeze transaction. h, the draw's key, is the hash of its block. |
| `--stand-in-tx <hash>` | Test networks only: a transaction whose block hash stands in for h. |
| `--strata <file>` | The purposive strata list (default `data/strata-mainnet.json`). |
| `--consented <file>` | A private file of bech32 stake addresses, one per line, removed from every frame. Never commit it. |
| `--case <stake address>` | Also runs the per-wallet steps for this wallet without sampling it. The consented keys are case wallets automatically. |
| `--hmac-key <file>` | Test networks only: an HMAC key other than `secret/hmac.key`. |
| `--set name=value` | Overrides a setting. A resumed run must use the settings it started with. |
| `--redo <step>` or `all` | Recomputes a step and every step after it. |
| `--capture` | Runs every explainable statement under `EXPLAIN (ANALYZE, BUFFERS)` and keeps the plans. Refused on mainnet. |
| `--expect-network <name>` | Refuses any other database. |
| `--work-mem`, `--maintenance-work-mem`, `--parallel-workers`, `--temp-tablespaces` | Session settings for the heavy steps (defaults 1GB, 1GB, 4, the server's). |

## Outputs

Data never enters the repository. Everything is written under `${XDG_DATA_HOME:-$HOME/.local/share}/unfrackit-research/` (`RESEARCH_CORPUS_HOME` overrides it), directories 0700 and files 0600:

```
secret/hmac.key                 the study's HMAC key (init-secret)
runs/<network>/<run-id>/
  params.json                   snapshot, freeze block and h, windows and tx-id bounds, settings, consented count, code version
  report.json                   every count: flow tables, draw, strata, split, flags, the reconstruction check, profiles, era report
  timings.json                  wall time and rows of every step and statement, with plans when captured
  manifest.json                 the corpus manifest
  raw/sample.csv                the samples with stake addresses and identifiers
```

The manifest holds the snapshot block (height, hash, time), the freeze block, the windows, the flow tables, the draw summary, the strata list with its counts, the reconstruction check counts, the code version, and per frame and sample the published identifiers with their split. A published identifier is HMAC-SHA256 under the study key over the credential's 29-byte reward address, truncated to 16 hex characters; the key never reaches PostgreSQL. Identifiers are sorted within each sample, so the manifest does not carry the draw order. It names no stake address, address or transaction hash. `raw/` does, and stays private.

The consented keys are never written to the run directory; only their count is, with how many of them would have fallen inside each sample's drawn prefix had they not been removed, so an outsider's reproduction of the draw can differ only by those keys.

## Steps

Each step runs in one transaction with its row in `study.step` (run id, name, start, finish, rows) and a comment naming the run on every table it builds. A rerun skips finished steps whose tables still carry the run's mark; once one step is recomputed, every later step is too. A failed step leaves nothing behind.

| Step | File | Builds |
|---|---|---|
| (precondition) | `00-study-schema.sql` | order check; `study.run`, `study.param`, `study.step`; T(B) helpers |
| `epoch_counts`, `peak_runs` | `05-03-windows.sql` | transactions per epoch (all, phase-2-valid, the `epoch` view's count); 73-epoch runs since Alonzo, ranked |
| `era_report` | `05-03-windows.sql` | fee, coins-per-UTxO, value-size and tx-size changes inside each window |
| `cred`, `consented_table` | `05-04-credentials.sql` | every stake credential with its header type and network tag, checked; the consented keys |
| `txo`, `txo_asset`, `asset` | `06-01-txo.sql` | the life table of every output with a stake credential; its assets; every asset's CIP-67 label |
| `activity` | `05-04-activity.sql` | receipts and spend events per window |
| `state`, `paycount` | `05-05-exclusions.sql` | UTxO count, lovelace, script-held lovelace, assets and payment credentials at the reference blocks |
| `frame`, `flow` | `05-04-frames.sql` | both frames with every stage, the draw and split keys; the flow table |
| `draw` | `05-04-draw.sql` | draw order with running counts; the stopping points; the random and ADA-only samples |
| `strata_list_table`, `nft_top`, `strata` | `05-04-strata.sql` | the strata list, the frozen NFT query's ten policies, the strata samples |
| `split`, `sample_wallets` | `05-08-split.sql` | exploration and confirmation per sample; the sampled and case wallets |
| `unfrackit_tx`, `prior_flags` | `05-06-prior-treated.sql` | label-674 UnFrack.It messages; UnFrack.It and Evolution flags per wallet |
| `franken` | `05-05-franken.sql` | franken flags per payment credential |
| `check_61_table` | `06-01-check.sql` | the three-way check of every sampled wallet at the snapshot |
| `script_tx`, `profile` | `05-09-profile-inputs.sql` | spends, market interactions (DEX, marketplace, other), holdings, profile and flags |

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

## Settings

The numbers the pre-registration fixes (73 epochs, 365 days, the guard of 200,000, the targets 2,400, 1,000 and 600, the 1,200 ADA-only wallets, 50 per stratum, ten NFT policies, the exclusion caps 20,000 UTxOs, 200 payment credentials and half the value, the profile cut points) are fixed settings in `src/params.mjs`.

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
| `x11_supply` | false | The NFT query classes assets per wallet, so a fungible held as one unit counts as an NFT. true also drops policies with an asset minted above one unit. |
| `x12_history` | true | Payment credentials are counted over the stake credential's history up to the reference block. false counts those present at it. |
| `x13_all` | false | Franken flags consider key payment credentials only. true includes script credentials. |
| `x14_search_bytes` | true | Label-674 payloads db-sync could not decode as JSON are searched in their bytes and counted separately. |
| `x15_bech32` | false | The HMAC input is the 29-byte reward address. true uses its bech32 text. |
| `x17_invalid_is_script` | true | A phase-2-invalid transaction counts as executing a script. Native-script evaluation never does. |
| `x19_count_invalid` | true | Every transaction counts toward the peak window, phase-2-invalid included, as the `epoch` view and Koios count. |
| `x21_others_allowed` | true | The seven Evolution outputs are the transaction's only pure-ADA outputs at the wallet; other outputs are allowed. |

Readings with no setting, because no alternative changes the code: the guard counts eligible keys taken in draw order; the split takes the first floor(N/5) of each sample in split order as exploration; the Alonzo epoch is the first with `protocol_major` 5 or more; only completed epochs before the snapshot's epoch can end the peak window.

## Hashing

The extraction and sampling files are fixed on chain before any study query runs, because the code that draws the sample is part of what the freeze commits to. `npm run hash` prints the SHA-256 of every file under `src/`, `sql/` and `data/`, of `package.json` and `package-lock.json`, the pinned dependencies with their npm integrity, and the Node version. It refuses a file that is not UTF-8 with LF line endings and a final newline, or that has a byte-order mark. Tests, the README and `infra/` are not hashed.

`data/strata-mainnet.json` is the strata list as drafted, rows in table order; the frozen list replaces it before hashing.

## Tests

`npm test` runs the unit tests: no database, no chain data. They cover the CIP-67 parser on the CIP's ten test vectors, the five registry prefixes and the CIP-68 asset names the preprod seeder generates for one of its test wallets; the classification rule; the draw and split digests from the SQL against Node's SHA-256; the frame stages, flow table, draw and split on a small fixture; the Evolution fingerprint at and just beyond 0.2 percentage points; the franken flags; HMAC against a fixed key with values computed by OpenSSL; CIP-19 address decoding on the CIP's vectors; the SQL's canonical UTxO lines against Node's; and the statement splitter, the typed parameters and the hash list.

`test/integration/run-preprod.sh <tag>` runs the integration tests against a preprod database. Stop db-sync first so the tip stays at the snapshot, and start it again afterward. The seeded wallets of the preprod seeder (`tools/preprod-seeder`, draft pull request #9 in this repository) are the ground truth; the tests use only its `address` and `verify` commands and its deterministic shape generator, which touches no key.

| Test | What it checks |
|---|---|
| T1 | No block has `previous_id >= id`; transactions in (`block_id`, `block_index`) order are in id order. |
| T2 | Each shape's address maps to one stake credential, whose bech32 form and hash match the address's delegation part; one payment credential per shape. |
| T3 | The shapes at the snapshot match the seeder's specification: counts, lovelace and assets per UTxO under a one-to-one map of policies; nothing held; `verify` exits 0. |
| T4 | The rehearsal of the database check against independent sources: twenty credentials against Koios (preprod public tier, no token, 150 ms apart) and five against the node's `query utxo`, at the database tip, with every later transaction listed. |
| T5 | Every transaction that touched each shape is one of the seeder's, with the expected outputs, burns and payers. |
| T6 | Each shape's state before and at every block of its history. |
| T7 | The reference query and the life table agree at every T6 block, the three implementations agree at the snapshot, and both agree with `cardano-db-tool utxo-set` at three slots. |
| T8 | The reference query and the life table agree for 1,000 credentials at 20 blocks. |
| T9 | Five phase-2-invalid transactions: their `tx_in` rows are the collateral inputs of their own CBOR (which Koios serves byte for byte), their body inputs are not spent by them, and the collateral return is the output at the index equal to the number of body outputs. |
| T10 | Two full runs with a guard of 1,000: the flow table adds up, the shapes land where they should, no franken flag on them, the reconstruction check passes with the direct read, and the two runs build identical tables and manifests. |
| T11 | The label-674 UnFrack.It messages on preprod, and no seeder transaction among them. |
| T12 | The first T10 run captures every step's plan, time and rows. |

Results go to `runs/preprod/<tag>/tests/`.

## Sizing a mainnet run

The heavy steps are `txo` (every output with a stake credential joined with `tx_in`) and `txo_asset` (that table joined with `ma_tx_out`); everything after them filters study tables on indexed columns, and the per-wallet steps run only for sampled and case wallets. `timings.json` holds each step's wall time and rows. `project` scales a preprod run's step times linearly by mainnet row counts over preprod row counts of each step's dominant table, both read with `health` (`pg_class` estimates, which may be read on mainnet before the freeze); it reports the per-wallet steps at preprod size, since their cost follows the sample, and it understates sorts and hashes that spill to disk at mainnet size.

On preprod (23.9 million `tx_out` rows, 10.2 million of them with a stake credential, and 18.2 million of their asset rows), a full run took about 4.5 minutes, plus 36 seconds for the order check; the life table step alone took 92 seconds.

Run the heavy steps with db-sync stopped (the snapshot requires it anyway), a work memory of 1 to 2 GB, parallel workers, and `temp_tablespaces` on a disk with free space of at least twice the study tables' size; on preprod the study tables, with their indexes, took 0.63 of the bytes of `tx_out` (4.5 GB against 7.2 GB).

## Infrastructure

`infra/preprod/compose.yaml` is the compose file the preprod database ran under, with its data root replaced by `${DBSYNC_ROOT}`; substituting the root back gives the file as run. It names secret files by path and holds no secret. `infra/preprod/db-sync-config.json` is the db-sync configuration as run (SHA-256 `3ae03f2c13fffabfdede51babc08d9cc5c2bfa446c80ebbb0c5d6a6e2018d864`). The images are pinned by digest in the compose file: cardano-db-sync 13.7.2.1, cardano-node 11.0.1, PostgreSQL 17.2. On mainnet the db-sync configuration differs only in its network files and in `tx_cbor`, which is disabled there.

## License

The tool's code is licensed under Apache-2.0 (see `LICENSE`). This README is licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
