/** @file Static decision matrix, boundary attacks, deterministic explanations and absent authority. */
import { expect, test } from "bun:test";
import { createDelegation, createIntent, createPolicy, createScope, NOW_MS } from "./fixtures.js";
import {
  evaluatePolicy,
  type PolicyEvaluation,
  type PolicyEvaluationInput,
} from "../src/evaluate-policy.js";
import { validatePaymentIntent } from "../src/payment-intent.js";
import { validatePolicy } from "../src/policy.js";
import { computeIntentDigest } from "../src/canonicalization.js";
import { ValidationError } from "../src/validation.js";

/**
 * Create independent default contracts for one deterministic evaluation test.
 *
 * @param overrides - Replacement top-level fields for the scenario under test.
 * @returns An unfrozen wire envelope using mock host scope and `NOW_MS`.
 */
function createEvaluation(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return {
    intent: createIntent(),
    policy: createPolicy(),
    delegation: createDelegation(),
    scope: createScope(),
    nowMs: NOW_MS,
    ...overrides,
  };
}

test("public inputs expose useful wire types without bypassing validation", () => {
  const input = createEvaluation();
  const amount: string = input.intent.amountAtomic;
  const hardLimit: string = input.policy.hardTransactionLimitAtomic;
  const revoked: boolean = input.delegation.revoked;
  const ownerId: string = input.scope.ownerId;
  expect([amount, hardLimit, revoked, ownerId]).toEqual(["1000000", "20000000", false, "owner-1"]);
  expect(evaluatePolicy(input).kind).toBe("ALLOW");
});

test.each([
  { amount: "1", kind: "ALLOW", reasons: ["WITHIN_STATIC_POLICY"] },
  { amount: "10000000", kind: "ALLOW", reasons: ["WITHIN_STATIC_POLICY"] },
  { amount: "10000001", kind: "REQUIRE_APPROVAL", reasons: ["AUTONOMOUS_LIMIT_EXCEEDED"] },
  { amount: "20000000", kind: "REQUIRE_APPROVAL", reasons: ["AUTONOMOUS_LIMIT_EXCEEDED"] },
  { amount: "20000001", kind: "DENY", reasons: ["HARD_TRANSACTION_LIMIT_EXCEEDED"] },
])("evaluates exact transaction ceilings %p", ({ amount, kind, reasons }) => {
  const result = evaluatePolicy(
    createEvaluation({ intent: createIntent({ amountAtomic: amount }) }),
  );
  expect(result.kind).toBe(kind);
  expect(result.reasonCodes).toEqual(reasons);
});

test("allows exact hard ceiling when autonomous ceiling is equal", () => {
  expect(
    evaluatePolicy(
      createEvaluation({
        policy: createPolicy({ autonomousTransactionLimitAtomic: "20000000" }),
        intent: createIntent({ amountAtomic: "20000000" }),
      }),
    ).kind,
  ).toBe("ALLOW");
});

test("a zero autonomous allowance routes even the smallest positive payment to review", () => {
  expect(
    evaluatePolicy(
      createEvaluation({
        policy: createPolicy({ autonomousTransactionLimitAtomic: "0" }),
        intent: createIntent({ amountAtomic: "1" }),
      }),
    ).reasonCodes,
  ).toEqual(["AUTONOMOUS_LIMIT_EXCEEDED"]);
});

test.each(["ALLOW", "REQUIRE_APPROVAL", "DENY"] as const)(
  "uses the owner's explicit default %s for an unknown recipient",
  (action) => {
    const result = evaluatePolicy(
      createEvaluation({
        intent: createIntent({ recipient: "merchant:unknown" }),
        policy: createPolicy({ defaultRecipientAction: action }),
      }),
    );
    expect(result.kind).toBe(action);
    expect(result.reasonCodes).toEqual([
      action === "ALLOW"
        ? "WITHIN_STATIC_POLICY"
        : action === "DENY"
          ? "RECIPIENT_FORBIDDEN"
          : "RECIPIENT_REQUIRES_APPROVAL",
    ]);
  },
);

