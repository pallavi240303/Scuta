/** @file Private persisted record types; database money is text and decoded money is bigint. */
import type {
  WalletConfiguration,
  WalletScope,
  TrustedScope,
  PolicySnapshot,
  DelegationSnapshot,
  BudgetAccount,
  IntentRecord,
  ReservationRecord,
  BudgetAllocation,
  ExecutionRecord,
  ObservationRecord,
  LedgerEvent,
  OutboxRecord,
  WalletClockRecord,
  WalletFaultRecord,
} from "@scuta/core";

import type { InferSelectModel } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import type { DRIZZLE_TABLES } from "./drizzle-schema.js";

/** Scope-bound pointer to an immutable policy version and its computed digest. */
export interface ActivePolicyRecord {
  readonly scope: TrustedScope;
  readonly policyId: string;
  readonly version: string;
  readonly digest: string;
}
/** Scope-bound pointer to an immutable delegation activation revision. */
export interface ActiveDelegationRecord {
  readonly scope: TrustedScope;
  readonly revision: number;
}
/** Wallet-scoped allocation data without transient compare-and-set expectations. */
export interface AllocationRecord {
  readonly wallet: WalletScope;
  readonly allocation: BudgetAllocation;
}
/** Stored data kinds with a distinct checked codec for each table responsibility. */
export interface LedgerRecords {
  readonly wallet: WalletConfiguration;
  readonly policySnapshot: PolicySnapshot;
  readonly activePolicy: ActivePolicyRecord;
  readonly delegationSnapshot: DelegationSnapshot;
  readonly activeDelegation: ActiveDelegationRecord;
  readonly budget: BudgetAccount;
  readonly intent: IntentRecord;
  readonly reservation: ReservationRecord;
  readonly allocation: AllocationRecord;
  readonly execution: ExecutionRecord;
  readonly observation: ObservationRecord;
  readonly event: LedgerEvent;
  readonly outbox: OutboxRecord;
  readonly clock: WalletClockRecord;
  readonly fault: WalletFaultRecord;
}
/** Logical table kind, separate from physical SQL identifiers. */
export type LedgerRecordKind = keyof LedgerRecords;
/** Exact column models accepted by the typed store-only query mappings. */
export type LedgerRows = {
  readonly [K in LedgerRecordKind]: InferSelectModel<(typeof DRIZZLE_TABLES)[K]> &
    SQLiteUpdateSetSource<(typeof DRIZZLE_TABLES)[K]>;
};
/** Runtime allowlist prevents inherited object properties from being treated as codec selectors. */
export const LEDGER_RECORD_KINDS = Object.freeze([
  "wallet",
  "policySnapshot",
  "activePolicy",
  "delegationSnapshot",
  "activeDelegation",
  "budget",
  "intent",
  "reservation",
  "allocation",
  "execution",
  "observation",
  "event",
  "outbox",
  "clock",
  "fault",
] as const satisfies readonly LedgerRecordKind[]);
/** Bound SQLite values; bigint money never enters the driver as INTEGER or REAL. */
export type SqliteValue = string | number | null;
/** Complete flat row including canonical payload and relational/query metadata. */
export type SqliteRow = Readonly<Record<string, SqliteValue>>;
