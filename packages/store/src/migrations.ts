/** @file Checked SQLite migrations; no financial authorization or deployment adapter is provided here. */
import { SQLiteError, type Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { LedgerError } from "@scuta/core";
import { LEDGER_SCHEMA } from "./schema.js";

/** Database schema inspection result, decoded independently from driver type assertions. */
type SchemaRow = Readonly<Record<string, unknown>>;

/** Read only application objects; generated SQLite indexes are not migration definitions.
 * @param database - Connection inside this migration transaction.
 * @returns Actual schema rows for comparison with reviewed SQL.
 */
function readSchema(database: Database): readonly SchemaRow[] {
  return database
    .query<SchemaRow, []>(
      "SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
    )
    .all();
}

/** Require exact known schema definitions without silently recreating missing objects.
 * @param database - Connection inside the immediate transaction.
 * @throws {LedgerError} If an object was added, removed or altered.
 */
function verifySchema(database: Database): void {
  const actual = readSchema(database);
  if (actual.length !== LEDGER_SCHEMA.length) throw new LedgerError("STORE_CORRUPT");
  for (const definition of LEDGER_SCHEMA) {
    const row = actual.find((candidate) => candidate.name === definition.name);
    if (!row || row.type !== definition.type || row.sql !== definition.sql)
      throw new LedgerError("STORE_CORRUPT");
  }
  if (database.query("PRAGMA foreign_key_check").all().length !== 0)
    throw new LedgerError("STORE_CORRUPT");
}

/** Apply known migrations under an immediate transaction and reject incompatible databases.
 * @param database - Caller-owned SQLite connection outside a transaction.
 * @param busyTimeoutMs - Integer lock wait from zero to fifty milliseconds, defaulting to fifty.
 * @throws {LedgerError} If schema/history is incompatible, nested, or unavailable.
 */
export function migrateLedger(database: Database, busyTimeoutMs = 50): void {
  if (database.inTransaction) throw new LedgerError("NESTED_TRANSACTION");
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 50)
    throw new LedgerError("STORE_CORRUPT");
  const checksum = createHash("sha256")
    .update(LEDGER_SCHEMA.map((definition) => definition.sql).join(";\n"))
    .digest("hex");
  try {
    database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=" + busyTimeoutMs);
    const foreignKeys = database
      .query<SchemaRow, []>("SELECT foreign_keys AS enabled FROM pragma_foreign_keys")
      .get()?.enabled;
    if (foreignKeys !== 1 && foreignKeys !== 1n) throw new LedgerError("STORE_CORRUPT");
    database
      .transaction(() => {
        const objects = readSchema(database);
        const hasHistory = objects.some((row) => row.name === "schema_migrations");
        if (!hasHistory) {
          if (objects.length !== 0) throw new LedgerError("STORE_CORRUPT");
          for (const definition of LEDGER_SCHEMA) database.exec(definition.sql);
          database
            .query("INSERT INTO schema_migrations(version,checksum) VALUES(?,?)")
            .run(1, checksum);
        } else {
          const history = database
            .query<SchemaRow, []>("SELECT version,checksum FROM schema_migrations ORDER BY version")
            .all();
          if (
            history.length !== 1 ||
            (history[0]?.version !== 1 && history[0]?.version !== 1n) ||
            history[0]?.checksum !== checksum
          )
            throw new LedgerError("STORE_CORRUPT");
        }
        verifySchema(database);
      })
      .immediate();
  } catch (error) {
    if (error instanceof LedgerError) throw error;
    if (
      error instanceof SQLiteError &&
      (error.code?.startsWith("SQLITE_BUSY") || error.code?.startsWith("SQLITE_LOCKED"))
    )
      throw new LedgerError("STORE_BUSY");
    throw new LedgerError("STORE_CORRUPT");
  }
}
