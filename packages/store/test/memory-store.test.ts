/** @file Run the shared contract against the actual memory transaction adapter. */
import { defineStoreContract } from "./store-contract.js";
import { createMemoryStore } from "../src/memory-store.js";

defineStoreContract("memory", createMemoryStore);
