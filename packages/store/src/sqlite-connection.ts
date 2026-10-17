/** @file Owned SQLite connections and bounded contention handling. */
import { Database, SQLiteError } from "bun:sqlite";
import { LedgerError } from "@scuta/core";
import { migrateLedger } from "./migrations.js";

/** Local database path and bounded overrides; no remote or ephemeral deployment support. */
export interface SqliteStoreOptions {
  readonly path: string;
  readonly busyTimeoutMs?: number;
  readonly maxAttempts?: number;
}

/** Open and migrate one checked connection.
 * @param options - Path and bounded contention configuration.
 * @returns An owned private driver connection.
 */
export function openLedgerDatabase(options: SqliteStoreOptions): Database {
  const timeout = options.busyTimeoutMs ?? 50;
  const attempts = options.maxAttempts ?? 3;
  if (
    typeof options.path !== "string" ||
    options.path.length === 0 ||
    options.path.includes("\0") ||
    options.path === ":memory:" ||
    !Number.isInteger(timeout) ||
    timeout < 0 ||
    timeout > 50 ||
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > 3
  )
    throw new LedgerError("STORE_CORRUPT");
  let database: Database | null = null;
  try {
    database = new Database(options.path, { create: true, strict: true, safeIntegers: true });
    const db = database;
    db.exec("PRAGMA busy_timeout=" + timeout);
    retrySqliteBusy(
      () => {
        db.exec("PRAGMA journal_mode=WAL");
        const mode = db
          .query<{ journalMode: string }, []>(
            "SELECT journal_mode AS journalMode FROM pragma_journal_mode",
          )
          .get();
        if (mode?.journalMode !== "wal") throw new LedgerError("STORE_CORRUPT");
        db.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
        migrateLedger(db, timeout);
      },
      attempts,
      true,
    );
    db.exec("PRAGMA busy_timeout=" + timeout);
    const settings = db
      .query<{ synchronous: bigint; foreignKeys: bigint; timeout: bigint }, []>(
        "SELECT (SELECT synchronous FROM pragma_synchronous) AS synchronous, " +
          "(SELECT foreign_keys FROM pragma_foreign_keys) AS foreignKeys, " +
          "(SELECT timeout FROM pragma_busy_timeout) AS timeout",
      )
      .get();
    if (
      settings?.synchronous !== 2n ||
      settings.foreignKeys !== 1n ||
      settings.timeout !== BigInt(timeout)
    )
      throw new LedgerError("STORE_CORRUPT");
    return db;
  } catch (error) {
    database?.close();
    if (error instanceof LedgerError) throw error;
    throw normalizeSqliteError(error);
  }
}

/** Retry only real SQLite busy failures within a fixed attempt bound.
 * @param operation - Complete synchronous attempt.
 * @param maxAttempts - One through three total attempts.
 * @param migration - Whether a known redacted migration busy error can be retried during initialization.
 * @returns A successful attempt result.
 */
export function retrySqliteBusy<T>(operation: () => T, maxAttempts: number, migration = false): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      const busy =
        isSqliteBusy(error) ||
        (migration && error instanceof LedgerError && error.code === "STORE_BUSY");
      if (!busy) throw error;
      if (attempt >= maxAttempts) throw new LedgerError("STORE_BUSY");
    }
  }
}

/** Recognize driver contention without trusting callback-generated error messages.
 * @param error - Caught driver or callback exception.
 * @returns Whether SQLite identified a busy or locked database.
 */
export function isSqliteBusy(error: unknown): boolean {
  return (
    error instanceof SQLiteError &&
    (error.code?.startsWith("SQLITE_BUSY") === true ||
      error.code?.startsWith("SQLITE_LOCKED") === true)
  );
}

/** Redact driver diagnostics while keeping deterministic uniqueness conflicts distinguishable.
 * @param error - Driver failure, never returned directly.
 * @returns Stable ledger error without SQL or record contents.
 */
export function normalizeSqliteError(error: unknown): LedgerError {
  if (error instanceof LedgerError) return error;
  if (isSqliteBusy(error)) return new LedgerError("STORE_BUSY");
  if (
    error instanceof SQLiteError &&
    (error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.code === "SQLITE_CONSTRAINT_PRIMARYKEY")
  )
    return new LedgerError("CONFIGURATION_CONFLICT");
  return new LedgerError("STORE_CORRUPT");
}
