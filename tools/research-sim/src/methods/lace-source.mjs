// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The pinned source of Lace's transaction builder, which no package publishes:
// input-output-hk/lace at the release commit of lace-extension 2.5.1, its
// private package @lace-contract/cardano-context. scripts/build-lace.mjs takes
// these paths from a clone, checks each one's git object hash against the
// pins below, bundles them into the gitignored directory OUTPUT_DIR and
// records the commit, the hashes and the bundle's SHA-256 beside it
// (BUILD_RECORD). methods/lace.mjs refuses to load a build whose record
// differs from these pins. Nothing of the wallet's source is kept in the
// repository.
//
// The paths the bundle compiles: the two directories the build path runs
// (tx-builder, input-selection) and the three modules they import beside
// them. Their other imports are @cardano-sdk/core, crypto and tx-construction,
// which the tool installs at the versions that package's package.json pins
// (lines 8 to 12), and type-only imports (src/types.ts, common/types.ts),
// which compile to nothing.

export const LACE_REPO = 'https://github.com/input-output-hk/lace.git';
export const LACE_COMMIT = '4d553bd696903c7a78652ab61da5237165008195';
export const LACE_RELEASE = 'lace-extension@2.5.1';

const SRC = 'packages/contract/cardano-context/src';
export const LACE_SRC = SRC;

// path -> [git object type, object hash] at LACE_COMMIT.
export const LACE_PATHS = Object.freeze({
  [`${SRC}/tx-builder`]: Object.freeze(['tree', '7de158d96348be817f9f074145ebf1df5d116103']),
  [`${SRC}/input-selection`]: Object.freeze(['tree', '5e92b2b644f8379f42cc2f858eaa2bc6b65f413e']),
  [`${SRC}/signing/getUniqueSigners.ts`]: Object.freeze(['blob', 'e2344db94333a32aff2cc1b4bf15308460c64d28']),
  [`${SRC}/estimate-signed-tx-size.ts`]: Object.freeze(['blob', '9d9a7f3459c6fecde618aade5513363a8b76b686']),
  [`${SRC}/common/time.ts`]: Object.freeze(['blob', '8d2947755d26cc3fe92020faaa94ae38d09dc3c9'])
});

// The repository's license (Apache-2.0), copied beside the bundle, and the
// package's manifest, whose dependency pins the tool follows.
export const LACE_LICENSE = Object.freeze(['LICENSE', 'blob', '13d1bef4128d5f41829c0bcb62814fb17668475c']);
export const LACE_MANIFEST = Object.freeze(['packages/contract/cardano-context/package.json', 'blob', '15fb4a5cfea3cfaa02593187bfb2b19d873e0f5b']);

// The @cardano-sdk packages the bundle imports, at the manifest's versions.
export const LACE_SDK = Object.freeze({
  '@cardano-sdk/core': '0.47.1',
  '@cardano-sdk/crypto': '0.4.7',
  '@cardano-sdk/tx-construction': '0.29.1'
});

// Under the tool's directory.
export const OUTPUT_DIR = 'build/wallets/lace';
export const BUNDLE = 'cardano-context.cjs';
export const BUILD_RECORD = 'source.json';
export const BUILD_SCRIPT = 'scripts/build-lace.mjs';

// What the bundle exports, from the entry the build script writes.
export const ENTRY = `export { TransactionBuilder, InsufficientCollateralError } from './tx-builder/TransactionBuilder';
export { EvaluatedFeeShortfallError } from './tx-builder/balancing';
export { RoundRobinRandomCoinSelector } from './input-selection/RoundRobinRandomCoinSelector';
export { LargeFirstCoinSelector } from './input-selection/LargeFirstCoinSelector';
export { InputSelectionError, InputSelectionFailure } from './input-selection/InputSelectionError';
export { SLOT_CONFIG_NETWORK, resolveSlotNo } from './common/time';
export { getUniqueSignerKeyHashes } from './signing/getUniqueSigners';
`;
