// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The pinned source of the Cardano Transaction Lib balancer, which is
// PureScript and published to no JavaScript registry: CTL
// (Plutonomicon/cardano-transaction-lib) at its v10.0.1 release commit, whose
// package set (spago-packages.nix, the file CTL's own build reads) pins every
// PureScript package by repository and commit, the balancer
// (purescript-cardano-transaction-balancer v2.0.1) among them, and whose npm
// lockfile pins the JavaScript its foreign modules import.
// scripts/build-ctl.mjs takes the pinned files from a clone of CTL, checks
// each one's git object hash, fetches each package of the set at its commit,
// compiles the simulator's entry module (scripts/ctl/Entry.purs) with the
// modules it imports using the PureScript compiler the CTL build names
// (purs 0.15.8, nix/default.nix:35), installs the lockfile's npm packages,
// bundles the compiled JavaScript with them into the gitignored OUTPUT_DIR
// and records the commit, the hashes, the compiler, the packages and the
// bundle's SHA-256 beside it (BUILD_RECORD). methods/ctl.mjs refuses to load a
// build whose record differs from these pins. Nothing of CTL's source or of
// its packages is kept in the repository.

export const CTL_REPO = 'https://github.com/Plutonomicon/cardano-transaction-lib.git';
export const CTL_COMMIT = '5f960b9351b43a490ad379f2dca12daba0b83683';
export const CTL_RELEASE = 'v10.0.1';

// path -> [git object type, object hash] at CTL_COMMIT: the package set, the
// npm manifest and lockfile, and the license (MIT), copied beside the bundle.
export const CTL_PATHS = Object.freeze({
  'spago-packages.nix': Object.freeze(['blob', '522e1d07da498157d35334b688ee1abca3ea9341']),
  'package.json': Object.freeze(['blob', 'a3ae9a1c58d49f3078565bc3b9201417386c172f']),
  'package-lock.json': Object.freeze(['blob', 'f6ba78606943f18f3fe5920b8adc93fd9fc70ad4']),
  LICENSE: Object.freeze(['blob', '2d81c86b8e604e416f231863f086e553105245c9'])
});

// The balancer as the package set pins it (spago-packages.nix:332-339).
export const BALANCER = Object.freeze({
  name: 'cardano-transaction-balancer',
  version: 'v2.0.1',
  url: 'https://github.com/mlabs-haskell/purescript-cardano-transaction-balancer',
  rev: '70df801270f55cc024a5d7b54da881b0f33e88f1'
});

// The PureScript compiler CTL's build uses (nix/default.nix:35,
// easy-ps.purs-0_15_8): the release's Linux binary, the tarball's SHA-256
// (its SHA-1 is the release's linux64.sha, bb93d660...) and the binary's,
// which is also the binary the npm package purescript@0.15.8 installs.
export const PURS = Object.freeze({
  version: '0.15.8',
  url: 'https://github.com/purescript/purescript/releases/download/v0.15.8/linux64.tar.gz',
  tarballSha256: '1e887f56908d5ec2b9faa9759cca954b7430fba3d130a8e05731284954ea57a4',
  binarySha256: 'c00bc0e105fd272340396004042c7e210306a994f9cbf43c890adeaa74c54a67'
});

// The entry module, the simulator's own code (under the tool's directory).
export const ENTRY_FILE = 'scripts/ctl/Entry.purs';
export const ENTRY_MODULE = 'UnFrackIt.Ctl.Entry';

// Under the tool's directory: the build, and the fetched packages and the
// compiler, kept between builds and checked again by every build.
export const OUTPUT_DIR = 'build/ctl';
export const CACHE_DIR = 'build/ctl-cache';
export const BUNDLE = 'ctl-balancer.cjs';
export const BUILD_RECORD = 'source.json';
export const BUILD_SCRIPT = 'scripts/build-ctl.mjs';
