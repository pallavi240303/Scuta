/** @file Domain-separated semantic policy identity; digests are not authentication credentials. */
import { createHash } from "node:crypto";
import type { PolicyDigestInput } from "./policy.js";
import type { PaymentIntent } from "./payment-intent.js";
import type { TrustedScope } from "./validation.js";

/**
 * Hash purchase semantics and host scope in a fixed, versioned field order.
 *
 * Includes resource URL, method, POST body digest and expiry; excludes tracing
 * and idempotency keys. This identifies a purchase, not a signature or execution permission.
 *
 * @param intent - Payment intent already returned by `validatePaymentIntent`; not revalidated here.
 * @param scope - Validated host-resolved ownership/delegation labels to bind into the digest.
 * @returns A lowercase 64-hex SHA-256 digest in the `pennywise.intent.v1` domain.
 */
export function computeIntentDigest(intent: PaymentIntent, scope: TrustedScope): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "pennywise.intent.v1",
        intent.schemaVersion,
        [scope.ownerId, scope.walletId, scope.agentId, scope.delegationId],
        intent.delegationId,
        intent.network,
        intent.asset,
        intent.amountAtomic.toString(),
        intent.recipient,
        intent.capability,
        intent.resourceUrl,
        intent.method,
        intent.method === "POST" ? intent.bodyDigest : null,
        intent.expiresAtMs,
      ]),
    )
    .digest("hex");
}

/**
 * Hash normalized owner policy independently of recipient-rule ordering.
 *
 * Does not mutate the caller's rules or authenticate policy ownership.
 *
 * @param policy - Validated policy fields with bigint limits, excluding the digest itself; not revalidated here.
 * @returns A lowercase 64-hex SHA-256 digest in the `pennywise.policy.v1` domain.
 */
export function computePolicyDigest(policy: PolicyDigestInput): string {
  const rules = policy.recipientRules
    .map((rule) => [rule.recipient, rule.action] as const)
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return createHash("sha256")
    .update(
      JSON.stringify([
        "pennywise.policy.v1",
        policy.schemaVersion,
        policy.policyId,
        policy.version,
        [
          policy.scope.ownerId,
          policy.scope.walletId,
          policy.scope.agentId,
          policy.scope.delegationId,
        ],
        policy.network,
        policy.asset,
        policy.hardTransactionLimitAtomic.toString(),
        policy.autonomousTransactionLimitAtomic.toString(),
        rules,
        policy.defaultRecipientAction,
        policy.approvalEnabled,
      ]),
    )
    .digest("hex");
}
