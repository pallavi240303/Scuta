/** @file File-backed SQLite transaction, snapshot, rollback and bounded-contention guarantees. */
import { afterEach, expect, test } from "bun:test";
import { Database, SQLiteError } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { LedgerError, type LedgerStore, type LedgerTransaction } from "@scuta/core";
import { openSqliteStore } from "../src/sqlite-store.js";
import { openLedgerDatabase, retrySqliteBusy } from "../src/sqlite-connection.js";
import { defineStoreContract } from "./store-contract.js";
import { createChanges, createInitialChanges, createStoreRecords } from "./store-fixtures.js";
import { createSqliteRecords } from "./fixtures/sqlite-fixtures.js";
import { encodeLedgerRow } from "../src/row-codecs.js";

const directories: string[] = [];
const stores: LedgerStore[] = [];
const connections: Database[] = [];

/** Allocate one task-owned database path, cleaned only after all its connections close.
 * @returns A unique local file path.
 */
function databasePath(): string {
  const directory = mkdtempSync(resolve(tmpdir(), "scuta-transactions-"));
  directories.push(directory);
  return resolve(directory, "ledger.sqlite");
}

/** Track a real store so failed assertions cannot leak its connection.
 * @param path - Shared or fresh task-owned database file.
 * @returns The public transaction port, without driver access.
 */
function createStore(path = databasePath()): LedgerStore {
  const store = openSqliteStore({ path });
  stores.push(store);
  return store;
}

/** Track a separate diagnostic or competing SQLite connection.
 * @param path - Existing task-owned file.
 * @returns A real connection owned by this test.
 */
function connect(path: string): Database {
  const connection = new Database(path);
  connections.push(connection);
  return connection;
}

afterEach(() => {
  for (const connection of connections.splice(0)) {
    if (connection.inTransaction) connection.exec("ROLLBACK");
    connection.close();
  }
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

defineStoreContract("sqlite", createStore);

test("owned connections establish WAL, FULL durability and foreign-key enforcement", () => {
  const db = openLedgerDatabase({ path: databasePath(), busyTimeoutMs: 7, maxAttempts: 2 });
  connections.push(db);
  expect(db.query("SELECT journal_mode AS journalMode FROM pragma_journal_mode").get()).toEqual({
    journalMode: "wal",
  });
  expect(db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2n });
  expect(db.query("SELECT foreign_keys AS foreignKeys FROM pragma_foreign_keys").get()).toEqual({
    foreignKeys: 1n,
  });
  expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 7n });
  expect(() => db.exec("INSERT INTO wallet_clocks VALUES ('owner','missing',0,'{}')")).toThrow();
});

test.each([
  { timeout: 0, expected: 0n },
  { timeout: 7, expected: 7n },
  { timeout: null, expected: 50n },
])(
  "startup preserves timeout $expected at every migration lock attempt",
  ({ timeout, expected }) => {
    const path = databasePath();
    createStore(path);
    const writer = connect(path);
    writer.exec("BEGIN IMMEDIATE");
    const original = Object.getOwnPropertyDescriptor(Database.prototype, "transaction");
    if (!original) throw new Error("missing driver transaction");
    const transaction: unknown = original.value;
    if (typeof transaction !== "function") throw new Error("invalid driver transaction");
    const observed: bigint[] = [];
    Object.defineProperty(Database.prototype, "transaction", {
      ...original,
      /** Observe the real connection setting immediately before its migration lock attempt.
       * @param operation - Opaque callback forwarded unchanged to the real driver.
       * @returns The genuine transaction wrapper, unchanged.
       */
      value: function observeMigration(this: Database, operation: unknown): unknown {
        const row = this.query<{ timeout: bigint }, []>("PRAGMA busy_timeout").get();
        if (!row) throw new Error("missing connection timeout");
        observed.push(row.timeout);
        return Reflect.apply(transaction, this, [operation]);
      },
    });
    try {
      const options = timeout === null ? {} : { busyTimeoutMs: timeout };
      expect(() => openSqliteStore({ path, ...options, maxAttempts: 2 })).toThrow("STORE_BUSY");
    } finally {
      Object.defineProperty(Database.prototype, "transaction", original);
    }
    expect(observed).toEqual([expected, expected]);
    expect(writer.inTransaction).toBe(true);
  },
);

