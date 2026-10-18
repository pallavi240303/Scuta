/** @file Real memory/SQLite coordinator fixtures with deterministic host time and task-owned files. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { LedgerResult, LedgerStore, BudgetAccountWire, PolicyWire } from "@scuta/core";
import { createLedger } from "../../../core/src/index.js";
import { createMemoryStore, openSqliteStore } from "../../src/index.js";
import { createStoreRecords } from "../store-fixtures.js";
import { NOW_MS } from "../../../core/test/fixtures.js";

/** Actual adapters exercised by every coordinator scenario. */
export const STORE_KINDS = ["memory", "sqlite"] as const;
/** Real adapter selection, not a mocked storage implementation. */
export type StoreKind = (typeof STORE_KINDS)[number];
/** Optional trusted configuration or a deliberately unconfigured ledger. */
export interface LedgerFixtureOptions {
  readonly initialize?: boolean;
  readonly budgets?: readonly BudgetAccountWire[];
  readonly policy?: PolicyWire;
}

/** Require an explicit successful result without hiding the conflicting reason.
 * @param result - Actual coordinator result.
 * @returns Its typed successful value.
 */
export function requireSuccess<T>(result: LedgerResult<T>): T {
  if (!result.ok) throw new Error("Expected success, received " + result.reason);
  return result.value;
}

/** Open a real adapter and initialize its coordinator using deterministic mock records.
 * @param kind - Actual adapter to exercise.
 * @param options - Configuration variation or empty-ledger selection.
 * @returns Owned test fixture with an explicit cleanup method.
 */
export function createLedgerFixture(kind: StoreKind, options: LedgerFixtureOptions = {}) {
  const records = createStoreRecords();
  const directory = kind === "sqlite" ? mkdtempSync(resolve(tmpdir(), "scuta-admission-")) : null;
  const path = directory ? resolve(directory, "ledger.sqlite") : null;
  const store: LedgerStore = path ? openSqliteStore({ path }) : createMemoryStore();
  const time = { nowMs: NOW_MS };
  let nextId = 0;
  const createId = () => "generated-" + ++nextId;
  const ledger = createLedger({ store, now: () => time.nowMs, createId });
  const budgets: readonly BudgetAccountWire[] = options.budgets ?? [
    {
      ...records.budget,
      ceilingAtomic: records.budget.ceilingAtomic.toString(),
    },
  ];
  try {
    if (options.initialize !== false) {
      requireSuccess(ledger.configureWallet(records.wallet, budgets));
      requireSuccess(ledger.activatePolicy(options.policy ?? records.policy.wire));
      requireSuccess(ledger.activateDelegation(records.delegation.wire));
    }
  } catch (error) {
    store.close();
    if (directory) rmSync(directory, { recursive: true });
    throw error;
  }
  return {
    ...records,
    ledger,
    store,
    time,
    createId,
    path,
    budgets,
    close() {
      store.close();
      if (directory) rmSync(directory, { recursive: true });
    },
  };
}