test("explicit recipient denial outranks a permissive default and approval condition", () => {
  const policy = createPolicy({
    defaultRecipientAction: "ALLOW",
    recipientRules: [{ recipient: "merchant:weather", action: "DENY" }],
  });
  const result = evaluatePolicy(
    createEvaluation({ policy, intent: createIntent({ amountAtomic: "15000000" }) }),
  );
  expect(result.kind).toBe("DENY");
  expect(result.reasonCodes).toEqual(["RECIPIENT_FORBIDDEN"]);
});

test.each([true, false])("combines review triggers with approval enabled=%s", (approvalEnabled) => {
  const policy = createPolicy({
    approvalEnabled,
    recipientRules: [{ recipient: "merchant:weather", action: "REQUIRE_APPROVAL" }],
  });
  const result = evaluatePolicy(
    createEvaluation({ policy, intent: createIntent({ amountAtomic: "15000000" }) }),
  );
  expect(result.kind).toBe(approvalEnabled ? "REQUIRE_APPROVAL" : "DENY");
  expect(result.reasonCodes).toEqual([
    ...(approvalEnabled ? [] : ["APPROVAL_UNAVAILABLE" as const]),
    "RECIPIENT_REQUIRES_APPROVAL",
    "AUTONOMOUS_LIMIT_EXCEEDED",
  ]);
});

test("approval disabled does not deny a transaction that needs no approval", () => {
  expect(
    evaluatePolicy(createEvaluation({ policy: createPolicy({ approvalEnabled: false }) })).kind,
  ).toBe("ALLOW");
});

test.each([
  { offset: -1, kind: "ALLOW" },
  { offset: 0, kind: "DENY" },
  { offset: 1, kind: "DENY" },
])("checks exact intent expiry %p", ({ offset, kind }) => {
  const result = evaluatePolicy(createEvaluation({ nowMs: NOW_MS + 300000 + offset }));
  expect(result.kind).toBe(kind);
  expect(result.reasonCodes).toEqual([
    kind === "ALLOW" ? "WITHIN_STATIC_POLICY" : "INTENT_EXPIRED",
  ]);
});

test.each(["ownerId", "walletId", "agentId", "delegationId"] as const)(
  "denies policy bound to another %s",
  (field) => {
    const result = evaluatePolicy(
      createEvaluation({
        policy: createPolicy({ scope: { ...createScope(), [field]: "other-1" } }),
      }),
    );
    expect(result.reasonCodes).toEqual(["SCOPE_MISMATCH"]);
  },
);

test.each([
  { delegation: createDelegation({ revoked: true }), reasons: ["DELEGATION_REVOKED"] },
  {
    delegation: createDelegation({ expiresAt: "2026-10-11T00:00:00.000Z" }),
    reasons: ["DELEGATION_EXPIRED"],
  },
  { delegation: createDelegation({ capabilities: [] }), reasons: ["CAPABILITY_NOT_DELEGATED"] },
  {
    delegation: createDelegation({ scope: { ...createScope(), walletId: "other-1" } }),
    reasons: ["SCOPE_MISMATCH"],
  },
])("denies inactive or mismatched grants %p", ({ delegation, reasons }) => {
  const result = evaluatePolicy(createEvaluation({ delegation }));
  expect(result.kind).toBe("DENY");
  expect(result.reasonCodes).toEqual(reasons);
});

test.each([
  {
    change: { capability: "OTHER_CAPABILITY" },
    reasons: ["CAPABILITY_NOT_DELEGATED", "UNSUPPORTED_CAPABILITY"],
  },
  { change: { network: "other:local" }, reasons: ["UNSUPPORTED_NETWORK"] },
  { change: { asset: "mock:eur" }, reasons: ["UNSUPPORTED_ASSET"] },
  { change: { delegationId: "other-1" }, reasons: ["SCOPE_MISMATCH"] },
])("denies unsupported or cross-scope proposals %p", ({ change, reasons }) => {
  const result = evaluatePolicy(createEvaluation({ intent: createIntent(change) }));
  expect(result.kind).toBe("DENY");
  expect(result.reasonCodes).toEqual(reasons);
});

