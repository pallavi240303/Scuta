/** @file Private checked encoders and decoders for persisted rows; corruption fails closed. */
import { LedgerError } from "@scuta/core";
import type { WalletScope, TrustedScope } from "@scuta/core";
import type { LedgerRecordKind, LedgerRecords, SqliteRow } from "./row-types.js";
import { LEDGER_RECORD_KINDS } from "./row-types.js";
import { RECORD_PARSERS } from "./record-parsers.js";
import {
  canonicalJson,
  parsePayload,
  readObject,
  requireRow,
  freezeRecord,
} from "./row-validation.js";

/** Project owner/wallet metadata without retaining unrelated configuration properties.
 * @param wallet - Typed owner labels.
 * @returns Checked columns supplied by a validated record.
 */
function walletColumns(wallet: WalletScope): SqliteRow {
  return { ownerId: wallet.ownerId, walletId: wallet.walletId };
}

/** Project full principal metadata for scoped indexes and relationships.
 * @param scope - Validated full scope.
 * @returns Wallet and delegation columns.
 */
function scopeColumns(scope: TrustedScope): SqliteRow {
  return { ...walletColumns(scope), agentId: scope.agentId, delegationId: scope.delegationId };
}

/** Record-specific indexed columns; financial values are always canonical decimal strings. */
const rowColumns: { readonly [K in LedgerRecordKind]: (record: LedgerRecords[K]) => SqliteRow } = {
  wallet: (record) => ({
    ...walletColumns(record),
    network: record.network,
    asset: record.asset,
    signerId: record.signerId,
    reservationTtlMs: record.reservationTtlMs,
    executionTtlMs: record.executionTtlMs,
    orphanAfterMs: record.orphanAfterMs,
  }),
  policySnapshot: (record) => ({
    ...scopeColumns(record.policy.scope),
    policyId: record.policy.policyId,
    version: record.policy.version,
    digest: record.policy.digest,
    network: record.policy.network,
    asset: record.policy.asset,
  }),
  activePolicy: (record) => ({
    ...scopeColumns(record.scope),
    policyId: record.policyId,
    version: record.version,
    digest: record.digest,
  }),
  delegationSnapshot: (record) => ({
    ...scopeColumns(record.delegation.scope),
    revision: record.revision,
  }),
  activeDelegation: (record) => ({ ...scopeColumns(record.scope), revision: record.revision }),
  budget: (record) => ({
    ...walletColumns(record.scope),
    accountId: record.accountId,
    kind: record.scope.kind,
    agentId: record.scope.kind === "WALLET" ? null : record.scope.agentId,
    delegationId: record.scope.kind === "DELEGATION" ? record.scope.delegationId : null,
    network: record.network,
    asset: record.asset,
    windowMs: record.windowMs,
    ceilingAtomic: record.ceilingAtomic.toString(),
    revision: record.revision,
  }),
  intent: (record) => ({
    ...scopeColumns(record.scope),
    intentId: record.intentId,
    idempotencyKey: record.intent.idempotencyKey,
    intentDigest: record.intentDigest,
    network: record.intent.network,
    asset: record.intent.asset,
    recipient: record.intent.recipient,
    amountAtomic: record.intent.amountAtomic.toString(),
    decisionKind: record.decision.kind,
    reservationId: record.reservationId,
    createdAtMs: record.createdAtMs,
  }),
  reservation: (record) => ({
    ...scopeColumns(record.scope),
    reservationId: record.reservationId,
    intentId: record.intentId,
    amountAtomic: record.amountAtomic.toString(),
    state: record.state,
    expiresAtMs: record.expiresAtMs,
    policyDigest: record.policyDigest,
    delegationRevision: record.delegationRevision,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    executionId: record.executionId,
    decisionKind: "ALLOW",
  }),
  allocation: (record) => ({
    ...walletColumns(record.wallet),
    accountId: record.allocation.accountId,
    reservationId: record.allocation.reservationId,
    amountAtomic: record.allocation.amountAtomic.toString(),
    state: record.allocation.state,
    committedAtMs: record.allocation.committedAtMs,
  }),
  execution: (record) => ({
    ...scopeColumns(record.binding.scope),
    executionId: record.executionId,
    reservationId: record.binding.reservationId,
    network: record.binding.network,
    asset: record.binding.asset,
    signerId: record.binding.signerId,
    recipient: record.binding.recipient,
    amountAtomic: record.binding.amountAtomic.toString(),
    nonce: record.binding.nonce,
    intentDigest: record.binding.intentDigest,
    bindingDigest: record.bindingDigest,
    payloadDigest: record.payloadDigest,
    validAfterMs: record.binding.validAfterMs,
    validBeforeMs: record.binding.validBeforeMs,
    claimedAtMs: record.claimedAtMs,
  }),
  observation: (record) => ({
    ...walletColumns(record.wallet),
    evidenceId: record.observation.evidenceId,
    executionId: record.observation.executionId,
    bindingDigest: record.observation.bindingDigest,
    kind: record.observation.kind,
  }),
  event: (record) => ({
    ...walletColumns(record.wallet),
    eventId: record.eventId,
    sequence: record.sequence,
    kind: record.kind,
    subjectId: record.subjectId,
    occurredAtMs: record.occurredAtMs,
  }),
  outbox: (record) => ({
    ...walletColumns(record.wallet),
    eventId: record.eventId,
    state: record.state,
    workerId: record.workerId,
    claimToken: record.claimToken,
    leaseExpiresAtMs: record.leaseExpiresAtMs,
  }),
  clock: (record) => ({ ...walletColumns(record.wallet), highWaterMs: record.highWaterMs }),
  fault: (record) => ({
    ...walletColumns(record.wallet),
    faultId: record.faultId,
    createdAtMs: record.createdAtMs,
  }),
};

