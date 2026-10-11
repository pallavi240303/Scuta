/** @file Verify stable validation failures report a field path without embedding input secrets. */
import { expect, test } from "bun:test";
import {
  ValidationError,
  validateArray,
  validateBoolean,
  validateEnum,
  validateEvaluationTime,
  validateIdentifier,
  validateObject,
  validateProfileIdentifier,
  validateScope,
  validateTimestamp,
} from "./validation.js";
import { createScope } from "../test/fixtures.js";

test("validation errors preserve machine-readable code and path", () => {
  const error = new ValidationError("INVALID_FORMAT", "intent.amountAtomic");
  expect(error.code).toBe("INVALID_FORMAT");
  expect(error.path).toBe("intent.amountAtomic");
  expect(error.name).toBe("ValidationError");
  expect(error).toBeInstanceOf(Error);
});

test("validation messages describe location, not rejected input", () => {
  const error = new ValidationError("UNKNOWN_FIELD", "intent");
  expect(error.message).toBe("UNKNOWN_FIELD at intent");
});

test("plain null-prototype records remain valid and independent", () => {
  const record = Object.assign(Object.create(null) as Record<string, unknown>, createScope());
  const scope = validateScope(record);
  record.ownerId = "other-1";
  expect(scope.ownerId).toBe("owner-1");
  expect(Object.isFrozen(scope)).toBe(true);
});

test("shared guards report the selected field path without rejected values", () => {
  const calls = [
    () => validateIdentifier("bad secret", "scope.ownerId"),
    () => validateProfileIdentifier(42, "intent.network"),
    () => validateBoolean("true", "policy.approvalEnabled"),
    () => validateEnum("IGNORE", ["ALLOW"], "rule.action"),
    () => validateTimestamp(null, "intent.expiresAt"),
  ];
  for (const call of calls) {
    try {
      call();
      throw new Error("Expected a validation error");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      if (!(error instanceof ValidationError)) throw error;
      expect(error.message).not.toContain("secret");
      expect(error.path).toMatch(/^(scope|intent|policy|rule)\./u);
    }
  }
});

test("dense arrays are copied and decorated or nonstandard arrays are rejected", () => {
  const input = ["first"];
  const parsed = validateArray(input, "items");
  input[0] = "second";
  expect(parsed).toEqual(["first"]);
  expect(() => validateArray({ length: 0 }, "items")).toThrow(ValidationError);
  expect(() => validateArray(Object.assign([], { extra: true }), "items")).toThrow(ValidationError);
  const nonstandard: unknown[] = [];
  Object.setPrototypeOf(nonstandard, null);
  expect(() => validateArray(nonstandard, "items")).toThrow(ValidationError);
});

test("bounded identifiers and explicit zero evaluation time are accepted", () => {
  expect(validateIdentifier("A".repeat(64), "id")).toHaveLength(64);
  expect(validateProfileIdentifier("a".repeat(256), "asset")).toHaveLength(256);
  expect(validateEvaluationTime(0)).toBe(0);
  expect(() => validateObject(new Date(), [], "scope")).toThrow(ValidationError);
});
