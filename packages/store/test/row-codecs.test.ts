/** @file Persisted record codecs must reject corrupt financial state instead of fabricating safe balances. */
import { expect, test } from "bun:test";
import { MAX_ATOMIC_AMOUNT, type IntentRecord } from "@scuta/core";
import { encodeLedgerRow, decodeLedgerRow } from "../src/row-codecs.js";
import { createSqliteRecords } from "./fixtures/sqlite-fixtures.js";
import { LEDGER_TABLE_NAMES } from "../src/schema.js";
import type { LedgerRecordKind } from "../src/row-types.js";

test.each(Object.keys(LEDGER_TABLE_NAMES) as LedgerRecordKind[])(
  "round-trips immutable %s records",
  (kind) => {
    const r = createSqliteRecords();
    const row = encodeLedgerRow(kind, r[kind]);
    const restored = decodeLedgerRow(kind, row);
    expect(restored).toEqual(r[kind]);
    expect(restored).not.toBe(r[kind]);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(typeof row.payload).toBe("string");
  },
);
test.each([9007199254740993n, MAX_ATOMIC_AMOUNT])("preserves exact budget value %s", (amount) => {
  const row = encodeLedgerRow("budget", { ...createSqliteRecords().budget, ceilingAtomic: amount });
  expect(row.ceilingAtomic).toBe(amount.toString());
  expect(decodeLedgerRow("budget", row).ceilingAtomic).toBe(amount);
});
test.each([
  { ceilingAtomic: "01" },
  { ceilingAtomic: "-1" },
  { ceilingAtomic: 100 },
  { ceilingAtomic: (MAX_ATOMIC_AMOUNT + 1n).toString() },
  { windowMs: -1 },
  { windowMs: Number.MAX_SAFE_INTEGER + 1 },
  { revision: "1" },
  { accountId: "wrong" },
  { ownerId: "another-owner" },
  { payload: "{" },
  { payload: "null" },
  { unexpected: true },
])("rejects corrupted budget metadata or payload %p", (change) => {
  expect(() =>
    decodeLedgerRow("budget", {
      ...encodeLedgerRow("budget", createSqliteRecords().budget),
      ...change,
    }),
  ).toThrow("STORE_CORRUPT");
});
test("payload changes cannot hide behind unchanged indexed metadata", () => {
  const row = encodeLedgerRow("budget", createSqliteRecords().budget);
  const payload = row.payload;
  if (typeof payload !== "string") throw new Error("Fixture payload missing");
  expect(() =>
    decodeLedgerRow("budget", {
      ...row,
      payload: payload.replace('"ceilingAtomic":"100"', '"ceilingAtomic":"99"'),
    }),
  ).toThrow("STORE_CORRUPT");
  expect(() =>
    decodeLedgerRow("budget", {
      ...row,
      payload: payload.replace('"ceilingAtomic":"100"', '"ceilingAtomic":100'),
    }),
  ).toThrow("STORE_CORRUPT");
  expect(() => decodeLedgerRow("budget", { ...row, payload: " " + payload })).toThrow(
    "STORE_CORRUPT",
  );
});
test("invalid states and execution digest mismatches are rejected", () => {
  const r = createSqliteRecords();
  expect(() =>
    decodeLedgerRow("reservation", {
      ...encodeLedgerRow("reservation", r.reservation),
      state: "UNKNOWN",
    }),
  ).toThrow("STORE_CORRUPT");
  expect(() =>
    decodeLedgerRow("execution", {
      ...encodeLedgerRow("execution", r.execution),
      bindingDigest: "0".repeat(64),
    }),
  ).toThrow("STORE_CORRUPT");
  expect(() =>
    encodeLedgerRow("execution", { ...r.execution, payloadDigest: "0".repeat(64) }),
  ).toThrow("STORE_CORRUPT");
});
test("decoder failures redact payloads and reject getters without invoking them", () => {
  const row = {
    ...encodeLedgerRow("wallet", createSqliteRecords().wallet),
    payload: "PRIVATE_SECRET",
  };
  try {
    decodeLedgerRow("wallet", row);
    throw new Error("Expected failure");
  } catch (error) {
    expect(error instanceof Error ? error.message : "").toBe("STORE_CORRUPT");
  }
  let invoked = false;
  Object.defineProperty(row, "payload", {
    get() {
      invoked = true;
      return "PRIVATE_SECRET";
    },
  });
  expect(() => decodeLedgerRow("wallet", row)).toThrow("STORE_CORRUPT");
  expect(invoked).toBe(false);
});

test("unknown or inherited record-kind names cannot select a codec", () => {
  const wallet = createSqliteRecords().wallet;
  expect(() => {
    Reflect.apply(encodeLedgerRow, null, ["toString", wallet]);
  }).toThrow("STORE_CORRUPT");
  expect(() => {
    Reflect.apply(decodeLedgerRow, null, ["constructor", {}]);
  }).toThrow("STORE_CORRUPT");
});

test("budget-denied intents preserve static ALLOW provenance and remain hold-free", () => {
  const r = createSqliteRecords();
  const denied: IntentRecord = {
    ...r.intent,
    reservationId: null,
    decision: { ...r.intent.decision, kind: "DENY", ledgerReasons: ["BUDGET_EXCEEDED"] },
  };
  const decoded = decodeLedgerRow("intent", encodeLedgerRow("intent", denied));
  expect(decoded.decision.kind).toBe("DENY");
  expect(decoded.decision.evaluation.kind).toBe("ALLOW");
  expect(decoded.reservationId).toBeNull();
});

test("wallet-scoped writer projections accept configuration objects but persist only ownership labels", () => {
  const r = createSqliteRecords();
  const record = { ...r.event, wallet: r.wallet };
  const decoded = decodeLedgerRow("event", encodeLedgerRow("event", record));
  expect(decoded.wallet).toEqual({ ownerId: "owner-1", walletId: "wallet-1" });
  expect(Object.isFrozen(decoded.wallet)).toBe(true);
});

test("noncanonical duplicate keys and numeric money inside payloads are rejected", () => {
  const row = encodeLedgerRow("budget", createSqliteRecords().budget);
  const payload = row.payload;
  if (typeof payload !== "string") throw new Error("Fixture payload missing");
  expect(() =>
    decodeLedgerRow("budget", {
      ...row,
      payload: payload.replace(
        '"ceilingAtomic":"100"',
        '"ceilingAtomic":"50","ceilingAtomic":"100"',
      ),
    }),
  ).toThrow("STORE_CORRUPT");
});
