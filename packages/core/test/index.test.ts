/** @file Verify the source entry exposes only documented policy and ledger helpers, not internal validation shortcuts. */
import { expect, test } from "bun:test";
import * as core from "../src/index.js";

test("exports the supported runtime surface without execution credentials or internal guards", () => {
  expect(Object.keys(core).sort()).toEqual(
    [
      "MAX_ATOMIC_AMOUNT",
      "ValidationError",
      "LedgerError",
      "computeIntentDigest",
      "computePolicyDigest",
      "evaluatePolicy",
      "createLedger",
      "parseAtomicAmount",
      "serializeAtomicAmount",
      "validateDelegation",
      "validateDelegationScope",
      "validatePaymentIntent",
      "validatePolicy",
      "computeBudgetExposure",
      "computeReservationExpiry",
      "canTransitionReservation",
      "validateWalletConfiguration",
      "validateBudgetAccount",
      "validateExecutionBinding",
      "validateLedgerObservation",
      "computeExecutionBindingDigest",
      "computeLedgerObservationDigest",
      "computePayloadDigest",
    ].sort(),
  );
  expect(core.serializeAtomicAmount(core.parseAtomicAmount("9007199254740993"))).toBe(
    "9007199254740993",
  );
});
