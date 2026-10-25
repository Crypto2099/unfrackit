# research-sim

The downstream simulator of the UnFrack.It UTxO-management research. This folder holds its history reader: a command-line tool that turns a cardano-db-sync database into the simulator's inputs, for given wallets and windows. For each wallet (a stake credential) and window it writes one history file. The file holds the wallet's UTxO set at the window's start, then every event of the window in chain order: deposits, held UTxOs consumed, spends with their intents, self-reorganizations, and 30-day marks. The tool also writes a wallet's state at the snapshot block, and computes the census, near-cap and collateral quantities and the battery pools as separate commands.

A few terms recur below. The extraction is the study's sampling tool in this repository, `tools/research-corpus`; it builds its tables in a database schema named `study`. A frame is the window a wallet was sampled for: `recent` (the 365 days ending at the snapshot block) or `peak` (the busiest 73 epochs since the Mary hard fork). Every sampled wallet is in one split: exploration, which may be read at any time, or confirmation, which is read only after the study's analysis scripts are frozen on chain. The treatment is the code under test, UnFrack.It's planner and selection rule; its files are published with the study's archive, not in this repository.

## Where it may run

- **Preprod**: anything, at any time, through a read-only role. All development and every test of the reader runs there.
- **Mainnet**: refused. Every command that connects reads db-sync's `meta` table first and stops on a mainnet database. The mainnet code paths, such as the ImmutableDB byte source below, are implemented and tested against preprod's own node; no command in this release runs them on mainnet. `EXPLAIN ANALYZE` executes its query, so the code refuses it on mainnet as well; plain `EXPLAIN` is allowed everywhere.

## Install

Node 24 is required (`engines` in `package.json`). From this folder:

```
npm ci
npm test
node src/cli.mjs help
```

The tool has its own `package.json` and lockfile. Its one runtime dependency is `pg` (node-postgres) 8.23.0, pinned with its npm integrity.

cardano-serialization-lib (CSL) comes only through the treatment's `cslkit.mjs`, so that the reader, the treatment and every adapter share one CSL instance. `--treatment <dir>` names the directory holding the treatment's files, and `--treatment-pins <file>` a list of their SHA-256 digests, one `<64 hex><two spaces><file name>` per line. Before anything is imported, every listed file's digest is compared with the file in that directory, and any difference refuses the load, naming the file. The `history` and `census` commands need both options.

## The database

cardano-db-sync 13.7 with the core `tx_out` layout, `tx_out` values enabled, and multi-asset, metadata, Plutus and ledger data inserted; never `prune`, `bootstrap` or `only_utxo`. The queries read schema `public`, and the extraction's `study` tables when the role can read them (its samples with their split and reconstruction-check exclusion, its franken flags, and its life table). Each filters on an indexed column, except the chain-wide collateral measurement and the epoch boundaries of the near-cap command, which read their tables in one pass each. Nothing is created anywhere.

