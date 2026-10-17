/** @file Typed reconstruction of every persisted ledger record from untrusted canonical JSON data. */
import {
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
  type PolicySnapshot,
  type PolicyWire,
  type DelegationSnapshot,
  type DelegationWire,
  type LedgerDecision,
  type PolicyEvaluation,
  type IntentRecord,
  type ReservationRecord,
  type ExecutionRecord,
  type ObservationRecord,
  type LedgerEvent,
  type OutboxRecord,
  type WalletClockRecord,
  type WalletFaultRecord,
  type ReservationState,
} from "@scuta/core";
import {
  canonicalJson,
  readObject,
  readScope,
  readWallet,
  readIdentifier,
  readInteger,
  readString,
  readDigest,
  readNullableId,
  readNullableTime,
  readAmount,
  readEnum,
  readArray,
  requireRow,
} from "./row-validation.js";
import type {
  ActivePolicyRecord,
  ActiveDelegationRecord,
  AllocationRecord,
  LedgerRecordKind,
  LedgerRecords,
} from "./row-types.js";

const states: readonly ReservationState[] = [
  "RESERVED",
  "EXECUTING",
  "PENDING_RECONCILIATION",
  "COMMITTED",
  "RELEASED",
  "EXPIRED",
];
const decisions = ["ALLOW", "DENY", "REQUIRE_APPROVAL"] as const;
const policyReasons = [
  "SCOPE_MISMATCH",
  "DELEGATION_REVOKED",
  "DELEGATION_EXPIRED",
  "CAPABILITY_NOT_DELEGATED",
  "INTENT_EXPIRED",
  "UNSUPPORTED_CAPABILITY",
  "UNSUPPORTED_NETWORK",
  "UNSUPPORTED_ASSET",
  "RECIPIENT_FORBIDDEN",
  "HARD_TRANSACTION_LIMIT_EXCEEDED",
  "APPROVAL_UNAVAILABLE",
  "RECIPIENT_REQUIRES_APPROVAL",
  "AUTONOMOUS_LIMIT_EXCEEDED",
  "WITHIN_STATIC_POLICY",
] as const;
const ledgerReasons = [
  "NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "BUDGET_EXCEEDED",
  "STALE_PERMISSION",
  "INVALID_TRANSITION",
  "PAYLOAD_MISMATCH",
  "EVIDENCE_CONFLICT",
  "WALLET_CONTAINED",
] as const;

/** Rebuild a policy from wire fields and verify its separately stored parsed snapshot.
 * @param value - Persisted wire/parsed snapshot pair.
 * @returns Computed immutable policy and canonical wire fields.
 * @throws {LedgerError} If parsed content disagrees with the validated wire snapshot.
 * @throws {ValidationError} If wire policy is invalid.
 */
function policySnapshot(value: unknown): PolicySnapshot {
  const raw = readObject(value, ["wire", "policy"]);
  const policy = validatePolicy(raw.wire);
  requireRow(canonicalJson(raw.policy) === canonicalJson(policy));
  const wire: PolicyWire = {
    schemaVersion: policy.schemaVersion,
    policyId: policy.policyId,
    version: policy.version,
    scope: policy.scope,
    network: policy.network,
    asset: policy.asset,
    hardTransactionLimitAtomic: serializeAtomicAmount(policy.hardTransactionLimitAtomic),
    autonomousTransactionLimitAtomic: policy.autonomousTransactionLimitAtomic.toString(),
    recipientRules: policy.recipientRules,
    defaultRecipientAction: policy.defaultRecipientAction,
    approvalEnabled: policy.approvalEnabled,
  };
  return { wire, policy };
}

/** Validate both delegation representations and its persisted revision.
 * @param value - Stored delegation pair.
 * @returns Independently owned validated snapshot and revision.
 * @throws {LedgerError} If representation or revision is inconsistent.
 * @throws {ValidationError} If the wire grant is invalid.
 */
function delegationSnapshot(value: unknown): DelegationSnapshot {
  const raw = readObject(value, ["wire", "delegation", "revision"]);
  const delegation = validateDelegation(raw.wire);
  readInteger(delegation.expiresAtMs);
  requireRow(canonicalJson(raw.delegation) === canonicalJson(delegation));
  const wire: DelegationWire = {
    schemaVersion: delegation.schemaVersion,
    scope: delegation.scope,
    capabilities: delegation.capabilities,
    revoked: delegation.revoked,
    expiresAt: new Date(delegation.expiresAtMs).toISOString(),
  };
  return { wire, delegation, revision: readInteger(raw.revision, true) };
}

