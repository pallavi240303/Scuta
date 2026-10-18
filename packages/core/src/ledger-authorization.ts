/** @file Atomic all-budget admission, durable scoped retry identity and read-only exposure inspection. */
import { createHash } from "node:crypto";
import type { Ledger, LedgerDependencies, LedgerAuthorizationInput } from "./ledger.js";
import { LedgerError, type LedgerTransaction } from "./ledger-store.js";
import type {
  IntentRecord,
  LedgerDecision,
  LedgerReason,
  ReservationRecord,
} from "./ledger-contracts.js";
import { validatePaymentIntent, type PaymentIntent } from "./payment-intent.js";
import {
  validateScope,
  validateObject,
  validateIdentifier,
  type TrustedScope,
} from "./validation.js";
import { computeIntentDigest } from "./canonicalization.js";
import { computeBudgetExposure } from "./budget.js";
import { computeReservationExpiry } from "./reservation.js";
import { evaluatePolicy } from "./evaluate-policy.js";
import { applyLedgerEvent } from "./ledger-events.js";
import {
  readWalletScope,
  requireLedgerWallet,
  readLedgerTime,
  ledgerSuccess,
  readLedgerStatus,
} from "./ledger-context.js";

/** Admission and inspection methods, independent of the configured store implementation. */
export type LedgerAuthorization = Pick<Ledger, "authorize" | "getStatus" | "getBudgetExposure">;

/** Admit one new purchase using only persisted trusted configuration.
 * @param dependencies - Store, trusted time and opaque IDs.
 * @param tx - Existing serialized write transaction.
 * @param scope - Validated host identity.
 * @param intent - Independent validated purchase.
 * @param wire - Inert wire purchase for static re-evaluation.
 * @returns Persisted original decision and current lifecycle.
 */
function admitPurchase(
  dependencies: LedgerDependencies,
  tx: LedgerTransaction,
  scope: TrustedScope,
  intent: PaymentIntent,
  wire: LedgerAuthorizationInput["intent"],
) {
  const wallet = readWalletScope(scope);
  const configuration = requireLedgerWallet(tx, wallet);
  const policy = tx.getPolicy(scope);
  const delegation = tx.getDelegation(scope);
  const budgets = tx.getBudgets(scope);
  if (
    !policy ||
    !delegation ||
    budgets.filter((account) => account.scope.kind === "WALLET").length !== 1
  )
    throw new LedgerError("CONFIGURATION_MISSING");
  const nowMs = readLedgerTime(dependencies, tx, wallet);
  const evaluation = evaluatePolicy({
    intent: wire,
    policy: policy.wire,
    delegation: delegation.wire,
    scope,
    nowMs,
  });
  const reasons: LedgerReason[] = [];
  if (tx.getFault(wallet)) reasons.push("WALLET_CONTAINED");
  if (
    evaluation.kind !== "DENY" &&
    budgets.some(
      (account) =>
        computeBudgetExposure(
          account,
          tx.getAllocations(wallet, [account.accountId], nowMs - account.windowMs),
          nowMs,
        ).headroomAtomic < intent.amountAtomic,
    )
  )
    reasons.push("BUDGET_EXCEEDED");
  const decision: LedgerDecision = Object.freeze({
    kind: reasons.length > 0 ? "DENY" : evaluation.kind,
    evaluation,
    ledgerReasons: Object.freeze(reasons),
    evaluatedAtMs: nowMs,
  });
  const intentId = validateIdentifier(dependencies.createId(), "intentId");
  const reservation: ReservationRecord | null =
    decision.kind === "ALLOW"
      ? Object.freeze({
          reservationId: validateIdentifier(dependencies.createId(), "reservationId"),
          intentId,
          scope,
          amountAtomic: intent.amountAtomic,
          state: "RESERVED",
          expiresAtMs: computeReservationExpiry(nowMs, configuration.reservationTtlMs, [
            intent.expiresAtMs,
            delegation.delegation.expiresAtMs,
          ]),
          policyDigest: policy.policy.digest,
          delegationRevision: delegation.revision,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
          executionId: null,
        })
      : null;
  const record: IntentRecord = Object.freeze({
    intentId,
    scope,
    intent,
    intentDigest: evaluation.intentDigest,
    decision,
    reservationId: reservation?.reservationId ?? null,
    createdAtMs: nowMs,
  });
  applyLedgerEvent(
    dependencies,
    tx,
    wallet,
    nowMs,
    { kind: "DECISION", subjectId: intentId, reason: decision.kind },
    {
      intents: [record],
      reservations: reservation ? [{ record: reservation, expectedState: null }] : [],
      allocations: reservation
        ? budgets.map((account) => ({
            wallet,
            allocation: {
              reservationId: reservation.reservationId,
              accountId: account.accountId,
              amountAtomic: intent.amountAtomic,
              state: "RESERVED",
              committedAtMs: null,
            },
            expectedState: null,
          }))
        : [],
    },
  );
  return ledgerSuccess(readLedgerStatus(tx, record));
}

