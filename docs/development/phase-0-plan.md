# Scuta Phase 0 Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` for native implementation, or `superpowers:subagent-driven-development` only if the maintainer chooses delegation. Complete tasks in order; checkboxes track this plan, not claimed implementation results.

**Goal:** Deliver a tested, reusable static-policy core with exact amounts, trusted-scope checks, deterministic request binding, and a local demonstration.

**Architecture:** One Bun workspace containing a private core package and a non-networked example. Pure functions validate inputs and evaluate policy using explicitly supplied time/scope; there is no database, signer, payment execution, or behavior engine.

**Tech stack:** Bun 1.3.14, TypeScript 6.0.3, `@types/bun` 1.3.14, ESLint 10.12.0, `@eslint/js` 10.0.1, `typescript-eslint` 8.71.1, `eslint-plugin-jsdoc` 65.2.4, Prettier 3.9.10. Exact versions were checked against public registry metadata; installation/runtime compatibility remains to be tested. No runtime validation dependency: small explicit validators for the Phase 0 object contract.

**Spec:** [Phase 0 development record](phase-0.md), especially modules, evaluation rules, coding standards, acceptance cases and planned scripts. [Core engineering contract](../core-authorization-design.md) supplies future integration boundaries, not extra Stage 0 features.

## Global constraints

- TypeScript only for product code, examples, and tests; configuration formats use their native syntax.
- Bun for installation, execution, scripts and tests; exact dependencies, one `bun.lock`, publication disabled.
- `kebab-case` source files, `camelCase` functions/fields, `PascalCase` types, `UPPER_SNAKE_CASE` reason literals and module constants.
- File-level JSDoc in every source/test/example; concise JSDoc for named functions, public types and exported constants; no callback boilerplate or redundant comments.
- No explicit `any`, unexplained non-null assertions, ignored compiler errors, floating-point money, or silent fallback to permissive defaults.
- Supply time and trusted scope; no wall-clock reads, environment reads, signing, networking, stateful budgets, velocity or LLMs in the core.
- Write and run failing tests before each implementation. Record actual evidence only in `phase-0.md`; this plan is not a second progress diary.
- Work against the existing Desktop repository; do not push, publish, deploy or create commits without maintainer direction. If isolation is chosen, preserve the approved docs and report the checkout used.

## Review focus

| Input or condition                                 | Required behavior                                                                  | Owning task |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------- |
| Host passes a forged/mutated "validated" object    | Revalidate at the public evaluation boundary; do not trust a TypeScript cast       | 2 and 5     |
| Unicode, inherited fields or oversized identifiers | Reject ambiguous/non-plain input rather than silently normalize authority          | 2           |
| Calendar overflow or exact expiry                  | Strict UTC millisecond timestamps; invalid dates reject; `expiresAt <= now` denies | 2, 3 and 5  |
| Duplicate/reordered recipient/capability entries   | Duplicates reject; reorder of semantic sets does not change policy digest          | 2 and 4     |
| Consumer imports built package instead of source   | Public exports/declarations work without test internals or path aliases            | 6           |

## Files and contract decisions

Create only `packages/core`, `apps/example` and necessary root tooling. Planned core files are `validation.ts`, `amount.ts`, `payment-intent.ts`, `policy.ts`, `delegation.ts`, `canonicalization.ts`, `evaluate-policy.ts` and `index.ts`; each implementation module has a matching `*.test.ts`. `validation.ts` owns typed errors and shared object/identifier/time guards, not catch-all utilities. Shared test data lives in `packages/core/test/fixtures.ts`.

### Data contract to implement

Runtime validators treat object inputs as `unknown` until parsed. The public evaluator exposes typed wire contracts for callers but still revalidates them. Accept only `Object.prototype` or null prototypes; reject unknown fields, custom prototypes, inherited substitutes, accessors and invalid types. Copy into recursively frozen values; do not mutate caller inputs.

