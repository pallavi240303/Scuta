/** @file Smoke verification imports compiled public exports instead of source-only development aliases. */
import type { PolicyEvaluation } from "../packages/core/dist/index.js";
import { createDemoInputs } from "../apps/example/src/static-policy-demo.js";

/**
 * Check required runtime exports and demo outcomes using an emitted package entry.
 *
 * @param entry - Module URL to import; defaults to the core's built `dist/index.js`, never its source.
 * @returns A frozen array of the three expected static evaluations.
 * @throws {Error} Rejects if import fails, required exports are absent, evaluation fails
 * or the outcomes differ from ALLOW, REQUIRE_APPROVAL and DENY.
 */
export async function verifyBuiltPackage(
  entry = new URL("../packages/core/dist/index.js", import.meta.url),
): Promise<readonly PolicyEvaluation[]> {
  const imported: unknown = await import(entry.href);
  if (typeof imported !== "object" || imported === null) throw new Error("Invalid built module");
  const core = imported as typeof import("../packages/core/dist/index.js");
  const functions = [
    "parseAtomicAmount",
    "serializeAtomicAmount",
    "ValidationError",
    "validatePaymentIntent",
    "validatePolicy",
    "validateDelegation",
    "validateDelegationScope",
    "computeIntentDigest",
    "computePolicyDigest",
    "evaluatePolicy",
  ] as const;
  if (
    functions.some((name) => typeof core[name] !== "function") ||
    typeof core.MAX_ATOMIC_AMOUNT !== "bigint"
  ) {
    throw new Error("Missing built public export");
  }
  const results = Object.freeze(createDemoInputs().map((input) => core.evaluatePolicy(input)));
  if (results.map((result) => result.kind).join(",") !== "ALLOW,REQUIRE_APPROVAL,DENY")
    throw new Error("Incorrect built policy outcomes");
  return results;
}

if (import.meta.main) {
  await verifyBuiltPackage();
  console.log("Built public package smoke check passed.");
}