test("collects hard denials in fixed order, without duplicate scope reasons or approval triggers", () => {
  const result = evaluatePolicy(
    createEvaluation({
      policy: createPolicy({
        scope: { ...createScope(), agentId: "other-1" },
        approvalEnabled: false,
      }),
      delegation: createDelegation({
        scope: { ...createScope(), ownerId: "other-1" },
        revoked: true,
        capabilities: [],
        expiresAt: "2026-10-11T00:00:00.000Z",
      }),
      intent: createIntent({
        delegationId: "other-1",
        expiresAt: "2026-10-11T00:00:00.000Z",
        capability: "OTHER_CAPABILITY",
        network: "other:local",
        asset: "mock:eur",
        recipient: "merchant:unknown",
        amountAtomic: "20000001",
      }),
    }),
  );
  expect(result.kind).toBe("DENY");
  expect(result.reasonCodes).toEqual([
    "SCOPE_MISMATCH",
    "DELEGATION_REVOKED",
    "DELEGATION_EXPIRED",
    "INTENT_EXPIRED",
    "CAPABILITY_NOT_DELEGATED",
    "UNSUPPORTED_CAPABILITY",
    "UNSUPPORTED_NETWORK",
    "UNSUPPORTED_ASSET",
    "RECIPIENT_FORBIDDEN",
    "HARD_TRANSACTION_LIMIT_EXCEEDED",
  ]);
});

test.each([
  { intent: validatePaymentIntent(createIntent()) },
  { policy: validatePolicy(createPolicy()) },
  { intent: { ...createIntent(), remainingBudget: "unlimited" } },
  { policy: { ...createPolicy(), digest: "forged" } },
  { scope: { ...createScope(), ownerId: "" } },
  { policy: createPolicy({ autonomousTransactionLimitAtomic: "20000001" }) },
  { nowMs: NaN },
  { nowMs: -1 },
  { nowMs: 0.5 },
])("revalidates malformed and force-cast normalized objects %p", (change) => {
  const input = { ...createEvaluation(), ...change } as PolicyEvaluationInput;
  expect(() => evaluatePolicy(input)).toThrow(ValidationError);
});

test("rejects malformed evaluation envelopes", () => {
  expect(() => evaluatePolicy(null as unknown as PolicyEvaluationInput)).toThrow(ValidationError);
  expect(() =>
    evaluatePolicy({ ...createEvaluation(), authority: true } as PolicyEvaluationInput),
  ).toThrow(ValidationError);
  const raw: Record<string, unknown> = { ...createEvaluation() };
  delete raw.delegation;
  expect(() => evaluatePolicy(raw as unknown as PolicyEvaluationInput)).toThrow(ValidationError);
});

test("returns deterministic frozen provenance and does not mutate inputs", () => {
  const input = createEvaluation();
  const before = structuredClone(input);
  const result = evaluatePolicy(input);
  expect(result).toEqual(evaluatePolicy(input));
  expect(input).toEqual(before);
  expect(result.policyDigest).toBe(validatePolicy(input.policy).digest);
  expect(result.intentDigest).toBe(
    computeIntentDigest(validatePaymentIntent(input.intent), createScope()),
  );
  expect(result.policyVersion).toBe("1");
  expect(result.evaluatedAtMs).toBe(NOW_MS);
  expect(Reflect.set(result, "kind", "DENY")).toBe(false);
  expect(Reflect.set(result.reasonCodes, "0", "SCOPE_MISMATCH")).toBe(false);
});

test("a returned evaluation does not retain authority or mutable input state", () => {
  const policy = {
    ...createPolicy(),
    scope: createScope(),
    recipientRules: [{ recipient: "merchant:weather", action: "ALLOW" as const }],
  };
  const input = createEvaluation({ policy });
  const result = evaluatePolicy(input);
  policy.recipientRules.length = 0;
  policy.scope.ownerId = "other-1";
  expect(result.kind).toBe("ALLOW");
  expect(evaluatePolicy(input).kind).toBe("DENY");
  const authorityFieldsAbsent: Extract<
    keyof PolicyEvaluation,
    "reservationId" | "approvalId" | "executionToken" | "signingKey"
  > extends never
    ? true
    : false = true;
  expect(authorityFieldsAbsent).toBe(true);
  expect(Object.keys(result).sort()).toEqual([
    "evaluatedAtMs",
    "intentDigest",
    "kind",
    "policyDigest",
    "policyVersion",
    "reasonCodes",
  ]);
});
