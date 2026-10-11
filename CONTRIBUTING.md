# Contributing to Scuta

Scuta is building behavior-adaptive authorization for agent payments, bounded by owner-defined limits and accurate financial exposure. Contributions should improve that goal, not expand the project into a general wallet or agent platform.

## Scope and Current Priorities

Every contribution must strengthen **authorization, exposure accounting, adaptive authority, approval safety, or verification**. Read the [goals and boundaries](docs/how-scuta-works.md) and [implementation roadmap](docs/core-authorization-design.md#17-implementation-phases) before proposing work.

- **Implemented:** the TypeScript static-policy core, input validation, delegation checks and canonical binding. Current contributions can add boundary/regression tests, focused fixes, clearer contracts and accurate documentation.
- **Next:** design the authoritative SQLite ledger, atomic budget holds, scoped retries and crash recovery. Discuss those contracts before implementation.
- **Later:** isolated execution, the bounded x402 integration, durable approvals, deterministic adaptation and evaluation. Propose scenarios now; do not add later-phase infrastructure before its contracts are agreed.

The initial reference release targets one gateway/store, one configured payment profile and one verified external sandbox/testnet integration. The pure core stays separate from storage, networking and provider SDKs.

**Outside the initial scope:** custody infrastructure, trading, general agent orchestration, arbitrary contract calls/token allowances, bridging, cross-asset valuation, additional providers/assets/chains, dashboards, LLM-based authorization, automatic baseline promotion and multi-host deployment. Extra dependencies or integrations are not useful merely because they are available. See the [release boundaries](docs/core-authorization-design.md#19-deferred-scope-and-release-gates).

## Local Setup

Use Bun **1.3.14** and the committed lockfile:

```sh
bun install --frozen-lockfile
bun run check
bun run demo
```

Use `bun run test` or `bun run test:watch` during development, and `bun run format` for formatting. The demo uses mocks; no credentials or real funds are needed. See the [phase record](docs/development/phase-0.md) for scripts, evidence and limitations.

## Keep Issues and PRs Focused

For an issue or PR, explain:

1. **Problem and scope:** who is affected, which project goal and development phase it serves.
2. **Expected behavior:** a minimal reproduction for bugs, or a concrete scenario and acceptance criteria for proposals.
3. **Safety impact:** affected contracts, [invariant IDs](docs/core-authorization-design.md#3-invariants) and [scenario IDs](docs/core-authorization-design.md#16-scenarios-and-expected-results), where relevant.
4. **Evidence:** exact commands/results, compatibility impact and documentation updates; distinguish implemented behavior from plans.

Discuss changes to policy precedence, scope/binding, budget semantics, payment identity, approvals, recovery, finality or audit guarantees before coding. Dependency/deployment proposals must explain necessity, alternatives and operational cost using the [technology decisions](docs/technology-decisions.md).

Keep branches and PRs small and single-purpose. Do not bundle unrelated cleanup or future-phase features. Narrow or defer proposals that cannot be tied to a project goal and an acceptance case. Update the existing phase record when behavior changes; do not create duplicate tracking documents.

## Non-Negotiable Safety Rules

These are design requirements, not a claim that all controls already exist:

- Agents cannot rewrite owner policy, administer approvals/recovery or supply trusted settlement evidence. Adaptation and approval cannot override hard limits.
- Preserve principal/delegation isolation, canonical purchase binding and scoped retry identity. A retry must not create another budget hold or payable operation.
- Reserve all applicable budgets atomically; keep pending and uncertain payments counted across window rollover.
- Revalidate current permission before execution. A freeze blocks new claims, but previously issued payments may still settle and remain exposure.
- Bind approval to one exact purchase; payment consent, authority recovery and policy administration are separate permissions.
- Release potentially executed holds only on verified non-execution/final non-redeemability, never merely on a timeout or an agent's failure report.
- Commit financial state and durable events together. Keep behavioral rules deterministic, baselines versioned/reviewed, and recovery explicit.

A static `ALLOW` is not a reservation or permission to sign. Embedded checks can be bypassed by host code; enforcement requires an isolated, exclusive signing path. Do not claim zero loss, perfect compromise detection or production safety from mocks or coverage.

## Code and Test Standards

- Use TypeScript for product code, tests and examples; keep policy logic pure, with injected time/adapters and no provider SDK dependencies.
- Use precise types, immutable validated values and explicit result unions. Keep `unknown` at validation boundaries; do not bypass checks with unsafe assertions.
- Use bounded atomic-unit `bigint` internally and canonical decimal strings externally. Never use floating-point money.
- Keep names clear. Add file overviews and meaningful function JSDoc (`@param`, `@returns`, relevant `@throws`); put concise JSDoc above types/interfaces, not between fields.
- Keep dependencies pinned and include intentional `bun.lock` changes. Do not introduce another package-manager lockfile or weaken lint, types, runtime validation or coverage checks.

Write failing tests before behavior changes. Test rejection paths and affected boundaries, not just successful decisions. Future stateful work needs real-store concurrency/restart tests, crash and replay cases, stale approvals and ambiguous outcomes—not mock-only evidence. Keep fixtures deterministic and logs redacted.

Benchmarks must use identical hard limits/accounting and held-out workloads; report harmful exposure, useful task completion, false blocks, approvals, recovery and latency. Blocking everything is not success. Detailed requirements live in the [scenario catalogue](docs/core-authorization-design.md#16-scenarios-and-expected-results) and [evaluation contract](docs/core-authorization-design.md#18-evaluation).

## Continuous Integration

[GitHub Actions](.github/workflows/check.yml) runs `bun run check`: build, formatting, lint, types, tests, coverage inventory and built-package smoke verification. Run it before code PRs and record the result. For documentation-only changes, check formatting, links and consistency; report exactly what was checked.

CI does not replace human review of security-critical changes. CodeRabbit remains deferred until a later implementation milestone and a public repository.

## Security and License

Use mocks or explicitly authorized test environments; never test against external funds or systems without permission. Do not commit credentials, reusable signatures or sensitive payment data. A private vulnerability-reporting channel must be established before executable public release; do not publish sensitive exploit details in issues.

Be specific and respectful. Contribute only work you have the right to share under [MIT](LICENSE), preserving required third-party notices.
