/** @file Runtime boundaries for exact ledger configuration and internal execution metadata. */
import { Buffer } from "node:buffer";
import { parseAtomicAmount, parseNonnegativeAtomicAmount } from "./amount.js";
import type {
  BudgetAccount,
  BudgetScope,
  ExecutionBinding,
  LedgerObservation,
  WalletConfiguration,
} from "./ledger-contracts.js";
import {
  ValidationError,
  validateEnum,
  validateIdentifier,
  validateObject,
  validateProfileIdentifier,
  validateScope,
} from "./validation.js";

/** Validate a nonnegative safe-integer time or counter without rounding.
 * @param value - Untrusted integer value.
 * @param path - Trusted redacted field label.
 * @param positive - Whether zero is disallowed for this duration or revision.
 * @returns The exact checked number.
 * @throws {ValidationError} If the value is not an integer inside the selected range.
 */
export function validateLedgerInteger(value: unknown, path: string, positive = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (positive ? 1 : 0))
    throw new ValidationError("OUT_OF_RANGE", path);
  return value;
}

/** Validate an account's configured hierarchical membership.
 * @param value - Inert discriminated scope object.
 * @returns An independent immutable scope with only fields appropriate to its kind.
 * @throws {ValidationError} If labels, kind or allowed-field membership are invalid.
 */
function validateBudgetScope(value: unknown): BudgetScope {
  const raw = validateObject(
    value,
    ["kind", "ownerId", "walletId", "agentId", "delegationId"],
    "budget.scope",
  );
  const kind = validateEnum(raw.kind, ["WALLET", "AGENT", "DELEGATION"], "budget.scope.kind");
  validateObject(
    raw,
    kind === "WALLET"
      ? ["kind", "ownerId", "walletId"]
      : kind === "AGENT"
        ? ["kind", "ownerId", "walletId", "agentId"]
        : ["kind", "ownerId", "walletId", "agentId", "delegationId"],
    "budget.scope",
  );
  const wallet = {
    ownerId: validateIdentifier(raw.ownerId, "budget.scope.ownerId"),
    walletId: validateIdentifier(raw.walletId, "budget.scope.walletId"),
  };
  if (kind === "WALLET") return Object.freeze({ kind, ...wallet });
  const agentId = validateIdentifier(raw.agentId, "budget.scope.agentId");
  if (kind === "AGENT") return Object.freeze({ kind, ...wallet, agentId });
  return Object.freeze({
    kind,
    ...wallet,
    agentId,
    delegationId: validateIdentifier(raw.delegationId, "budget.scope.delegationId"),
  });
}

/** Validate a lowercase digest or nonce without normalization.
 * @param value - Untrusted 64-character hexadecimal string.
 * @param path - Trusted redacted field label.
 * @returns The original exact canonical digest.
 * @throws {ValidationError} If the value is not a lowercase 64-hex string.
 */
function validateDigest(value: unknown, path: string): string {
  if (typeof value !== "string" || /^[a-f0-9]{64}/u.exec(value)?.[0] !== value)
    throw new ValidationError("INVALID_FORMAT", path);
  return value;
}

/** Validate a bounded unsigned payload's canonical base64 representation.
 * @param value - Untrusted payload text, checked before allocating decoded bytes.
 * @returns Original canonical base64 for one to 16,384 bytes.
 * @throws {ValidationError} If size or encoding is invalid.
 */
function validatePayload(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 21_848)
    throw new ValidationError("OUT_OF_RANGE", "execution.payloadBase64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > 16_384 || bytes.toString("base64") !== value)
    throw new ValidationError("INVALID_FORMAT", "execution.payloadBase64");
  return value;
}

/** Validate wallet settings.
 * @param value - Untrusted inert wire object.
 * @returns Immutable wallet configuration, not signer credentials.
 * @throws {ValidationError} If a label, shape or positive duration is invalid.
 */
export function validateWalletConfiguration(value: unknown): WalletConfiguration {
  const raw = validateObject(
    value,
    [
      "ownerId",
      "walletId",
      "network",
      "asset",
      "signerId",
      "reservationTtlMs",
      "executionTtlMs",
      "orphanAfterMs",
    ],
    "wallet",
  );
  return Object.freeze({
    ownerId: validateIdentifier(raw.ownerId, "wallet.ownerId"),
    walletId: validateIdentifier(raw.walletId, "wallet.walletId"),
    network: validateProfileIdentifier(raw.network, "wallet.network"),
    asset: validateProfileIdentifier(raw.asset, "wallet.asset"),
    signerId: validateIdentifier(raw.signerId, "wallet.signerId"),
    reservationTtlMs: validateLedgerInteger(raw.reservationTtlMs, "wallet.reservationTtlMs", true),
    executionTtlMs: validateLedgerInteger(raw.executionTtlMs, "wallet.executionTtlMs", true),
    orphanAfterMs: validateLedgerInteger(raw.orphanAfterMs, "wallet.orphanAfterMs", true),
  });
}
/** Validate a budget account.
 * @param value - Untrusted inert wire object.
 * @returns Immutable exact budget account.
 * @throws {ValidationError} If scope, revision, window or canonical ceiling is invalid.
 */
