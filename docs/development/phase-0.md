# PennyWise Phase 0 — Development Record

Status: design drafted; implementation not started. Updated 11 October 2026.

[How PennyWise works](../how-pennywise-works.md) · [Architecture](../core-authorization-design.md) · [Contributing](../../CONTRIBUTING.md)

This is the single Phase 0 record: intent, expected outcome, design, tests, actual results and lessons. Create later records beside it when those phases start. A future root `CHANGELOG.md` summarizes user-facing changes, not this evidence.

## Initial thinking

Establish predictable payment contracts and static rules before adding adaptation. Prove amount precision, delegation boundaries, hard-deny precedence and deterministic request binding without signing or stateful budget claims. This foundation serves the [fixed project goals](../how-pennywise-works.md#1-objective-and-success-criteria); a static evaluator alone is not the finished product.

Bun manages packages, execution, scripts and tests; TypeScript is the only product language. Avoid unnecessary Bun APIs in the pure core; cross-runtime compatibility is unverified until tested.

See [Technology decisions](../technology-decisions.md) for rationale and open choices. SQLite belongs to Phase 1; the evaluator remains storage-independent.

## Expected outcome

Deliver a reusable core that validates proposals/policy, checks delegated scope, and returns deterministic static evaluations with stable reasons. Include separate test files, automated checks, a local demo and verified contributor commands.

Phase 0 is not a wallet, a payment gateway, a reservation ledger, or an adaptive risk engine. A successful policy evaluation is not permission to sign or proof of available budget.

## Approach

Use one Bun workspace, one core package and a local example. Evaluation is synchronous and independent of storage, networking, signing, environment variables and wall-clock reads; supply time explicitly. Include strict type checking, runtime validation, formatting/linting, coverage, build checks and CI.

Rejected alternatives: a standalone script lacks the reusable package boundary; building the gateway now mixes persistence/payment concerns prematurely. Do not scaffold unused future packages.

Pin compatible Bun, TypeScript and lint/format versions; use `bun:test`, commit `bun.lock`, and use the same versions in CI. No second lockfile. Check source, tests and examples with the TypeScript compiler separately from test execution. Package names are local workspace names; keep publication disabled.

## Modules and contracts

- `amount.ts`: parse bounded, positive canonical decimal strings into atomic-unit `bigint` values and serialize them without floating-point conversion.
- `payment-intent.ts`: validate the core payment proposal, including scope selection, configured network/asset, recipient, amount, supported capability, and expiry.
- `policy.ts`: validate immutable policy snapshots containing explicit hard transaction limits, autonomous transaction limits, recipient rules, permitted network/asset, approval eligibility, version, and digest.
- `delegation.ts`: verify that a selected delegation belongs to the trusted caller scope and is active, unexpired, and permits the requested capability. Trusted scope is supplied by a trusted host; this phase does not implement credential authentication.
- `canonicalization.ts`: create deterministic, versioned, domain-separated digests of explicitly defined core fields. Bind scope, amount, recipient, network/asset, capability, resource identity, method, body digest where applicable, and expiry. Exclude tracing metadata and idempotency keys from payment semantics.
- `evaluate-policy.ts`: combine validated inputs using explicit denial precedence and return a pure `PolicyEvaluation`.
- `index.ts`: export the supported public API; no internal implementation shortcuts exposed for consumers.

Use a separate `PolicyEvaluation` union with `ALLOW`, `DENY`, and `REQUIRE_APPROVAL`, plus reason codes and policy provenance. Do not reuse the future reservation-bearing `Decision` type. Phase 0 results have no reservation ID, approval ID, execution token, or signing capability.

Phase 2 adds x402 challenge parsing, adapter-specific authorization binding and HTTP parsing. Phase 0 hashes only its validated core fields—not arbitrary challenges or a complete x402 authorization. The later raw-JSON boundary must reject duplicate keys before parsing loses them.

## Evaluation rules

1. Reject malformed input and invalid policy with typed validation errors; never silently produce ALLOW.
2. Deny cross-scope, expired, revoked, or unsupported delegations and requests.
3. Deny unsupported network, asset, or capability.
4. Deny forbidden recipients and amounts above the hard transaction ceiling.
5. Require approval for otherwise permitted amounts above the autonomous allowance or recipients requiring review, only when policy permits that approval route; otherwise deny.
6. Allow proposals satisfying every applicable Phase 0 rule.

Hard denials outrank approval conditions. Approval cannot override hard restrictions. Reason ordering is deterministic. An amount equal to a ceiling is inside it; a request or delegation expiring at evaluation time is expired. Policy validation rejects an autonomous limit above the hard limit.

Shared budgets, rolling exposure, and velocity counters require authoritative state and are deliberately not enforced by this stateless evaluator. Do not accept agent-supplied remaining-budget values as authoritative enforcement.

## Coding and documentation standards

- TypeScript only for product code, examples, and tests; configuration formats use their native syntax.
- `kebab-case` for source filenames; `camelCase` for functions, variables, and properties; `PascalCase` for types; `UPPER_SNAKE_CASE` for decision/reason literals and true module constants.
- Prefer specific names such as `parseAtomicAmount`, `validatePaymentIntent`, `validatePolicy`, `validateDelegationScope`, `computeIntentDigest`, and `evaluatePolicy`.
- Avoid vague catch-all modules such as `utils.ts`, `helpers.ts`, and `manager.ts`.
- Concise file-level JSDoc in every source, test, and example file. Add comments to configuration only where its format supports them; do not corrupt JSON with comments.
- Concise JSDoc on named functions, public types, and exported constants, explaining units, constraints, return meaning, and errors where useful. Do not repeat TypeScript type declarations in prose or add empty tag boilerplate.
- Test callbacks use descriptive test names, not repetitive JSDoc blocks. Inline comments explain non-obvious security reasoning only.
- No explicit `any`, unexplained non-null assertions, ignored compiler errors, floating-point money, or silent fallback to permissive defaults.
- Prefer readonly validated values and explicit result unions. Do not mutate caller inputs or rely on TypeScript readonly alone to protect retained policy state from runtime mutation.
- Add lint checks for supported documentation and naming conventions; review semantic clarity manually rather than claiming lint can prove it.

## Test files and acceptance criteria

Each module gets a separate matching `*.test.ts` file. Write failing tests before implementing the behavior.

| Area | Required cases |
|---|---|
| Amounts | Exact round trip above JavaScript's safe integer range; smallest valid value; explicit maximum and maximum plus one; reject zero, negatives, fractions, signs, exponent notation, whitespace, leading zeros, oversized strings, and non-string wire amounts |
| Input validation | Missing fields, unknown security fields, wrong types, malformed identifiers/addresses, invalid expiry, unsupported network/asset/capability |
| Policy validation | Inconsistent limits, invalid recipient rules, missing version, invalid approval settings; runtime mutation cannot silently change an already validated snapshot |
| Scope | Wrong owner, wallet, agent or delegation; revoked and expired delegation; caller-provided identity cannot replace trusted scope |
| Static decisions | Normal allow; exact-limit allow; one-unit-over hard denial; autonomous-limit approval; unavailable approval route denies; forbidden recipient denies even if approval conditions match |
| Time | One instant before expiry, exact expiry and after expiry using a supplied fixed clock value; invalid evaluation time rejected |
| Canonicalization | Equivalent key ordering yields the same digest; every bound security field changes the digest; tracing metadata does not; scope and policy versions remain distinguishable |
| Purity and stability | Identical validated input yields identical evaluation; inputs remain unchanged; reason codes and precedence remain stable |
| Package consumption | Built public entry point can be imported and evaluated without test-runner internals or source-only path aliases |

Use table-driven boundary tests and focused generated/property tests where they add evidence, especially amount serialization and canonicalization. Coverage must include all decision outcomes and relevant branch boundaries; a percentage alone is not the acceptance criterion.

## Planned scripts

These commands are deliverables to implement and verify, not available commands today:

| Command | Purpose |
|---|---|
| `bun install --frozen-lockfile` | Reproducible installation after `bun.lock` exists; CI must also verify the lockfile is present |
| `bun test` | Run the built-in test runner once; assert that tests are discovered and failures return a nonzero exit code |
| `bun run test:watch` | Run `bun test --watch` during development |
| `bun run test:coverage` | Run `bun test --coverage` with configuration including uncovered source files |
| `bun run typecheck` | Run the pinned TypeScript compiler with `--noEmit` across source, tests, and examples |
| `bun run lint` | Naming, documentation, and code-quality checks |
| `bun run format:check` | Check formatting without rewriting files |
| `bun run format` | Apply formatting explicitly |
| `bun run build` | Produce the core package build and declarations |
| `bun run demo` | Display normal allow, approval-required, and hard-denial examples with reasons; no funds or credentials |
| `bun run check` | Run formatting, lint, type checking, coverage tests, build, and built-package smoke checks |

Bootstrap with `bun install`; verify thereafter with frozen-lockfile installation and the full check on the pinned toolchain, from a clean checkout or isolated clean copy—not cached output alone.

## What completion means

All documented scripts run successfully; failure cases actually fail; the built package works; static behavior is covered by tests; file/API documentation is concise and complete; README and CONTRIBUTING distinguish implemented Phase 0 behavior from future enforcement. No secret, payment, live network integration, database, dashboard, LLM, or behavioral baseline is added.

Implementation will proceed in this order: validated contracts and tooling, delegation checks and canonicalization, evaluator and boundary tests, then demo/CI/documentation and clean verification. A detailed implementation plan follows approval of this scope.

## Actual outcome so far

As of 11 October 2026: documentation only. No manifest, lockfile, implementation, tests, demo or CI exists; no runtime, coverage, performance or security result is claimed.

| Deliverable | Current result | Evidence needed to mark complete |
|---|---|---|
| Phase design and Bun decision | Documented | This record and linked project docs |
| Workspace and pinned tools | Not implemented | Manifest, `bun.lock`, exact tool versions, clean install |
| Validated contracts and amount handling | Not implemented | Passing boundary tests and public contract review |
| Delegation and canonicalization | Not implemented | Scope-isolation and digest-binding tests |
| Static policy evaluator | Not implemented | Passing allow/deny/approval and precedence cases |
| Demo and developer commands | Not implemented | Actual command output and built-package smoke check |
| CI and full verification | Not implemented | Passing run tied to the tested revision |

## Verification log

No implementation checks have run. For each run, append date, tested revision/working-tree state, tool versions, exact command, result/test counts and a reproducible log/CI reference. Record failures/fixes as well as passes; expected output is not evidence.

## Decisions and deviations

| Date | Decision | Reason and impact |
|---|---|---|
| 2026-10-10 | Begin with a stateless evaluator | Separates policy correctness from later reservation and execution guarantees |
| 2026-10-11 | Use Bun instead of the originally proposed toolchain | Maintainer preference; one package manager, runtime, script runner, and built-in test runner for Phase 0 |
| 2026-10-11 | Consolidate the phase design and progress in this file | One place to compare intent, evidence, and outcome without duplicate tracking docs |
| 2026-10-11 | Document stack rationale and the SQLite/PostgreSQL deployment boundary | Keep the first reference single-host; make costs and reconsideration criteria explicit without adding dependencies |
| 2026-10-11 | Consolidate repeated guidance and link the fixed project goals | Preserve Phase 0 tests/contracts while distinguishing this foundation from the adaptive release objective |

## Lessons and next step

No implementation lessons yet. Record surprises, changes and limitations as observed. Next: finalize Phase 0 contracts/plan, then build and test. Advance to Phase 1 only with completion evidence.

## Tooling references

- [Bun installation and lockfile behavior](https://bun.sh/docs/pm/cli/install) — workspace installation and reproducible dependency resolution.
- [Bun test runner](https://bun.sh/docs/test) — TypeScript tests, watch mode, coverage, and the distinction between executing tests and checking types.