Connection: `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`. The password comes from the file `PGPASSFILE` names (libpq's format, mode 0600). It is read when the connection opens and never printed or logged. Every session is read only.

## Transaction bytes

Every spend's intent is read from the transaction's own bytes:

- `tx_cbor` (the default on a test network): db-sync's `tx_cbor` table, kept when db-sync runs with its `tx_cbor` option on.
- `immutable` (the mainnet source): the node's ImmutableDB chunk files, read without modification, locally or over SSH with `cat`, `stat` and `dd` (`--bytes immutable --immutable-dir <dir> [--immutable-host <host>]`). Each block is found through its chunk's secondary index and checked against the index entry's CRC-32. Each transaction is reassembled from the block's body, witness-set, validity and auxiliary-data segments with their original bytes.

The on-disk format is read from `IntersectMBO/ouroboros-consensus` at commit a0e8f68afeac411fcc8262f9271438314a87ed02: `ImmutableDB/Impl/Util.hs`, `Impl/Index/Secondary.hs` and `Chunks/Internal.hs`, and the era envelope in `ouroboros-consensus-cardano`, `Cardano/Node.hs` (`encodeDiskHfcBlock`). Every ledger path below is in `IntersectMBO/cardano-ledger` at commit 391db20866113f08bc6317cb5c341304365986c6; the block layout is the Conway CDDL's (`eras/conway/impl/cddl/data/conway.cddl:8-14`).

Every transaction read from either source must hash to db-sync's transaction hash (BLAKE2b-256 of its body bytes) and have the size db-sync records, the ledger's size: the length of `[body, witnesses, auxiliary data or null]`, which leaves out the validity flag from Alonzo on (`eras/alonzo/impl/src/Cardano/Ledger/Alonzo/Tx.hs:377-385` and `:482-496`). A mismatch stops the read with the transaction named.

## Commands

| Command | What it does |
|---|---|
| `history --run-id <id> (--wallet <id or stake address>... \| --wallets <file> \| --from-study random\|all) --window <w>...` | History files for each wallet and window. `<w>` is `recent`, `peak`, `snapshot` (the state at the snapshot, no events) or `blocks:<first id>-<last id>` (a test window). |
| `census --run-id <id> (--wallets <file> \| --from-study \| --all-wallets)` | Per wallet at the snapshot: UTxO count, the largest UTxO's value bytes, near-cap status, locked ADA and excess ADA. |
| `near-cap --run-id <id> (--wallets <file> \| --from-study \| --all-wallets)` | Per epoch boundary from the Mary hard fork to the snapshot: how many wallets have a largest UTxO above 50, 80 and 90 percent of the value-size limit in force. |
| `collateral --run-id <id>` | Over the recent window's script-executing transactions whose collateral inputs all sit at key addresses: the share under 20 ADA of collateral, the distribution of collateral coin, the share with a collateral return, the share of collateral inputs carrying tokens. |
| `battery-pools --run-id <id> --network <n>` | From a run's recent-window history files, the amounts of the pure-ADA payments (spend type T1) and the shares of a fungible's holding sent in fungible-token spends (T5). |
| `hash` | SHA-256 of every hashed file, the pinned dependencies and the Node version. Also `npm run hash`. |

Common options: `--expect-network <name>` refuses any other database; `--snapshot tip|<block hash>|<block id>` (default `tip`); `--extraction-run <params.json>` takes the snapshot and the windows from an extraction run of `tools/research-corpus` and checks them against the database; `--bytes`, `--immutable-dir`, `--immutable-host`; `--treatment`, `--treatment-pins`; `--set <name>=<value>` changes one of the settings listed under Settings; `--explain` keeps the plain `EXPLAIN` plan of the census and collateral queries; `--analysis-freeze-tx <hash>`, the mainnet transaction whose signed record freezes the analysis scripts; without it a confirmation-split wallet is refused, and with it the run records the hash.

`--from-study` reads the wallets from the extraction's `study` tables, when the role can read them: for `history`, its random sample (`--from-study random`) or every sampled wallet (`--from-study all`); for `census`, its eligible recent-frame wallets; for `near-cap`, the union of both random samples. A wallet the extraction's reconstruction check excluded is refused. `--all-wallets` takes every key stake credential with an output, for a test network.

## Outputs

Wallet-level data never enters the repository. Everything is written under `${XDG_DATA_HOME:-$HOME/.local/share}/unfrackit-research/sim/<network>/<run-id>/` (`RESEARCH_SIM_HOME` overrides the root), directories 0700 and files 0600:

```
history/<wallet>.<window>.jsonl   one wallet and window
history-run.json                  the run's snapshot, parameters, settings, byte source and per-file counts
census.jsonl, census-run.json     the census rows and the run's summary
near-cap.json                     near-cap counts per epoch boundary
collateral.json                   the collateral measurement
battery-pools.json                the T1 amounts and T5 shares
```

Files name wallets by db-sync's stake-credential id (`stake_address.id`); no stake address appears in them.

### History files

One JSON Lines file per wallet and window. Amounts are decimal strings; hashes, policies, names and CBOR lowercase hex; references `<transaction id>#<index>`.

1. `header`: the wallet, frame and split; the window's first and last blocks, its transaction-id range [`lo`, `hi`] and the transaction id of its start state; the snapshot; the snapshot epoch's protocol parameters; the franken-flagged payment credentials; the arrival table; the settings; the byte source and db-sync version.
2. `state`: the UTxO set as of the last block before the window's first block, as UTxO records.
3. Events in chain order:
   - `deposit`: the wallet outputs created by a transaction that is not the wallet's spend, as UTxO records;
   - `held-consumed`: the held wallet UTxOs consumed by a transaction that is not the wallet's spend;
   - `intent`: a spend and its intent;
   - `self-reorganization`: a spend with no requested output, no certificate, vote or proposal, no mint or burn and no script; counted and not replayed. It carries its implicit values, the held UTxOs it consumed, the net value it brought in from outside the wallet, and the observed wallet parts;
   - `mark`: every 30 days of block time from the window's first block, placed before the first event at or after its time.
4. `end`: the UTxO set's count and digest at the window's last block, and the event counts.

A UTxO record is `{ ref, cbor, address, cred, coin, assets, held, origin }`: `cbor` is the CIP-30 `TransactionUnspentOutput` (CIP-0030, "TransactionUnspentOutput": `[input, output]`), `cred` the payment credential, `assets` `[{ policy, name, qty }]` sorted by policy then name bytes, `held` the reason the UTxO is held (`script-payment`, `datum`, `reference-script` or `franken`) or null, `origin` `initial` or `deposit`. The output inside `cbor` is re-encoded from db-sync's columns on every network, so that preprod runs the code mainnet runs. The address bytes come from its text and the value takes the ledger's serialization. A datum is its hash or the inline datum's bytes. A reference script comes from db-sync's script bytes, or, for a native script, whose bytes db-sync does not keep, from its creating transaction's bytes. db-sync does not record whether the original output used the array or the map form, so the re-encoding uses the map form only when an inline datum or a reference script needs it; its content always equals the original's.

An intent is `{ id, source, type, time, requested, implicit, fixed, collateral, invalid, burst, observed, classes, derived }`:

- `time`: slot, block time (Unix seconds), index in the block, epoch, block number.
- `requested`: `[{ cbor, address, coin, assets, datum, scriptRef, raised, index, wallet, scriptPayment }]`, with `from` and `inflow` on a requested wallet output built from an inflow. `raised` is null or `{ from, to, rule, original }`.
- `implicit`: `{ withdrawals, refunds, deposits, donation, mint, burn }`.
- `fixed`: null, or `{ inputs, referenceInputs, body, witnesses, redeemers, auxiliaryData, scriptFee, fixedBytes, refScriptBytes }`. `inputs` and `referenceInputs` are `[{ ref, cbor }]`, a held wallet input carrying `held` and, at a key payment credential, `walletKey`; `body` maps Conway CDDL body field numbers to CBOR; `witnesses` maps witness-set keys to CBOR; a redeemer is `{ tag, target, data, exUnits }`.
- `collateral`: `{ required, observed }`, `observed` null or `{ inputs, return, total }`.
- `invalid`: null, or for a phase-2-invalid transaction `{ forfeit, heldConsumed }`.
- `burst`: null or `{ id, parallel, index }`.
- `observed`: `{ tx, size, fee, epoch, protocolMajor, minFeeA, minFeeB, walletInputs, walletOutputs, walletWitnesses }`.
- `classes`: each asset of the transaction's wallet inputs, outputs and requested outputs, `FT` or `NFT`.
- `derived`: null, or the pool deposits taken from db-sync's net deposit.

## The rules this code implements

A wallet is a stake credential. Its outputs are those db-sync gives its `stake_address_id`: outputs at base addresses with its stake credential, whatever their payment credential, and outputs at pointer addresses created before Conway (CIP-0019, "Delegation part" and "Pointers"). Byron outputs never belong to a wallet. A wallet's UTxO set at transaction id T is every output created at or before T and not consumed at or before T, read from the wallet's own rows. Before a wallet is read, that set at the snapshot is compared with db-sync's own UTxO-at-block pattern restricted to the wallet, and a wallet whose two sets differ is refused.

Held UTxOs are kept and flagged, never offered to a selector: a UTxO at a script payment credential, one carrying a datum or a reference script, and one at a franken-flagged payment credential. Anyone can create an output that pairs their own payment key with another wallet's stake credential (CIP-0019, "Delegation part"), so such a credential may not be the wallet's; the study calls these franken addresses. In a wallet with two or more key payment credentials, a credential is flagged if it never appears as an input in a transaction that also spends another of the wallet's key payment credentials. The rule reads the wallet's whole history up to the snapshot, and flags nothing in a wallet where no pair of credentials co-spends.

A spend event is a transaction that consumes a wallet output at a key payment credential. Its intent:

- **Requested outputs.** Every output to another stake credential, and every wallet output at a script payment credential or carrying a datum or a reference script, as observed. From the wallet's other outputs, the net inflow of each native asset that did not come from a wallet input (it came from a non-wallet input or a mint) becomes requested wallet outputs at their minimum, each at the address of the observed output that received it. Every other wallet output is change. A requested output whose coin is below the minimum at the snapshot (CSL's `min_ada_for_output` at the snapshot's coins per UTxO byte) is raised to it, the raise recorded with the minimum-UTxO rule of its transaction's era: Mary (protocol major 4 and below), Alonzo (5 and 6), or Babbage and Conway (7 on).
- **Implicit values.** Withdrawals, refunds, deposits, the treasury donation, mints and burns, read from the transaction's fields and checked against db-sync's `withdrawal`, `tx.deposit`, `ma_tx_mint` and `tx.treasury_donation`. Deposits follow each certificate's rule in the Conway CDDL (`conway.cddl:30-48`, `:429-540`): a Shelley-era registration or deregistration at the epoch's key deposit, Conway's registration and deregistration certificates and DRep certificates with their stated coin, and proposals with theirs. A pool registration pays the pool deposit only when the pool is new, which the bytes do not say; its deposit is the remainder of db-sync's net deposit, which must be a whole number of pool deposits.
- **Fixed parts**, each as its original bytes:
  - non-wallet inputs and held wallet inputs, with their resolved outputs, and reference inputs;
  - every body field except the inputs, outputs and fee, the two hashes a builder recomputes (7 and 11), and collateral (13, 16 and 17);
  - the witness-set entries other than the wallet's own payment-key witnesses;
  - the redeemers, each with the item it points at, resolved in the ledger's order: inputs by transaction id then index, policies by bytes, reward accounts by network then credential (a script credential before a key) then hash, voters by kind (committee, DRep, pool) then credential, certificates and proposals as listed;
  - the auxiliary data.

  The script fee is the execution term `ceiling(priceMem * mem + priceStep * steps)` (`libs/cardano-ledger-core/src/Cardano/Ledger/Plutus/ExUnits.hs:198-203`) plus the Conway reference-script term, both under the snapshot's parameters. The reference-script term's price per byte grows by 1.2 for every further 25,600 bytes (`eras/conway/impl/src/Cardano/Ledger/Conway/Tx.hs:105-145`), over the reference scripts of the inputs and reference inputs (`eras/conway/impl/src/Cardano/Ledger/Conway/UTxO.hs:149-171`). The bytes of the fixed parts are the observed size less the size of the same transaction with them removed.
- **Collateral** is required when the transaction carries a redeemer or is phase-2-invalid; the observed collateral is kept for reporting. A phase-2-invalid transaction is an intent whose only effect is the loss of its total collateral.
- **Spend type**, in this order: T6 script execution (a Plutus redeemer, or phase-2-invalid; native scripts never count), T8 mint or burn, T7 certificate or governance, T5 fungible tokens sent, T4 NFTs of several policies, T3 several NFTs of one policy, T2 one NFT, T1 pure-ADA payment. An asset's class: a valid CIP-67 label decides (333 and 444 fungible; 222, 100 and 500 non-fungible unless more than one unit is held), otherwise more than one unit makes it fungible (CIP-0067, "Specification"; CIP-0068, "Labels", "333 FT Standard", "444 RFT Standard"). The units are the largest of the wallet's holding at the window's start, at its end, and the units the transaction moved.

Every intent is checked before it is written. db-sync's consumed inputs (the body inputs, or the collateral inputs of a phase-2-invalid transaction) and its outputs must be the transaction's. Coin and every asset must be conserved with the implicit values. The transaction rebuilt from the intent's parts and the observed wallet inputs, change and witnesses, each part's original bytes, must have the transaction's exact body hash and size. Before a history file is complete, its observed events replayed from the start state must reach the wallet's UTxO set at the window's end. Any failure stops the run with the transaction named.

A burst is a maximal run of the wallet's spends with no more than 60 seconds between consecutive block times. It is chained if any of its transactions spends an output of an earlier transaction of the same burst, transactions in one block ordered by their index; parallel otherwise.

For every asset held at a window's start, the arrival table names the transaction in which it first entered one of the wallet's outputs over the whole history, or the creating transaction of the UTxO holding it, flagged, when none is found.

The census measures value bytes as the ledger's serialization of the Value (`eras/alonzo/impl/src/Cardano/Ledger/Alonzo/Rules/Utxo.hs:425-447`) and a UTxO's minimum with CSL on the output re-encoded from db-sync's columns. The value-size limit in force is `max_val_size` from Alonzo on, and the Mary era's 4,000-byte constant before it (`eras/allegra/impl/src/Cardano/Ledger/Allegra/Rules/Utxo.hs:249-264`).

## Settings

Where a rule admits more than one reading, the reading is a named setting whose default is the reading this code uses; `--set` changes it, and the value is recorded in every history file's header. A value that is not implemented is refused.

| Setting | Default | Meaning |
|---|---|---|
| `requested` | `a` | Requested outputs as observed, plus the inflow of native assets as requested wallet outputs. `c`: outputs to other stake credentials only. |
| `heldConsumed` | `a` | A held UTxO leaves the state when any transaction consumes it; consumed by the wallet's own spend, it is a fixed input. `b`: held UTxOs never leave. |
| `mainnetBytes` | `immutable-db` | Mainnet transaction bytes come from the node's ImmutableDB. |
| `scriptFee` | `snapshot` | Both script-fee terms under the snapshot's parameters, once per intent. |
| `fixedBytes` | `per-intent` | The bytes of the fixed parts, once per intent. |
| `phase2Invalid` | `forfeit` | A phase-2-invalid spend forfeits its collateral. `skip`: not written. |
| `assetClass` | `profile` | Units for an asset's class: the largest of the holdings at the window's start and end and the units moved. `at-spend`: the holding just before the spend. |
| `valueBytes` | `ledger` | Value bytes by the ledger's serialization. |
| `inflowIncludesAda` | `false` | ADA inflow reaches the change through the implicit input and is not a requested output. |
| `typeAssets` | `outflow` | Spend types read the requested outputs other than inflow outputs, or the inflow outputs when there is no other. |
| `t5ScriptOrders` | `contents` | A requested output at a script address makes a spend T5 only when it carries a fungible token. `any-script-output`: whatever it carries. |
| `burstMinSpends` | `2` | A lone spend carries no burst. |
| `burstGapSeconds` | `60` | The burst gap. |
| `markSeconds`, `markBeforeTies` | 30 days, `true` | The mark interval, and whether a mark at an event's exact time comes first. |
| `outputForm` | `auto` | A UTxO re-encoded from db-sync's columns takes the map form when an inline datum or a reference script needs it, the array form otherwise. |
| `chunkSlots` | `21600` | ImmutableDB chunk size in slots. |

## Hashing

`npm run hash` prints the SHA-256 of every file under `src/`, `sql/` and `data/` and of `package.json` and `package-lock.json`, the pinned dependencies with their npm integrity, and the Node version, in the format of the extraction tool's code manifest. It refuses a file that is not UTF-8 with LF line endings and a final newline, or that has a byte-order mark. Tests and the README are not hashed.

## Tests

`npm test` runs the unit tests: no database and no chain data. They cover CBOR spans and encoders, BLAKE2b against Node's 64-byte digest and known 32-byte digests, CIP-19's address vectors, Base58, CIP-67's ten test vectors and the five registry prefixes, the classification rule, value sizes against the ledger encoding over random values, both output forms with datums and reference scripts, transactions of both era layouts with their size rule, redeemers in both forms, the ImmutableDB format on a constructed chunk (including a CRC-32 mismatch), parameters and both fee terms, bursts (a chained pair in one block, 59 and 61 seconds apart, a parallel burst), marks, the observed replay, spend types, asset classes, settings and the code manifest.

The intent tests build transactions with CSL, so they run when `RESEARCH_SIM_TREATMENT_DIR` and `RESEARCH_SIM_TREATMENT_PINS` name the treatment and its digests, and are skipped otherwise.

`npm run test:preprod` runs the integration tests against a preprod database, as of one snapshot block (`RESEARCH_SIM_SNAPSHOT`), since db-sync keeps following the chain while they run; their environment is described in `test/integration/history/env.mjs`. They cover:

- the reconstruction against the reference query, for the seeded wallets and 1,000 random wallets at 20 blocks;
- outputs re-encoded from db-sync's columns against their original bytes, by output form;
- the 17 seeded shapes against the preprod seeder's specification (`tools/preprod-seeder`, used through its `address` command and its deterministic generator only), and the shapes' own spends as intents;
- every spend of the seeder's funder and of 200 further wallets over the last 60 days, with the burst cases they contain;
- phase-2-invalid transactions;
- the ImmutableDB against `tx_cbor`, byte for byte, across every Shelley-based era;
- the census, near-cap and collateral commands, with their plans and run times.

Results go to `preprod/<RESEARCH_SIM_TEST_TAG>/tests/` under the output root.

## License

The tool's code is licensed under Apache-2.0 (see `LICENSE`). This README is licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
