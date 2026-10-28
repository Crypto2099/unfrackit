# research-sim

The downstream simulator of the UnFrack.It UTxO-management research. This folder holds two parts of it.

The history reader turns a cardano-db-sync database into the simulator's inputs, for given wallets and windows. For each wallet (a stake credential) and window it writes one history file. The file holds the wallet's UTxO set at the window's start, then every event of the window in chain order: deposits, held UTxOs consumed, spends with their intents, self-reorganizations, and 30-day marks. The reader also writes a wallet's state at the snapshot block, and computes the census, near-cap and collateral quantities and the battery pools as separate commands.

The simulator core replays those histories and builds the batteries, offline: a ledger kit that assembles and checks transactions exactly, wallet states, a bridge to the treatment, the method contract every selector implements, the arms and their run plans, the replay engine, the batteries, and the synthetic shapes with their intent streams. It reads no database and no chain.

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

The tool has its own `package.json` and lockfile. Its runtime dependencies are `pg` (node-postgres) 8.23.0 and the baseline libraries listed under Baselines, each pinned with its npm integrity. `npm ci --ignore-scripts` installs the same tree without compiling `chacha-native`, an optional native dependency of `chacha` (which `@cardano-sdk/key-management` uses), and `chacha` then loads its JavaScript implementation; no adapter calls it.

cardano-serialization-lib (CSL) comes only through the treatment's `cslkit.mjs`, so that the reader, the treatment and every adapter share one CSL instance. `--treatment <dir>` names the directory holding the treatment's files, and `--treatment-pins <file>` a list of their SHA-256 digests, one `<64 hex><two spaces><file name>` per line. Before anything is imported, every listed file's digest is compared with the file in that directory, and any difference refuses the load, naming the file. The `history` and `census` commands need both options.

## The database

cardano-db-sync 13.7 with the core `tx_out` layout, `tx_out` values enabled, and multi-asset, metadata, Plutus and ledger data inserted; never `prune`, `bootstrap` or `only_utxo`. The queries read schema `public`, and the extraction's `study` tables when the role can read them (its samples with their split and reconstruction-check exclusion, its franken flags, and its life table). Each filters on an indexed column, except the chain-wide collateral measurement and the epoch boundaries of the near-cap command, which read their tables in one pass each. Reads by transaction, reference or wallet go in batches (200 transactions, 1,000 or 2,000 output references, or 500 wallets per statement), so that no single statement runs long. Nothing is created anywhere.

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
| `collateral --run-id <id>` | Over the recent window's script-executing transactions whose collateral inputs all sit at key addresses: the share under 20 ADA of collateral, the distribution of collateral coin, the share with a collateral return, the share of collateral inputs carrying tokens. On a test network, `--days <n>` measures the last n days instead of the recent window. |
| `battery-pools --run-id <id> --network <n>` | From a run's recent-window history files, the amounts of the pure-ADA payments (spend type T1) and the shares of a fungible's holding sent in fungible-token spends (T5). |
| `replay --treatment <dir> (--history <file or dir>... \| --shapes <names\|all>) --plan recent\|peak\|test` | A run plan's arms replayed over history files, or over the shapes' synthetic streams. `--workers <n>` (default 1), `--limit-ms` (default 300,000 per replay), `--reps-h1`, `--reps-variants`, `--test-reps`, `--run-id`, `--analysis-freeze-tx`. |
| `battery --treatment <dir> (--history <snapshot file or dir>... --pools <file> \| --shapes <names\|all>)` | The standard battery and H-10's at the snapshot, under the battery's selectors (`--methods study`, the default) or the test methods (`--methods test`). `--reps <n>` (default 30), `--answer-limit-ms` (default 60,000 per method answer), `--workers`, `--run-id`. A wallet's draws come from the frozen pools `--pools` names; the shapes use fixed test values. |
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

The `replay` and `battery` commands write, under the same root:

```
run.json         the command, its plan, the settings, the treatment's digests, the Node version and the code manifest
records.jsonl    the records, one JSON object per line
timings.jsonl    wall-clock times, kept apart so that a run repeated with the same seeds writes byte-identical records
log.jsonl        start, each time-out or error, end
```

