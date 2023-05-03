/* eslint-disable */
(globalThis as any)['emsInitialized'] = false

import emsInit from './cardano-message-signing-web/cardano_message_signing'

(async () => {

  (globalThis as any)['emsInitialized'] = !!(await emsInit('/wasm/cms-v1.0.1.wasm'))

})()

export * from './cardano-message-signing-web/cardano_message_signing'