test.each([
  { busyTimeoutMs: -1 },
  { busyTimeoutMs: 51 },
  { busyTimeoutMs: 0.5 },
  { maxAttempts: 0 },
  { maxAttempts: 4 },
  { maxAttempts: Number.NaN },
])("invalid connection bounds fail before creating a usable store: %j", (options) => {
  expect(() => openSqliteStore({ path: databasePath(), ...options })).toThrow("STORE_CORRUPT");
});

test("a memory-only path cannot silently downgrade the file-backed durability contract", () => {
  expect(() => openSqliteStore({ path: ":memory:" })).toThrow("STORE_CORRUPT");
});

test("close and reopen preserve a hold, its decision and exact budget ceiling", () => {
  const path = databasePath();
  const first = createStore(path);
  const r = createStoreRecords();
  first.transaction((tx) => tx.apply(createInitialChanges(r)));
  first.transaction((tx) =>
    tx.apply(
      createChanges({
        budgets: [
          {
            account: { ...r.budget, revision: 2, ceilingAtomic: 9007199254740993n },
            expectedRevision: 1,
          },
        ],
      }),
    ),
  );
  first.close();
  const second = createStore(path);
  second.read((tx) => {
    expect(tx.getReservation(r.scope, "reservation-1")?.state).toBe("RESERVED");
    expect(tx.getIntent(r.scope, "intent-1")?.decision.kind).toBe("ALLOW");
    expect(tx.getBudget(r.wallet, "wallet-budget")?.ceilingAtomic).toBe(9007199254740993n);
    expect(tx.getAllocations(r.wallet, ["wallet-budget"], 0)).toHaveLength(1);
  });
});

test("throwing after financial, event and outbox writes leaves all three tables empty", () => {
  const path = databasePath();
  const store = createStore(path);
  const records = createStoreRecords();
  const complete = createSqliteRecords(records);
  expect(() =>
    store.transaction((tx) => {
      tx.apply(createInitialChanges(records));
      tx.apply(
        createChanges({
          events: [complete.event],
          outbox: [{ record: complete.outbox, expectedState: null, expectedClaimToken: null }],
        }),
      );
      throw new Error("abort entire purchase");
    }),
  ).toThrow("abort entire purchase");
  const db = connect(path);
  for (const table of ["payment_intents", "decision_events", "outbox_events"])
    expect(db.query("SELECT count(*) AS count FROM " + table).get()).toEqual({ count: 0 });
});

test("write ownership is acquired before the callback reads authoritative state", () => {
  const path = databasePath();
  const store = createStore(path);
  const competitor = connect(path);
  competitor.exec("PRAGMA busy_timeout=0");
  store.transaction(() => {
    expect(() => competitor.exec("BEGIN IMMEDIATE")).toThrow();
    expect(competitor.inTransaction).toBe(false);
  });
  competitor.exec("BEGIN IMMEDIATE; ROLLBACK");
});

test("a read callback sees one snapshot while another connection commits", () => {
  const path = databasePath();
  const reader = createStore(path);
  const writer = createStore(path);
  const r = createStoreRecords();
  writer.transaction((tx) => tx.apply(createInitialChanges(r)));
  reader.read((tx) => {
    expect(tx.getBudget(r.wallet, "wallet-budget")?.revision).toBe(1);
    writer.transaction((other) =>
      other.apply(
        createChanges({
          budgets: [
            { account: { ...r.budget, ceilingAtomic: 10n, revision: 2 }, expectedRevision: 1 },
          ],
        }),
      ),
    );
    expect(tx.getBudget(r.wallet, "wallet-budget")?.revision).toBe(1);
  });
  expect(reader.read((tx) => tx.getBudget(r.wallet, "wallet-budget")?.revision)).toBe(2);
});

