/** @file Keep owner policy immutable and reject inconsistent caps, rule sets and review settings. */
import { expect, test } from "bun:test";
import { createPolicy, createScope } from "../test/fixtures.js";
import { validatePolicy } from "./policy.js";
import { ValidationError } from "./validation.js";

test.each(["hardTransactionLimitAtomic", "autonomousTransactionLimitAtomic"] as const)(
  "reports the exact policy amount field %s without exposing its value",
  (field) => {
    try {
      validatePolicy({ ...createPolicy(), [field]: "private-invalid-value" });
      throw new Error("Expected invalid policy amount to be rejected");
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      expect(error.code).toBe("INVALID_FORMAT");
      expect(error.path).toBe(`policy.${field}`);
      expect(error.message).not.toContain("private-invalid-value");
    }
  },
);

test("validates caps and creates a stable policy digest", () => {
  const policy = validatePolicy(createPolicy());
  expect(policy.hardTransactionLimitAtomic).toBe(20000000n);
  expect(policy.autonomousTransactionLimitAtomic).toBe(10000000n);
  expect(policy.digest).toMatch(/^[a-f0-9]{64}$/u);
  expect(validatePolicy(createPolicy()).digest).toBe(policy.digest);
});

test("permits zero autonomous spending without permitting a zero hard ceiling", () => {
  expect(
    validatePolicy(createPolicy({ autonomousTransactionLimitAtomic: "0" }))
      .autonomousTransactionLimitAtomic,
  ).toBe(0n);
  expect(() => validatePolicy(createPolicy({ hardTransactionLimitAtomic: "0" }))).toThrow(
    ValidationError,
  );
});

test.each(Object.keys(createPolicy()))("rejects missing policy field %s", (key) => {
  const raw: Record<string, unknown> = { ...createPolicy() };
  delete raw[key];
  expect(() => validatePolicy(raw)).toThrow(ValidationError);
});

test.each([
  { autonomousTransactionLimitAtomic: "20000001" },
  { autonomousTransactionLimitAtomic: "00" },
  { hardTransactionLimitAtomic: "9".repeat(79) },
  { approvalEnabled: "true" },
  { version: "" },
  { defaultRecipientAction: "IGNORE" },
  { recipientRules: [{ recipient: "bad space", action: "ALLOW" }] },
  { recipientRules: [{ recipient: "merchant:weather", action: "UNKNOWN" }] },
  { recipientRules: [{ recipient: "merchant:weather", action: "ALLOW", override: true }] },
  {
    recipientRules: [
      { recipient: "merchant:weather", action: "ALLOW" },
      { recipient: "merchant:weather", action: "DENY" },
    ],
  },
  {
    recipientRules: Array.from(new Array<undefined>(101).keys(), (index) => ({
      recipient: `merchant:${index}`,
      action: "ALLOW",
    })),
  },
  { scope: { ...createScope(), ownerId: "owner\n" } },
  { digest: "forged" },
  { network: "" },
])("rejects malformed owner policy %p", (change) => {
  expect(() => validatePolicy({ ...createPolicy(), ...change })).toThrow(ValidationError);
});

test("copies nested owner scope and recipient rules before freezing", () => {
  const raw = {
    ...createPolicy(),
    scope: createScope(),
    recipientRules: [{ recipient: "merchant:weather", action: "ALLOW" as const }],
  };
  const policy = validatePolicy(raw);
  raw.scope.ownerId = "owner-2";
  raw.recipientRules[0] = { recipient: "merchant:evil", action: "ALLOW" };
  expect(policy.scope.ownerId).toBe("owner-1");
  expect(policy.recipientRules).toEqual([{ recipient: "merchant:weather", action: "ALLOW" }]);
  expect(Reflect.set(policy.scope, "ownerId", "owner-2")).toBe(false);
  expect(
    Reflect.set(policy.recipientRules, "0", { recipient: "merchant:evil", action: "ALLOW" }),
  ).toBe(false);
  const rule = policy.recipientRules[0];
  if (!rule) throw new Error("Expected the fixture rule");
  expect(Reflect.set(rule, "action", "DENY")).toBe(false);
});

test("recipient rule ordering is semantic-set ordering, not policy identity", () => {
  const rules = [
    { recipient: "merchant:weather", action: "ALLOW" as const },
    { recipient: "merchant:news", action: "REQUIRE_APPROVAL" as const },
  ];
  expect(validatePolicy(createPolicy({ recipientRules: rules })).digest).toBe(
    validatePolicy(createPolicy({ recipientRules: [...rules].reverse() })).digest,
  );
});

test("rule changes and limit changes create different policy digests", () => {
  const digest = validatePolicy(createPolicy()).digest;
  expect(validatePolicy(createPolicy({ hardTransactionLimitAtomic: "21000000" })).digest).not.toBe(
    digest,
  );
  expect(validatePolicy(createPolicy({ version: "2" })).digest).not.toBe(digest);
});

test("rejects accessor entries and sparse rule arrays", () => {
  let reads = 0;
  const rules = Object.defineProperty([], "0", {
    get() {
      reads += 1;
      return { recipient: "merchant:weather", action: "ALLOW" };
    },
  });
  expect(() => validatePolicy({ ...createPolicy(), recipientRules: rules })).toThrow(
    ValidationError,
  );
  expect(reads).toBe(0);
  expect(() => validatePolicy({ ...createPolicy(), recipientRules: new Array(1) })).toThrow(
    ValidationError,
  );
});
