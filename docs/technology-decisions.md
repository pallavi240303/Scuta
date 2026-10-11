# PennyWise — Technology Decisions

Updated 11 October 2026. Design choices, not installed dependencies or measured performance. Every choice must support the [project goals](how-pennywise-works.md#1-objective-and-success-criteria), state its cost, and have verification evidence.

[Engineering contract](core-authorization-design.md) · [Phase 0 record](development/phase-0.md)

## 1. Why SQLite first, rather than PostgreSQL?

The first deployment is one self-hosted gateway with durable local state and a low-friction contributor setup. SQLite removes a separate database server; PostgreSQL is an alternative when multiple gateway hosts need shared authoritative state or measured writer contention prevents the required workload. Neither database makes a read-check-write sequence safe without correct transactions.

| Consideration | SQLite reference | PostgreSQL alternative |
|---|---|---|
| Setup | Local file; no database service | Server/managed instance, credentials and connections |
| Write coordination | Serialized writes | Row locks can coordinate unrelated rows concurrently |
| Shared wallet budget | Short serialized transactions | Explicit locking/isolation across affected budget rows |
| Several gateway hosts | Independent files cannot share authoritative headroom | Shared server fits this topology |
| Operations | Permissions, durable storage, backup/restore | Networking, pooling, availability, backup/restore |

SQLite supports concurrent connections but one writer; PostgreSQL permits finer-grained locking. Shared-wallet contention still exists in either system. There is no justified requests-per-second cutoff yet. [SQLite deployment guidance](https://www.sqlite.org/whentouse.html), [SQLite isolation](https://www.sqlite.org/isolation.html), [PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html).

### Required SQLite safeguards

- Use `BEGIN IMMEDIATE` for read/check/reserve/state/event writes, with uniqueness constraints, lifecycle checks and bounded busy retries. External calls occur after commit; an in-process mutex is not the concurrency guarantee.
- Test separate connections/processes, restarts, timeouts and expiry races; measure contention and latency.
- Choose and test journal/durability/backup settings in Phase 1. Use durable storage, not ephemeral files or a cross-host network filesystem.
- Preserve the entire allowed amount range with exact encoding/arithmetic. SQLite integers are bounded and REAL is floating point; never silently convert large atomic values to REAL or JavaScript `number`. [SQLite data types](https://www.sqlite.org/datatype3.html).

### Reconsideration and migration

Reconsider before Phase 1 if multi-host or managed-database operation is required. A PostgreSQL adapter needs ordered locking or suitable Serializable transactions, bounded deadlock/serialization retries, unique constraints and the same invariant tests. Default Read Committed with an unprotected read-check-insert sequence is insufficient. This is not a connection-string swap. [PostgreSQL isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

Migration must pause new authorization, preserve holds/approvals/policy revisions/payment identities, reconcile state and establish one authoritative writer before resuming. Never let both stores independently authorize the wallet.

**Decision:** SQLite first; PostgreSQL is a scoped alternative, not a promised extra adapter. Phase 0 has no database.

## 2. Language and developer tooling

| Choice | Reason | Cost and verification |
|---|---|---|
| TypeScript | One language for core, SDK, gateway, tests and examples; explicit result unions | Types do not validate runtime input; strict compilation plus malformed-input tests |
| Bun | Maintainer's choice for development runtime, package management and scripts | Pin versions/dependencies and `bun.lock`; verify clean frozen-lockfile installation and dependency compatibility; no automatic Node.js compatibility claim |
| Bun test runner | Test/watch/coverage without another runner | Separate `*.test.ts` files, fixed clocks, discovered/failing-test checks and coverage including unvisited files |
| TypeScript compiler check | Type-check source, tests and examples independently of execution | `bun run typecheck` runs the pinned compiler with `--noEmit`; invalid types must fail |
| Focused workspace packages | Shared contracts with core/store/adapter boundaries | Start with core only; smoke-test built public exports and declarations |
| JSDoc/file docs and style checks | Explain units, invariants and errors without redundant comments | Enforce supported rules; review semantic naming/documentation manually |
| CI | Reproducible checks beyond one machine | Provider/platform matrix open; run the same pinned toolchain and full local checks |

These are Phase 0 requirements; exact tool versions and style packages remain unselected. Test execution does not replace type checking. [TypeScript types](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html), [Bun tests](https://bun.sh/docs/test), [Bun installation](https://bun.sh/docs/pm/cli/install).

## 3. Runtime architecture and data

| Choice | Reason | Cost and verification |
|---|---|---|
| One gateway, internal modules | Understandable deployment and state coordination | No independently scaled engines; test module boundaries |
| Exclusive isolated execution credentials | Prevent agent code bypassing authorization | Operational isolation, not a type guarantee; test unauthorized access |
| Pure policy core | Deterministic decisions with injected time/data | Cannot enforce live shared budgets; Phase 0 ALLOW never permits signing |
| Atomic-unit `bigint`, decimal-string boundaries | Exact amounts and explicit encoding | Validate bounds/canonical form; test beyond safe-integer range and database round trips |
| Runtime schemas | Input, policy and receipts remain untrusted despite types | Library open; reject unknown security fields/invalid values without permissive fallback |
| Versioned canonical digests | Bind identical semantics across retries, approval and decisions | Encoding/hash implementation open; digests are not authentication; test field coverage/determinism |
| Durable relational ledger | Atomic holds, identities, approvals and state | Phase 1 schema/encoding need design; test real-store concurrency, atomicity and crashes |
| Memory store | Fast isolated tests and fault fixtures | Test-only; no restart or real-fund persistence guarantee |
| Transactional outbox/workers | State and work commit together; external calls follow | Repeated delivery needs event IDs/idempotent consumers and crash tests; not an external broker |
| Deterministic signals/authority states | Explain and reproduce permission changes without inference | Phase 4; measure missed attacks, false blocks, approval burden and recovery |
| Reviewed immutable baselines | Avoid automatic training on every settled payment | Review effort and slower benign drift; test poisoning and changing workloads |

No queue, cache or extra service is selected by these patterns. Detailed transaction and recovery semantics live in the [core contract](core-authorization-design.md).

## 4. Payment integration

| Choice | Reason | Cost and verification |
|---|---|---|
| x402 `exact` | Concrete paid HTTP challenge/response for the first example | Pin protocol/SDK, validate challenges, keep SDK types outside the pure core |
| EIP-3009 | Fixed payment fields/validity and single-use nonce fit stable execution identity | Compatible token required; nonce protection alone does not solve crashes/reconciliation |
| One asset/network | Prove accounting without cross-asset valuation | Reject unsupported profiles; no multi-chain claim |
| Mock signer/provider/resource | Controlled duplicate/crash/uncertainty tests without funds | Durable simulator ledger; no public-network finality or reliability claim |
| One external sandbox/testnet integration | Verify that the controller works beyond its simulator | Provider not selected; confirm access, bounded debit, retry identity, isolated credentials, status/evidence and finality, then reconcile independent records |

x402 is the payment protocol, not the behavior engine. EIP-3009 signs its defined payment fields—not the URL or response quality. Local purchase binding and verified settlement are separate. [x402 overview](https://docs.x402.org/introduction), [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009).

A hosted wallet can be the execution adapter while still settling on a blockchain. Provider choice does not change the authorization objective or imply universal compatibility. External integration belongs to the complete-release gate in Phase 5; mocks remain necessary for deterministic failure injection.

## 5. Open implementation choices

Runtime-validation library, linter/formatter, HTTP framework, SQLite driver, ORM/migrations, hosted wallet, approval channel, CI provider, exact versions and digest encoding/hash implementation remain open.

Choose tooling in Phase 0, storage in Phase 1, mock payment/HTTP in Phase 2, approval delivery in Phase 3, and the external integration by Phase 5. Record each choice, requirement, rejected alternative, operational cost and verification here; record actual results in the phase record.

A frontend framework, distributed cache, external broker, orchestration platform or LLM service is not required for initial correctness. Do not add infrastructure merely to enlarge the stack.
