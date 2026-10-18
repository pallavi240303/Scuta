/** @file Scope-bound Drizzle reads and deterministic worker selections, confined to the store layer. */
import { and, or, eq, gt, lte, asc, desc, inArray, exists, sql, type AnyColumn } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/sqlite-core";
import type { LedgerReadView, WalletScope, TrustedScope } from "@scuta/core";
import { assertIdentifier, assertStore, scopeKey, walletKey } from "./memory-state.js";
import { DRIZZLE_TABLES } from "./drizzle-schema.js";
import type { SqliteQueries } from "./sqlite-queries.js";

/** Columns needed to bind wallet ownership, independent of a particular table. */
interface WalletColumns {
  readonly ownerId: AnyColumn;
  readonly walletId: AnyColumn;
}
/** Columns needed to bind full principal ownership. */
interface ScopeColumns extends WalletColumns {
  readonly agentId: AnyColumn;
  readonly delegationId: AnyColumn;
}

/** Build a bound wallet predicate using real typed table columns.
 * @param table - Drizzle table with wallet ownership columns.
 * @param wallet - Trusted wallet labels.
 * @returns A parameterized ownership condition.
 */
export function walletCondition(table: WalletColumns, wallet: WalletScope) {
  walletKey(wallet);
  return and(eq(table.ownerId, wallet.ownerId), eq(table.walletId, wallet.walletId));
}

/** Build a bound full-principal predicate.
 * @param table - Drizzle table with agent/delegation columns.
 * @param scope - Trusted full scope.
 * @returns A parameterized scope condition.
 */
export function scopeCondition(table: ScopeColumns, scope: TrustedScope) {
  scopeKey(scope);
  return and(
    walletCondition(table, scope),
    eq(table.agentId, scope.agentId),
    eq(table.delegationId, scope.delegationId),
  );
}

/** Require safe worker bounds while allowing calculated pre-epoch cutoffs.
 * @param time - Trusted time or calculated cutoff.
 * @param limit - Maximum one to one thousand results.
 * @param signed - Whether negative safe cutoffs are valid.
 */
function checkQuery(time: number, limit: number, signed = false): void {
  assertStore(Number.isSafeInteger(time) && (signed || time >= 0));
  assertStore(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000);
}

/** Build lifetime-owned typed reads over the current SQLite transaction.
 * @param queries - Store-only Drizzle operations.
 * @param assertOpen - Lifetime gate for paths that may not execute a query.
 * @returns Frozen read methods with checked immutable records.
 */