export function validateBudgetAccount(value: unknown): BudgetAccount {
  const raw = validateObject(
    value,
    ["accountId", "scope", "network", "asset", "windowMs", "ceilingAtomic", "revision"],
    "budget",
  );
  return Object.freeze({
    accountId: validateIdentifier(raw.accountId, "budget.accountId"),
    scope: validateBudgetScope(raw.scope),
    network: validateProfileIdentifier(raw.network, "budget.network"),
    asset: validateProfileIdentifier(raw.asset, "budget.asset"),
    windowMs: validateLedgerInteger(raw.windowMs, "budget.windowMs", true),
    ceilingAtomic: parseNonnegativeAtomicAmount(raw.ceilingAtomic, "budget.ceilingAtomic"),
    revision: validateLedgerInteger(raw.revision, "budget.revision", true),
  });
}
/** Validate unsigned execution metadata.
 * @param value - Untrusted inert wire object.
 * @returns Immutable parsed binding, not verified protocol authority.
 * @throws {ValidationError} If identity, money, payload or validity interval is malformed.
 */
export function validateExecutionBinding(value: unknown): ExecutionBinding {
  const raw = validateObject(
    value,
    [
      "scope",
      "reservationId",
      "intentDigest",
      "signerId",
      "network",
      "asset",
      "recipient",
      "amountAtomic",
      "nonce",
      "validAfterMs",
      "validBeforeMs",
      "payloadBase64",
    ],
    "execution",
  );
  const validAfterMs = validateLedgerInteger(raw.validAfterMs, "execution.validAfterMs");
  const validBeforeMs = validateLedgerInteger(raw.validBeforeMs, "execution.validBeforeMs");
  if (validBeforeMs <= validAfterMs)
    throw new ValidationError("OUT_OF_RANGE", "execution.validBeforeMs");
  return Object.freeze({
    scope: validateScope(raw.scope, "execution.scope"),
    reservationId: validateIdentifier(raw.reservationId, "execution.reservationId"),
    intentDigest: validateDigest(raw.intentDigest, "execution.intentDigest"),
    signerId: validateIdentifier(raw.signerId, "execution.signerId"),
    network: validateProfileIdentifier(raw.network, "execution.network"),
    asset: validateProfileIdentifier(raw.asset, "execution.asset"),
    recipient: validateProfileIdentifier(raw.recipient, "execution.recipient"),
    amountAtomic: parseAtomicAmount(raw.amountAtomic, "execution.amountAtomic"),
    nonce: validateDigest(raw.nonce, "execution.nonce"),
    validAfterMs,
    validBeforeMs,
    payloadBase64: validatePayload(raw.payloadBase64),
  });
}
/** Validate normalized evidence labels.
 * @param value - Untrusted inert wire object.
 * @returns Immutable observation, not verified provider evidence.
 * @throws {ValidationError} If labels, digest, kind or reference bounds are invalid.
 */
export function validateLedgerObservation(value: unknown): LedgerObservation {
  const raw = validateObject(
    value,
    ["evidenceId", "executionId", "bindingDigest", "kind", "evidenceRef"],
    "observation",
  );
  if (
    typeof raw.evidenceRef !== "string" ||
    /^[\x20-\x7e]{1,256}/u.exec(raw.evidenceRef)?.[0] !== raw.evidenceRef
  )
    throw new ValidationError("INVALID_FORMAT", "observation.evidenceRef");
  return Object.freeze({
    evidenceId: validateIdentifier(raw.evidenceId, "observation.evidenceId"),
    executionId: validateIdentifier(raw.executionId, "observation.executionId"),
    bindingDigest: validateDigest(raw.bindingDigest, "observation.bindingDigest"),
    kind: validateEnum(raw.kind, ["SETTLED", "FINAL_NON_EXECUTION"], "observation.kind"),
    evidenceRef: raw.evidenceRef,
  });
}
