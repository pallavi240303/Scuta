/** @file Versioned semantic execution and observation digests, not portable authorization proofs. */
import type { ExecutionBinding, LedgerObservation } from "./ledger-contracts.js";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

/** Hash previously validated unsigned payload bytes, not its base64 representation.
 * @param binding - Parsed bounded execution binding; this helper does not revalidate it.
 * @returns Lowercase SHA-256 digest of the decoded payload.
 */
export function computePayloadDigest(binding: ExecutionBinding): string {
  return createHash("sha256").update(Buffer.from(binding.payloadBase64, "base64")).digest("hex");
}

/** Hash a parsed execution binding.
 * @param binding - Previously validated unsigned execution metadata.
 * @returns A lowercase SHA-256 semantic digest.
 */
export function computeExecutionBindingDigest(binding: ExecutionBinding): string {
  const { scope } = binding;
  return createHash("sha256")
    .update(
      JSON.stringify([
        "scuta.execution.v1",
        scope.ownerId,
        scope.walletId,
        scope.agentId,
        scope.delegationId,
        binding.reservationId,
        binding.intentDigest,
        binding.signerId,
        binding.network,
        binding.asset,
        binding.recipient,
        binding.amountAtomic.toString(),
        binding.nonce,
        binding.validAfterMs.toString(),
        binding.validBeforeMs.toString(),
        binding.payloadBase64,
      ]),
    )
    .digest("hex");
}
/** Hash parsed evidence content.
 * @param observation - Previously validated normalized labels.
 * @returns A lowercase SHA-256 content digest.
 */
export function computeLedgerObservationDigest(observation: LedgerObservation): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "scuta.observation.v1",
        observation.evidenceId,
        observation.executionId,
        observation.bindingDigest,
        observation.kind,
        observation.evidenceRef,
      ]),
    )
    .digest("hex");
}