/** Decode an active policy pointer without inventing a policy when missing.
 * @param value - Stored pointer.
 * @returns Exact version and digest in its principal scope.
 * @throws {LedgerError} If labels or fields are invalid.
 */
function activePolicy(value: unknown): ActivePolicyRecord {
  const raw = readObject(value, ["scope", "policyId", "version", "digest"]);
  return {
    scope: readScope(raw.scope),
    policyId: readIdentifier(raw.policyId),
    version: readIdentifier(raw.version),
    digest: readDigest(raw.digest),
  };
}

/** Decode an active delegation pointer.
 * @param value - Stored pointer.
 * @returns Exact principal and positive revision.
 * @throws {LedgerError} If pointer data is invalid.
 */
function activeDelegation(value: unknown): ActiveDelegationRecord {
  const raw = readObject(value, ["scope", "revision"]);
  return { scope: readScope(raw.scope), revision: readInteger(raw.revision, true) };
}

/** Decode preserved static evaluation and final ledger denial/allow provenance.
 * @param value - Stored final decision.
 * @returns Checked decision retaining the original static result.
 * @throws {LedgerError} If explanation, identity or decision combination is invalid.
 */
function decision(value: unknown): LedgerDecision {
  const raw = readObject(value, ["kind", "evaluation", "ledgerReasons", "evaluatedAtMs"]);
  const source = readObject(raw.evaluation, [
    "kind",
    "reasonCodes",
    "policyVersion",
    "policyDigest",
    "intentDigest",
    "evaluatedAtMs",
  ]);
  const evaluation: PolicyEvaluation = {
    kind: readEnum(source.kind, decisions),
    reasonCodes: readArray(source.reasonCodes, (reason) => readEnum(reason, policyReasons)),
    policyVersion: readIdentifier(source.policyVersion),
    policyDigest: readDigest(source.policyDigest),
    intentDigest: readDigest(source.intentDigest),
    evaluatedAtMs: readInteger(source.evaluatedAtMs),
  };
  requireRow(
    evaluation.reasonCodes.length > 0 &&
      new Set(evaluation.reasonCodes).size === evaluation.reasonCodes.length,
  );
  const result: LedgerDecision = {
    kind: readEnum(raw.kind, decisions),
    evaluation,
    ledgerReasons: readArray(raw.ledgerReasons, (reason) => readEnum(reason, ledgerReasons)),
    evaluatedAtMs: readInteger(raw.evaluatedAtMs),
  };
  requireRow(new Set(result.ledgerReasons).size === result.ledgerReasons.length);
  requireRow(
    result.kind === evaluation.kind || (result.kind === "DENY" && result.ledgerReasons.length > 0),
  );
  requireRow(result.evaluatedAtMs === evaluation.evaluatedAtMs);
  return result;
}

/** Reconstruct a parsed purchase and verify its canonical identity and non-executable denials.
 * @param value - Stored intent record.
 * @returns Exact immutable purchase provenance after facade freezing.
 * @throws {LedgerError} If identity or decision fields are corrupt.
 * @throws {ValidationError} If purchase fields are malformed.
 */
function intent(value: unknown): IntentRecord {
  const raw = readObject(value, [
    "intentId",
    "scope",
    "intent",
    "intentDigest",
    "decision",
    "reservationId",
    "createdAtMs",
  ]);
  const fields = readObject(raw.intent, [
    "schemaVersion",
    "idempotencyKey",
    "delegationId",
    "network",
    "asset",
    "amountAtomic",
    "recipient",
    "capability",
    "resourceUrl",
    "method",
    "bodyDigest",
    "expiresAtMs",
    "traceId",
  ]);
  const { expiresAtMs, ...wire } = fields;
  const purchase = validatePaymentIntent({
    ...wire,
    expiresAt: new Date(readInteger(expiresAtMs)).toISOString(),
  });
  const scope = readScope(raw.scope);
  const result: IntentRecord = {
    intentId: readIdentifier(raw.intentId),
    scope,
    intent: purchase,
    intentDigest: readDigest(raw.intentDigest),
    decision: decision(raw.decision),
    reservationId: readNullableId(raw.reservationId),
    createdAtMs: readInteger(raw.createdAtMs),
  };
  requireRow(
    computeIntentDigest(purchase, scope) === result.intentDigest &&
      result.decision.evaluation.intentDigest === result.intentDigest,
  );
  requireRow(result.decision.kind === "ALLOW" || result.reservationId === null);
  if (result.decision.kind !== "DENY") requireRow(purchase.delegationId === scope.delegationId);
  return result;
}

