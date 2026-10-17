/** @file Migration integrity and relational financial constraints on real temporary SQLite databases. */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  MAX_ATOMIC_AMOUNT,
  computeExecutionBindingDigest,
  computePayloadDigest,
} from "@scuta/core";
import { migrateLedger } from "../src/migrations.js";
import { encodeLedgerRow, decodeLedgerRow } from "../src/row-codecs.js";
import {
  createSqliteRecords,
  insertSqliteRecords,
  insertSqliteRow,
} from "./fixtures/sqlite-fixtures.js";
import { createStoreRecords } from "./store-fixtures.js";
import type { SqliteRow } from "../src/row-types.js";

test("fresh migration enables foreign keys and applies exactly once", () => {
  const db = new Database(":memory:");
  try {
    migrateLedger(db);
    migrateLedger(db);
    insertSqliteRecords(db);
    expect(
      db.query<{ count: number }, []>("SELECT count(*) AS count FROM schema_migrations").get()
        ?.count,
    ).toBe(1);
    expect(
      db
        .query<{ foreignKeys: number }, []>(
          "SELECT foreign_keys AS foreignKeys FROM pragma_foreign_keys",
        )
        .get()?.foreignKeys,
    ).toBe(1);
    expect(
      db.query<{ count: number }, []>("SELECT count(*) AS count FROM reservations").get()?.count,
    ).toBe(1);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("rows survive close, reopen and repeated migration", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "scuta-schema-"));
  const path = resolve(directory, "ledger.sqlite");
  let db = new Database(path);
  try {
    migrateLedger(db);
    insertSqliteRecords(db);
    db.close();
    db = new Database(path);
    migrateLedger(db);
    expect(
      decodeLedgerRow("budget", db.query<SqliteRow, []>("SELECT * FROM budget_accounts").get())
        .ceilingAtomic,
    ).toBe(100n);
    expect(
      db.query<{ count: number }, []>("SELECT count(*) AS count FROM executions").get()?.count,
    ).toBe(1);
  } finally {
    db.close();
    await rm(directory, { recursive: true });
  }
});

test.each(["checksum", "version", "schema"] as const)(
  "rejects altered migration %s without deleting data",
  (change) => {
    const db = new Database(":memory:");
    try {
      migrateLedger(db);
      insertSqliteRecords(db);
      if (change === "checksum")
        db.query("UPDATE schema_migrations SET checksum = ?").run("0".repeat(64));
      if (change === "version") db.exec("UPDATE schema_migrations SET version = 2");
      if (change === "schema") db.exec("ALTER TABLE budget_accounts ADD COLUMN unexpected TEXT");
      expect(() => migrateLedger(db)).toThrow("STORE_CORRUPT");
      expect(
        db.query<{ count: number }, []>("SELECT count(*) AS count FROM payment_intents").get()
          ?.count,
      ).toBe(1);
      expect(db.inTransaction).toBe(false);
    } finally {
      db.close();
    }
  },
);

test("unrelated databases are refused rather than overwritten", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE user_data (value TEXT); INSERT INTO user_data VALUES ('keep')");
    expect(() => migrateLedger(db)).toThrow("STORE_CORRUPT");
    expect(db.query<{ value: string }, []>("SELECT value FROM user_data").get()?.value).toBe(
      "keep",
    );
    expect(db.query("SELECT name FROM sqlite_schema WHERE name='schema_migrations'").all()).toEqual(
      [],
    );
  } finally {
    db.close();
  }
});

test("migration refuses a caller-owned transaction", () => {
  const db = new Database(":memory:");
  try {
    db.transaction(() => expect(() => migrateLedger(db)).toThrow("NESTED_TRANSACTION")).immediate();
    expect(db.query("SELECT name FROM sqlite_schema WHERE type='table'").all()).toEqual([]);
  } finally {
    db.close();
  }
});

