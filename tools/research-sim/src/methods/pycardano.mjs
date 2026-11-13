// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The PyCardano baseline, pycardano-lf: PyCardano's transaction builder at
// its defaults (pycardano 0.19.2 from PyPI, whose package equals
// pycardano/ of Python-Cardano/pycardano at the release tag's commit
// 0445f3079cb8b356f48c13e040d00e25326ce59e), run in the pycardano helper (helpers/pycardano,
// built by scripts/build-helpers.mjs pycardano) through the bridge
// (methods/helper.mjs).
//
// The call (helpers/pycardano/main.py): TransactionBuilder(context),
// add_input_address for each address of the wallet's spendable UTxOs in the
// order each first appears in the state's order (library.mjs inputOrder),
// add_output with each requested output decoded from its own bytes, the
// replay's fixed parts through the builder's operations, then
// build(change_address=the change address), and the witness set
// build_and_sign writes (txbuilder.py:1254-1491, :1724). The chain
// context is the replay's state: the run's protocol parameters, the network,
// the spend's slot, and the wallet's UTxOs by address in the state's order;
// nothing reaches a network.
//
// The default selectors are [LargestFirstSelector(),
// RandomImproveMultiAsset()] (txbuilder.py:107-109). build() asks them for the
// outputs, any burn and the fee of the transaction as it stands before
// selection, less what the fixed inputs, mint and withdrawals provide, plus
// the change's minimum when that remainder is short of it
// (txbuilder.py:1306-1386). The pool is the UTxOs of the input addresses,
// each address's in the context's order, the addresses in the order they
// were added (txbuilder.py:1400-1415). LargestFirstSelector sorts the pool by
// lovelace, a stable ascending sort, and takes from its end until the whole
// requested value is covered, then makes one more pass for any change minimum
// still short (coinselection.py:73-132); among equal lovelace it therefore
// takes the UTxO latest in the pool first. Only if it raises (an exhausted
// pool) does RandomImproveMultiAsset run (txbuilder.py:1417-1463,
// coinselection.py:135-341), whose draws come from Python's module random
// (coinselection.py:166): the helper seeds it with random.seed(seed) from
// the request's seed before each build, so the method is seeded and not
// deterministic, and L/own and L/layout of one repetition draw alike.
// LargestFirstSelector adds what it takes onto the existing amount build()
// hands every selector (txbuilder.py:1429, coinselection.py:98 and :105,
// Value.__iadd__ changing the object in place, transaction.py:301-305), so
// the fallback starts from that sum with none of those UTxOs selected, and
// its minimum-change pass for that sum draws from the whole pool. The
// selected inputs are sorted by transaction id and index
// (txbuilder.py:1465-1467). The change (txbuilder.py:628-770): the fee
// estimated with the change, two passes; ADA-only change one output, refused
// under its minimum (never burned); token change packed per policy under
// maxValSize, every output but the last at its minimum and the last holding
// the remaining ADA.
//
// The helper's process runs with an empty environment and PYTHONHASHSEED=0
// (the launcher, scripts/build-helpers.mjs), so the reference inputs, which
// the builder keeps in a Python set (txbuilder.py:140-142), are written in
// the same order on every run, and the library's CBOR module is its default
// pure-Python one (pycardano/cbor.py: CBOR_C_EXTENSION unset).
//
// Parameters: the run's, as PyCardano's ProtocolParameters, with the
// reference-script fee tiers as the node reports them (a 25,600-byte range
// priced up by 1.2, at most 204,800 bytes) and the execution-unit limit per
// transaction, which the run does not carry, at 16,500,000 memory and
// 10,000,000,000 steps; PyCardano reads that limit only in max_tx_fee, for
// the fee field of its first estimate and for its collateral amount, 150% of
// that maximum fee (txbuilder.py:1527-1531). The run holds no cost models,
// so the script-data hash is over empty ones; its size is exact.
//
// Witnesses: build() writes no vkey witness; the bridge has the helper write
// one synthetic witness per wallet key, then the intent's other vkey
// witnesses as observed, as a tag-258 set in the library's witness set. Its
// fee priced _witness_count() keys (txbuilder.py:1091-1101); when the
// observed witnesses outnumber them the response names them unpriced.
//
// The replay path (main.py with_fixed_parts), each part through the
// builder's own operation or field before build():
//   fixed inputs        add_input; a script input with its redeemer, or whose
//                       native script is a reference script, add_script_input
//                       (txbuilder.py:211-349)
//   reference inputs    reference_inputs
//   native scripts      native_scripts, from the witness set
//   Plutus scripts      by hash, from the witness set or a reference input,
//                       to the operation of the part each script serves
//   datums              datums (the witness set's, as their own bytes)
//   redeemers           with the observed units (so the builder evaluates
//                       nothing), and as their own data bytes, to
//                       add_script_input, add_minting_script,
//                       add_withdrawal_script or add_certificate_script
//   mint and burn       mint, and add_minting_script for a Plutus policy or a
//                       native one from a reference input
//   certificates        certificates, each in turn, a script one's redeemer
//                       attached after it
//   withdrawals         withdrawals
//   votes, proposals    voting_procedures, proposal_procedures
//   required signers    required_signers
//   validity            ttl, validity_start
//   treasury, donation  current_treasury_value, add_treasury_donation
//   auxiliary data      auxiliary_data, decoded by the library (metadata and
//                       auxiliary scripts)
//   collateral          collaterals, the UTxO the engine set aside; the
//                       builder writes its return and total
//                       (txbuilder.py:1507-1611)
// Not replayable: body field 6 (kit/replay.mjs replayRefusal); a body field
// none of the operations above writes; a bootstrap witness, which no
// operation writes; a redeemer of a vote or a proposal, which no operation
// attaches. The builder adds what its build() adds to any transaction with a
// script, native ones included (txbuilder.py:1288-1304, :1470-1477): a
// validity interval from the context's slot when the intent has none, and
// the inputs' key hashes as required signers when the intent has none.
//
// The layout change (opts.changePolicy 'layout'): the library builds its
// transaction exactly as for its own change; the bridge reads the wallet
// inputs it selected from that transaction, drops its change, and builds the
// simulator's layout change on those inputs (methods/change.mjs). A build the
// library refuses fails before this point, as for its own change: build()
// selects and makes its change in one call.
//
// Errors to failure classes (the helper reports each as the exception's
// class name and the first line of its message; the rest 'other'):
//   UTxOSelectionException "All UTxO selectors failed" (txbuilder.py:1438-
//   1463); InvalidTransactionException "The input UTxOs cannot cover the
//   transaction outputs and tx fee" (txbuilder.py:651-660)       balance
//   InsufficientUTxOBalanceException "Not enough ADA left for change" and
//   "Not enough ADA left to cover non-ADA assets in a change address"
//   (txbuilder.py:670-699)                                   change-minimum
//   InvalidTransactionException "Transaction size (N) exceeds the max limit
//   (M)" (txbuilder.py:1149-1156)                                  tx-size
//   ValueError "Minimum collateral amount N is greater than total provided
//   collateral inputs" and "Minimum lovelace amount for collateral return N
//   is greater than collateral change" (txbuilder.py:1588-1607)  collateral

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { CLASSES } from '../kit/check.mjs';
import { REPLAY_COVERAGE } from './library.mjs';
import { helperMethod, helperBuild } from './helper.mjs';

