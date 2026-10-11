/** @file Owner policy contract; adaptive permission may never override these hard constraints. */
import { parseAtomicAmount, parseNonnegativeAtomicAmount } from "./amount.js";
import { computePolicyDigest } from "./canonicalization.js";
import {
  ValidationError,
  validateArray,
  validateBoolean,
  validateEnum,
  validateIdentifier,
  validateObject,
  validateProfileIdentifier,
  validateScope,
  type TrustedScope,
} from "./validation.js";

/** Owner-selected recipient action inside all other hard constraints. */
export type RecipientAction = "ALLOW" | "REQUIRE_APPROVAL" | "DENY";

/** One explicit recipient rule; duplicate recipients are invalid. */
export interface RecipientRule {
  readonly recipient: string;
  readonly action: RecipientAction;
}

/** Owner policy wire contract; canonical atomic-unit limits require runtime validation. */
export interface PolicyWire {
  readonly schemaVersion: "1";
  readonly policyId: string;
  readonly version: string;
  readonly scope: TrustedScope;
  readonly network: string;
  readonly asset: string;
  readonly hardTransactionLimitAtomic: string;
  readonly autonomousTransactionLimitAtomic: string;
  readonly recipientRules: readonly RecipientRule[];
  readonly defaultRecipientAction: RecipientAction;
  readonly approvalEnabled: boolean;
}

/** Normalized policy fields bound into its digest, excluding the digest itself. */
export type PolicyDigestInput = Readonly<
  Omit<PolicyWire, "hardTransactionLimitAtomic" | "autonomousTransactionLimitAtomic"> & {
    hardTransactionLimitAtomic: bigint;
    autonomousTransactionLimitAtomic: bigint;
  }
>;

/** Immutable validated policy plus computed identity, not a caller-asserted hash. */
export type Policy = Readonly<
  PolicyDigestInput & {
    digest: string;
  }
>;

/**
 * Validate an owner policy, freeze its nested values and compute its semantic digest.
 *
 * @param value - Untrusted, inert policy wire object; caller-supplied digests are not accepted.
 * @returns An independent immutable snapshot with exact bigint limits and a computed policy digest.
 * @throws {ValidationError} If fields or recipient rules are malformed or duplicated,
 * or the autonomous allowance exceeds the hard transaction ceiling.
 */
export function validatePolicy(value: unknown): Policy {
  const raw = validateObject(
    value,
    [
      "schemaVersion",
      "policyId",
      "version",
      "scope",
      "network",
      "asset",
      "hardTransactionLimitAtomic",
      "autonomousTransactionLimitAtomic",
      "recipientRules",
      "defaultRecipientAction",
      "approvalEnabled",
    ],
    "policy",
  );
  const hardTransactionLimitAtomic = parseAtomicAmount(
    raw.hardTransactionLimitAtomic,
    "policy.hardTransactionLimitAtomic",
  );
  const autonomousTransactionLimitAtomic = parseNonnegativeAtomicAmount(
    raw.autonomousTransactionLimitAtomic,
    "policy.autonomousTransactionLimitAtomic",
  );
  if (autonomousTransactionLimitAtomic > hardTransactionLimitAtomic)
    throw new ValidationError("INCONSISTENT_POLICY", "policy.autonomousTransactionLimitAtomic");
  const recipientRules = validateArray(raw.recipientRules, "policy.recipientRules").map((value) => {
    const rule = validateObject(value, ["recipient", "action"], "policy.recipientRules");
    return Object.freeze({
      recipient: validateProfileIdentifier(rule.recipient, "policy.recipientRules.recipient"),
      action: validateEnum(
        rule.action,
        ["ALLOW", "REQUIRE_APPROVAL", "DENY"],
        "policy.recipientRules.action",
      ),
    });
  });
  if (new Set(recipientRules.map((rule) => rule.recipient)).size !== recipientRules.length) {
    throw new ValidationError("INVALID_SHAPE", "policy.recipientRules");
  }
  const policy: PolicyDigestInput = {
    schemaVersion: validateEnum(raw.schemaVersion, ["1"], "policy.schemaVersion"),
    policyId: validateIdentifier(raw.policyId, "policy.policyId"),
    version: validateIdentifier(raw.version, "policy.version"),
    scope: validateScope(raw.scope, "policy.scope"),
    network: validateProfileIdentifier(raw.network, "policy.network"),
    asset: validateProfileIdentifier(raw.asset, "policy.asset"),
    hardTransactionLimitAtomic,
    autonomousTransactionLimitAtomic,
    recipientRules: Object.freeze(recipientRules),
    defaultRecipientAction: validateEnum(
      raw.defaultRecipientAction,
      ["ALLOW", "REQUIRE_APPROVAL", "DENY"],
      "policy.defaultRecipientAction",
    ),
    approvalEnabled: validateBoolean(raw.approvalEnabled, "policy.approvalEnabled"),
  };
  return Object.freeze({ ...policy, digest: computePolicyDigest(policy) });
}
