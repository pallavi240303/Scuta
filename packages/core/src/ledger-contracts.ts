/** @file Immutable financial-ledger records; labels and typed evidence do not authenticate callers. */
import type { PaymentIntent } from "./payment-intent.js";
import type { PolicyEvaluation } from "./evaluate-policy.js";
import type { TrustedScope } from "./validation.js";

/** Trusted owner and wallet labels for one authoritative ledger namespace. */
export interface WalletScope {
  readonly ownerId: string;
  readonly walletId: string;
}
/** The supported hierarchy of owner-configured spending accounts. */
export type BudgetScope = Readonly<
  WalletScope &
    (
      | { kind: "WALLET" }
      | { kind: "AGENT"; agentId: string }
      | { kind: "DELEGATION"; agentId: string; delegationId: string }
    )
>;
/** Single-profile wallet settings; durations are positive safe-integer milliseconds. */
export interface WalletConfigurationWire extends WalletScope {
  readonly network: string;
  readonly asset: string;
  readonly signerId: string;
  readonly reservationTtlMs: number;
  readonly executionTtlMs: number;
  readonly orphanAfterMs: number;
}
/** Validated immutable wallet configuration, not signer credentials. */
export type WalletConfiguration = Readonly<WalletConfigurationWire>;
/** Wire account with canonical decimal ceiling, including zero to close admission. */
export interface BudgetAccountWire {
  readonly accountId: string;
  readonly scope: BudgetScope;
  readonly network: string;
  readonly asset: string;
  readonly windowMs: number;
  readonly ceilingAtomic: string;
  readonly revision: number;
}
/** Validated account preserving exact money and immutable account identity. */
export type BudgetAccount = Readonly<
  Omit<BudgetAccountWire, "ceilingAtomic"> & { ceilingAtomic: bigint }
>;
/** Reservation states whose live obligations are accounted independently of age. */
export const RESERVATION_STATES = Object.freeze([
  "RESERVED",
  "EXECUTING",
  "PENDING_RECONCILIATION",
  "COMMITTED",
  "RELEASED",
  "EXPIRED",
] as const);
/** Durable reservation lifecycle; approval-pending holds enter in Phase 3. */
export type ReservationState = (typeof RESERVATION_STATES)[number];
/** One reservation's debit membership in an authoritative budget account. */
export interface BudgetAllocation {
  readonly reservationId: string;
  readonly accountId: string;
  readonly amountAtomic: bigint;
  readonly state: ReservationState;
  readonly committedAtMs: number | null;
}
/** Exact rolling spend, unresolved exposure and nonnegative admission headroom. */
export interface BudgetExposure {
  readonly spentAtomic: bigint;
  readonly heldAtomic: bigint;
  readonly headroomAtomic: bigint;
}
/** Ordinary nonthrowing ledger conflicts, separate from static policy explanations. */
export type LedgerReason =
  | "NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "BUDGET_EXCEEDED"
  | "STALE_PERMISSION"
  | "INVALID_TRANSITION"
  | "PAYLOAD_MISMATCH"
  | "EVIDENCE_CONFLICT"
  | "WALLET_CONTAINED";
/** An operation's successful value or an explicit ordinary conflict. */
export type LedgerResult<T> = Readonly<
  { ok: true; value: T } | { ok: false; reason: LedgerReason }
