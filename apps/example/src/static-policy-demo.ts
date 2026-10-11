/** @file Local static policy walkthrough using mock identifiers, with no payment or network execution. */
import { evaluatePolicy, type PolicyEvaluation, type PolicyEvaluationInput } from "@scuta/core";

/**
 * Create mock purchases below the autonomous allowance, above it and above the hard ceiling.
 *
 * @returns Three wire envelopes using fixed time and opaque mock identifiers, without shared nested scope objects.
 */
export function createDemoInputs(): readonly PolicyEvaluationInput[] {
  const scope = {
    ownerId: "owner-1",
    walletId: "wallet-1",
    agentId: "agent-1",
    delegationId: "delegation-1",
  };
  return ["1000000", "15000000", "20000001"].map((amountAtomic, index): PolicyEvaluationInput => ({
    nowMs: 1791676800000,
    scope: { ...scope },
    intent: {
      schemaVersion: "1",
      idempotencyKey: `request-${index + 1}`,
      delegationId: scope.delegationId,
      network: "mock:local",
      asset: "mock:usd",
      amountAtomic,
      recipient: "merchant:weather",
      capability: "PAY_HTTP_RESOURCE",
      resourceUrl: "https://example.test/weather",
      method: "GET",
      expiresAt: "2026-10-11T00:05:00.000Z",
    },
    policy: {
      schemaVersion: "1",
      policyId: "policy-1",
      version: "1",
      scope: { ...scope },
      network: "mock:local",
      asset: "mock:usd",
      hardTransactionLimitAtomic: "20000000",
      autonomousTransactionLimitAtomic: "10000000",
      recipientRules: [{ recipient: "merchant:weather", action: "ALLOW" }],
      defaultRecipientAction: "DENY",
      approvalEnabled: true,
    },
    delegation: {
      schemaVersion: "1",
      scope: { ...scope },
      capabilities: ["PAY_HTTP_RESOURCE"],
      revoked: false,
      expiresAt: "2026-10-11T01:00:00.000Z",
    },
  }));
}

/**
 * Run the static walkthrough through the built core, without network calls or payments.
 *
 * @returns A frozen array of ALLOW, REQUIRE_APPROVAL and DENY evaluations, in that order.
 * REQUIRE_APPROVAL does not contact a human; these are static results only.
 */
export function runStaticPolicyDemo(): readonly PolicyEvaluation[] {
  return Object.freeze(createDemoInputs().map((input) => evaluatePolicy(input)));
}

if (import.meta.main) {
  console.log("Static policy only: mock atomic units, no payment execution or approval service.");
  console.log(JSON.stringify(runStaticPolicyDemo(), null, 2));
}