| Contract            | Fields and meaning                                                                                                                                                                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TrustedScope`      | `ownerId`, `walletId`, `agentId`, `delegationId`; supplied by the trusted host, not authenticated by this phase                                                                                                                                                                         |
| `PaymentIntentWire` | `schemaVersion: "1"`, `idempotencyKey`, `delegationId`, `network`, `asset`, `amountAtomic`, `recipient`, `capability` (bounded identifier), `resourceUrl`, GET/POST variant (body digest forbidden/required), `expiresAt`, optional `traceId`                                           |
| `PolicyWire`        | `schemaVersion: "1"`, `policyId`, `version`, `scope: TrustedScope`, `network`, `asset`, `hardTransactionLimitAtomic`, `autonomousTransactionLimitAtomic`, `recipientRules: {recipient, action: "ALLOW" \| "REQUIRE_APPROVAL" \| "DENY"}[]`, `defaultRecipientAction`, `approvalEnabled` |
| `DelegationWire`    | `schemaVersion: "1"`, `scope: TrustedScope`, `capabilities: readonly "PAY_HTTP_RESOURCE"[]` (may be empty), `revoked`, `expiresAt`                                                                                                                                                      |
| Parsed counterparts | Readonly copies; atomic amounts become `bigint`; wire `expiresAt` becomes integer `expiresAtMs`. `Policy` adds its computed digest, never an unchecked caller digest                                                                                                                    |
| `PolicyEvaluation`  | Discriminated `ALLOW`/`DENY`/`REQUIRE_APPROVAL`, ordered `reasonCodes`, `policyVersion`, `policyDigest`, `intentDigest`, `evaluatedAtMs`; no reservation, approval or execution identifiers                                                                                             |

Contract bounds: positive payment/hard amounts up to `MAX_ATOMIC_AMOUNT = 2^256 - 1`; autonomous limit may be zero to require approval. Canonical base-10 strings only. IDs use `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`. Network/asset/recipient are opaque case-sensitive profile identifiers of 1–256 ASCII characters `[A-Za-z0-9:._/-]`, beginning with an alphanumeric character; they are not verified blockchain addresses. Adapter-specific address validation is later work. Recipient/capability lists are capped at 100 entries and reject duplicates.

Times use exactly `YYYY-MM-DDTHH:mm:ss.sssZ`, validated by parse/format round trip and a safe-integer epoch value; evaluation time must be a nonnegative safe integer. Resource URLs are HTTPS, at most 2,048 characters, without credentials/fragments; normalize through `URL.href`, preserve query ordering. POST requires a lowercase 64-hex SHA-256 body digest; GET must omit it. Unknown security fields reject; `traceId` is the only optional tracing field and uses the ID bound. Raw JSON duplicate-key detection belongs to the later HTTP boundary; this API accepts objects, not JSON text.

Public boundary signatures:

```ts
parseAtomicAmount(value: unknown, path?: string): bigint
serializeAtomicAmount(value: bigint): string
validatePaymentIntent(value: unknown): PaymentIntent
validatePolicy(value: unknown): Policy
validateDelegation(value: unknown): Delegation
validateDelegationScope(delegation: Delegation, scope: TrustedScope,
  intent: PaymentIntent, nowMs: number): readonly DelegationReasonCode[]
