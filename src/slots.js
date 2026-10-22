// Slot numbers from the wall clock. Since the Shelley hard fork every network has
// one-second slots, so the slot is the Unix time minus a fixed origin:
// shelleyStartTime - shelleyStartSlot from each network's genesis files
// (mainnet 1596059091 - 4492800, preprod 1655769600 - 86400, preview 1666656000 - 0).

export const SLOT_ORIGIN = Object.freeze({
  mainnet: 1591566291,
  preprod: 1655683200,
  preview: 1666656000,
});

// Time to live of a built transaction: one hour.
export const TTL_SECONDS = 3600;

export function currentSlot(network, nowSeconds = Date.now() / 1000) {
  if (SLOT_ORIGIN[network] === undefined) {
    throw new TypeError(`Unknown network: ${network}`);
  }
  return Math.floor(nowSeconds) - SLOT_ORIGIN[network];
}

// The ledger accepts a transaction while the current slot is below its TTL.
export function ttlFor(network, nowSeconds = Date.now() / 1000) {
  return currentSlot(network, nowSeconds) + TTL_SECONDS;
}