export const PYCARDANO_VERSION = '0.19.2';
export const PYCARDANO_COMMIT = '0445f3079cb8b356f48c13e040d00e25326ce59e';
export const PYCARDANO_PYTHON = '3.12';
export const SITE_PACKAGES = `lib/python${PYCARDANO_PYTHON}/site-packages`;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// The SHA-256 of a virtual environment's site-packages: of each file's path
// and SHA-256, in path order, leaving out what depends on where the
// environment was made or on the interpreter's runs (compiled bytecode in
// __pycache__, and each distribution's RECORD, which hashes the launch
// scripts that name the environment's path).
export function environmentHash(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== '__pycache__') walk(p);
      } else if (e.isFile() && !e.name.endsWith('.pyc') && !(e.name === 'RECORD' && d.endsWith('.dist-info'))) files.push(relative(dir, p));
    }
  };
  walk(dir);
  files.sort();
  const h = createHash('sha256');
  for (const f of files) h.update(`${f}\0${sha256(readFileSync(join(dir, f)))}\0`);
  return { hash: h.digest('hex'), files: files.length };
}

// The launcher the build writes as the helper's executable.
export function launcherText({ main, environment, python }) {
  return [
    '#!/bin/sh',
    `# The PyCardano helper: main.py (sha256 ${main}) in the virtual`,
    `# environment beside it (${python}, site-packages sha256 ${environment}),`,
    '# with an empty environment, a fixed hash seed, no user site and no',
    '# bytecode written.',
    'd=$(dirname "$0")',
    'exec env -i PYTHONHASHSEED=0 "$d/venv/bin/python" -P -s -B "$d/main.py"',
    ''
  ].join('\n');
}

