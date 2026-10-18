/** @file Observable synchronous transaction guarantees shared by memory and future SQLite adapters. */
import { expect, test } from "bun:test";
import {
  LedgerError,
  evaluatePolicy,
  validatePaymentIntent,
  type IntentRecord,
  type LedgerStore,
  type LedgerTransaction,
  type LedgerReadView,
} from "@scuta/core";
import {
  createChanges,
  createStoreWallet,
  createStoreRecords,
  createInitialChanges,
  createClaimChanges,
} from "./store-fixtures.js";
import { createIntent } from "../../core/test/fixtures.js";

/** Register reusable tests against a fresh real adapter.
 * @param name - Adapter name shown in failures.
 * @param factory - Constructor providing an isolated store per test.
 * @returns Nothing; Bun registers and runs the tests.
 */
export function defineStoreContract(name: string, factory: () => LedgerStore): void {
  test(name + ": commits independent immutable snapshots and ignores caller mutation", () => {
    const store = factory();
    try {
      const wallet = createStoreWallet();
      expect(
        store.transaction((tx) => {
          tx.apply(createChanges({ wallets: [wallet] }));
          return "committed";
        }),
      ).toBe("committed");
      const result = store.read((tx) => tx.getWallet(wallet));
      expect(result?.signerId).toBe("mock-signer-1");
      expect(result).not.toBe(wallet);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Reflect.set(wallet, "signerId", "changed-signer")).toBe(true);
      expect(store.read((tx) => tx.getWallet(wallet))?.signerId).toBe("mock-signer-1");
    } finally {
      store.close();
    }
  });
  test(name + ": rolls back every earlier apply when callback throws", () => {
    const store = factory();
    const records = createStoreRecords();
    try {
      expect(() =>
        store.transaction((tx) => {
          tx.apply(createInitialChanges(records));
          throw new Error("injected failure");
        }),
      ).toThrow("injected failure");
      expect(store.read((tx) => tx.getWallet(records.wallet))).toBeNull();
      expect(
        store.read((tx) => tx.findIntent(records.scope, records.intent.intent.idempotencyKey)),
      ).toBeNull();
      expect(
        store.read((tx) => tx.getAllocations(records.wallet, [records.budget.accountId], 0)),
      ).toEqual([]);
    } finally {
      store.close();
    }
  });
  test(name + ": cannot commit after a caught write failure", () => {
    const store = factory();
    try {
      expect(() =>
        store.transaction((tx) => {
          tx.apply(createChanges({ wallets: [createStoreWallet()] }));
          try {
            tx.apply(createChanges({ wallets: [{ ...createStoreWallet(), signerId: "changed" }] }));
          } catch (error) {
            expect(error).toBeInstanceOf(LedgerError);
          }
        }),
      ).toThrow("CONFIGURATION_CONFLICT");
      expect(store.read((tx) => tx.getWallet(createStoreWallet()))).toBeNull();
    } finally {
      store.close();
    }
  });
  test(name + ": closes escaped handles after return and rollback", () => {
    const store = factory();
    const saved: { tx: LedgerTransaction | null; read: LedgerReadView | null } = {
      tx: null,
      read: null,
    };
    try {
      store.transaction((tx) => {
        saved.tx = tx;
      });
      store.read((tx) => {
        saved.read = tx;
      });
      expect(() => saved.tx?.apply(createChanges())).toThrow("TRANSACTION_CLOSED");
      expect(() => saved.tx?.getWallet(createStoreWallet())).toThrow("TRANSACTION_CLOSED");
      expect(() => saved.read?.getWallet(createStoreWallet())).toThrow("TRANSACTION_CLOSED");
      expect(() =>
        store.transaction((tx) => {
          saved.tx = tx;
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(() => saved.tx?.getWallet(createStoreWallet())).toThrow("TRANSACTION_CLOSED");
    } finally {
      store.close();
    }
  });
  test(name + ": rejects nested reads, transactions and close during callbacks", () => {
    const store = factory();
    try {
      store.transaction(() => {
        expect(() => store.transaction(() => 1)).toThrow("NESTED_TRANSACTION");
        expect(() => store.read(() => 1)).toThrow("NESTED_TRANSACTION");
        expect(() => store.close()).toThrow("NESTED_TRANSACTION");
      });
      store.read(() => expect(() => store.transaction(() => 1)).toThrow("NESTED_TRANSACTION"));
    } finally {
      store.close();
    }
  });
  test(name + ": rejects async writes and fences resumed continuations", async () => {
    const store = factory();
    let continuation = Promise.resolve();
    try {
      expect(() =>
        store.transaction((tx) => {
          tx.apply(createChanges({ wallets: [createStoreWallet()] }));
          continuation = Promise.resolve().then(() => {
            expect(() => tx.apply(createChanges())).toThrow("TRANSACTION_CLOSED");
          });
          return continuation;
        }),
      ).toThrow("ASYNC_TRANSACTION");
      await continuation;
      expect(store.read((tx) => tx.getWallet(createStoreWallet()))).toBeNull();
      expect(() => store.transaction(() => ({ then() {} }))).toThrow("ASYNC_TRANSACTION");
      expect(() => store.read(() => Promise.resolve(1))).toThrow("ASYNC_TRANSACTION");
    } finally {
      store.close();
    }
  });
  test(name + ": reads have no write methods and close is terminal", () => {
    const store = factory();
    store.read((tx) => expect("apply" in tx).toBe(false));
    store.close();
    store.close();
    expect(() => store.read(() => 1)).toThrow("TRANSACTION_CLOSED");
    expect(() => store.transaction(() => 1)).toThrow("TRANSACTION_CLOSED");
  });
  test(name + ": supports immutable replay and isolates record scopes", () => {
    const store = factory();
    const r = createStoreRecords();
    try {
      store.transaction((tx) => tx.apply(createInitialChanges(r)));
      store.transaction((tx) =>
        tx.apply(createChanges({ wallets: [r.wallet], intents: [r.intent] })),
      );
      store.read((tx) => {
        expect(tx.getPolicy(r.scope)?.policy.digest).toBe(r.policy.policy.digest);
        expect(tx.getDelegation(r.scope)?.revision).toBe(1);
        expect(tx.getBudgets(r.scope).map((account) => account.accountId)).toEqual([
          "wallet-budget",
        ]);
        expect(tx.getBudget(r.wallet, "wallet-budget")?.ceilingAtomic).toBe(100n);
        expect(tx.findIntent(r.scope, r.intent.intent.idempotencyKey)?.intentId).toBe("intent-1");
        expect(tx.getIntent(r.scope, "intent-1")?.intent.amountAtomic).toBe(70n);
        expect(tx.getReservation(r.scope, "reservation-1")?.state).toBe("RESERVED");
        expect(tx.getExecution(r.scope, "execution-1")).toBeNull();
        expect(tx.getObservation(r.wallet, "missing")).toBeNull();
        expect(tx.getClock(r.wallet)).toBeNull();
        expect(tx.getFault(r.wallet)).toBeNull();
        expect(tx.getOutbox(r.wallet, "missing")).toBeNull();
        expect(Object.isFrozen(tx.getIntent(r.scope, "intent-1")?.scope)).toBe(true);
        expect(tx.getWallet({ ...r.wallet, ownerId: "other" })).toBeNull();
        const otherScope = { ...r.scope, agentId: "other-agent" };
        expect(tx.getIntent(otherScope, "intent-1")).toBeNull();
        expect(tx.getReservation(otherScope, "reservation-1")).toBeNull();
        expect(tx.getPolicy(otherScope)).toBeNull();
        expect(tx.getDelegation(otherScope)).toBeNull();
        expect(tx.getBudget({ ...r.wallet, walletId: "other" }, "wallet-budget")).toBeNull();
        expect(tx.getAllocations({ ...r.wallet, walletId: "other" }, ["wallet-budget"], 0)).toEqual(
          [],
        );
      });
    } finally {
      store.close();
    }
  });
  test(name + ": rejects duplicate retry identity, reservation membership and nonce", () => {
    const store = factory();
    const r = createStoreRecords();
    try {
      store.transaction((tx) => tx.apply(createInitialChanges(r)));
      expect(() =>
        store.transaction((tx) =>
          tx.apply(createChanges({ intents: [{ ...r.intent, intentId: "intent-2" }] })),
        ),
      ).toThrow("CONFIGURATION_CONFLICT");
      expect(() =>
        store.transaction((tx) =>
          tx.apply(
            createChanges({
              reservations: [
                {
                  record: { ...r.reservation, reservationId: "reservation-2" },
                  expectedState: null,
                },
              ],
            }),
          ),
        ),
      ).toThrow();
      store.transaction((tx) => tx.apply(createClaimChanges(r)));
      expect(store.read((tx) => tx.getExecution(r.scope, "execution-1"))?.binding.nonce).toBe(
        "b".repeat(64),
      );
      expect(() =>
        store.transaction((tx) =>
          tx.apply(createChanges({ executions: [{ ...r.execution, executionId: "execution-2" }] })),
        ),
      ).toThrow("CONFIGURATION_CONFLICT");
      expect(() =>
        store.transaction((tx) =>
          tx.apply(
            createChanges({
              executions: [{ ...r.execution, claimedAtMs: r.execution.claimedAtMs + 1 }],
            }),
          ),
        ),
      ).toThrow("CONFIGURATION_CONFLICT");
      expect(
        store.read((tx) => tx.getExecution({ ...r.scope, agentId: "other" }, "execution-1")),
      ).toBeNull();
    } finally {
      store.close();
    }
  });
  test(name + ": enforces revisions and immutable budget identity", () => {
    const store = factory();
    const r = createStoreRecords();
    try {
      store.transaction((tx) => tx.apply(createInitialChanges(r)));
      const revised = { ...r.budget, revision: 2, ceilingAtomic: 20n };
      store.transaction((tx) =>
        tx.apply(createChanges({ budgets: [{ account: revised, expectedRevision: 1 }] })),
      );
      expect(store.read((tx) => tx.getBudget(r.wallet, "wallet-budget"))?.ceilingAtomic).toBe(20n);
      expect(
        store.read((tx) => tx.getAllocations(r.wallet, ["wallet-budget"], 0))[0]?.amountAtomic,
      ).toBe(70n);
      expect(() =>
        store.transaction((tx) =>
          tx.apply(
            createChanges({
              budgets: [{ account: { ...revised, revision: 3 }, expectedRevision: 1 }],
            }),
          ),
        ),
      ).toThrow("CONFIGURATION_CONFLICT");
      expect(() =>
        store.transaction((tx) =>
          tx.apply(
            createChanges({
              budgets: [{ account: { ...revised, revision: 3, windowMs: 1 }, expectedRevision: 2 }],
            }),
          ),
        ),
      ).toThrow("CONFIGURATION_CONFLICT");
      expect(() =>
        store.transaction((tx) =>
          tx.apply(
            createChanges({
              budgets: [
                { account: { ...revised, revision: 3, ceilingAtomic: -1n }, expectedRevision: 2 },
              ],
            }),
          ),
        ),
      ).toThrow();
      const revoked = { ...r.delegation.wire, revoked: true };
      store.transaction((tx) =>
        tx.apply(
          createChanges({
            delegations: [
              {
                record: {
                  wire: revoked,
                  delegation: { ...r.delegation.delegation, revoked: true },
                  revision: 2,
                },
                expectedRevision: 1,
              },
            ],
          }),
        ),
      );
      expect(store.read((tx) => tx.getDelegation(r.scope))?.delegation.revoked).toBe(true);
      expect(() =>
        store.transaction((tx) =>
          tx.apply(createChanges({ delegations: [{ record: r.delegation, expectedRevision: 2 }] })),
        ),
      ).toThrow("CONFIGURATION_CONFLICT");
    } finally {
      store.close();
    }
  });
  test(name + ": rejects broken financial references without partial updates", () => {
    const store = factory();
    const r = createStoreRecords();
    try {
      expect(() =>
        store.transaction((tx) => tx.apply(createChanges({ intents: [r.intent] }))),
      ).toThrow("STORE_CORRUPT");
      store.transaction((tx) => tx.apply(createInitialChanges(r)));
      expect(() =>
        store.transaction((tx) =>
          tx.apply(
            createChanges({
              allocations: [
                {
                  wallet: r.wallet,
                  allocation: {
                    reservationId: "reservation-1",
                    accountId: "missing",
                    amountAtomic: 70n,
                    state: "RESERVED",
                    committedAtMs: null,
                  },
                  expectedState: null,
                },
              ],
            }),
          ),
        ),
      ).toThrow("STORE_CORRUPT");
      expect(() =>
        store.transaction((tx) =>
          tx.apply(
            createChanges({
              reservations: [
                {
                  record: {
                    ...r.reservation,
                    amountAtomic: 71n,
                    state: "EXECUTING",
                    executionId: "execution-1",
                  },
                  expectedState: "RESERVED",
                },
              ],
              executions: [r.execution],
            }),
          ),
        ),
      ).toThrow("CONFIGURATION_CONFLICT");
      expect(store.read((tx) => tx.getReservation(r.scope, "reservation-1"))?.state).toBe(
        "RESERVED",
      );
    } finally {
      store.close();
    }
  });
  test(name + ": lists exact expiry and retains unresolved allocations", () => {
    const store = factory();
    const r = createStoreRecords();
    try {
      store.transaction((tx) => tx.apply(createInitialChanges(r)));
      expect(
        store.read((tx) => tx.listExpirable(r.wallet, r.reservation.expiresAtMs - 1, 10)),
      ).toEqual([]);
      expect(
        store
          .read((tx) => tx.listExpirable(r.wallet, r.reservation.expiresAtMs, 10))
          .map((row) => row.reservationId),
      ).toEqual(["reservation-1"]);
      expect(
        store.read((tx) =>
          tx.getAllocations(r.wallet, ["wallet-budget"], Number.MAX_SAFE_INTEGER),
        )[0]?.amountAtomic,
      ).toBe(70n);
      expect(() => store.read((tx) => tx.listExpirable(r.wallet, 0, 0))).toThrow();
      expect(() => store.read((tx) => tx.listExpirable(r.wallet, 0, 1001))).toThrow();
      store.transaction((tx) => tx.apply(createClaimChanges(r)));
      expect(store.read((tx) => tx.listExpirable(r.wallet, Number.MAX_SAFE_INTEGER, 10))).toEqual(
        [],
      );
      expect(store.read((tx) => tx.listOrphans(r.wallet, r.execution.claimedAtMs - 1, 10))).toEqual(
        [],
      );
      expect(
        store
          .read((tx) => tx.listOrphans(r.wallet, r.execution.claimedAtMs, 10))
          .map((row) => row.reservationId),
      ).toEqual(["reservation-1"]);
    } finally {
      store.close();
    }
  });
  test(name + ": stores evidence, fenced delivery, clocks and faults atomically", () => {
    const store = factory();
    const r = createStoreRecords();
    const event = {
      eventId: "event-1",
      wallet: r.wallet,
      sequence: 1,
      kind: "DECISION" as const,
      subjectId: "intent-1",
      occurredAtMs: r.intent.createdAtMs,
      reason: null,
    };
    const pending = {
      eventId: event.eventId,
      wallet: r.wallet,
      state: "PENDING" as const,
      workerId: null,
      claimToken: null,
      leaseExpiresAtMs: null,
    };
    try {
      store.transaction((tx) => {
        tx.apply(createInitialChanges(r));
        tx.apply(createClaimChanges(r));
        tx.apply(
          createChanges({
            events: [event],
            outbox: [{ record: pending, expectedState: null, expectedClaimToken: null }],
            observations: [
              {
                wallet: r.wallet,
                observation: {
                  evidenceId: "evidence-1",
                  executionId: "execution-1",
                  bindingDigest: r.execution.bindingDigest,
                  kind: "SETTLED",
                  evidenceRef: "mock:receipt-1",
                },
              },
            ],
            clocks: [{ record: { wallet: r.wallet, highWaterMs: 100 }, expectedHighWaterMs: null }],
            faults: [
              { wallet: r.wallet, faultId: "fault-1", reason: "test-conflict", createdAtMs: 100 },
            ],
          }),
        );
      });
      store.read((tx) => {
        expect(tx.getObservation(r.wallet, "evidence-1")?.kind).toBe("SETTLED");
        expect(tx.getClock(r.wallet)?.highWaterMs).toBe(100);
        expect(tx.getFault(r.wallet)?.faultId).toBe("fault-1");
        expect(tx.listDeliverable(r.wallet, 100, 10).map((row) => row.eventId)).toEqual([
          "event-1",
        ]);
      });
      const claimed = {
        ...pending,
        state: "CLAIMED" as const,
        workerId: "worker-1",
        claimToken: "claim-1",
        leaseExpiresAtMs: 200,
      };
      store.transaction((tx) =>
        tx.apply(
          createChanges({
            outbox: [{ record: claimed, expectedState: "PENDING", expectedClaimToken: null }],
          }),
        ),
      );
      expect(store.read((tx) => tx.listDeliverable(r.wallet, 199, 10))).toEqual([]);
      expect(
        store.read((tx) => tx.listDeliverable(r.wallet, 200, 10)).map((row) => row.eventId),
      ).toEqual(["event-1"]);
      expect(() =>
        store.transaction((tx) =>
          tx.apply(
            createChanges({
              outbox: [
                {
                  record: { ...claimed, state: "DELIVERED" },
                  expectedState: "CLAIMED",
                  expectedClaimToken: "stale",
                },
              ],
            }),
          ),
        ),
      ).toThrow("CONFIGURATION_CONFLICT");
      store.transaction((tx) =>
        tx.apply(
          createChanges({
            outbox: [
              {
                record: { ...claimed, state: "DELIVERED" },
                expectedState: "CLAIMED",
                expectedClaimToken: "claim-1",
              },
            ],
          }),
        ),
      );
      expect(store.read((tx) => tx.listDeliverable(r.wallet, 200, 10))).toEqual([]);
      expect(() =>
        store.transaction((tx) =>
          tx.apply(
            createChanges({
              clocks: [{ record: { wallet: r.wallet, highWaterMs: 99 }, expectedHighWaterMs: 100 }],
            }),
          ),
        ),
      ).toThrow("CLOCK_REGRESSION");
      expect(() =>
        store.transaction((tx) =>
          tx.apply(
            createChanges({
              observations: [
                {
                  wallet: r.wallet,
                  observation: {
                    evidenceId: "evidence-1",
                    executionId: "execution-1",
                    bindingDigest: r.execution.bindingDigest,
                    kind: "FINAL_NON_EXECUTION",
                    evidenceRef: "mock:other",
                  },
                },
              ],
            }),
          ),
        ),
      ).toThrow("CONFIGURATION_CONFLICT");
      expect(store.read((tx) => tx.getOutbox(r.wallet, "event-1"))?.state).toBe("DELIVERED");
    } finally {
      store.close();
    }
  });
  test(
    name + ": preserves budget-denied retry identity and static ALLOW provenance without a hold",
    () => {
      const store = factory();
      const r = createStoreRecords();
      const initial = createInitialChanges(r);
      const denied: IntentRecord = {
        ...r.intent,
        reservationId: null,
        decision: { ...r.intent.decision, kind: "DENY", ledgerReasons: ["BUDGET_EXCEEDED"] },
      };
      try {
        store.transaction((tx) =>
          tx.apply(
            createChanges({
              wallets: initial.wallets,
              policies: initial.policies,
              delegations: initial.delegations,
              budgets: initial.budgets,
              intents: [denied],
            }),
          ),
        );
        store.transaction((tx) => tx.apply(createChanges({ intents: [denied] })));
        store.read((tx) => {
          const stored = tx.findIntent(r.scope, "request-1");
          expect(stored?.intentId).toBe("intent-1");
          expect(stored?.decision.kind).toBe("DENY");
          expect(stored?.decision.evaluation.kind).toBe("ALLOW");
          expect(stored?.decision.ledgerReasons).toEqual(["BUDGET_EXCEEDED"]);
          expect(stored?.reservationId).toBeNull();
          expect(Object.isFrozen(stored?.decision)).toBe(true);
          expect(tx.getReservation(r.scope, "reservation-1")).toBeNull();
          expect(tx.getAllocations(r.wallet, ["wallet-budget"], 0)).toEqual([]);
        });
        expect(() =>
          store.transaction((tx) =>
            tx.apply(
              createChanges({
                intents: [
                  {
                    ...denied,
                    decision: { ...denied.decision, ledgerReasons: ["WALLET_CONTAINED"] },
                  },
                ],
              }),
            ),
          ),
        ).toThrow("CONFIGURATION_CONFLICT");
      } finally {
        store.close();
      }
    },
  );

  test.each([
    { change: { network: "mock:unsupported" }, reason: "UNSUPPORTED_NETWORK" },
    { change: { asset: "mock:unsupported" }, reason: "UNSUPPORTED_ASSET" },
    { change: { delegationId: "other-delegation" }, reason: "SCOPE_MISMATCH" },
  ])(
    name + ": retains a valid request denied for $reason without making it executable",
    ({ change, reason }) => {
      const store = factory();
      const r = createStoreRecords();
      const wire = createIntent({ amountAtomic: "70", ...change });
      const evaluation = evaluatePolicy({
        intent: wire,
        policy: r.policy.wire,
        delegation: r.delegation.wire,
        scope: r.scope,
        nowMs: r.intent.createdAtMs,
      });
      expect(evaluation.kind).toBe("DENY");
      expect(evaluation.reasonCodes).toContain(reason);
      const denied: IntentRecord = {
        ...r.intent,
        intent: validatePaymentIntent(wire),
        intentDigest: evaluation.intentDigest,
        reservationId: null,
        decision: {
          kind: "DENY",
          evaluation,
          ledgerReasons: [],
          evaluatedAtMs: r.intent.createdAtMs,
        },
      };
      try {
        store.transaction((tx) =>
          tx.apply(createChanges({ wallets: [r.wallet], intents: [denied] })),
        );
        store.transaction((tx) => tx.apply(createChanges({ intents: [denied] })));
        store.read((tx) => {
          expect(tx.findIntent(r.scope, "request-1")?.decision.evaluation.reasonCodes).toContain(
            reason,
          );
          expect(tx.getIntent(r.scope, "intent-1")?.reservationId).toBeNull();
          expect(tx.getReservation(r.scope, "reservation-1")).toBeNull();
          expect(tx.getExecution(r.scope, "execution-1")).toBeNull();
          expect(tx.getAllocations(r.wallet, ["wallet-budget"], 0)).toEqual([]);
        });
        expect(() =>
          store.transaction((tx) =>
            tx.apply(
              createChanges({
                intents: [
                  {
                    ...denied,
                    intentId: "intent-2",
                    intent: { ...denied.intent, idempotencyKey: "request-2" },
                    reservationId: "reservation-2",
                  },
                ],
                reservations: [
                  {
                    record: {
                      ...r.reservation,
                      intentId: "intent-2",
                      reservationId: "reservation-2",
                    },
                    expectedState: null,
                  },
                ],
              }),
            ),
          ),
        ).toThrow("STORE_CORRUPT");
        expect(store.read((tx) => tx.getReservation(r.scope, "reservation-2"))).toBeNull();
      } finally {
        store.close();
      }
    },
  );

  test(name + ": identical local IDs in two wallets never combine allocations", () => {
    const store = factory();
    const first = createStoreRecords();
    const second = createStoreRecords({ ...first.scope, walletId: "wallet-2" });
    try {
      store.transaction((tx) => {
        tx.apply(createInitialChanges(first));
        tx.apply(createInitialChanges(second));
      });
      store.read((tx) => {
        expect(
          tx.getAllocations(first.wallet, ["wallet-budget"], 0).map((row) => row.amountAtomic),
        ).toEqual([70n]);
        expect(
          tx.getAllocations(second.wallet, ["wallet-budget"], 0).map((row) => row.amountAtomic),
        ).toEqual([70n]);
        expect(tx.getIntent(second.scope, "intent-1")?.scope.walletId).toBe("wallet-2");
      });
    } finally {
      store.close();
    }
  });

  test(name + ": a nonce cannot be reused by a different reservation", () => {
    const store = factory();
    const first = createStoreRecords();
    const second = createStoreRecords(first.scope, "2");
    const extra = createInitialChanges(second);
    try {
      store.transaction((tx) => {
        tx.apply(createInitialChanges(first));
        tx.apply(
          createChanges({
            intents: extra.intents,
            reservations: extra.reservations,
            allocations: extra.allocations,
          }),
        );
        tx.apply(createClaimChanges(first));
      });
      expect(() => store.transaction((tx) => tx.apply(createClaimChanges(second)))).toThrow(
        "CONFIGURATION_CONFLICT",
      );
      expect(store.read((tx) => tx.getReservation(second.scope, "reservation-2"))?.state).toBe(
        "RESERVED",
      );
      expect(store.read((tx) => tx.getExecution(second.scope, "execution-2"))).toBeNull();
    } finally {
      store.close();
    }
  });

  test(name + ": committed cutoff is exclusive and may precede epoch zero", () => {
    const store = factory();
    const r = createStoreRecords();
    const booked = r.intent.createdAtMs;
    try {
      store.transaction((tx) => {
        tx.apply(createInitialChanges(r));
        tx.apply(createClaimChanges(r));
        tx.apply(
          createChanges({
            reservations: [
              {
                record: { ...r.reservation, state: "COMMITTED", executionId: "execution-1" },
                expectedState: "EXECUTING",
              },
            ],
            allocations: [
              {
                wallet: r.wallet,
                allocation: {
                  reservationId: "reservation-1",
                  accountId: "wallet-budget",
                  amountAtomic: 70n,
                  state: "COMMITTED",
                  committedAtMs: booked,
                },
                expectedState: "EXECUTING",
              },
            ],
          }),
        );
      });
      expect(store.read((tx) => tx.getAllocations(r.wallet, ["wallet-budget"], booked))).toEqual(
        [],
      );
      expect(
        store
          .read((tx) => tx.getAllocations(r.wallet, ["wallet-budget"], booked - 1))
          .map((row) => row.amountAtomic),
      ).toEqual([70n]);
      expect(
        store
          .read((tx) => tx.getAllocations(r.wallet, ["wallet-budget"], -60_000))
          .map((row) => row.amountAtomic),
      ).toEqual([70n]);
      expect(store.read((tx) => tx.listOrphans(r.wallet, -1, 10))).toEqual([]);
    } finally {
      store.close();
    }
  });

  test(name + ": tied worker deadlines use case-sensitive identifier order before limiting", () => {
    const store = factory();
    const first = createStoreRecords();
    const upper = createStoreRecords(first.scope, "A");
    const lower = createStoreRecords(first.scope, "a");
    const extra = createInitialChanges(lower);
    try {
      store.transaction((tx) => {
        tx.apply(createInitialChanges(upper));
        tx.apply(
          createChanges({
            intents: extra.intents,
            reservations: extra.reservations,
            allocations: extra.allocations,
          }),
        );
      });
      expect(
        store
          .read((tx) => tx.listExpirable(first.wallet, upper.reservation.expiresAtMs, 1))
          .map((row) => row.reservationId),
      ).toEqual(["reservation-A"]);
    } finally {
      store.close();
    }
  });

  test(name + ": rejects getters and cyclic record data before any write", () => {
    const store = factory();
    try {
      const accessor = createStoreWallet();
      let invoked = false;
      Object.defineProperty(accessor, "signerId", {
        get() {
          invoked = true;
          return "secret";
        },
      });
      expect(() =>
        store.transaction((tx) => tx.apply(createChanges({ wallets: [accessor] }))),
      ).toThrow("STORE_CORRUPT");
      expect(invoked).toBe(false);
      const cyclic = createStoreWallet();
      Reflect.set(cyclic, "cycle", cyclic);
      expect(() =>
        store.transaction((tx) => tx.apply(createChanges({ wallets: [cyclic] }))),
      ).toThrow("STORE_CORRUPT");
      expect(store.read((tx) => tx.getWallet(createStoreWallet()))).toBeNull();
    } finally {
      store.close();
    }
  });

  test(name + ": async read handles cannot resume after rejection", async () => {
    const store = factory();
    let resumed = Promise.resolve();
    try {
      expect(() =>
        store.read((tx) => {
          resumed = Promise.resolve().then(() => {
            expect(() => tx.getWallet(createStoreWallet())).toThrow("TRANSACTION_CLOSED");
          });
          return resumed;
        }),
      ).toThrow("ASYNC_TRANSACTION");
      await resumed;
      const thenable = Object.assign(() => 1, { then() {} });
      expect(() => store.transaction(() => thenable)).toThrow("ASYNC_TRANSACTION");
    } finally {
      store.close();
    }
  });

  test(name + ": wallet-wide admission reads preserve ownership and ordered event identity", () => {
    const store = factory();
    const r = createStoreRecords();
    const other = { ownerId: "other-owner", walletId: r.wallet.walletId };
    try {
      store.transaction((tx) => tx.apply(createInitialChanges(r)));
      store.transaction((tx) =>
        tx.apply(
          createChanges({
            budgets: [
              {
                account: {
                  ...r.budget,
                  accountId: "other-agent-budget",
                  scope: {
                    ownerId: r.scope.ownerId,
                    walletId: r.scope.walletId,
                    kind: "AGENT",
                    agentId: "agent-2",
                  },
                },
                expectedRevision: null,
              },
            ],
            events: [
              {
                eventId: "late",
                wallet: r.wallet,
                sequence: 3,
                kind: "DECISION",
                subjectId: "intent-1",
                occurredAtMs: r.intent.createdAtMs,
                reason: null,
              },
              {
                eventId: "early",
                wallet: r.wallet,
                sequence: 1,
                kind: "CONFIGURATION",
                subjectId: "wallet-1",
                occurredAtMs: r.intent.createdAtMs,
                reason: null,
              },
            ],
          }),
        ),
      );
      store.read((tx) => {
        expect(tx.listBudgets(r.wallet).map((account) => account.accountId)).toEqual([
          "other-agent-budget",
          "wallet-budget",
        ]);
        expect(tx.listBudgets(other)).toEqual([]);
        expect(tx.hasIntents(r.wallet)).toBe(true);
        expect(tx.hasIntents(other)).toBe(false);
        expect(tx.getLatestEvent(r.wallet)?.sequence).toBe(3);
        expect(tx.getLatestEvent(other)).toBeNull();
        expect(tx.getEvent(r.wallet, "early")?.sequence).toBe(1);
        expect(tx.getEvent(other, "early")).toBeNull();
      });
    } finally {
      store.close();
    }
  });

  test(name + ": an escaped read cannot bypass lifetime checks with an empty account list", () => {
    const store = factory();
    const saved: { view: LedgerReadView | null } = { view: null };
    try {
      store.read((view) => {
        saved.view = view;
      });
      expect(() => saved.view?.getAllocations(createStoreWallet(), [], 0)).toThrow(
        "TRANSACTION_CLOSED",
      );
    } finally {
      store.close();
    }
  });

  test(
    name + ": identical delivered outbox replay tolerates a structural wallet configuration",
    () => {
      const store = factory();
      const r = createStoreRecords();
      const pending = {
        eventId: "event-1",
        wallet: r.wallet,
        state: "PENDING" as const,
        workerId: null,
        claimToken: null,
        leaseExpiresAtMs: null,
      };
      const claimed = {
        ...pending,
        state: "CLAIMED" as const,
        workerId: "worker-1",
        claimToken: "claim-1",
        leaseExpiresAtMs: r.intent.createdAtMs + 1000,
      };
      const delivered = { ...claimed, state: "DELIVERED" as const };
      try {
        store.transaction((tx) => {
          tx.apply(createInitialChanges(r));
          tx.apply(
            createChanges({
              events: [
                {
                  eventId: "event-1",
                  wallet: r.wallet,
                  sequence: 1,
                  kind: "DECISION",
                  subjectId: "intent-1",
                  occurredAtMs: r.intent.createdAtMs,
                  reason: null,
                },
              ],
              outbox: [{ record: pending, expectedState: null, expectedClaimToken: null }],
            }),
          );
        });
        store.transaction((tx) =>
          tx.apply(
            createChanges({
              outbox: [{ record: claimed, expectedState: "PENDING", expectedClaimToken: null }],
            }),
          ),
        );
        store.transaction((tx) =>
          tx.apply(
            createChanges({
              outbox: [
                { record: delivered, expectedState: "CLAIMED", expectedClaimToken: "claim-1" },
              ],
            }),
          ),
        );
        store.transaction((tx) =>
          tx.apply(
            createChanges({
              outbox: [
                { record: delivered, expectedState: "DELIVERED", expectedClaimToken: "claim-1" },
              ],
            }),
          ),
        );
        expect(store.read((tx) => tx.getOutbox(r.wallet, "event-1"))?.state).toBe("DELIVERED");
      } finally {
        store.close();
      }
    },
  );
}
