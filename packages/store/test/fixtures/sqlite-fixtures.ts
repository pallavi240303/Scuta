/** @file Referentially complete records and bound inserts for real SQLite tests. */
import type { Database } from "bun:sqlite";
import { createStoreRecords } from "../store-fixtures.js";
import { encodeLedgerRow } from "../../src/row-codecs.js";
import { LEDGER_TABLE_NAMES } from "../../src/schema.js";
import type { LedgerRecordKind, LedgerRecords, SqliteRow } from "../../src/row-types.js";

/** Create records whose deferred intent, reservation and execution links resolve together.
 * @param records - Deterministic mock purchase and configuration.
 * @returns Complete stored records without credentials or signed payments.
 */
export function createSqliteRecords(records = createStoreRecords()): LedgerRecords {
  const r = records;
  const wallet = { ownerId: r.wallet.ownerId, walletId: r.wallet.walletId };
  return {
    wallet: r.wallet,
    policySnapshot: r.policy,
    activePolicy: {
      scope: r.scope,
      policyId: r.policy.policy.policyId,
      version: r.policy.policy.version,
      digest: r.policy.policy.digest,
    },
    delegationSnapshot: r.delegation,
    activeDelegation: { scope: r.scope, revision: 1 },
    budget: r.budget,
    intent: r.intent,
    reservation: { ...r.reservation, state: "EXECUTING", executionId: r.execution.executionId },
    allocation: {
      wallet,
      allocation: {
        reservationId: r.reservation.reservationId,
        accountId: r.budget.accountId,
        amountAtomic: 70n,
        state: "EXECUTING",
        committedAtMs: null,
      },
    },
    execution: r.execution,
    observation: {
      wallet,
      observation: {
        evidenceId: "evidence-1",
        executionId: r.execution.executionId,
        bindingDigest: r.execution.bindingDigest,
        kind: "SETTLED",
        evidenceRef: "mock:receipt-1",
      },
    },
    event: {
      eventId: "event-1",
      wallet,
      sequence: 1,
      kind: "DECISION",
      subjectId: r.intent.intentId,
      occurredAtMs: r.intent.createdAtMs,
      reason: null,
    },
    outbox: {
      eventId: "event-1",
      wallet,
      state: "PENDING",
      workerId: null,
      claimToken: null,
      leaseExpiresAtMs: null,
    },
    clock: { wallet, highWaterMs: r.intent.createdAtMs },
    fault: {
      wallet,
      faultId: "fault-1",
      reason: "EVIDENCE_CONFLICT",
      createdAtMs: r.intent.createdAtMs,
    },
  };
}

/** Insert statically selected columns with bound values, including invalid test mutations.
 * @param database - Real test connection.
 * @param kind - Known ledger table kind.
 * @param row - Encoded row columns.
 */
export function insertSqliteRow(database: Database, kind: LedgerRecordKind, row: SqliteRow): void {
  const columns = Object.keys(row);
  database
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
}

/** Insert a coherent fixture in one transaction with deferred ownership links.
 * @param database - Migrated SQLite connection.
 * @param records - Complete records to persist.
 */
export function insertSqliteRecords(database: Database, records = createSqliteRecords()): void {
  database
    .transaction(() => {
      for (const kind of Object.keys(LEDGER_TABLE_NAMES) as LedgerRecordKind[])
        insertSqliteRow(database, kind, encodeLedgerRow(kind, records[kind]));
    })
    .immediate();
}
