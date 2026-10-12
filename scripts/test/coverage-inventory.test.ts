/** @file Coverage and discovery checks must expose unvisited files and refuse empty test suites. */
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { assertCoverageInventory, listCoreSources, listTestFiles } from "../coverage-inventory.js";

test("discovers the actual core sources and test files", async () => {
  const projectRoot = resolve(import.meta.dirname, "../..");
  expect((await listCoreSources(projectRoot)).map((source) => source.split("/").at(-1))).toEqual([
    "amount.ts",
    "budget.ts",
    "canonicalization.ts",
    "delegation.ts",
    "evaluate-policy.ts",
    "execution-binding.ts",
    "index.ts",
    "ledger-contracts.ts",
    "ledger-validation.ts",
    "payment-intent.ts",
    "policy.ts",
    "reservation.ts",
    "validation.ts",
  ]);
  expect((await listTestFiles(projectRoot)).length).toBeGreaterThanOrEqual(10);
});

test("coverage inventory accepts relative and absolute LCOV paths and rejects omissions", () => {
  const projectRoot = resolve(import.meta.dirname, "../..");
  const source = resolve(projectRoot, "packages/core/src/amount.ts");
  expect(() =>
    assertCoverageInventory(
      projectRoot,
      [source],
      "SF:packages/core/src/amount.ts\nend_of_record\n",
    ),
  ).not.toThrow();
  expect(() =>
    assertCoverageInventory(projectRoot, [source], `SF:${source}\nend_of_record\n`),
  ).not.toThrow();
  expect(() => assertCoverageInventory(projectRoot, [source], "")).toThrow(/omitted/u);
  expect(() => assertCoverageInventory(projectRoot, [], "")).toThrow(/No core/u);
});

test("an unvisited nested source is inventoried and zero tests are rejected", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "scuta-inventory-"));
  try {
    await mkdir(resolve(projectRoot, "packages/core/src/nested"), { recursive: true });
    await mkdir(resolve(projectRoot, "apps"));
    await mkdir(resolve(projectRoot, "scripts"));
    const unvisited = resolve(projectRoot, "packages/core/src/nested/unvisited.ts");
    await writeFile(
      unvisited,
      "/** @file Unvisited fixture. */\nexport function unvisited() { return 1; }\n",
    );
    await writeFile(resolve(projectRoot, "packages/core/src/nested/ignored.test.ts"), "");
    await writeFile(resolve(projectRoot, "packages/core/src/nested/types.d.ts"), "");
    expect(await listCoreSources(projectRoot)).toEqual([unvisited]);
    expect(() => assertCoverageInventory(projectRoot, [unvisited], "")).toThrow(/omitted/u);
    expect(await listTestFiles(projectRoot)).toHaveLength(1);
    await rm(resolve(projectRoot, "packages/core/src/nested/ignored.test.ts"));
    const failure: unknown = await listTestFiles(projectRoot).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "").toMatch(/No test/u);
  } finally {
    await rm(projectRoot, { recursive: true });
  }
});
