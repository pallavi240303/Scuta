/** @file Admission boundaries for exact money, trusted configuration, deadlines and durable event identity. */
import { expect, test } from "bun:test";
import { createLedger, MAX_ATOMIC_AMOUNT } from "../../core/src/index.js";
import { createIntent, createDelegation, createPolicy, NOW_MS } from "../../core/test/fixtures.js";
import { createChanges } from "./store-fixtures.js";
import { STORE_KINDS, createLedgerFixture, requireSuccess } from "./fixtures/ledger-fixtures.js";

for (const kind of STORE_KINDS) {
  test(kind + ": zero ceiling denies without a hold and cannot be bypassed by approval", () => {
    const f = createLedgerFixture(kind);
    try {
      requireSuccess(f.ledger.setBudgetCeiling(f.wallet, "wallet-budget", "0"));
      requireSuccess(
        f.ledger.activatePolicy(
          createPolicy({
            version: "2",
            hardTransactionLimitAtomic: "100",
            autonomousTransactionLimitAtomic: "0",
          }),
        ),
      );
      const status = requireSuccess(
        f.ledger.authorize({ scope: f.scope, intent: createIntent({ amountAtomic: "1" }) }),
      );
      expect(status.decision).toMatchObject({
        kind: "DENY",
        ledgerReasons: ["BUDGET_EXCEEDED"],
        evaluation: { kind: "REQUIRE_APPROVAL" },
      });
      expect(status.reservation).toBeNull();
      expect(requireSuccess(f.ledger.getBudgetExposure(f.wallet, "wallet-budget"))).toEqual({
        spentAtomic: 0n,
        heldAtomic: 0n,
        headroomAtomic: 0n,
      });
    } finally {
      f.close();
    }
  });

  test(kind + ": full-range exact amounts survive coordinator admission and inspection", () => {
    const f = createLedgerFixture(kind, { initialize: false });
    try {
      const base = f.budgets[0];
      if (!base) throw new Error("missing fixture account");
      const maximum = MAX_ATOMIC_AMOUNT.toString();
      requireSuccess(f.ledger.configureWallet(f.wallet, [{ ...base, ceilingAtomic: maximum }]));
      requireSuccess(
        f.ledger.activatePolicy(
          createPolicy({
            hardTransactionLimitAtomic: maximum,
            autonomousTransactionLimitAtomic: maximum,
          }),
        ),
      );
      requireSuccess(f.ledger.activateDelegation(f.delegation.wire));
      const first = requireSuccess(
        f.ledger.authorize({
          scope: f.scope,
          intent: createIntent({ amountAtomic: "9007199254740993" }),
        }),
      );
      expect(first.reservation?.amountAtomic).toBe(9007199254740993n);
      const remaining = (MAX_ATOMIC_AMOUNT - 9007199254740993n).toString();
      expect(
        requireSuccess(
          f.ledger.authorize({
            scope: f.scope,
            intent: createIntent({ amountAtomic: remaining, idempotencyKey: "remaining" }),
          }),
        ).decision.kind,
      ).toBe("ALLOW");
      expect(requireSuccess(f.ledger.getBudgetExposure(f.wallet, "wallet-budget"))).toEqual({
        spentAtomic: 0n,
        heldAtomic: MAX_ATOMIC_AMOUNT,
        headroomAtomic: 0n,
      });
    } finally {
      f.close();
    }
  });

  test.each([
    { intentMs: 120_000, delegationMs: 180_000, expected: 60_000 },
    { intentMs: 10_000, delegationMs: 180_000, expected: 10_000 },
    { intentMs: 120_000, delegationMs: 15_000, expected: 15_000 },
  ])(
    kind + ": reservation expiry uses the earliest authoritative bound: $expected",
    ({ intentMs, delegationMs, expected }) => {
      const f = createLedgerFixture(kind);
      try {
        requireSuccess(
          f.ledger.activateDelegation(
            createDelegation({ expiresAt: new Date(NOW_MS + delegationMs).toISOString() }),
          ),
        );
        const status = requireSuccess(
          f.ledger.authorize({
            scope: f.scope,
            intent: createIntent({
              amountAtomic: "1",
              expiresAt: new Date(NOW_MS + intentMs).toISOString(),
            }),
          }),
        );
        expect(status.reservation?.expiresAtMs).toBe(NOW_MS + expected);
      } finally {
        f.close();
      }
    },
  );

  test(kind + ": different agents share the wallet ceiling but not retry/status namespaces", () => {
    const f = createLedgerFixture(kind);
    try {
      const other = { ...f.scope, agentId: "agent-2", delegationId: "grant-2" };
      requireSuccess(
        f.ledger.activatePolicy(
          createPolicy({
            scope: other,
            hardTransactionLimitAtomic: "100",
            autonomousTransactionLimitAtomic: "100",
          }),
        ),
      );
      requireSuccess(f.ledger.activateDelegation(createDelegation({ scope: other })));
      const first = requireSuccess(
        f.ledger.authorize({ scope: f.scope, intent: createIntent({ amountAtomic: "70" }) }),
      );
      const second = requireSuccess(
        f.ledger.authorize({
          scope: other,
          intent: createIntent({ amountAtomic: "70", delegationId: other.delegationId }),
        }),
      );
      expect(second.intentId).not.toBe(first.intentId);
      expect(second.decision.ledgerReasons).toEqual(["BUDGET_EXCEEDED"]);
      expect(f.ledger.getStatus(other, first.intentId)).toEqual({ ok: false, reason: "NOT_FOUND" });
      expect(requireSuccess(f.ledger.getBudgetExposure(f.wallet, "wallet-budget")).heldAtomic).toBe(
        70n,
      );
    } finally {
      f.close();
    }
  });

  test(
    kind + ": decision and conflict events each have one durable pending outbox identity",
    () => {
      const f = createLedgerFixture(kind);
      try {
        const status = requireSuccess(
          f.ledger.authorize({ scope: f.scope, intent: createIntent({ amountAtomic: "70" }) }),
        );
        const event = f.store.read((tx) => tx.getLatestEvent(f.wallet));
        expect(event).toMatchObject({ kind: "DECISION", subjectId: status.intentId, sequence: 4 });
        if (!event) throw new Error("missing decision event");
        expect(f.store.read((tx) => tx.getOutbox(f.wallet, event.eventId))).toMatchObject({
          eventId: event.eventId,
          state: "PENDING",
          workerId: null,
          claimToken: null,
          leaseExpiresAtMs: null,
        });
        const changed = { scope: f.scope, intent: createIntent({ amountAtomic: "71" }) };
        f.ledger.authorize(changed);
        const conflict = f.store.read((tx) => tx.getLatestEvent(f.wallet));
        expect(conflict).toMatchObject({ kind: "IDEMPOTENCY_CONFLICT", sequence: 5 });
        if (!conflict) throw new Error("missing conflict event");
        expect(f.store.read((tx) => tx.getOutbox(f.wallet, conflict.eventId))?.state).toBe(
          "PENDING",
        );
        f.ledger.authorize(changed);
        expect(f.store.read((tx) => tx.listDeliverable(f.wallet, NOW_MS, 100))).toHaveLength(5);
      } finally {
        f.close();
      }
    },
  );

  test(kind + ": exhausted event sequence rolls back new financial admission", () => {
    const f = createLedgerFixture(kind);
    try {
      const wallet = { ownerId: f.wallet.ownerId, walletId: f.wallet.walletId };
      f.store.transaction((tx) =>
        tx.apply(
          createChanges({
            events: [
              {
                wallet,
                eventId: "last-event",
                sequence: Number.MAX_SAFE_INTEGER,
                kind: "CONFIGURATION",
                subjectId: f.wallet.walletId,
                occurredAtMs: NOW_MS,
                reason: null,
              },
            ],
          }),
        ),
      );
      expect(() =>
        f.ledger.authorize({ scope: f.scope, intent: createIntent({ amountAtomic: "70" }) }),
      ).toThrow("COUNTER_EXHAUSTED");
      expect(f.store.read((tx) => tx.findIntent(f.scope, "request-1"))).toBeNull();
      expect(requireSuccess(f.ledger.getBudgetExposure(f.wallet, "wallet-budget")).heldAtomic).toBe(
        0n,
      );
    } finally {
      f.close();
    }
  });

  test(kind + ": malformed envelopes and host capabilities cannot partially write", () => {
    const f = createLedgerFixture(kind);
    try {
      const before = f.store.read((tx) => tx.getLatestEvent(f.wallet));
      const input = { scope: f.scope, intent: createIntent(), decision: "ALLOW" };
      expect(() => f.ledger.authorize(input)).toThrow("UNKNOWN_FIELD");
      const ledger = createLedger({ store: f.store, now: () => Number.NaN, createId: f.createId });
      expect(() => ledger.authorize({ scope: f.scope, intent: createIntent() })).toThrow(
        "OUT_OF_RANGE",
      );
      const badId = createLedger({ store: f.store, now: () => NOW_MS, createId: () => "bad id" });
      expect(() => badId.authorize({ scope: f.scope, intent: createIntent() })).toThrow(
        "INVALID_FORMAT",
      );
      expect(f.store.read((tx) => tx.hasIntents(f.wallet))).toBe(false);
      expect(f.store.read((tx) => tx.getLatestEvent(f.wallet))).toEqual(before);
    } finally {
      f.close();
    }
  });

  test(kind + ": missing policy or delegation cannot fall back to a fabricated allowance", () => {
    const f = createLedgerFixture(kind, { initialize: false });
    try {
      requireSuccess(f.ledger.configureWallet(f.wallet, f.budgets));
      expect(() => f.ledger.authorize({ scope: f.scope, intent: createIntent() })).toThrow(
        "CONFIGURATION_MISSING",
      );
      requireSuccess(f.ledger.activatePolicy(f.policy.wire));
      expect(() => f.ledger.authorize({ scope: f.scope, intent: createIntent() })).toThrow(
        "CONFIGURATION_MISSING",
      );
      expect(f.store.read((tx) => tx.hasIntents(f.wallet))).toBe(false);
    } finally {
      f.close();
    }
  });

  test(
    kind + ": rejected configuration cannot change the active profile or budget identity",
    () => {
      const f = createLedgerFixture(kind);
      try {
        expect(() => f.ledger.activatePolicy(createPolicy({ asset: "mock:other" }))).toThrow(
          "CONFIGURATION_CONFLICT",
        );
        const base = f.budgets[0];
        if (!base) throw new Error("missing fixture account");
        expect(() => f.ledger.configureWallet(f.wallet, [{ ...base, windowMs: 1 }])).toThrow(
          "CONFIGURATION_CONFLICT",
        );
        expect(f.store.read((tx) => tx.getBudget(f.wallet, "wallet-budget"))?.windowMs).toBe(
          60_000,
        );
        expect(f.store.read((tx) => tx.getPolicy(f.scope))?.policy.asset).toBe("mock:usd");
      } finally {
        f.close();
      }
    },
  );
}
