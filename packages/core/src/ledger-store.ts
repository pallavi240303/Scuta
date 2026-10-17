/** @file Trusted synchronous storage ports; these interfaces do not authorize agents or verify providers. */
import type { Policy, PolicyWire } from "./policy.js";
import type { Delegation, DelegationWire } from "./delegation.js";
import type { TrustedScope } from "./validation.js";
import type {
  WalletScope,
  WalletConfiguration,
  BudgetAccount,
  BudgetAllocation,
  IntentRecord,
  ReservationRecord,
  ReservationState,
  ExecutionRecord,
  LedgerObservation,
  LedgerEvent,
  OutboxRecord,
  WalletClockRecord,
  WalletFaultRecord,
} from "./ledger-contracts.js";

/** Redacted storage and coordinator failures, distinct from ordinary financial denials. */
export type LedgerErrorCode =
  | "STORE_BUSY"
  | "STORE_CORRUPT"
  | "CONFIGURATION_MISSING"
  | "CONFIGURATION_CONFLICT"
  | "CLOCK_REGRESSION"
  | "TRANSACTION_CLOSED"
  | "ASYNC_TRANSACTION"
  | "NESTED_TRANSACTION"
  | "COUNTER_EXHAUSTED";

/** Storage failure containing a stable code only, never caller data or credentials. */
export class LedgerError extends Error {
  /** Create a safe machine-readable failure.
   * @param code - Fixed failure category, not a caller-supplied message.
   */
  constructor(readonly code: LedgerErrorCode) {
    super(code);
    this.name = "LedgerError";
  }
}

/** Immutable wire and parsed policy snapshots with a validated computed digest. */
export interface PolicySnapshot {
  readonly wire: PolicyWire;
  readonly policy: Policy;
}
/** Immutable wire and parsed delegation snapshots with a monotonic activation revision. */
export interface DelegationSnapshot {
  readonly wire: DelegationWire;
  readonly delegation: Delegation;
  readonly revision: number;
}
/** Activate a policy only if the current digest matches the expectation, or null for creation. */
export interface PolicyActivation {
  readonly record: PolicySnapshot;
  readonly expectedDigest: string | null;
}
/** Activate a delegation at the expected current revision, or null for creation. */
export interface DelegationActivation {
  readonly record: DelegationSnapshot;
  readonly expectedRevision: number | null;
}
/** Create a budget or replace its ceiling at the expected revision without changing identity. */
export interface BudgetMutation {
  readonly account: BudgetAccount;
  readonly expectedRevision: number | null;
}
/** Insert or advance a reservation at the expected current lifecycle state. */
export interface ReservationMutation {
  readonly record: ReservationRecord;
  readonly expectedState: ReservationState | null;
}
/** Wallet-scoped allocation update whose amount and budget membership never change. */
export interface AllocationMutation {
  readonly wallet: WalletScope;
  readonly allocation: BudgetAllocation;
  readonly expectedState: ReservationState | null;
}
/** Immutable evidence content in its execution's wallet namespace; not an authenticity proof. */
export interface ObservationRecord {
  readonly wallet: WalletScope;
  readonly observation: LedgerObservation;
}
/** Delivery update fenced by current state and token; null state means first insertion. */
export interface OutboxMutation {
  readonly record: OutboxRecord;
  readonly expectedState: OutboxRecord["state"] | null;
  readonly expectedClaimToken: string | null;
}
/** Compare-and-set wallet time high-water mark; null means first insertion. */
export interface ClockMutation {
  readonly record: WalletClockRecord;
  readonly expectedHighWaterMs: number | null;
}
/** One complete typed batch; empty arrays leave tables unchanged, and any failure aborts the transaction. */
export interface LedgerChanges {
  readonly wallets: readonly WalletConfiguration[];
  readonly policies: readonly PolicyActivation[];
  readonly delegations: readonly DelegationActivation[];
  readonly budgets: readonly BudgetMutation[];
  readonly intents: readonly IntentRecord[];
  readonly reservations: readonly ReservationMutation[];
  readonly allocations: readonly AllocationMutation[];
  readonly executions: readonly ExecutionRecord[];
  readonly observations: readonly ObservationRecord[];
  readonly events: readonly LedgerEvent[];
  readonly outbox: readonly OutboxMutation[];
  readonly clocks: readonly ClockMutation[];
  readonly faults: readonly WalletFaultRecord[];
}
/** Lifetime-checked read snapshot; lookups return immutable copies, null, or immutable collections. */
export interface LedgerReadView {
  getWallet(wallet: WalletScope): WalletConfiguration | null;
  getPolicy(scope: TrustedScope): PolicySnapshot | null;
  getDelegation(scope: TrustedScope): DelegationSnapshot | null;
  getBudgets(scope: TrustedScope): readonly BudgetAccount[];
  getBudget(wallet: WalletScope, accountId: string): BudgetAccount | null;
  findIntent(scope: TrustedScope, idempotencyKey: string): IntentRecord | null;
  getIntent(scope: TrustedScope, intentId: string): IntentRecord | null;
  getReservation(scope: TrustedScope, reservationId: string): ReservationRecord | null;
  getExecution(scope: TrustedScope, executionId: string): ExecutionRecord | null;
  getAllocations(
    wallet: WalletScope,
    accountIds: readonly string[],
    earliestCommittedAtMs: number,
  ): readonly BudgetAllocation[];
  getObservation(wallet: WalletScope, evidenceId: string): LedgerObservation | null;
  getClock(wallet: WalletScope): WalletClockRecord | null;
  getFault(wallet: WalletScope): WalletFaultRecord | null;
  getOutbox(wallet: WalletScope, eventId: string): OutboxRecord | null;
  listExpirable(wallet: WalletScope, nowMs: number, limit: number): readonly ReservationRecord[];
  listOrphans(wallet: WalletScope, beforeMs: number, limit: number): readonly ReservationRecord[];
  listDeliverable(wallet: WalletScope, nowMs: number, limit: number): readonly OutboxRecord[];
}
/** Read/write handle usable only inside its owning synchronous transaction callback. */
export interface LedgerTransaction extends LedgerReadView {
  apply(changes: LedgerChanges): void;
}
/** Internal transaction runner; callbacks cannot nest, return thenables, or reuse escaped handles. */
export interface LedgerStore {
  transaction<T>(operation: (tx: LedgerTransaction) => T): T;
  read<T>(operation: (tx: LedgerReadView) => T): T;
  close(): void;
}
