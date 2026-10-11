/** @file Known-answer and field-binding tests for local semantic digests, not payment signatures. */
import { expect, test } from "bun:test";
import { createIntent, createPolicy, createScope } from "../test/fixtures.js";
import { computeIntentDigest, computePolicyDigest } from "./canonicalization.js";
import { validatePaymentIntent, type PaymentIntent } from "./payment-intent.js";
import { validatePolicy, type PolicyDigestInput } from "./policy.js";

test("matches the independently checked Node SHA-256 intent fixture", () => {
  expect(computeIntentDigest(validatePaymentIntent(createIntent()), createScope())).toBe(
    "36186bb0bd429e4650d1b5d111d528822d017f7cc0ac8e56c69acb34fa80dada",
  );
});

test("ignores input key order, idempotency identity and tracing labels", () => {
  const raw = createIntent();
  const reordered = Object.fromEntries(Object.entries(raw).reverse());
  const baseline = computeIntentDigest(validatePaymentIntent(raw), createScope());
  expect(computeIntentDigest(validatePaymentIntent(reordered), createScope())).toBe(baseline);
  expect(
    computeIntentDigest(
      validatePaymentIntent(createIntent({ idempotencyKey: "request-2", traceId: "trace-2" })),
      createScope(),
    ),
  ).toBe(baseline);
});

test.each([
  { schemaVersion: "2" as "1" },
  { delegationId: "delegation-2" },
  { network: "mock:other" },
  { asset: "mock:eur" },
  { amountAtomic: 1000001n },
  { recipient: "merchant:other" },
  { capability: "OTHER_CAPABILITY" },
  { resourceUrl: "https://example.test/other" },
  { method: "POST" as const, bodyDigest: "a".repeat(64) },
  { expiresAtMs: 1791677100001 },
] satisfies Partial<PaymentIntent>[])("binds each encoded purchase field %p", (change) => {
  const intent = validatePaymentIntent(createIntent());
  expect(computeIntentDigest({ ...intent, ...change }, createScope())).not.toBe(
    computeIntentDigest(intent, createScope()),
  );
});

test.each(["ownerId", "walletId", "agentId", "delegationId"] as const)(
  "binds trusted scope %s",
  (field) => {
    const intent = validatePaymentIntent(createIntent());
    expect(computeIntentDigest(intent, { ...createScope(), [field]: "other-1" })).not.toBe(
      computeIntentDigest(intent, createScope()),
    );
  },
);

test("binds a POST body independently of the method and resource", () => {
  const first = validatePaymentIntent(createIntent({ method: "POST", bodyDigest: "a".repeat(64) }));
  const second = validatePaymentIntent(
    createIntent({ method: "POST", bodyDigest: "b".repeat(64) }),
  );
  expect(computeIntentDigest(first, createScope())).not.toBe(
    computeIntentDigest(second, createScope()),
  );
});

test.each([
  { schemaVersion: "2" as "1" },
  { policyId: "policy-2" },
  { version: "2" },
  { network: "mock:other" },
  { asset: "mock:eur" },
  { hardTransactionLimitAtomic: 20000001n },
  { autonomousTransactionLimitAtomic: 9999999n },
  { approvalEnabled: false },
  { defaultRecipientAction: "ALLOW" as const },
  { recipientRules: [{ recipient: "merchant:weather", action: "DENY" as const }] },
  { recipientRules: [{ recipient: "merchant:other", action: "ALLOW" as const }] },
] satisfies Partial<PolicyDigestInput>[])("binds each encoded policy field %p", (change) => {
  const policy = validatePolicy(createPolicy());
  expect(computePolicyDigest({ ...policy, ...change })).not.toBe(policy.digest);
});

test.each(["ownerId", "walletId", "agentId", "delegationId"] as const)(
  "binds policy scope %s",
  (field) => {
    const policy = validatePolicy(createPolicy());
    expect(
      computePolicyDigest({ ...policy, scope: { ...createScope(), [field]: "other-1" } }),
    ).not.toBe(policy.digest);
  },
);

test("sorts recipient rules as a semantic set without changing the caller's array", () => {
  const rules = [
    { recipient: "merchant:z", action: "DENY" as const },
    { recipient: "merchant:A", action: "ALLOW" as const },
  ];
  const raw = createPolicy({ recipientRules: rules });
  const digest = validatePolicy(raw).digest;
  expect(validatePolicy({ ...raw, recipientRules: [...rules].reverse() }).digest).toBe(digest);
  expect(validatePolicy(Object.fromEntries(Object.entries(raw).reverse())).digest).toBe(digest);
  expect(rules[0]?.recipient).toBe("merchant:z");
});

test("separates policy and intent domains and produces lowercase 64-hex digests", () => {
  const policy = validatePolicy(createPolicy());
  const digest = computeIntentDigest(validatePaymentIntent(createIntent()), createScope());
  expect(digest).toMatch(/^[a-f0-9]{64}$/u);
  expect(policy.digest).toMatch(/^[a-f0-9]{64}$/u);
  expect(digest).not.toBe(policy.digest);
});