computeIntentDigest(intent: PaymentIntent, scope: TrustedScope): string
computePolicyDigest(policy: PolicyDigestInput): string
evaluatePolicy(input: PolicyEvaluationInput): PolicyEvaluation
```

`PolicyEvaluationInput` contains typed wire `intent`, `policy`, `delegation`, host `scope` and `nowMs: number`. The evaluator accepts wire objects, not previously parsed snapshots, and creates its own validated copies. `HttpPurchase` discriminates GET (body digest forbidden) from POST (body digest required). Amount parsers optionally accept a trusted diagnostic field path, defaulting to `amountAtomic`. Validation failures throw `ValidationError` carrying `code` and `path`, never the sensitive input. Valid but expired/revoked/cross-scope/unsupported requests return policy DENY. `validateDelegationScope` returns reasons and does not throw for a valid denied delegation. These typing/diagnostic refinements were approved in the bounded Phase 0 cleanup recorded in [the phase record](phase-0.md#readability-and-contract-cleanup).

Policy validation uses an internal zero-accepting parser for the autonomous limit; the public payment parser remains strictly positive. Policy and intent serialization have explicit fixed field order and domain-separated SHA-256 through `node:crypto`; no Bun-specific API in the pure core. Digests are bindings, not authentication. Compute the policy digest from validated fields before freezing; avoid a policy-validator/canonicalization import cycle.

## Task 1: Workspace and exact amounts

**Files:** root `package.json`, `bun.lock`, `.gitignore`, `.prettierignore`, `.prettierrc.json`, `bunfig.toml`, `eslint.config.mjs`, `tsconfig.json`; `packages/core/package.json`, `tsconfig.build.json`, `src/validation.ts`, `src/validation.test.ts`, `src/amount.ts`, `src/amount.test.ts`.

**Interfaces:** Produce `ValidationError`, `ValidationCode`, `MAX_ATOMIC_AMOUNT`, the positive amount parser and serializer. Internal validation codes cover `INVALID_TYPE`, `INVALID_SHAPE`, `UNKNOWN_FIELD`, `INVALID_FORMAT`, `OUT_OF_RANGE` and `INCONSISTENT_POLICY`.

- [ ] Configure the private `@scuta/core` workspace with strict TypeScript, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, separate source/test checking, and exact tool versions. Install using Bun and verify declared peer compatibility; do not upgrade silently if tools fail.
- [ ] Write `amount.test.ts`: `parseAtomicAmount("9007199254740993") === 9007199254740993n`; minimum `"1"`; max round trip; max+1 and `"0"`, `"-1"`, `"+1"`, `"1.0"`, `"1e6"`, `" 1"`, `"01"`, 79-digit input and numeric values throw typed errors. Serializer rejects zero, negative and out-of-range values.
- [ ] Run `bun test packages/core/src/amount.test.ts`; record failure from missing behavior, not a broken test dependency.
- [ ] Implement the guards/parser/serializer with length checks before `BigInt` conversion; add error shape/redaction assertions in `validation.test.ts`.
- [ ] Run the amount/validation tests and `bun run typecheck`. Configure naming, no-explicit-any/non-null rules, `jsdoc/require-file-overview` and JSDoc on named functions/types/exported constants. Test callbacks are exempt from repetitive documentation.

**Gate:** exact amounts and typed validation errors work; configured tools start. Preserve results for the final phase record rather than claiming the whole phase passes.

## Task 2: Validated request, policy and delegation snapshots

**Files:** `src/payment-intent.ts`, `src/policy.ts`, `src/delegation.ts`, `src/canonicalization.ts` and matching tests; extend `validation.ts`/tests; create `test/fixtures.ts`.

**Interfaces:** Consume Task 1 guards; produce the wire/parsed types above, their three validators, and `computePolicyDigest`. Internal `PolicyDigestInput` is validated policy fields without `digest`; the encoder uses a type-only import to avoid a runtime cycle.

Fixtures: time `2026-10-11T00:00:00.000Z`, scope `owner-1/wallet-1/agent-1/delegation-1`, profile `mock:local`/`mock:usd`, merchant `merchant:weather`, URL `https://example.test/weather`, limits `20000000`/`10000000`, default DENY, explicit merchant ALLOW, approval enabled, policy version `"1"`, valid delegation expiry `2026-10-11T01:00:00.000Z`, intent expiry `2026-10-11T00:05:00.000Z`.

- [ ] Write table tests for required/unknown fields, wrong types, malformed/oversized/Unicode identifiers, accessors/custom prototypes, invalid calendar dates, forbidden URL credentials/fragments/schemes, POST body binding, duplicate rules/capabilities, and autonomous limit greater than hard limit. Validate zero autonomous limit as valid.
- [ ] Assert returned values are independent recursively frozen copies: changing the original scope/rule array cannot change a validated snapshot. Reordered valid lists remain acceptable.
- [ ] Run `bun test packages/core/src/payment-intent.test.ts packages/core/src/policy.test.ts packages/core/src/delegation.test.ts` and confirm red.
- [ ] Implement explicit validators, the fixture factory and the policy digest encoder with domain `pennywise.policy.v1`. Encode explicit validated fields in fixed-order JSON arrays, amounts as decimal strings, semantic recipient sets sorted by code-unit comparison, then SHA-256 lowercase hex. Test digest stability under key/rule reordering and change under a limit/version edit; Task 4 expands the binding matrix.
- [ ] Run contract/validation tests and type checking. Confirm unsupported but well-formed network/asset identifiers parse and are denied by evaluation later, not mistaken for malformed data.

**Gate:** validation, freezing and initial policy-digest tests pass; no placeholder digest or forward implementation dependency.

## Task 3: Delegation scope and time boundaries

**Files:** extend `src/delegation.ts` and `src/delegation.test.ts`.

**Interfaces:** Consume parsed intent/delegation and validated host scope; produce `validateDelegationScope(...): readonly DelegationReasonCode[]`. `DelegationReasonCode` is `SCOPE_MISMATCH | DELEGATION_REVOKED | DELEGATION_EXPIRED | CAPABILITY_NOT_DELEGATED`; Task 5 includes it in the wider evaluation `ReasonCode` union.

