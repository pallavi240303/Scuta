/** @file Complete deterministic records for transaction-adapter tests; no signing or provider access. */
import {
  computeExecutionBindingDigest,
  computePayloadDigest,
  evaluatePolicy,
  validateExecutionBinding,
  validatePaymentIntent,
  validatePolicy,
  validateDelegation,
  type LedgerChanges,
  type WalletConfiguration,
  type IntentRecord,
  type ReservationRecord,
  type ExecutionRecord,
  type BudgetAccount,
  type PolicySnapshot,
  type DelegationSnapshot,
  type TrustedScope,
} from "@scuta/core";
import {
  createIntent,
  createPolicy,
  createDelegation,
  createScope,
  NOW_MS,
} from "../../core/test/fixtures.js";
import { createExecutionBinding } from "../../core/test/ledger-fixtures.js";

/** Build a full batch with empty collections for untouched tables.
 * @param overrides - Collections participating in this batch.
 * @returns A complete typed write batch.
 */
export function createChanges(overrides: Partial<LedgerChanges> = {}): LedgerChanges {
  return {
    wallets: [],
    policies: [],
    delegations: [],
    budgets: [],
    intents: [],
    reservations: [],
    allocations: [],
    executions: [],
    observations: [],
    events: [],
    outbox: [],
    clocks: [],
    faults: [],
    ...overrides,
  };
}

/** Create settings for one mock wallet.
 * @returns Independent configuration without credentials.
 */
export function createStoreWallet(): WalletConfiguration {
  return {
    ownerId: "owner-1",
    walletId: "wallet-1",
    network: "mock:local",
    asset: "mock:usd",
    signerId: "mock-signer-1",
    reservationTtlMs: 60_000,
    executionTtlMs: 60_000,
    orphanAfterMs: 60_000,
  };
}

/** Create a complete purchase, hold and configuration fixture.
 * @param scope - Principal labels, allowing isolation tests to reuse local IDs.
 * @param identity - Local purchase suffix for distinct operations in one wallet.
 * @returns Independently owned, validated fixture records.
 */
export function createStoreRecords(scope: TrustedScope = createScope(), identity = "1") {
  const wallet = { ...createStoreWallet(), ownerId: scope.ownerId, walletId: scope.walletId };
  const policyWire = createPolicy({
    scope,
    hardTransactionLimitAtomic: "100",
    autonomousTransactionLimitAtomic: "100",
  });
  const policy: PolicySnapshot = { wire: policyWire, policy: validatePolicy(policyWire) };
  const delegationWire = createDelegation({ scope });
  const delegation: DelegationSnapshot = {
    wire: delegationWire,
    delegation: validateDelegation(delegationWire),
    revision: 1,
  };
  const wire = createIntent({
    amountAtomic: "70",
    delegationId: scope.delegationId,
    idempotencyKey: "request-" + identity,
  });
  const evaluation = evaluatePolicy({
    intent: wire,
    policy: policyWire,
    delegation: delegationWire,
    scope,
    nowMs: NOW_MS,
  });
  const intent: IntentRecord = {
    intentId: "intent-" + identity,
    scope,
    intent: validatePaymentIntent(wire),
    intentDigest: evaluation.intentDigest,
    decision: { kind: evaluation.kind, evaluation, ledgerReasons: [], evaluatedAtMs: NOW_MS },
    reservationId: "reservation-" + identity,
    createdAtMs: NOW_MS,
  };
  const reservation: ReservationRecord = {
    reservationId: "reservation-" + identity,
    intentId: intent.intentId,
    scope,
    amountAtomic: 70n,
    state: "RESERVED",
    expiresAtMs: NOW_MS + 60_000,
    policyDigest: policy.policy.digest,
    delegationRevision: 1,
    createdAtMs: NOW_MS,
    updatedAtMs: NOW_MS,
    executionId: null,
  };
  const binding = validateExecutionBinding(
    createExecutionBinding({
      scope,
      reservationId: reservation.reservationId,
      intentDigest: intent.intentDigest,
    }),
  );
  const execution: ExecutionRecord = {
    executionId: "execution-" + identity,
    binding,
    bindingDigest: computeExecutionBindingDigest(binding),
    payloadDigest: computePayloadDigest(binding),
    claimedAtMs: NOW_MS,
  };
  const budget: BudgetAccount = {
    accountId: "wallet-budget",
    scope: { kind: "WALLET", ownerId: scope.ownerId, walletId: scope.walletId },
    network: wallet.network,
    asset: wallet.asset,
    windowMs: 60_000,
    ceilingAtomic: 100n,
    revision: 1,
  };
  return { scope, wallet, policy, delegation, intent, reservation, execution, budget };
}

/** Build coherent initial configuration and an unclaimed hold.
 * @param records - Deterministic fixture records.
 * @returns One referentially complete financial batch.
 */
export function createInitialChanges(records = createStoreRecords()): LedgerChanges {
  const { wallet, policy, delegation, intent, reservation, budget } = records;
  return createChanges({
    wallets: [wallet],
    policies: [{ record: policy, expectedDigest: null }],
    delegations: [{ record: delegation, expectedRevision: null }],
    budgets: [{ account: budget, expectedRevision: null }],
    intents: [intent],
    reservations: [{ record: reservation, expectedState: null }],
    allocations: [
      {
        wallet,
        allocation: {
          reservationId: reservation.reservationId,
          accountId: budget.accountId,
          amountAtomic: 70n,
          state: "RESERVED",
          committedAtMs: null,
        },
        expectedState: null,
      },
    ],
  });
}

/** Create a matching claim and its allocation update.
 * @param records - Previously inserted fixture records.
 * @returns A typed RESERVED-to-EXECUTING batch.
 */
export function createClaimChanges(records = createStoreRecords()): LedgerChanges {
  return createChanges({
    reservations: [
      {
        record: {
          ...records.reservation,
          state: "EXECUTING",
          executionId: records.execution.executionId,
        },
        expectedState: "RESERVED",
      },
    ],
    executions: [records.execution],
    allocations: [
      {
        wallet: records.wallet,
        allocation: {
          reservationId: records.reservation.reservationId,
          accountId: records.budget.accountId,
          amountAtomic: 70n,
          state: "EXECUTING",
          committedAtMs: null,
        },
        expectedState: "RESERVED",
      },
    ],
  });
}
