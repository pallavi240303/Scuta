/** @file Events, delivery work and trusted clock advance committed with each coordinator mutation. */
import type { LedgerDependencies } from "./ledger.js";
import type { LedgerChanges, LedgerTransaction } from "./ledger-store.js";
import type { WalletScope, LedgerEvent, LedgerEventKind } from "./ledger-contracts.js";
import { ledgerChanges, nextLedgerCounter } from "./ledger-context.js";
import { validateIdentifier } from "./validation.js";

/** Coordinator-owned event content; a deterministic ID deduplicates conflicting retry evidence. */
interface LedgerEventInput {
  readonly kind: LedgerEventKind;
  readonly subjectId: string;
  readonly reason?: string;
  readonly eventId?: string;
}

/** Append one ordered event and its pending delivery record in the financial transaction.
 * @param dependencies - Trusted opaque ID producer.
 * @param tx - Owning write transaction.
 * @param wallet - Immutable wallet identity.
 * @param nowMs - Checked transaction time.
 * @param event - Event content; an explicit ID supports conflict deduplication.
 * @param changes - Financial or configuration changes committed with this event.
 */
export function applyLedgerEvent(
  dependencies: LedgerDependencies,
  tx: LedgerTransaction,
  wallet: WalletScope,
  nowMs: number,
  event: LedgerEventInput,
  changes: Partial<LedgerChanges>,
): void {
  const record: LedgerEvent = {
    eventId: validateIdentifier(event.eventId ?? dependencies.createId(), "eventId"),
    wallet,
    sequence: nextLedgerCounter(tx.getLatestEvent(wallet)?.sequence ?? 0),
    kind: event.kind,
    subjectId: event.subjectId,
    occurredAtMs: nowMs,
    reason: event.reason ?? null,
  };
  tx.apply(
    ledgerChanges({
      ...changes,
      events: [record],
      outbox: [
        {
          record: {
            eventId: record.eventId,
            wallet,
            state: "PENDING",
            workerId: null,
            claimToken: null,
            leaseExpiresAtMs: null,
          },
          expectedState: null,
          expectedClaimToken: null,
        },
      ],
      clocks: [
        {
          record: { wallet, highWaterMs: nowMs },
          expectedHighWaterMs: tx.getClock(wallet)?.highWaterMs ?? null,
        },
      ],
    }),
  );
}
