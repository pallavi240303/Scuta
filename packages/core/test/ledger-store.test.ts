/** @file Store failures expose fixed machine-readable categories without retaining record data. */
import { expect, test } from "bun:test";
import { LedgerError } from "../src/ledger-store.js";

test("ledger errors retain only their fixed category and standard error identity", () => {
  const error = new LedgerError("STORE_CORRUPT");
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe("STORE_CORRUPT");
  expect(error.message).toBe("STORE_CORRUPT");
  expect(error.name).toBe("LedgerError");
});
