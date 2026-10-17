/** @file File-backed SQLite transaction port, without payment or agent-facing authority. */
import { SQLiteError } from "bun:sqlite";
import {
  LedgerError,
  type LedgerStore,
  type LedgerReadView,
  type LedgerTransaction,
} from "@scuta/core";
import {
  openLedgerDatabase,
  retrySqliteBusy,
  normalizeSqliteError,
  isSqliteBusy,
  type SqliteStoreOptions,
} from "./sqlite-connection.js";
import { snapshot } from "./memory-state.js";
import { createSqliteQueries } from "./sqlite-queries.js";
import { createSqliteReadView } from "./sqlite-read.js";
import { applySqliteChanges } from "./sqlite-write.js";

/** Open the authoritative local store.
 * @param options - Local database path and bounded contention settings.
 * @returns A synchronous driver-free store port.
 */
export function openSqliteStore(options: SqliteStoreOptions): LedgerStore {
  const database = openLedgerDatabase(options);
  const attempts = options.maxAttempts ?? 3;
  let closed = false;
  let active = false;

  /** Execute one complete synchronous attempt with a fresh lifetime-owned handle.
   * @param operation - Trusted callback with no external side effects.
   * @param writable - Whether to acquire write ownership and expose apply.
   * @returns Callback result after successful completion.
   */
  function attempt<T>(
    operation: (view: LedgerReadView | LedgerTransaction) => T,
    writable: boolean,
  ): T {
    let open = true;
    let failed: { readonly error: unknown } | null = null;
    const retryFailure: { error: SQLiteError | null } = { error: null };

    /** Gate every database operation on callback ownership and transaction health.
     * @returns The private connection during this attempt only.
     */
    function current() {
      if (!open) throw new LedgerError("TRANSACTION_CLOSED");
      if (failed) throw failed.error;
      return database;
    }
    const queries = createSqliteQueries(current);
    const read = createSqliteReadView(queries, current);
    const view = writable
      ? Object.freeze({
          ...read,
          apply(changes) {
            current();
            try {
              applySqliteChanges(queries, read, snapshot(changes));
            } catch (error) {
              if (error instanceof SQLiteError && isSqliteBusy(error)) retryFailure.error = error;
              failed = {
                error: error instanceof SQLiteError ? normalizeSqliteError(error) : error,
              };
              throw failed.error;
            }
          },
        } satisfies LedgerTransaction)
      : read;
    try {
      if (!writable) database.exec("PRAGMA query_only=ON");
      database.exec(writable ? "BEGIN IMMEDIATE" : "BEGIN DEFERRED");
      const result = operation(view);
      if (
        result !== null &&
        (typeof result === "object" || typeof result === "function") &&
        "then" in result &&
        typeof result.then === "function"
      ) {
        if (result instanceof Promise) void result.catch(() => {});
        throw new LedgerError("ASYNC_TRANSACTION");
      }
      current();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      if (database.inTransaction) database.exec("ROLLBACK");
      if (retryFailure.error !== null) throw retryFailure.error;
      throw error;
    } finally {
      open = false;
      if (!writable) database.exec("PRAGMA query_only=OFF");
    }
  }

  /** Reject closed/nested use and retry only complete driver-busy attempts.
   * @param operation - Synchronous internal callback.
   * @param writable - Whether this is a write transaction.
   * @returns Committed callback result.
   */
  function run<T>(
    operation: (view: LedgerReadView | LedgerTransaction) => T,
    writable: boolean,
  ): T {
    if (closed) throw new LedgerError("TRANSACTION_CLOSED");
    if (active) throw new LedgerError("NESTED_TRANSACTION");
    active = true;
    try {
      return retrySqliteBusy(() => attempt(operation, writable), attempts);
    } catch (error) {
      if (error instanceof SQLiteError) throw normalizeSqliteError(error);
      throw error;
    } finally {
      active = false;
    }
  }

  return Object.freeze({
    transaction<T>(operation: (tx: LedgerTransaction) => T): T {
      return run((view) => {
        if (!("apply" in view)) throw new LedgerError("STORE_CORRUPT");
        return operation(view);
      }, true);
    },
    read<T>(operation: (tx: LedgerReadView) => T): T {
      return run(operation, false);
    },
    close() {
      if (active) throw new LedgerError("NESTED_TRANSACTION");
      if (!closed) {
        database.close();
        closed = true;
      }
    },
  });
}
