/** @file Private SQLite table identities and reviewed schema definitions for migration one. */
import type { LedgerRecordKind } from "./row-types.js";
import { MAX_ATOMIC_AMOUNT } from "@scuta/core";

/** Static SQL names only; no agent-supplied table or column identifiers are interpolated. */
export const LEDGER_TABLE_NAMES = Object.freeze({
  wallet: "wallets",
  policySnapshot: "policy_snapshots",
  activePolicy: "active_policies",
  delegationSnapshot: "delegation_snapshots",
  activeDelegation: "active_delegations",
  budget: "budget_accounts",
  intent: "payment_intents",
  reservation: "reservations",
  allocation: "reservation_allocations",
  execution: "executions",
  observation: "reconciliation_observations",
  event: "decision_events",
  outbox: "outbox_events",
  clock: "wallet_clocks",
  fault: "ledger_faults",
} satisfies Record<LedgerRecordKind, string>);

/** One checksummed schema object, compared with sqlite_schema before accepting an existing database. */
export interface SchemaDefinition {
  readonly type: "table" | "index";
  readonly name: string;
  readonly sql: string;
}

/** Define a bounded identifier column without accepting arbitrary SQL names.
 * @param name - Static schema identifier.
 * @param nullable - Whether absence is part of this table's contract.
 * @returns Reviewed column SQL.
 */
function identifier(name: string, nullable = false): string {
  return (
    name +
    " TEXT" +
    (nullable ? "" : " NOT NULL") +
    " CHECK(" +
    name +
    " IS NULL OR (length(" +
    name +
    ") BETWEEN 1 AND 64 AND " +
    name +
    " GLOB '[A-Za-z0-9]*' AND " +
    name +
    " NOT GLOB '*[^A-Za-z0-9_-]*'))"
  );
}
/** Define a bounded profile label, not a verified provider address.
 * @param name - Static profile column.
 * @returns Reviewed profile SQL.
 */
function profile(name: string): string {
  return (
    name +
    " TEXT NOT NULL CHECK(length(" +
    name +
    ") BETWEEN 1 AND 256 AND " +
    name +
    " GLOB '[A-Za-z0-9]*' AND " +
    name +
    " NOT GLOB '*[^A-Za-z0-9:._/-]*')"
  );
}
/** Define a safe integer column.
 * @param name - Static time, duration or counter column.
 * @param minimum - Minimum permitted value.
 * @param nullable - Whether a missing lease/booking time is permitted.
 * @returns Reviewed bounded-integer SQL.
 */
function integer(name: string, minimum = 0, nullable = false): string {
  return (
    name +
    " INTEGER" +
    (nullable ? "" : " NOT NULL") +
    " CHECK(" +
    name +
    " IS NULL OR " +
    name +
    " BETWEEN " +
    minimum +
    " AND 9007199254740991)"
  );
}
/** Define canonical uint256 decimal text without casting money to SQLite numeric types.
 * @param name - Static financial column.
 * @param zero - Whether zero closes a budget instead of representing a payment.
 * @returns Reviewed exact-text SQL.
 */
function money(name: string, zero = false): string {
  const maximum = MAX_ATOMIC_AMOUNT.toString();
  return (
    name +
    " TEXT NOT NULL CHECK(length(" +
    name +
    ") BETWEEN 1 AND 78 AND " +
    name +
    " NOT GLOB '*[^0-9]*' AND (" +
    (zero ? name + "='0' OR " : "") +
    name +
    " GLOB '[1-9]*') AND (length(" +
    name +
    ") < 78 OR " +
    name +
    " <= '" +
    maximum +
    "' COLLATE BINARY))"
  );
}
/** Define a lowercase SHA-256 identity or nonce column.
 * @param name - Static digest column.
 * @returns Reviewed hexadecimal SQL.
 */
function digest(name: string): string {
  return (
    name + " TEXT NOT NULL CHECK(length(" + name + ")=64 AND " + name + " NOT GLOB '*[^0-9a-f]*')"
  );
}
/** Build one strict table whose supplied columns are static trusted definitions.
 * @param name - Known table name.
 * @param columns - Reviewed columns and constraints.
 * @returns Frozen checksummed table definition.
 */
