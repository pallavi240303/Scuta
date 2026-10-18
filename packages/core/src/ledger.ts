/** @file Trusted financial coordinator; host authentication and payment execution are separate boundaries. */
import { createLedgerConfiguration } from "./ledger-configuration.js";
import { createLedgerAuthorization } from "./ledger-authorization.js";
import type { LedgerStore } from "./ledger-store.js";
import type { Policy, PolicyWire } from "./policy.js";
import type { Delegation, DelegationWire } from "./delegation.js";
import type { PaymentIntentWire } from "./payment-intent.js";
import type { TrustedScope } from "./validation.js";
import type {
  WalletConfigurationWire,
  WalletConfiguration,
  WalletScope,
  BudgetAccountWire,
  BudgetAccount,
  LedgerResult,
  LedgerStatus,
  BudgetExposure,
} from "./ledger-contracts.js";

/** Trusted store and deterministic host capabilities; callbacks must have no external side effects. */
export interface LedgerDependencies {
  readonly store: LedgerStore;
  readonly now: () => number;
  readonly createId: () => string;
}
/** Payment proposal with independently host-authenticated scope, never a caller-supplied ALLOW. */
export interface LedgerAuthorizationInput {
  readonly scope: TrustedScope;
  readonly intent: PaymentIntentWire;
}
/** Internal configuration/admission surface; do not hand this object to an agent. */
export interface Ledger {
  configureWallet(
    configuration: WalletConfigurationWire,
    budgets: readonly BudgetAccountWire[],
  ): LedgerResult<WalletConfiguration>;
  activatePolicy(policy: PolicyWire): LedgerResult<Policy>;
  activateDelegation(delegation: DelegationWire): LedgerResult<Delegation>;
  setBudgetCeiling(
    wallet: WalletScope,
    accountId: string,
    ceilingAtomic: string,
  ): LedgerResult<BudgetAccount>;
  revokeDelegation(scope: TrustedScope): LedgerResult<Delegation>;
  authorize(input: LedgerAuthorizationInput): LedgerResult<LedgerStatus>;
  getStatus(scope: TrustedScope, intentId: string): LedgerResult<LedgerStatus>;
  getBudgetExposure(wallet: WalletScope, accountId: string): LedgerResult<BudgetExposure>;
}

/** Construct the trusted coordinator around one authoritative store.
 * @param dependencies - Synchronous local storage, clock and opaque ID producer.
 * @returns The internal configuration and admission API.
 */
export function createLedger(dependencies: LedgerDependencies): Ledger {
  return Object.freeze({
    ...createLedgerConfiguration(dependencies),
    ...createLedgerAuthorization(dependencies),
  });
}
