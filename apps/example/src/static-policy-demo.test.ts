/** @file Consumer-facing demo outcomes must explain static policy without claiming execution authority. */
import { expect, test } from "bun:test";
import { runStaticPolicyDemo } from "./static-policy-demo.js";

test("demonstrates allow, approval and hard-deny outcomes in fixed order", () => {
  const results = runStaticPolicyDemo();
  expect(results.map((result) => result.kind)).toEqual(["ALLOW", "REQUIRE_APPROVAL", "DENY"]);
  expect(results.map((result) => result.reasonCodes)).toEqual([
    ["WITHIN_STATIC_POLICY"],
    ["AUTONOMOUS_LIMIT_EXCEEDED"],
    ["HARD_TRANSACTION_LIMIT_EXCEEDED"],
  ]);
  expect(results).toHaveLength(3);
  for (const result of results) {
    expect(result.policyDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.intentDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result).not.toHaveProperty("reservationId");
    expect(result).not.toHaveProperty("approvalId");
    expect(result).not.toHaveProperty("executionToken");
  }
});

test("the demo is repeatable and its result collection is immutable", () => {
  const results = runStaticPolicyDemo();
  expect(results).toEqual(runStaticPolicyDemo());
  expect(Object.isFrozen(results)).toBe(true);
});
