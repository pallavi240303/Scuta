# Contributing to Adaptive Agent Authorization

This project is designing a TypeScript authorization layer that adjusts agent spending authority based on observable behavior. The repository currently contains documentation only. APIs, package paths and test commands described in the design are planned, not installed or executable.

Start with the [README](README.md), then the [core design](docs/core-authorization-design.md). Security and accounting semantics in that document are the shared contract for future contributions.

## Current Contribution Status

Design reviews, documented counterexamples and scenario proposals are useful now. No license has been selected; do not assume contributions are accepted under an unspecified future license. The maintainer must select a license and establish contribution terms before accepting substantive patches.

A concrete private security-reporting channel is also not configured yet. Establish it before inviting executable security testing or publishing the first executable release. Do not invent an email address or imply that an unconfigured advisory process is available.

## What We Are Building First

The first reference deployment is one service outside the agent process, one authoritative SQLite database, and one configured mock x402 payment profile. Core engines are modules, not independently deployed microservices.

An embedded mode can reuse the core, but cannot claim protection from host code that bypasses it. Every contribution must distinguish intended behavior, tested implementation and deferred functionality.

## Non-Negotiable Design Requirements

Refer to the [numbered invariants](docs/core-authorization-design.md#3-invariants) in proposals and security-relevant pull requests.

- Bind identity and delegation to authenticated credentials before reading or changing financial state.
- Check every applicable shared wallet, agent, delegation and optional task budget atomically.
- Count live holds across window boundaries; do not free exposure because a day or TTL elapsed.
- Scope idempotency keys and return current status on valid retries without creating new authority.
- Bind one reservation to one execution identity, fixed payment nonce and immutable signing payload.
- Revalidate current policy, authority, delegation, expiry and approval when claiming execution.
- Treat already claimed or issued payments as outstanding after a freeze until resolved.
- Keep payment approval, authority recovery and policy changes under separate permissions.
- Commit decisions, reservations, authority changes and durable events together.
- Release an executed operation's exposure only through validated reconciliation evidence.
- Keep agent reports, descriptions, LLM output and payment-service responses untrusted until validated.
- Preserve deterministic signal calculations and explicit insufficient-history behavior.

These requirements are not proof that an implementation is secure. Each must have appropriate durable-store and adapter tests.

## Contribution Areas by Phase

The six-phase roadmap is canonical across the documentation.

| Phase | Contribution areas | Acceptance evidence |
|---|---|---|
| 0 — Contracts and static policy | Identity binding, canonical schemas, policy precedence, toolchain and CI | Boundary fixtures, deterministic digests and documented commands |
| 1 — Ledger and execution safety | SQLite transactions, shared budgets, scoped keys, execution claims and outbox | Separate-connection concurrency and crash-recovery tests |
| 2 — Mock x402 payment | Isolated gateway, restricted signer, exact profile and reconciliation | One debit per operation, no signer bypass and retained uncertain exposure |
| 3 — Durable approvals | Delivery adapters, expiry, approver permissions, caps and recovery | Stale/duplicate approval, freeze and timeout-race tests |
| 4 — Adaptive authority | Reference signals, baseline provenance, state transitions and cooldowns | Reproducible worked traces, cold-start and false-positive cases |
| 5 — Evaluation and adoption | Testkit, benchmark comparisons, examples and documentation | Reproducible results with legitimate-task and approval-cost measurements |

Scenarios and tests grow in every phase. A dashboard, new chain, generic contract-call adapter or Merkle proof layer should not delay the core accounting and execution work.

## Suggested Starter Tasks

These are suggested issue scopes, not claims that GitHub issues have already been created.

| Task | Concrete acceptance criteria |
|---|---|
| Canonical amount fixtures | Cover zero, negative, exponent, overflow and leading-zero forms; preserve exact integer value across serialization. |
| Scoped idempotency fixtures | Same key in different principals is isolated; same scoped key with changed digest conflicts; valid retry does not create another hold. |
| Window-rollover scenario | An outstanding hold remains counted beyond its originating window, then transfers into committed spend exactly once. |
| Approval/recovery review | One-off purchase approval leaves general authority unchanged; stale approval after freeze cannot execute. |
| Mock signer contract | Stable nonce/payload survives retries; changed payload and unauthorized caller fail. |
| Reference adaptive trace | Sixth and eleventh distinct requests produce the documented transitions; same-intent retry does not increment logical velocity. |
| Diagram and terminology review | Every signing route passes execution validation; denial and approval branches match lifecycle semantics. |
| Related-work comparison | Identify actual overlap with existing tools and distinguish documented claims from independently tested behavior. |

Before the workspace exists, contribute prose fixtures and counterexamples. After it exists, convert them into tests using the project's pinned tooling.

## Design Proposals

Discuss a change before implementing it if it alters identity scope, digest fields, budget semantics, policy precedence, execution identity, approval binding, baseline eligibility, recovery, settlement finality or audit guarantees.

A focused proposal should state:

1. The concrete trigger or failure.
2. The affected contract and invariant IDs.
3. The proposed before/after behavior.
4. Crash, retry, concurrency and revocation behavior.
5. Alternatives and compatibility impact.
6. A reproducible scenario and acceptance criteria.

Do not introduce a new primitive solely because it sounds more secure or scalable. Explain which requirement it satisfies. Avoid silently converting future roadmap items into mandatory runtime dependencies.

## Development Workflow

There is no package manifest or executable toolchain yet. No install, build or test command is currently available.

The Phase 0 bootstrap must add pinned Node.js and package-manager versions, a lockfile, strict TypeScript configuration, runtime schema validation, formatting/linting, test execution and CI. Update this guide with commands actually verified from a clean checkout as part of that same change.

Once available, use a focused branch, keep changes small, run the relevant checks and update the affected contract documentation. No git remote, issue tracker or security channel should be assumed to exist merely because this guide describes the future workflow.

## TypeScript and Data Rules

- Represent money internally as bounded integer atomic units; use canonical decimal strings on the wire.
- Do not convert monetary `bigint` values to `number` for risk comparisons.
- Use discriminated unions so a denied decision cannot be accidentally treated as executable.
- Validate every external field and reject unsupported schemes/capabilities.
- Derive trusted identity from credentials, not agent-supplied labels.
- Inject the clock and external adapters for reproducible tests.
- Keep pure policy/behavior functions independent of signing and networking.
- Do not put external calls inside the financial database transaction.
- Distinguish logical request, reservation, execution, payment nonce and delivery-attempt identities.
- Do not log credentials, reusable payment signatures or unredacted sensitive request bodies.

## Required Verification

Scale verification to the affected behavior. Documentation corrections do not require unrelated runtime tests.

### Policy and identity

Test hard-deny precedence, delegation ownership, per-scope record access, immutable policy versions, current-state checks and canonical request binding. An approval must not bypass a hard ceiling.

### Ledger and concurrency

Run against the actual persistent adapter using separate connections, and separate processes where relevant. A test with only a mock mutex is insufficient evidence of SQLite concurrency behavior.

Verify overlapping budget scopes, duplicate requests, competing claims, budget reductions below existing exposure, window rollover and expiry-versus-claim races. Assert final financial balances and unique execution identities.

### Crashes and settlement

Inject failures before/after transaction commit, execution claim, signing, signature persistence, submission and settlement recording. Include a successful payment followed by an application error.

Every recovery path must reuse the same operation or retain uncertainty. Lease expiry, generic exceptions, request timeout and agent-reported failure must not release an executed hold.

### Approval and recovery

Test authenticated responder identity, exact binding, expiry, duplicate/conflicting responses, policy changes, freezes, pending count limits and delivery retries. Approval must not change authority. Recovery must use its own permission or the explicit qualified cooldown rule.

### Behavior

Test the exact [reference adaptive policy](docs/core-authorization-design.md#6-reference-adaptive-policy), candidate-inclusive windows, boundary thresholds, insufficient history, frozen baseline versions and recovery qualifications.

Malformed/denied attempts may affect operational abuse counters but cannot become normal baseline examples. A settled purchase is not sufficient proof of benign training data. Do not silently implement automatic baseline promotion in version 1.

### Adapter contract

For the first x402 profile, bind the validated network, asset, recipient, value, payment validity, nonce and signing domain to the persisted operation. Independently validate settlement evidence. Resource binding in local policy must not be described as a field signed by EIP-3009 itself.

Assert that the agent cannot call a raw signer or submit replacement execution fields. Pin protocol versions and declare finality assumptions.

## Benchmark Contributions

Compare adaptive behavior against strong static baselines using identical hard ceilings and accounting protections. Hold out evaluation workloads from tuning.

Report legitimate task completion, loss, false blocks, approval burden, recovery time, uncertain exposure and latency. A system that denies everything is not a successful adaptive policy. Include slowly changing legitimate workloads, below-threshold attackers, poisoning attempts and defensive denial of service.

State algorithm/baseline versions, seeds, sample units, hardware and uncertainty. Do not present a mock demonstration as a production-security result.

## Pull-Request Checklist

- [ ] The change addresses one concrete problem and identifies affected contracts.
- [ ] Implemented, proposed and deferred behavior are clearly distinguished.
- [ ] Relevant invariant IDs and scenario IDs are named.
- [ ] Amounts, identity scope and request binding remain exact.
- [ ] Shared-budget, replay, execution and revocation implications were considered.
- [ ] Crash and uncertain-settlement behavior is explicit.
- [ ] Approval does not implicitly recover authority.
- [ ] Appropriate tests or document checks were actually run.
- [ ] README, design, diagrams and contributor guidance remain consistent.
- [ ] No credentials, reusable payment signatures or real funds are included.
- [ ] License and contribution terms are established before the patch is accepted.

Security-critical changes deserve a second independent review where available, but this is not a requirement to block ordinary documentation corrections or small unrelated contributions.

## Security Research and Community

Use simulated assets or explicitly authorized test environments. Do not target external systems or funds without permission. Keep exploit details and secrets out of public discussions until an actual private reporting channel and disclosure process exist.

Be specific and respectful. Challenge assumptions with traces, counterexamples and measurements. Document limitations and negative results. Maintainers should publish a concrete code of conduct and contact method as the contributor community opens.

## Licensing

No license has been selected. Apache-2.0 remains a maintainer decision. Do not use “by contributing you accept whichever license is selected later.” Once a license is committed, replace this section with the actual contribution terms and link to that file.

