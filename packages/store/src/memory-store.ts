/** @file Nondurable transaction test adapter, not a deployment or payment authority. */
import {
  LedgerError,
  type LedgerStore,
  type LedgerTransaction,
  type LedgerReadView,
} from "@scuta/core";
import { cloneMemoryState, createMemoryState, snapshot, type MemoryState } from "./memory-state.js";
import { createReadView } from "./memory-read.js";
import { applyMemoryChanges } from "./memory-write.js";

/** Create an isolated transactional memory store.
 * @returns A fresh synchronous internal store with no persistence.
 */
export function createMemoryStore(): LedgerStore {
  let committed = createMemoryState();
  let closed = false;
  let active = false;

  /** Run one lifetime-owned synchronous callback and publish changes only after success.
   * @param operation - Internal callback without network or async work.
   * @param writable - Whether a write handle is exposed.
   * @returns The callback result after successful commit or read.
   * @throws {LedgerError} If closed, nested, async, or a write failed.
   */
  function run<T>(
    operation: (view: LedgerTransaction | LedgerReadView) => T,
    writable: boolean,
  ): T {
    if (closed) throw new LedgerError("TRANSACTION_CLOSED");
    if (active) throw new LedgerError("NESTED_TRANSACTION");
    active = true;
    let open = true;
    let failed: { error: unknown } | null = null;
    let working = writable ? cloneMemoryState(committed) : committed;

    /** Return this callback's state only while its handle remains usable.
     * @returns Current private maps.
     * @throws {LedgerError} If the callback ended or a write failed.
     */
    function current(): MemoryState {
      if (!open) throw new LedgerError("TRANSACTION_CLOSED");
      if (failed) throw failed.error;
      return working;
    }
    const readView = createReadView(current);
    const view: LedgerReadView | LedgerTransaction = writable
      ? Object.freeze({
          ...readView,
          apply(changes) {
            const candidate = cloneMemoryState(current());
            try {
              applyMemoryChanges(candidate, snapshot(changes));
              working = candidate;
            } catch (error) {
              failed = { error };
              throw error;
            }
          },
        } satisfies LedgerTransaction)
      : readView;
    try {
      const result = operation(view);
      if (
        result !== null &&
        (typeof result === "object" || typeof result === "function") &&
        "then" in result &&
        typeof result.then === "function"
      ) {
        if (result instanceof Promise) void result.catch(() => {});
        throw new LedgerError("ASYNC_TRANSACTION");
      }
      current();
      if (writable) committed = working;
      return result;
    } finally {
      open = false;
      active = false;
    }
  }
  return Object.freeze({
    transaction<T>(operation: (tx: LedgerTransaction) => T): T {
      return run((view) => {
        if (!("apply" in view)) throw new LedgerError("STORE_CORRUPT");
        return operation(view);
      }, true);
    },
    read<T>(operation: (tx: LedgerReadView) => T): T {
      return run(operation, false);
    },
    close() {
      if (active) throw new LedgerError("NESTED_TRANSACTION");
      closed = true;
      committed = createMemoryState();
    },
  });
}
