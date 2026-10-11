/** @file Verify the source entry exposes only documented static operations, not internal validation shortcuts. */
import { expect, test } from "bun:test";
import * as core from "./index.js";

test("exports the supported runtime surface without execution credentials or internal guards", () => {
  expect(Object.keys(core).sort()).toEqual(
    [
      "MAX_ATOMIC_AMOUNT",
      "ValidationError",
      "computeIntentDigest",
      "computePolicyDigest",
      "evaluatePolicy",
      "parseAtomicAmount",
      "serializeAtomicAmount",
      "validateDelegation",
      "validateDelegationScope",
      "validatePaymentIntent",
      "validatePolicy",
    ].sort(),
  );
  expect(core.serializeAtomicAmount(core.parseAtomicAmount("9007199254740993"))).toBe(
    "9007199254740993",
  );
});