/** Decode reservation identity and its internally consistent lifecycle shape.
 * @param value - Persisted reservation.
 * @returns Checked hold metadata, not execution authority.
 * @throws {LedgerError} If lifecycle, timestamps or labels are invalid.
 * @throws {ValidationError} If amount text is invalid.
 */
function reservation(value: unknown): ReservationRecord {
  const raw = readObject(value, [
    "reservationId",
    "intentId",
    "scope",
    "amountAtomic",
    "state",
    "expiresAtMs",
    "policyDigest",
    "delegationRevision",
    "createdAtMs",
    "updatedAtMs",
    "executionId",
  ]);
  const result: ReservationRecord = {
    reservationId: readIdentifier(raw.reservationId),
    intentId: readIdentifier(raw.intentId),
    scope: readScope(raw.scope),
    amountAtomic: readAmount(raw.amountAtomic),
    state: readEnum(raw.state, states),
    expiresAtMs: readInteger(raw.expiresAtMs),
    policyDigest: readDigest(raw.policyDigest),
    delegationRevision: readInteger(raw.delegationRevision, true),
    createdAtMs: readInteger(raw.createdAtMs),
    updatedAtMs: readInteger(raw.updatedAtMs),
    executionId: readNullableId(raw.executionId),
  };
  requireRow(result.expiresAtMs > result.createdAtMs && result.updatedAtMs >= result.createdAtMs);
  if (result.state === "RESERVED" || result.state === "EXPIRED")
    requireRow(result.executionId === null);
  if (
    result.state === "EXECUTING" ||
    result.state === "PENDING_RECONCILIATION" ||
    result.state === "COMMITTED"
  )
    requireRow(result.executionId !== null);
  return result;
}

/** Decode a wallet-local allocation without transient write expectations.
 * @param value - Persisted allocation pair.
 * @returns Checked exact financial membership.
 * @throws {LedgerError} If lifecycle or booking shape is inconsistent.
 * @throws {ValidationError} If amount text is invalid.
 */
function allocation(value: unknown): AllocationRecord {
  const raw = readObject(value, ["wallet", "allocation"]);
  const item = readObject(raw.allocation, [
    "reservationId",
    "accountId",
    "amountAtomic",
    "state",
    "committedAtMs",
  ]);
  const result: AllocationRecord = {
    wallet: readWallet(raw.wallet),
    allocation: {
      reservationId: readIdentifier(item.reservationId),
      accountId: readIdentifier(item.accountId),
      amountAtomic: readAmount(item.amountAtomic),
      state: readEnum(item.state, states),
      committedAtMs: readNullableTime(item.committedAtMs),
    },
  };
  requireRow(
    result.allocation.state === "COMMITTED"
      ? result.allocation.committedAtMs !== null
      : result.allocation.committedAtMs === null,
  );
  return result;
}

/** Decode an execution and recompute both semantic and unsigned-payload identities.
 * @param value - Persisted execution.
 * @returns Checked fixed execution record, not a signature.
 * @throws {LedgerError} If stored digests disagree with the validated binding.
 * @throws {ValidationError} If the binding is malformed.
 */
function execution(value: unknown): ExecutionRecord {
  const raw = readObject(value, [
    "executionId",
    "binding",
    "bindingDigest",
    "payloadDigest",
    "claimedAtMs",
  ]);
  const binding = validateExecutionBinding(raw.binding);
  const result: ExecutionRecord = {
    executionId: readIdentifier(raw.executionId),
    binding,
    bindingDigest: readDigest(raw.bindingDigest),
    payloadDigest: readDigest(raw.payloadDigest),
    claimedAtMs: readInteger(raw.claimedAtMs),
  };
  requireRow(
    computeExecutionBindingDigest(binding) === result.bindingDigest &&
      computePayloadDigest(binding) === result.payloadDigest,
  );
  return result;
}

/** Decode scoped normalized evidence labels without claiming provider authenticity.
 * @param value - Persisted observation pair.
 * @returns Checked evidence record.
 * @throws {LedgerError} If ownership shape is invalid.
 * @throws {ValidationError} If observation labels are invalid.
 */
