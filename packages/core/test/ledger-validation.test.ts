/** @file Ledger wire boundaries reject ambiguous values and copy trusted configuration before freezing. */
import { expect, test } from "bun:test";
import { MAX_ATOMIC_AMOUNT } from "../src/amount.js";
import {
  validateBudgetAccount,
  validateExecutionBinding,
  validateLedgerObservation,
  validateWalletConfiguration,
} from "../src/ledger-validation.js";
import {
  createBudgetAccount,
  createExecutionBinding,
  createWalletConfiguration,
} from "./ledger-fixtures.js";

test("validates wallet configuration and rejects missing or unknown authority fields", () => {
  const raw = createWalletConfiguration();
  const parsed = validateWalletConfiguration(raw);
  expect(parsed.reservationTtlMs).toBe(60_000);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(() => validateWalletConfiguration({ ...raw, reservationTtlMs: 0 })).toThrow();
  expect(() => validateWalletConfiguration({ ...raw, extraAuthority: true })).toThrow();
  const missing: Record<string, unknown> = { ...raw };
  delete missing.signerId;
  expect(() => validateWalletConfiguration(missing)).toThrow();
});
test("parses zero and full-range budget ceilings without floating-point conversion", () => {
  const account = createBudgetAccount();
  for (const [wire, expected] of [
    ["0", 0n],
    ["9007199254740993", 9007199254740993n],
    [MAX_ATOMIC_AMOUNT.toString(), MAX_ATOMIC_AMOUNT],
  ] as const)
    expect(validateBudgetAccount({ ...account, ceilingAtomic: wire }).ceilingAtomic).toBe(expected);
  for (const ceilingAtomic of ["00", "-1", "1.0", 1, (MAX_ATOMIC_AMOUNT + 1n).toString()])
    expect(() => validateBudgetAccount({ ...account, ceilingAtomic })).toThrow();
  expect(() =>
    validateBudgetAccount({
      ...account,
      ceilingAtomic: "100",
      scope: { ...account.scope, agentId: "agent-1" },
    }),
  ).toThrow();
});

test("validates explicit agent and delegation membership without accepting extra labels", () => {
  const raw = { ...createBudgetAccount(), ceilingAtomic: "100" };
  for (const scope of [
    { kind: "AGENT", ownerId: "owner-1", walletId: "wallet-1", agentId: "agent-1" },
    {
      kind: "DELEGATION",
      ownerId: "owner-1",
      walletId: "wallet-1",
      agentId: "agent-1",
      delegationId: "delegation-1",
    },
  ] as const) {
    const account = validateBudgetAccount({ ...raw, scope });
    expect(account.scope.kind).toBe(scope.kind);
    expect(account.scope).not.toBe(scope);
    expect(Object.isFrozen(account.scope)).toBe(true);
  }
  for (const change of [
    { revision: 0 },
    { windowMs: 0 },
    { scope: { kind: "UNKNOWN" } },
    {
      scope: {
        kind: "AGENT",
        ownerId: "owner-1",
        walletId: "wallet-1",
        agentId: "agent-1",
        delegationId: "delegation-1",
      },
    },
  ])
    expect(() => validateBudgetAccount({ ...raw, ...change })).toThrow();
});
test("copies execution scope and validates bounded payload and financial identity", () => {
  const raw = createExecutionBinding();
  const parsed = validateExecutionBinding(raw);
  expect(parsed.amountAtomic).toBe(70n);
  expect(Object.isFrozen(parsed.scope)).toBe(true);
  expect(parsed.scope).not.toBe(raw.scope);
  for (const change of [
    { amountAtomic: "0" },
    { nonce: "B".repeat(64) },
    { payloadBase64: "cGF5\n" },
    { payloadBase64: "" },
    { payloadBase64: Buffer.alloc(16_385).toString("base64") },
    { validBeforeMs: raw.validAfterMs },
    { validAfterMs: NaN },
    { scope: { ...raw.scope, admin: true } },
  ])
    expect(() => validateExecutionBinding({ ...raw, ...change })).toThrow();
  expect(
    validateExecutionBinding(
      createExecutionBinding({ payloadBase64: Buffer.alloc(16_384).toString("base64") }),
    ).payloadBase64.length,
  ).toBeGreaterThan(0);
});
test("normalizes reconciliation labels without trusting agent assertions or extra fields", () => {
  const raw = {
    evidenceId: "evidence-1",
    executionId: "execution-1",
    bindingDigest: "a".repeat(64),
    kind: "SETTLED",
    evidenceRef: "mock:receipt-1",
  };
  expect(validateLedgerObservation(raw).kind).toBe("SETTLED");
  for (const change of [
    { kind: "FAILED" },
    { bindingDigest: "a".repeat(63) },
    { evidenceRef: "\nsecret" },
    { evidenceRef: "x".repeat(257) },
    { verified: true },
  ])
    expect(() => validateLedgerObservation({ ...raw, ...change })).toThrow();
});
