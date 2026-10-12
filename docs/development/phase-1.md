# Scuta Phase 1 — Ledger and Reservation Design

Status: proposed design, awaiting maintainer review. No Phase 1 code is implemented. This is the single Phase 1 design and outcome record; implementation tasks and actual evidence will be added after design approval.

On 12 October 2026, the maintainer confirmed SQLite for the initial reference. The ledger contracts and lifecycle below still require design review; this database choice does not imply approval of an implementation plan.

[Project objective](../how-scuta-works.md#1-objective-and-success-criteria) · [System invariants](../core-authorization-design.md#3-invariants) · [Roadmap](../core-authorization-design.md#17-implementation-phases)

## Intent and expected outcome

Replace stateless financial admission with durable, atomic budget reservations. A request must fit every applicable budget, retries must preserve one identity, and potentially executed payments must remain exposure until a trusted reconciliation result resolves them.

Phase 0's evaluator and digest domains remain unchanged. This phase adds a trusted ledger coordinator and storage adapters around those contracts. It does not add HTTP authentication, a signer, a payment provider, human approval delivery, behavioral adaptation, benchmarks or demo polish.

Expected outcome: the memory and SQLite adapters satisfy the same lifecycle tests; file-backed SQLite additionally passes independent-process concurrency and restart/crash tests. These demonstrate accounting under the stated trust model, not real-fund safety or distributed exactly-once payment execution.

## Selected approach and boundaries

Use a SQLite-backed reference ledger and a memory test double behind one synchronous transaction contract. A memory-first prototype would simplify early setup but postpone the important durable/concurrent checks. A database-only implementation would reduce initial adapters but couple tests to persistence. The selected shared coordinator keeps admission and transition rules in one place while exercising both adapters.

The ledger is trusted service-side code. Its caller supplies already authenticated scope; labels and TypeScript types do not authenticate anyone. Agents must never receive the database, transaction runner, configuration methods or reconciliation methods. Gateway credential isolation is Phase 2, not a Phase 1 claim.

One configured network/asset per wallet, exact transfer amount, and no agent-funded fees. The reserved maximum debit therefore equals the validated intent amount. Fees, multiple assets and task-scoped budgets require later reviewed contracts; no cross-asset arithmetic is allowed.

## Package and file responsibilities

| Location                                | Responsibility                                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/ledger-contracts.ts` | Validated configuration, ledger inputs/results, reservation states, execution and reconciliation contracts.          |
| `packages/core/src/budget.ts`           | Pure bigint exposure, rolling-window and headroom calculations.                                                      |
| `packages/core/src/reservation.ts`      | Pure allowed-state transitions and expiry checks.                                                                    |
| `packages/core/src/ledger.ts`           | Trusted coordinator using an injected transaction runner, clock and ID generator; no SQLite or provider imports.     |
| `packages/core/test/`                   | New ledger tests and deterministic fixtures. Existing source-adjacent tests remain unchanged in this phase's design. |
| `packages/store/src/memory-store.ts`    | Transactional test double with rollback; not a durable deployment.                                                   |
| `packages/store/src/sqlite-store.ts`    | Bun SQLite connection, prepared statements, synchronous immediate transactions and bounded contention handling.      |
| `packages/store/src/migrations.ts`      | Ordered, checksummed migrations and schema-version rejection.                                                        |
| `packages/store/src/row-codecs.ts`      | Runtime validation and decimal-text decoding of persisted rows.                                                      |
| `packages/store/test/`                  | Adapter contract, real SQLite, independent-process and crash tests; worker fixtures are not test entry files.        |

Private `@scuta/store` depends on the built `@scuta/core`. Build core before store; verify both emitted entry points. Keep product code, tests and examples in TypeScript, precise JSDoc above functions/types and file overviews. No ORM, additional package manager, public package publication or speculative package scaffolding.

## Amounts, time and budgets

Persist money as canonical decimal `TEXT`; validate each row and decode to bounded `bigint`. Never use SQLite `SUM`, integer casts, lexical ordering or floating-point arithmetic for money. Individual amounts and ceilings retain the core's unsigned 256-bit bound; aggregate calculations use bigint and are not truncated to that bound.

Payment amounts remain strictly positive. Budget ceilings may be zero to close admission; negative or out-of-range values are invalid. Windows and configured TTLs are positive safe-integer milliseconds. Expiry calculations must preserve safe-integer precision and cannot extend an intent or delegation deadline.

The injected trusted clock is read inside each transaction. Times are nonnegative safe-integer milliseconds. Persist a high-water mark: a mutating operation with an earlier time fails with `CLOCK_REGRESSION`, without freeing holds. This prevents backwards clocks from creating false window or expiry results. Read-only status remains available. Clock integrity is a host assumption.

Each wallet has a mandatory wallet budget; configured agent/delegation budgets are additional constraints. Membership comes from trusted persisted scope configuration, never an agent-supplied budget list. Account identity, network/asset, scope and window duration are immutable. Initially configure membership before accepting any intent; adding/removing accounts with history is deferred. Owner-authorized ceiling updates use revisions on the same account, preserving its history and holds.

For each applicable account at time `now`:

```text
spent = committed allocations booked in (now - windowMs, now]
held = allocations in RESERVED, EXECUTING or PENDING_RECONCILIATION
headroom = max(0, ceiling - spent - held)
```

Commit booking time is the trusted reconciliation transaction time, not a caller's backdated timestamp. It conservatively starts the rolling-spend window when settlement is recorded. Provider settlement time is separate future evidence metadata. All unresolved holds count regardless of age or original admission window. Lowering a ceiling below exposure yields zero new headroom; it does not erase obligations.

## Persisted records and ownership

| Record                               | Required protection                                                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Schema migrations                    | Ordered version and checksum; reject unknown/newer or altered applied migrations.                                           |
| Policy snapshots and active pointers | Immutable validated wire snapshot/digest per policy ID/version; scope-bound activation; conflicting version reuse rejected. |
| Delegation snapshots                 | Scope, capabilities, expiry, revocation and monotonic revision; changes affect later claims.                                |
| Budget accounts                      | Stable account identity, scope, profile, window, ceiling and revision.                                                      |
| Payment intents                      | Unique `(ownerId, walletId, agentId, delegationId, idempotencyKey)` and canonical digest; original evaluation retained.     |
| Reservations and allocations         | One reservation per admitted intent; maximum debit allocated to every applicable account.                                   |
| Executions                           | Unique reservation ID and wallet/profile/nonce; immutable execution binding persisted before any future signing.            |
| Reconciliation observations          | Evidence identity and canonical content binding; duplicates cannot repeat a financial transition.                           |
| Decision events and outbox           | Ordered event sequence and unique delivery identity; append with each financial mutation.                                   |
| Ledger faults and clock state        | Persistent wallet-scoped containment flag and mutation-time high-water mark.                                                |

Keep financial history and used-key tombstones for the entire phase; garbage collection is not implemented. Reject malformed persisted financial rows rather than treating them as zero or silently rebuilding a safe state.

## Coordinator contract

The transaction runner executes a synchronous callback to completion, committing all changes or rolling back all of them. Promises/thenables are rejected; no asynchronous work or network call may occur within it. The coordinator exposes separate roles, not a generic agent-accessible `commit` or `release` API.

Transaction handles are valid only during their callback and are invalidated on return, rollback or failure. A rejected asynchronous callback must not be able to resume and write through its old handle. Nested coordinator transactions are rejected. Returned records are immutable, independently owned snapshots, not mutable adapter state.

| Operation                                      | Input and result                                                                                                                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trusted configuration                          | Activate validated policy/delegation snapshots, initialize budgets and update ceilings/revocation. No agent authorization is provided by this internal interface.                                                       |
| `authorize`                                    | Trusted scope plus `PaymentIntentWire`; load current snapshots in the transaction, evaluate and return original decision plus current status. Outcomes are reserved, denied or approval-required without a reservation. |
| `getStatus`                                    | Trusted full scope plus intent/reservation ID; reject cross-scope access without revealing another record's existence. No expiry or other mutation on read.                                                             |
| `claimExecution`                               | Trusted scope, reservation ID and normalized internal execution binding; atomically create one execution or return its existing binding. Never accept a replacement purchase from the agent.                            |
| `cancelUnclaimed` / `expireUnclaimed`          | Cancel a scope-owned RESERVED hold or expire it at its trusted deadline. Cannot release a claimed hold.                                                                                                                 |
| `markUncertain` / orphan recovery              | Move EXECUTING to PENDING_RECONCILIATION without reducing exposure; recovery identifies old executions by a configured stale threshold.                                                                                 |
| `recordSettlement` / `recordFinalNonExecution` | Internal, adapter-validated normalized observation tied to the execution; commit or release exactly once. Phase 1 uses trusted test evidence, not provider verification.                                                |
| Durable outbox handling                        | Claim delivery using a bounded lease/fence, acknowledge the matching claim, or redeliver the same event after expiry. Delivery does not change financial exposure.                                                      |

Malformed input throws a redacted validation error. Ordinary denials and lifecycle conflicts use explicit result unions; exhausted database contention is `STORE_BUSY`, not an ALLOW or a budget denial. Required budget/configuration absence fails closed. Exact TypeScript signatures and validators will be pinned in the implementation tasks after this design is approved.

## Atomic authorization flow

1. Validate inert wire input and trusted scope; begin the serialized transaction and read trusted time.
2. Look up the scoped retry key. Same digest returns the original evaluation and current lifecycle without extending expiry or changing exposure. Different digest returns `IDEMPOTENCY_CONFLICT`; never overwrite the original purchase. Deduplicate repeated conflict events by stored intent and conflicting digest.
3. Load active policy/delegation and applicable budget accounts from the authoritative store. Run Phase 0 evaluation against this snapshot, not a caller-supplied earlier ALLOW.
4. Persist a hard denial without allocations. Otherwise compute exposure for every applicable budget; insufficient headroom produces a persisted budget denial without partial allocations.
5. A static REQUIRE_APPROVAL is persisted as a non-executable result with no hold. Approval admission, queue bounds and PENDING_APPROVAL are deferred together to Phase 3; retries cannot turn this old request into an executable one.
6. For ALLOW, create one RESERVED record and all allocations. Expiry is the earliest of intent expiry, delegation expiry and trusted configured reservation TTL.
7. Persist evaluation provenance, reservation and event/outbox records in the same transaction; return only after commit.

Even denied/approval-required logical requests retain their retry identities. A later policy change does not revive them; the caller submits a new logical request when appropriate. Reads/retries do not double-count logical activity.

## Claims, outcomes and recovery

| From                               | Permitted transition                                     | Exposure effect                                                             |
| ---------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------- |
| RESERVED                           | EXECUTING after current-state revalidation               | Hold retained.                                                              |
| RESERVED                           | RELEASED on cancellation/stale permission                | Unclaimed hold removed.                                                     |
| RESERVED                           | EXPIRED at the exact trusted deadline                    | Unclaimed hold removed.                                                     |
| EXECUTING                          | PENDING_RECONCILIATION on uncertainty or orphan recovery | Hold retained.                                                              |
| EXECUTING / PENDING_RECONCILIATION | COMMITTED on matching verified settlement                | Hold replaced atomically by exact committed debit in all original accounts. |
| EXECUTING / PENDING_RECONCILIATION | RELEASED on verified final non-execution                 | Hold removed only with matching trusted evidence.                           |

Claim revalidates the active policy digest, delegation revision/capability, profile, intent/hold expiry, autonomous permission and current budget ceilings including the reservation's own hold once. A stale or newly disallowed unclaimed reservation is cancelled atomically; no new approval is silently substituted. Repeating an existing execution returns its status without granting fresh permission or allocating another nonce.

The internal execution binding contains execution identity, reservation/intent binding, signer identity, profile, wallet, recipient, exact amount, nonce, bounded validity and immutable payload bytes/digest. Reject a financial mismatch; recompute the payload digest. Bind validity to current intent/delegation expiry and a trusted maximum. No signature or network call exists in Phase 1. The Phase 2 adapter must additionally prove that the payload actually encodes these financial fields for its selected protocol.

Settlement/non-execution observations must match the entire stored execution identity and financial binding. Matching duplicate terminal observations return the existing result with no new debit/event. Conflicting terminal observations or reused evidence with different content record a durable ledger fault and block new reservations/claims for the affected wallet. Status/reconciliation remain possible; automated repair is deferred. Fault results must commit their containment records rather than throw inside the transaction and accidentally roll them back.

A generic timeout, expired execution lease, resource error, TTL or agent report never proves non-payment. An unclaimed-expiry worker cannot touch EXECUTING or PENDING_RECONCILIATION. Adapter authenticity, complete history and finality verification are Phase 2+ prerequisites; typed evidence alone does not prove them.

## SQLite choice and transactional behavior

Use the built-in `bun:sqlite` driver with the pinned Bun toolchain: no native addon installation or new driver dependency. Its synchronous transaction functions fit the bounded local coordinator. Node runtime portability and ORM abstractions are not promised. SQLite's integer range is narrower than the core amount range, motivating decimal text rather than direct bigint binding. See [Bun SQLite](https://bun.sh/docs/api/sqlite).

Use a local file with WAL, `synchronous=FULL`, enabled foreign keys and validated schema. Use `BEGIN IMMEDIATE` for read-check-write admission, claims, transitions, configuration and migrations. SQLite serializes writers; an immediate transaction acquires write ownership before reading admission state. See [SQLite isolation](https://www.sqlite.org/isolation.html) and [transaction behavior](https://www.sqlite.org/lang_transaction.html).

Set a 50 ms busy timeout and allow at most three whole-transaction attempts on busy errors, with no external side effects or partial retry. After rollback, retries reread authoritative state and clock. These are initial bounded implementation settings, not performance results. A failure to establish required database settings is an initialization error. Network filesystems, independent database copies and multi-host admission are unsupported.

## Acceptance tests

Use deterministic IDs/clocks and temporary databases. Memory contract tests do not substitute for file-backed, separate-connection/process checks.

| Case                           | Required result                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact arithmetic               | Round trip 2^53+1 and the core maximum as text; reject invalid/corrupt rows; no rounding or SQL integer overflow.                                                               |
| Shared race                    | Two simultaneous requests for 70 against a wallet budget of 100: exactly one hold, one budget denial, no partial debit/event. Repeat using different agents and processes.      |
| Multiple budgets               | Wallet has room but agent/delegation does not: deny with no allocation in any account.                                                                                          |
| Retry identity                 | Concurrent same-key/same-purchase requests return one intent/reservation. Changed purchase conflicts; another authenticated scope cannot read or mutate the first.              |
| Boundaries                     | Exact ceiling admitted; one unit above rejected. Spend at the rolling lower boundary excluded; an old unresolved hold still included.                                           |
| Reduced ceiling                | Existing holds survive a lower ceiling; no new admission, and a now-unsafe unclaimed execution cannot proceed.                                                                  |
| Claim versus expiry/revocation | One ordered transition wins; no execution after a prior expiry/revocation, no duplicate identity and no TTL release after claim.                                                |
| Persistence                    | Close/reopen and terminate/restart processes: holds, original decisions, nonces and outbox identities survive.                                                                  |
| Rollback/crash                 | Inject failure between state/event writes; kill a process before commit and after commit-before-response. Observe either all effects or none, then recover by retry key.        |
| Reconciliation                 | Settlement and final non-execution affect allocations exactly once. Unknown/timeouts retain exposure. Mismatched evidence cannot release it; contradictions contain the wallet. |
| Outbox                         | Expired leases redeliver the same event; stale fencing acknowledgments fail; financial state does not change with delivery retries.                                             |
| Contention/corruption          | Bounded STORE_BUSY, rejected async transaction callbacks, changed migration checksum, invalid stored data and clock regression all fail closed.                                 |

Also test zero budget ceilings, overflow-safe deadlines, retained/expired transaction handles and caller mutation of returned snapshots. Rejected async callbacks must leave no writes, including after a queued continuation resumes.

Map tests to INV-01 through INV-11 where applicable. INV-12 behavioral/operator freeze semantics arrive later; this phase proves only revocation ordering and ledger-fault containment. Tests exercise interfaces and outcomes, not coverage percentages alone.

## Implementation and release gate

After approval, add bite-sized TDD tasks here for contracts and arithmetic, adapter transactions/migrations, admission, claims/reconciliation, outbox/recovery and cross-process verification. Add store build/type/export checks and ensure test discovery and coverage inventory include both packages without weakening existing checks.

Required evidence: frozen installation, full build/format/lint/type checks, core/store test inventories, existing static digest fixtures, store smoke checks and Linux CI results when available. Record exact commands, failed probes, actual outcomes and remaining limitations in this file. No implementation, passing Phase 1 tests, benchmark results or security proof is claimed yet.

## Design verification — 12 October 2026

Self-review clarified zero budget ceilings, deadline precision, transaction-handle lifetime and the distinction between Phase 1 approval-required decisions and Phase 3 approval holds. Formatting and whitespace checks passed; all three local links and their headings resolve. The design contains the eleven required design sections and no unresolved TODO/TBD placeholders. No product files or dependencies changed, and no runtime or Phase 1 tests were run for this documentation-only draft.
