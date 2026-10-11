/** @file Load every core implementation module so Bun coverage includes unvisited source files. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { listCoreSources } from "./coverage-inventory.js";

for (const source of await listCoreSources(resolve(import.meta.dirname, ".."))) {
  await import(pathToFileURL(source).href);
}