export function createSqliteReadView(
  queries: SqliteQueries,
  assertOpen: () => void,
): LedgerReadView {
  return Object.freeze({
    getWallet(wallet) {
      return queries.get("wallet", (t) => walletCondition(t, wallet));
    },
    getPolicy(scope) {
      const active = queries.get("activePolicy", (t) => scopeCondition(t, scope));
      if (!active) return null;
      const record = queries.get("policySnapshot", (t) =>
        and(
          scopeCondition(t, scope),
          eq(t.policyId, active.policyId),
          eq(t.version, active.version),
        ),
      );
      assertStore(record !== null && record.policy.digest === active.digest);
      return record;
    },
    getDelegation(scope) {
      const active = queries.get("activeDelegation", (t) => scopeCondition(t, scope));
      if (!active) return null;
      const record = queries.get("delegationSnapshot", (t) =>
        and(scopeCondition(t, scope), eq(t.revision, active.revision)),
      );
      assertStore(record !== null);
      return record;
    },
    getBudget(wallet, accountId) {
      assertIdentifier(accountId);
      return queries.get("budget", (t) =>
        and(walletCondition(t, wallet), eq(t.accountId, accountId)),
      );
    },
    listBudgets(wallet) {
      return queries.list("budget", (t) => walletCondition(t, wallet), {
        orderBy: (t) => [asc(t.accountId)],
      });
    },
    hasIntents(wallet) {
      return queries.get("intent", (t) => walletCondition(t, wallet)) !== null;
    },
    getEvent(wallet, eventId) {
      assertIdentifier(eventId);
      return queries.get("event", (t) => and(walletCondition(t, wallet), eq(t.eventId, eventId)));
    },
    getLatestEvent(wallet) {
      return queries.get("event", (t) => walletCondition(t, wallet), {
        orderBy: (t) => [desc(t.sequence)],
      });
    },
    getBudgets(scope) {
      scopeKey(scope);
      return queries.list(
        "budget",
        (t) =>
          and(
            walletCondition(t, scope),
            or(
              eq(t.kind, "WALLET"),
              and(
                eq(t.agentId, scope.agentId),
                or(eq(t.kind, "AGENT"), eq(t.delegationId, scope.delegationId)),
              ),
            ),
          ),
        { orderBy: (t) => [asc(t.accountId)] },
      );
    },
    findIntent(scope, idempotencyKey) {
      assertIdentifier(idempotencyKey);
      return queries.get("intent", (t) =>
        and(scopeCondition(t, scope), eq(t.idempotencyKey, idempotencyKey)),
      );
    },
    getIntent(scope, id) {
      assertIdentifier(id);
      return queries.get("intent", (t) => and(scopeCondition(t, scope), eq(t.intentId, id)));
    },
    getReservation(scope, id) {
      assertIdentifier(id);
      return queries.get("reservation", (t) =>
        and(scopeCondition(t, scope), eq(t.reservationId, id)),
      );
    },
    getExecution(scope, id) {
      assertIdentifier(id);
      return queries.get("execution", (t) => and(scopeCondition(t, scope), eq(t.executionId, id)));
    },
    getAllocations(wallet, accountIds, cutoff) {
      assertOpen();
      walletKey(wallet);
      assertStore(Number.isSafeInteger(cutoff));
      const records = [...new Set(accountIds)].sort().flatMap((id) => {
        assertIdentifier(id);
        return queries
          .list(
            "allocation",
            (t) =>
              and(
                walletCondition(t, wallet),
                eq(t.accountId, id),
                or(
                  inArray(t.state, ["RESERVED", "EXECUTING", "PENDING_RECONCILIATION"]),
                  and(eq(t.state, "COMMITTED"), gt(t.committedAtMs, cutoff)),
                ),
              ),
            { orderBy: (t) => [asc(t.reservationId)] },
          )
          .map((row) => row.allocation);
      });
      return Object.freeze(records);
    },
    getObservation(wallet, id) {
      assertIdentifier(id);
      return (
        queries.get("observation", (t) => and(walletCondition(t, wallet), eq(t.evidenceId, id)))
          ?.observation ?? null
      );
    },
    getClock(wallet) {
      return queries.get("clock", (t) => walletCondition(t, wallet));
    },
    getFault(wallet) {
      return queries.get("fault", (t) => walletCondition(t, wallet));
    },
    getOutbox(wallet, id) {
      assertIdentifier(id);
      return queries.get("outbox", (t) => and(walletCondition(t, wallet), eq(t.eventId, id)));
    },
    listExpirable(wallet, nowMs, limit) {
      checkQuery(nowMs, limit);
      return queries.list(
        "reservation",
        (t) => and(walletCondition(t, wallet), eq(t.state, "RESERVED"), lte(t.expiresAtMs, nowMs)),
        { orderBy: (t) => [asc(t.expiresAtMs), asc(t.reservationId)], limit },
      );
    },
    listOrphans(wallet, beforeMs, limit) {
      checkQuery(beforeMs, limit, true);
      const reservations = DRIZZLE_TABLES.reservation;
      const executions = queries.list(
        "execution",
        (t) =>
          and(
            walletCondition(t, wallet),
            lte(t.claimedAtMs, beforeMs),
            exists(
              new QueryBuilder()
                .select({ id: reservations.reservationId })
                .from(reservations)
                .where(
                  and(
                    eq(reservations.ownerId, t.ownerId),
                    eq(reservations.walletId, t.walletId),
                    eq(reservations.reservationId, t.reservationId),
                    eq(reservations.state, "EXECUTING"),
                  ),
                ),
            ),
          ),
        { orderBy: (t) => [asc(t.claimedAtMs), asc(t.reservationId)], limit },
      );
      return Object.freeze(
        executions.map((execution) => {
          const reservation = queries.get("reservation", (t) =>
            and(
              scopeCondition(t, execution.binding.scope),
              eq(t.reservationId, execution.binding.reservationId),
            ),
          );
          assertStore(reservation !== null && reservation.executionId === execution.executionId);
          return reservation;
        }),
      );
    },
    listDeliverable(wallet, nowMs, limit) {
      checkQuery(nowMs, limit);
      const events = DRIZZLE_TABLES.event;
      return queries.list(
        "outbox",
        (t) =>
          and(
            walletCondition(t, wallet),
            or(eq(t.state, "PENDING"), and(eq(t.state, "CLAIMED"), lte(t.leaseExpiresAtMs, nowMs))),
          ),
        {
          orderBy: (t) => {
            const sequence = new QueryBuilder()
              .select({ sequence: events.sequence })
              .from(events)
              .where(
                and(
                  eq(events.ownerId, t.ownerId),
                  eq(events.walletId, t.walletId),
                  eq(events.eventId, t.eventId),
                ),
              );
            return [sql`(${sequence})`];
          },
          limit,
        },
      );
    },
  } satisfies LedgerReadView);
}
