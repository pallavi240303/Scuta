/** @file Pure exact accounting for rolling committed spend and age-independent financial holds. */
import type { BudgetAccount, BudgetAllocation, BudgetExposure } from "./ledger-contracts.js";
import { RESERVATION_STATES } from "./ledger-contracts.js";
import { MAX_ATOMIC_AMOUNT, serializeAtomicAmount } from "./amount.js";
import { validateLedgerInteger } from "./ledger-validation.js";
import { ValidationError } from "./validation.js";

/** Calculate account headroom.
 * @param account - Validated budget with exact ceiling.
 * @param allocations - Validated financial memberships.
 * @param nowMs - Trusted nonnegative safe-integer time.
 * @returns Exact spend, holds and headroom.
 * @throws {ValidationError} If selected financial records, ceiling or trusted time are malformed.
 */
export function computeBudgetExposure(
  account: BudgetAccount,
  allocations: readonly BudgetAllocation[],
  nowMs: number,
): BudgetExposure {
  validateLedgerInteger(nowMs, "nowMs");
  validateLedgerInteger(account.windowMs, "budget.windowMs", true);
  if (
    typeof account.ceilingAtomic !== "bigint" ||
    account.ceilingAtomic < 0n ||
    account.ceilingAtomic > MAX_ATOMIC_AMOUNT
  )
    throw new ValidationError("OUT_OF_RANGE", "budget.ceilingAtomic");
  let spentAtomic = 0n;
  let heldAtomic = 0n;
  for (const allocation of allocations) {
    if (allocation.accountId !== account.accountId) continue;
    serializeAtomicAmount(allocation.amountAtomic);
    if (!RESERVATION_STATES.includes(allocation.state))
      throw new ValidationError("INVALID_FORMAT", "allocation.state");
    if (allocation.state === "COMMITTED") {
      const booked = validateLedgerInteger(allocation.committedAtMs, "allocation.committedAtMs");
      if (booked > nowMs) throw new ValidationError("OUT_OF_RANGE", "allocation.committedAtMs");
      if (booked > nowMs - account.windowMs) spentAtomic += allocation.amountAtomic;
    } else {
      if (allocation.committedAtMs !== null)
        throw new ValidationError("INVALID_SHAPE", "allocation.committedAtMs");
      if (
        allocation.state === "RESERVED" ||
        allocation.state === "EXECUTING" ||
        allocation.state === "PENDING_RECONCILIATION"
      )
        heldAtomic += allocation.amountAtomic;
    }
  }
  const remaining = account.ceilingAtomic - spentAtomic - heldAtomic;
  return Object.freeze({
    spentAtomic,
    heldAtomic,
    headroomAtomic: remaining > 0n ? remaining : 0n,
  });
}
