/** @file Scope-bound SQLite snapshot reads and deterministic worker selections; no financial mutation. */
import type { LedgerReadView, WalletScope, TrustedScope } from "@scuta/core";
import { assertIdentifier, assertStore, scopeKey, walletKey } from "./memory-state.js";
import type { SqliteQueries } from "./sqlite-queries.js";

/** Trusted SQL ownership predicate shared by private row operations. */
export const WALLET_WHERE = "ownerId=? AND walletId=?";
/** Trusted SQL principal predicate, including agent and delegation. */
export const SCOPE_WHERE = WALLET_WHERE + " AND agentId=? AND delegationId=?";

/** Validate and bind a wallet tuple without accepting SQL from callers.
 * @param wallet - Trusted ownership labels.
 * @returns Bound primitive identifiers.
 */
export function walletValues(wallet: WalletScope): readonly string[] {
  walletKey(wallet);
  return [wallet.ownerId, wallet.walletId];
}

/** Validate and bind a full principal tuple.
 * @param scope - Trusted full scope.
 * @returns Bound scope identifiers.
 */
export function scopeValues(scope: TrustedScope): readonly string[] {
  scopeKey(scope);
  return [...walletValues(scope), scope.agentId, scope.delegationId];
}

/** Require safe query bounds without rejecting calculated negative cutoffs.
 * @param time - Time or calculated cutoff.
 * @param limit - Maximum one to one thousand results.
 * @param signed - Whether the cutoff can precede epoch zero.
 */
function checkQuery(time: number, limit: number, signed = false): void {
  assertStore(Number.isSafeInteger(time) && (signed || time >= 0));
  assertStore(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000);
}

/** Build the public read-only handle around checked prepared record operations.
 * @param queries - Callback-lifetime-owned typed queries.
 * @param assertOpen - Lifetime gate, including queries that may return without touching SQL.
 * @returns Frozen scope-bound read methods.
 */
export function createSqliteReadView(
  queries: SqliteQueries,
  assertOpen: () => void,
): LedgerReadView {
  return Object.freeze({
    getWallet(wallet) {
      return queries.get("wallet", WALLET_WHERE, walletValues(wallet));
    },
    getPolicy(scope) {
      const values = scopeValues(scope);
      const active = queries.get("activePolicy", SCOPE_WHERE, values);
      if (!active) return null;
      const record = queries.get("policySnapshot", SCOPE_WHERE + " AND policyId=? AND version=?", [
        ...values,
        active.policyId,
        active.version,
      ]);
      assertStore(record !== null && record.policy.digest === active.digest);
      return record;
    },
    getDelegation(scope) {
      const values = scopeValues(scope);
      const active = queries.get("activeDelegation", SCOPE_WHERE, values);
      if (!active) return null;
      const record = queries.get("delegationSnapshot", SCOPE_WHERE + " AND revision=?", [
        ...values,
        active.revision,
      ]);
      assertStore(record !== null);
      return record;
    },
    getBudget(wallet, accountId) {
      assertIdentifier(accountId);
      return queries.get("budget", WALLET_WHERE + " AND accountId=?", [
        ...walletValues(wallet),
        accountId,
      ]);
    },
    getBudgets(scope) {
      scopeKey(scope);
      return queries.list(
        "budget",
        WALLET_WHERE +
          " AND (kind='WALLET' OR (agentId=? AND (kind='AGENT' OR delegationId=?))) ORDER BY accountId",
        [...walletValues(scope), scope.agentId, scope.delegationId],
      );
    },
    findIntent(scope, idempotencyKey) {
      assertIdentifier(idempotencyKey);
      return queries.get("intent", SCOPE_WHERE + " AND idempotencyKey=?", [
        ...scopeValues(scope),
        idempotencyKey,
      ]);
    },
    getIntent(scope, id) {
      assertIdentifier(id);
      return queries.get("intent", SCOPE_WHERE + " AND intentId=?", [...scopeValues(scope), id]);
    },
    getReservation(scope, id) {
      assertIdentifier(id);
      return queries.get("reservation", SCOPE_WHERE + " AND reservationId=?", [
        ...scopeValues(scope),
        id,
      ]);
    },
    getExecution(scope, id) {
      assertIdentifier(id);
      return queries.get("execution", SCOPE_WHERE + " AND executionId=?", [
        ...scopeValues(scope),
        id,
      ]);
    },
    getAllocations(wallet, accountIds, earliestCommittedAtMs) {
      assertOpen();
      assertStore(Number.isSafeInteger(earliestCommittedAtMs));
      const values = walletValues(wallet);
      const allocations = [...new Set(accountIds)].sort().flatMap((accountId) => {
        assertIdentifier(accountId);
        return queries
          .list(
            "allocation",
            WALLET_WHERE +
              " AND accountId=? AND (state IN ('RESERVED','EXECUTING','PENDING_RECONCILIATION') OR (state='COMMITTED' AND committedAtMs>?)) ORDER BY reservationId",
            [...values, accountId, earliestCommittedAtMs],
          )
          .map((record) => record.allocation);
      });
      return Object.freeze(allocations);
    },
    getObservation(wallet, id) {
      assertIdentifier(id);
      return (
        queries.get("observation", WALLET_WHERE + " AND evidenceId=?", [
          ...walletValues(wallet),
          id,
        ])?.observation ?? null
      );
    },
    getClock(wallet) {
      return queries.get("clock", WALLET_WHERE, walletValues(wallet));
    },
    getFault(wallet) {
      return queries.get("fault", WALLET_WHERE, walletValues(wallet));
    },
    getOutbox(wallet, id) {
      assertIdentifier(id);
      return queries.get("outbox", WALLET_WHERE + " AND eventId=?", [...walletValues(wallet), id]);
    },
    listExpirable(wallet, nowMs, limit) {
      checkQuery(nowMs, limit);
      return queries.list(
        "reservation",
        WALLET_WHERE +
          " AND state='RESERVED' AND expiresAtMs<=? ORDER BY expiresAtMs,reservationId LIMIT ?",
        [...walletValues(wallet), nowMs, limit],
      );
    },
    listOrphans(wallet, beforeMs, limit) {
      checkQuery(beforeMs, limit, true);
      const executions = queries.list(
        "execution",
        WALLET_WHERE +
          " AND claimedAtMs<=? AND EXISTS (SELECT 1 FROM reservations r WHERE r.ownerId=executions.ownerId AND r.walletId=executions.walletId AND r.reservationId=executions.reservationId AND r.state='EXECUTING') ORDER BY claimedAtMs,reservationId LIMIT ?",
        [...walletValues(wallet), beforeMs, limit],
      );
      return Object.freeze(
        executions.map((execution) => {
          const record = queries.get("reservation", SCOPE_WHERE + " AND reservationId=?", [
            ...scopeValues(execution.binding.scope),
            execution.binding.reservationId,
          ]);
          assertStore(record !== null && record.executionId === execution.executionId);
          return record;
        }),
      );
    },
    listDeliverable(wallet, nowMs, limit) {
      checkQuery(nowMs, limit);
      return queries.list(
        "outbox",
        WALLET_WHERE +
          " AND (state='PENDING' OR (state='CLAIMED' AND leaseExpiresAtMs<=?)) ORDER BY (SELECT sequence FROM decision_events e WHERE e.ownerId=outbox_events.ownerId AND e.walletId=outbox_events.walletId AND e.eventId=outbox_events.eventId) LIMIT ?",
        [...walletValues(wallet), nowMs, limit],
      );
    },
  } satisfies LedgerReadView);
}
