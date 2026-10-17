/** @file Load every declared implementation module so coverage includes unvisited core and store sources. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { listImplementationSources } from "./coverage-inventory.js";

for (const source of await listImplementationSources(resolve(import.meta.dirname, ".."))) {
  await import(pathToFileURL(source).href);
}
