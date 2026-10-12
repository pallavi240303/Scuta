/** @file Reviewed reservation transitions and precision-safe authoritative expiry calculation. */
import type { ReservationState } from "./ledger-contracts.js";
import { validateLedgerInteger } from "./ledger-validation.js";
import { ValidationError } from "./validation.js";

/** Check a lifecycle transition.
 * @param from - Current state.
 * @param to - Requested next state.
 * @returns Whether the reviewed lifecycle permits the edge.
 */
export function canTransitionReservation(from: ReservationState, to: ReservationState): boolean {
  if (from === "RESERVED") return to === "EXECUTING" || to === "RELEASED" || to === "EXPIRED";
  if (from === "EXECUTING")
    return to === "PENDING_RECONCILIATION" || to === "COMMITTED" || to === "RELEASED";
  if (from === "PENDING_RECONCILIATION") return to === "COMMITTED" || to === "RELEASED";
  return false;
}
/** Clamp an unclaimed hold's lifetime.
 * @param nowMs - Trusted transaction time.
 * @param ttlMs - Positive lifetime in milliseconds.
 * @param deadlines - Authoritative future intent and delegation bounds.
 * @returns The earliest precision-safe expiry.
 * @throws {ValidationError} If time, TTL or authoritative future deadlines are invalid.
 */
export function computeReservationExpiry(
  nowMs: number,
  ttlMs: number,
  deadlines: readonly number[],
): number {
  validateLedgerInteger(nowMs, "nowMs");
  validateLedgerInteger(ttlMs, "ttlMs", true);
  if (deadlines.length === 0) throw new ValidationError("INVALID_SHAPE", "deadlines");
  let expiry = BigInt(nowMs) + BigInt(ttlMs);
  if (expiry > BigInt(Number.MAX_SAFE_INTEGER)) expiry = BigInt(Number.MAX_SAFE_INTEGER);
  for (const deadline of deadlines) {
    validateLedgerInteger(deadline, "deadlines");
    if (deadline <= nowMs) throw new ValidationError("OUT_OF_RANGE", "deadlines");
    if (BigInt(deadline) < expiry) expiry = BigInt(deadline);
  }
  return Number(expiry);
}
