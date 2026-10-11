/** @file Guard test discovery and propagate the Bun runner exit status without masking failures. */
import { resolve } from "node:path";
import { listTestFiles } from "./coverage-inventory.js";

const projectRoot = resolve(import.meta.dirname, "..");
const files = await listTestFiles(projectRoot);
const coverage = process.argv.slice(2).includes("--coverage");
console.log(`Discovered ${files.length} test files.`);
const runner = Bun.spawn(
  [
    process.execPath,
    "test",
    ...files,
    ...(coverage
      ? ["--coverage", "--preload", resolve(projectRoot, "scripts/coverage-preload.ts")]
      : []),
  ],
  { cwd: projectRoot, stdout: "inherit", stderr: "inherit" },
);
process.exitCode = await runner.exited;
