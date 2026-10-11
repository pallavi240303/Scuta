# Contributing to PennyWise

PennyWise has a tested Phase 0 static core and an [MIT license](LICENSE). The gateway, ledger, payment integration, human approval service and adaptive engine remain planned. Boundary tests, counterexamples and focused PRs are useful now. Discuss substantial semantic changes before starting them.

## Local Setup

Use Bun **1.3.14**; dependencies are pinned in `package.json` and `bun.lock`:

```sh
bun install --frozen-lockfile
bun run check
bun run demo
```

`bun run check` builds the public package, checks formatting/lint/types, runs coverage tests with nonempty discovery and a complete core-source inventory, then verifies built exports. GitHub Actions runs the same command on push/PR; configuration is not evidence of a remote pass.

Use `bun run test`, `bun run test:watch`, or `bun run test:coverage` for focused development. `bun test` can target individual source test files; build first when running consumer tests. Use `bun run format` to apply formatting and `bun run format:check` to check without changes. No real funds or credentials are needed.

Read the [goals and flow](docs/how-pennywise-works.md), then the [engineering contract](docs/core-authorization-design.md). A contribution must strengthen authorization, exposure accounting, adaptation, approval safety, or their verification. Extra providers, infrastructure, or interfaces are not goals by themselves.

## Design Contract

