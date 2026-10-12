/** @file Prove exact positive atomic amounts and reject ambiguous or unbounded money input. */
import { expect, test } from "bun:test";
import { parseAtomicAmount, serializeAtomicAmount } from "../src/amount.js";
import { ValidationError } from "../src/validation.js";

const maximum = "115792089237316195423570985008687907853269984665640564039457584007913129639935";

test.each(["1", "9007199254740993", maximum])("round-trips exact amount %s", (value) => {
  expect(serializeAtomicAmount(parseAtomicAmount(value))).toBe(value);
});

test("preserves values beyond JavaScript safe integer precision", () => {
  expect(parseAtomicAmount("9007199254740993")).toBe(9007199254740993n);
});

test.each([
  "0",
  "-1",
  "+1",
  "1.0",
  "1e6",
  " 1",
  "1 ",
  "1\n",
  "1\r\n",
  "1\t",
  "01",
  "",
  "١",
  "9".repeat(79),
  (BigInt(maximum) + 1n).toString(),
  1,
  null,
  undefined,
  {},
  true,
])("rejects invalid atomic amount %p", (value) => {
  expect(() => parseAtomicAmount(value)).toThrow(ValidationError);
});

test.each([0n, -1n, BigInt(maximum) + 1n])("rejects invalid serialized value %s", (value) => {
  expect(() => serializeAtomicAmount(value)).toThrow(ValidationError);
});

test("rejects unsafe runtime casts in the serializer", () => {
  expect(() => serializeAtomicAmount(1 as unknown as bigint)).toThrow(ValidationError);
});

test("generated positive integer round trips remain exact", () => {
  for (let index = 1n; index <= 128n; index += 1n) {
    const value = (index << 160n) + index;
    expect(parseAtomicAmount(serializeAtomicAmount(value))).toBe(value);
  }
});
