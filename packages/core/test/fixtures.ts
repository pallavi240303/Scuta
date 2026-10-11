/** @file Non-networked wire fixtures shared by policy tests, with fresh independent objects. */
import type { DelegationWire } from "../src/delegation.js";
import type { PaymentIntentWire } from "../src/payment-intent.js";
import type { PolicyWire } from "../src/policy.js";

/** Deterministic evaluation instant in UTC milliseconds. */
export const NOW_MS = 1791676800000;

/**
 * Create fresh mock ownership/delegation labels for an isolated test.
 *
 * @returns A mutable scope fixture, not authentication credentials.
 */
export function createScope() {
  return {
    ownerId: "owner-1",
    walletId: "wallet-1",
    agentId: "agent-1",
    delegationId: "delegation-1",
  };
}

/**
 * Create a fresh mock purchase, defaulting to GET and 1,000,000 atomic units.
 *
 * @param overrides - Replacement wire fields; selecting POST also requires a body digest.
 * @returns An unfrozen wire fixture for validation or policy tests; overrides are not runtime-validated.
 * @throws {Error} If a POST override omits its body digest.
 */
export function createIntent(overrides: Partial<PaymentIntentWire> = {}): PaymentIntentWire {
  const { method = "GET", bodyDigest, ...fields } = overrides;
  const intent: Omit<PaymentIntentWire, "method" | "bodyDigest"> = {
    schemaVersion: "1",
    idempotencyKey: "request-1",
    delegationId: "delegation-1",
    network: "mock:local",
    asset: "mock:usd",
    amountAtomic: "1000000",
    recipient: "merchant:weather",
    capability: "PAY_HTTP_RESOURCE",
    resourceUrl: "https://example.test/weather",
    expiresAt: "2026-10-11T00:05:00.000Z",
    ...fields,
  };
  if (method === "POST") {
    if (bodyDigest === undefined) throw new Error("POST fixture requires a body digest");
    return { ...intent, method, bodyDigest };
  }
  return { ...intent, method };
}

/**
 * Create a mock policy with 20,000,000 hard and 10,000,000 autonomous atomic-unit ceilings.
 *
 * @param overrides - Replacement fields, intentionally allowed to form negative validation cases.
 * @returns An unfrozen wire policy with a fresh default scope and recipient-rule array.
 */
export function createPolicy(overrides: Partial<PolicyWire> = {}): PolicyWire {
  return {
    schemaVersion: "1",
    policyId: "policy-1",
    version: "1",
    scope: createScope(),
    network: "mock:local",
    asset: "mock:usd",
    hardTransactionLimitAtomic: "20000000",
    autonomousTransactionLimitAtomic: "10000000",
    recipientRules: [{ recipient: "merchant:weather", action: "ALLOW" }],
    defaultRecipientAction: "DENY",
    approvalEnabled: true,
    ...overrides,
  };
}

/**
 * Create an active mock delegation expiring one hour after `NOW_MS`.
 *
 * @param overrides - Replacement fields for active, expired, revoked or malformed test cases.
 * @returns An unfrozen wire delegation with fresh default scope and capability values.
 */
export function createDelegation(overrides: Partial<DelegationWire> = {}): DelegationWire {
  return {
    schemaVersion: "1",
    scope: createScope(),
    capabilities: ["PAY_HTTP_RESOURCE"],
    revoked: false,
    expiresAt: "2026-10-11T01:00:00.000Z",
    ...overrides,
  };
}
