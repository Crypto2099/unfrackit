import { test } from "node:test";
import assert from "node:assert/strict";
import { SLOT_ORIGIN, TTL_SECONDS, currentSlot, ttlFor } from "../src/slots.js";

// Block slot and block time pairs read from Koios on 2026-10-05 (Shelley era only;
// the one-subtraction formula does not cover Byron-era times).
const VECTORS = [
  ["mainnet", 199593417, 1791159708],
  ["mainnet", 130636802, 1722203093],
  ["mainnet", 4492800, 1596059091],
  ["preprod", 135476483, 1791159683],
  ["preprod", 84758408, 1740441608],
  ["preprod", 518360, 1656201560],
  ["preview", 124503713, 1791159713],
  ["preview", 86400040, 1753056040],
  ["preview", 20, 1666656020],
];

test("currentSlot matches Koios block slots", () => {
  for (const [network, slot, time] of VECTORS) {
    assert.equal(currentSlot(network, time), slot, `${network} ${time}`);
  }
});

test("currentSlot floors fractional seconds", () => {
  assert.equal(currentSlot("preview", 1666656020.999), 20);
});

test("ttlFor is one hour past the current slot", () => {
  assert.equal(TTL_SECONDS, 3600);
  assert.equal(ttlFor("mainnet", 1791159708), 199593417 + 3600);
});

test("an unknown network is rejected", () => {
  assert.equal(SLOT_ORIGIN.sanchonet, undefined);
  assert.throws(() => currentSlot("sanchonet", 1791159708), TypeError);
});