>;
/** Final admission outcome retaining the original static evaluation as provenance. */
export interface LedgerDecision {
  readonly kind: PolicyEvaluation["kind"];
  readonly evaluation: PolicyEvaluation;
  readonly ledgerReasons: readonly LedgerReason[];
  readonly evaluatedAtMs: number;
}
/** A scoped logical purchase retained even after denial or terminal resolution. */
export interface IntentRecord {
  readonly intentId: string;
  readonly scope: TrustedScope;
  readonly intent: PaymentIntent;
  readonly intentDigest: string;
  readonly decision: LedgerDecision;
  readonly reservationId: string | null;
  readonly createdAtMs: number;
}
/** One immutable purchase hold with a durable, ordered mutable lifecycle. */
export interface ReservationRecord {
  readonly reservationId: string;
  readonly intentId: string;
  readonly scope: TrustedScope;
  readonly amountAtomic: bigint;
  readonly state: ReservationState;
  readonly expiresAtMs: number;
  readonly policyDigest: string;
  readonly delegationRevision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly executionId: string | null;
}
/** Internal unsigned payment metadata whose protocol semantics require a later adapter. */
export interface ExecutionBindingWire {
  readonly scope: TrustedScope;
  readonly reservationId: string;
  readonly intentDigest: string;
  readonly signerId: string;
  readonly network: string;
  readonly asset: string;
  readonly recipient: string;
  readonly amountAtomic: string;
  readonly nonce: string;
  readonly validAfterMs: number;
  readonly validBeforeMs: number;
  readonly payloadBase64: string;
}
/** Validated binding with exact debit; this is neither a signature nor provider verification. */
export type ExecutionBinding = Readonly<
  Omit<ExecutionBindingWire, "amountAtomic"> & { amountAtomic: bigint }
>;
/** Persisted execution identity and fixed unsigned payload before any future signing. */
export interface ExecutionRecord {
  readonly executionId: string;
  readonly binding: ExecutionBinding;
  readonly bindingDigest: string;
  readonly payloadDigest: string;
  readonly claimedAtMs: number;
}
/** Normalized trusted-worker evidence reference; authenticity is outside the ledger. */
export interface LedgerObservationWire {
  readonly evidenceId: string;
  readonly executionId: string;
  readonly bindingDigest: string;
  readonly kind: "SETTLED" | "FINAL_NON_EXECUTION";
  readonly evidenceRef: string;
}
/** Validated immutable evidence labels, not proof supplied by an agent. */
export type LedgerObservation = Readonly<LedgerObservationWire>;
/** Durable event categories whose subject records retain financial provenance. */
export type LedgerEventKind =
  | "CONFIGURATION"
  | "DECISION"
  | "IDEMPOTENCY_CONFLICT"
  | "RESERVATION_TRANSITION"
  | "RECONCILIATION"
  | "LEDGER_FAULT";
/** Ordered event committed with the financial mutation it describes. */
export interface LedgerEvent {
  readonly eventId: string;
  readonly wallet: WalletScope;
  readonly sequence: number;
  readonly kind: LedgerEventKind;
  readonly subjectId: string;
  readonly occurredAtMs: number;
  readonly reason: string | null;
}
/** Durable delivery status whose lease cannot release financial exposure. */
export interface OutboxRecord {
  readonly eventId: string;
  readonly wallet: WalletScope;
  readonly state: "PENDING" | "CLAIMED" | "DELIVERED";
  readonly workerId: string | null;
  readonly claimToken: string | null;
  readonly leaseExpiresAtMs: number | null;
}
/** One fenced delivery lease; a stale token cannot acknowledge a replacement claim. */
export type OutboxClaim = Readonly<
  Omit<OutboxRecord, "state" | "workerId" | "claimToken" | "leaseExpiresAtMs"> & {
    state: "CLAIMED";
    workerId: string;
    claimToken: string;
    leaseExpiresAtMs: number;
  }
>;
/** Highest trusted mutation time recorded for a wallet. */
export interface WalletClockRecord {
  readonly wallet: WalletScope;
  readonly highWaterMs: number;
}
/** Latched accounting fault that blocks new reservations and execution claims. */
export interface WalletFaultRecord {
  readonly wallet: WalletScope;
  readonly faultId: string;
  readonly reason: string;
  readonly createdAtMs: number;
}
/** Original admission provenance together with current financial lifecycle records. */
export type LedgerStatus = Readonly<
  IntentRecord & { reservation: ReservationRecord | null; execution: ExecutionRecord | null }
>;