Every record names its wallet (the stake-credential id, or a shape's name), window, arm, variant, method, change policy, collateral rule and repetition, and an intent by its position in the wallet's stream. A record that would carry an address, a stake address, a transaction hash or a credential is refused, and free-text fields (a failure's detail, a refusal's reason) have them replaced by placeholders. The kinds:

- `spend`: one replayed intent: its outcome (built, failed with its class, infeasible by balance, not replayable, or forfeit), the fee and the wallet-controlled fee, size, inputs, signing keys, assets dragged, change outputs with their bytes and largest Value, the drag bytes of H-2, the bytes and fee per policy recreated in change for H-3, the collateral used, the collateral available under every rule at a script interaction, and the UTxO count and largest Value after it;
- `plan`: a tidy plan an arm applied, at the start or at a 30-day mark, with its fee, transaction count and UTxOs after;
- `burst`: a parallel burst's separate pass, and whether it was feasible;
- `trigger`: an H-6 trigger, with its rescue outcome under each confirmatory collateral rule;
- `wallet-arm`: per wallet and arm over the window: counts by outcome and class, failures per 100 attempted spends, spend, wallet-controlled, plan and forfeit fees, burst feasibility, the end state's UTxO count, locked ADA and locked ADA per token, the largest Value's trajectory, the end state's conformity to the arm's layout, and H-3's time-averaged locked ADA per policy where the arm records it;
- `battery` and `h12`: one battery run by one method, its outcome, fees, the "balance suffices" flag, the plan after the spend, and for the H-12 rule its completion, chain length and whole-chain fees; the oracle's reference, when an oracle is given;
- `timeout` and `refused`: a replay that ran past its limit, and one the rules do not settle (a wallet for which the change-address rule names no address where the replay needs one, a start plan the planner refuses).

### History files

One JSON Lines file per wallet and window. Amounts are decimal strings; hashes, policies, names and CBOR lowercase hex; references `<transaction id>#<index>`.

1. `header`: the wallet, frame and split; the window's first and last blocks, its transaction-id range [`lo`, `hi`] and the transaction id of its start state; the snapshot; the snapshot epoch's protocol parameters; the franken-flagged payment credentials; the arrival table; `latestKeyBase`, the latest output the wallet received at or before the start state's transaction, spent or not, at a key payment credential and a base address whose credential is not franken-flagged, as `{ address, txId, index }` (null when there is none); the settings; the byte source and db-sync version.
2. `state`: the UTxO set as of the last block before the window's first block, as UTxO records.
3. Events in chain order:
   - `deposit`: the wallet outputs created by a transaction that is not the wallet's spend, as UTxO records;
   - `held-consumed`: the held wallet UTxOs consumed by a transaction that is not the wallet's spend;
   - `intent`: a spend and its intent;
   - `self-reorganization`: a spend with no requested output, no certificate, vote or proposal, no mint or burn and no script; counted, its reshuffle of the wallet's inputs not replayed. It carries its implicit values, the held UTxOs it consumed, `withdrawal` (its reward withdrawals, which the replay deposits), the net value it brought in from outside the wallet other than those, and the observed wallet parts;
   - `mark`: every 30 days of block time from the window's first block, placed before the first event at or after its time.
4. `end`: the UTxO set's count and digest at the window's last block, and the event counts.

A UTxO record is `{ ref, cbor, address, cred, coin, assets, held, origin, txId }`: `cbor` is the CIP-30 `TransactionUnspentOutput` (CIP-0030, "TransactionUnspentOutput": `[input, output]`), `cred` the payment credential, `assets` `[{ policy, name, qty }]` sorted by policy then name bytes, `held` the reason the UTxO is held (`script-payment`, `datum`, `reference-script` or `franken`) or null, `origin` `initial` or `deposit`, and `txId` db-sync's id of the creating transaction, which follows chain order and ranks outputs for the change address. The output inside `cbor` is re-encoded from db-sync's columns on every network, so that preprod runs the code mainnet runs. The address bytes come from its text and the value takes the ledger's serialization. A datum is its hash or the inline datum's bytes. A reference script comes from db-sync's script bytes, or, for a native script, whose bytes db-sync does not keep, from its creating transaction's bytes. db-sync does not record whether the original output used the array or the map form, so the re-encoding uses the map form only when an inline datum or a reference script needs it; its content always equals the original's.

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

## The simulator core

### The ledger kit

Every size is the ledger's size of the transaction's bytes, never an estimate, and every fee is `minFeeA * size + minFeeB`, plus for a replayed script spend the intent's script fee (`eras/alonzo/impl/src/Cardano/Ledger/Alonzo/Tx.hs:498-508`; `eras/conway/impl/src/Cardano/Ledger/Conway/Tx.hs:105-145`). The wallet-controlled fee, which every fee comparison uses, is that fee less the script fee and less `minFeeA` times the bytes of the intent's fixed parts.

Every built transaction is checked from its bytes, without CSL, so that the checks are a second implementation beside the treatment's and the libraries' own: the size limit (`eras/shelley/impl/src/Cardano/Ledger/Shelley/Rules/Utxo.hs:570-585`); every output's Value, the collateral return's included, at most `maxValSize` (`eras/alonzo/impl/src/Cardano/Ledger/Alonzo/Rules/Utxo.hs:425-447`); every output's coin at least `coinsPerUtxoByte * (160 + its bytes)` (`eras/babbage/impl/src/Cardano/Ledger/Babbage/TxOut.hs:678-702`); every input resolving; coin and every asset conserved with the withdrawals, refunds, mints, deposits, burns and treasury donation (`Shelley/Rules/Utxo.hs:513-529`; `eras/conway/impl/src/Cardano/Ledger/Conway/UTxO.hs:107-145`); the fee at least the minimum (`eras/babbage/impl/src/Cardano/Ledger/Babbage/Rules/Utxo.hs:183-212`); one vkey witness per distinct key payment credential among the inputs and collateral inputs, plus the intent's other witnesses (`eras/alonzo/impl/src/Cardano/Ledger/Alonzo/TxBody.hs:307-313`; `eras/shelley/impl/src/Cardano/Ledger/Shelley/UTxO.hs:205-227`); the auxiliary-data hash present exactly with auxiliary data; and, with redeemers, collateral: one to `maxCollateralInputs` inputs at key addresses, the balance less the return ADA only, at least `collateralPercent` of the fee, and equal to the total-collateral field (`Babbage/Rules/Utxo.hs:231-308`; `eras/babbage/impl/src/Cardano/Ledger/Babbage/Collateral.hs:30-39`). A failed check is a build failure of one class: transaction size, value size, change minimum, maximum input count, balance, fee under the minimum, collateral, time limit or other. A fee under the minimum (`fee-minimum`) is reported apart from balance shortfalls: the transaction balances, and the network rejects it for its fee alone.

A selection-only method's transaction is assembled with CSL: its inputs sorted by transaction id then index, its outputs, and synthetic vkey witnesses, one per distinct payment key, of the size real ones have, at the minimum fee found as a fixed point (the fee's and the change coin's encodings are part of the size). A replayed intent's transaction is assembled from its parts: the requested outputs and every fixed part as their original bytes, the arm's inputs and change, spend redeemers re-indexed to their inputs' places, the auxiliary-data hash recomputed, and collateral under the arm's rule with its return output and total. The script-data hash is a 32-byte stand-in over the redeemers and datums: the ledger's also covers the cost models' language views, which a history file does not carry, and no check reads it. Four negative controls are caught on every form of transaction, each by its own check: the fee one lovelace short, the size one byte over, a Value one byte over, and one witness short.

### States, the treatment and the methods

A state holds the wallet's UTxO records (in `txid#index` order), its stake credential, its franken-flagged credentials and its change address. The change address is the address of the latest output at a key payment credential and a base address, by creating transaction then index and passing over franken-flagged credentials, among every output the wallet has received on the chain up to that point: `latestKeyBase`, then the deposits and the observed wallet outputs of the window's spends and self-reorganizations, the real wallet's own change included. Every arm and method therefore has the same change address at a given spend, and it moves as later outputs arrive; an event's own outputs count from the next event on. A wallet that spends, or holds a spendable UTxO, before it has received such an output, or never receives one, is refused; before that output its state holds nothing a plan could spend, so plans there are recorded empty and not run. Applying a transaction removes its wallet inputs and adds its outputs that carry the wallet's stake credential; payments to other stake credentials leave the wallet.

The treatment is loaded from the directory the operator names, every file's digest checked against `data/treatment-pins.txt` first. Its planner and its H-12 selection rule run on states, given the UTxOs in `txid#index` order with held UTxOs marked held, and every transaction they build must pass both the treatment's own checks and the kit's; a disagreement stops the run. Protocol parameters reach it as its parameters object, and a parameter it would read differently from the run's is refused.

A method is `{ name, version, deterministic, build(state, intent, params, opts) }`, `opts` naming a seed, a change policy, the arm's collateral rule and H-12's absorption. Methods are made by name (`src/methods/registry.mjs`), so that a worker thread can make the one its job names. The H-12 method serves the batteries only, since its request carries only requested outputs. Two test methods exist only to test the engine and never appear in a study run: `test-largest-first` (largest coin first, with a simulator-owned change policy) and `test-stall`, which blocks its thread to force the time limits. The simulator's change policies, put on a baseline's input selection, are built from the treatment's own functions: `layout` (H-9's layout-preserving change), `single` (one change output, failing at the value-size limit) and `naive` (the naive-tidy control's rule applied to change).

### Arms and run plans

An arm is a starting layout at the window start and how it is kept: `observed`; `tidy-once` (the planner's full plan applied, its fees charged); `maintained-tidy` (as tidy-once, then re-planned at every 30-day mark, any plan applied and charged); and H-1's two controls, `naive-tidy` and `random-tidy`, each applied once. Plan fees are recorded apart from spend fees. A variant is the planner's settings varied as one hypothesis names, every other setting at its default: H-2's groupings by arrival, by policy then arrival and at random, and byte-optimal packing; H-3's bundle sizes 1, 5, 10, 30, 60 and no count cap; H-4's isolation per asset and per policy; H-5's reserve rules R0 to R6; and H-6's never-propose arm, 1 ADA dust threshold and 3-to-6 and 5-to-20 ADA collateral bands.

A run plan lists which arms run in which window under which selectors and change policies: H-1's arms under the three baselines and its controls under the primary selector, the Evolution SDK's observed arm, H-2 to H-4's variants (tidy-once) and H-6's (maintained-tidy) in the recent window, H-5's reserve rules in both windows, H-9's tidy-once arm with the default and the layout-preserving change, and H-11's factorial in the peak window. A random selector runs 30 repetitions in H-1's arms and at the snapshot and 10 in the variants and H-11; a deterministic one runs once. Repetition r runs a seeded selector with seed r and any random layout with seed r, so compared arms share one seed sequence. Each arm runs under the ledger and the practice collateral rule, with the ledger minimum and token-bearing collateral as sensitivity arms, when its window holds a script interaction.

### The replay engine

Each (wallet, arm, variant, selector, change policy, collateral rule, repetition) replay runs in a worker thread, at most 300 seconds of wall-clock time; CSL's calls are synchronous, so a replay past its limit is stopped by terminating its thread, recorded as a time-out, and the pool starts a fresh worker. Workers are also replaced after 40 jobs, since CSL's asm.js heap only grows to the largest wallet a worker has built for; a worker on the 3,005-UTxO shapes holds about 0.8 GiB, so `--workers` should leave that much memory per worker. Deposits enter every arm when they occurred; held UTxOs leave every arm when anything consumes them; self-reorganizations are counted and their reshuffles not replayed, but one that carries a reward withdrawal deposits the withdrawn ADA in every arm, as one UTxO at the change address in effect at it, so that every arm receives what the real wallet received, its fee charged to no arm; at a mark the maintained-tidy arm re-plans. Every arm replays the same intents in the same order:

- A phase-2-invalid intent forfeits the observed total collateral from collateral chosen under the arm's rule, its return output coming back to the wallet.
- An intent the arm's balance cannot fund, by the H-12 rule's exact test with the intent's implicit values and fixed inputs counted, is recorded as infeasible by balance and is not a selector failure.
- Otherwise the method builds it, the kit checks it, and it is applied; a failure leaves the state as it was and the replay continues.

Collateral is the smallest UTxO eligible under the arm's rule that is not an input of the spend and can carry the total collateral with a return output at its minimum, ties by `txid#index`. At every script interaction the engine records whether collateral is available under each rule. At each parallel burst's first spend, a separate pass builds the burst's spends from the state at its start without spending any output created earlier in the burst, for burst feasibility; the sequential replay continues for fees. In the maintained-tidy arm, a plan that proposes a pure-ADA-only transaction the never-propose setting would not is an H-6 trigger, and a trigger rescues when, within 30 days of block time, the never-propose arm lacks eligible collateral at a script interaction or cannot build a parallel burst that the rule's arm can.

### The batteries

At the snapshot, from the observed layout: an ADA payment drawn from the pooled T1 amounts, one NFT, a share of one fungible drawn from the pooled T5 shares, all NFTs of one policy, p of the most spread fungible's balance for p in {0.25, 0.5, 0.75, 0.9}, and payrolls to 10 and 100 recipients; and H-10's payments of p of the ADA balance from the observed and the tidy layout. Draws come from one mulberry32 generator per wallet and spend kind, seeded from SHA-256 of the stake credential and the kind's name. A drawn ADA amount under its output's minimum is raised to that minimum, and a fungible share or payroll share that rounds to zero units pays one unit; a payroll whose wallet holds fewer units than it has recipients is left unbuilt and reported. Recipients are synthetic base addresses whose stake part is no wallet's.

"The balance suffices" (the H-12 rule's exact test) is evaluated once per wallet and spend on the layout the spend is made from, the observed layout for the standard battery and H-12, and is the infeasible-by-balance rule of every battery. Every method's answer must come within 60 seconds of wall-clock time; one that does not has returned an error with the reason "time limit", and the wallet's remaining spends continue in a fresh worker. After every spend the frozen planner plans the resulting state at its defaults. When an oracle is given, it is called once per wallet, observed-layout spend and distinct oracle change policy, so that two selectors whose change the oracle builds the same way share one reference, with every method's single transaction under that policy as an incumbent.

### Synthetic shapes and streams

The 17 shapes of the preprod seeder (byte for byte the treatment harness's) and the claim and merchant shapes CL1, CL3, E1 and E2 are generated deterministically with mulberry32. Each shape has a synthetic intent stream of fixed test values for the engine's tests, over 75 days: payments of each type T1 to T8 that its holdings allow, a deposit with a held datum UTxO, a parallel burst, a deposit at a second base address of the wallet, to which the change address moves, a Plutus spend with a script input, redeemer, script and datum, a phase-2-invalid forfeit, a payment with a validity interval, a message and a held fixed input, a self-reorganization, one with a reward withdrawal, a native-script mint, a stake registration with its deposit, and two 30-day marks.

## Baselines

The baselines are external selectors run at their libraries' defaults, each through an adapter in `src/methods/` that implements the simulator's method contract (`src/methods/contract.mjs`):

| Method | Library | What runs |
|---|---|---|
| `csl-lf` | cardano-serialization-lib 13.2.1 | `TransactionBuilder.add_inputs_from` with `LargestFirstMultiAsset`, then `add_change_if_needed` |
| `csl-ri` | cardano-serialization-lib 13.2.1 | the same with `RandomImproveMultiAsset`, which draws from an unseedable generator |
| `csl-lf-pure`, `csl-ri-pure` | cardano-serialization-lib 13.2.1 | the two above with `prefer_pure_change` set |
| `cjs-rrri` | `@cardano-sdk/input-selection` 0.14.35 | `roundRobinRandomImprove`, seeded with mulberry32 |
| `evo-lf` | `@evolution-sdk/evolution` 0.6.0 | its transaction builder at its defaults: largest-first selection, no `unfrack` option |

cardano-serialization-lib (CSL) is the treatment's instance, loaded through its `cslkit.mjs`; no other CSL build is installed. Every adapter receives the spendable UTxOs in transaction id then index order, runs its library with the run's protocol parameters, and maps the library's errors to the failure classes. The engine runs the ledger kit's checks on what it returns; no adapter checks, retries or repairs its library's output. Each adapter's source comments cite the library code it relies on, by repository, commit, file and line.

Serialization and witnesses. A library that returns a transaction keeps its own encoding. CSL's witness set is filled with one synthetic vkey witness per distinct payment key among the inputs (the treatment's `build.mjs` witnesses), and the Evolution SDK's transaction is taken with its own fake witnesses, one per payment key. cardano-js-sdk selects inputs and computes change only, so the kit assembles its transaction, and its four constraint callbacks are computed with the kit on the transaction as it will be assembled, at the wallet's change address:

- `computeMinimumCost`: the ledger's minimum fee for the skeleton's transaction, its fee field at that fee;
- `computeMinimumCoinQuantity`: CSL's `min_ada_for_output` for the output;
- `tokenBundleSizeExceedsLimit`: the bundle's Value, its coin at the widest encoding, against `maxValSize` (the library passes the bundle without its coin; setting `cjsBundleCoin` in `src/settings.mjs`);
- `computeSelectionLimit`: the skeleton's input count when its transaction fits `maxTxSize`, one fewer when it does not.

Failure classes:

| Library | Error | Class |
|---|---|---|
| CSL | "Not enough ADA leftover to include non-ADA assets in a change address" | `change-minimum` |
| CSL | "UTxO Balance Insufficient", "Insufficient input in transaction", "No inputs to add" | `balance` |
| CSL | "Maximum transaction size of ... exceeded" | `tx-size` |
| CSL | "Maximum value size of ... exceeded" | `value-size` |
| cardano-js-sdk | `UtxoBalanceInsufficient` | `balance` |
| cardano-js-sdk | `UtxoFullyDepleted` | `change-minimum` |
| cardano-js-sdk | `MaximumInputCountExceeded` | `max-inputs` |
| Evolution SDK | a `CoinSelectionError` | `balance` |
| Evolution SDK | "Cannot balance transaction: Native assets present in leftover ...", "Cannot create valid change: Insufficient funds ..." | `change-minimum` |
| Evolution SDK | "Transaction size (...) exceeds protocol maximum" | `tx-size` |

Any other error takes class `other` with its text.

Change substitution. With a change policy other than `default` (`layout`, `single` or `naive`), `csl-lf`, `csl-ri` and `cjs-rrri` keep only the inputs their library chose, and the simulator's policy (`src/methods/change.mjs`) builds the change, the kit assembling the transaction at its exact fee. When those inputs cannot fund the change, the spend fails with class `change-minimum`. `evo-lf` takes no substitution.

Not built yet: the replay path. An intent with fixed parts, or one that needs collateral, is refused with an error rather than built in part.

### Builder survey

`src/survey/` holds the library part of the builder survey. Its fixture (`fixture.mjs`) is a wallet of k UTxOs, k from 1 to 5, each with 141 one-unit tokens of its own test policy under 32-byte names (a 4,974-byte Value) and 100 ADA. The wallet comes with and without two pure-ADA UTxOs of 2k × 100 ADA each, which alone cover the payment: 75% of the wallet's ADA to an external key address. Both variants, for k from 1 to 5, together hold 9,000 ADA, within one 10,000 tADA preprod faucet request. Names, policies and transaction ids are BLAKE2b hashes of fixed texts. These values are the settings in `SURVEY_SETTINGS`.

The subjects are the baselines above, Mesh (`@meshsdk/transaction` 1.9.1) at its default selector and with its `LargestFirstInputSelector`, driven through `MeshTxBuilder` offline with Mesh's own constraint callbacks (`src/methods/mesh.mjs`), and the Evolution SDK with its `unfrack` option at the option's defaults. A random subject runs 30 times (seeds 1 to 30 where it takes one). Every transaction a subject builds goes through the kit's checks; one the kit rejects is recorded as built but invalid, with the reason. `mesh-compare.mjs` compares Mesh's default with `cjs-rrri` on the shapes' battery spends, both given the same seeded draws.

### Dependencies

Direct dependencies, pinned exactly:

| Package | Version | Integrity |
|---|---|---|
| `pg` | 8.23.0 | `sha512-Ip2EQCngowJLGOfCwkFhPXU7/ljlhn6Rxlmy4XYfL2Y+vyRM59+8uR2xqRWKdYmbXmxCFOAmKxBuSUCdF34qLg==` |
| `@cardano-sdk/input-selection` | 0.14.35 | `sha512-Qd+/lVUSn5wUpTZDm5CaRW3fpiFXn1hSJTfPnR03TAsjvcCvSysidDI2v+yfg7p+fqp+4FCIIW0RTiIaSNRv3g==` |
| `@evolution-sdk/evolution` | 0.6.0 | `sha512-4vyDsTSQHq/9FuFSU1Yss8ep8tvkAKFMWQT90CKUPUzqDF1lQBIMXbab3BRv9etz5OyiuGrzPdsZcR277Xmp5A==` |
| `@meshsdk/transaction` | 1.9.1 | `sha512-FjKSoUi2xFaKJPI1ObQ13UkrCJu+iPW6THP//ZD/f5I1NciaUz3bcoQ7xWcc7El4TCcDunBPp9di6w9JitBR6Q==` |

`@cardano-sdk/input-selection` 0.14.35 was published from `input-output-hk/cardano-js-sdk` commit 48019e49c826ea77d81be0e2d2907f94406f5e04. Its `@cardano-sdk` dependencies resolve to the versions that commit holds: core 0.47.1, util 0.17.2, key-management 0.29.19, crypto 0.4.7 and dapp-connector 0.13.31. The Evolution SDK 0.6.0 is the tag `@evolution-sdk/evolution@0.6.0` of `IntersectMBO/evolution-sdk`, commit c4139df12e099dbd4742d3e2c10dc52f50a4bd41; `overrides` in `package.json` pin its caret dependencies to the versions that commit's `pnpm-lock.yaml` holds, with the same integrities: effect 3.22.2 (with @standard-schema/spec 1.1.0, fast-check 3.23.2 and pure-rand 6.1.0), @noble/curves 2.4.0, @noble/hashes 2.4.0, @scure/base 2.4.0, @scure/bip32 2.4.0 and @scure/bip39 2.4.0. Mesh 1.9.1, the npm release built from `MeshJS/mesh` commit c0b183eccd0c20a465778f204f8c9caf73294bd8, pins `@cardano-sdk/input-selection` 0.14.28, core 0.46.12 and util 0.17.1, which npm installs as nested copies under `@meshsdk/transaction` and `@meshsdk/core-cst`. Every other package is the version the lockfile recorded when these were installed on 2026-10-27; `npm run hash` prints each with its integrity.

<details>
<summary>Every package in the lockfile (205)</summary>

@biglup/is-cid 1.0.3, @cardano-ogmios/client 6.9.0, @cardano-ogmios/schema 6.9.0, @cardano-sdk/core 0.47.1, @cardano-sdk/core 0.46.12 (under @meshsdk/core-cst), @cardano-sdk/core 0.46.12 (under @meshsdk/transaction), @cardano-sdk/crypto 0.4.7, @cardano-sdk/crypto 0.4.5 (under @meshsdk/core-cst), @cardano-sdk/dapp-connector 0.13.31, @cardano-sdk/input-selection 0.14.35, @cardano-sdk/input-selection 0.14.28 (under @meshsdk/core-cst), @cardano-sdk/input-selection 0.14.28 (under @meshsdk/transaction), @cardano-sdk/key-management 0.29.19, @cardano-sdk/util 0.17.2, @cardano-sdk/util 0.17.1 (under @meshsdk/core-cst), @cardano-sdk/util 0.17.1 (under @meshsdk/transaction), @cardanosolutions/json-bigint 1.1.0, @chainsafe/is-ip 2.1.0, @chainsafe/netmask 2.0.0, @dnsquery/dns-packet 6.1.1, @emurgo/cardano-message-signing-nodejs 1.1.0, @evolution-sdk/evolution 0.6.0, @foxglove/crc 0.0.3, @harmoniclabs/bigint-utils 1.0.0, @harmoniclabs/biguint 1.0.0, @harmoniclabs/bitstream 1.0.0, @harmoniclabs/bytestring 1.0.0, @harmoniclabs/cbor 1.6.0, @harmoniclabs/crypto 0.3.1, @harmoniclabs/crypto 0.2.5 (under @harmoniclabs/plutus-data), @harmoniclabs/obj-utils 1.0.0, @harmoniclabs/pair 1.0.0, @harmoniclabs/plutus-data 1.2.6, @harmoniclabs/uint8array-utils 1.0.4, @harmoniclabs/uplc 1.4.1, @leichtgewicht/ip-codec 2.0.5, @libp2p/interface 3.4.0, @meshsdk/common 1.9.1, @meshsdk/core-cst 1.9.1, @meshsdk/transaction 1.9.1, @multiformats/dns 1.0.15, @multiformats/mafmt 12.1.6, @multiformats/multiaddr 12.5.1, @multiformats/multiaddr 13.0.3 (under @libp2p/interface), @noble/curves 2.4.0, @noble/hashes 2.4.0, @noble/hashes 1.8.0 (under @meshsdk/common), @noble/hashes 1.8.0 (under bip39), @scure/base 1.2.6, @scure/base 2.4.0 (under @evolution-sdk/evolution), @scure/base 2.4.0 (under @scure/bip32), @scure/bip32 2.4.0, @scure/bip39 2.4.0, @standard-schema/spec 1.1.0, @types/base32-encoding 1.0.2, @types/json-bigint 1.0.4, @types/node 26.6.5, @zxing/text-encoding 0.9.0 (optional), abort-error 1.0.2, available-typed-arrays 1.0.7, b4a 1.9.0, base32-encoding 1.0.0, bech32 2.0.0, bignumber.js 9.3.1, bindings 1.5.0 (optional), bip39 3.1.2, bip39 3.1.0 (under @meshsdk/common), blake2b 2.1.4, blake2b-wasm 2.4.0, blakejs 1.2.1, bn.js 5.2.5, call-bind 1.0.9, call-bind-apply-helpers 1.0.2, call-bound 1.0.4, chacha 2.1.0, chacha-native 2.0.3 (optional), cipher-base 1.0.7, core-util-is 1.0.3, create-hash 1.2.0, create-hmac 1.1.7, cross-fetch 3.2.0, define-data-property 1.1.4, dom-walk 0.1.2, dunder-proto 1.0.1, effect 3.22.2 (under @evolution-sdk/evolution), es-define-property 1.0.1, es-errors 1.3.0, es-object-atoms 1.1.2, eventemitter3 5.0.4, fast-check 3.23.2, fastq 1.20.3, file-uri-to-path 1.0.0 (optional), for-each 0.3.5, fraction.js 4.0.1, function-bind 1.1.2, generator-function 2.0.1, get-intrinsic 1.3.0, get-proto 1.0.1, get-random-values 2.1.0, global 4.4.0, gopd 1.2.0, has-property-descriptors 1.0.2, has-symbols 1.1.0, has-tostringtag 1.0.2, hash-base 3.1.2, hash.js 1.1.7, hashlru 2.3.0, hasown 2.0.4, i 0.3.7, inherits 2.0.4, ip-address 10.7.5, ip-address 9.0.5 (under @meshsdk/core-cst), ip-address 9.0.5 (under @meshsdk/transaction), is-arguments 1.2.0, is-callable 1.2.7, is-generator-function 1.1.2, is-regex 1.2.1, is-typed-array 1.1.15, isarray 0.0.1, isarray 1.0.0 (under hash-base), isarray 2.0.5 (under to-buffer), iso-url 1.2.1, isomorphic-ws 4.0.1, jsbn 1.1.0, json-bigint 1.0.0, libsodium-sumo 0.8.4, libsodium-sumo 0.7.16 (under @meshsdk/core-cst), libsodium-wrappers-sumo 0.8.4, libsodium-wrappers-sumo 0.7.10 (under @meshsdk/core-cst), lodash 4.18.1, main-event 1.0.5, math-intrinsics 1.1.0, md5.js 1.3.5, min-document 2.19.2, minimalistic-assert 1.0.1, multiformats 13.4.2, multiformats 14.0.5 (under @libp2p/interface), multiformats 14.0.5 (under @multiformats/dns), multiformats 14.0.5 (under uint8arraylist), nan 2.30.0 (optional), nanoassert 2.0.0, nanoid 3.3.20, node-fetch 2.7.0, p-queue 9.3.5, p-timeout 7.0.2, pbkdf2 3.1.7, pg 8.23.0, pg-cloudflare 1.4.1 (optional), pg-connection-string 2.14.1, pg-int8 1.0.1, pg-pool 3.14.0, pg-protocol 1.16.1, pg-types 2.2.0, pgpass 1.0.5, possible-typed-array-names 1.1.0, postgres-array 2.0.0, postgres-bytea 1.0.1, postgres-date 1.0.7, postgres-interval 1.2.0, process 0.11.10, process-nextick-args 2.0.1, progress-events 1.1.0, pure-rand 6.1.0, readable-stream 1.1.14, readable-stream 2.3.8 (under hash-base), reusify 1.1.0, ripemd160 2.0.3, rxjs 7.8.2, safe-buffer 5.2.1, safe-buffer 5.1.2 (under hash-base > readable-stream), safe-buffer 5.1.2 (under hash-base > string_decoder), safe-regex-test 1.1.0, serialize-error 8.1.0, set-function-length 1.2.2, sha.js 2.4.12, split2 4.2.0, sprintf-js 1.1.3, string_decoder 0.10.31, string_decoder 1.1.1 (under hash-base), to-buffer 1.2.2, tr46 0.0.3, ts-custom-error 3.3.1, ts-log 2.2.7, tslib 2.8.1, type-fest 0.20.2, typed-array-buffer 1.0.3, uint8-varint 2.0.5, uint8-varint 3.0.0 (under @libp2p/interface), uint8arraylist 3.0.2, uint8arraylist 2.4.9 (under uint8-varint), uint8arrays 5.1.1, uint8arrays 6.1.1 (under @libp2p/interface), uint8arrays 6.1.1 (under @multiformats/dns), uint8arrays 6.1.1 (under uint8arraylist), undici-types 8.9.0, utf8-codec 1.0.0, util 0.12.5, util-deprecate 1.0.2, web-encoding 1.1.5, webextension-polyfill 0.8.0, webidl-conversions 3.0.1, whatwg-url 5.0.0, which-typed-array 1.1.24, ws 7.5.13, xtend 4.0.2

</details>

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

The simulator core's readings (`src/settings.mjs`), recorded in every run's `run.json`:

| Setting | Default | Meaning |
|---|---|---|
| `changeAddress` | `latest-key-base-received` | The change address of every arm and method, as above. |
| `serialization` | `own` | A method that returns whole transactions keeps its own serialization; a selection-only method is assembled by the kit. |
| `batteryDraws` | `pool` | Battery draws from frozen pools, one generator per wallet and spend kind. |
| `recipients` | `synthetic-base` | External recipients are synthetic base addresses. |
| `oversizeRequest` | `split` | A requested token output over the value-size limit is split into outputs at their minimum. |
| `infeasible` | `exact` | The H-12 rule's exact test decides infeasibility by balance in every battery and replay. |
| `h10Amount` | `observed` | H-10's tidy-layout payments are p of the observed layout's balance. |
| `unclassified` | `other` | A failure that fits no class is class `other`, with its text. |
| `substitutedChange` | `fail` | Substituted change the selector's inputs cannot fund fails with class change minimum. |
| `rng` | `mulberry32` | Seeds: the seed number for a selector, the repetition number for a random layout. |
| `collateralChoice` | `smallest` | The smallest eligible collateral UTxO, always with a return output and the total-collateral field. |
| `phase2Invalid` | `forfeit` | A phase-2-invalid transaction forfeits the observed total collateral. |
| `burstPass` | `separate` | The in-burst constraint applies only in a separate pass at each parallel burst. |
| `policyRecord` | `per-spend-and-window` | H-3's per-policy records: bytes and fee recreated in change per spend, and time-averaged locked ADA per window. |
| `heldBytes` | `ledger` | Value bytes by the ledger's serialization, the minimum by CSL on the output. |
| `treatmentOrder` | `ref` | The treatment is given UTxOs in `txid#index` order. |
| `heldToTreatment` | `flagged` | Held UTxOs are given to the treatment marked held. |

## Hashing

`npm run hash` prints the SHA-256 of every file under `src/`, `sql/` and `data/` and of `package.json` and `package-lock.json`, the pinned dependencies with their npm integrity, and the Node version, in the format of the extraction tool's code manifest. It refuses a file that is not UTF-8 with LF line endings and a final newline, or that has a byte-order mark. Tests and the README are not hashed.

## Tests

`npm test` runs the unit tests: no database and no chain data. They cover CBOR spans and encoders, BLAKE2b against Node's 64-byte digest and known 32-byte digests, CIP-19's address vectors, Base58, CIP-67's ten test vectors and the five registry prefixes, the classification rule, value sizes against the ledger encoding over random values, both output forms with datums and reference scripts, transactions of both era layouts with their size rule, redeemers in both forms, the ImmutableDB format on a constructed chunk (including a CRC-32 mismatch), parameters and both fee terms, bursts (a chained pair in one block, 59 and 61 seconds apart, a parallel burst), marks, the observed replay, spend types, asset classes, settings and the code manifest.

The intent tests and the kit's CSL tests build transactions with CSL, so they run when `RESEARCH_SIM_TREATMENT_DIR` and `RESEARCH_SIM_TREATMENT_PINS` name the treatment and its digests, and are skipped otherwise. The unit tests also cover the kit's checks and their classes, sizes against CSL on every UTxO of the 21 shapes, witness counting over several payment keys, the reference-script fee term, wallet states and the change-address rule, the history file reader, output records and their guard, run plans and arm settings, collateral eligibility, H-6's rescue join, and the replay assembler against CSL's assembly.

`npm run test:treatment` runs the simulator's tests against the treatment (one at a time):

- the bridge against a fresh run of the treatment harness's own runners, plan for plan and battery result for battery result, on a digest-checked copy;
- every transaction built on the 21 shapes (plans, battery spends by the H-12 rule and the test method under each change policy) meeting the kit's checks, read back by CSL to the same bytes, at exactly the ledger's minimum fee when the treatment built it, with the four negative controls caught on each;
- the replay engine on every shape's synthetic stream under every arm and variant, each replayed transaction checked, read by CSL and its negative controls caught, and its events in place; one case is left out and named in the test, M3's tidy-once arm at the random grouping, where the planner exhausts the JavaScript heap planning the end state;
- a replay run repeated through the worker pool with the same seeds writing byte-identical records;
- the battery runner with its H-12 records and the oracle hook;
- the time limits, forced (shortened to 2 seconds by default; `RESEARCH_SIM_REAL_LIMITS=1` runs them at 300 and 60 seconds);
- timing and memory of a plan, a battery and a replay on M2, M3 and E1.

`npm run test:treatment` runs the tests that need the treatment (`RESEARCH_SIM_TREATMENT_DIR`, with `RESEARCH_SIM_TREATMENT_PINS` naming a digest list other than `data/treatment-pins.txt`): the bridge and the shapes, and the baselines. `baselines-behavior.test.mjs` checks the library behaviors the adapters rely on, each on a constructed case, and one failure of each class per adapter. `baselines-battery.test.mjs` runs every baseline, at its default change and under each substituted policy, on the battery spends of the 21 synthetic shapes (the 17 seeded shapes plus CL1, CL3, E1 and E2): each transaction meets the kit's checks or fails one with its class, and the kit's negative controls are caught on each in its library's encoding. The same test measures cardano-js-sdk's callbacks against the assembled transactions, the build times on the largest shapes, M2 and M3 (3,005 UTxOs each) and E1 (405 UTxOs), and determinism by seed and by run. `survey.test.mjs` runs the builder survey and the Mesh comparison. With `RESEARCH_SIM_OUT` naming a directory, these write their records there as JSON.

`npm run test:preprod` runs the integration tests against a preprod database, as of one snapshot block (`RESEARCH_SIM_SNAPSHOT`), since db-sync keeps following the chain while they run; their environment is described in `test/integration/history/env.mjs`. They cover:

- the reconstruction against the reference query, for the seeded wallets and 1,000 random wallets at 20 blocks;
- outputs re-encoded from db-sync's columns against their original bytes, by output form;
- the 17 seeded shapes against the preprod seeder's specification (`tools/preprod-seeder`, used through its `address` command and its deterministic generator only), and the shapes' own spends as intents; a UTxO whose creating transaction spends no input of the funder or of a shape, sent by someone else, is left out of the comparison and reported;
- every spend of the seeder's funder and of 200 further wallets over the last 60 days, with the burst cases they contain, each file read back by the simulator's reader with every record's creating transaction id checked against db-sync's;
- phase-2-invalid transactions;
- the ImmutableDB against `tx_cbor`, byte for byte, across every Shelley-based era;
- the census, near-cap and collateral commands, with their plans and run times.

Results go to `preprod/<RESEARCH_SIM_TEST_TAG>/tests/` under the output root.

## License

The tool's code is licensed under Apache-2.0 (see `LICENSE`). This README is licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
