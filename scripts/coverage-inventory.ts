/** @file Enumerate core sources and verify that loaded-file LCOV has not silently omitted a module. */
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Recursively discover regular files while ignoring links and generated/dependency directories.
 *
 * @param directory - Existing directory to traverse.
 * @returns Sorted absolute file paths; no file contents are read.
 * @throws {Error} Rejects if a directory cannot be read during traversal.
 */
async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (
        entry.isDirectory() &&
        !["node_modules", "dist", "coverage", ".superpowers"].includes(entry.name)
      )
        return listFiles(path);
      return entry.isFile() ? [path] : [];
    }),
  );
  return groups.flat().sort();
}

/**
 * Discover TypeScript implementation files under the core source directory.
 *
 * @param projectRoot - Repository root used to locate `packages/core/src`.
 * @returns Sorted absolute source paths, excluding test files and declaration files; may be empty.
 * @throws {Error} Rejects if the source directory or a traversed subdirectory cannot be read.
 */
export async function listCoreSources(projectRoot: string): Promise<readonly string[]> {
  return (await listFiles(resolve(projectRoot, "packages/core/src"))).filter(
    (path) => path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".d.ts"),
  );
}

/**
 * Verify that LCOV names every discovered core implementation file.
 *
 * Presence alone does not establish a coverage percentage or security guarantee.
 *
 * @param projectRoot - Root against which relative LCOV `SF:` paths are resolved.
 * @param sources - Implementation paths discovered by `listCoreSources`.
 * @param lcov - LCOV text whose source-file records will be checked.
 * @returns Nothing when every source is present in the report.
 * @throws {Error} If the source inventory is empty or any source is missing from LCOV.
 */
export function assertCoverageInventory(
  projectRoot: string,
  sources: readonly string[],
  lcov: string,
): void {
  if (sources.length === 0) throw new Error("No core source files discovered");
  const covered = new Set(
    lcov
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("SF:"))
      .map((line) => resolve(projectRoot, line.slice(3))),
  );
  const missing = sources.filter((source) => !covered.has(resolve(source)));
  if (missing.length > 0)
    throw new Error(`Coverage omitted core source files: ${missing.join(", ")}`);
}

/**
 * Discover separate test files under packages, apps and scripts.
 *
 * @param projectRoot - Repository root containing all three supported directories.
 * @returns Sorted absolute paths ending in `.test.ts`; the list is never empty on success.
 * @throws {Error} Rejects if traversal fails or no test files are discovered.
 */
export async function listTestFiles(projectRoot: string): Promise<readonly string[]> {
  const files = (
    await Promise.all(
      ["packages", "apps", "scripts"].map((directory) =>
        listFiles(resolve(projectRoot, directory)),
      ),
    )
  )
    .flat()
    .filter((path) => path.endsWith(".test.ts"))
    .sort();
  if (files.length === 0) throw new Error("No test files discovered");
  return files;
}

if (import.meta.main) {
  const projectRoot = resolve(import.meta.dirname, "..");
  const sources = await listCoreSources(projectRoot);
  assertCoverageInventory(
    projectRoot,
    sources,
    await readFile(resolve(projectRoot, "coverage/lcov.info"), "utf8"),
  );
  console.log(`Coverage inventory verified: ${sources.length} core source files.`);
}
