/** @file Lifecycle and safe deadline boundaries prevent expiry from releasing claimed exposure. */
import { expect, test } from "bun:test";
import { canTransitionReservation, computeReservationExpiry } from "../src/reservation.js";
import type { ReservationState } from "../src/ledger-contracts.js";

test("allows only the reviewed reservation lifecycle edges", () => {
  const states: readonly ReservationState[] = [
    "RESERVED",
    "EXECUTING",
    "PENDING_RECONCILIATION",
    "COMMITTED",
    "RELEASED",
    "EXPIRED",
  ];
  const edges = [
    "RESERVED:EXECUTING",
    "RESERVED:RELEASED",
    "RESERVED:EXPIRED",
    "EXECUTING:PENDING_RECONCILIATION",
    "EXECUTING:COMMITTED",
    "EXECUTING:RELEASED",
    "PENDING_RECONCILIATION:COMMITTED",
    "PENDING_RECONCILIATION:RELEASED",
  ];
  for (const from of states)
    for (const to of states)
      expect(canTransitionReservation(from, to)).toBe(edges.includes(`${from}:${to}`));
});
test("clamps reservation expiry to the earliest authoritative deadline", () => {
  expect(computeReservationExpiry(100, 60_000, [5_100, 10_100])).toBe(5_100);
  expect(computeReservationExpiry(100, 60, [5_100])).toBe(160);
  expect(
    computeReservationExpiry(Number.MAX_SAFE_INTEGER - 1, 60_000, [Number.MAX_SAFE_INTEGER]),
  ).toBe(Number.MAX_SAFE_INTEGER);
});
test("rejects invalid time, nonpositive TTL and already expired deadlines", () => {
  for (const ttl of [0, -1, 0.5, NaN, Infinity])
    expect(() => computeReservationExpiry(100, ttl, [200])).toThrow();
  expect(() => computeReservationExpiry(-1, 10, [200])).toThrow();
  expect(() => computeReservationExpiry(100, 10, [])).toThrow();
  expect(() => computeReservationExpiry(100, 10, [100])).toThrow();
});
