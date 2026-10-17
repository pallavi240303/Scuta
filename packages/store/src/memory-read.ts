/** @file Lifetime-checked scoped reads and bounded deterministic worker queries. */
import type { LedgerReadView, WalletScope, TrustedScope } from "@scuta/core";
import {
  assertInteger,
  assertStore,
  recordKey,
  scopeKey,
  snapshot,
  walletKey,
  type MemoryState,
} from "./memory-state.js";

/** Compare wallet ownership without accepting a caller-selected namespace shortcut.
 * @param first - Stored owner.
 * @param second - Requested owner.
 * @returns Whether both wallet tuples match.
 */
function sameWallet(first: WalletScope, second: WalletScope): boolean {
  return walletKey(first) === walletKey(second);
}

/** Copy only a record belonging to the full requested principal.
 * @param record - Candidate record.
 * @param scope - Requested full scope.
 * @returns An independent snapshot or null without cross-scope disclosure.
 */
function scoped<T extends { readonly scope: TrustedScope }>(
  record: T | undefined,
  scope: TrustedScope,
): T | null {
  return record && scopeKey(record.scope) === scopeKey(scope) ? snapshot(record) : null;
}

/** Validate a bounded worker query.
 * @param time - Trusted inclusive boundary.
 * @param limit - Maximum returned records, from one to one thousand.
 * @param signedBoundary - Whether a calculated cutoff may precede epoch zero.
 * @throws {LedgerError} If query bounds are invalid.
 */
function assertQuery(time: number, limit: number, signedBoundary = false): void {
  assertStore(Number.isSafeInteger(time));
  if (!signedBoundary) assertInteger(time);
  assertInteger(limit, true);
  assertStore(limit <= 1000);
}

/** Compare case-sensitive ASCII identifiers without depending on host locale.
 * @param first - First canonical identifier.
 * @param second - Second canonical identifier.
 * @returns Negative, zero or positive ordering.
 */
function compareIdentifiers(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

/** Create a read-only handle with a callback-owned lifetime gate.
 * @param current - Checked accessor for this callback's current tables.
 * @returns Frozen methods returning independently owned data.
 */
export function createReadView(current: () => MemoryState): LedgerReadView {
  return Object.freeze({
    getWallet(wallet) {
      return snapshot(current().wallets.get(walletKey(wallet)) ?? null);
    },
    getPolicy(scope) {
      return snapshot(current().policies.get(scopeKey(scope)) ?? null);
    },
    getDelegation(scope) {
      return snapshot(current().delegations.get(scopeKey(scope)) ?? null);
    },
    getBudget(wallet, accountId) {
      return snapshot(current().budgets.get(recordKey(wallet, accountId)) ?? null);
    },
    getBudgets(scope) {
      const state = current();
      scopeKey(scope);
      return snapshot(
        [...state.budgets.values()]
          .filter(
            (account) =>
              sameWallet(account.scope, scope) &&
              (account.scope.kind === "WALLET" ||
                (account.scope.agentId === scope.agentId &&
                  (account.scope.kind === "AGENT" ||
                    account.scope.delegationId === scope.delegationId))),
          )
          .sort((a, b) => compareIdentifiers(a.accountId, b.accountId)),
      );
    },
    findIntent(scope, idempotencyKey) {
      const state = current();
      scopeKey(scope);
      return snapshot(
        [...state.intents.values()].find(
          (record) =>
            scopeKey(record.scope) === scopeKey(scope) &&
            record.intent.idempotencyKey === idempotencyKey,
        ) ?? null,
      );
    },
    getIntent(scope, id) {
      return scoped(current().intents.get(recordKey(scope, id)), scope);
    },
    getReservation(scope, id) {
      return scoped(current().reservations.get(recordKey(scope, id)), scope);
    },
    getExecution(scope, id) {
      const record = current().executions.get(recordKey(scope, id));
      return record && scopeKey(record.binding.scope) === scopeKey(scope) ? snapshot(record) : null;
    },
    getAllocations(wallet, accountIds, earliestCommittedAtMs) {
      const state = current();
      assertStore(Number.isSafeInteger(earliestCommittedAtMs));
      const wanted = new Set(accountIds);
      return snapshot(
        [...state.allocations.values()]
          .filter(
            (row) =>
              sameWallet(row.wallet, wallet) &&
              wanted.has(row.allocation.accountId) &&
              (["RESERVED", "EXECUTING", "PENDING_RECONCILIATION"].includes(row.allocation.state) ||
                (row.allocation.state === "COMMITTED" &&
                  row.allocation.committedAtMs !== null &&
                  row.allocation.committedAtMs > earliestCommittedAtMs)),
          )
          .map((row) => row.allocation)
          .sort(
            (a, b) =>
              compareIdentifiers(a.accountId, b.accountId) ||
              compareIdentifiers(a.reservationId, b.reservationId),
          ),
      );
    },
    getObservation(wallet, id) {
      return snapshot(current().observations.get(recordKey(wallet, id))?.observation ?? null);
    },
    getClock(wallet) {
      return snapshot(current().clocks.get(walletKey(wallet)) ?? null);
    },
    getFault(wallet) {
      return snapshot(current().faults.get(walletKey(wallet)) ?? null);
    },
    getOutbox(wallet, id) {
      return snapshot(current().outbox.get(recordKey(wallet, id)) ?? null);
    },
    listExpirable(wallet, nowMs, limit) {
      const state = current();
      assertQuery(nowMs, limit);
      return snapshot(
        [...state.reservations.values()]
          .filter(
            (record) =>
              sameWallet(record.scope, wallet) &&
              record.state === "RESERVED" &&
              record.expiresAtMs <= nowMs,
          )
          .sort(
            (a, b) =>
              a.expiresAtMs - b.expiresAtMs || compareIdentifiers(a.reservationId, b.reservationId),
          )
          .slice(0, limit),
      );
    },
    listOrphans(wallet, beforeMs, limit) {
      const state = current();
      assertQuery(beforeMs, limit, true);
      return snapshot(
        [...state.executions.values()]
          .filter(
            (record) => sameWallet(record.binding.scope, wallet) && record.claimedAtMs <= beforeMs,
          )
          .flatMap((record) => {
            const reservation = state.reservations.get(
              recordKey(wallet, record.binding.reservationId),
            );
            return reservation?.state === "EXECUTING"
              ? [{ record: reservation, at: record.claimedAtMs }]
              : [];
          })
          .sort(
            (a, b) =>
              a.at - b.at || compareIdentifiers(a.record.reservationId, b.record.reservationId),
          )
          .slice(0, limit)
          .map((row) => row.record),
      );
    },
    listDeliverable(wallet, nowMs, limit) {
      const state = current();
      assertQuery(nowMs, limit);
      return snapshot(
        [...state.outbox.values()]
          .filter(
            (record) =>
              sameWallet(record.wallet, wallet) &&
              (record.state === "PENDING" ||
                (record.state === "CLAIMED" &&
                  record.leaseExpiresAtMs !== null &&
                  record.leaseExpiresAtMs <= nowMs)),
          )
          .sort((a, b) => {
            const first = state.events.get(recordKey(wallet, a.eventId));
            const second = state.events.get(recordKey(wallet, b.eventId));
            assertStore(first !== undefined && second !== undefined);
            return first.sequence - second.sequence;
          })
          .slice(0, limit),
      );
    },
  } satisfies LedgerReadView);
}