/** Convert driver bigint counters only after confirming they fit the exact safe-integer domain.
 * @param value - Untrusted relational column.
 * @returns The original primitive or an exact bounded number.
 * @throws {LedgerError} If a driver integer would lose precision.
 */
function driverValue(value: unknown): unknown {
  if (typeof value !== "bigint") return value;
  requireRow(value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER));
  return Number(value);
}

/** Encode a typed record as text money and checked query metadata.
 * @param kind - Statically selected record kind.
 * @param record - Typed data to validate before persistence.
 * @returns A complete independently owned row.
 * @throws {LedgerError} If record shape or financial data is invalid.
 */
export function encodeLedgerRow<K extends LedgerRecordKind>(
  kind: K,
  record: LedgerRecords[K],
): SqliteRow {
  try {
    requireRow(LEDGER_RECORD_KINDS.includes(kind));
    const decoded = RECORD_PARSERS[kind](parsePayload(canonicalJson(record)));
    return Object.freeze({ ...rowColumns[kind](decoded), payload: canonicalJson(decoded) });
  } catch {
    throw new LedgerError("STORE_CORRUPT");
  }
}

/** Decode a row and verify its indexed columns agree with canonical record content.
 * @param kind - Statically selected record kind.
 * @param row - Untrusted database result.
 * @returns Immutable validated data with exact bigint amounts.
 * @throws {LedgerError} If any stored data or metadata is corrupt.
 */
export function decodeLedgerRow<K extends LedgerRecordKind>(
  kind: K,
  row: unknown,
): LedgerRecords[K] {
  try {
    requireRow(LEDGER_RECORD_KINDS.includes(kind));
    const raw = readObject(row);
    const record = RECORD_PARSERS[kind](parsePayload(raw.payload));
    const expected: SqliteRow = { ...rowColumns[kind](record), payload: canonicalJson(record) };
    requireRow(Object.keys(raw).length === Object.keys(expected).length);
    for (const key of Object.keys(expected)) requireRow(driverValue(raw[key]) === expected[key]);
    return freezeRecord(record);
  } catch {
    throw new LedgerError("STORE_CORRUPT");
  }
}