function table(name: string, columns: readonly string[]): SchemaDefinition {
  return Object.freeze({
    type: "table",
    name,
    sql: "CREATE TABLE " + name + " (\n" + columns.join(",\n") + "\n) STRICT",
  });
}
/** Build a static query index.
 * @param name - Known index name.
 * @param on - Static table and ordered columns.
 * @returns Frozen checksummed index definition.
 */
function index(name: string, on: string): SchemaDefinition {
  return Object.freeze({ type: "index", name, sql: "CREATE INDEX " + name + " ON " + on });
}

const walletColumns = [identifier("ownerId"), identifier("walletId")];
const scopeColumns = [...walletColumns, identifier("agentId"), identifier("delegationId")];
const payloadColumn =
  "payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload)='object' AND length(CAST(payload AS BLOB)) <= 131072)";
const walletReference =
  "FOREIGN KEY(ownerId,walletId) REFERENCES wallets(ownerId,walletId) DEFERRABLE INITIALLY DEFERRED";
const profileReference =
  "FOREIGN KEY(ownerId,walletId,network,asset) REFERENCES wallets(ownerId,walletId,network,asset) DEFERRABLE INITIALLY DEFERRED";
const stateColumn =
  "state TEXT NOT NULL CHECK(state IN ('RESERVED','EXECUTING','PENDING_RECONCILIATION','COMMITTED','RELEASED','EXPIRED'))";

