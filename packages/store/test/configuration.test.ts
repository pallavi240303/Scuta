/** @file Trusted configuration identity, membership, ceiling updates and revision safety on both stores. */
import { expect, test } from "bun:test";
import { createIntent, createPolicy, NOW_MS } from "../../core/test/fixtures.js";
import { STORE_KINDS, createLedgerFixture, requireSuccess } from "./fixtures/ledger-fixtures.js";

for (const kind of STORE_KINDS) {
  test(kind + ": identical configuration and activation are no-ops", () => {
    const f = createLedgerFixture(kind);
    try {
      const event = f.store.read((tx) => tx.getLatestEvent(f.wallet));
      requireSuccess(f.ledger.configureWallet(f.wallet, f.budgets));
      requireSuccess(f.ledger.activatePolicy(f.policy.wire));
      requireSuccess(f.ledger.activateDelegation(f.delegation.wire));
      expect(f.store.read((tx) => tx.getLatestEvent(f.wallet))).toEqual(event);
      expect(f.store.read((tx) => tx.getDelegation(f.scope))?.revision).toBe(1);
    } finally {
      f.close();
    }
  });

  test(
    kind + ": membership requires exactly one wallet budget and unique matching accounts",
    () => {
      const f = createLedgerFixture(kind, { initialize: false });
      try {
        const base = f.budgets[0];
        if (!base) throw new Error("missing budget");
        expect(() => f.ledger.configureWallet(f.wallet, [])).toThrow("CONFIGURATION_CONFLICT");
        expect(() =>
          f.ledger.configureWallet(f.wallet, [
            base,
            { ...base, accountId: "second-wallet-budget" },
          ]),
        ).toThrow("CONFIGURATION_CONFLICT");
        expect(() => f.ledger.configureWallet(f.wallet, [base, base])).toThrow(
          "CONFIGURATION_CONFLICT",
        );
        expect(() =>
          f.ledger.configureWallet(f.wallet, [{ ...base, asset: "mock:other" }]),
        ).toThrow("CONFIGURATION_CONFLICT");
        expect(() =>
          f.ledger.configureWallet(f.wallet, [
            { ...base, scope: { ...base.scope, ownerId: "other" } },
          ]),
        ).toThrow("CONFIGURATION_CONFLICT");
        expect(f.store.read((tx) => tx.getWallet(f.wallet))).toBeNull();
      } finally {
        f.close();
      }
    },
  );

  test(
    kind + ": new budget membership is allowed before history but not after any decision",
    () => {
      const f = createLedgerFixture(kind);
      try {
        const base = f.budgets[0];
        if (!base) throw new Error("missing budget");
        const agent = {
          ...base,
          accountId: "agent-budget",
          scope: {
            ownerId: f.scope.ownerId,
            walletId: f.scope.walletId,
            agentId: f.scope.agentId,
            kind: "AGENT" as const,
          },
        };
        requireSuccess(f.ledger.configureWallet(f.wallet, [...f.budgets, agent]));
        requireSuccess(
          f.ledger.authorize({ scope: f.scope, intent: createIntent({ amountAtomic: "101" }) }),
        );
        expect(() =>
          f.ledger.configureWallet(f.wallet, [
            ...f.budgets,
            agent,
            { ...agent, accountId: "late-budget" },
          ]),
        ).toThrow("CONFIGURATION_CONFLICT");
        expect(() => f.ledger.configureWallet(f.wallet, f.budgets)).toThrow(
          "CONFIGURATION_CONFLICT",
        );
        expect(f.store.read((tx) => tx.listBudgets(f.wallet))).toHaveLength(2);
      } finally {
        f.close();
      }
    },
  );

  test(
    kind + ": immutable wallet settings and reused policy versions cannot be overwritten",
    () => {
      const f = createLedgerFixture(kind);
      try {
        expect(() =>
          f.ledger.configureWallet({ ...f.wallet, signerId: "replacement" }, f.budgets),
        ).toThrow("CONFIGURATION_CONFLICT");
        expect(() =>
          f.ledger.activatePolicy({ ...f.policy.wire, hardTransactionLimitAtomic: "200" }),
        ).toThrow("CONFIGURATION_CONFLICT");
        requireSuccess(
          f.ledger.activatePolicy(
            createPolicy({
              version: "2",
              hardTransactionLimitAtomic: "80",
              autonomousTransactionLimitAtomic: "80",
            }),
          ),
        );
        expect(() =>
          f.ledger.activatePolicy({ ...f.policy.wire, hardTransactionLimitAtomic: "200" }),
        ).toThrow("CONFIGURATION_CONFLICT");
      } finally {
        f.close();
      }
    },
  );

  test(kind + ": lowering ceilings preserves holds and closes further admission", () => {
    const f = createLedgerFixture(kind);
    try {
      requireSuccess(
        f.ledger.authorize({ scope: f.scope, intent: createIntent({ amountAtomic: "70" }) }),
      );
      const budget = requireSuccess(f.ledger.setBudgetCeiling(f.wallet, "wallet-budget", "10"));
      expect(budget.revision).toBe(2);
      expect(requireSuccess(f.ledger.getBudgetExposure(f.wallet, "wallet-budget"))).toEqual({
        spentAtomic: 0n,
        heldAtomic: 70n,
        headroomAtomic: 0n,
      });
      expect(
        requireSuccess(
          f.ledger.authorize({
            scope: f.scope,
            intent: createIntent({ amountAtomic: "1", idempotencyKey: "after-reduction" }),
          }),
        ).decision.kind,
      ).toBe("DENY");
      requireSuccess(f.ledger.setBudgetCeiling(f.wallet, "wallet-budget", "0"));
      expect(requireSuccess(f.ledger.getBudgetExposure(f.wallet, "wallet-budget")).heldAtomic).toBe(
        70n,
      );
      expect(f.ledger.setBudgetCeiling(f.wallet, "missing", "1")).toEqual({
        ok: false,
        reason: "NOT_FOUND",
      });
    } finally {
      f.close();
    }
  });

  test(kind + ": revocation increments once and cannot revive the denied request key", () => {
    const f = createLedgerFixture(kind);
    try {
      requireSuccess(f.ledger.revokeDelegation(f.scope));
      const latest = f.store.read((tx) => tx.getLatestEvent(f.wallet));
      requireSuccess(f.ledger.revokeDelegation(f.scope));
      expect(f.store.read((tx) => tx.getLatestEvent(f.wallet))).toEqual(latest);
      expect(f.store.read((tx) => tx.getDelegation(f.scope))?.revision).toBe(2);
      const input = { scope: f.scope, intent: createIntent({ amountAtomic: "70" }) };
      const denied = requireSuccess(f.ledger.authorize(input));
      expect(denied.decision.evaluation.reasonCodes).toContain("DELEGATION_REVOKED");
      requireSuccess(f.ledger.activateDelegation(f.delegation.wire));
      expect(f.store.read((tx) => tx.getDelegation(f.scope))?.revision).toBe(3);
      expect(requireSuccess(f.ledger.authorize(input))).toEqual(denied);
    } finally {
      f.close();
    }
  });

  test(kind + ": configuration clock regression has no partial revision or event", () => {
    const f = createLedgerFixture(kind);
    try {
      const before = f.store.read((tx) => tx.getLatestEvent(f.wallet));
      f.time.nowMs = NOW_MS - 1;
      expect(() => f.ledger.setBudgetCeiling(f.wallet, "wallet-budget", "0")).toThrow(
        "CLOCK_REGRESSION",
      );
      expect(f.store.read((tx) => tx.getBudget(f.wallet, "wallet-budget"))?.revision).toBe(1);
      expect(f.store.read((tx) => tx.getLatestEvent(f.wallet))).toEqual(before);
    } finally {
      f.close();
    }
  });
}
