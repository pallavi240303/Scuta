/** @file Exercise the purchase boundary without accepting ambiguous wire values or hidden authority. */
import { expect, test } from "bun:test";
import { createIntent } from "./fixtures.js";
import { validatePaymentIntent } from "../src/payment-intent.js";
import { ValidationError } from "../src/validation.js";

test("reports the intent amount path without exposing the invalid value", () => {
  try {
    validatePaymentIntent({ ...createIntent(), amountAtomic: "private-invalid-value" });
    throw new Error("Expected invalid intent amount to be rejected");
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    expect(error.path).toBe("intent.amountAtomic");
    expect(error.message).not.toContain("private-invalid-value");
  }
});

test("POST exposes a required body digest after method narrowing", () => {
  const intent = validatePaymentIntent(
    createIntent({ method: "POST", bodyDigest: "a".repeat(64) }),
  );
  if (intent.method !== "POST") throw new Error("Expected a POST purchase");
  const digest: string = intent.bodyDigest;
  expect(digest).toBe("a".repeat(64));
});

test("GET omits its body digest instead of retaining an undefined property", () => {
  expect(Object.hasOwn(validatePaymentIntent(createIntent()), "bodyDigest")).toBe(false);
});

test("parses exact amount, normalized HTTPS URL and UTC expiry", () => {
  const intent = validatePaymentIntent(
    createIntent({ resourceUrl: "https://EXAMPLE.test:443/weather" }),
  );
  expect(intent.amountAtomic).toBe(1000000n);
  expect(intent.resourceUrl).toBe("https://example.test/weather");
  expect(intent.expiresAtMs).toBe(1791677100000);
});

test.each(Object.keys(createIntent()))("rejects missing required intent field %s", (key) => {
  const raw: Record<string, unknown> = { ...createIntent() };
  delete raw[key];
  expect(() => validatePaymentIntent(raw)).toThrow(ValidationError);
});

test.each([
  { amountAtomic: 1 },
  { schemaVersion: "2" },
  { idempotencyKey: "x".repeat(65) },
  { delegationId: "agent\n" },
  { recipient: "merchant:é" },
  { asset: "" },
  { network: "mock:local\n" },
  { capability: "PAY\n" },
  { expiresAt: "2026-02-30T00:00:00.000Z" },
  { expiresAt: "2026-10-11T00:05:00Z" },
  { expiresAt: "2026-10-11T00:05:00.000+00:00" },
  { expiresAt: "2026-10-11T00:05:00.000Z\n" },
  { resourceUrl: "http://example.test/weather" },
  { resourceUrl: "https://user:secret@example.test/weather" },
  { resourceUrl: "https://example.test/#x" },
  { resourceUrl: "not-a-url" },
  { resourceUrl: "https://example.test/" + "x".repeat(2048) },
  { method: "DELETE" },
  { bodyDigest: "a".repeat(64) },
  { traceId: 7 },
  { amountAtomic: "0" },
  { unknownAuthority: true },
  { resourceUrl: " https://example.test/" },
  { resourceUrl: "https://example.test/a\tb" },
  { resourceUrl: "https://example.test/a\nb" },
  { resourceUrl: "https://example.test/a\u007fb" },
  { resourceUrl: "https://example.test/#" },
  { recipient: "a".repeat(257) },
])("rejects malformed purchase fields %p", (change) => {
  expect(() => validatePaymentIntent({ ...createIntent(), ...change })).toThrow(ValidationError);
});

test("accepts a bound POST body digest", () => {
  const intent = validatePaymentIntent(
    createIntent({ method: "POST", bodyDigest: "a".repeat(64) }),
  );
  expect(intent.bodyDigest).toBe("a".repeat(64));
});

test.each([undefined, "a".repeat(63), "A".repeat(64), "a".repeat(64) + "\n"])(
  "rejects missing or noncanonical POST body digest %p",
  (bodyDigest) => {
    expect(() => validatePaymentIntent({ ...createIntent(), method: "POST", bodyDigest })).toThrow(
      ValidationError,
    );
  },
);

test("keeps well-formed unsupported profile identifiers for policy denial", () => {
  expect(
    validatePaymentIntent(createIntent({ asset: "mock:other", capability: "ARBITRARY_CALL" }))
      .asset,
  ).toBe("mock:other");
});

test("does not normalize query ordering into a different purchase", () => {
  const intent = validatePaymentIntent(
    createIntent({ resourceUrl: "https://example.test/?b=2&a=1" }),
  );
  expect(intent.resourceUrl).toBe("https://example.test/?b=2&a=1");
});

test("copies and freezes the validated intent", () => {
  const raw = { ...createIntent() };
  const intent = validatePaymentIntent(raw);
  raw.amountAtomic = "2000000";
  expect(intent.amountAtomic).toBe(1000000n);
  expect(Reflect.set(intent, "amountAtomic", 7n)).toBe(false);
});

test("rejects accessors without invoking them", () => {
  let reads = 0;
  const raw = Object.defineProperty({ ...createIntent() }, "recipient", {
    get() {
      reads += 1;
      return "merchant:weather";
    },
  });
  expect(() => validatePaymentIntent(raw)).toThrow(ValidationError);
  expect(reads).toBe(0);
});

test("rejects inherited fields and custom prototypes", () => {
  const raw = Object.create(createIntent()) as unknown;
  expect(() => validatePaymentIntent(raw)).toThrow(ValidationError);
});

test("rejects unknown symbol and nonenumerable fields", () => {
  const raw = { ...createIntent(), [Symbol("authority")]: true };
  expect(() => validatePaymentIntent(raw)).toThrow(ValidationError);
  expect(() =>
    validatePaymentIntent(Object.defineProperty({ ...createIntent() }, "hidden", { value: true })),
  ).toThrow(ValidationError);
});

test.each([null, [], "intent", 42, true].map((raw) => ({ raw })))(
  "rejects non-object proposal %p",
  ({ raw }) => {
    expect(() => validatePaymentIntent(raw)).toThrow(ValidationError);
  },
);
