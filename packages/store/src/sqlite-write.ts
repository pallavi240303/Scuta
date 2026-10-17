/** @file Guarded SQLite batches preserving immutable identities, revision fences and financial links. */
import { isDeepStrictEqual } from "node:util";
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
import { SCOPE_WHERE, WALLET_WHERE, scopeValues, walletValues } from "./sqlite-read.js";

/** Optional payment profile compared with immutable wallet configuration. */
type PaymentProfile = Pick<WalletConfiguration, "network" | "asset">;

/** Require a configured wallet and optional matching payment profile.
 * @param view - Current transaction's checked read methods.
 * @param wallet - Record ownership.
 * @param profile - Required network/asset when applicable.
 */
function requireWallet(view: LedgerReadView, wallet: WalletScope, profile?: PaymentProfile): void {
  const configured = view.getWallet(wallet);
  assertStore(configured !== null);
  if (profile)
    assertStore(configured.network === profile.network && configured.asset === profile.asset);
}

/** Verify a reservation and its dependent records after a complete typed batch.
 * @param queries - Current callback's typed prepared statements.
 * @param view - Scoped reads on the same transaction.
 * @param reservation - Validated affected reservation.
 */
function verifyReservation(
  queries: SqliteQueries,
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
  const policy = queries.get("policySnapshot", SCOPE_WHERE + " AND digest=?", [
    ...scopeValues(scope),
    reservation.policyDigest,
  ]);
  const delegation = queries.get("delegationSnapshot", SCOPE_WHERE + " AND revision=?", [
    ...scopeValues(scope),
    reservation.delegationRevision,
  ]);
  assertStore(policy !== null && delegation !== null);
  const allocations = queries.list("allocation", WALLET_WHERE + " AND reservationId=?", [
    ...walletValues(scope),
    reservation.reservationId,
  ]);
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
  const executions = queries.list("execution", WALLET_WHERE + " AND reservationId=?", [
    ...walletValues(scope),
    reservation.reservationId,
  ]);
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

/** Check affected financial graphs, including unchanged dependents of a changed reservation.
 * @param queries - Current callback's typed prepared statements.
 * @param view - Current checked read view.
 * @param changes - Complete applied batch.
 */
function verifyReferences(
  queries: SqliteQueries,
  view: LedgerReadView,
  changes: LedgerChanges,
): void {
  const affected = new Map<string, { readonly scope: TrustedScope; readonly id: string }>();
  for (const { record } of changes.reservations)
    affected.set(recordKey(record.scope, record.reservationId), {
      scope: record.scope,
      id: record.reservationId,
    });
  for (const record of changes.intents) {
    if (record.reservationId !== null)
      affected.set(recordKey(record.scope, record.reservationId), {
        scope: record.scope,
        id: record.reservationId,
      });
  }
  for (const { binding } of changes.executions)
    affected.set(recordKey(binding.scope, binding.reservationId), {
      scope: binding.scope,
      id: binding.reservationId,
    });
  for (const { wallet, allocation } of changes.allocations) {
    const record = queries.get("reservation", WALLET_WHERE + " AND reservationId=?", [
      ...walletValues(wallet),
      allocation.reservationId,
    ]);
    assertStore(record !== null);
    affected.set(recordKey(record.scope, record.reservationId), {
      scope: record.scope,
      id: record.reservationId,
    });
  }
  for (const { scope, id } of affected.values()) {
    const record = view.getReservation(scope, id);
    assertStore(record !== null);
    verifyReservation(queries, view, record);
  }
  for (const { wallet, observation } of changes.observations) {
    const execution = queries.get("execution", WALLET_WHERE + " AND executionId=?", [
      ...walletValues(wallet),
      observation.executionId,
    ]);
    assertStore(execution !== null && execution.bindingDigest === observation.bindingDigest);
  }
  for (const { record } of changes.outbox)
    assertStore(
      queries.get("event", WALLET_WHERE + " AND eventId=?", [
        ...walletValues(record.wallet),
        record.eventId,
      ]) !== null,
    );
}

/** Apply a complete batch inside the owning immediate transaction; any failure must poison it.
 * @param queries - Lifetime-owned query operations.
 * @param view - Reads of this same transaction, never a separate connection.
 * @param changes - Independently owned inert batch.
 */
export function applySqliteChanges(
  queries: SqliteQueries,
  view: LedgerReadView,
  changes: LedgerChanges,
): void {
  for (const wallet of changes.wallets)
    queries.immutable("wallet", wallet, WALLET_WHERE, walletValues(wallet));
  for (const { record, expectedDigest } of changes.policies) {
    encodeLedgerRow("policySnapshot", record);
    const scope = record.policy.scope;
    requireWallet(view, scope, record.policy);
    const previous = view.getPolicy(scope);
    assertStore((previous?.policy.digest ?? null) === expectedDigest, "CONFIGURATION_CONFLICT");
    queries.immutable("policySnapshot", record, SCOPE_WHERE + " AND policyId=? AND version=?", [
      ...scopeValues(scope),
      record.policy.policyId,
      record.policy.version,
    ]);
    const active = {
      scope,
      policyId: record.policy.policyId,
      version: record.policy.version,
      digest: record.policy.digest,
    };
    if (previous)
      queries.replace("activePolicy", active, SCOPE_WHERE + " AND digest=?", [
        ...scopeValues(scope),
        expectedDigest,
      ]);
    else queries.insert("activePolicy", active);
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
    queries.immutable("delegationSnapshot", record, SCOPE_WHERE + " AND revision=?", [
      ...scopeValues(scope),
      record.revision,
    ]);
    const active = { scope, revision: record.revision };
    if (previous)
      queries.replace("activeDelegation", active, SCOPE_WHERE + " AND revision=?", [
        ...scopeValues(scope),
        expectedRevision,
      ]);
    else queries.insert("activeDelegation", active);
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
      queries.replace("budget", account, WALLET_WHERE + " AND accountId=? AND revision=?", [
        ...walletValues(account.scope),
        account.accountId,
        expectedRevision,
      ]);
    else queries.insert("budget", account);
  }
  for (const intent of changes.intents) {
    encodeLedgerRow("intent", intent);
    requireWallet(view, intent.scope, intent.decision.kind === "DENY" ? undefined : intent.intent);
    queries.immutable("intent", intent, WALLET_WHERE + " AND intentId=?", [
      ...walletValues(intent.scope),
      intent.intentId,
    ]);
  }
  for (const { record, expectedState } of changes.reservations) {
    encodeLedgerRow("reservation", record);
    const values = [...walletValues(record.scope), record.reservationId];
    const clause = WALLET_WHERE + " AND reservationId=?";
    const previous = queries.get("reservation", clause, values);
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
      queries.replace("reservation", record, clause + " AND state=?", [...values, expectedState]);
    } else {
      assertStore(record.state === "RESERVED" && record.executionId === null);
      queries.insert("reservation", record);
    }
  }
  for (const { wallet, allocation, expectedState } of changes.allocations) {
    encodeLedgerRow("allocation", { wallet, allocation });
    const values = [...walletValues(wallet), allocation.accountId, allocation.reservationId];
    const clause = WALLET_WHERE + " AND accountId=? AND reservationId=?";
    const previous = queries.get("allocation", clause, values)?.allocation ?? null;
    assertStore((previous?.state ?? null) === expectedState, "CONFIGURATION_CONFLICT");
    if (previous) {
      assertStore(allocation.amountAtomic === previous.amountAtomic, "CONFIGURATION_CONFLICT");
      assertStore(
        isDeepStrictEqual(previous, allocation) ||
          canTransitionReservation(previous.state, allocation.state),
        "CONFIGURATION_CONFLICT",
      );
      queries.replace("allocation", { wallet, allocation }, clause + " AND state=?", [
        ...values,
        expectedState,
      ]);
    } else queries.insert("allocation", { wallet, allocation });
  }
  for (const execution of changes.executions)
    queries.immutable("execution", execution, WALLET_WHERE + " AND executionId=?", [
      ...walletValues(execution.binding.scope),
      execution.executionId,
    ]);
  for (const record of changes.observations)
    queries.immutable("observation", record, WALLET_WHERE + " AND evidenceId=?", [
      ...walletValues(record.wallet),
      record.observation.evidenceId,
    ]);
  for (const event of changes.events)
    queries.immutable("event", event, WALLET_WHERE + " AND eventId=?", [
      ...walletValues(event.wallet),
      event.eventId,
    ]);
  for (const { record, expectedState, expectedClaimToken } of changes.outbox) {
    encodeLedgerRow("outbox", record);
    const values = [...walletValues(record.wallet), record.eventId];
    const clause = WALLET_WHERE + " AND eventId=?";
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
      queries.replace("outbox", record, clause + " AND state=? AND claimToken IS ?", [
        ...values,
        expectedState,
        expectedClaimToken,
      ]);
    } else {
      assertStore(record.state === "PENDING", "CONFIGURATION_CONFLICT");
      queries.insert("outbox", record);
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
      queries.replace("clock", record, WALLET_WHERE + " AND highWaterMs=?", [
        ...walletValues(record.wallet),
        expectedHighWaterMs,
      ]);
    else queries.insert("clock", record);
  }
  for (const fault of changes.faults) {
    requireWallet(view, fault.wallet);
    queries.immutable("fault", fault, WALLET_WHERE, walletValues(fault.wallet));
  }
  verifyReferences(queries, view, changes);
}
