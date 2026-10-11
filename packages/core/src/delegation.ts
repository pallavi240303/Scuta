/** @file Protected delegation data; trusted scope is supplied by the host in this phase. */
import {
  ValidationError,
  matchesScope,
  validateArray,
  validateBoolean,
  validateEnum,
  validateObject,
  validateScope,
  validateTimestamp,
  validateEvaluationTime,
  type TrustedScope,
} from "./validation.js";
import type { PaymentIntent } from "./payment-intent.js";

/** Stable delegation denial categories, ordered independently of approval conditions. */
export type DelegationReasonCode =
  "SCOPE_MISMATCH" | "DELEGATION_REVOKED" | "DELEGATION_EXPIRED" | "CAPABILITY_NOT_DELEGATED";

/**
 * Check whether a validated delegation covers the requested purchase at a supplied time.
 *
 * Does not authenticate the host or reparse these snapshots. An expiry equal to
 * `nowMs` is expired. Valid but inactive grants return reasons rather than throwing.
 *
 * @param delegation - Snapshot already returned by `validateDelegation`.
 * @param scope - Validated ownership/delegation labels resolved by a trusted host.
 * @param intent - Snapshot already returned by `validatePaymentIntent`.
 * @param nowMs - Nonnegative safe-integer milliseconds since the Unix epoch.
 * @returns A frozen ordered list of denial reasons; empty means these delegation checks passed.
 * @throws {ValidationError} If the supplied evaluation time is invalid.
 */
export function validateDelegationScope(
  delegation: Delegation,
  scope: TrustedScope,
  intent: PaymentIntent,
  nowMs: number,
): readonly DelegationReasonCode[] {
  validateEvaluationTime(nowMs);
  const reasons: DelegationReasonCode[] = [];
  if (!matchesScope(delegation.scope, scope) || intent.delegationId !== scope.delegationId)
    reasons.push("SCOPE_MISMATCH");
  if (delegation.revoked) reasons.push("DELEGATION_REVOKED");
  if (delegation.expiresAtMs <= nowMs) reasons.push("DELEGATION_EXPIRED");
  if (!delegation.capabilities.some((capability) => capability === intent.capability))
    reasons.push("CAPABILITY_NOT_DELEGATED");
  return Object.freeze(reasons);
}

/** Delegated capabilities supported by the static reference core. */
export type DelegatedCapability = "PAY_HTTP_RESOURCE";

/** Owner-issued grants and revocation state, with canonical UTC expiry. */
export interface DelegationWire {
  readonly schemaVersion: "1";
  readonly scope: TrustedScope;
  readonly capabilities: readonly DelegatedCapability[];
  readonly revoked: boolean;
  readonly expiresAt: string;
}

/** Immutable delegation snapshot with expiry in milliseconds since the Unix epoch. */
export type Delegation = Readonly<
  Omit<DelegationWire, "expiresAt"> & {
    expiresAtMs: number;
  }
>;

/**
 * Validate and freeze a delegation snapshot without authenticating its issuer.
 *
 * @param value - Untrusted, inert wire object containing scope, granted capabilities, revocation and expiry.
 * @returns An independent frozen snapshot with expiry in epoch milliseconds; an empty capability list is valid.
 * @throws {ValidationError} If fields are missing or malformed, or capabilities are unsupported or duplicated.
 */
export function validateDelegation(value: unknown): Delegation {
  const raw = validateObject(
    value,
    ["schemaVersion", "scope", "capabilities", "revoked", "expiresAt"],
    "delegation",
  );
  const capabilities = validateArray(raw.capabilities, "delegation.capabilities").map(
    (capability) => validateEnum(capability, ["PAY_HTTP_RESOURCE"], "delegation.capabilities"),
  );
  if (new Set(capabilities).size !== capabilities.length)
    throw new ValidationError("INVALID_SHAPE", "delegation.capabilities");
  return Object.freeze({
    schemaVersion: validateEnum(raw.schemaVersion, ["1"], "delegation.schemaVersion"),
    scope: validateScope(raw.scope, "delegation.scope"),
    capabilities: Object.freeze(capabilities),
    revoked: validateBoolean(raw.revoked, "delegation.revoked"),
    expiresAtMs: validateTimestamp(raw.expiresAt, "delegation.expiresAt"),
  });
}
