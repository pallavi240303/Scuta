/** @file Validate protected delegation snapshots before later scope and expiry evaluation. */
import { expect, test } from "bun:test";
import { createDelegation, createScope, createIntent, NOW_MS } from "./fixtures.js";
import { validateDelegation, validateDelegationScope } from "../src/delegation.js";
import { validatePaymentIntent } from "../src/payment-intent.js";
import { ValidationError } from "../src/validation.js";

test("accepts the active matching grant without mutating inputs", () => {
  const reasons = validateDelegationScope(
    validateDelegation(createDelegation()),
    createScope(),
    validatePaymentIntent(createIntent()),
    NOW_MS,
  );
  expect(reasons).toEqual([]);
  expect(Object.isFrozen(reasons)).toBe(true);
});

test.each(["ownerId", "walletId", "agentId", "delegationId"] as const)(
  "rejects mismatched delegated %s",
  (field) => {
    const delegation = validateDelegation(
      createDelegation({ scope: { ...createScope(), [field]: "other-1" } }),
    );
    expect(
      validateDelegationScope(
        delegation,
        createScope(),
        validatePaymentIntent(createIntent()),
        NOW_MS,
      ),
    ).toEqual(["SCOPE_MISMATCH"]);
  },
);

test("rejects a proposal selecting another delegation", () => {
  expect(
    validateDelegationScope(
      validateDelegation(createDelegation()),
      createScope(),
      validatePaymentIntent(createIntent({ delegationId: "other-1" })),
      NOW_MS,
    ),
  ).toEqual(["SCOPE_MISMATCH"]);
});

test.each([
  { offset: -1, reasons: [] },
  { offset: 0, reasons: ["DELEGATION_EXPIRED"] },
  { offset: 1, reasons: ["DELEGATION_EXPIRED"] },
])("checks exact grant expiry %p", ({ offset, reasons }) => {
  const delegation = validateDelegation(createDelegation());
  expect(
    validateDelegationScope(
      delegation,
      createScope(),
      validatePaymentIntent(createIntent()),
      delegation.expiresAtMs + offset,
    ),
  ).toEqual(reasons);
});

test("rejects revoked grants and absent capability in stable order", () => {
  const delegation = validateDelegation(
    createDelegation({
      scope: { ...createScope(), agentId: "other-1" },
      revoked: true,
      capabilities: [],
      expiresAt: "2026-10-10T00:00:00.000Z",
    }),
  );
  expect(
    validateDelegationScope(
      delegation,
      createScope(),
      validatePaymentIntent(createIntent()),
      NOW_MS,
    ),
  ).toEqual([
    "SCOPE_MISMATCH",
    "DELEGATION_REVOKED",
    "DELEGATION_EXPIRED",
    "CAPABILITY_NOT_DELEGATED",
  ]);
});

test.each([[], ["PAY_HTTP_RESOURCE"]].map((capabilities) => ({ capabilities })))(
  "checks requested undelegated capability %p",
  ({ capabilities }) => {
    const delegation = validateDelegation({ ...createDelegation(), capabilities });
    const intent = validatePaymentIntent(createIntent({ capability: "ARBITRARY_CALL" }));
    expect(validateDelegationScope(delegation, createScope(), intent, NOW_MS)).toEqual([
      "CAPABILITY_NOT_DELEGATED",
    ]);
  },
);

test.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "0", null])(
  "rejects invalid evaluation instant %p",
  (nowMs) => {
    expect(() =>
      validateDelegationScope(
        validateDelegation(createDelegation()),
        createScope(),
        validatePaymentIntent(createIntent()),
        nowMs as number,
      ),
    ).toThrow(ValidationError);
  },
);

test("copies active delegation with exact expiry and scope", () => {
  const delegation = validateDelegation(createDelegation());
  expect(delegation.scope).toEqual(createScope());
  expect(delegation.expiresAtMs).toBe(1791680400000);
  expect(delegation.revoked).toBe(false);
});

test("supports a valid delegation with no granted capability", () => {
  expect(validateDelegation(createDelegation({ capabilities: [] })).capabilities).toEqual([]);
});

test.each(Object.keys(createDelegation()))("rejects missing delegation field %s", (key) => {
  const raw: Record<string, unknown> = { ...createDelegation() };
  delete raw[key];
  expect(() => validateDelegation(raw)).toThrow(ValidationError);
});

test.each([
  { revoked: "false" },
  { capabilities: ["ARBITRARY_CALL"] },
  { capabilities: ["PAY_HTTP_RESOURCE", "PAY_HTTP_RESOURCE"] },
  { capabilities: "PAY_HTTP_RESOURCE" },
  { scope: { ...createScope(), ownerId: "" } },
  { scope: { ...createScope(), budget: "infinite" } },
  { expiresAt: "2026-02-30T00:00:00.000Z" },
  { schemaVersion: "2" },
  { additionalAuthority: true },
])("rejects invalid delegation %p", (change) => {
  expect(() => validateDelegation({ ...createDelegation(), ...change })).toThrow(ValidationError);
});

test("freezes copies without retaining caller-controlled scope or arrays", () => {
  const raw = {
    ...createDelegation(),
    scope: createScope(),
    capabilities: ["PAY_HTTP_RESOURCE" as const],
  };
  const delegation = validateDelegation(raw);
  raw.scope.walletId = "wallet-2";
  raw.capabilities.length = 0;
  expect(delegation.scope.walletId).toBe("wallet-1");
  expect(delegation.capabilities).toEqual(["PAY_HTTP_RESOURCE"]);
  expect(Reflect.set(delegation, "revoked", true)).toBe(false);
  expect(Reflect.set(delegation.capabilities, "0", "ARBITRARY_CALL")).toBe(false);
});