function observation(value: unknown): ObservationRecord {
  const raw = readObject(value, ["wallet", "observation"]);
  return {
    wallet: readWallet(raw.wallet),
    observation: validateLedgerObservation(raw.observation),
  };
}

/** Decode bounded nullable event explanation text.
 * @param value - Exact null or bounded printable ASCII explanation.
 * @returns Checked explanation.
 * @throws {LedgerError} If text is malformed.
 */
function explanation(value: unknown): string | null {
  if (value === null) return null;
  const text = readString(value);
  requireRow(/^[\x20-\x7e]*/u.exec(text)?.[0] === text);
  return text;
}

/** Decode an ordered durable event.
 * @param value - Persisted event.
 * @returns Checked event identity and explanation.
 * @throws {LedgerError} If event data is invalid.
 */
function event(value: unknown): LedgerEvent {
  const raw = readObject(value, [
    "eventId",
    "wallet",
    "sequence",
    "kind",
    "subjectId",
    "occurredAtMs",
    "reason",
  ]);
  return {
    eventId: readIdentifier(raw.eventId),
    wallet: readWallet(raw.wallet),
    sequence: readInteger(raw.sequence, true),
    kind: readEnum(raw.kind, [
      "CONFIGURATION",
      "DECISION",
      "IDEMPOTENCY_CONFLICT",
      "RESERVATION_TRANSITION",
      "RECONCILIATION",
      "LEDGER_FAULT",
    ]),
    subjectId: readIdentifier(raw.subjectId),
    occurredAtMs: readInteger(raw.occurredAtMs),
    reason: explanation(raw.reason),
  };
}

/** Decode delivery data with explicit pending/leased metadata, not a worker action.
 * @param value - Persisted outbox record.
 * @returns Consistent delivery state and lease identity.
 * @throws {LedgerError} If lifecycle shape is invalid.
 */
function outbox(value: unknown): OutboxRecord {
  const raw = readObject(value, [
    "eventId",
    "wallet",
    "state",
    "workerId",
    "claimToken",
    "leaseExpiresAtMs",
  ]);
  const result: OutboxRecord = {
    eventId: readIdentifier(raw.eventId),
    wallet: readWallet(raw.wallet),
    state: readEnum(raw.state, ["PENDING", "CLAIMED", "DELIVERED"]),
    workerId: readNullableId(raw.workerId),
    claimToken: readNullableId(raw.claimToken),
    leaseExpiresAtMs: readNullableTime(raw.leaseExpiresAtMs),
  };
  requireRow(
    result.state === "PENDING"
      ? result.workerId === null && result.claimToken === null && result.leaseExpiresAtMs === null
      : result.workerId !== null && result.claimToken !== null && result.leaseExpiresAtMs !== null,
  );
  return result;
}

/** Decode the wallet's trusted-time high-water value.
 * @param value - Persisted clock record.
 * @returns Exact safe integer state.
 * @throws {LedgerError} If clock data is malformed.
 */
function clock(value: unknown): WalletClockRecord {
  const raw = readObject(value, ["wallet", "highWaterMs"]);
  return { wallet: readWallet(raw.wallet), highWaterMs: readInteger(raw.highWaterMs) };
}

/** Decode a wallet-local latched fault record.
 * @param value - Persisted containment record.
 * @returns Exact fault identity and bounded explanation.
 * @throws {LedgerError} If fault data is malformed.
 */
function fault(value: unknown): WalletFaultRecord {
  const raw = readObject(value, ["wallet", "faultId", "reason", "createdAtMs"]);
  const reason = explanation(raw.reason);
  requireRow(reason !== null);
  return {
    wallet: readWallet(raw.wallet),
    faultId: readIdentifier(raw.faultId),
    reason,
    createdAtMs: readInteger(raw.createdAtMs),
  };
}

/** Record-specific runtime parsers; no database record is accepted only because TypeScript says it is typed. */
export const RECORD_PARSERS: {
  readonly [K in LedgerRecordKind]: (value: unknown) => LedgerRecords[K];
} = {
  wallet: validateWalletConfiguration,
  policySnapshot,
  activePolicy,
  delegationSnapshot,
  activeDelegation,
  budget: validateBudgetAccount,
  intent,
  reservation,
  allocation,
  execution,
  observation,
  event,
  outbox,
  clock,
  fault,
};