- [ ] Write tests changing each scope field independently: owner, wallet, agent, delegation; also mismatched intent delegation. Assert `SCOPE_MISMATCH` for each, without disclosing another scope's data.
- [ ] At the exact delegation expiry, expect `DELEGATION_EXPIRED`; one millisecond before is valid. Revocation denies; a requested undelegated capability denies. Invalid `nowMs` throws validation error.
- [ ] Run `bun test packages/core/src/delegation.test.ts` and confirm the new cases fail.
- [ ] Implement explicit comparisons and deterministic reason order; do not authenticate credentials or accept caller labels as trusted scope.
- [ ] Re-run the delegation tests/type check; show allowed fixtures still pass unchanged.

**Gate:** pure scope/revocation/expiry checks pass without ledger or network assumptions.

## Task 4: Canonical request and policy binding

**Files:** extend `src/canonicalization.ts`, `src/canonicalization.test.ts` and policy binding tests.

**Interfaces:** Produce `computeIntentDigest`; consume normalized types and Task 2's `computePolicyDigest`. Domains are `pennywise.intent.v1` and `pennywise.policy.v1`.

- [ ] Write tests: differently ordered object keys produce the same digest; changing each scope/payment/resource/method/body/expiry field changes the intent digest; changing idempotency key/traceId does not. GET omission and POST digest remain distinct.
- [ ] For policy, reordered recipient rules have identical digest; rule action, default action, limits, approval flag, profile, scope, policy ID and version changes alter it. Freeze/mutation tests from Task 2 must still pass. Intent/policy domains cannot collide for an equivalent encoded fixture.
- [ ] Run `bun test packages/core/src/canonicalization.test.ts` and confirm red.
- [ ] Implement fixed-order JSON array encoding of explicit fields: amounts as decimal strings, times as validated milliseconds, optional body digest as `null`; sort semantic sets by code-unit comparison, not locale. Use SHA-256 lowercase hex. Add a checked-in fixed known-answer fixture, verified against an independent Node crypto invocation.
- [ ] Run canonicalization/policy tests and type checking; document that this is local purchase binding, not full x402/EIP-3009 signing.

**Gate:** all validators and binding tests now pass; no hash of arbitrary unvalidated objects or caller-supplied digest is trusted.

## Task 5: Pure static-policy evaluation

**Files:** `src/evaluate-policy.ts`, `src/evaluate-policy.test.ts`, `src/index.ts`; extend fixtures.

**Interfaces:** Produce `PolicyEvaluationInput`, `PolicyEvaluation`, `ReasonCode` and `evaluatePolicy`. The public boundary validates all supplied objects/scope/time, then evaluates parsed copies. Export documented public contracts only.

Reason precedence: `SCOPE_MISMATCH`, `DELEGATION_REVOKED`, `DELEGATION_EXPIRED`, `INTENT_EXPIRED`, `CAPABILITY_NOT_DELEGATED`, `UNSUPPORTED_CAPABILITY`, `UNSUPPORTED_NETWORK`, `UNSUPPORTED_ASSET`, `RECIPIENT_FORBIDDEN`, `HARD_TRANSACTION_LIMIT_EXCEEDED`, `APPROVAL_UNAVAILABLE`. Collect applicable hard-denial reasons in this fixed order. The only supported capability is `PAY_HTTP_RESOURCE`. Otherwise approval reasons are `RECIPIENT_REQUIRES_APPROVAL`, then `AUTONOMOUS_LIMIT_EXCEEDED`; ordinary allow uses `WITHIN_STATIC_POLICY`. Policy scope must match the host scope.

- [ ] Write assertions for ALLOW at normal/exact autonomous limit, hard exact-limit eligibility, one-unit-over hard denial, above-autonomous approval, zero autonomous allowance, unknown/forbidden/review recipient rules, and disabled approval routing. With approval disabled, include `APPROVAL_UNAVAILABLE` and the approval triggers in the denial explanation.
- [ ] Test exact intent expiry versus one millisecond before; wrong scope/revoked/expired delegation; unsupported capability/network/asset; deterministic multiple-denial precedence. Forbidden recipient plus high amount must remain DENY, never REQUIRE_APPROVAL.
- [ ] Revalidate objects even if force-cast to parsed types; test malformed policy/scope and mutation of original input. Identical inputs yield deep-equal results; no result carries reservation/approval/execution IDs.
- [ ] Run `bun test packages/core/src/evaluate-policy.test.ts` and confirm red.
- [ ] Implement validation, owned-scope/delegation checks, hard rules, explicit approval routing, and versioned digest provenance. No budget balance input, asynchronous call, global clock or authority state.
- [ ] Run `bun test`, `bun run typecheck` and lint. Add a compile-time consumer assertion that accessing a reservation/signing credential is a type error, isolated from runnable source.