Security-relevant changes must name the affected [invariants](docs/core-authorization-design.md#3-invariants) and [scenarios](docs/core-authorization-design.md#16-scenarios-and-expected-results). In particular:

- Derive identity/delegation from trusted credentials; isolate all record access.
- Reserve every applicable shared budget atomically; count pending and uncertain holds across window boundaries.
- Keep scoped retries bound to one intent, execution identity, nonce, and immutable payload.
- Revalidate current permission before execution; keep earlier potentially issued payments accounted for after a freeze.
- Separate payment approval, authority recovery, and policy administration.
- Persist decisions, reservations, authority updates, and durable events together.
- Release executed holds only through verified reconciliation; agent reports and generic timeouts are insufficient.
- Keep behavioral rules deterministic, with explicit cold starts and reviewed baseline versions.

Enforcement assumes isolated, exclusive signer access. Embedded guardrails cannot protect against host code that bypasses them. Describe planned, tested, and deferred behavior separately.

## Where to Contribute

Use the [six-phase roadmap](docs/core-authorization-design.md#17-implementation-phases) for sequencing and acceptance gates. Start with [Phase 0](docs/development/phase-0.md); later phases should not introduce dependencies into the pure core.

Suggested issue scopes—not already-created issues:

| Task                                 | Acceptance evidence                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Amount and canonicalization fixtures | Exact round trips; invalid forms rejected; every bound field changes the digest                     |
| Scoped retry fixtures                | Cross-principal isolation; changed-intent conflict; no additional hold on a valid retry             |
| Budget rollover and concurrency      | Live holds survive rollover; competing requests fit shared headroom                                 |
| Approval/recovery review             | One-off approval preserves restriction; stale approval after freeze cannot execute                  |
| Mock signer contract                 | Fixed nonce/payload survives retries; changed payload and unauthorized caller fail                  |
| Adaptive trace                       | Sixth/eleventh distinct requests match the reference policy; valid retries do not increase velocity |
| Flow and evaluation review           | No signer bypass; lifecycle branches agree; claimed benefits have measurable evidence               |

Add Phase 0 cases as executable `*.test.ts` files. For later phases, propose concise scenario fixtures first and convert them to tests when those contracts are implemented. Phase 1 ledger design is the next implementation boundary, not an invitation to add a signer now.

## Propose Semantic Changes First

Discuss changes to scope, digest fields, budget semantics, precedence, payment identity, approvals, baseline eligibility, recovery, finality, or audit guarantees. State the trigger, affected contracts/invariants, before/after behavior, retry/crash/concurrency/revocation implications, alternatives, compatibility cost, and a reproducible acceptance case.

For dependencies or deployment changes, follow [Technology decisions](docs/technology-decisions.md): record the requirement, exact choice, alternative, operational cost, and evidence. Do not present an unselected tool as a standard.

## Workflow and Code Standards

Keep Bun, TypeScript and development dependencies pinned, and include intentional `bun.lock` updates. Do not add another package-manager lockfile or bypass runtime validation, strict type checking, JSDoc/naming checks or coverage inventory. The [verified scripts and evidence](docs/development/phase-0.md#scripts) describe the current baseline. No hosted issue tracker or private security-reporting channel is assumed to exist.

Use focused branches and small PRs. Keep one phase record under `docs/development/` containing intent, expected/actual outcome, tests, exact verification evidence, decisions, and lessons. Record failures as well as passes; do not include sensitive logs. Add a root changelog when user-facing implementation changes exist.

- TypeScript only for product code, tests, and examples; follow the [naming and JSDoc standards](docs/development/phase-0.md#coding-and-documentation-standards).
- Document named functions with a clear summary, meaningful `@param`/`@returns` descriptions and relevant `@throws` conditions. Explain units, preconditions and side effects; do not duplicate TypeScript types or add empty tags.
- Put concise JSDoc above each type/interface definition, including referenced types such as `TrustedScope`; do not add comments between its fields.
- Use bounded atomic-unit `bigint` internally and canonical decimal strings externally; no floating-point money or monetary `number` conversions.
- Validate external fields and reject unsupported capabilities. Use explicit result unions and immutable validated values.
- Expose precise wire types to callers; keep `unknown` at runtime validation boundaries. Narrow GET/POST before accessing body fields rather than adding assertions or non-null operators.
- Inject time and adapters; keep policy/behavior pure and network calls outside financial transactions.
- Distinguish logical requests, reservations, executions, nonces, and delivery attempts.
- Do not log credentials, reusable payment signatures, or sensitive unredacted bodies.

## Required Verification

Write failing tests before implementing behavior. Scale checks to the change; prose corrections do not require unrelated runtime tests.

| Area                   | Required evidence                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Policy and identity    | Hard-deny precedence, owned delegation, per-scope access, immutable snapshots, canonical binding and current-state checks                                                                                             |
| Ledger                 | Real persistent-store tests using separate connections/processes where relevant; overlapping scopes, competing claims, rollover, budget reductions and expiry races; assert balances and unique execution identities  |
| Crashes and settlement | Failures before/after commit, claim, signing, signature persistence, submission and reconciliation; paid resource error; same-operation recovery or retained uncertainty, never release on lease expiry/timeout alone |
| Approvals and recovery | Authenticated exact binding, expired/stale/forged/duplicate/conflicting responses, policy/freeze races, queue caps and redelivery; approval never recovers authority                                                  |
| Behavior               | Exact reference thresholds, candidate-inclusive windows, insufficient history, baseline provenance, recovery qualifications and poisoning attempts; no automatic baseline promotion                                   |
| Payment adapter        | Persisted financial fields/domain/validity/nonce, unauthorized signer access, replacement-field rejection, independently verified evidence, pinned protocol and finality assumptions                                  |

EIP-3009 does not sign the resource URL or guarantee fulfillment; local purchase binding is separate. See the [reference adaptive policy](docs/core-authorization-design.md#6-reference-adaptive-policy) and [scenario catalogue](docs/core-authorization-design.md#16-scenarios-and-expected-results).

Benchmark changes must use identical hard limits and accounting protections, with evaluation workloads held out from tuning. Report harmful spend, task completion, false blocks, approvals, recovery, unresolved exposure, and latency. Include legitimate drift, below-threshold attacks, poisoning, and defensive denial of service. State versions, seeds, sample units, hardware, and uncertainty; distinguish mocks from external integration results. Blocking everything is not success.

## Pull-Request Checklist

- [ ] One concrete problem; affected contracts, invariant IDs, and scenarios identified.
- [ ] Proposed, implemented, and deferred behavior distinguished.
- [ ] Exact amounts, scope, binding, shared budgets, replay, revocation, and uncertain outcomes preserved.
- [ ] Approval and recovery remain separate.
- [ ] Relevant checks actually run; commands and results recorded.
- [ ] Documentation and diagrams agree; details live in their canonical document rather than being repeated.
- [ ] No credentials, reusable signatures, or real funds included.
- [ ] Contribution rights, MIT compatibility, and required third-party notices preserved.

Seek independent review for security-critical changes where available; this need not block ordinary prose corrections.

## Continuous Integration

[GitHub Actions](.github/workflows/check.yml) runs `bun run check` on pushes and PRs: build, formatting, lint, types, tests, coverage inventory and built-package smoke verification. Run the same command locally before submitting a PR and include the results. A passing check does not establish production financial safety; security-critical changes still need focused tests and human review.

CodeRabbit is deferred until the maintainer chooses a later implementation milestone and makes the repository public. No bot setup or credentials are required from contributors now. CI configuration alone does not prove a hosted pass or create branch protection.

## Security, Community, and License

Use simulated assets or explicitly authorized test environments; never target external funds or systems without permission. No private vulnerability-reporting channel is configured yet: establish one before executable public release and keep exploit details/secrets out of public discussions. Maintainers should publish a code of conduct and contact method as the community opens.

Be specific and respectful; use traces and measurements to challenge assumptions, and document limitations and negative results. Submit only material you have the right to contribute, under [MIT](LICENSE), preserving applicable notices.
