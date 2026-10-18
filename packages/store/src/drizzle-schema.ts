/** @file Typed query mappings only; reviewed STRICT DDL and checksummed migrations remain authoritative. */
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { LEDGER_TABLE_NAMES } from "./schema.js";

/** Create fresh owner columns for each table definition.
 * @returns Required wallet identity and canonical payload columns.
 */
function walletColumns() {
  return { ownerId: text().notNull(), walletId: text().notNull(), payload: text().notNull() };
}

/** Create fresh full-principal columns without sharing mutable column builders.
 * @returns Required wallet, agent and delegation fields.
 */
function scopeColumns() {
  return { ...walletColumns(), agentId: text().notNull(), delegationId: text().notNull() };
}

/** Statically typed metadata mirroring migration one without generating or altering its SQL. */
export const DRIZZLE_TABLES = {
  wallet: sqliteTable(LEDGER_TABLE_NAMES.wallet, {
    ...walletColumns(),
    network: text().notNull(),
    asset: text().notNull(),
    signerId: text().notNull(),
    reservationTtlMs: integer().notNull(),
    executionTtlMs: integer().notNull(),
    orphanAfterMs: integer().notNull(),
  }),
  policySnapshot: sqliteTable(LEDGER_TABLE_NAMES.policySnapshot, {
    ...scopeColumns(),
    policyId: text().notNull(),
    version: text().notNull(),
    digest: text().notNull(),
    network: text().notNull(),
    asset: text().notNull(),
  }),
  activePolicy: sqliteTable(LEDGER_TABLE_NAMES.activePolicy, {
    ...scopeColumns(),
    policyId: text().notNull(),
    version: text().notNull(),
    digest: text().notNull(),
  }),
  delegationSnapshot: sqliteTable(LEDGER_TABLE_NAMES.delegationSnapshot, {
    ...scopeColumns(),
    revision: integer().notNull(),
  }),
  activeDelegation: sqliteTable(LEDGER_TABLE_NAMES.activeDelegation, {
    ...scopeColumns(),
    revision: integer().notNull(),
  }),
  budget: sqliteTable(LEDGER_TABLE_NAMES.budget, {
    ...walletColumns(),
    accountId: text().notNull(),
    kind: text().notNull(),
    agentId: text(),
    delegationId: text(),
    network: text().notNull(),
    asset: text().notNull(),
    windowMs: integer().notNull(),
    ceilingAtomic: text().notNull(),
    revision: integer().notNull(),
  }),
  intent: sqliteTable(LEDGER_TABLE_NAMES.intent, {
    ...scopeColumns(),
    intentId: text().notNull(),
    idempotencyKey: text().notNull(),
    intentDigest: text().notNull(),
    network: text().notNull(),
    asset: text().notNull(),
    recipient: text().notNull(),
    amountAtomic: text().notNull(),
    decisionKind: text().notNull(),
    reservationId: text(),
    createdAtMs: integer().notNull(),
  }),
  reservation: sqliteTable(LEDGER_TABLE_NAMES.reservation, {
    ...scopeColumns(),
    reservationId: text().notNull(),
    intentId: text().notNull(),
    amountAtomic: text().notNull(),
    state: text().notNull(),
    expiresAtMs: integer().notNull(),
    policyDigest: text().notNull(),
    delegationRevision: integer().notNull(),
    createdAtMs: integer().notNull(),
    updatedAtMs: integer().notNull(),
    executionId: text(),
    decisionKind: text().notNull(),
  }),
  allocation: sqliteTable(LEDGER_TABLE_NAMES.allocation, {
    ...walletColumns(),
    accountId: text().notNull(),
    reservationId: text().notNull(),
    amountAtomic: text().notNull(),
    state: text().notNull(),
    committedAtMs: integer(),
  }),
  execution: sqliteTable(LEDGER_TABLE_NAMES.execution, {
    ...scopeColumns(),
    executionId: text().notNull(),
    reservationId: text().notNull(),
    network: text().notNull(),
    asset: text().notNull(),
    signerId: text().notNull(),
    recipient: text().notNull(),
    amountAtomic: text().notNull(),
    nonce: text().notNull(),
    intentDigest: text().notNull(),
    bindingDigest: text().notNull(),
    payloadDigest: text().notNull(),
    validAfterMs: integer().notNull(),
    validBeforeMs: integer().notNull(),
    claimedAtMs: integer().notNull(),
  }),
  observation: sqliteTable(LEDGER_TABLE_NAMES.observation, {
    ...walletColumns(),
    evidenceId: text().notNull(),
    executionId: text().notNull(),
    bindingDigest: text().notNull(),
    kind: text().notNull(),
  }),
  event: sqliteTable(LEDGER_TABLE_NAMES.event, {
    ...walletColumns(),
    eventId: text().notNull(),
    sequence: integer().notNull(),
    kind: text().notNull(),
    subjectId: text().notNull(),
    occurredAtMs: integer().notNull(),
  }),
  outbox: sqliteTable(LEDGER_TABLE_NAMES.outbox, {
    ...walletColumns(),
    eventId: text().notNull(),
    state: text().notNull(),
    workerId: text(),
    claimToken: text(),
    leaseExpiresAtMs: integer(),
  }),
  clock: sqliteTable(LEDGER_TABLE_NAMES.clock, {
    ...walletColumns(),
    highWaterMs: integer().notNull(),
  }),
  fault: sqliteTable(LEDGER_TABLE_NAMES.fault, {
    ...walletColumns(),
    faultId: text().notNull(),
    createdAtMs: integer().notNull(),
  }),
};
