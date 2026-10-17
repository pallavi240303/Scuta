/** @file Typed memory tables and snapshot helpers for the nondurable transaction adapter. */
import {
  LedgerError,
  type LedgerErrorCode,
  type WalletScope,
  type TrustedScope,
  type WalletConfiguration,
  type PolicySnapshot,
  type DelegationSnapshot,
  type BudgetAccount,
  type IntentRecord,
  type ReservationRecord,
  type AllocationMutation,
  type ExecutionRecord,
  type ObservationRecord,
  type LedgerEvent,
  type OutboxRecord,
  type WalletClockRecord,
  type WalletFaultRecord,
} from "@scuta/core";

/** Internal tables; stored records are deeply frozen and table maps are never exposed. */
export interface MemoryState {
  wallets: Map<string, WalletConfiguration>;
  policies: Map<string, PolicySnapshot>;
  policyHistory: Map<string, PolicySnapshot>;
  delegations: Map<string, DelegationSnapshot>;
  delegationHistory: Map<string, DelegationSnapshot>;
  budgets: Map<string, BudgetAccount>;
  intents: Map<string, IntentRecord>;
  reservations: Map<string, ReservationRecord>;
  allocations: Map<string, AllocationMutation>;
  executions: Map<string, ExecutionRecord>;
  observations: Map<string, ObservationRecord>;
  events: Map<string, LedgerEvent>;
  outbox: Map<string, OutboxRecord>;
  clocks: Map<string, WalletClockRecord>;
  faults: Map<string, WalletFaultRecord>;
}

/** Create empty table ownership for a new adapter.
 * @returns Independent maps with no records.
 */
export function createMemoryState(): MemoryState {
  return {
    wallets: new Map(),
    policies: new Map(),
    policyHistory: new Map(),
    delegations: new Map(),
    delegationHistory: new Map(),
    budgets: new Map(),
    intents: new Map(),
    reservations: new Map(),
    allocations: new Map(),
    executions: new Map(),
    observations: new Map(),
    events: new Map(),
    outbox: new Map(),
    clocks: new Map(),
    faults: new Map(),
  };
}

/** Copy maps without copying their immutable records.
 * @param state - Current private table set.
 * @returns Independent maps for rollback-safe writes.
 */
export function cloneMemoryState(state: MemoryState): MemoryState {
  return {
    wallets: new Map(state.wallets),
    policies: new Map(state.policies),
    policyHistory: new Map(state.policyHistory),
    delegations: new Map(state.delegations),
    delegationHistory: new Map(state.delegationHistory),
    budgets: new Map(state.budgets),
    intents: new Map(state.intents),
    reservations: new Map(state.reservations),
    allocations: new Map(state.allocations),
    executions: new Map(state.executions),
    observations: new Map(state.observations),
    events: new Map(state.events),
    outbox: new Map(state.outbox),
    clocks: new Map(state.clocks),
    faults: new Map(state.faults),
  };
}

/** Reject an invalid internal record without embedding its contents in the failure.
 * @param condition - Required invariant.
 * @param code - Fixed error category.
 * @throws {LedgerError} If the invariant is false.
 */
export function assertStore(
  condition: boolean,
  code: LedgerErrorCode = "STORE_CORRUPT",
): asserts condition {
  if (!condition) throw new LedgerError(code);
}

/** Require bounded nonnegative integer time or a positive revision/count.
 * @param value - Internal numeric value.
 * @param positive - Whether zero is forbidden.
 * @throws {LedgerError} If precision, sign or type is invalid.
 */
export function assertInteger(value: number, positive = false): void {
  assertStore(Number.isSafeInteger(value) && value >= (positive ? 1 : 0));
}

/** Validate a table identifier before constructing a key.
 * @param value - Canonical internal identifier.
 * @throws {LedgerError} If the label is malformed.
 */
export function assertIdentifier(value: string): void {
  assertStore(
    typeof value === "string" &&
      value.length <= 64 &&
      /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value) &&
      !value.endsWith("\n"),
  );
}

/** Build an unambiguous owner/wallet namespace.
 * @param wallet - Trusted wallet labels, not authentication.
 * @returns A canonical tuple key.
 * @throws {LedgerError} If an identifier is malformed.
 */
export function walletKey(wallet: WalletScope): string {
  assertIdentifier(wallet.ownerId);
  assertIdentifier(wallet.walletId);
  return JSON.stringify([wallet.ownerId, wallet.walletId]);
}

/** Build an unambiguous full principal/delegation namespace.
 * @param scope - Trusted full scope labels.
 * @returns A canonical tuple key.
 * @throws {LedgerError} If an identifier is malformed.
 */
export function scopeKey(scope: TrustedScope): string {
  walletKey(scope);
  assertIdentifier(scope.agentId);
  assertIdentifier(scope.delegationId);
  return JSON.stringify([scope.ownerId, scope.walletId, scope.agentId, scope.delegationId]);
}

/** Build a wallet-local primary key.
 * @param wallet - Record owner.
 * @param id - Local record identity.
 * @returns An unambiguous composite key.
 * @throws {LedgerError} If a namespace or identifier is invalid.
 */
export function recordKey(wallet: WalletScope, id: string): string {
  assertIdentifier(id);
  return JSON.stringify([walletKey(wallet), id]);
}

/** Copy inert boundary data while rejecting accessors, cycles and custom prototypes.
 * @param value - Primitive, record or dense array to copy.
 * @param ancestors - Current traversal path for cycle rejection.
 * @returns An independently owned deeply frozen copy.
 * @throws {LedgerError} If data is executable, cyclic or nonstandard.
 */
function copyInert(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || ["string", "number", "bigint", "boolean"].includes(typeof value))
    return value;
  assertStore(typeof value === "object" && value !== null);
  const prototype: unknown = Object.getPrototypeOf(value);
  assertStore(
    Array.isArray(value)
      ? prototype === Array.prototype
      : prototype === Object.prototype || prototype === null,
  );
  assertStore(!ancestors.has(value));
  ancestors.add(value);
  if (Array.isArray(value)) {
    assertStore(Reflect.ownKeys(value).length === value.length + 1);
    const copied: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      assertStore(descriptor !== undefined && "value" in descriptor);
      const child: unknown = descriptor.value;
      copied.push(copyInert(child, ancestors));
    }
    ancestors.delete(value);
    return Object.freeze(copied);
  }
  const copied: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    assertStore(typeof key === "string");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assertStore(descriptor !== undefined && "value" in descriptor);
    const child: unknown = descriptor.value;
    Object.defineProperty(copied, key, { value: copyInert(child, ancestors), enumerable: true });
  }
  ancestors.delete(value);
  return Object.freeze(copied);
}

/** Copy a record or collection and freeze it without freezing caller-owned objects.
 * @param value - Inert typed store data.
 * @returns Independent immutable data preserving bigint values.
 * @throws {LedgerError} If record data is not inert.
 */
export function snapshot<T>(value: T): T {
  return copyInert(value, new WeakSet()) as T;
}
