# Scuta — Technology Decisions

Updated 17 October 2026. Phase 0 tooling, validation and hashing, plus Phase 1 contracts, the memory test store and SQLite transaction adapter, are implemented. Financial admission, gateway and payment implementation remain pending. No performance benefit is inferred from a stack choice. Every choice must support the [project goals](how-scuta-works.md#1-objective-and-success-criteria), state its cost, and have verification evidence.

[Engineering contract](core-authorization-design.md) · [Phase 0 record](development/phase-0.md)

## 1. Why SQLite first, rather than PostgreSQL?

The first deployment is one self-hosted gateway with durable local state and a low-friction contributor setup. SQLite removes a separate database server; PostgreSQL is an alternative when multiple gateway hosts need shared authoritative state or measured writer contention prevents the required workload. Neither database makes a read-check-write sequence safe without correct transactions.

| Consideration         | SQLite reference                                      | PostgreSQL alternative                                 |
| --------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| Setup                 | Local file; no database service                       | Server/managed instance, credentials and connections   |
| Write coordination    | Serialized writes                                     | Row locks can coordinate unrelated rows concurrently   |
| Shared wallet budget  | Short serialized transactions                         | Explicit locking/isolation across affected budget rows |
| Several gateway hosts | Independent files cannot share authoritative headroom | Shared server fits this topology                       |
| Operations            | Permissions, durable storage, backup/restore          | Networking, pooling, availability, backup/restore      |

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

### Memory transaction adapter

The internal `@scuta/store` adapter uses typed maps with copied, deeply frozen records. Each write callback works on private candidate maps and publishes them only on success; failures, thenables and escaped handles cannot commit late writes. The same observable contract tests will run against SQLite. This separates transaction semantics from the database driver, but memory cannot survive restarts or coordinate processes and is never a deployment substitute.

Snapshot copying explicitly accepts inert primitive/object/array data and preserves bigint. It rejects accessors, custom prototypes, sparse arrays and cycles. Native Bun `structuredClone` did not preserve shared scope references in the full fixture, so checked explicit copying is used instead. No runtime dependency was added; the existing standard-library `node:util` comparison checks immutable replay without depending on object-key insertion order.

### SQLite schema and encoding

- **Driver:** pinned Bun's built-in `bun:sqlite` avoids a native addon or ORM and fits synchronous local transactions. The internal SQLite adapter implements the store port without exposing its driver; this does not promise Node portability.
- **Schema:** STRICT tables, compound ownership keys, uniqueness constraints and deferred foreign keys reject malformed relational records while allowing intent/reservation/execution links to commit in one batch. Adapters must still check cross-record financial semantics; foreign keys alone do not authorize a payment.
- **Encoding:** canonical decimal TEXT preserves unsigned 256-bit money; safe-integer metadata stays INTEGER. Bounded canonical JSON retains complete typed records, while relational columns support lookups and independent validation. The cost is duplicated metadata and decode work; every column must match the validated payload.
- **Integrity:** versioned SQL checksums and exact schema comparison reject changed or unexpected objects, rather than silently repairing history. This detects incompatible layouts, not privileged data tampering. An intentional schema change needs a new migration.

Row codecs are private, reconstruct checked immutable records, recompute semantic digests and return redacted `STORE_CORRUPT` failures. Real SQLite tests cover constraints, malformed rows, repeated migration and close/reopen. WAL/FULL/foreign-key settings and guarded transactions are tested; independent-process crash recovery remains unverified.

### SQLite transaction adapter

Writes use `BEGIN IMMEDIATE` so they acquire write ownership before reading mutable state. Prepared queries bind values; checked batches enforce immutable identities, expected revisions/states/tokens and affected financial references before commit. Failed applies poison the whole callback even when caught. Read handles use deferred, query-only transactions so multi-query results share a snapshot without acquiring write ownership.

WAL lets a reader retain its snapshot while another connection commits; FULL requests SQLite's stronger synchronous durability setting. Neither configuration is evidence of power-loss or cross-process crash recovery. The adapter requires a local file and rejects memory-only paths instead of silently dropping WAL. Its cost is one serialized writer and dependence on the pinned Bun runtime and trustworthy local filesystem.

Busy handling retries complete rolled-back attempts at most three times, using a default 50 ms SQLite timeout. Test overrides are limited to 0–50 ms and one to three attempts. Private retry provenance distinguishes real driver contention from callback-generated ledger errors; deterministic conflicts and application errors are not retried. Callbacks must remain synchronous and free of external side effects because a retry can rerun them. The store never deletes live WAL sidecars; callers close their handles, and tests remove only their owned temporary directory after closing every connection.

Migration receives the same validated timeout as connection setup, including every initialization retry; direct migration calls default to 50 ms. A regression observes the actual connection setting before each immediate migration attempt under real writer contention, covering 0 ms, 7 ms and the default. This is a SQLite lock-wait setting, not an end-to-end startup latency guarantee. The earlier mismatch is resolved in the [Task 4 follow-up](development/phase-1.md#startup-timeout-fix-and-implementation-audit).

This is an internal storage port, not an admission engine: a trusted caller can submit a reservation without allocations. It validates supplied financial links but does not derive or require every applicable budget. Task 5 must perform that complete admission in one transaction before any execution integration is usable.

## 2. Language and developer tooling

| Choice                           | Reason                                                                          | Cost and verification                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript                       | One language for core, SDK, gateway, tests and examples; explicit result unions | Types do not validate runtime input; strict compilation plus malformed-input tests                                                                         |
| Bun                              | Maintainer's choice for development runtime, package management and scripts     | Pin versions/dependencies and `bun.lock`; verify clean frozen-lockfile installation and dependency compatibility; no automatic Node.js compatibility claim |
| Bun test runner                  | Test/watch/coverage without another runner                                      | Separate `*.test.ts` files, fixed clocks, discovered/failing-test checks and coverage including unvisited files                                            |
| TypeScript compiler check        | Type-check source, tests and examples independently of execution                | `bun run typecheck` runs the pinned compiler with `--noEmit`; invalid types must fail                                                                      |
| Focused workspace packages       | Shared contracts with core/store/adapter boundaries                             | Start with core only; smoke-test built public exports and declarations                                                                                     |
| JSDoc/file docs and style checks | Explain units, invariants and errors without redundant comments                 | Enforce supported rules; review semantic naming/documentation manually                                                                                     |
| CI                               | Reproducible checks beyond one machine                                          | GitHub Actions configured on Linux; remote results and broader platform support unverified                                                                 |

Phase 0 pins the following development-only tools; none adds a runtime dependency to the core:

| Tool                  | Exact version    | Why selected                                                                                                                                      |
| --------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bun / `@types/bun`    | 1.3.14 / 1.3.14  | One requested development runtime and test runner, with matching API types                                                                        |
| TypeScript            | 6.0.3            | Strict contracts and emitted declarations; inside the selected TypeScript ESLint peer range (`<6.1.0`), unlike registry-latest 7.0.2 at selection |
| `@types/node`         | 26.6.5           | Explicit Node API type resolution for the core-only build and standard `node:crypto`; types are not a runtime support guarantee                   |
| ESLint / `@eslint/js` | 10.12.0 / 10.0.1 | Flat configuration and standard code-quality checks                                                                                               |
| `typescript-eslint`   | 8.71.1           | Type-aware unsafe-operation and naming checks                                                                                                     |
| `eslint-plugin-jsdoc` | 65.2.4           | Enforce file overviews and documentation on public types, functions and exported constants                                                        |
| Prettier              | 3.9.10           | One automatic format for source, tests, configuration and Markdown                                                                                |

GitHub Actions is configured on Linux, with read-only repository permissions, Bun 1.3.14 and immutable action revisions: [checkout v4.3.0](https://github.com/actions/checkout/tree/08eba0b27e820071cde6df949e0beb9ba4906955) and [setup-bun v2.0.2](https://github.com/oven-sh/setup-bun/tree/735343b667d3e6f658f44d0eca948eb6282f2b76). Official tag references were verified before pinning. A remote CI pass and broader runtime/platform support remain unverified. The [phase record](development/phase-0.md) contains actual local checks and failures.

Test execution does not replace type checking. [TypeScript types](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html), [Bun tests](https://bun.sh/docs/test), [Bun installation](https://bun.sh/docs/pm/cli/install).

## 3. Runtime architecture and data

| Choice                                          | Reason                                                          | Cost and verification                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| One gateway, internal modules                   | Understandable deployment and state coordination                | No independently scaled engines; test module boundaries                                                  |
| Exclusive isolated execution credentials        | Prevent agent code bypassing authorization                      | Operational isolation, not a type guarantee; test unauthorized access                                    |
| Pure policy core                                | Deterministic decisions with injected time/data                 | Cannot enforce live shared budgets; Phase 0 ALLOW never permits signing                                  |
| Atomic-unit `bigint`, decimal-string boundaries | Exact amounts and explicit encoding                             | Validate bounds/canonical form; test beyond safe-integer range and database round trips                  |
| Runtime schemas                                 | Input, policy and receipts remain untrusted despite types       | Explicit Phase 0 object validators; future receipt/HTTP schemas deferred; reject unknown security fields |
| Versioned canonical digests                     | Bind identical semantics across retries, approval and decisions | Phase 0 fixed-order arrays and SHA-256; digests are not authentication; payment signing is deferred      |
| Durable relational ledger                       | Atomic holds, identities, approvals and state                   | SQLite transactions implemented; admission and independent-process concurrency/crash evidence pending    |
| Memory store                                    | Fast isolated tests and fault fixtures                          | Test-only; no restart or real-fund persistence guarantee                                                 |
| Transactional outbox/workers                    | State and work commit together; external calls follow           | Repeated delivery needs event IDs/idempotent consumers and crash tests; not an external broker           |
| Deterministic signals/authority states          | Explain and reproduce permission changes without inference      | Phase 4; measure missed attacks, false blocks, approval burden and recovery                              |
| Reviewed immutable baselines                    | Avoid automatic training on every settled payment               | Review effort and slower benign drift; test poisoning and changing workloads                             |

No queue, cache or extra service is selected by these patterns. Detailed transaction and recovery semantics live in the [core contract](core-authorization-design.md).

## 4. Payment integration

| Choice                                   | Reason                                                                           | Cost and verification                                                                                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| x402 `exact`                             | Concrete paid HTTP challenge/response for the first example                      | Pin protocol/SDK, validate challenges, keep SDK types outside the pure core                                                                                  |
| EIP-3009                                 | Fixed payment fields/validity and single-use nonce fit stable execution identity | Compatible token required; nonce protection alone does not solve crashes/reconciliation                                                                      |
| One asset/network                        | Prove accounting without cross-asset valuation                                   | Reject unsupported profiles; no multi-chain claim                                                                                                            |
| Mock signer/provider/resource            | Controlled duplicate/crash/uncertainty tests without funds                       | Durable simulator ledger; no public-network finality or reliability claim                                                                                    |
| One external sandbox/testnet integration | Verify that the controller works beyond its simulator                            | Provider not selected; confirm access, bounded debit, retry identity, isolated credentials, status/evidence and finality, then reconcile independent records |

x402 is the payment protocol, not the behavior engine. EIP-3009 signs its defined payment fields—not the URL or response quality. Local purchase binding and verified settlement are separate. [x402 overview](https://docs.x402.org/introduction), [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009).

A hosted wallet can be the execution adapter while still settling on a blockchain. Provider choice does not change the authorization objective or imply universal compatibility. External integration belongs to the complete-release gate in Phase 5; mocks remain necessary for deterministic failure injection.

## 5. Open implementation choices

Phase 0 uses small explicit validators rather than a schema dependency: the object contract is bounded and reviewable, with unknown-field, accessor, type and immutability tests. Its digests use fixed-order JSON arrays, decimal-string amounts, sorted recipient sets and domain-separated SHA-256 through `node:crypto`. This is local semantic binding, not authentication, an x402 signature, or an audit tree.

HTTP framework, hosted wallet, approval channel and protocol/SDK versions remain open. The SQLite driver, first migration and transaction adapter are selected above; the financial coordinator remains pending. No ORM is required until it solves a demonstrated storage need.

Choose tooling in Phase 0, storage in Phase 1, mock payment/HTTP in Phase 2, approval delivery in Phase 3, and the external integration by Phase 5. Record each choice, requirement, rejected alternative, operational cost and verification here; record actual results in the phase record.

A frontend framework, distributed cache, external broker, orchestration platform or LLM service is not required for initial correctness. Do not add infrastructure merely to enlarge the stack.