/** Ordered migration-one objects, including metadata, ownership constraints and worker indexes. */
export const LEDGER_SCHEMA = Object.freeze([
  table("schema_migrations", [integer("version", 1), digest("checksum"), "PRIMARY KEY(version)"]),
  table("wallets", [
    ...walletColumns,
    profile("network"),
    profile("asset"),
    identifier("signerId"),
    integer("reservationTtlMs", 1),
    integer("executionTtlMs", 1),
    integer("orphanAfterMs", 1),
    payloadColumn,
    "PRIMARY KEY(ownerId,walletId)",
    "UNIQUE(ownerId,walletId,network,asset)",
  ]),
  table("policy_snapshots", [
    ...scopeColumns,
    identifier("policyId"),
    identifier("version"),
    digest("digest"),
    profile("network"),
    profile("asset"),
    payloadColumn,
    "PRIMARY KEY(ownerId,walletId,agentId,delegationId,policyId,version)",
    "UNIQUE(ownerId,walletId,agentId,delegationId,digest)",
    "UNIQUE(ownerId,walletId,agentId,delegationId,policyId,version,digest)",
    profileReference,
  ]),
  table("active_policies", [
    ...scopeColumns,
    identifier("policyId"),
    identifier("version"),
    digest("digest"),
    payloadColumn,
    "PRIMARY KEY(ownerId,walletId,agentId,delegationId)",
    "FOREIGN KEY(ownerId,walletId,agentId,delegationId,policyId,version,digest) REFERENCES policy_snapshots(ownerId,walletId,agentId,delegationId,policyId,version,digest) DEFERRABLE INITIALLY DEFERRED",
  ]),
  table("delegation_snapshots", [
    ...scopeColumns,
    integer("revision", 1),
    payloadColumn,
    "PRIMARY KEY(ownerId,walletId,agentId,delegationId,revision)",
    walletReference,
  ]),
  table("active_delegations", [
    ...scopeColumns,
    integer("revision", 1),
    payloadColumn,
    "PRIMARY KEY(ownerId,walletId,agentId,delegationId)",
    "FOREIGN KEY(ownerId,walletId,agentId,delegationId,revision) REFERENCES delegation_snapshots(ownerId,walletId,agentId,delegationId,revision) DEFERRABLE INITIALLY DEFERRED",
  ]),
  table("budget_accounts", [
    ...walletColumns,
    identifier("accountId"),
    "kind TEXT NOT NULL CHECK(kind IN ('WALLET','AGENT','DELEGATION'))",
    identifier("agentId", true),
    identifier("delegationId", true),
    profile("network"),
    profile("asset"),
    integer("windowMs", 1),
    money("ceilingAtomic", true),
    integer("revision", 1),
    payloadColumn,
    "PRIMARY KEY(ownerId,walletId,accountId)",
    "CHECK((kind='WALLET' AND agentId IS NULL AND delegationId IS NULL) OR (kind='AGENT' AND agentId IS NOT NULL AND delegationId IS NULL) OR (kind='DELEGATION' AND agentId IS NOT NULL AND delegationId IS NOT NULL))",
    profileReference,
  ]),
  table("payment_intents", [
    ...scopeColumns,
    identifier("intentId"),
    identifier("idempotencyKey"),
    digest("intentDigest"),
    profile("network"),
    profile("asset"),
    profile("recipient"),
    money("amountAtomic"),
    "decisionKind TEXT NOT NULL CHECK(decisionKind IN ('ALLOW','DENY','REQUIRE_APPROVAL'))",
    identifier("reservationId", true),
    integer("createdAtMs"),
    payloadColumn,
    "PRIMARY KEY(ownerId,walletId,intentId)",
    "UNIQUE(ownerId,walletId,agentId,delegationId,idempotencyKey)",
    "UNIQUE(ownerId,walletId,intentId,agentId,delegationId,amountAtomic,decisionKind)",
    "CHECK(decisionKind='ALLOW' OR reservationId IS NULL)",
    walletReference,
    "FOREIGN KEY(ownerId,walletId,reservationId,intentId) REFERENCES reservations(ownerId,walletId,reservationId,intentId) DEFERRABLE INITIALLY DEFERRED",
  ]),
  table("reservations", [
    ...scopeColumns,
    identifier("reservationId"),
    identifier("intentId"),
    money("amountAtomic"),
    stateColumn,
    integer("expiresAtMs"),
    digest("policyDigest"),
    integer("delegationRevision", 1),
    integer("createdAtMs"),
    integer("updatedAtMs"),
    identifier("executionId", true),
    "decisionKind TEXT NOT NULL CHECK(decisionKind='ALLOW')",
    payloadColumn,
    "PRIMARY KEY(ownerId,walletId,reservationId)",
    "UNIQUE(ownerId,walletId,intentId)",
    "UNIQUE(ownerId,walletId,reservationId,intentId)",
    "UNIQUE(ownerId,walletId,reservationId,amountAtomic,state)",
    "UNIQUE(ownerId,walletId,reservationId,agentId,delegationId,amountAtomic)",
    "CHECK(expiresAtMs>createdAtMs AND updatedAtMs>=createdAtMs)",
    "CHECK((state IN ('RESERVED','EXPIRED') AND executionId IS NULL) OR (state IN ('EXECUTING','PENDING_RECONCILIATION','COMMITTED') AND executionId IS NOT NULL) OR state='RELEASED')",
    "FOREIGN KEY(ownerId,walletId,intentId,agentId,delegationId,amountAtomic,decisionKind) REFERENCES payment_intents(ownerId,walletId,intentId,agentId,delegationId,amountAtomic,decisionKind) DEFERRABLE INITIALLY DEFERRED",
    "FOREIGN KEY(ownerId,walletId,agentId,delegationId,policyDigest) REFERENCES policy_snapshots(ownerId,walletId,agentId,delegationId,digest) DEFERRABLE INITIALLY DEFERRED",
    "FOREIGN KEY(ownerId,walletId,agentId,delegationId,delegationRevision) REFERENCES delegation_snapshots(ownerId,walletId,agentId,delegationId,revision) DEFERRABLE INITIALLY DEFERRED",
    "FOREIGN KEY(ownerId,walletId,executionId,reservationId) REFERENCES executions(ownerId,walletId,executionId,reservationId) DEFERRABLE INITIALLY DEFERRED",
  ]),
  table("reservation_allocations", [
    ...walletColumns,
    identifier("accountId"),
    identifier("reservationId"),
    money("amountAtomic"),
    stateColumn,
    integer("committedAtMs", 0, true),
    payloadColumn,
    "PRIMARY KEY(ownerId,walletId,accountId,reservationId)",
    "CHECK((state='COMMITTED' AND committedAtMs IS NOT NULL) OR (state<>'COMMITTED' AND committedAtMs IS NULL))",
    "FOREIGN KEY(ownerId,walletId,accountId) REFERENCES budget_accounts(ownerId,walletId,accountId) DEFERRABLE INITIALLY DEFERRED",
    "FOREIGN KEY(ownerId,walletId,reservationId,amountAtomic,state) REFERENCES reservations(ownerId,walletId,reservationId,amountAtomic,state) DEFERRABLE INITIALLY DEFERRED",
  ]),
  table("executions", [
    ...scopeColumns,
    identifier("executionId"),
    identifier("reservationId"),
    profile("network"),
    profile("asset"),
    identifier("signerId"),
    profile("recipient"),
    money("amountAtomic"),
    digest("nonce"),
    digest("intentDigest"),
    digest("bindingDigest"),
    digest("payloadDigest"),
    integer("validAfterMs"),
    integer("validBeforeMs"),
    integer("claimedAtMs"),
    payloadColumn,
    "PRIMARY KEY(ownerId,walletId,executionId)",
    "UNIQUE(ownerId,walletId,reservationId)",
    "UNIQUE(ownerId,walletId,network,asset,nonce)",
    "UNIQUE(ownerId,walletId,executionId,reservationId)",
    "UNIQUE(ownerId,walletId,executionId,bindingDigest)",
    "CHECK(validBeforeMs>validAfterMs)",
    profileReference,
    "FOREIGN KEY(ownerId,walletId,reservationId,agentId,delegationId,amountAtomic) REFERENCES reservations(ownerId,walletId,reservationId,agentId,delegationId,amountAtomic) DEFERRABLE INITIALLY DEFERRED",
  ]),
  table("reconciliation_observations", [
    ...walletColumns,
    identifier("evidenceId"),
    identifier("executionId"),
    digest("bindingDigest"),
    "kind TEXT NOT NULL CHECK(kind IN ('SETTLED','FINAL_NON_EXECUTION'))",
    payloadColumn,
    "PRIMARY KEY(ownerId,walletId,evidenceId)",
    "FOREIGN KEY(ownerId,walletId,executionId,bindingDigest) REFERENCES executions(ownerId,walletId,executionId,bindingDigest) DEFERRABLE INITIALLY DEFERRED",
  ]),
  table("decision_events", [
    ...walletColumns,
    identifier("eventId"),
    integer("sequence", 1),
    "kind TEXT NOT NULL CHECK(kind IN ('CONFIGURATION','DECISION','IDEMPOTENCY_CONFLICT','RESERVATION_TRANSITION','RECONCILIATION','LEDGER_FAULT'))",
    identifier("subjectId"),
    integer("occurredAtMs"),
    payloadColumn,
    "PRIMARY KEY(ownerId,walletId,eventId)",
    "UNIQUE(ownerId,walletId,sequence)",
    walletReference,
  ]),
  table("outbox_events", [
    ...walletColumns,
    identifier("eventId"),
    "state TEXT NOT NULL CHECK(state IN ('PENDING','CLAIMED','DELIVERED'))",
    identifier("workerId", true),
    identifier("claimToken", true),
    integer("leaseExpiresAtMs", 0, true),
    payloadColumn,
    "PRIMARY KEY(ownerId,walletId,eventId)",
    "CHECK((state='PENDING' AND workerId IS NULL AND claimToken IS NULL AND leaseExpiresAtMs IS NULL) OR (state IN ('CLAIMED','DELIVERED') AND workerId IS NOT NULL AND claimToken IS NOT NULL AND leaseExpiresAtMs IS NOT NULL))",
    "FOREIGN KEY(ownerId,walletId,eventId) REFERENCES decision_events(ownerId,walletId,eventId) DEFERRABLE INITIALLY DEFERRED",
  ]),
  table("wallet_clocks", [
    ...walletColumns,
    integer("highWaterMs"),
    payloadColumn,
    "PRIMARY KEY(ownerId,walletId)",
    walletReference,
  ]),
  table("ledger_faults", [
    ...walletColumns,
    identifier("faultId"),
    integer("createdAtMs"),
    payloadColumn,
    "PRIMARY KEY(ownerId,walletId)",
    walletReference,
  ]),
  index(
    "allocation_exposure",
    "reservation_allocations(ownerId,walletId,accountId,state,committedAtMs)",
  ),
  index("reservation_expiry", "reservations(ownerId,walletId,state,expiresAtMs,reservationId)"),
  index("execution_orphans", "executions(ownerId,walletId,claimedAtMs,reservationId)"),
  index("outbox_delivery", "outbox_events(ownerId,walletId,state,leaseExpiresAtMs,eventId)"),
]);