**Gate:** every static branch/boundary and explanation contract is tested; ALLOW remains an evaluation only.

## Task 6: Usable demo, build, checks, CI and evidence

**Files:** `apps/example/package.json`, `src/static-policy-demo.ts`, matching test; `scripts/verify-built-package.ts`, matching test; `scripts/coverage-preload.ts`; `.github/workflows/check.yml`; finish root scripts/config; update README, CONTRIBUTING, technology decisions and `phase-0.md` actual results.

**Interfaces:** Example imports `@scuta/core`; build outputs `packages/core/dist/index.js` and declarations via `tsc`. The workspace export points to built files; development tests use explicit source imports, no consumer path aliases. The smoke check imports the built public entry, evaluates fixtures, and fails on missing exports/incorrect result.

- [ ] Write demo/smoke tests: fixture results are ALLOW, REQUIRE_APPROVAL and DENY in fixed order, with reason/provenance and no payment identifiers; smoke test fails when the built entry is absent. Run and confirm red.
- [ ] Implement the no-network demo/build/smoke check. Cover the spec's install/test/watch/coverage/typecheck/lint/format/build/demo/check commands; add `bun run smoke`. Watch is interactive; verify startup then stop it, not leave it running.
- [ ] Coverage must include every core source file, not just imported modules. Bun documents loaded-file coverage: use a controlled source-enumerating preload and an LCOV file-inventory check, exclude only test/build/config files, and verify an unvisited temporary source is visible. Do not rely on a nonexistent configuration switch. Use text plus LCOV; inspect every decision boundary rather than equating percentage with correctness.
- [ ] Prove negative checks in a temporary copy: wrong type fails typecheck, missing file JSDoc/bad name fails lint, bad formatting fails format check, deliberate assertion failure and zero discovered tests fail verification. Do not commit deliberate failures or skip tests to turn checks green.
- [ ] Add GitHub Actions for push/PR with read-only permissions, pinned checkout/setup-bun action revisions, Bun 1.3.14, lockfile-presence check, `bun install --frozen-lockfile` and `bun run check`. Confirm official action revisions at implementation, not mutable guessed SHAs. CI is configured, not reported as passed until actually run externally.
- [ ] Run clean-copy frozen install, `bun run check`, `bun run demo`, and `git diff --check`. Record actual test counts, discovered files, coverage inventory, tool versions, exact commands, negative-check results and limitations in `phase-0.md`. Update docs only to verified capabilities and add exact tool rationale; preserve future-stage boundaries.
- [ ] Review the complete diff. Leave it uncommitted for the maintainer unless asked otherwise.

**Gate:** a clean checkout can install/build/test/use the public core and run the demo; all specified failures fail. No database, real payment, provider integration, wallet credentials, adaptive baseline or security-enforcement claim is introduced.

## Self-review and execution handoff

All Phase 0 acceptance areas map to Tasks 1–6; each of the five review-focus cases has an owning test. Contracts, units and names are defined above; Task 2 implements policy binding and Task 4 expands it before evaluation. Coding standards and planned scripts remain canonical in the phase record rather than duplicated as new implementation claims.

The maintainer approved native implementation in the existing Desktop repository. The plan is retained as the agreed specification; actual results, failures and deviations live only in the [Phase 0 record](phase-0.md). No commits, pushes, publication or payments are part of this implementation.

## Technical references

- [Bun test coverage](https://bun.sh/docs/test/code-coverage) — loaded-file coverage and text/LCOV reporters.
- [TypeScript ESLint typed linting](https://typescript-eslint.io/getting-started/typed-linting/) — type-aware checks and project configuration.
- [JSDoc file-overview rule](https://github.com/gajus/eslint-plugin-jsdoc/blob/main/docs/rules/require-file-overview.md) — file documentation enforcement.
- [Bun installation](https://bun.sh/docs/pm/cli/install) — exact dependencies and frozen-lockfile workflow.
