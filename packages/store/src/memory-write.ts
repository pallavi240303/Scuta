/** @file Apply typed memory batches with immutable identities, revision fences and financial references. */
import { isDeepStrictEqual } from "node:util";
import {
  canTransitionReservation,
  computeExecutionBindingDigest,
  computeIntentDigest,
  computePayloadDigest,
  serializeAtomicAmount,
  validateBudgetAccount,
  validateDelegation,
  validateExecutionBinding,
  validateLedgerObservation,
  validatePaymentIntent,
  validatePolicy,
  validateWalletConfiguration,
  type LedgerChanges,
  type WalletScope,
  type BudgetScope,
  type TrustedScope,
  type WalletConfiguration,
} from "@scuta/core";
import {
  assertIdentifier,
  assertInteger,
  assertStore,
  recordKey,
  scopeKey,
  walletKey,
  type MemoryState,
} from "./memory-state.js";

/** Configured network and asset labels compared at storage boundaries. */
type PaymentProfile = Pick<WalletConfiguration, "network" | "asset">;

/** Insert an immutable record or accept exact replay without overwriting history.
 * @param table - Private target table.
 * @param key - Scoped record identity.
 * @param record - Independently owned immutable record.
 * @throws {LedgerError} If an existing identity has different content.
 */
function insertImmutable<T>(table: Map<string, T>, key: string, record: T): void {
  const previous = table.get(key);
  assertStore(
    previous === undefined || isDeepStrictEqual(previous, record),
    "CONFIGURATION_CONFLICT",
  );
  if (previous === undefined) table.set(key, record);
}

/** Require a configured wallet with matching payment profile.
 * @param state - Candidate tables.
 * @param wallet - Record namespace.
 * @param profile - Optional network and asset to compare.
 * @throws {LedgerError} If ownership or profile cannot be resolved.
 */
function requireWallet(state: MemoryState, wallet: WalletScope, profile?: PaymentProfile): void {
  const configured = state.wallets.get(walletKey(wallet));
  assertStore(configured !== undefined);
  if (profile)
    assertStore(configured.network === profile.network && configured.asset === profile.asset);
}

/** Check whether a configured budget applies to a principal.
 * @param budget - Wallet, agent or delegation account scope.
 * @param scope - Reservation principal.
 * @returns Whether the scope belongs to this account.
 */
function budgetApplies(budget: BudgetScope, scope: TrustedScope): boolean {
  return (
    walletKey(budget) === walletKey(scope) &&
    (budget.kind === "WALLET" ||
      (budget.agentId === scope.agentId &&
        (budget.kind === "AGENT" || budget.delegationId === scope.delegationId)))
  );
}

/** Apply all table changes to a disposable candidate.
 * @param state - Candidate table maps; never the committed state.
 * @param changes - Independently owned frozen batch.
 * @throws {LedgerError} If a uniqueness, identity, revision or reference constraint fails.
 * @throws {ValidationError} If configuration or financial wire reconstruction is malformed.
 */
