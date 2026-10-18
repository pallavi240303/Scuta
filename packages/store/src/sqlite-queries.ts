/** @file Store-only Drizzle queries with typed predicates, checked row codecs and no caller SQL. */
import type { Database } from "bun:sqlite";
import { isDeepStrictEqual } from "node:util";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { LedgerError } from "@scuta/core";
import { DRIZZLE_TABLES } from "./drizzle-schema.js";
import { decodeLedgerRow, encodeLedgerRow } from "./row-codecs.js";
import type { LedgerRecordKind, LedgerRecords } from "./row-types.js";

/** Predicate bound to the columns of exactly one stored record kind. */
export type RecordPredicate<K extends LedgerRecordKind> = (
  table: (typeof DRIZZLE_TABLES)[K],
) => SQL | undefined;
/** Typed ordering and optional result bound, never embedded SQL text. */
export interface RecordQueryOptions<K extends LedgerRecordKind> {
  readonly orderBy?: (table: (typeof DRIZZLE_TABLES)[K]) => readonly (SQL | AnySQLiteColumn)[];
  readonly limit?: number;
}
/** Checked record access confined to a callback-owned connection. */
export interface SqliteQueries {
  get<K extends LedgerRecordKind>(
    kind: K,
    predicate: RecordPredicate<K>,
    options?: RecordQueryOptions<K>,
  ): LedgerRecords[K] | null;
  list<K extends LedgerRecordKind>(
    kind: K,
    predicate: RecordPredicate<K>,
    options?: RecordQueryOptions<K>,
  ): readonly LedgerRecords[K][];
  insert<K extends LedgerRecordKind>(kind: K, record: LedgerRecords[K]): void;
  replace<K extends LedgerRecordKind>(
    kind: K,
    record: LedgerRecords[K],
    predicate: RecordPredicate<K>,
  ): void;
  immutable<K extends LedgerRecordKind>(
    kind: K,
    record: LedgerRecords[K],
    predicate: RecordPredicate<K>,
  ): void;
}

/** Bind Drizzle to the lifetime-owned Bun connection without replacing native transaction control.
 * @param current - Callback and poisoned-transaction gate.
 * @returns Typed store-private operations using synchronous Drizzle execution.
 */
export function createSqliteQueries(current: () => Database): SqliteQueries {
  const database = drizzle(current());
  const queries: SqliteQueries = {
    get(kind, predicate, options) {
      return queries.list(kind, predicate, { ...options, limit: 1 })[0] ?? null;
    },
    list(kind, predicate, options) {
      current();
      const table = DRIZZLE_TABLES[kind];
      let query = database.select().from(table).where(predicate(table)).$dynamic();
      if (options?.orderBy) query = query.orderBy(...options.orderBy(table));
      if (options?.limit !== undefined) query = query.limit(options.limit);
      return Object.freeze(query.all().map((row) => decodeLedgerRow(kind, row)));
    },
    insert(kind, record) {
      current();
      database.insert(DRIZZLE_TABLES[kind]).values(encodeLedgerRow(kind, record)).run();
    },
    replace(kind, record, predicate) {
      current();
      const table = DRIZZLE_TABLES[kind];
      const result = database
        .update(table)
        .set(encodeLedgerRow(kind, record))
        .where(predicate(table))
        .returning({ ownerId: table.ownerId })
        .all();
      if (result.length !== 1) throw new LedgerError("CONFIGURATION_CONFLICT");
    },
    immutable(kind, record, predicate) {
      const previous = queries.get(kind, predicate);
      if (previous === null) queries.insert(kind, record);
      else if (!isDeepStrictEqual(encodeLedgerRow(kind, previous), encodeLedgerRow(kind, record)))
        throw new LedgerError("CONFIGURATION_CONFLICT");
    },
  };
  return Object.freeze(queries);
}