test("contended writes fail closed without entering or partially running a callback", () => {
  const path = databasePath();
  const store = createStore(path);
  const writer = connect(path);
  writer.exec("BEGIN IMMEDIATE");
  let entered = 0;
  expect(() =>
    store.transaction(() => {
      entered++;
    }),
  ).toThrow("STORE_BUSY");
  expect(entered).toBe(0);
  writer.exec("ROLLBACK");
  expect(store.transaction(() => "recovered")).toBe("recovered");
});

test.each([1, 2, 3])(
  "real busy failures stop after exactly %i complete attempts",
  (maxAttempts) => {
    const path = databasePath();
    createStore(path);
    const writer = connect(path);
    const contender = connect(path);
    contender.exec("PRAGMA busy_timeout=0");
    writer.exec("BEGIN IMMEDIATE");
    let attempts = 0;
    expect(() =>
      retrySqliteBusy(() => {
        attempts++;
        contender.exec("BEGIN IMMEDIATE");
      }, maxAttempts),
    ).toThrow("STORE_BUSY");
    expect(attempts).toBe(maxAttempts);
    expect(contender.inTransaction).toBe(false);
  },
);

test("callback errors are neither redacted nor retried as driver contention", () => {
  const store = createStore();
  let attempts = 0;
  const error = new LedgerError("STORE_BUSY");
  expect(() =>
    store.transaction(() => {
      attempts++;
      throw error;
    }),
  ).toThrow(error);
  expect(attempts).toBe(1);
  expect(store.read(() => "usable")).toBe("usable");
});

test("closing one store preserves committed WAL state owned by another live connection", () => {
  const path = databasePath();
  const first = createStore(path);
  const second = createStore(path);
  const r = createStoreRecords();
  first.transaction((tx) => tx.apply(createInitialChanges(r)));
  first.close();
  expect(second.read((tx) => tx.getIntent(r.scope, "intent-1")?.intent.amountAtomic)).toBe(70n);
  second.transaction((tx) =>
    tx.apply(
      createChanges({
        budgets: [
          { account: { ...r.budget, revision: 2, ceilingAtomic: 20n }, expectedRevision: 1 },
        ],
      }),
    ),
  );
  second.close();
  const reopened = createStore(path);
  expect(reopened.read((tx) => tx.getBudget(r.wallet, "wallet-budget")?.revision)).toBe(2);
});

test("corrupt persisted payloads fail closed instead of returning an empty balance", () => {
  const path = databasePath();
  const store = createStore(path);
  const r = createStoreRecords();
  store.transaction((tx) => tx.apply(createInitialChanges(r)));
  const db = connect(path);
  db.exec("UPDATE budget_accounts SET payload='{}'");
  expect(() => store.read((tx) => tx.getBudget(r.wallet, "wallet-budget"))).toThrow(
    "STORE_CORRUPT",
  );
  expect(() => store.read((tx) => tx.getBudgets(r.scope))).toThrow("STORE_CORRUPT");
});

test("an active pointer with missing history is corruption, not absent configuration", () => {
  const path = databasePath();
  const store = createStore(path);
  const r = createStoreRecords();
  store.transaction((tx) => tx.apply(createInitialChanges(r)));
  const db = connect(path);
  db.exec("PRAGMA foreign_keys=OFF; DELETE FROM policy_snapshots");
  expect(() => store.read((tx) => tx.getPolicy(r.scope))).toThrow("STORE_CORRUPT");
});

test("SQLite insertion errors are redacted and deterministic conflicts are not retried", () => {
  const store = createStore();
  const r = createStoreRecords();
  store.transaction((tx) => tx.apply(createInitialChanges(r)));
  let entered = 0;
  expect(() =>
    store.transaction((tx) => {
      entered++;
      tx.apply(createChanges({ intents: [{ ...r.intent, intentId: "other-intent" }] }));
    }),
  ).toThrow("CONFIGURATION_CONFLICT");
  expect(entered).toBe(1);
  expect(store.read((tx) => tx.getIntent(r.scope, "other-intent"))).toBeNull();
});