const ERROR_CLASSES = [
  [/^UTxOSelectionException: All UTxO selectors failed/, CLASSES.balance],
  [/^InvalidTransactionException: The input UTxOs cannot cover the transaction outputs and tx fee/, CLASSES.balance],
  [/^InsufficientUTxOBalanceException: Not enough ADA left for change/, CLASSES.changeMinimum],
  [/^InsufficientUTxOBalanceException: Not enough ADA left to cover non-ADA assets in a change address/, CLASSES.changeMinimum],
  [/^InvalidTransactionException: Transaction size \(\d+\) exceeds the max limit \(\d+\)/, CLASSES.txSize],
  [/^ValueError: Minimum collateral amount \d+ is greater than total provided collateral inputs/, CLASSES.collateral],
  [/^ValueError: Minimum lovelace amount for collateral return \d+ is greater than collateral change/, CLASSES.collateral]
];

export function classOfPycardanoError(text) {
  for (const [re, cls] of ERROR_CLASSES) if (re.test(text)) return cls;
  return CLASSES.other;
}

// Why the build's environment or main.py differ from its record, or null;
// checked once per process and build.
const CHECKED = new Map();
function environmentProblem(record) {
  const dir = dirname(record.path);
  const key = `${dir}\0${record.sha256}`;
  if (CHECKED.has(key)) return CHECKED.get(key);
  let problem = null;
  const main = join(dir, 'main.py');
  const site = join(dir, 'venv', SITE_PACKAGES);
  if (!existsSync(main) || sha256(readFileSync(main)) !== record.main) problem = 'its main.py differs from the build record';
  else if (!existsSync(site) || !record.environment || environmentHash(site).hash !== record.environment.hash) problem = 'its virtual environment differs from the build record';
  CHECKED.set(key, problem);
  return problem;
}

export function pycardanoMethod(T) {
  const name = 'pycardano-lf';
  const hint = 'run node scripts/build-helpers.mjs pycardano';
  const { problem, record } = helperBuild('pycardano');
  if (problem) throw new Error(`${name}: ${problem}`);
  const mod = record.modules && record.modules.pycardano;
  if (!mod || mod.version !== PYCARDANO_VERSION) throw new Error(`${name}: the pycardano helper was built with ${mod ? `pycardano ${mod.version}` : 'no pycardano'}, not ${PYCARDANO_VERSION}; ${hint}`);
  const env = environmentProblem(record);
  if (env) throw new Error(`${name}: the pycardano helper's build differs from the tree (${env}); ${hint}`);
  return helperMethod(T, {
    name,
    version: `PyCardano ${PYCARDANO_VERSION} (${PYCARDANO_COMMIT.slice(0, 7)}) LargestFirstSelector, RandomImproveMultiAsset fallback; helper pycardano sha256 ${record.sha256.slice(0, 16)}`,
    deterministic: false,
    seeded: true,
    library: 'pycardano',
    coverage: REPLAY_COVERAGE.pycardano,
    classify: classOfPycardanoError,
    refused: 'the PyCardano baseline takes its own change or the layout change only',
    process: { key: name, command: record.path, args: [] }
  });
}
