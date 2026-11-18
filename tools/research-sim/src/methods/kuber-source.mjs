// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The pinned source of Kuber, which the kuber helper (helpers/kuber) builds
// against: dQuadrant/kuber at the release tag v4.2.0's commit. Kuber's
// balancer, txBuilderToTxBody, and the runner that calls it, executeTxBuilder
// (src/Cardano/Kuber/Core/TxFramework.hs:307-329), live in a module the
// package lists under other-modules (kuber.cabal:33, :42), so no package that
// depends on Kuber can call them. scripts/build-helpers.mjs kuber therefore
// takes the paths below from a clone of the commit, checks each one's git
// object hash against its pin, extracts them with git archive into
// SOURCE_DIR (gitignored), and makes one change to the package description:
// the module Cardano.Kuber.Core.TxFramework moves from other-modules to
// exposed-modules (exposeTxFramework). The edited kuber.cabal must hash to
// KUBER_CABAL_EDITED. Kuber's code is unchanged; helpers/kuber/cabal.project
// builds this directory as a local package in place of the release's
// source-repository-package. Nothing of Kuber's source is kept in the
// repository.

export const KUBER_REPO = 'https://github.com/dQuadrant/kuber.git';
export const KUBER_COMMIT = '2c559089e394ea7bc8a9bbde968bcdfb2ef7fac5';
export const KUBER_VERSION = '4.2.0';

// path -> [git object type, object hash] at KUBER_COMMIT: the library's source,
// its package description, the file the description names as an extra source
// file, and the repository's license (MIT; the file's name is the
// repository's own spelling).
export const KUBER_PATHS = Object.freeze({
  src: Object.freeze(['tree', 'c5535c50f623b81e3c94fb31820d85877a35ec02']),
  'kuber.cabal': Object.freeze(['blob', 'fd7ad90924e516e0c0b74aa62a14aa5121c056f2']),
  'CHANGELOG.md': Object.freeze(['blob', '449ddbc3eb2a0dab8266e3e42b497b9858e072ab']),
  LISENCE: Object.freeze(['blob', '203c69e4f1cb8d9b1ab5ed09bf1abed85fd76c27'])
});

// The one change, and the git blob hash of kuber.cabal after it.
export const KUBER_EXPOSED_MODULE = 'Cardano.Kuber.Core.TxFramework';
export const KUBER_CABAL_EDITED = '7de884b45cbbb602630586469cbc27ca5d22a256';

// Under the tool's directory; helpers/kuber/cabal.project names it as
// ../../build/helpers/kuber/source.
export const SOURCE_DIR = 'build/helpers/kuber/source';

// kuber.cabal with KUBER_EXPOSED_MODULE moved from other-modules to the end of
// exposed-modules; throws unless each line it moves or follows occurs exactly
// once, in the section the change expects.
export function exposeTxFramework(text) {
  const line = `    ${KUBER_EXPOSED_MODULE}\n`;
  const lastExposed = '    Cardano.Kuber.Http.Spec\n';
  if (text.split(line).length !== 2) throw new Error(`kuber.cabal does not list ${KUBER_EXPOSED_MODULE} exactly once`);
  if (text.split(lastExposed).length !== 2) throw new Error('kuber.cabal does not list Cardano.Kuber.Http.Spec exactly once');
  if (text.indexOf(lastExposed) > text.indexOf('  other-modules:') || text.indexOf(line) < text.indexOf('  other-modules:')) throw new Error('kuber.cabal does not have the layout the change expects');
  return text.replace(line, '').replace(lastExposed, lastExposed + line);
}