/** Bind admission and scoped inspection to the transaction port.
 * @param dependencies - Authoritative store and trusted host capabilities.
 * @returns Coordinator methods with durable retry and all-account accounting.
 */
export function createLedgerAuthorization(dependencies: LedgerDependencies): LedgerAuthorization {
  const { store } = dependencies;
  return {
    authorize(input) {
      const raw = validateObject(input, ["scope", "intent"], "authorization");
      const scope = validateScope(raw.scope);
      const intent = validatePaymentIntent(raw.intent);
      const intentDigest = computeIntentDigest(intent, scope);
      const { expiresAtMs, amountAtomic, ...fields } = intent;
      const wire = Object.freeze({
        ...fields,
        amountAtomic: amountAtomic.toString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
      });
      return store.transaction((tx) => {
        const previous = tx.findIntent(scope, intent.idempotencyKey);
        if (!previous) return admitPurchase(dependencies, tx, scope, intent, wire);
        if (previous.intentDigest === intentDigest)
          return ledgerSuccess(readLedgerStatus(tx, previous));
        const wallet = readWalletScope(scope);
        const eventId = createHash("sha256")
          .update(JSON.stringify(["scuta.conflict.v1", scope, previous.intentId, intentDigest]))
          .digest("hex");
        if (!tx.getEvent(wallet, eventId))
          applyLedgerEvent(
            dependencies,
            tx,
            wallet,
            readLedgerTime(dependencies, tx, wallet),
            {
              kind: "IDEMPOTENCY_CONFLICT",
              subjectId: previous.intentId,
              reason: "IDEMPOTENCY_CONFLICT",
              eventId,
            },
            {},
          );
        return Object.freeze({ ok: false, reason: "IDEMPOTENCY_CONFLICT" });
      });
    },
    getStatus(input, intentId) {
      const scope = validateScope(input);
      const id = validateIdentifier(intentId, "intentId");
      return store.read((tx) => {
        const intent = tx.getIntent(scope, id);
        return intent
          ? ledgerSuccess(readLedgerStatus(tx, intent))
          : Object.freeze({ ok: false, reason: "NOT_FOUND" });
      });
    },
    getBudgetExposure(input, accountId) {
      const wallet = readWalletScope(input);
      const id = validateIdentifier(accountId, "accountId");
      return store.read((tx) => {
        requireLedgerWallet(tx, wallet);
        const account = tx.getBudget(wallet, id);
        if (!account) return Object.freeze({ ok: false, reason: "NOT_FOUND" });
        const nowMs = readLedgerTime(dependencies, tx, wallet);
        return ledgerSuccess(
          computeBudgetExposure(
            account,
            tx.getAllocations(wallet, [id], nowMs - account.windowMs),
            nowMs,
          ),
        );
      });
    },
  };
}
