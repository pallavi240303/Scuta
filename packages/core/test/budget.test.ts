/** @file Exact budget calculations must include live holds across rollover without rounding. */
import { expect, test } from "bun:test";
import { MAX_ATOMIC_AMOUNT } from "../src/amount.js";
import { computeBudgetExposure } from "../src/budget.js";
import type { BudgetAllocation } from "../src/ledger-contracts.js";
import { createBudgetAccount } from "./ledger-fixtures.js";

/** Construct one account allocation with explicit lifecycle and booking time.
 * @param amountAtomic - Positive committed or held amount.
 * @param state - Reservation lifecycle attached to the allocation.
 * @param committedAtMs - Booking time for committed spend, otherwise null.
 * @returns A standalone allocation in the default wallet budget.
 */
function allocation(
  amountAtomic: bigint,
  state: BudgetAllocation["state"],
  committedAtMs: number | null = null,
): BudgetAllocation {
  return {
    reservationId: "reservation-1",
    accountId: "wallet-budget",
    amountAtomic,
    state,
    committedAtMs,
  };
}

test("subtracts committed spend and all live holds from a budget", () => {
  expect(
    computeBudgetExposure(
      createBudgetAccount(),
      [allocation(60n, "COMMITTED", 100), allocation(30n, "RESERVED")],
      100,
    ),
  ).toEqual({ spentAtomic: 60n, heldAtomic: 30n, headroomAtomic: 10n });
});
test("zero and reduced ceilings never erase obligations or produce negative headroom", () => {
  expect(
    computeBudgetExposure(
      createBudgetAccount({ ceilingAtomic: 0n }),
      [allocation(60n, "EXECUTING")],
      100,
    ),
  ).toEqual({ spentAtomic: 0n, heldAtomic: 60n, headroomAtomic: 0n });
});
test("rolling spend excludes the exact lower boundary but retains old unresolved holds", () => {
  expect(
    computeBudgetExposure(
      createBudgetAccount({ windowMs: 60 }),
      [
        allocation(40n, "COMMITTED", 40),
        allocation(10n, "COMMITTED", 41),
        allocation(30n, "PENDING_RECONCILIATION"),
        allocation(20n, "RELEASED"),
        allocation(20n, "EXPIRED"),
      ],
      100,
    ),
  ).toEqual({ spentAtomic: 10n, heldAtomic: 30n, headroomAtomic: 60n });
});
test("a commit at time zero remains inside a window whose lower cutoff is negative", () => {
  expect(
    computeBudgetExposure(createBudgetAccount(), [allocation(70n, "COMMITTED", 0)], 0).spentAtomic,
  ).toBe(70n);
});
test("unbounded intermediate totals preserve the full individual amount range", () => {
  expect(
    computeBudgetExposure(
      createBudgetAccount({ ceilingAtomic: MAX_ATOMIC_AMOUNT }),
      [allocation(MAX_ATOMIC_AMOUNT, "RESERVED"), allocation(MAX_ATOMIC_AMOUNT, "EXECUTING")],
      100,
    ),
  ).toEqual({ spentAtomic: 0n, heldAtomic: MAX_ATOMIC_AMOUNT * 2n, headroomAtomic: 0n });
});
test("never counts another account or accepts malformed financial records", () => {
  expect(
    computeBudgetExposure(
      createBudgetAccount(),
      [{ ...allocation(90n, "RESERVED"), accountId: "other" }],
      100,
    ).headroomAtomic,
  ).toBe(100n);
  for (const row of [
    allocation(0n, "RESERVED"),
    allocation(-1n, "COMMITTED", 100),
    allocation(1n, "COMMITTED"),
    allocation(1n, "RESERVED", 100),
    allocation(1n, "COMMITTED", 101),
  ])
    expect(() => computeBudgetExposure(createBudgetAccount(), [row], 100)).toThrow();
});
