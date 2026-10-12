# preprod-seeder

A command-line tool that creates Cardano preprod test wallets laid out in 17 fixed UTxO shapes. Each shape wallet has its own 24-word mnemonic that can be restored into a preprod browser extension, so UnFrack.It (and later its library) can be tested on real chain data through real CIP-30 wallets.

The tool generates and holds its own testnet mnemonics. You fund one funder wallet from your own testnet wallet or the preprod faucet. `seed` mints the tokens a shape needs from the funder and lays out the shape's UTxOs at the shape wallet's addresses. `sweep` burns the tokens the tool minted and returns all the ADA to the funder, so a test that tidies a wallet can be repeated and each reseed mints a supply of exactly one per NFT.

**This tool works on preprod only.** It checks that the chain endpoint reports protocol magic 1 and refuses to build or sign anything otherwise, every address it makes has network ID 0, and every transaction carries network ID 0. The mnemonics it prints control test funds with no value. Never restore one into a mainnet wallet and never reuse a mainnet mnemonic here.

## Install

Node 20 (see `.nvmrc` at the repository root) is required. From this folder:

```
npm ci
node src/cli.mjs help
```

The tool has its own `package.json` and lockfile. It does not touch the app's dependencies, lint or build. `npm test` reproduces the published key and address test vectors listed under Specifications.

## Where secrets live

Mnemonics are stored outside the repository, in `${XDG_DATA_HOME:-$HOME/.local/share}/unfrackit-preprod-seeder/`. Set `PREPROD_SEEDER_HOME` to use a different directory. The directory is created with mode 0700 and every file in it with mode 0600. The mnemonic files are plain text. Nothing secret is printed except by the `mnemonic` command.

## Funding

1. Run `node src/cli.mjs init`. It creates the home directory and a funder wallet, then prints the funder's preprod address.
2. Send test ADA to that address from one of your own testnet wallets, or request it from the preprod faucet at https://docs.cardano.org/cardano-testnets/tools/faucet.
3. Run `budget` to see how much a seed needs.

The funder uses only pure-ADA UTxOs as fee and layout inputs. A token under a foreign policy that a sweep returns to the funder sits in its own UTxO and is left alone.

## Commands

| Command | What it does |
|---|---|
| `init` | Creates the home directory and the funder wallet (24 words) and prints the funder's address. Safe to run again. |
| `shapes` | Lists the 17 shapes. |
| `address <shape or funder>` | Prints the address. A shape that uses three payment keys (S7) prints all three. |
| `mnemonic <shape or funder>` | Prints the 24-word mnemonic, with a line on standard error saying it is for preprod only. |
| `budget [shapes...]` | A dry run. Builds every transaction a seed would submit, with exact sizes and fees from the current protocol parameters, and prints per shape the number of transactions, the tADA locked in the layout and the tADA spent in fees. It uses throwaway keys, reads no secret and submits nothing. |
| `seed <shape>` | Creates the shape wallet (its own 24-word mnemonic, account 0) if absent, mints the tokens from the funder, and lays out the UTxOs at the shape wallet's addresses. Transactions are chained by spending earlier outputs before they confirm, then the command waits for confirmation. `--no-wait` returns after submission. An interrupted seed resumes from a journal kept in the home directory. It refuses if the shape wallet already holds UTxOs. |
| `verify <shape>` | Queries the shape wallet's UTxOs and compares them with the specification: count, assets per UTxO, coin, inline datum and reference script. Exits non-zero on any difference. |
| `sweep <shape>` | Burns every token under the tool's own policies (the funder holds their keys), returns all the ADA to the funder, and returns any token under a foreign policy unburned, repacked under the value-size limit. |
| `reset <shape>` | Sweeps, waits for confirmation, then seeds again. |

Chain access is Koios preprod (`https://preprod.koios.rest/api/v1`, public tier, no token) for protocol parameters, address UTxOs, transaction submission and transaction status. Requests are spaced out and a 429 response is retried with the server's wait. `PREPROD_SEEDER_KOIOS_URL` overrides the endpoint; the tool still refuses any endpoint that is not preprod.

## Restoring a shape wallet into an extension

1. Run `mnemonic <shape>` and copy the 24 words.
2. In a CIP-30 browser wallet extension that offers the Cardano preprod network, switch it to Preprod and restore a wallet from the mnemonic. Use the standard recovery path, not a hardware-wallet one.
3. The wallet is account 0 of the CIP-1852 hierarchy. Every UTxO sits at an external payment address with the account's stake key, so the extension finds it within its default gap limit. S7 uses external indexes 0, 1 and 2; every other shape uses index 0 only.

Connect UnFrack.It to that wallet and run the analysis. Run `verify <shape>` at any time to compare the chain with the specification, and `reset <shape>` to put the wallet back after a test.

## Policies

Tokens are minted under native-script policies that each require one signature. The signing keys come from the funder mnemonic at `m/1855'/1815'/N'` (CIP-1855), so policy IDs are the same on every run and the funder can always mint or burn more. A shape with index `s` in the order of the table below uses `N = 128 * s + k` for its `k`-th policy, so policy IDs never collide between shapes (M3 needs 100 of its 128). A sweep burns tokens under any policy in these blocks and returns tokens under any other policy unburned.

