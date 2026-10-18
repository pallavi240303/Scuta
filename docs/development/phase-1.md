# Scuta Phase 1 — Ledger and Reservation Design

Status: design and implementation plan approved on 12 October 2026; native implementation with independent subagent review selected. Phase 1 implementation is in progress. This is the single Phase 1 design, implementation and outcome record.

The maintainer approved SQLite and the plan on 12 October 2026. Tasks 1–4 and the startup-timeout repair are committed through `9d696b8`. Task 5 trusted configuration/atomic admission and the requested store-only Drizzle refactor are implemented, independently reviewed and verified locally; no new commit is authorized. Execution claims, reconciliation, recovery/outbox workers and process race/crash verification remain pending. See the [latest Task 5 record](#task-5--trusted-configuration-and-atomic-admission); earlier audit sections preserve their checkpoint context.

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

| Location                                | Responsibility                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/ledger-contracts.ts` | Validated configuration, ledger inputs/results, reservation states, execution and reconciliation contracts.      |
| `packages/core/src/budget.ts`           | Pure bigint exposure, rolling-window and headroom calculations.                                                  |
| `packages/core/src/reservation.ts`      | Pure allowed-state transitions and expiry checks.                                                                |
| `packages/core/src/ledger.ts`           | Trusted coordinator using an injected transaction runner, clock and ID generator; no SQLite or provider imports. |
| `packages/core/test/`                   | Static-policy and ledger tests with deterministic fixtures, separate from product sources.                       |
| `packages/store/src/memory-store.ts`    | Transactional test double with rollback; not a durable deployment.                                               |
| `packages/store/src/sqlite-store.ts`    | Bun SQLite connection, prepared statements, synchronous immediate transactions and bounded contention handling.  |
| `packages/store/src/migrations.ts`      | Ordered, checksummed migrations and schema-version rejection.                                                    |
| `packages/store/src/row-codecs.ts`      | Runtime validation and decimal-text decoding of persisted rows.                                                  |
| `packages/store/test/`                  | Adapter contract, real SQLite, independent-process and crash tests; worker fixtures are not test entry files.    |

Private `@scuta/store` depends on the built `@scuta/core`. Build core before store; verify both emitted entry points. Keep product code, tests and examples in TypeScript, precise JSDoc above functions/types and file overviews. The maintainer subsequently selected Drizzle for store-only typed record queries; retain checked DDL/migrations and the core transaction port. No additional package manager, public package publication or speculative package scaffolding.

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

Use the built-in `bun:sqlite` driver with the pinned Bun toolchain: no native addon installation or new driver dependency. Its synchronous transaction functions fit the bounded local coordinator. Node runtime portability is not promised. The maintainer-selected Drizzle query layer wraps this driver without replacing checked migrations, row decoding or native transaction ownership. SQLite's integer range is narrower than the core amount range, motivating decimal text rather than direct bigint binding. See [Bun SQLite](https://bun.sh/docs/api/sqlite).

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

The implementation plan below pins bite-sized TDD tasks for contracts and arithmetic, adapter transactions/migrations, admission, claims/reconciliation, outbox/recovery and cross-process verification. Execute it only after plan review. Store build/type/export checks and source inventory must include both packages without weakening existing checks.

Required evidence: frozen installation, full build/format/lint/type checks, core/store test inventories, existing static digest fixtures, store smoke checks and Linux CI results when available. Record exact commands, failed probes, actual outcomes and remaining limitations in this file. This gate describes the complete phase; Tasks 1–2 evidence below does not establish durable-store or financial-enforcement guarantees.

## Design verification — 12 October 2026

Self-review clarified zero budget ceilings, deadline precision, transaction-handle lifetime and the distinction between Phase 1 approval-required decisions and Phase 3 approval holds. Formatting and whitespace checks passed; all three local links and their headings resolve. The design contains the eleven required design sections and no unresolved TODO/TBD placeholders. No product files or dependencies changed, and no runtime or Phase 1 tests were run for this documentation-only draft.

# Phase 1 Ledger Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` for native implementation, or `superpowers:subagent-driven-development` if the maintainer selects delegated implementation. Execute task-by-task with test-first checks; do not skip the maintainer's plan review.

**Goal:** Implement durable, atomic reservations and recoverable financial exposure without adding a signer or claiming payment enforcement.

**Architecture:** One trusted coordinator in core uses a synchronous transaction port. Memory and SQLite adapters implement the same port; lifecycle and admission rules are not duplicated in adapters. Financial changes, decisions and outbox work commit together.

**Tech stack:** Bun 1.3.14, TypeScript 6.0.3, Bun tests and strict tooling; built-in `bun:sqlite`, standard `node:crypto`, and maintainer-selected `drizzle-orm@0.45.4` confined to store queries. The original no-ORM choice is superseded; the checked physical schema remains unchanged.

**Spec:** The design sections above in this same file, plus the linked canonical invariants. The single-file layout preserves the maintainer's phase-tracking preference.

## Global constraints

- Continue on `feat/atomic-budget-reservations`; do not push, create a PR or change `feat/static-policy-evaluation` without authorization.
- Keep existing intent/policy types and `pennywise.intent.v1` / `pennywise.policy.v1` bindings unchanged.
- Persist exact money as decimal text; calculate with bigint, including totals larger than one individual amount bound.
- Use one wallet profile, configured budgets, WAL, FULL synchronous durability, foreign keys and immediate write transactions.
- SQLite busy timeout: 50 ms; maximum three complete transaction attempts. Never retry part of a transaction or an external payment.
- Tests live under each component's `test/`; tooling tests live in `scripts/test/`. The maintainer explicitly approved relocating the existing 11 tests during this milestone wrap-up.
- Do not create further commits until the maintainer explicitly approves them; planned commit steps below are suspended by that instruction.
- The maintainer subsequently authorized the current wrap-up commit only; remaining implementation commits still require approval.
- Every source/test/tooling file has a file overview; named functions and types have precise JSDoc above definitions, not between fields.
- Unknown is reserved for runtime decoding/validation. No `any`, non-null assertions, weakened lint/type rules or silent unsafe casts.
- No HTTP server, real funds, human approval holds, signer, provider verification, adaptation, benchmark framework or UI.

## Review focus

These less-obvious cases are pinned to tasks below, not left to informal review:

1. Changing a denied request's policy must not revive its retry key (Task 5).
2. Mutation of returned snapshots must not change authoritative state (Tasks 1, 2 and 5).
3. An async callback that resumes after rollback must not use an escaped transaction handle (Tasks 2 and 4).
4. Reusing an evidence ID with changed content must contain the wallet without rolling back the containment event (Task 7).
5. A worker acknowledging an expired/replaced outbox claim must not suppress redelivery (Task 8).

## Shared contracts and fixture values

Task 1 defines the data contracts below; Task 2 adds the transaction ports and `LedgerError`. Subsequent tasks consume those contracts. All fields and collections are readonly. Wire monetary fields are canonical strings; validated monetary fields are bigint. IDs use the existing identifier rules; digests and nonces are lowercase 64-hex values. Missing records use explicit `null`, not undefined-filled objects.

| Contract                                          | Fields / variants                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WalletScope`                                     | `ownerId`, `walletId`.                                                                                                                                                                                                                                                                            |
| `BudgetScope`                                     | Discriminated `kind`: WALLET with WalletScope; AGENT additionally has `agentId`; DELEGATION has all TrustedScope fields.                                                                                                                                                                          |
| `WalletConfigurationWire` / `WalletConfiguration` | WalletScope, `network`, `asset`, `signerId`, positive safe-integer `reservationTtlMs`, `executionTtlMs`, `orphanAfterMs`. No monetary conversion between the pair.                                                                                                                                |
| `BudgetAccountWire` / `BudgetAccount`             | `accountId`, BudgetScope, `network`, `asset`, positive `windowMs`, `ceilingAtomic`, positive safe-integer `revision`. Identity/window/profile cannot change after initialization.                                                                                                                 |
| `BudgetAllocation`                                | `reservationId`, `accountId`, positive `amountAtomic`, `state`, nullable safe-integer `committedAtMs`; state is the reservation state.                                                                                                                                                            |
| `BudgetExposure`                                  | `spentAtomic`, `heldAtomic`, `headroomAtomic`, each bigint.                                                                                                                                                                                                                                       |
| `ReservationState`                                | RESERVED, EXECUTING, PENDING_RECONCILIATION, COMMITTED, RELEASED, EXPIRED.                                                                                                                                                                                                                        |
| `LedgerDecision`                                  | Final `kind` ALLOW/DENY/REQUIRE_APPROVAL, `evaluation: PolicyEvaluation`, `ledgerReasons`, `evaluatedAtMs`. Budget denial retains static ALLOW provenance without returning final ALLOW.                                                                                                          |
| `IntentRecord`                                    | `intentId`, `scope: TrustedScope`, `intent: PaymentIntent`, `intentDigest`, `decision: LedgerDecision`, nullable string `reservationId`, `createdAtMs`.                                                                                                                                           |
| `ReservationRecord`                               | `reservationId`, `intentId`, `scope: TrustedScope`, `amountAtomic`, `state`, `expiresAtMs`, `policyDigest`, `delegationRevision`, `createdAtMs`, `updatedAtMs`, nullable string `executionId`.                                                                                                    |
| `ExecutionBindingWire` / `ExecutionBinding`       | TrustedScope, `reservationId`, `intentDigest`, `signerId`, `network`, `asset`, `recipient`, `amountAtomic`, `nonce`, `validAfterMs`, `validBeforeMs`, canonical `payloadBase64`. Payload limit is 16,384 decoded bytes.                                                                           |
| `ExecutionRecord`                                 | `executionId`, `binding: ExecutionBinding`, `bindingDigest`, `payloadDigest`, `claimedAtMs`. These fields never change on retry.                                                                                                                                                                  |
| `LedgerObservationWire` / `LedgerObservation`     | `evidenceId`, `executionId`, `bindingDigest`, `kind` SETTLED/FINAL_NON_EXECUTION, `evidenceRef` (1–256 printable ASCII characters). Full TrustedScope is separately required by the reconciliation call. Content hash is computed, not supplied.                                                  |
| `LedgerEvent`                                     | `eventId`, `wallet: WalletScope`, positive safe-integer `sequence`, `kind`, `subjectId`, `occurredAtMs`, nullable string `reason`. Kinds: CONFIGURATION, DECISION, IDEMPOTENCY_CONFLICT, RESERVATION_TRANSITION, RECONCILIATION, LEDGER_FAULT; subject records retain exact financial provenance. |
| `OutboxRecord` / `OutboxClaim`                    | `eventId`, `wallet: WalletScope`, `state` PENDING/CLAIMED/DELIVERED, nullable strings `workerId` and `claimToken`, nullable safe-integer `leaseExpiresAtMs`; a claim has non-null worker/token/deadline.                                                                                          |
| `WalletClockRecord` / `WalletFaultRecord`         | WalletScope and `highWaterMs`; or WalletScope, `faultId`, `reason`, `createdAtMs`. Faults are latched in this phase.                                                                                                                                                                              |
| `LedgerStatus`                                    | IntentRecord augmented with nullable `reservation: ReservationRecord` and `execution: ExecutionRecord`. The original decision is exposed as `status.decision`.                                                                                                                                    |
| `LedgerResult<T>`                                 | `{ ok: true, value: T }` or `{ ok: false, reason: LedgerReason }`. Ordinary lookup/transition conflicts are not thrown errors.                                                                                                                                                                    |
| `LedgerReason`                                    | NOT_FOUND, IDEMPOTENCY_CONFLICT, BUDGET_EXCEEDED, STALE_PERMISSION, INVALID_TRANSITION, PAYLOAD_MISMATCH, EVIDENCE_CONFLICT, WALLET_CONTAINED. Persist static denials using existing ReasonCode provenance.                                                                                       |
| `LedgerError`                                     | Redacted error with code STORE_BUSY, STORE_CORRUPT, CONFIGURATION_MISSING, CONFIGURATION_CONFLICT, CLOCK_REGRESSION, TRANSACTION_CLOSED, ASYNC_TRANSACTION, NESTED_TRANSACTION or COUNTER_EXHAUSTED. Malformed external objects still use ValidationError.                                        |

Use stored policy/delegation wire snapshots plus parsed values; do not hash an unvalidated caller-asserted digest. Store delegation revision separately because Phase 0's contract has no revision. Mutation-time/counter arithmetic must be checked, not wrapped.

`LedgerStore` produces `transaction<T>(operation: (tx: LedgerTransaction) => T): T`, `read<T>(operation: (tx: LedgerReadView) => T): T` and `close(): void`. Read callbacks also have lifetime-checked handles and reject promises. `LedgerTransaction` extends LedgerReadView with `apply(changes: LedgerChanges): void`; the adapter applies an entire typed batch, never a caller's raw SQL.

LedgerReadView methods are synchronous: `getWallet(wallet)`, `getPolicy(scope)`, `getDelegation(scope)`, `getBudgets(scope)`, `getBudget(wallet, accountId)`, `findIntent(scope, idempotencyKey)`, `getIntent(scope, intentId)`, `getReservation(scope, reservationId)`, `getExecution(scope, executionId)`, `getAllocations(wallet, accountIds, earliestCommittedAtMs)`, `getObservation(wallet, evidenceId)`, `getClock(wallet)`, `getFault(wallet)`, `getOutbox(wallet, eventId)`, `listExpirable(wallet, nowMs, limit)`, `listOrphans(wallet, beforeMs, limit)` and `listDeliverable(wallet, nowMs, limit)`. Each returns the named record or null, or a readonly collection of that record. Delegation reads return the snapshot and revision. Allocation reads include all unresolved holds and committed rows newer than the supplied lower bound; calculated allocation/orphan cutoffs may be negative safe integers. Wallet ownership is explicit so local IDs may repeat across wallets.

`LedgerChanges` has readonly arrays of wallets, policy activations, delegation activations, budgets, intents, reservations, allocations, executions, observations, events, outbox, clocks and faults. Empty arrays mean no change. Immutable records permit insert or identical replay only; mutable records carry expected revision/state/claim token where applicable. Policies/delegations have immutable snapshots and separate active pointers. Adapters validate table keys, scope relationships and immutable columns when applying changes, with matching SQLite uniqueness/foreign-key constraints.

Task 2 pins the batch types in `packages/core/src/ledger-store.ts`: policy/delegation records pair wire and parsed snapshots; budget, reservation, allocation, outbox and clock updates include their expected current value. Allocation and observation writes carry explicit wallet ownership. An apply failure invalidates the whole write callback even if the caller catches it. Worker query limits are 1–1000, with case-sensitive identifier tie-breaking rather than locale-dependent ordering.

Fixture baseline: `NOW_MS = 1791676800000`, owner-1/wallet-1/agent-1/delegation-1, mock:local/mock:usd, mock-signer-1, merchant:weather, existing HTTPS GET purchase, intent deadline NOW_MS+300,000, delegation deadline NOW_MS+3,600,000. Wallet budget ID wallet-budget, ceiling 100 atomic units, window 60,000 ms; policy hard/autonomous ceilings both 100. Reservation/execution TTLs and orphan threshold are 60,000 ms. The race uses two agents configured before history exists. Values are test fixtures, not production defaults.

## Task 1: Contracts, exact budget arithmetic and lifecycle rules

**Files:** Create `packages/core/src/ledger-contracts.ts`, `ledger-validation.ts`, `budget.ts`, `reservation.ts`, `execution-binding.ts`; tests with matching names under `packages/core/test/`; `packages/core/test/ledger-fixtures.ts`. Modify `packages/core/src/index.ts`, its export test and the exact core inventory expected in `scripts/test/coverage-inventory.test.ts`.

**Produces:** Shared contracts above; validators `validateWalletConfiguration(value: unknown): WalletConfiguration`, `validateBudgetAccount(value: unknown): BudgetAccount`, `validateExecutionBinding(value: unknown): ExecutionBinding`, `validateLedgerObservation(value: unknown): LedgerObservation`; `computeBudgetExposure(account: BudgetAccount, allocations: readonly BudgetAllocation[], nowMs: number): BudgetExposure`; `computeReservationExpiry(nowMs: number, ttlMs: number, deadlines: readonly number[]): number`; `canTransitionReservation(from: ReservationState, to: ReservationState): boolean`; `computeExecutionBindingDigest(binding: ExecutionBinding): string`, `computeLedgerObservationDigest(observation: LedgerObservation): string`.

- [x] Write failing tests for strict shape, canonical money, zero ceiling, full amount range, immutable copies and every state transition. Pin arithmetic assertions:

```ts
expect(exposure({ ceiling: 100n, spent: 60n, held: 30n }).headroomAtomic).toBe(10n);
expect(exposure({ ceiling: 0n, spent: 60n, held: 30n }).headroomAtomic).toBe(0n);
expect(computeReservationExpiry(NOW_MS, 60_000, [NOW_MS + 5_000])).toBe(NOW_MS + 5_000);
expect(canTransitionReservation("EXECUTING", "EXPIRED")).toBe(false);
```

The exposure fixture expands to typed accounts/allocations. Add lower-window equality, committed spend at time zero with a negative window cutoff, out-of-range integers, total above MAX_ATOMIC_AMOUNT, payload size/base64 canonicality and expiry near Number.MAX_SAFE_INTEGER. Do not clamp rolling lower bounds to zero, which would exclude a valid commit at time zero.

- [x] Run `bun test packages/core/test/ledger-validation.test.ts packages/core/test/budget.test.ts packages/core/test/reservation.test.ts packages/core/test/execution-binding.test.ts`; confirm failure from absent behavior.
- [x] Implement the pure functions and validators. Binding encoding is a fixed-order JSON array headed by `scuta.execution.v1`, then scope fields, reservation/intent identity, signer/profile/recipient, decimal amount, nonce, decimal validity times and canonical payload. Observation encoding is `scuta.observation.v1`, evidence/execution IDs, binding digest, kind and reference. Hash with SHA-256; compute payloadDigest over decoded unsigned payload bytes. Test each field changes the binding, without changing existing Phase 0 known-answer fixtures.
- [x] Run the targeted tests, `bun run check` and `bun run demo`; confirm strict checks and original digests pass.
- [x] Commit the passing deliverable as `feat(core): define ledger contracts and exact budget accounting`, recording actual test evidence.

## Task 2: Transaction ports and memory rollback

**Files:** Create `packages/core/src/ledger-store.ts` for the shared read/write ports, `packages/store/package.json`, `tsconfig.build.json`, `src/index.ts`, `src/memory-store.ts`, `test/memory-store.test.ts`, `test/store-contract.ts`, `test/store-fixtures.ts`. Modify root build/coverage tooling only as required by the new workspace.

**Consumes:** Task 1 validated contracts. **Produces:** transaction ports and the redacted `LedgerError` contract in `ledger-store.ts`, `createMemoryStore(): LedgerStore` and a reusable adapter contract suite. Root build emits core then store; store uses `types: ["bun"]`, a private workspace dependency on @scuta/core and no path-alias fallback.

- [x] Write failing tests for atomic batch application, rollback, unique intent/reservation/nonce constraints, immutable returned copies, nested calls and post-callback handle use. Assert `expect(inspectWallet(store).intents).toHaveLength(0)` after injected failure; use fixture helpers built from lifetime-checked read calls.
- [x] Run `bun run build && bun test packages/store/test/memory-store.test.ts`; establish missing adapter behavior, not an unrelated compiler/configuration error.
- [x] Implement transaction ports and snapshot/rollback memory behavior; invalidate handles in finally. Reject thenables before commit and preserve rollback after a queued continuation attempts another write. Only adapter state is cloned; no caller object becomes authoritative by reference.
- [x] Run the contract suite and strict checks. Add declared-package source discovery to coverage preload/inventory: both core and store must be nonempty and represented; keep the empty-test guard and existing listCoreSources behavior. Update exact source expectations rather than relaxing assertions.
- [ ] Commit as `feat(store): add transactional memory ledger adapter` only after explicit maintainer approval.

## Task 3: SQLite schema, migrations and row decoding

**Files:** Create `packages/store/src/migrations.ts`, `schema.ts`, `row-codecs.ts`; `test/migrations.test.ts`, `row-codecs.test.ts` and migration fixtures under `test/fixtures/`.

**Produces:** `migrateLedger(database: Database): void`; typed per-record codecs exposed only inside store. Migration 1 creates schema_migrations, wallets, policy_snapshots, active_policies, delegation_snapshots, active_delegations, budget_accounts, payment_intents, reservations, reservation_allocations, executions, reconciliation_observations, decision_events, outbox_events, wallet_clocks and ledger_faults.

- [x] Write failing tests: clean migration applies once; changed checksum/newer schema rejects; money 9007199254740993 and MAX_ATOMIC_AMOUNT round trips exactly; corrupt decimal/time/state rows reject. Assert duplicate scope/key, reservation/intent, execution/reservation and wallet/profile/nonce inserts fail. Add allocation-account/reservation and observation-execution foreign-key violations.
- [x] Run `bun test packages/store/test/migrations.test.ts packages/store/test/row-codecs.test.ts`; confirm the intended failures.
- [x] Implement checked migrations inside immediate transactions and runtime row codecs. Financial columns are TEXT; times/revisions/sequences are checked safe integers. Index account/state/commit time, scoped retry keys, reservation state/deadline, execution claim time and outbox state/deadline. Relational metadata must agree with decoded payload records. Invalid rows throw STORE_CORRUPT, never return empty balances.
- [x] Run migration/codec tests and type/lint checks, including a reopen and repeated migration.
- [ ] Commit as `feat(store): add validated SQLite ledger schema and migrations` only after explicit maintainer approval.

## Task 4: SQLite transaction adapter

**Files:** Create `packages/store/src/sqlite-store.ts`, `test/sqlite-store.test.ts`; extend Task 2's shared adapter contract tests and store exports.

**Produces:** `openSqliteStore(options: { path: string; busyTimeoutMs?: number; maxAttempts?: number }): LedgerStore`; defaults 50 ms/three attempts; test overrides permit integer busyTimeoutMs in 0–50 and maxAttempts in 1–3 only. Driver access is never exported from the public store instance.

- [x] Write failing tests using temporary local files for WAL/FULL/foreign-key settings, the shared rollback/handle contract, close/reopen persistence and bounded contention. Assert rolled-back intent/event/outbox counts remain zero. Force another connection to retain write ownership and assert STORE_BUSY after the attempt bound.
- [x] Run `bun test packages/store/test/sqlite-store.test.ts`; confirm absence of required adapter behavior.
- [x] Implement prepared record queries and guarded batch writes. Use BEGIN IMMEDIATE for mutations; rollback the whole attempt on failure and invalidate handles. Retry only busy failures with no external calls. Read views must be read-only database transactions, not unprotected multi-query snapshots. Reject nested callbacks and async continuation writes as in memory.
- [x] Run both adapter suites plus strict checks. Verify process/connection cleanup preserves shared WAL state; never delete live sidecars as a cleanup shortcut.
- [ ] Commit as `feat(store): enforce atomic SQLite ledger transactions` only after explicit maintainer approval.

## Task 5: Trusted configuration and atomic authorization

**Files:** Create `packages/core/src/ledger.ts`, `ledger-configuration.ts`, `ledger-authorization.ts`, `ledger-events.ts`; `packages/store/test/authorization.test.ts`, `configuration.test.ts`. Extend shared fixtures and public export checks.

**Produces:** `createLedger(dependencies: { store: LedgerStore; now: () => number; createId: () => string }): Ledger`. Methods: `configureWallet(configuration: WalletConfigurationWire, budgets: readonly BudgetAccountWire[]): LedgerResult<WalletConfiguration>`; `activatePolicy(policy: PolicyWire): LedgerResult<Policy>`; `activateDelegation(delegation: DelegationWire): LedgerResult<Delegation>`; `setBudgetCeiling(wallet: WalletScope, accountId: string, ceilingAtomic: string): LedgerResult<BudgetAccount>`; `revokeDelegation(scope: TrustedScope): LedgerResult<Delegation>`; `authorize(input: { scope: TrustedScope; intent: PaymentIntentWire }): LedgerResult<LedgerStatus>`; `getStatus(scope: TrustedScope, intentId: string): LedgerResult<LedgerStatus>`; `getBudgetExposure(wallet: WalletScope, accountId: string): LedgerResult<BudgetExposure>`.

- [ ] Write failing cases for all static outcomes, correct ancestor membership, profile/scope mismatch, zero budget, no partial allocation, configuration/version conflicts, ceiling reduction and CLOCK_REGRESSION. Pin the main sequence:

```ts
expect(authorizeAmount(fixture, "70", "first")).toMatchObject({
  ok: true,
  value: { decision: { kind: "ALLOW" } },
});
expect(authorizeAmount(fixture, "70", "second")).toMatchObject({
  ok: true,
  value: { decision: { kind: "DENY", ledgerReasons: ["BUDGET_EXCEEDED"] } },
});
expect(inspectExposure(fixture).heldAtomic).toBe(70n);
```

Assert same-key retries retain reservation/expiry/event identity. Changed digest conflicts. A denied key stays denied after policy activation; approval-required has no reservation; changed returned objects cannot alter later status.

- [ ] Run `bun run build && bun test packages/store/test/authorization.test.ts packages/store/test/configuration.test.ts`; confirm behavior failures.
- [ ] Implement the shared configuration/authorization coordinator against the transaction port. Persist clock advancement, decisions, allocations, events and outbox work atomically. Missing required configuration throws CONFIGURATION_MISSING. Wallet/account membership cannot be replaced once any intent exists. Repeated identical initialization/activation is a no-op; conflicting immutable identity/revision reuse rejects. Budget lowering preserves prior allocations.
- [ ] Run this suite against memory and SQLite, then full checks. getStatus/read exposure must neither expire holds nor advance the clock.
- [ ] Commit as `feat(core): reserve shared budgets with scoped retry safety`.

## Task 6: Claims, unclaimed expiry and cancellation

**Files:** Create `packages/core/src/ledger-execution.ts`; `packages/store/test/execution.test.ts`, `expiry.test.ts`; extend Ledger interfaces/exports.

**Produces:** `claimExecution(scope: TrustedScope, reservationId: string, binding: ExecutionBindingWire): LedgerResult<LedgerStatus>`; `cancelUnclaimed(scope: TrustedScope, reservationId: string): LedgerResult<LedgerStatus>`; `expireUnclaimed(wallet: WalletScope, limit: number): readonly ReservationRecord[]`. Batch limit is validated in 1–1000; ordering is deadline then reservation ID.

- [ ] Write failing tests for one claim per reservation, changed nonce/payload, stale policy/revision, exact expiry, revoked capability, contained wallet and changed budget ceiling. Pin `expect(inspectExposure(fixture).heldAtomic).toBe(70n)` after claim and `expect(repeatClaim(fixture)).toEqual(firstClaim)` for an identical binding. A changed binding returns PAYLOAD_MISMATCH, preserving the first.
- [ ] Run `bun test packages/store/test/execution.test.ts packages/store/test/expiry.test.ts`; confirm failures.
- [ ] Implement current-state revalidation and immutable execution insertion in one transaction. Stale unclaimed permission cancels its hold; a malformed/mismatched internal binding does not grant execution. Expiry/cancellation only transition RESERVED; existing executions return historical status without renewing authority. Compute and persist nonce/payload/binding before any future external execution.
- [ ] Run both adapters, exact boundary tests and strict checks. Assert own hold is counted once, not twice, during claim revalidation.
- [ ] Commit as `feat(core): persist unique execution claims and safe unclaimed expiry`.

## Task 7: Reconciliation and wallet containment

**Files:** Create `packages/core/src/ledger-reconciliation.ts`; `packages/store/test/reconciliation.test.ts`, evidence fixtures. Extend coordinator interfaces/exports.

**Produces:** `markUncertain(scope: TrustedScope, executionId: string): LedgerResult<LedgerStatus>`; `recordSettlement(scope: TrustedScope, observation: LedgerObservationWire): LedgerResult<LedgerStatus>`; `recordFinalNonExecution(scope: TrustedScope, observation: LedgerObservationWire): LedgerResult<LedgerStatus>`.

- [ ] Write failing tests for matching settlement, final non-execution, duplicate evidence, cross-scope/mismatched binding, same evidence ID with changed content and contradictory terminal observations. Assert settlement yields `{ spentAtomic: 70n, heldAtomic: 0n, headroomAtomic: 30n }`; uncertainty retains heldAtomic 70n; identical replay leaves observation/debit/event counts unchanged. Contradiction persists one wallet fault, blocks new admission/claims and still permits scoped status reads.
- [ ] Run `bun test packages/store/test/reconciliation.test.ts`; confirm failures.
- [ ] Implement validation and atomic hold-to-spend/release transitions in original budget accounts. Booking time comes from the trusted transaction clock. Evidence is explicitly trusted normalized test input; this API does not verify provider signatures/finality. Invalid binding cannot free exposure. Return EVIDENCE_CONFLICT after committing containment, not by throwing inside the transaction.
- [ ] Run both adapter suites and strict checks; repeat malformed and duplicate evidence tests after reopen.
- [ ] Commit as `feat(core): reconcile exposure and contain contradictory outcomes`.

## Task 8: Durable outbox and orphan recovery

**Files:** Create `packages/core/src/ledger-recovery.ts`, `ledger-outbox.ts`; `packages/store/test/recovery.test.ts`, `outbox.test.ts`.

**Produces:** `recoverOrphans(wallet: WalletScope, limit: number): readonly ReservationRecord[]` using configured orphanAfterMs; `claimOutbox(wallet: WalletScope, workerId: string, leaseMs: number, limit: number): readonly OutboxClaim[]`; `acknowledgeOutbox(wallet: WalletScope, eventId: string, claimToken: string): LedgerResult<OutboxRecord>`. Batch bounds are 1–1000; lease is positive safe-integer and overflow-checked. Delivery order is event sequence; a new opaque claim token fences each redelivery.

- [ ] Write failing tests for orphan conversion, reopened delivery state, abandoned lease, duplicate acknowledgments and stale token. Assert orphan recovery moves state to PENDING_RECONCILIATION with heldAtomic 70n. After lease expiry, assert `second.eventId === first.eventId`, `second.claimToken !== first.claimToken` and old acknowledgment returns INVALID_TRANSITION without marking DELIVERED.
- [ ] Run `bun test packages/store/test/recovery.test.ts packages/store/test/outbox.test.ts`; confirm failures.
- [ ] Implement bounded internal recovery/delivery operations without a background service or network calls. Recovery never extends execution validity, creates a replacement nonce or frees a claimed hold. Acknowledgment/redelivery preserves financial state; matching repeated successful acknowledgment is idempotent.
- [ ] Run both adapters, exact lease boundaries and strict checks; test counter/deadline exhaustion without wraparound.
- [ ] Commit as `feat(core): recover orphaned executions and durable outbox delivery`.

## Task 9: Independent-process fault and race tests

**Files:** Create `packages/store/test/concurrency.test.ts`, `crash-recovery.test.ts`, `fixtures/ledger-worker.ts`, `fixtures/crash-worker.ts`. Worker fixtures have file docs and are not named *.test.ts.

**Consumes:** The built core/store API and Task 5's fixture configuration. **Produces:** Reproducible tests with parent/child readiness barriers and bounded timeouts, no additional runtime APIs or test dependencies.

- [ ] Write tests that would fail if coordinator writes were split or uniqueness/locking were removed: two distinct-agent 70-unit requests against 100; same-key race; simultaneous claim; claim versus trusted expiry/revocation; child killed between allocation/event writes; child killed after commit-before-response. Assert `allowCount === 1`, `denyCount === 1`, `heldAtomic === 70n`; use fresh temporary databases and fixed clocks.
- [ ] Run `bun test packages/store/test/concurrency.test.ts packages/store/test/crash-recovery.test.ts`. Verify the harness genuinely overlaps independent processes; a Promise.all over synchronous calls is not sufficient. Confirm the tests detect a deliberately broken implementation in a disposable copy, never by weakening the working checkout.
- [ ] Implement only necessary test fixtures/fault barriers; do not expose crash injection in the production Ledger API. At the store boundary, a transaction callback can apply the first typed batch then throw/exit before the remainder, exercising real rollback.
- [ ] Rerun races repeatedly and after close/reopen; enforce bounded cleanup of only task-owned temporary databases/processes. After a committed-but-unanswered request, retry must recover the same reservation/nonce/outbox identity.
- [ ] Commit as `test(store): prove reservation races and crash recovery across processes`.

## Task 10: Full verification, exports and actual phase record

**Files:** Modify `scripts/coverage-inventory.ts`, `coverage-preload.ts`, their tests, `verify-built-package.ts` and its tests, root package scripts, README, CONTRIBUTING, technology decisions and this record; update `.github/workflows/check.yml` only if the existing check entry requires it.

- [ ] Add failing tests for missing/unvisited store source, missing store build/public export, empty tests and a compiled ledger that cannot reserve/recover the fixture. Keep the existing missing-core-export and known-digest probes. Assert `expect(() => assertCoverageInventory(root, storeSources, missingStoreLcov)).toThrow()` and missing compiled store imports reject rather than fall back to source.
- [ ] Run targeted tooling tests; confirm failures reflect the missing verification behavior.
- [ ] Extend inventory/smoke checks without broad coverage exclusions or disabled rules. Include all implementation files in both packages. Smoke imports emitted core/store, exercises an ordinary reservation/retry and closes its memory store. Keep demo static-only unless the maintainer separately approves a demo change.
- [ ] Run fresh frozen installation, `bun run check`, `bun run demo`, targeted cross-process suites and `git diff --check`. Verify full build, formatting, lint, type checks, guarded test discovery, both coverage inventories and smoke. Record exact counts/results, test environment and any unverified Linux/hosted behavior; do not invent coverage percentages or claim provider/security verification.
- [ ] Update this file with actual initial/expected/observed outcomes and failures, and document all new stack choices. Commit as `chore: verify and document the durable reservation ledger`. Stop for branch integration instructions; no automatic push/PR.

## Plan self-review and handoff

The tasks cover the approved admission/lifecycle/configuration rules, exact storage, memory rollback, SQLite constraints, durable events, scope isolation, contention, restarts and cross-process crash evidence. Review-focus cases are assigned to explicit tests. Future adapter authentication/finality, actual approvals, behavior and external payment execution remain outside Phase 1 and are not implied by ledger tests.

The maintainer approved native execution and requested independent subagent code review on 12 October 2026. Work proceeds task-by-task on the ledger branch; a whole-branch review follows verification. Actual completion and evidence will be recorded here rather than inferred from this plan.

## Implementation evidence

Task 1: implemented immutable ledger contracts, exact rolling spend/live-hold calculations, precision-safe expiry, reviewed lifecycle edges, strict wallet/budget/execution/evidence validators and semantic binding helpers. New tests were written first; typed stubs then demonstrated assertion failures before implementation. Public-export expectations also failed before the helpers were exported.

Verification: `bun run check` passed with 267 tests across 15 files, 620 assertions and zero failures; all 13 core sources were included in the coverage inventory. Build, formatting, lint, types and built-package smoke passed. Line/function coverage does not prove branch coverage or financial enforcement. No store, atomic reservation coordinator, signer or payment execution is implemented by Task 1.

Failures resolved without weaker checks: the first red run exposed absent modules, then the assertions failed against temporary unimplemented stubs; an unused destructured test binding violated naming/lint rules, and a scope fixture widened its kind to string. The fixture fixes preserve runtime behavior and strict rules. The baseline check completed but its shell wrapper used zsh's readonly `status`; subsequent wrappers use task-specific names.

### Milestone wrap-up — 12 October 2026

The maintainer requested formatting and separate test folders, and prohibited further commits until explicitly approved. Task 1 was committed before that instruction; cleanup was left uncommitted at the wrap-up checkpoint. The maintainer subsequently authorized committing these changes. Phase 1 is not complete.

Existing source-adjacent tests now live in `packages/core/test/` and `apps/example/test/`; tooling tests live in `scripts/test/`. Imports and repository-root/fixture paths are adjusted without changing test behavior. The unfinished Task 2 test scaffolding is preserved in ignored local planning scratch, outside runnable test discovery, for resumption; no memory or SQLite store is implemented yet.

Independent read-only review found no critical or important issues in Task 1 or the relocation. Minor findings were addressed: assign `LedgerError` explicitly to Task 2, remove stale relocation/approval guidance, and pin execution/observation digest literals independently calculated with Node SHA-256 from the documented field order. No production behavior changed.

Review boundaries accepted: memory transactions (Task 2), SQLite persistence (Tasks 3–4), atomic admission and clock enforcement (Task 5), execution claims (Task 6), reconciliation (Task 7), recovery/outbox (Task 8), process races/crashes (Task 9) and compiled ledger smoke coverage (Task 10) remain unimplemented and unverified. Protocol equivalence, signing, authentication, provider finality, real-fund safety, approvals, adaptation, multi-asset/fees and unfinished scratch tests are outside this milestone; they are not implied by the review.

Final wrap-up verification: `bun run check` passed with 267 tests across 15 files, 622 assertions and zero failures; all 13 core sources passed inventory. Formatting, build, lint, types and built-package smoke passed. `bun run demo` retained the three expected mock decisions; `git diff --check` passed. All 11 old test paths are absent with their destination files present. HEAD remains `2dcbc9a`; no wrap-up changes were staged or committed.

### Task 2 — Transaction ports and memory adapter

Initial intent: give the existing ledger rules a reliable internal state boundary before adding SQLite or financial admission. Expected outcome: a typed synchronous store with atomic batches, rollback, immutable snapshots, scope isolation and closed-handle protection, verified by tests reusable against SQLite.

Implemented: the shared ports and redacted `LedgerError` in core; private `@scuta/store` with separate table, read, write and callback-lifetime modules. Records cover configuration/history, intents, reservations/allocations, execution identities, observations, events/outbox, wallet clocks and faults. Mutable batches check expected revision/state/token; immutable identities support identical replay only. Any apply failure poisons the callback, so catching it cannot commit earlier writes.

Design refinements: allocation queries/writes and observation writes carry wallet ownership, allowing local IDs to repeat safely across wallets. Calculated cutoffs permit negative safe integers; worker limits are 1–1000 and identifier tie-breaking is case-sensitive rather than locale-dependent. Snapshots use checked explicit inert-data copying; the one generic type assertion is localized to that value-preserving boundary, not financial decoding. No dependency version changed; the lockfile only adds the local store workspace.

Test progression: absent imports first exposed the missing adapter, then a typed temporary factory produced 13 behavioral failures before implementation. The initial full fixture exposed native clone corruption of a shared scope; explicit copying fixed it. Further regression tests first failed for negative cutoffs and locale ordering, then passed after their fixes. TypeScript closure narrowing was resolved through the existing transaction gate; lint required a named payment-profile type and explicitly awaited operations instead of Bun matcher assertions with non-Promise typings. No rule was disabled.

Independent read-only review found no critical findings and two important compatibility issues: budget-denied records must retain static ALLOW provenance, and profile/delegation-denied requests must remain storable tombstones. Four shared regression cases failed first, then passed after refining intent checks. Denied records retain canonical input and ownership but cannot have holds; admitted records and execution references remain strict. No minors were reported.

Verification: `bun run check` passed with **295 tests, 772 assertions, 17 files and zero failures**; all **19 implementation sources** (14 core, five store) appear in the coverage inventory. Build, formatting, lint, types and emitted core/store smoke passed. Frozen installation and the unchanged mock demo passed; whitespace checks passed. These are local results, not branch-coverage, durability, concurrency or real-payment safety proof.

Run the focused adapter suite after building:

```sh
bun run build
bun test packages/store/test/memory-store.test.ts
bun run check
```

Review boundaries accepted: SQLite/reopen/process durability (Tasks 3–4 and 9), financial budget admission/configuration enforcement (Task 5), trusted-time advancement and execution deadlines (Tasks 5–6), reconciliation authenticity and containment orchestration (Task 7), fresh outbox tokens/lease workers (Task 8), and compiled reservation smoke/Linux evidence (Task 10) remain pending. Signing, protocol semantics, HTTP authentication, approvals and adaptation belong to later phases. This internal typed store does not sandbox hostile Proxy traps or arbitrary trusted callback code; persisted-row decoding is Task 3. Memory is a nondurable test adapter, not a production payment store.

Task 2 is implemented but uncommitted on `feat/atomic-budget-reservations`, based on `a38ce14`. The earlier ignored test scaffolding is superseded by the runnable shared suite and retained only as historical scratch. Next: SQLite schema, migrations and row codecs; no new commit or external mutation was authorized.

### Task 3 — SQLite schema, migrations and row codecs

Initial intent: establish exact, checked persistence before implementing the SQLite transaction port. Expected outcome: one repeatable migration, relational ownership/uniqueness constraints and private codecs that reject inconsistent records without losing money precision.

Implemented: 16 STRICT tables including migration history, four lookup indexes, immediate migration transactions, enabled foreign keys, bounded busy errors and exact schema/history verification. Deferred references support coherent cyclic intent/reservation/execution insertion. All 15 record kinds have typed codecs: money is canonical decimal TEXT, metadata is checked safe integers, and relational columns must agree with a bounded canonical JSON payload. Decoding reconstructs immutable records, validates states and digests, and redacts failures. Helpers remain private; no SQLite `LedgerStore` factory is exported.

Design choices: typed payloads plus indexed camelCase columns avoid binding financial bigint as SQLite INTEGER, at the cost of duplicated metadata and decode checks. Canonical payloads are bounded to 128 KiB, depth 32 and record arrays of 100 entries. Schema changes require a new version; migrations refuse unrelated databases or altered objects rather than silently repairing them.

Test progression: missing modules established absence, then typed stubs produced 39 behavioral failures before implementation. A runtime codec-kind allowlist fixed an independently failing inherited-property selector case. Driver-safe bigint metadata, denied-intent provenance, structural wallet inputs and duplicate JSON keys have regressions. Type/lint fixes preserved strict rules; no dependency or coverage exclusion was added.

Independent read-only review found no critical issue, one important schema-filter bug and one minor overlapping-constraint test. SQL LIKE treated the underscore in the reserved prefix as a wildcard, hiding ordinary sqlite-like tables/triggers. Three regressions failed first, then passed with exact prefix filtering. The execution/reservation uniqueness test now uses a different nonce and recomputed digests, asserting the intended constraint rather than incidentally hitting nonce uniqueness.

Focused verification: **62 migration/codec tests, 150 assertions, zero failures**. These include real temporary SQLite files, close/reopen, repeated migration, contention, ownership and uniqueness, exact 2^53+1/max-256-bit amounts, corrupt rows and migration tampering.

Full verification: frozen installation made no dependency changes; `bun run check` passed with **357 tests, 922 assertions, 19 files and zero failures**. Build, formatting, lint, types, all **25 implementation sources** in coverage inventory (14 core, 11 store), and emitted core/store smoke passed. These local checks do not establish branch coverage, full financial enforcement, crash durability or real-fund safety.

Run from the repository root:

```sh
bun run build
bun test packages/store/test/migrations.test.ts packages/store/test/row-codecs.test.ts
bun run check
```

Review boundaries accepted: guarded SQLite queries/batches, compare-and-set writes, callback lifetimes, bounded transaction retries and remaining cross-record financial checks belong to Task 4. WAL/FULL settings and process race/crash evidence remain Tasks 4 and 9. Budget admission and trusted time (Tasks 5–6), reconciliation authenticity/containment (Task 7), outbox/orphan workers (Task 8), and Linux/complete ledger smoke (Tasks 9–10) are not established here. Signing, provider finality, authentication, approvals and adaptation are later phases. Inert-data codecs do not sandbox hostile callbacks/Proxy traps or privileged database administrators.

Task 3 changes remain uncommitted alongside Task 2. Next: implement the SQLite transaction adapter against the existing shared store contract; no payment or authorization coordinator is implemented by this step.

### Task 4 — SQLite transaction adapter

Initial intent: turn the checked SQLite records into a real implementation of the existing synchronous store port. Expected outcome: the same observable contract as memory, plus file-backed commits, stable read snapshots, exact reopen behavior and bounded contention without exposing raw database access.

Implemented: `openSqliteStore({ path, busyTimeoutMs?, maxAttempts? })` in the private store package. Separate connection, prepared-query, read, write and callback-lifetime modules keep responsibilities focused. Connections require WAL, FULL synchronous mode and foreign keys; money remains checked decimal TEXT. Writes start with `BEGIN IMMEDIATE`; reads use deferred query-only transactions. Batches enforce immutable records, expected revisions/states/tokens and affected cross-record ownership, budget membership and execution bindings. Any failed apply poisons the callback, even when its exception is caught.

Contention retries at most three entire rolled-back attempts, not individual statements. Real busy provenance stays private while callbacks receive redacted failures. Every attempt has new handles; ended or rejected asynchronous callbacks cannot resume reads/writes. There are no external side effects inside callbacks. Close is idempotent and never deletes WAL files belonging to other live connections.

Test progression: typed stubs produced 46 failures before implementation. Two additional shared regressions exposed an empty-allocation read bypassing lifetime checks and delivered-outbox replay comparing structural wallet extras; both passed after targeted fixes. A test-only fault at the driver boundary then reproduced busy-error provenance being lost during redaction. Both uncaught and caught apply failures now roll back and retry completely, without adding injection APIs to production. Strict checks caught an unused import, snake-case SQLite result labels and a closure-narrowing issue; explicit aliases and a typed retry-state container fixed them without weakening rules.

Pre-review verification: **409 tests, 1,129 assertions, 20 files, zero failures**; all **30 implementation sources** (14 core, 16 store) pass coverage inventory. Build, formatting, lint, types and emitted core/store smoke passed. The SQLite suite has **50 tests**, including 25 shared contract cases; the new driver-boundary fault is injected only in tests, while locking, queries, transactions and rollback use real SQLite.

Run from the repository root:

```sh
bun run build
bun test packages/store/test/memory-store.test.ts packages/store/test/sqlite-store.test.ts
bun run check
```

Independent read-only review found no Critical or Important issues and one Minor. The reviewer independently ran both adapter suites: **75 passed, zero failures, 347 assertions**. Additional disposable-file probes confirmed nested snapshot immutability and rejection of validly digested but wrong recipient/signer bindings, with the original reservation still RESERVED.

Review checkpoint finding (resolved in the follow-up below): migration initialization reset the SQLite busy timeout to 50 ms, even when a lower override was requested. Defaults and the maximum attempt count stayed bounded, but the reduced startup override was not honored.

Accepted review boundaries:

- Complete budget admission and all-applicable account membership belong to Task 5. The trusted internal port can persist a reservation without allocations if supplied that batch; it validates supplied links, not completeness of admission. Never expose this port as an agent authorization API.
- Denied-key revival, policy re-evaluation, ceiling enforcement and configuration membership changes require Task 5's coordinator.
- Trusted-clock advancement and claim/deadline/cancellation/expiry decisions require Tasks 5–6; stored clock monotonicity and lifecycle checks are only prerequisites.
- Evidence authenticity, contradiction detection and committed containment require Task 7; immutable evidence alone is not containment.
- Expired acknowledgments, fresh lease tokens and orphan recovery decisions require Task 8; token fences and selections do not implement those operations.
- Independent-process races, killed-writer/commit-before-response recovery and power-loss evidence remain Task 9. Complete emitted-ledger reservation smoke and Linux/hosted evidence remain Tasks 9–10.
- Signing, protocol equivalence, provider finality, authentication, approvals and adaptation are later phases. Hostile callbacks/Proxy traps, privileged database rewriting, network filesystems, multi-host deployment and scalability claims are outside this trusted local-store contract.

Frozen installation was unchanged; the emitted SQLite factory separately passed a temporary-file wallet write/close/reopen smoke. The existing static demo passed, as did three repeated SQLite suite runs (50/50 each) and whitespace checks. No source/test weakening, new dependency, stage, commit, push or PR. At this checkpoint Task 4 was accepted with the minor deferred; it is resolved below. Next is Task 5, trusted configuration and atomic financial admission.

### Startup timeout fix and implementation audit

The maintainer requested the timeout fix, a regression and a project-status audit, without committing. Root cause: connection setup selected the requested timeout, but migration unconditionally replaced it with 50 ms. Migration now accepts a validated integer timeout in 0–50 ms, defaulting to 50, and connection setup forwards its selection on every attempt. No schema definition/checksum, dependency, retry count or financial behavior changed.

Tests first observed both requested 0 ms and 7 ms becoming 50 ms on both startup attempts; the default-50 control passed. The fix makes all three pass under real retained-writer contention. Five additional failing-first cases reject negative, excessive, fractional and nonfinite timeout values before changing schema. Instrumentation observes the real connection just before migration constructs its immediate transaction and forwards the original driver wrapper untouched; no wall-clock threshold or fake lock is used. The first harness tried to wrap Bun's nonconfigurable immediate property; it was corrected before establishing the genuine regression.

Verification: targeted migration/SQLite suites **84 passed, 286 assertions**; full `bun run check` **417 passed, zero failures, 1,153 assertions, 20 files**. Build, formatting, lint, types, coverage inventory for all **30 implementation sources**, and existing built-package smoke passed. This follow-up is a tested repair of the previous review finding, not a new independent security audit.

Pre-Task-5 implementation/status audit (superseded by the admission outcome below), based on public exports, implementation files, tests, scripts, CI configuration and the approved roadmap:

| Area                     | Implemented and supported by local tests                                                                                                                                         | What cannot yet be inferred                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static policy            | Runtime validation, scope/delegation checks, hard/autonomous ceilings, recipient rules and explained decisions                                                                   | Host scope is not authentication; static ALLOW is not execution authority; REQUIRE_APPROVAL does not contact a human                                            |
| Money and exposure       | Bounded exact bigint amounts, text persistence, rolling spend/live-hold arithmetic and safe expiry helpers                                                                       | Calculations require complete allocations; no integrated admission or wallet-balance verification                                                               |
| Record identity          | Canonical digests, immutable history, scoped unique retry keys, reservation/execution/nonce constraints                                                                          | Hashes are not authentication or protocol equivalence; constraints do not implement logical retry/claim orchestration                                           |
| Storage                  | Memory and SQLite transaction ports, atomic batches, rollback poisoning, snapshot reads, revision/state/token fences, checked rows, ordinary close/reopen and bounded contention | No complete budget allocation requirement; no independent-process crash, power-loss, multi-host or production performance proof                                 |
| Events and recovery data | Persisted event/outbox/evidence/clock/fault records and worker selection queries                                                                                                 | No trusted reconciliation, containment coordinator, outbox lease worker, orphan recovery or automatic clock advancement                                         |
| Tooling                  | Bun/TypeScript, component test folders, style/type/JSDoc checks, source inventory, static demo and configured GitHub Actions                                                     | Automated emitted-store smoke exercises memory; complete emitted-ledger/SQLite reservation smoke remains Task 10. Remote Linux CI results were not checked here |

Phase status: Phase 0 is implemented; Phase 1 Tasks 1–4 are implemented, while Tasks 5–10 remain. Tasks 5–8 must add trusted configuration/admission, revalidated execution claims, reconciliation/containment and recovery/outbox operations. Task 9 must prove overlapping independent-process races and kill/restart recovery; Task 10 closes compiled-consumer, CI and documentation evidence gaps. A configured workflow is not a verified remote run.

Later phases remain designs: isolated gateway and mock x402 payment (2), durable authenticated approvals (3), behavior-based authority/recovery (4), and comparative evaluation, overhead measurements, contributor testkit and one verified external integration (5). Core/adapter separation does not imply compatibility with every wallet or payment protocol.

Conclusion: the project has tested policy/accounting primitives and local transactional storage, not yet an enforceable adaptive authorization product. The decisive next demonstration is Task 5 admission: two 70-unit requests against a 100-unit wallet budget yield one hold and one denial, with every applicable account updated atomically. After coordinator tests, repeat it across processes in Task 9. Adaptive benefit over a strong static policy, legitimate task completion, approval burden and false restrictions remain research questions.

### Task 5 — Trusted configuration and atomic admission

Initial intent: turn the exact storage foundations into the first actual financial admission operation. Expected outcome: two 70-unit purchases against a 100-unit shared ceiling produce one RESERVED hold and one budget denial, with no partial allocations or refreshed retry lifetime.

Implemented `createLedger({ store, now, createId })` in core, split into configuration, admission, event and shared-check modules. The trusted host configures one wallet profile, exactly one wallet budget and optional agent/delegation accounts. `authorize` derives membership from persisted scope and re-evaluates current static policy inside one transaction. It records the original decision, every required allocation, ordered event, pending outbox work and clock advance atomically. IDs must be unique opaque identifiers; callbacks remain synchronous and free of external side effects.

- Same scoped key/purchase returns the original decision and current lifecycle without new IDs, events, holds or expiry. Changed purchases return `IDEMPOTENCY_CONFLICT`; repeated identical conflicts generate only one event.
- Denied and approval-required keys remain non-executable after later policy changes. Approval-required has no hold or human-delivery hook in this phase.
- Configuration identity/window/profile cannot be replaced. Membership declarations are complete: additions only before any retained intent; removals unsupported. Ceiling updates retain the same account/history and increment its revision. Delegation changes/revocation increment revisions; identical initialization/activation is a no-op.
- Insufficient headroom in any account denies without allocating in another. Zero closes admission; lowering a ceiling never erases holds. A latched wallet fault blocks new admission; contradiction detection belongs to Task 7.
- Reservation expiry is the minimum of configured TTL, intent expiry and delegation expiry. Read-only status/exposure never expire holds or advance time. New mutations and exposure reads reject clock regression; unchanged retries/no-ops need no clock advance.

The maintainer requested Drizzle after Task 4: `drizzle-orm@0.45.4` is pinned only in store. Typed mappings/queries replace record-query strings; native transaction controls and the reviewed/checksummed physical schema stay unchanged. Required full row types and codecs preserve exact money and reject inconsistent stored metadata. Cost/rationale: [technology decisions](../technology-decisions.md#drizzle-query-layer).

Test progression: typed coordinator stubs produced 45 behavioral failures, then 45 passes. Another 22 boundary probes cover zero ceilings, exact full-range money, all three expiry bounds, cross-agent shared limits, durable decision/conflict outbox identity, sequence exhaustion, malformed inputs and missing configuration. The shared adapter suite also checks the four new membership/history/event reads. Existing busy-fault tests now intercept Drizzle's actual native `prepare` boundary; real locks, writes and rollback remain in use.

Independent read-only review found no Critical or Minor issues and one Important test-isolation defect: fault injection patched native `prepare` but restored `query`. Descriptor-restoration assertions failed in both fault scenarios before the fix; restoring the correct method makes both pass and leaves both native methods unchanged. The reviewer ran **183 tests / 719 assertions** independently; the post-fix focused suite passes **183 / 723**, without a second review round.

Final fresh `bun run check`: **486 tests, zero failures, 1,427 assertions, 23 files**, with all **36 implementation sources** inventoried. Build, formatting, strict lint/types and emitted core/store smoke passed. Coordinator integration tests explicitly import source for accurate coverage; compiled package smoke remains separate. Frozen installation was unchanged, the static demo passed, and all 77 local documentation targets/anchors resolved. A separate emitted-coordinator admission/retry/exposure smoke passed against both stores; the complete lifecycle/CI release gate remains Task 10.

```sh
bun run build
bun test packages/store/test/authorization.test.ts packages/store/test/configuration.test.ts packages/store/test/admission-boundaries.test.ts
bun run check
```

Inference: admission now accounts for every configured applicable account atomically in the tested local flows, rather than merely computing headroom or storing caller-supplied batches. It does not check wallet solvency, authenticate callers, issue payment authority, execute funds or adapt limits from behavior. The static demo is unchanged.

Accepted review boundaries: claims/cancellation/automatic expiry (Task 6); conflicting evidence and committed containment (7); stale outbox acknowledgments/redelivery/orphan workers (8); independent-process races, kill/commit-before-response and power-loss evidence (9); complete compiled lifecycle smoke and remote Linux results (10). Authentication, signer/provider/protocol verification, solvency, actual payments, approvals and adaptation remain later/excluded work. Multi-asset/fees, post-history membership migration, hostile executable callbacks/Proxy traps, privileged DB rewriting, network filesystems, multi-host deployment and production scalability remain outside this trusted local contract.

Next is Task 6, not another payment integration or adaptive engine. No benchmark, hosted-wallet integration, approvals or adaptation is implied by this milestone. All Task 5 changes remain uncommitted; HEAD is still `9d696b8`, with nothing staged.
