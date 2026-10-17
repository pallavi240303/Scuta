/** @file Private prepared queries with checked row codecs and statically selected table identities. */
import type { Database } from "bun:sqlite";
import { isDeepStrictEqual } from "node:util";
import { LedgerError } from "@scuta/core";
import { LEDGER_TABLE_NAMES } from "./schema.js";
import { decodeLedgerRow, encodeLedgerRow } from "./row-codecs.js";
import type { LedgerRecordKind, LedgerRecords, SqliteRow, SqliteValue } from "./row-types.js";

/** Prepared typed record access restricted to a callback-owned connection. */
export interface SqliteQueries {
  get<K extends LedgerRecordKind>(
    kind: K,
    clause: string,
    values: readonly SqliteValue[],
  ): LedgerRecords[K] | null;
  list<K extends LedgerRecordKind>(
    kind: K,
    clause: string,
    values: readonly SqliteValue[],
  ): readonly LedgerRecords[K][];
  insert<K extends LedgerRecordKind>(kind: K, record: LedgerRecords[K]): void;
  replace<K extends LedgerRecordKind>(
    kind: K,
    record: LedgerRecords[K],
    clause: string,
    values: readonly SqliteValue[],
  ): void;
  immutable<K extends LedgerRecordKind>(
    kind: K,
    record: LedgerRecords[K],
    clause: string,
    values: readonly SqliteValue[],
  ): void;
}

/** Create typed query operations without exposing raw SQL through the public store.
 * @param current - Lifetime and poisoned-transaction gate.
 * @returns Private query methods; clauses are trusted internal SQL only.
 */
export function createSqliteQueries(current: () => Database): SqliteQueries {
  const queries: SqliteQueries = {
    get(kind, clause, values) {
      const row = current()
        .query<SqliteRow, SqliteValue[]>(
          "SELECT * FROM " + LEDGER_TABLE_NAMES[kind] + " WHERE " + clause,
        )
        .get(...values);
      return row === null ? null : decodeLedgerRow(kind, row);
    },
    list(kind, clause, values) {
      const rows = current()
        .query<SqliteRow, SqliteValue[]>(
          "SELECT * FROM " + LEDGER_TABLE_NAMES[kind] + " WHERE " + clause,
        )
        .all(...values);
      return Object.freeze(rows.map((row) => decodeLedgerRow(kind, row)));
    },
    insert(kind, record) {
      const row = encodeLedgerRow(kind, record);
      const columns = Object.keys(row);
      current()
        .query(
          "INSERT INTO " +
            LEDGER_TABLE_NAMES[kind] +
            " (" +
            columns.join(",") +
            ") VALUES (" +
            columns.map(() => "?").join(",") +
            ")",
        )
        .run(...Object.values(row));
    },
    replace(kind, record, clause, values) {
      const row = encodeLedgerRow(kind, record);
      const result = current()
        .query(
          "UPDATE " +
            LEDGER_TABLE_NAMES[kind] +
            " SET " +
            Object.keys(row)
              .map((column) => column + "=?")
              .join(",") +
            " WHERE " +
            clause,
        )
        .run(...Object.values(row), ...values);
      if (result.changes !== 1) throw new LedgerError("CONFIGURATION_CONFLICT");
    },
    immutable(kind, record, clause, values) {
      const previous = queries.get(kind, clause, values);
      if (previous === null) queries.insert(kind, record);
      else if (!isDeepStrictEqual(encodeLedgerRow(kind, previous), encodeLedgerRow(kind, record)))
        throw new LedgerError("CONFIGURATION_CONFLICT");
    },
  };
  return Object.freeze(queries);
}
