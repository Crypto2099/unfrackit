/* eslint-disable */
globalThis['cslInitialized'] = false

import cslInit from './cardano-serialization-lib-web/cardano_serialization_lib.js'

(async () => {

    globalThis['cslInitialized'] = !!(await cslInit('/wasm/csl-v11.1.0.wasm'))

})()


export * from './cardano-serialization-lib-web/cardano_serialization_lib'
