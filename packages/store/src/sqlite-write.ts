/** @file Typed Drizzle batches preserving immutable identities, revision fences and financial links. */
import { isDeepStrictEqual } from "node:util";
import { and, eq, isNull } from "drizzle-orm";
import {
  canTransitionReservation,
  type LedgerChanges,
  type LedgerReadView,
  type WalletScope,
  type TrustedScope,
  type WalletConfiguration,
  type ReservationRecord,
} from "@scuta/core";
import { assertStore, recordKey } from "./memory-state.js";
import { encodeLedgerRow } from "./row-codecs.js";
import type { SqliteQueries } from "./sqlite-queries.js";
import { scopeCondition, walletCondition } from "./sqlite-read.js";

/** Optional payment profile compared with immutable wallet configuration. */
type PaymentProfile = Pick<WalletConfiguration, "network" | "asset">;

/** Require a configured wallet and optional matching profile.
 * @param view - Current transaction's checked reads.
 * @param wallet - Record ownership.
 * @param profile - Required network/asset when applicable.
 */
function requireWallet(view: LedgerReadView, wallet: WalletScope, profile?: PaymentProfile): void {
  const configured = view.getWallet(wallet);
  assertStore(configured !== null);
  if (profile)
    assertStore(configured.network === profile.network && configured.asset === profile.asset);
}

/** Verify affected reservation membership and immutable execution bindings.
 * @param q - Current transaction's typed Drizzle operations.
 * @param view - Reads on that same transaction.
 * @param reservation - Affected validated reservation.
 */
function verifyReservation(
  q: SqliteQueries,
  view: LedgerReadView,
  reservation: ReservationRecord,
): void {
  const scope = reservation.scope;
  const intent = view.getIntent(scope, reservation.intentId);
  assertStore(intent !== null && intent.reservationId === reservation.reservationId);
  assertStore(
    intent.decision.kind === "ALLOW" &&
      intent.intent.amountAtomic === reservation.amountAtomic &&
      intent.decision.evaluation.policyDigest === reservation.policyDigest,
  );
  const policy = q.get("policySnapshot", (t) =>
    and(scopeCondition(t, scope), eq(t.digest, reservation.policyDigest)),
  );
  const delegation = q.get("delegationSnapshot", (t) =>
    and(scopeCondition(t, scope), eq(t.revision, reservation.delegationRevision)),
  );
  assertStore(policy !== null && delegation !== null);
  const allocations = q.list("allocation", (t) =>
    and(walletCondition(t, scope), eq(t.reservationId, reservation.reservationId)),
  );
  for (const { allocation } of allocations) {
    const budget = view.getBudget(scope, allocation.accountId);
    assertStore(budget !== null);
    assertStore(
      (budget.scope.kind === "WALLET" ||
        (budget.scope.agentId === scope.agentId &&
          (budget.scope.kind === "AGENT" || budget.scope.delegationId === scope.delegationId))) &&
        allocation.amountAtomic === reservation.amountAtomic &&
        allocation.state === reservation.state,
    );
  }
  const executions = q.list("execution", (t) =>
    and(walletCondition(t, scope), eq(t.reservationId, reservation.reservationId)),
  );
  if (reservation.executionId === null) {
    assertStore(executions.length === 0);
    return;
  }
  assertStore(executions.length === 1);
  const execution = view.getExecution(scope, reservation.executionId);
  const wallet = view.getWallet(scope);
  assertStore(execution !== null && wallet !== null);
  assertStore(
    execution.binding.reservationId === reservation.reservationId &&
      execution.binding.intentDigest === intent.intentDigest &&
      execution.binding.amountAtomic === reservation.amountAtomic &&
      execution.binding.recipient === intent.intent.recipient &&
      execution.binding.network === wallet.network &&
      execution.binding.asset === wallet.asset &&
      execution.binding.signerId === wallet.signerId,
  );
}

/** Validate changed financial graphs and unchanged dependents before the batch can commit.
 * @param q - Transaction-owned Drizzle operations.
 * @param view - Same-transaction checked reads.
 * @param changes - Complete applied batch.
 */
function verifyReferences(q: SqliteQueries, view: LedgerReadView, changes: LedgerChanges): void {
  const affected = new Map<string, { readonly scope: TrustedScope; readonly id: string }>();
  for (const { record } of changes.reservations)
    affected.set(recordKey(record.scope, record.reservationId), {
      scope: record.scope,
      id: record.reservationId,
    });
  for (const record of changes.intents)
    if (record.reservationId !== null)
      affected.set(recordKey(record.scope, record.reservationId), {
        scope: record.scope,
        id: record.reservationId,
      });
  for (const { binding } of changes.executions)
    affected.set(recordKey(binding.scope, binding.reservationId), {
      scope: binding.scope,
      id: binding.reservationId,
    });
  for (const { wallet, allocation } of changes.allocations) {
    const record = q.get("reservation", (t) =>
      and(walletCondition(t, wallet), eq(t.reservationId, allocation.reservationId)),
    );
    assertStore(record !== null);
    affected.set(recordKey(record.scope, record.reservationId), {
      scope: record.scope,
      id: record.reservationId,
    });
  }
  for (const { scope, id } of affected.values()) {
    const record = view.getReservation(scope, id);
    assertStore(record !== null);
    verifyReservation(q, view, record);
  }
  for (const { wallet, observation } of changes.observations) {
    const execution = q.get("execution", (t) =>
      and(walletCondition(t, wallet), eq(t.executionId, observation.executionId)),
    );
    assertStore(execution !== null && execution.bindingDigest === observation.bindingDigest);
  }
  for (const { record } of changes.outbox)
    assertStore(
      q.get("event", (t) =>
        and(walletCondition(t, record.wallet), eq(t.eventId, record.eventId)),
      ) !== null,
    );
}

