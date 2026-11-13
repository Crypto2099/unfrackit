// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The pinned source of AdaLite's planner, which no package publishes:
// vacuumlabs/adalite at e7522c2, the commit after the v7.0.2 release commit
// 86dd006 (it changes only .yarnrc.yml, package.json and yarn.lock, so the
// wallet code is v7.0.2's). scripts/build-adalite.mjs takes the paths below
// from a clone, checks each one's git object hash against these pins,
// bundles the modules the planner loads into the gitignored directory
// OUTPUT_DIR and records the commit, the hashes and the bundle's SHA-256
// beside it (BUILD_RECORD). methods/adalite.mjs refuses to load a build whose
// record differs from these pins. Nothing of the wallet's source is kept in
// the repository.
//
// The wallet's send path (app/frontend/actions/common.ts:44-52,
// prepareTxPlan) is Account(...).getTxPlan (wallet/account.ts:348-355):
// arrangeUtxos (:306-340), then selectMinimalTxPlan (wallet/shelley/
// transaction/shelley-transaction-planner.ts:194-223) over computeTxPlan and
// validateTxPlan (computeTxPlan.ts:37-381). The method runs that planner on
// each spend's requested outputs (methods/adalite.mjs): Account's arrangeUtxos
// and selectMinimalTxPlan's loop over the bundle's computeTxPlan and
// validateTxPlan, and getTxPlan itself for the tests that compare the two.
// The transaction is ShelleyTxAux
// (wallet/shelley/shelley-transaction.ts:54-130), which Account.prepareTxAux
// (wallet/account.ts:240-268) fills from the plan, and
// ShelleySignedTransactionStructured with cborizeTxWitnesses (:289-346),
// which the wallet's signer assembles (wallet/shelley/
// shelley-js-crypto-provider.ts:225-238). The modules they load, with
// TypeScript's type-only imports left out, lie in the three directories and
// two files below; the build fails if the bundle reads any other file of the
// repository. Their packages are bignumber.js, cardano-crypto.js, cbor and
// lodash, which the tool installs at the versions the repository's yarn.lock
// resolves for app/package.json's ranges, and Node's assert.

export const ADALITE_REPO = 'https://github.com/vacuumlabs/adalite.git';
export const ADALITE_COMMIT = 'e7522c2d84dd5f34f0381e613978577bf28666fd';
export const ADALITE_RELEASE = 'v7.0.2 (86dd006) and one dependency commit';

export const ADALITE_SRC = 'app/frontend';

// path -> [git object type, object hash] at ADALITE_COMMIT.
export const ADALITE_PATHS = Object.freeze({
  'app/frontend/wallet': Object.freeze(['tree', 'fac07bbc401a95cbffcb45c11653000dbaccb489']),
  'app/frontend/errors': Object.freeze(['tree', 'ff7d7e27e7f3eedf375189127adaa1b08741419b']),
  'app/frontend/helpers': Object.freeze(['tree', 'd5773a3bc618ff5f321a5a3400088be4d7599cc9']),
  'app/frontend/types.ts': Object.freeze(['blob', '80ae24cc5d8303ef843c802b89367b5b15bc8c7e']),
  'app/frontend/config.ts': Object.freeze(['blob', '64c988e8ce29abd5ed7160a79dd7c60f5a5ce99b'])
});

// The repository has no license file; both manifests declare ISC
// (package.json:20, app/package.json:15). The app's manifest gives the
// packages' ranges and yarn.lock their resolved versions.
export const ADALITE_LICENSE = 'ISC';
export const ADALITE_ROOT_MANIFEST = Object.freeze(['package.json', 'blob', '8ffa8d90033579c0fea01272bf7a908c763d29cd']);
export const ADALITE_MANIFEST = Object.freeze(['app/package.json', 'blob', '60e42b1efb2ef1db544ae06ba51836886fbce136']);
export const ADALITE_LOCK = Object.freeze(['yarn.lock', 'blob', '708c51a5f4f66407f20826c2281cbcd0f06efa57']);

// The packages the bundle loads, at the versions yarn.lock resolves.
export const ADALITE_PACKAGES = Object.freeze({
  'bignumber.js': '9.3.1',
  'cardano-crypto.js': '6.1.2',
  cbor: '8.1.0',
  lodash: '4.18.1'
});

// Under the tool's directory.
export const OUTPUT_DIR = 'build/wallets/adalite';
export const BUNDLE = 'adalite-send.cjs';
export const BUILD_RECORD = 'source.json';
export const BUILD_SCRIPT = 'scripts/build-adalite.mjs';

// What the bundle exports, from the entry the build script writes in
// app/frontend.
export const ENTRY = `export { Account } from './wallet/account';
export { ShelleyTxAux, ShelleySignedTransactionStructured, cborizeTxWitnesses } from './wallet/shelley/shelley-transaction';
export { encodeCbor } from './wallet/helpers/cbor';
export { computeMinUtxoLovelaceAmount, txFeeFunction } from './wallet/shelley/transaction/utils';
export { computeTxPlan, validateTxPlan } from './wallet/shelley/transaction/computeTxPlan';
export { MAX_TX_SIZE, MAX_TX_OUTPUT_SIZE } from './wallet/constants';
export { MAX_OUTPUT_TOKENS } from './wallet/shelley/transaction/constants';
export { InternalErrorReason, UnexpectedErrorReason } from './errors';
export { TxType, AssetFamily } from './types';
`;

// The build's two departures from compiling the files as they are, each
// recorded in BUILD_RECORD:
// - a namespace import of a CommonJS package that the module then calls
//   (import * as _ from 'lodash'; _(...), and the same for assert) is compiled
//   as a default import. Under the wallet's webpack build the namespace of a
//   CommonJS module is the module itself, so _ is lodash's function; under
//   esbuild it would be a copy that cannot be called. NAMESPACE_CALLS lists the
//   packages.
// - config.ts reads the page's data-config attribute at load
//   (document.body.getAttribute). The bundle declares a module-local
//   `document` whose body has no such attribute, so ADALITE_CONFIG is {}, as
//   on a page that sets none (helpers/debugLog.ts:4-5 notes the same for the
//   wallet's own tests). Nothing on the planner's path reads ADALITE_CONFIG.
export const NAMESPACE_CALLS = Object.freeze(['lodash', 'assert']);
export const BANNER = '// Module-local stand-in for the page: no data-config attribute (app/frontend/config.ts).\nconst document = { body: { getAttribute: () => null } };';
