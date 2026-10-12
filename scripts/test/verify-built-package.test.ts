/** @file Verify a built consumer succeeds and a missing emitted entry fails visibly. */
import { expect, test } from "bun:test";
import { verifyBuiltPackage } from "../verify-built-package.js";

test("imports the emitted public core and evaluates a permitted mock purchase", async () => {
  const results = await verifyBuiltPackage();
  expect(results.map((result) => result.kind)).toEqual(["ALLOW", "REQUIRE_APPROVAL", "DENY"]);
});

test("rejects a missing build entry rather than falling back to source", async () => {
  const failure: unknown = await verifyBuiltPackage(
    new URL("../../packages/core/dist/absent-entry.js", import.meta.url),
  ).catch((error: unknown) => error);
  expect(typeof failure).toBe("object");
  expect(String(failure)).toContain("Cannot find module");
});

test("rejects a module with incomplete public exports", async () => {
  const failure: unknown = await verifyBuiltPackage(
    new URL("../../apps/example/test/incomplete-package.ts", import.meta.url),
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure instanceof Error ? failure.message : "").toBe("Missing built public export");
});