test.each([-1, 51, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
  "invalid migration timeout %s is rejected before schema changes",
  (timeout) => {
    const db = new Database(":memory:");
    try {
      expect(() => migrateLedger(db, timeout)).toThrow("STORE_CORRUPT");
      expect(db.query("SELECT name FROM sqlite_schema WHERE type='table'").all()).toEqual([]);
      expect(db.inTransaction).toBe(false);
    } finally {
      db.close();
    }
  },
);

test("an unrelated sqlite-like table is not mistaken for an internal object", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE sqliteXunexpected (value TEXT)");
    expect(() => migrateLedger(db)).toThrow("STORE_CORRUPT");
    expect(db.query("SELECT name FROM sqlite_schema WHERE name='schema_migrations'").all()).toEqual(
      [],
    );
    expect(db.inTransaction).toBe(false);
  } finally {
    db.close();
  }
});

test.each(["table", "trigger"] as const)(
  "an added sqlite-like %s invalidates the ledger schema",
  (kind) => {
    const db = new Database(":memory:");
    try {
      migrateLedger(db);
      if (kind === "table") db.exec("CREATE TABLE sqliteXunexpected (value TEXT)");
      else
        db.exec(
          "CREATE TRIGGER sqliteXunexpected AFTER INSERT ON wallet_clocks BEGIN DELETE FROM wallet_clocks; END",
        );
      expect(() => migrateLedger(db)).toThrow("STORE_CORRUPT");
      expect(db.inTransaction).toBe(false);
    } finally {
      db.close();
    }
  },
);

test("a held writer causes bounded STORE_BUSY without partial schema installation", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "scuta-schema-busy-"));
  const path = resolve(directory, "ledger.sqlite");
  const writer = new Database(path);
  const contender = new Database(path);
  try {
    writer.exec("BEGIN IMMEDIATE");
    expect(() => migrateLedger(contender)).toThrow("STORE_BUSY");
    writer.exec("ROLLBACK");
    expect(contender.query("SELECT name FROM sqlite_schema WHERE type='table'").all()).toEqual([]);
    migrateLedger(contender);
  } finally {
    if (writer.inTransaction) writer.exec("ROLLBACK");
    writer.close();
    contender.close();
    await rm(directory, { recursive: true });
  }
});

test("scoped retries, reservation membership and execution claims are unique", () => {
  const db = new Database(":memory:");
  const r = createSqliteRecords();
  try {
    migrateLedger(db);
    insertSqliteRecords(db, r);
    expect(() =>
      insertSqliteRow(db, "intent", {
        ...encodeLedgerRow("intent", r.intent),
        intentId: "intent-2",
        reservationId: null,
      }),
    ).toThrow();
    expect(() =>
      insertSqliteRow(db, "reservation", {
        ...encodeLedgerRow("reservation", r.reservation),
        reservationId: "reservation-2",
        state: "RESERVED",
        executionId: null,
      }),
    ).toThrow();
    const binding = { ...r.execution.binding, nonce: "2".repeat(64) };
    expect(() =>
      insertSqliteRow(
        db,
        "execution",
        encodeLedgerRow("execution", {
          ...r.execution,
          executionId: "execution-2",
          binding,
          bindingDigest: computeExecutionBindingDigest(binding),
          payloadDigest: computePayloadDigest(binding),
        }),
      ),
    ).toThrow(
      "UNIQUE constraint failed: executions.ownerId, executions.walletId, executions.reservationId",
    );
  } finally {
    db.close();
  }
});

test("a nonce cannot repeat in a distinct otherwise coherent wallet purchase", () => {
  const db = new Database(":memory:");
  const first = createStoreRecords();
  const second = createSqliteRecords(createStoreRecords(first.scope, "2"));
  try {
    migrateLedger(db);
    insertSqliteRecords(db, createSqliteRecords(first));
    expect(() =>
      db
        .transaction(() => {
          insertSqliteRow(db, "intent", encodeLedgerRow("intent", second.intent));
          insertSqliteRow(db, "reservation", encodeLedgerRow("reservation", second.reservation));
          insertSqliteRow(db, "allocation", encodeLedgerRow("allocation", second.allocation));
          insertSqliteRow(db, "execution", encodeLedgerRow("execution", second.execution));
        })
        .immediate(),
    ).toThrow();
    expect(
      db.query<{ count: number }, []>("SELECT count(*) AS count FROM payment_intents").get()?.count,
    ).toBe(1);
  } finally {
    db.close();
  }
});

