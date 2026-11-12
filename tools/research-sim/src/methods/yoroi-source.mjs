// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The pinned source of the Yoroi wallet's send flow, which no package
// publishes: Emurgo/yoroi at the v7.0.5 release commit, the mobile app's own
// modules. scripts/build-yoroi.mjs takes these paths from a clone, checks
// each one's git object hash against the pins below, bundles the send flow
// into the gitignored directory OUTPUT_DIR and records the commit, the hashes,
// the npm packages and the bundle's SHA-256 beside it (BUILD_RECORD).
// methods/yoroi.mjs refuses to load a build whose record differs from these
// pins. Nothing of the wallet's source is kept in the repository.
//
// The paths the bundle compiles, under mobile/packages/: cardano-wallet and
// tx, and the Yoroi packages they import on the send path (api, common,
// logger, portfolio, types). Their package name imports (@yoroi/tx and so on)
// resolve as mobile/tsconfig.json:28-52 maps them, to packages/<name>.
//
// @emurgo/cross-csl-mobile, the app's bridge to its native CSL build, is
// replaced by @emurgo/cross-csl-nodejs over cardano-serialization-lib 14.1.2
// for Node, as Yoroi's own test setup replaces it (mobile/jest.setup.js:41,
// mobile/__mocks__/@emurgo/cross-csl-mobile.js:1). The two bridge packages
// and immer come from the npm registry at the versions and integrities
// mobile/package-lock.json records, checked against the tarballs, and are
// bundled in. cardano-serialization-lib 14.1.2 is not bundled: the bundle
// loads it at run time under the npm alias CSL_ALIAS, whose integrity is the
// one Yoroi's lockfile records for @emurgo/cardano-serialization-lib-nodejs.
// The alias keeps it apart from the treatment's CSL 17.0.0, which every other
// method loads (methods/csl.mjs).

export const YOROI_REPO = 'https://github.com/Emurgo/yoroi.git';
export const YOROI_COMMIT = 'd8e3d3f93fb772f0b6bd2296e45bfac7da4fb9d6';
export const YOROI_RELEASE = 'v7.0.5';

const PK = 'mobile/packages';
export const YOROI_PACKAGES = PK;

// path -> [git object type, object hash] at YOROI_COMMIT.
export const YOROI_PATHS = Object.freeze({
  [`${PK}/api`]: Object.freeze(['tree', '7eb29f4f39e4787890a15d5076ecd5cc45612c7b']),
  [`${PK}/cardano-wallet`]: Object.freeze(['tree', 'cb18018a30bdf5ed292cdda8fb228ec96143cfed']),
  [`${PK}/common`]: Object.freeze(['tree', '2642204767a5c47d3158ab114a6af712b2ccff7b']),
  [`${PK}/logger`]: Object.freeze(['tree', 'be69459829864c305a024084fc0b93bd29681484']),
  [`${PK}/portfolio`]: Object.freeze(['tree', 'be3c81063e0f987c2afaf923623c3d68b946c57d']),
  [`${PK}/tx`]: Object.freeze(['tree', '21ad31a268f3ad767dd7153669543a705fe815e6']),
  [`${PK}/types`]: Object.freeze(['tree', '301308faf01bbf7994dba00113deb8fda7f24fef'])
});

// The repository's license (Apache-2.0), copied beside the bundle, and the
// app's lockfile, whose npm pins the build follows.
export const YOROI_LICENSE = Object.freeze(['LICENSE', 'blob', 'c3cd12fb4460184d5d8bc7241a7836415481bfc8']);
export const YOROI_LOCKFILE = Object.freeze(['mobile/package-lock.json', 'blob', 'c07155ebd9b325f1eff61ac1c3be4ab77260e64a']);

// The npm packages bundled in, as the lockfile records them.
export const YOROI_NPM = Object.freeze({
  '@emurgo/cross-csl-nodejs': Object.freeze({ version: '8.0.0-alpha.1', integrity: 'sha512-eeFlLZllmfqy3gEwvF+ZOu/Jo5RwX8wRc9UhGkcd/LbukxvnbbqhIySfFR/ydCkyO/zH51kcRQ+KJQXJ9H9vIQ==' }),
  '@emurgo/cross-csl-core': Object.freeze({ version: '8.0.0-alpha.1', integrity: 'sha512-CZYjDQ5L4lORY7EYWH1zW3+Ku3r5VktKYWAu5KUtKF/bDOq0DEi383ivm+G687KzWPaLSPgCMRir5w9Wd3Dc0w==' }),
  immer: Object.freeze({ version: '10.1.1', integrity: 'sha512-s2MPrmjovJcoMaHtx6K11Ra7oD05NT97w1IC5zpMkT6Atjr7H8LjaDd81iIxUYpMKSRRNMJE703M1Fhr/TctHw==' })
});

// cardano-serialization-lib, as the lockfile records it, loaded at run time
// under CSL_ALIAS (package.json).
export const YOROI_CSL = Object.freeze({ package: '@emurgo/cardano-serialization-lib-nodejs', version: '14.1.2', integrity: 'sha512-g8sxCEaQXqRt4A3zmhebuo+pMucVDs/4FlkUD+J+awJCJMAkK7eCFBEb09d8+jREec687D5fY+FG9NemExSQhQ==' });
export const CSL_ALIAS = 'cardano-serialization-lib-nodejs-14.1.2';

// Under the tool's directory.
export const OUTPUT_DIR = 'build/wallets/yoroi';
export const BUNDLE = 'yoroi-send.cjs';
export const BUILD_RECORD = 'source.json';
export const BUILD_SCRIPT = 'scripts/build-yoroi.mjs';

// What the bundle exports, from the entry the build script writes under
// mobile/packages: createSendTx and the conversion of the wallet's UTxO
// records, the call createSendTxFromWallet makes (cardano-wallet/
// transaction-recipes/wallet-helpers.ts:287-322 and :43-53), and the
// logger's setter (logger/logger.ts:7-39).
export const ENTRY = `export { createSendTx } from './cardano-wallet/transaction-recipes/createSendTx';
export { convertRawUtxosToModernUtxos } from './cardano-wallet/transaction-recipes/helpers';
export { setLogger, noOpLogger } from './logger';
`;
