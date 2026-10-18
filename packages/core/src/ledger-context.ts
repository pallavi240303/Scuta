/** @file Shared coordinator checks for trusted time, immutable results and complete atomic batches. */
import type { LedgerDependencies } from "./ledger.js";
import { LedgerError, type LedgerChanges, type LedgerReadView } from "./ledger-store.js";
import type {
  WalletScope,
  WalletConfiguration,
  LedgerResult,
  IntentRecord,
  LedgerStatus,
} from "./ledger-contracts.js";
import { validateLedgerInteger } from "./ledger-validation.js";
import { validateIdentifier, validateObject } from "./validation.js";

/** Copy wallet identity from a structurally compatible trusted configuration or scope.
 * @param value - Inert wallet, full scope or wallet configuration.
 * @returns Independently owned wallet labels.
 */
export function readWalletScope(value: WalletScope): WalletScope {
  const raw = validateObject(
    value,
    [
      "ownerId",
      "walletId",
      "agentId",
      "delegationId",
      "network",
      "asset",
      "signerId",
      "reservationTtlMs",
      "executionTtlMs",
      "orphanAfterMs",
    ],
    "wallet",
  );
  return Object.freeze({
    ownerId: validateIdentifier(raw.ownerId, "wallet.ownerId"),
    walletId: validateIdentifier(raw.walletId, "wallet.walletId"),
  });
}

/** Require the authoritative configuration before reading financial state.
 * @param view - Current transaction snapshot.
 * @param wallet - Trusted wallet identity.
 * @returns Existing immutable configuration.
 */
export function requireLedgerWallet(
  view: LedgerReadView,
  wallet: WalletScope,
): WalletConfiguration {
  const configuration = view.getWallet(wallet);
  if (!configuration) throw new LedgerError("CONFIGURATION_MISSING");
  return configuration;
}

/** Read trusted time without moving its persisted high-water mark.
 * @param dependencies - Host clock capability.
 * @param view - Same-transaction clock snapshot.
 * @param wallet - Time namespace.
 * @returns Checked nonregressing transaction time.
 */
export function readLedgerTime(
  dependencies: LedgerDependencies,
  view: LedgerReadView,
  wallet: WalletScope,
): number {
  const nowMs = validateLedgerInteger(dependencies.now(), "nowMs");
  const clock = view.getClock(wallet);
  if (clock && nowMs < clock.highWaterMs) throw new LedgerError("CLOCK_REGRESSION");
  return nowMs;
}

/** Increment a bounded revision or event sequence without rounding.
 * @param previous - Current nonnegative counter.
 * @returns The next exact safe integer.
 */
export function nextLedgerCounter(previous: number): number {
  validateLedgerInteger(previous, "counter");
  if (previous === Number.MAX_SAFE_INTEGER) throw new LedgerError("COUNTER_EXHAUSTED");
  return previous + 1;
}

/** Build a complete batch without exposing partial store mutations to callers.
 * @param changes - Collections participating in this atomic operation.
 * @returns All required collections, with absent ones empty.
 */
export function ledgerChanges(changes: Partial<LedgerChanges>): LedgerChanges {
  return {
    wallets: [],
    policies: [],
    delegations: [],
    budgets: [],
    intents: [],
    reservations: [],
    allocations: [],
    executions: [],
    observations: [],
    events: [],
    outbox: [],
    clocks: [],
    faults: [],
    ...changes,
  };
}

/** Wrap a successful immutable coordinator result.
 * @param value - Independently owned validated value.
 * @returns Explicit successful result.
 */
export function ledgerSuccess<T>(value: T): LedgerResult<T> {
  return Object.freeze({ ok: true, value });
}

/** Assemble original provenance and current lifecycle in one scoped snapshot.
 * @param view - One authoritative read or write transaction.
 * @param intent - Original scoped purchase.
 * @returns Immutable current status, with no expiry or financial mutation.
 */
export function readLedgerStatus(view: LedgerReadView, intent: IntentRecord): LedgerStatus {
  const reservation =
    intent.reservationId === null ? null : view.getReservation(intent.scope, intent.reservationId);
  if (intent.reservationId !== null && reservation === null) throw new LedgerError("STORE_CORRUPT");
  const execution = reservation?.executionId
    ? view.getExecution(intent.scope, reservation.executionId)
    : null;
  if (reservation?.executionId && execution === null) throw new LedgerError("STORE_CORRUPT");
  return Object.freeze({ ...intent, reservation, execution });
}