test.each(["account", "reservation", "execution"] as const)(
  "rejects unknown %s references",
  (relationship) => {
    const db = new Database(":memory:");
    const r = createSqliteRecords();
    try {
      migrateLedger(db);
      insertSqliteRecords(db, r);
      expect(() =>
        db
          .transaction(() => {
            if (relationship === "account")
              insertSqliteRow(db, "allocation", {
                ...encodeLedgerRow("allocation", r.allocation),
                accountId: "missing",
              });
            if (relationship === "reservation")
              insertSqliteRow(db, "allocation", {
                ...encodeLedgerRow("allocation", r.allocation),
                reservationId: "missing",
              });
            if (relationship === "execution")
              insertSqliteRow(db, "observation", {
                ...encodeLedgerRow("observation", r.observation),
                evidenceId: "other-evidence",
                executionId: "missing",
              });
          })
          .immediate(),
      ).toThrow();
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  },
);

test.each(["0", "9007199254740993", MAX_ATOMIC_AMOUNT.toString()])(
  "stores exact budget text %s",
  (amount) => {
    const db = new Database(":memory:");
    const r = createSqliteRecords();
    try {
      migrateLedger(db);
      insertSqliteRow(db, "wallet", encodeLedgerRow("wallet", r.wallet));
      insertSqliteRow(
        db,
        "budget",
        encodeLedgerRow("budget", { ...r.budget, ceilingAtomic: BigInt(amount) }),
      );
      const row = db.query<SqliteRow, []>("SELECT * FROM budget_accounts").get();
      expect(row?.ceilingAtomic).toBe(amount);
      expect(decodeLedgerRow("budget", row).ceilingAtomic).toBe(BigInt(amount));
    } finally {
      db.close();
    }
  },
);

test.each(["01", "-1", "1e3", "1.5", (MAX_ATOMIC_AMOUNT + 1n).toString()])(
  "rejects malformed budget text %s",
  (amount) => {
    const db = new Database(":memory:");
    const r = createSqliteRecords();
    try {
      migrateLedger(db);
      insertSqliteRow(db, "wallet", encodeLedgerRow("wallet", r.wallet));
      expect(() =>
        insertSqliteRow(db, "budget", {
          ...encodeLedgerRow("budget", r.budget),
          ceilingAtomic: amount,
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  },
);

test("bigint driver metadata is checked before safe conversion while money remains text", () => {
  const db = new Database(":memory:", { safeIntegers: true });
  const r = createSqliteRecords();
  try {
    migrateLedger(db);
    insertSqliteRow(db, "wallet", encodeLedgerRow("wallet", r.wallet));
    insertSqliteRow(
      db,
      "budget",
      encodeLedgerRow("budget", { ...r.budget, ceilingAtomic: 9007199254740993n }),
    );
    const row = db.query<Record<string, unknown>, []>("SELECT * FROM budget_accounts").get();
    expect(row?.revision).toBe(1n);
    expect(row?.ceilingAtomic).toBe("9007199254740993");
    expect(decodeLedgerRow("budget", row).ceilingAtomic).toBe(9007199254740993n);
    expect(() =>
      decodeLedgerRow("budget", { ...row, revision: BigInt(Number.MAX_SAFE_INTEGER) + 1n }),
    ).toThrow("STORE_CORRUPT");
  } finally {
    db.close();
  }
});

test("wallet namespaces permit identical local purchase IDs and nonces in different wallets", () => {
  const db = new Database(":memory:");
  const first = createStoreRecords();
  const second = createSqliteRecords(createStoreRecords({ ...first.scope, walletId: "wallet-2" }));
  try {
    migrateLedger(db);
    insertSqliteRecords(db, createSqliteRecords(first));
    insertSqliteRecords(db, second);
    expect(
      db.query<{ count: number }, []>("SELECT count(*) AS count FROM reservation_allocations").get()
        ?.count,
    ).toBe(2);
    const row = db
      .query<SqliteRow, []>("SELECT * FROM payment_intents WHERE walletId='wallet-2'")
      .get();
    expect(decodeLedgerRow("intent", row).scope.walletId).toBe("wallet-2");
  } finally {
    db.close();
  }
});
