# Scuta Phase 0 — Development Record

Status: Phase 0 complete; locally verified and independently reviewed. Updated 11 October 2026.

[How Scuta works](../how-scuta-works.md) · [Architecture](../core-authorization-design.md) · [Contributing](../../CONTRIBUTING.md)

[Implementation plan](phase-0-plan.md): approved contracts, six test-driven tasks, exact tool choices and verification gates. This file remains the only Phase 0 results record.

This is the single Phase 0 record: intent, expected outcome, design, tests, actual results and lessons. Create later records beside it when those phases start. A future root `CHANGELOG.md` summarizes user-facing changes, not this evidence.

## Initial thinking

Establish predictable payment contracts and static rules before adding adaptation. Prove amount precision, delegation boundaries, hard-deny precedence and deterministic request binding without signing or stateful budget claims. This foundation serves the [fixed project goals](../how-scuta-works.md#1-objective-and-success-criteria); a static evaluator alone is not the finished product.

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
- Structured JSDoc on named functions: a clear summary, `@param` descriptions for inputs, `@returns` for result meaning and relevant `@throws` conditions. Explain units, constraints, trust preconditions, mutation and side effects where useful; do not duplicate TypeScript types or add empty tag boilerplate. Public types and exported constants need concise semantic documentation rather than function tags.
- Test callbacks use descriptive test names, not repetitive JSDoc blocks. Inline comments explain non-obvious security reasoning only.
- No explicit `any`, unexplained non-null assertions, ignored compiler errors, floating-point money, or silent fallback to permissive defaults.
- Prefer readonly validated values and explicit result unions. Do not mutate caller inputs or rely on TypeScript readonly alone to protect retained policy state from runtime mutation.
- Add lint checks for supported documentation and naming conventions; review semantic clarity manually rather than claiming lint can prove it.

## Test files and acceptance criteria

Each module gets a separate matching `*.test.ts` file. Write failing tests before implementing the behavior.

| Area                 | Required cases                                                                                                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Amounts              | Exact round trip above JavaScript's safe integer range; smallest valid value; explicit maximum and maximum plus one; reject zero, negatives, fractions, signs, exponent notation, whitespace, leading zeros, oversized strings, and non-string wire amounts |
| Input validation     | Missing fields, unknown security fields, wrong types, malformed identifiers/addresses, invalid expiry, unsupported network/asset/capability                                                                                                                 |
| Policy validation    | Inconsistent limits, invalid recipient rules, missing version, invalid approval settings; runtime mutation cannot silently change an already validated snapshot                                                                                             |
| Scope                | Wrong owner, wallet, agent or delegation; revoked and expired delegation; caller-provided identity cannot replace trusted scope                                                                                                                             |
| Static decisions     | Normal allow; exact-limit allow; one-unit-over hard denial; autonomous-limit approval; unavailable approval route denies; forbidden recipient denies even if approval conditions match                                                                      |
| Time                 | One instant before expiry, exact expiry and after expiry using a supplied fixed clock value; invalid evaluation time rejected                                                                                                                               |
| Canonicalization     | Equivalent key ordering yields the same digest; every bound security field changes the digest; tracing metadata does not; scope and policy versions remain distinguishable                                                                                  |
| Purity and stability | Identical validated input yields identical evaluation; inputs remain unchanged; reason codes and precedence remain stable                                                                                                                                   |
| Package consumption  | Built public entry point can be imported and evaluated without test-runner internals or source-only path aliases                                                                                                                                            |

Use table-driven boundary tests and focused generated/property tests where they add evidence, especially amount serialization and canonicalization. Coverage must include all decision outcomes and relevant branch boundaries; a percentage alone is not the acceptance criterion.

## Scripts

Verified from the repository root with Bun 1.3.14. Build before standalone consumer tests or type/lint checks on a fresh checkout; `check`, `test`, `test:watch`, `test:coverage` and `demo` do that automatically.

| Command                         | Purpose                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile` | Reproducible installation after `bun.lock` exists; CI must also verify the lockfile is present          |
| `bun test`                      | Direct test runner; useful for individual source tests, or all tests after building                     |
| `bun run test`                  | Build and run discovered tests; fail on zero test files or any failed test                              |
| `bun run test:watch`            | Run `bun test --watch` during development                                                               |
| `bun run test:coverage`         | Build, run coverage with every core source preloaded, then verify LCOV inventory                        |
| `bun run typecheck`             | Run the pinned TypeScript compiler with `--noEmit` across source, tests, and examples                   |
| `bun run lint`                  | Naming, documentation, and code-quality checks                                                          |
| `bun run format:check`          | Check formatting without rewriting files                                                                |
| `bun run format`                | Apply formatting explicitly                                                                             |
| `bun run build`                 | Produce the core package build and declarations                                                         |
| `bun run demo`                  | Display normal allow, approval-required, and hard-denial examples with reasons; no funds or credentials |
| `bun run smoke`                 | Import emitted public exports and verify all three static outcomes; requires a build                    |
| `bun run check`                 | Build, format check, lint, typecheck, coverage tests/inventory and built-package smoke                  |

Bootstrap with `bun install`; verify thereafter with frozen-lockfile installation and the full check on the pinned toolchain, from a clean checkout or isolated clean copy—not cached output alone.

## What completion means

All documented scripts run successfully; failure cases actually fail; the built package works; static behavior is covered by tests; file/API documentation is concise and complete; README and CONTRIBUTING distinguish implemented Phase 0 behavior from future enforcement. No secret, payment, live network integration, database, dashboard, LLM, or behavioral baseline is added.

Implementation followed the approved order: validated contracts and tooling, delegation checks and canonicalization, evaluator and boundary tests, then demo/CI/documentation and clean verification. Changes remain uncommitted in the approved Desktop checkout.

## Actual outcome so far

Local verification after the readability cleanup on 11 October 2026: **249 tests passed across 11 separate test files** (initial implementation: 243). All **8 core implementation files** appear in LCOV; Bun reports **100% function and line coverage** on these files. This is not branch coverage, a performance benchmark, a compromise-detection result, or proof of leak-free enforcement.

| Deliverable         | Actual result                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Workspace and tools | Private core/example workspaces, exact dependencies, `bun.lock`, clean frozen install                                   |
| Validated contracts | Exact positive amounts up to `2^256 - 1`; autonomous zero; bounded fields; strict dates/URLs; recursively frozen copies |
| Delegation          | Host-scope comparisons, revocation, capability checks, expiry at/before/after boundaries                                |
| Binding             | Fixed-order, domain-separated SHA-256; intent known-answer independently checked with Node; all bound fields tested     |
| Static evaluation   | Hard-deny precedence, explicit approval eligibility, stable ordered reasons and policy/intent provenance                |
| Demo and package    | Built public workspace imports; deterministic allow/review/deny; no signing or payment identifiers                      |
| Local verification  | Formatting, lint, types, tests, coverage inventory, build and smoke pass in an isolated clean copy                      |
| CI                  | Pinned GitHub Actions configured; no remote run has occurred                                                            |

No authentication, SQLite, reservation, payment adapter, signer, approval service, behavior engine, or live financial exposure calculation was added. Inert decoded objects are the boundary: validators reject accessors/custom prototypes, but do not sandbox malicious executable host code or Proxy traps. Network/asset/recipient identifiers are opaque strings, not verified provider addresses. Digest helpers require parsed inputs; `evaluatePolicy` always revalidates wire objects. A static `ALLOW` is not a token, budget hold or payment authorization.

## Verification log

Tested state: working-tree changes on base commit `4c060fdde552d75a45b784f74aec778453d7446e`, no new commit. Local platform: Darwin arm64; Bun 1.3.14, TypeScript 6.0.3, ESLint 10.12.0, Prettier 3.9.10. Node v26.5.0 was used only for the independent SHA-256 fixture check. Exact dependency rationale lives in [Technology decisions](../technology-decisions.md#2-language-and-developer-tooling).

| Task              | Failing test evidence before implementation    | Subsequent complete-suite result                            |
| ----------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| 1: amounts/errors | 31 failures against missing behavior           | 31 passed / 2 files                                         |
| 2: wire contracts | 98 new failures against validator scaffolds    | 129 passed / 5 files                                        |
| 3: delegation     | 19 new failures; 17 existing cases passed      | 148 passed / 5 files                                        |
| 4: intent binding | 18 failures; 16 policy cases passed            | 182 passed / 6 files                                        |
| 5: evaluator      | 42 failures against evaluator scaffold         | 224 passed / 7 files                                        |
| 6: demo/tooling   | 4 demo/smoke failures and 3 inventory failures | 243 passed / 11 files after expanded boundary/export checks |

| Verification command or probe                                                                                                                                    | Observed result                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Clean-copy `bun install --frozen-lockfile`, `bun run check`, `bun run demo`                                                                                      | Exit 0; no pre-existing dependencies/build output; 243 tests, 8 core sources, three demo outcomes  |
| `bun run test:watch`                                                                                                                                             | Started and passed 243 tests; deliberately stopped with Ctrl-C (exit 130), no watcher left running |
| Invalid `result.reservationId` access in temporary copy; `bun run typecheck`                                                                                     | Exit 2, TS2339: field absent from `PolicyEvaluation`                                               |
| Missing file/API JSDoc and `bad_name`; `bun run lint`                                                                                                            | Exit 1, three expected documentation/naming errors                                                 |
| Unformatted temporary source; `bun run format:check`                                                                                                             | Exit 1 and named the offending file                                                                |
| Deliberate failing assertion; `bun run check`                                                                                                                    | Exit 1; failing test propagated to the full check                                                  |
| Temporarily hide all test files; `bun run check`                                                                                                                 | Exit 1: `No test files discovered`                                                                 |
| Add an uncalled source; `bun test packages/core/src/amount.test.ts --coverage --preload ./scripts/coverage-preload.ts`, then `bun scripts/coverage-inventory.ts` | Extra file visible at 0% functions/lines; inventory increased from 8 to 9                          |

Negative probes were performed only in a disposable copy; deliberately invalid files are absent from the Desktop source. Detailed local logs are retained in ignored `.superpowers/sdd/phase-0-plan/` and the task's verification artifacts; they are development evidence, not required repository dependencies. Contributors can reproduce the baseline with the commands above.

The initial independent read-only review found no Critical or Important issues and repeated `bun run check` in a separate copy with fresh build output: 243 passed / 11 files, 8-source coverage inventory and successful smoke. It reused installed dependencies rather than independently repeating frozen installation or historical negative probes. Its nonblocking diagnostic finding—policy limits reported the generic `amountAtomic` path—is resolved in the cleanup below.

## Readability and contract cleanup

Intent: make the existing core easier to use and review without adding Phase 1 features, dependencies or permissive fallbacks. Expected outcome: precise public types, explicit HTTP purchase variants, simpler validation/decision flow and useful redacted error paths.

Changes: `PolicyEvaluationInput` exposes wire types rather than `unknown` fields; runtime guards retain `unknown` because TypeScript cannot authenticate external data. GET forbids a body digest and POST requires one, including after method narrowing. Optional tracing is included only when present. Dense-array validation uses ordinary loops without invoking accessors. Shared scope comparison removes duplicated label checks. Evaluation now reads as validation → hard restrictions → approval eligibility → immutable explanation; hard-denial ordering and canonical digests remain unchanged.

Amount failures name `intent.amountAtomic`, `policy.hardTransactionLimitAtomic` or `policy.autonomousTransactionLimitAtomic`; messages never include the rejected amount. Amount parsers retain their default path for existing callers. Multiply malformed inputs may encounter a different validation field first; no promise of malformed-field precedence is made.

Evidence: before implementation, three new diagnostic cases failed and the compiler rejected useful access to four `unknown` public fields plus POST digest narrowing. After implementation, `bun run check` passed: 249 tests, 497 assertions, all eight core sources inventoried, build/format/lint/types/coverage/smoke successful. No strict rule was disabled. Runtime rejection tests deliberately bypass the types to verify the boundary still rejects malformed input.

Clean-copy verification: fresh `bun install --frozen-lockfile`, `bun run check` and `bun run demo` passed without cached dependencies/build output; the three demo outcomes and known digests were unchanged. Temporary negative compiler probes against the emitted declarations rejected POST without a digest, GET with a digest and numeric wire amounts (three TS2322 errors). Removing the probe restored passing type checks; no invalid probe file is present in the repository.

Independent cleanup review found no Critical, Important or Minor issues. Its separate-copy full check repeated 249 passing tests and compared 6,144 valid evaluation combinations with the pre-cleanup snapshot: decisions, ordered reasons, provenance, digests and frozen results matched. The reviewer reused installed dependencies; fresh installation and negative declaration probes were verified separately by the implementer. This review covers only the cleanup delta, not production enforcement. The inert-object/parsed-helper boundary, trusted scope and diagnostic paths remain assumptions; authentication, raw JSON decoding, provider security, stateful budgets, actual approvals/signing, remote compatibility and performance remain unproven or deferred. The approved unpublished type refinement intentionally does not preserve callers depending on the former `unknown` fields.

Failures encountered and fixed: ESLint flat-config wrapper/JSDoc selector mismatch; unused callback parameters rejected by TypeScript; Bun `test.each` treating an empty-array case as an argument tuple; an ES2023-only test method against the ES2022 target; widened reason literals; explicit Node type discovery for the build; root tooling resolving a workspace dependency available only to the example; asynchronous matcher type declarations and a coverage resolver error not satisfying `instanceof Error`. Fixes preserved strict rules and tested rejection behavior; no check was disabled to obtain a pass.

## Structured JSDoc follow-up

Replaced summary-only named-function documentation with clear parameter descriptions, return meaning and relevant error conditions across the core, example, fixtures and tooling helpers. Public contracts explain atomic units, GET/POST body requirements, trusted host scope and static-only evaluation. Parsed-input digest helpers explicitly state that they do not revalidate inputs. File overviews and descriptive test names remain; anonymous test callbacks do not gain repetitive documentation blocks.

Types and interfaces use concise JSDoc above their definitions, not comments between fields. Referenced types such as `TrustedScope` are documented at their own definitions; usage sites may link to them with `{@link TrustedScope}`. Function documentation retains units, constraints and trust preconditions.

Lint now checks supported tags, parameter names, parameter descriptions and return documentation. A disposable incomplete-doc probe passed under the former rules and failed with five expected documentation errors after the checks were enabled. The comment-stripped TypeScript representation matched the prior snapshot across all 26 files; no TypeScript behavior or types changed. `bun run check` passed with 249 tests, 497 assertions and the eight-source coverage inventory. Dependencies and Phase 0 scope are unchanged.

## CI and deferred AI review

On 11 October 2026, the maintainer chose to keep GitHub Actions only and defer CodeRabbit until a later implementation milestone and public release of the repository. No specific milestone has been selected. The temporary CodeRabbit configuration and activation instructions were removed; README and CONTRIBUTING now describe the current CI-only setup.

The existing `.github/workflows/check.yml`, product code, dependencies and lockfile remain unchanged. This cleanup makes no GitHub or CodeRabbit account changes and does not uninstall an App the maintainer may have authorized separately. Hosted CI still needs verification after commit/push.

## Scuta rename

The project is now named Scuta. Documentation, workspace names and the example import use the new name; the goals-and-flow document is now `how-scuta-works.md`. The existing `pennywise.intent.v1` and `pennywise.policy.v1` digest domains remain protocol identifiers, not branding: changing them would change transaction and policy bindings. This rename adds no authorization features and does not rename the Desktop directory or GitHub repository.

Verification: frozen Bun installation, `bun run check`, `bun run demo` and `git diff --check` passed. The suite still discovers 11 test files and passes 249 tests with 497 assertions; all eight core sources are included in coverage. Known-answer digest tests and demo digests are unchanged. Existing tests have not been relocated.

## Decisions and deviations

| Date       | Decision                                                               | Reason and impact                                                                                                  |
| ---------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 2026-10-10 | Begin with a stateless evaluator                                       | Separates policy correctness from later reservation and execution guarantees                                       |
| 2026-10-11 | Use Bun instead of the originally proposed toolchain                   | Maintainer preference; one package manager, runtime, script runner, and built-in test runner for Phase 0           |
| 2026-10-11 | Consolidate the phase design and progress in this file                 | One place to compare intent, evidence, and outcome without duplicate tracking docs                                 |
| 2026-10-11 | Document stack rationale and the SQLite/PostgreSQL deployment boundary | Keep the first reference single-host; make costs and reconsideration criteria explicit without adding dependencies |
| 2026-10-11 | Consolidate repeated guidance and link the fixed project goals         | Preserve Phase 0 tests/contracts while distinguishing this foundation from the adaptive release objective          |

Implementation decisions: work in the approved Desktop checkout without committing; add direct Node API types for explicit build resolution; build before consumer checks; prove absent authority fields with a conditional-type assertion plus a failing compiler probe rather than ignored errors; retain ignored test evidence until integration. Review covers the local working tree, not an immutable new commit. The parsed helper/inert-object boundary, raw JSON decoding, provider/HTTP security, stateful financial controls and remote/runtime/performance evidence remain explicitly outside Phase 0's proven behavior.

## Lessons and next step

The pure core makes static boundary behavior reproducible, but cannot account for pending money or enforce exclusive signer access. Loaded-file coverage needs explicit enumeration; successful test execution also needs separate type checking and build-consumer checks. Tool and test-harness errors must be distinguished from policy failures.

Next: design Phase 1's authoritative SQLite ledger, exact persisted amount encoding, atomic shared-budget holds, scoped idempotency and crash recovery before implementing execution. Do not treat Phase 0 evaluations as enforceable financial authority or claim adaptive behavior yet.

## Tooling references

- [Bun installation and lockfile behavior](https://bun.sh/docs/pm/cli/install) — workspace installation and reproducible dependency resolution.
- [Bun test runner](https://bun.sh/docs/test) — TypeScript tests, watch mode, coverage, and the distinction between executing tests and checking types.