/** Apply one complete guarded batch inside its owning immediate transaction.
 * @param q - Lifetime-owned Drizzle operations.
 * @param view - Reads of this same transaction, never another connection.
 * @param changes - Independently owned inert typed batch.
 */
export function applySqliteChanges(
  q: SqliteQueries,
  view: LedgerReadView,
  changes: LedgerChanges,
): void {
  for (const wallet of changes.wallets)
    q.immutable("wallet", wallet, (t) => walletCondition(t, wallet));
  for (const { record, expectedDigest } of changes.policies) {
    encodeLedgerRow("policySnapshot", record);
    const scope = record.policy.scope;
    requireWallet(view, scope, record.policy);
    const previous = view.getPolicy(scope);
    assertStore((previous?.policy.digest ?? null) === expectedDigest, "CONFIGURATION_CONFLICT");
    q.immutable("policySnapshot", record, (t) =>
      and(
        scopeCondition(t, scope),
        eq(t.policyId, record.policy.policyId),
        eq(t.version, record.policy.version),
      ),
    );
    const active = {
      scope,
      policyId: record.policy.policyId,
      version: record.policy.version,
      digest: record.policy.digest,
    };
    if (previous)
      q.replace("activePolicy", active, (t) =>
        and(scopeCondition(t, scope), eq(t.digest, previous.policy.digest)),
      );
    else q.insert("activePolicy", active);
  }
  for (const { record, expectedRevision } of changes.delegations) {
    encodeLedgerRow("delegationSnapshot", record);
    const scope = record.delegation.scope;
    requireWallet(view, scope);
    const previous = view.getDelegation(scope);
    assertStore((previous?.revision ?? null) === expectedRevision, "CONFIGURATION_CONFLICT");
    if (previous) assertStore(previous.revision < Number.MAX_SAFE_INTEGER, "COUNTER_EXHAUSTED");
    assertStore(
      record.revision === (previous ? previous.revision + 1 : 1),
      "CONFIGURATION_CONFLICT",
    );
    q.immutable("delegationSnapshot", record, (t) =>
      and(scopeCondition(t, scope), eq(t.revision, record.revision)),
    );
    const active = { scope, revision: record.revision };
    if (previous)
      q.replace("activeDelegation", active, (t) =>
        and(scopeCondition(t, scope), eq(t.revision, previous.revision)),
      );
    else q.insert("activeDelegation", active);
  }
  for (const { account, expectedRevision } of changes.budgets) {
    encodeLedgerRow("budget", account);
    requireWallet(view, account.scope, account);
    const previous = view.getBudget(account.scope, account.accountId);
    assertStore((previous?.revision ?? null) === expectedRevision, "CONFIGURATION_CONFLICT");
    if (previous) {
      assertStore(previous.revision < Number.MAX_SAFE_INTEGER, "COUNTER_EXHAUSTED");
      assertStore(
        isDeepStrictEqual(
          { ...account, revision: previous.revision, ceilingAtomic: previous.ceilingAtomic },
          previous,
        ),
        "CONFIGURATION_CONFLICT",
      );
    }
    assertStore(
      account.revision === (previous ? previous.revision + 1 : 1),
      "CONFIGURATION_CONFLICT",
    );
    if (previous)
      q.replace("budget", account, (t) =>
        and(
          walletCondition(t, account.scope),
          eq(t.accountId, account.accountId),
          eq(t.revision, previous.revision),
        ),
      );
    else q.insert("budget", account);
  }
  for (const intent of changes.intents) {
    encodeLedgerRow("intent", intent);
    requireWallet(view, intent.scope, intent.decision.kind === "DENY" ? undefined : intent.intent);
    q.immutable("intent", intent, (t) =>
      and(walletCondition(t, intent.scope), eq(t.intentId, intent.intentId)),
    );
  }
  for (const { record, expectedState } of changes.reservations) {
    encodeLedgerRow("reservation", record);
    const previous = q.get("reservation", (t) =>
      and(walletCondition(t, record.scope), eq(t.reservationId, record.reservationId)),
    );
    assertStore((previous?.state ?? null) === expectedState, "CONFIGURATION_CONFLICT");
    if (previous) {
      assertStore(
        isDeepStrictEqual(
          {
            ...record,
            state: previous.state,
            updatedAtMs: previous.updatedAtMs,
            executionId: previous.executionId,
          },
          previous,
        ),
        "CONFIGURATION_CONFLICT",
      );
      assertStore(
        previous.executionId === null || previous.executionId === record.executionId,
        "CONFIGURATION_CONFLICT",
      );
      assertStore(record.updatedAtMs >= previous.updatedAtMs);
      assertStore(
        isDeepStrictEqual(previous, record) ||
          canTransitionReservation(previous.state, record.state),
        "CONFIGURATION_CONFLICT",
      );
      q.replace("reservation", record, (t) =>
        and(
          walletCondition(t, record.scope),
          eq(t.reservationId, record.reservationId),
          eq(t.state, previous.state),
        ),
      );
    } else {
      assertStore(record.state === "RESERVED" && record.executionId === null);
      q.insert("reservation", record);
    }
  }
  for (const { wallet, allocation, expectedState } of changes.allocations) {
    encodeLedgerRow("allocation", { wallet, allocation });
    const previous =
      q.get("allocation", (t) =>
        and(
          walletCondition(t, wallet),
          eq(t.accountId, allocation.accountId),
          eq(t.reservationId, allocation.reservationId),
        ),
      )?.allocation ?? null;
    assertStore((previous?.state ?? null) === expectedState, "CONFIGURATION_CONFLICT");
    if (previous) {
      assertStore(allocation.amountAtomic === previous.amountAtomic, "CONFIGURATION_CONFLICT");
      assertStore(
        isDeepStrictEqual(previous, allocation) ||
          canTransitionReservation(previous.state, allocation.state),
        "CONFIGURATION_CONFLICT",
      );
      q.replace("allocation", { wallet, allocation }, (t) =>
        and(
          walletCondition(t, wallet),
          eq(t.accountId, allocation.accountId),
          eq(t.reservationId, allocation.reservationId),
          eq(t.state, previous.state),
        ),
      );
    } else q.insert("allocation", { wallet, allocation });
  }
  for (const execution of changes.executions)
    q.immutable("execution", execution, (t) =>
      and(walletCondition(t, execution.binding.scope), eq(t.executionId, execution.executionId)),
    );
  for (const record of changes.observations)
    q.immutable("observation", record, (t) =>
      and(walletCondition(t, record.wallet), eq(t.evidenceId, record.observation.evidenceId)),
    );
  for (const event of changes.events)
    q.immutable("event", event, (t) =>
      and(walletCondition(t, event.wallet), eq(t.eventId, event.eventId)),
    );
  for (const { record, expectedState, expectedClaimToken } of changes.outbox) {
    encodeLedgerRow("outbox", record);
    const previous = view.getOutbox(record.wallet, record.eventId);
    assertStore(
      (previous?.state ?? null) === expectedState &&
        (previous?.claimToken ?? null) === expectedClaimToken,
      "CONFIGURATION_CONFLICT",
    );
    if (previous) {
      assertStore(
        previous.state !== "DELIVERED" ||
          isDeepStrictEqual(encodeLedgerRow("outbox", previous), encodeLedgerRow("outbox", record)),
        "CONFIGURATION_CONFLICT",
      );
      if (record.state === "PENDING")
        assertStore(previous.state === "PENDING", "CONFIGURATION_CONFLICT");
      if (record.state === "DELIVERED")
        assertStore(
          previous.state === "CLAIMED" || previous.state === "DELIVERED",
          "CONFIGURATION_CONFLICT",
        );
      q.replace("outbox", record, (t) =>
        and(
          walletCondition(t, record.wallet),
          eq(t.eventId, record.eventId),
          eq(t.state, previous.state),
          expectedClaimToken === null ? isNull(t.claimToken) : eq(t.claimToken, expectedClaimToken),
        ),
      );
    } else {
      assertStore(record.state === "PENDING", "CONFIGURATION_CONFLICT");
      q.insert("outbox", record);
    }
  }
  for (const { record, expectedHighWaterMs } of changes.clocks) {
    encodeLedgerRow("clock", record);
    requireWallet(view, record.wallet);
    const previous = view.getClock(record.wallet);
    assertStore((previous?.highWaterMs ?? null) === expectedHighWaterMs, "CONFIGURATION_CONFLICT");
    assertStore(
      previous === null || record.highWaterMs >= previous.highWaterMs,
      "CLOCK_REGRESSION",
    );
    if (previous)
      q.replace("clock", record, (t) =>
        and(walletCondition(t, record.wallet), eq(t.highWaterMs, previous.highWaterMs)),
      );
    else q.insert("clock", record);
  }
  for (const fault of changes.faults) {
    requireWallet(view, fault.wallet);
    q.immutable("fault", fault, (t) => walletCondition(t, fault.wallet));
  }
  verifyReferences(q, view, changes);
}