Policy IDs on chain come from real scripts, so a seeded wallet matches its shape up to a one-to-one substitution of policy IDs. Asset names, quantities, coin values, the grouping of assets into UTxOs and byte sizes are exactly as specified. M1's output holds as many 32-byte-name NFTs as fit in 5,000 value bytes (141, 4,974 bytes; one more makes 5,009) and carries exactly its minimum coin.

## The 17 shapes

Pure-ADA UTxOs hold only ADA. "One per UTxO" means each NFT or fungible piece sits in a UTxO of its own. A token UTxO holds its minimum ADA plus a surplus: 0 to 5 ADA in S2 to S9 and M5 (none in S2b), 0 to 1 ADA in M2, M3, M4 and M8, and none in M1 and M7. tADA locked is the ADA that sits in the layout at the current minimum-UTxO parameter; it comes back to the funder on a sweep, while the tokens are burned.

| Shape | What it holds | UTxOs | tADA locked |
|---|---|---|---|
| S1 | three pure-ADA UTxOs of 50 ADA | 3 | 150.0 |
| S2 | 60 NFTs of one policy, one per UTxO, and 2 pure-ADA UTxOs | 62 | 211.8 |
| S2b | the 60 NFTs of S2 in one UTxO at its exact minimum coin, and 2 pure-ADA UTxOs; meant for the setting that turns ADA roll-up off | 3 | 15.8 |
| S3 | 90 NFTs over 9 policies, one per UTxO, and 5 pure-ADA UTxOs | 95 | 355.0 |
| S4 | 20 fungible tokens of 20 policies and 100 pure-ADA UTxOs of 2 to 3 ADA | 120 | 320.9 |
| S5 | 300 NFTs over 30 policies, one per UTxO, and 20 pure-ADA UTxOs | 320 | 1,226.5 |
| S6 | 400 NFTs over 40 policies, 60 fungible UTxOs of 6 policies (each fungible over 10 UTxOs), and 40 pure-ADA UTxOs | 500 | 1,922.1 |
| S7 | the layout of S3 spread over 3 payment keys (external indexes 0, 1, 2) | 95 | 355.0 |
| S8 | 10 NFTs, an NFT on a UTxO carrying an inline datum, and a UTxO carrying a reference script, both at the wallet's own key address | 12 | 35.2 |
| S9 | 200 NFTs over 20 policies and 10 fungibles of 5 policies, each fungible split over three pieces; the 230 pieces shuffled into 61 UTxOs of 1 to 6 pieces; and 10 pure-ADA UTxOs | 71 | 302.6 |
| M1 | one UTxO of 141 NFTs of one policy (32-byte names) at the value-size cap and at its minimum coin, and pure-ADA UTxOs of 12 and 8 ADA | 3 | 42.4 |
| M2 | 3,000 NFTs of one policy, one per UTxO, and 5 pure-ADA UTxOs of 10 ADA | 3,005 | 5,107.1 |
| M3 | 3,000 NFTs over 100 policies (30 each), one per UTxO, and 5 pure-ADA UTxOs of 10 ADA | 3,005 | 5,056.1 |
| M4 | 5 fungible assets of 5 policies, each over 100 UTxOs (500 to 1,500 per UTxO), and 10 pure-ADA UTxOs of 2 to 5 ADA | 510 | 856.7 |
| M5 | the layout of S6, meant for the setting that packs outputs to the value cap | 500 | 1,922.1 |
| M7 | the layout of M1 with only 2 ADA of pure ADA (two UTxOs of 1 ADA), the shortfall case | 3 | 24.4 |
| M8 | CIP-67 labeled tokens (20 NFTs with label 222, 3 fungibles with label 333, 2 with label 444) and 5 unlabeled NFTs, one per UTxO | 30 | 49.8 |

There is no M6. Shapes are generated from fixed seeds, so the same shape is the same on every machine. The M8 labeled names carry the CIP-67 four-byte prefix in front of the name, so their asset names are not printable ASCII. The fungibles of label 333 share one policy and the fungibles of label 444 share another. One of the three 333 assets and one of the two 444 assets have a total quantity of 1.

## Specifications

The code cites these by number and section where it relies on them.

- CIP-1852 (HD derivation): `m/1852'/1815'/account'/role/index`, role 0 for payment keys and role 2 for the stake key.
- CIP-1855 (forging policy keys): `m/1855'/1815'/policy_ix'`.
- CIP-19 (addresses): base addresses with a payment key hash and a stake key hash, network tag 0 for testnets.
- CIP-67 and CIP-68: the four-byte asset name label prefix `[0000 | label | crc8 | 0000]` and the 100, 222, 333 and 444 labels.
- CIP-3: the Icarus master key derivation used by extensions.

`npm test` checks the CIP-3 Icarus master key vector, the CIP-11 vector for the key at `m/1852'/1815'/0'/2/0` and its reward address, the CIP-19 base address vectors and the CIP-67 label vectors.

## Limits

- Every transaction is built and checked against the live maximum transaction size, maximum value size and minimum-UTxO parameter, and carries the exact minimum fee.
- A shape that locks more than the funder holds is refused with the shortfall. Seeding every shape at once needs about 18,000 tADA plus about 62 tADA of fees; the largest, M2 and M3, need about 5,100 tADA each.
- Each shape wallet is expected to hold only its own layout. `seed` refuses a wallet that already holds UTxOs; use `sweep` first.

## License

The tool's code is licensed under Apache-2.0 (see `LICENSE`). This README is licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