test("a later connection observes revision fences instead of accepting a stale budget update", () => {
  const path = databasePath();
  const first = createStore(path);
  const second = createStore(path);
  const r = createStoreRecords();
  first.transaction((tx) => tx.apply(createInitialChanges(r)));
  second.transaction((tx) =>
    tx.apply(
      createChanges({
        budgets: [
          { account: { ...r.budget, revision: 2, ceilingAtomic: 30n }, expectedRevision: 1 },
        ],
      }),
    ),
  );
  expect(() =>
    first.transaction((tx) =>
      tx.apply(
        createChanges({
          budgets: [
            { account: { ...r.budget, revision: 2, ceilingAtomic: 90n }, expectedRevision: 1 },
          ],
        }),
      ),
    ),
  ).toThrow("CONFIGURATION_CONFLICT");
  expect(first.read((tx) => tx.getBudget(r.wallet, "wallet-budget")?.ceilingAtomic)).toBe(30n);
});

test("raw relational metadata cannot substitute a different canonical record", () => {
  const path = databasePath();
  const store = createStore(path);
  const r = createStoreRecords();
  store.transaction((tx) => tx.apply(createInitialChanges(r)));
  const row = encodeLedgerRow("budget", { ...r.budget, ceilingAtomic: 5n });
  const db = connect(path);
  db.query("UPDATE budget_accounts SET payload=?").run(row.payload ?? null);
  expect(() => store.read((tx) => tx.getBudget(r.wallet, "wallet-budget"))).toThrow(
    "STORE_CORRUPT",
  );
});

test.each([false, true])(
  "a busy apply retries the whole rolled-back batch, even when caught=%s",
  (caught) => {
    const path = databasePath();
    const store = createStore(path);
    const writer = connect(path);
    const contender = connect(path);
    contender.exec("PRAGMA busy_timeout=0");
    writer.exec("BEGIN IMMEDIATE");
    let busy: unknown = null;
    try {
      contender.exec("BEGIN IMMEDIATE");
    } catch (error) {
      busy = error;
    }
    writer.exec("ROLLBACK");
    if (!(busy instanceof SQLiteError)) throw new Error("fixture did not observe real contention");
    const original = Object.getOwnPropertyDescriptor(Database.prototype, "query");
    if (!original || typeof original.value !== "function") throw new Error("missing driver method");
    const query: unknown = original.value;
    if (typeof query !== "function") throw new Error("invalid driver method");
    const r = createStoreRecords();
    let injected = false;
    let attempts = 0;
    const handles: LedgerTransaction[] = [];
    Object.defineProperty(Database.prototype, "query", {
      ...original,
      /** Inject one real busy exception at a driver write boundary, leaving all other operations real.
       * @param sql - Prepared SQL issued by the adapter.
       * @returns The genuine driver statement unless this is the selected fault.
       */
      value: function queryWithFault(this: Database, sql: string): unknown {
        if (!injected && sql.startsWith("INSERT INTO wallet_clocks")) {
          injected = true;
          throw busy;
        }
        return Reflect.apply(query, this, [sql]);
      },
    });
    try {
      expect(
        store.transaction((tx) => {
          attempts++;
          handles.push(tx);
          tx.apply(createInitialChanges(r));
          try {
            tx.apply(
              createChanges({
                clocks: [
                  { record: { wallet: r.wallet, highWaterMs: 1 }, expectedHighWaterMs: null },
                ],
              }),
            );
          } catch (error) {
            expect(error).toBeInstanceOf(LedgerError);
            if (!caught) throw error;
          }
          return "committed";
        }),
      ).toBe("committed");
      expect(attempts).toBe(2);
      expect(() => handles[0]?.getWallet(r.wallet)).toThrow("TRANSACTION_CLOSED");
      expect(store.read((tx) => tx.getClock(r.wallet))?.highWaterMs).toBe(1);
      expect(contender.query("SELECT count(*) AS count FROM payment_intents").get()).toEqual({
        count: 1,
      });
    } finally {
      Object.defineProperty(Database.prototype, "query", original);
    }
  },
);
