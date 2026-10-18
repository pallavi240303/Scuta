/** @file Atomic admission, static provenance, shared exposure and retry scenarios against both adapters. */
import { expect, test } from "bun:test";
import type { LedgerChanges } from "@scuta/core";
import { createLedger } from "../../core/src/index.js";
import { createIntent, createPolicy, NOW_MS } from "../../core/test/fixtures.js";
import { openSqliteStore } from "../src/index.js";
import { createChanges } from "./store-fixtures.js";
import { STORE_KINDS, createLedgerFixture, requireSuccess } from "./fixtures/ledger-fixtures.js";

for (const kind of STORE_KINDS) {
  test(kind + ": two 70-unit purchases against 100 reserve exactly once", () => {
    const f = createLedgerFixture(kind);
    try {
      const first = requireSuccess(
        f.ledger.authorize({ scope: f.scope, intent: createIntent({ amountAtomic: "70" }) }),
      );
      const second = requireSuccess(
        f.ledger.authorize({
          scope: f.scope,
          intent: createIntent({ amountAtomic: "70", idempotencyKey: "request-2" }),
        }),
      );
      expect(first.decision.kind).toBe("ALLOW");
      expect(first.reservation?.state).toBe("RESERVED");
      expect(second.decision).toMatchObject({
        kind: "DENY",
        ledgerReasons: ["BUDGET_EXCEEDED"],
        evaluation: { kind: "ALLOW" },
      });
      expect(second.reservation).toBeNull();
      expect(requireSuccess(f.ledger.getBudgetExposure(f.wallet, "wallet-budget"))).toEqual({
        spentAtomic: 0n,
        heldAtomic: 70n,
        headroomAtomic: 30n,
      });
    } finally {
      f.close();
    }
  });

  test(kind + ": equality admits and one unit above remaining headroom denies", () => {
    const f = createLedgerFixture(kind);
    try {
      expect(
        requireSuccess(
          f.ledger.authorize({ scope: f.scope, intent: createIntent({ amountAtomic: "100" }) }),
        ).decision.kind,
      ).toBe("ALLOW");
      expect(
        requireSuccess(
          f.ledger.authorize({
            scope: f.scope,
            intent: createIntent({ amountAtomic: "1", idempotencyKey: "second" }),
          }),
        ).decision.kind,
      ).toBe("DENY");
      expect(requireSuccess(f.ledger.getBudgetExposure(f.wallet, "wallet-budget")).heldAtomic).toBe(
        100n,
      );
    } finally {
      f.close();
    }
  });

  test(kind + ": same purchase retries preserve hold, expiry, decision, event and clock", () => {
    const f = createLedgerFixture(kind);
    try {
      const input = { scope: f.scope, intent: createIntent({ amountAtomic: "70" }) };
      const first = requireSuccess(f.ledger.authorize(input));
      const event = f.store.read((tx) => tx.getLatestEvent(f.wallet));
      const clock = f.store.read((tx) => tx.getClock(f.wallet));
      f.time.nowMs += 100;
      expect(requireSuccess(f.ledger.authorize(input))).toEqual(first);
      expect(f.store.read((tx) => tx.getLatestEvent(f.wallet))).toEqual(event);
      expect(f.store.read((tx) => tx.getClock(f.wallet))).toEqual(clock);
      expect(requireSuccess(f.ledger.getBudgetExposure(f.wallet, "wallet-budget")).heldAtomic).toBe(
        70n,
      );
      expect(Reflect.set(first.decision, "kind", "DENY")).toBe(false);
      expect(Reflect.set(first.intent, "amountAtomic", 1n)).toBe(false);
      expect(requireSuccess(f.ledger.getStatus(f.scope, first.intentId))).toEqual(first);
    } finally {
      f.close();
    }
  });

  test(kind + ": changed purchase conflicts once without replacing or re-reserving", () => {
    const f = createLedgerFixture(kind);
    try {
      const first = requireSuccess(
        f.ledger.authorize({ scope: f.scope, intent: createIntent({ amountAtomic: "70" }) }),
      );
      const before = f.store.read((tx) => tx.getLatestEvent(f.wallet))?.sequence ?? 0;
      const changed = { scope: f.scope, intent: createIntent({ amountAtomic: "71" }) };
      expect(f.ledger.authorize(changed)).toEqual({ ok: false, reason: "IDEMPOTENCY_CONFLICT" });
      expect(f.ledger.authorize(changed)).toEqual({ ok: false, reason: "IDEMPOTENCY_CONFLICT" });
      expect(f.store.read((tx) => tx.getLatestEvent(f.wallet))?.sequence).toBe(before + 1);
      expect(requireSuccess(f.ledger.getStatus(f.scope, first.intentId))).toEqual(first);
      expect(requireSuccess(f.ledger.getBudgetExposure(f.wallet, "wallet-budget")).heldAtomic).toBe(
        70n,
      );
    } finally {
      f.close();
    }
  });

  test.each([
    { change: { network: "mock:other" }, reason: "UNSUPPORTED_NETWORK" },
    { change: { asset: "mock:other" }, reason: "UNSUPPORTED_ASSET" },
    { change: { delegationId: "another-grant" }, reason: "SCOPE_MISMATCH" },
    { change: { amountAtomic: "101" }, reason: "HARD_TRANSACTION_LIMIT_EXCEEDED" },
  ])(
    kind + ": valid disallowed purchases retain $reason without a reservation",
    ({ change, reason }) => {
      const f = createLedgerFixture(kind);
      try {
        const result = requireSuccess(
          f.ledger.authorize({
            scope: f.scope,
            intent: createIntent({ amountAtomic: "70", ...change }),
          }),
        );
        expect(result.decision.kind).toBe("DENY");
        expect(result.decision.evaluation.reasonCodes).toContain(reason);
        expect(result.reservationId).toBeNull();
        expect(
          requireSuccess(f.ledger.getBudgetExposure(f.wallet, "wallet-budget")).heldAtomic,
        ).toBe(0n);
      } finally {
        f.close();
      }
    },
  );

  test(kind + ": approval-required is durable but has no executable hold", () => {
    const f = createLedgerFixture(kind, {
      policy: createPolicy({
        hardTransactionLimitAtomic: "100",
        autonomousTransactionLimitAtomic: "50",
      }),
    });
    try {
      const input = { scope: f.scope, intent: createIntent({ amountAtomic: "70" }) };
      const first = requireSuccess(f.ledger.authorize(input));
      expect(first.decision.kind).toBe("REQUIRE_APPROVAL");
      expect(first.reservationId).toBeNull();
      expect(requireSuccess(f.ledger.getBudgetExposure(f.wallet, "wallet-budget")).heldAtomic).toBe(
        0n,
      );
      requireSuccess(
        f.ledger.activatePolicy(
          createPolicy({
            version: "2",
            hardTransactionLimitAtomic: "100",
            autonomousTransactionLimitAtomic: "100",
          }),
        ),
      );
      expect(requireSuccess(f.ledger.authorize(input))).toEqual(first);
    } finally {
      f.close();
    }
  });

  test(kind + ": a denied retry key stays denied after policy activation", () => {
    const f = createLedgerFixture(kind, {
      policy: createPolicy({
        hardTransactionLimitAtomic: "50",
        autonomousTransactionLimitAtomic: "50",
      }),
    });
    try {
      const input = { scope: f.scope, intent: createIntent({ amountAtomic: "70" }) };
      const denied = requireSuccess(f.ledger.authorize(input));
      requireSuccess(
        f.ledger.activatePolicy(
          createPolicy({
            version: "2",
            hardTransactionLimitAtomic: "100",
            autonomousTransactionLimitAtomic: "100",
          }),
        ),
      );
      expect(requireSuccess(f.ledger.authorize(input))).toEqual(denied);
      expect(
        requireSuccess(
          f.ledger.authorize({
            ...input,
            intent: { ...input.intent, idempotencyKey: "new-logical-request" },
          }),
        ).decision.kind,
      ).toBe("ALLOW");
    } finally {
      f.close();
    }
  });

  test(kind + ": ancestor budgets are all-or-nothing and another agent account is excluded", () => {
    const f = createLedgerFixture(kind, { initialize: false });
    try {
      const base = f.budgets[0];
      if (!base) throw new Error("missing fixture budget");
      requireSuccess(
        f.ledger.configureWallet(f.wallet, [
          base,
          {
            ...base,
            accountId: "agent-budget",
            scope: {
              ownerId: f.scope.ownerId,
              walletId: f.scope.walletId,
              agentId: f.scope.agentId,
              kind: "AGENT",
            },
            ceilingAtomic: "100",
          },
          {
            ...base,
            accountId: "delegation-budget",
            scope: { ...f.scope, kind: "DELEGATION" },
            ceilingAtomic: "60",
          },
          {
            ...base,
            accountId: "another-agent",
            scope: {
              ownerId: f.scope.ownerId,
              walletId: f.scope.walletId,
              agentId: "agent-2",
              kind: "AGENT",
            },
            ceilingAtomic: "0",
          },
        ]),
      );
      requireSuccess(f.ledger.activatePolicy(f.policy.wire));
      requireSuccess(f.ledger.activateDelegation(f.delegation.wire));
      expect(
        requireSuccess(
          f.ledger.authorize({ scope: f.scope, intent: createIntent({ amountAtomic: "70" }) }),
        ).decision.kind,
      ).toBe("DENY");
      for (const id of ["wallet-budget", "agent-budget", "delegation-budget", "another-agent"])
        expect(requireSuccess(f.ledger.getBudgetExposure(f.wallet, id)).heldAtomic).toBe(0n);
      expect(
        requireSuccess(
          f.ledger.authorize({
            scope: f.scope,
            intent: createIntent({ amountAtomic: "60", idempotencyKey: "fits-all" }),
          }),
        ).decision.kind,
      ).toBe("ALLOW");
      for (const id of ["wallet-budget", "agent-budget", "delegation-budget"])
        expect(requireSuccess(f.ledger.getBudgetExposure(f.wallet, id)).heldAtomic).toBe(60n);
      expect(requireSuccess(f.ledger.getBudgetExposure(f.wallet, "another-agent")).heldAtomic).toBe(
        0n,
      );
    } finally {
      f.close();
    }
  });

  test(kind + ": absent configuration fails closed and status is scope-isolated", () => {
    const empty = createLedgerFixture(kind, { initialize: false });
    try {
      expect(() => empty.ledger.authorize({ scope: empty.scope, intent: createIntent() })).toThrow(
        "CONFIGURATION_MISSING",
      );
      expect(empty.ledger.getStatus(empty.scope, "missing")).toEqual({
        ok: false,
        reason: "NOT_FOUND",
      });
    } finally {
      empty.close();
    }
    const f = createLedgerFixture(kind);
    try {
      const allowed = requireSuccess(
        f.ledger.authorize({ scope: f.scope, intent: createIntent({ amountAtomic: "70" }) }),
      );
      expect(f.ledger.getStatus({ ...f.scope, agentId: "other" }, allowed.intentId)).toEqual({
        ok: false,
        reason: "NOT_FOUND",
      });
    } finally {
      f.close();
    }
  });

  test(kind + ": clock regression cannot free or add exposure, while status stays readable", () => {
    const f = createLedgerFixture(kind);
    try {
      const allowed = requireSuccess(
        f.ledger.authorize({ scope: f.scope, intent: createIntent({ amountAtomic: "70" }) }),
      );
      f.time.nowMs = NOW_MS - 1;
      expect(() =>
        f.ledger.authorize({
          scope: f.scope,
          intent: createIntent({ amountAtomic: "1", idempotencyKey: "earlier" }),
        }),
      ).toThrow("CLOCK_REGRESSION");
      expect(requireSuccess(f.ledger.getStatus(f.scope, allowed.intentId))).toEqual(allowed);
      f.time.nowMs = NOW_MS + 120_000;
      expect(requireSuccess(f.ledger.getBudgetExposure(f.wallet, "wallet-budget")).heldAtomic).toBe(
        70n,
      );
      expect(f.store.read((tx) => tx.getClock(f.wallet))?.highWaterMs).toBe(NOW_MS);
      expect(requireSuccess(f.ledger.getStatus(f.scope, allowed.intentId)).reservation?.state).toBe(
        "RESERVED",
      );
    } finally {
      f.close();
    }
  });

  test(kind + ": latched faults deny new purchases without creating holds", () => {
    const f = createLedgerFixture(kind);
    try {
      f.store.transaction((tx) =>
        tx.apply(
          createChanges({
            faults: [
              {
                wallet: f.wallet,
                faultId: "fault-1",
                reason: "EVIDENCE_CONFLICT",
                createdAtMs: NOW_MS,
              },
            ],
          }),
        ),
      );
      const result = requireSuccess(
        f.ledger.authorize({ scope: f.scope, intent: createIntent({ amountAtomic: "70" }) }),
      );
      expect(result.decision).toMatchObject({ kind: "DENY", ledgerReasons: ["WALLET_CONTAINED"] });
      expect(result.reservation).toBeNull();
    } finally {
      f.close();
    }
  });

  test(kind + ": failure between admission and event persistence rolls back every effect", () => {
    const f = createLedgerFixture(kind);
    let fail = true;
    const failingStore = {
      ...f.store,
      transaction<T>(operation: Parameters<typeof f.store.transaction<T>>[0]): T {
        return f.store.transaction((tx) =>
          operation({
            ...tx,
            apply(changes: LedgerChanges) {
              tx.apply(changes);
              if (fail && changes.events.some((event) => event.kind === "DECISION")) {
                fail = false;
                throw new Error("injected event failure");
              }
            },
          }),
        );
      },
    };
    const ledger = createLedger({
      store: failingStore,
      now: () => f.time.nowMs,
      createId: f.createId,
    });
    try {
      const before = f.store.read((tx) => tx.getLatestEvent(f.wallet));
      expect(() =>
        ledger.authorize({ scope: f.scope, intent: createIntent({ amountAtomic: "70" }) }),
      ).toThrow("injected event failure");
      expect(f.store.read((tx) => tx.findIntent(f.scope, "request-1"))).toBeNull();
      expect(f.store.read((tx) => tx.getLatestEvent(f.wallet))).toEqual(before);
      expect(requireSuccess(ledger.getBudgetExposure(f.wallet, "wallet-budget")).heldAtomic).toBe(
        0n,
      );
    } finally {
      f.close();
    }
  });
}

test("a reopened SQLite coordinator recovers the original retry identity and exposure", () => {
  const f = createLedgerFixture("sqlite");
  try {
    const input = { scope: f.scope, intent: createIntent({ amountAtomic: "70" }) };
    const first = requireSuccess(f.ledger.authorize(input));
    f.store.close();
    if (!f.path) throw new Error("missing SQLite file");
    const store = openSqliteStore({ path: f.path });
    try {
      const ledger = createLedger({ store, now: () => f.time.nowMs, createId: f.createId });
      expect(requireSuccess(ledger.authorize(input))).toEqual(first);
      expect(requireSuccess(ledger.getBudgetExposure(f.wallet, "wallet-budget")).heldAtomic).toBe(
        70n,
      );
    } finally {
      store.close();
    }
  } finally {
    f.close();
  }
});
