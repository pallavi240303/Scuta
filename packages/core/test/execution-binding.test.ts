/** @file Semantic execution and evidence digests bind every reviewed identity field, not signatures. */
import { expect, test } from "bun:test";
import {
  computeExecutionBindingDigest,
  computeLedgerObservationDigest,
  computePayloadDigest,
} from "../src/execution-binding.js";
import { validateExecutionBinding, validateLedgerObservation } from "../src/ledger-validation.js";
import { createExecutionBinding } from "./ledger-fixtures.js";

test("payload digest hashes decoded unsigned bytes rather than base64 text", () => {
  expect(computePayloadDigest(validateExecutionBinding(createExecutionBinding()))).toBe(
    "9350872d712a127c494d7dc35e46b0bc9e62e288239708e581dfc3a1400154a4",
  );
});

test("execution bindings are deterministic and ignore object key insertion order", () => {
  const raw = createExecutionBinding();
  const baseline = computeExecutionBindingDigest(validateExecutionBinding(raw));
  expect(baseline).toMatch(/^[a-f0-9]{64}$/u);
  expect(
    computeExecutionBindingDigest(
      validateExecutionBinding(Object.fromEntries(Object.entries(raw).reverse())),
    ),
  ).toBe(baseline);
});
test("changing any execution identity or financial field changes its digest", () => {
  const raw = createExecutionBinding();
  const baseline = computeExecutionBindingDigest(validateExecutionBinding(raw));
  for (const scopeField of ["ownerId", "walletId", "agentId", "delegationId"] as const)
    expect(
      computeExecutionBindingDigest(
        validateExecutionBinding({ ...raw, scope: { ...raw.scope, [scopeField]: "other-1" } }),
      ),
    ).not.toBe(baseline);
  for (const change of [
    { reservationId: "reservation-2" },
    { intentDigest: "c".repeat(64) },
    { signerId: "other-signer" },
    { network: "mock:other" },
    { asset: "mock:eur" },
    { recipient: "merchant:other" },
    { amountAtomic: "71" },
    { nonce: "c".repeat(64) },
    { validAfterMs: raw.validAfterMs + 1 },
    { validBeforeMs: raw.validBeforeMs - 1 },
    { payloadBase64: "cGF5Mg==" },
  ])
    expect(computeExecutionBindingDigest(validateExecutionBinding({ ...raw, ...change }))).not.toBe(
      baseline,
    );
});
test("evidence content cannot reuse identity without changing the observation digest", () => {
  const raw = {
    evidenceId: "evidence-1",
    executionId: "execution-1",
    bindingDigest: "a".repeat(64),
    kind: "SETTLED",
    evidenceRef: "mock:receipt-1",
  };
  const baseline = computeLedgerObservationDigest(validateLedgerObservation(raw));
  for (const change of [
    { evidenceId: "evidence-2" },
    { executionId: "execution-2" },
    { bindingDigest: "b".repeat(64) },
    { kind: "FINAL_NON_EXECUTION" },
    { evidenceRef: "mock:receipt-2" },
  ])
    expect(
      computeLedgerObservationDigest(validateLedgerObservation({ ...raw, ...change })),
    ).not.toBe(baseline);
});