export function applyMemoryChanges(state: MemoryState, changes: LedgerChanges): void {
  for (const wallet of changes.wallets) {
    validateWalletConfiguration(wallet);
    insertImmutable(state.wallets, walletKey(wallet), wallet);
  }
  for (const { record, expectedDigest } of changes.policies) {
    const validated = validatePolicy(record.wire);
    assertStore(isDeepStrictEqual(validated, record.policy));
    requireWallet(state, record.policy.scope, record.policy);
    const key = scopeKey(record.policy.scope);
    const previous = state.policies.get(key);
    assertStore((previous?.policy.digest ?? null) === expectedDigest, "CONFIGURATION_CONFLICT");
    insertImmutable(
      state.policyHistory,
      JSON.stringify([key, record.policy.policyId, record.policy.version]),
      record,
    );
    state.policies.set(key, record);
  }
  for (const { record, expectedRevision } of changes.delegations) {
    assertInteger(record.revision, true);
    assertStore(isDeepStrictEqual(validateDelegation(record.wire), record.delegation));
    requireWallet(state, record.delegation.scope);
    const key = scopeKey(record.delegation.scope);
    const previous = state.delegations.get(key);
    assertStore((previous?.revision ?? null) === expectedRevision, "CONFIGURATION_CONFLICT");
    if (previous) assertStore(previous.revision < Number.MAX_SAFE_INTEGER, "COUNTER_EXHAUSTED");
    assertStore(
      record.revision === (previous ? previous.revision + 1 : 1),
      "CONFIGURATION_CONFLICT",
    );
    insertImmutable(state.delegationHistory, JSON.stringify([key, record.revision]), record);
    state.delegations.set(key, record);
  }
  for (const { account, expectedRevision } of changes.budgets) {
    const validated = validateBudgetAccount({
      ...account,
      ceilingAtomic: account.ceilingAtomic.toString(),
    });
    assertStore(isDeepStrictEqual(validated, account));
    requireWallet(state, account.scope, account);
    const key = recordKey(account.scope, account.accountId);
    const previous = state.budgets.get(key);
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
    state.budgets.set(key, account);
  }
  for (const intent of changes.intents) {
    requireWallet(state, intent.scope);
    scopeKey(intent.scope);
    assertInteger(intent.createdAtMs);
    const { expiresAtMs, amountAtomic, ...fields } = intent.intent;
    assertInteger(expiresAtMs);
    const validated = validatePaymentIntent({
      ...fields,
      amountAtomic: serializeAtomicAmount(amountAtomic),
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
    assertStore(isDeepStrictEqual(validated, intent.intent));
    if (intent.decision.kind !== "DENY") {
      requireWallet(state, intent.scope, intent.intent);
      assertStore(intent.intent.delegationId === intent.scope.delegationId);
    }
    assertStore(computeIntentDigest(intent.intent, intent.scope) === intent.intentDigest);
    assertStore(
      (intent.decision.kind === intent.decision.evaluation.kind ||
        (intent.decision.kind === "DENY" && intent.decision.ledgerReasons.length > 0)) &&
        intent.decision.evaluation.intentDigest === intent.intentDigest,
    );
    assertInteger(intent.decision.evaluatedAtMs);
    for (const previous of state.intents.values())
      assertStore(
        scopeKey(previous.scope) !== scopeKey(intent.scope) ||
          previous.intent.idempotencyKey !== intent.intent.idempotencyKey ||
          previous.intentId === intent.intentId,
        "CONFIGURATION_CONFLICT",
      );
    insertImmutable(state.intents, recordKey(intent.scope, intent.intentId), intent);
  }
  for (const { record, expectedState } of changes.reservations) {
    const key = recordKey(record.scope, record.reservationId);
    const previous = state.reservations.get(key);
    serializeAtomicAmount(record.amountAtomic);
    assertInteger(record.createdAtMs);
    assertInteger(record.updatedAtMs);
    assertInteger(record.expiresAtMs);
    assertInteger(record.delegationRevision, true);
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
    } else {
      assertStore(record.state === "RESERVED" && record.executionId === null);
      for (const other of state.reservations.values())
        assertStore(
          walletKey(other.scope) !== walletKey(record.scope) || other.intentId !== record.intentId,
          "CONFIGURATION_CONFLICT",
        );
    }
    state.reservations.set(key, record);
  }
  for (const mutation of changes.allocations) {
    const { wallet, allocation, expectedState } = mutation;
    const key = JSON.stringify([recordKey(wallet, allocation.accountId), allocation.reservationId]);
    assertIdentifier(allocation.reservationId);
    serializeAtomicAmount(allocation.amountAtomic);
    const previous = state.allocations.get(key)?.allocation;
    assertStore((previous?.state ?? null) === expectedState, "CONFIGURATION_CONFLICT");
    if (previous) {
      assertStore(allocation.amountAtomic === previous.amountAtomic, "CONFIGURATION_CONFLICT");
      assertStore(
        isDeepStrictEqual(previous, allocation) ||
          canTransitionReservation(previous.state, allocation.state),
        "CONFIGURATION_CONFLICT",
      );
    }
    assertStore(
      allocation.state === "COMMITTED"
        ? allocation.committedAtMs !== null
        : allocation.committedAtMs === null,
    );
    if (allocation.committedAtMs !== null) assertInteger(allocation.committedAtMs);
    state.allocations.set(key, mutation);
  }
  for (const execution of changes.executions) {
    const binding = validateExecutionBinding({
      ...execution.binding,
      amountAtomic: serializeAtomicAmount(execution.binding.amountAtomic),
    });
    assertStore(isDeepStrictEqual(binding, execution.binding));
    assertInteger(execution.claimedAtMs);
    assertStore(
      computeExecutionBindingDigest(binding) === execution.bindingDigest &&
        computePayloadDigest(binding) === execution.payloadDigest,
    );
    for (const other of state.executions.values()) {
      if (
        walletKey(other.binding.scope) !== walletKey(binding.scope) ||
        other.executionId === execution.executionId
      )
        continue;
      assertStore(other.binding.reservationId !== binding.reservationId, "CONFIGURATION_CONFLICT");
      assertStore(
        other.binding.network !== binding.network ||
          other.binding.asset !== binding.asset ||
          other.binding.nonce !== binding.nonce,
        "CONFIGURATION_CONFLICT",
      );
    }
    insertImmutable(state.executions, recordKey(binding.scope, execution.executionId), execution);
  }
  for (const record of changes.observations) {
    validateLedgerObservation(record.observation);
    insertImmutable(
      state.observations,
      recordKey(record.wallet, record.observation.evidenceId),
      record,
    );
  }
  for (const event of changes.events) {
    requireWallet(state, event.wallet);
    assertInteger(event.sequence, true);
    assertInteger(event.occurredAtMs);
    assertIdentifier(event.subjectId);
    for (const other of state.events.values())
      assertStore(
        walletKey(other.wallet) !== walletKey(event.wallet) ||
          other.sequence !== event.sequence ||
          other.eventId === event.eventId,
        "CONFIGURATION_CONFLICT",
      );
    insertImmutable(state.events, recordKey(event.wallet, event.eventId), event);
  }
  for (const { record, expectedState, expectedClaimToken } of changes.outbox) {
    const key = recordKey(record.wallet, record.eventId);
    const previous = state.outbox.get(key);
    assertStore(
      (previous?.state ?? null) === expectedState &&
        (previous?.claimToken ?? null) === expectedClaimToken,
      "CONFIGURATION_CONFLICT",
    );
    assertStore(
      previous
        ? previous.state !== "DELIVERED" || isDeepStrictEqual(previous, record)
        : record.state === "PENDING",
      "CONFIGURATION_CONFLICT",
    );
    assertStore(["PENDING", "CLAIMED", "DELIVERED"].includes(record.state));
    if (record.state === "PENDING") {
      assertStore(
        record.workerId === null && record.claimToken === null && record.leaseExpiresAtMs === null,
      );
      assertStore(previous === undefined || previous.state === "PENDING", "CONFIGURATION_CONFLICT");
    } else {
      assertStore(
        record.workerId !== null && record.claimToken !== null && record.leaseExpiresAtMs !== null,
      );
      assertIdentifier(record.workerId);
      assertIdentifier(record.claimToken);
      assertInteger(record.leaseExpiresAtMs);
      if (record.state === "DELIVERED")
        assertStore(
          previous?.state === "CLAIMED" || previous?.state === "DELIVERED",
          "CONFIGURATION_CONFLICT",
        );
    }
    state.outbox.set(key, record);
  }
  for (const { record, expectedHighWaterMs } of changes.clocks) {
    requireWallet(state, record.wallet);
    assertInteger(record.highWaterMs);
    const key = walletKey(record.wallet);
    const previous = state.clocks.get(key);
    assertStore((previous?.highWaterMs ?? null) === expectedHighWaterMs, "CONFIGURATION_CONFLICT");
    assertStore(
      previous === undefined || record.highWaterMs >= previous.highWaterMs,
      "CLOCK_REGRESSION",
    );
    state.clocks.set(key, record);
  }
  for (const fault of changes.faults) {
    requireWallet(state, fault.wallet);
    assertIdentifier(fault.faultId);
    assertInteger(fault.createdAtMs);
    insertImmutable(state.faults, walletKey(fault.wallet), fault);
  }
  assertReferences(state);
}

/** Check relationships after the complete batch, including mutually linked claim records.
 * @param state - Candidate tables after all writes.
 * @throws {LedgerError} If a financial or ownership link is broken.
 */
function assertReferences(state: MemoryState): void {
  for (const intent of state.intents.values()) {
    if (intent.reservationId === null) continue;
    const reservation = state.reservations.get(recordKey(intent.scope, intent.reservationId));
    assertStore(
      reservation !== undefined &&
        reservation.intentId === intent.intentId &&
        scopeKey(reservation.scope) === scopeKey(intent.scope),
    );
    assertStore(intent.decision.kind === "ALLOW");
  }
  for (const reservation of state.reservations.values()) {
    const intent = state.intents.get(recordKey(reservation.scope, reservation.intentId));
    assertStore(
      intent !== undefined &&
        scopeKey(intent.scope) === scopeKey(reservation.scope) &&
        intent.reservationId === reservation.reservationId,
    );
    assertStore(
      reservation.amountAtomic === intent.intent.amountAtomic &&
        reservation.policyDigest === intent.decision.evaluation.policyDigest,
    );
    assertStore(
      reservation.expiresAtMs > reservation.createdAtMs &&
        reservation.updatedAtMs >= reservation.createdAtMs,
    );
    if (reservation.executionId !== null) {
      const execution = state.executions.get(recordKey(reservation.scope, reservation.executionId));
      assertStore(
        execution !== undefined && execution.binding.reservationId === reservation.reservationId,
      );
      assertStore(reservation.state !== "RESERVED" && reservation.state !== "EXPIRED");
    } else assertStore(["RESERVED", "RELEASED", "EXPIRED"].includes(reservation.state));
  }
  for (const { wallet, allocation } of state.allocations.values()) {
    const budget = state.budgets.get(recordKey(wallet, allocation.accountId));
    const reservation = state.reservations.get(recordKey(wallet, allocation.reservationId));
    assertStore(budget !== undefined && reservation !== undefined);
    assertStore(
      budgetApplies(budget.scope, reservation.scope) &&
        allocation.amountAtomic === reservation.amountAtomic &&
        allocation.state === reservation.state,
    );
  }
  for (const execution of state.executions.values()) {
    const { binding } = execution;
    const reservation = state.reservations.get(recordKey(binding.scope, binding.reservationId));
    assertStore(
      reservation !== undefined &&
        reservation.executionId === execution.executionId &&
        scopeKey(reservation.scope) === scopeKey(binding.scope),
    );
    const intent = state.intents.get(recordKey(binding.scope, reservation.intentId));
    const wallet = state.wallets.get(walletKey(binding.scope));
    assertStore(intent !== undefined && wallet !== undefined);
    assertStore(
      binding.intentDigest === intent.intentDigest &&
        binding.amountAtomic === reservation.amountAtomic &&
        binding.recipient === intent.intent.recipient &&
        binding.network === wallet.network &&
        binding.asset === wallet.asset &&
        binding.signerId === wallet.signerId,
    );
  }
  for (const { wallet, observation } of state.observations.values()) {
    const execution = state.executions.get(recordKey(wallet, observation.executionId));
    assertStore(execution !== undefined && execution.bindingDigest === observation.bindingDigest);
  }
  for (const outbox of state.outbox.values())
    assertStore(state.events.has(recordKey(outbox.wallet, outbox.eventId)));
}
