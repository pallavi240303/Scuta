/** @file Trusted owner configuration with immutable membership, version history and revision-fenced ceilings. */
import { isDeepStrictEqual } from "node:util";
import type { Ledger, LedgerDependencies } from "./ledger.js";
import { LedgerError, type LedgerTransaction } from "./ledger-store.js";
import type { WalletConfiguration, BudgetAccount } from "./ledger-contracts.js";
import { validateWalletConfiguration, validateBudgetAccount } from "./ledger-validation.js";
import { validatePolicy, type Policy, type PolicyWire } from "./policy.js";
import { validateDelegation, type Delegation, type DelegationWire } from "./delegation.js";
import { validateArray, validateIdentifier, validateScope } from "./validation.js";
import { parseNonnegativeAtomicAmount } from "./amount.js";
import { applyLedgerEvent } from "./ledger-events.js";
import {
  readWalletScope,
  requireLedgerWallet,
  readLedgerTime,
  nextLedgerCounter,
  ledgerSuccess,
} from "./ledger-context.js";

/** Owner-only mutation methods; these are never an agent tool surface. */
export type LedgerConfiguration = Pick<
  Ledger,
  | "configureWallet"
  | "activatePolicy"
  | "activateDelegation"
  | "setBudgetCeiling"
  | "revokeDelegation"
>;

/** Reconstruct inert policy wire fields from the validated independent snapshot.
 * @param policy - Validated policy with computed digest.
 * @returns Immutable canonical wire representation.
 */
function policyWire(policy: Policy): PolicyWire {
  const { digest, ...fields } = policy;
  void digest;
  return Object.freeze({
    ...fields,
    hardTransactionLimitAtomic: policy.hardTransactionLimitAtomic.toString(),
    autonomousTransactionLimitAtomic: policy.autonomousTransactionLimitAtomic.toString(),
  });
}

/** Reconstruct inert delegation wire fields from its independent parsed snapshot.
 * @param delegation - Validated delegation.
 * @returns Immutable wire representation with canonical UTC expiry.
 */
function delegationWire(delegation: Delegation): DelegationWire {
  const { expiresAtMs, ...fields } = delegation;
  return Object.freeze({ ...fields, expiresAt: new Date(expiresAtMs).toISOString() });
}

/** Reject profile mismatches as owner configuration conflicts.
 * @param wallet - Authoritative wallet profile.
 * @param profile - Proposed policy or account profile.
 */
function requireProfile(
  wallet: WalletConfiguration,
  profile: Pick<WalletConfiguration, "network" | "asset">,
): void {
  if (wallet.network !== profile.network || wallet.asset !== profile.asset)
    throw new LedgerError("CONFIGURATION_CONFLICT");
}

/** Check a complete membership declaration without permitting hidden account removal or replacement.
 * @param tx - Owning transaction.
 * @param wallet - Validated wallet configuration.
 * @param accounts - Complete validated account declaration.
 * @returns New accounts to insert, or an empty list for an identical declaration.
 */
function newBudgetAccounts(
  tx: LedgerTransaction,
  wallet: WalletConfiguration,
  accounts: readonly BudgetAccount[],
): readonly BudgetAccount[] {
  if (
    accounts.filter((account) => account.scope.kind === "WALLET").length !== 1 ||
    new Set(accounts.map((account) => account.accountId)).size !== accounts.length
  )
    throw new LedgerError("CONFIGURATION_CONFLICT");
  for (const account of accounts) {
    requireProfile(wallet, account);
    if (account.scope.ownerId !== wallet.ownerId || account.scope.walletId !== wallet.walletId)
      throw new LedgerError("CONFIGURATION_CONFLICT");
  }
  const current = tx.listBudgets(wallet);
  for (const previous of current)
    if (!accounts.some((account) => isDeepStrictEqual(account, previous)))
      throw new LedgerError("CONFIGURATION_CONFLICT");
  const additions = accounts.filter(
    (account) => !current.some((previous) => previous.accountId === account.accountId),
  );
  if (
    (additions.length > 0 && tx.hasIntents(wallet)) ||
    additions.some((account) => account.revision !== 1)
  )
    throw new LedgerError("CONFIGURATION_CONFLICT");
  return additions;
}

/** Activate a changed delegation in the caller's existing transaction.
 * @param dependencies - Trusted host capabilities.
 * @param tx - Owning transaction.
 * @param delegation - Validated owner grant.
 * @returns The current or newly activated delegation.
 */
function activateDelegation(
  dependencies: LedgerDependencies,
  tx: LedgerTransaction,
  delegation: Delegation,
): Delegation {
  const wallet = readWalletScope(delegation.scope);
  requireLedgerWallet(tx, wallet);
  const previous = tx.getDelegation(delegation.scope);
  if (previous && isDeepStrictEqual(previous.delegation, delegation)) return previous.delegation;
  const nowMs = readLedgerTime(dependencies, tx, wallet);
  applyLedgerEvent(
    dependencies,
    tx,
    wallet,
    nowMs,
    { kind: "CONFIGURATION", subjectId: delegation.scope.delegationId },
    {
      delegations: [
        {
          record: {
            delegation,
            wire: delegationWire(delegation),
            revision: nextLedgerCounter(previous?.revision ?? 0),
          },
          expectedRevision: previous?.revision ?? null,
        },
      ],
    },
  );
  return delegation;
}

/** Bind owner configuration operations to the shared transaction port.
 * @param dependencies - Authoritative store, host clock and opaque ID producer.
 * @returns Trusted configuration methods without provider or database imports.
 */
export function createLedgerConfiguration(dependencies: LedgerDependencies): LedgerConfiguration {
  const { store } = dependencies;
  return {
    configureWallet(configuration, budgets) {
      const wallet = validateWalletConfiguration(configuration);
      const accounts = validateArray(budgets, "budgets").map(validateBudgetAccount);
      return store.transaction((tx) => {
        const previous = tx.getWallet(wallet);
        if (previous && !isDeepStrictEqual(previous, wallet))
          throw new LedgerError("CONFIGURATION_CONFLICT");
        const additions = newBudgetAccounts(tx, wallet, accounts);
        if (previous && additions.length === 0) return ledgerSuccess(previous);
        const identity = readWalletScope(wallet);
        const nowMs = readLedgerTime(dependencies, tx, identity);
        applyLedgerEvent(
          dependencies,
          tx,
          identity,
          nowMs,
          { kind: "CONFIGURATION", subjectId: wallet.walletId },
          {
            wallets: previous ? [] : [wallet],
            budgets: additions.map((account) => ({ account, expectedRevision: null })),
          },
        );
        return ledgerSuccess(wallet);
      });
    },
    activatePolicy(input) {
      const policy = validatePolicy(input);
      const wallet = readWalletScope(policy.scope);
      return store.transaction((tx) => {
        requireProfile(requireLedgerWallet(tx, wallet), policy);
        const previous = tx.getPolicy(policy.scope);
        if (previous?.policy.digest === policy.digest) return ledgerSuccess(previous.policy);
        const nowMs = readLedgerTime(dependencies, tx, wallet);
        applyLedgerEvent(
          dependencies,
          tx,
          wallet,
          nowMs,
          { kind: "CONFIGURATION", subjectId: policy.policyId },
          {
            policies: [
              {
                record: { policy, wire: policyWire(policy) },
                expectedDigest: previous?.policy.digest ?? null,
              },
            ],
          },
        );
        return ledgerSuccess(policy);
      });
    },
    activateDelegation(input) {
      const delegation = validateDelegation(input);
      return store.transaction((tx) =>
        ledgerSuccess(activateDelegation(dependencies, tx, delegation)),
      );
    },
    setBudgetCeiling(input, accountId, ceilingAtomic) {
      const wallet = readWalletScope(input);
      const id = validateIdentifier(accountId, "accountId");
      const ceiling = parseNonnegativeAtomicAmount(ceilingAtomic, "ceilingAtomic");
      return store.transaction((tx) => {
        requireLedgerWallet(tx, wallet);
        const previous = tx.getBudget(wallet, id);
        if (!previous) return Object.freeze({ ok: false, reason: "NOT_FOUND" });
        if (previous.ceilingAtomic === ceiling) return ledgerSuccess(previous);
        const nowMs = readLedgerTime(dependencies, tx, wallet);
        const account = Object.freeze({
          ...previous,
          ceilingAtomic: ceiling,
          revision: nextLedgerCounter(previous.revision),
        });
        applyLedgerEvent(
          dependencies,
          tx,
          wallet,
          nowMs,
          { kind: "CONFIGURATION", subjectId: id },
          { budgets: [{ account, expectedRevision: previous.revision }] },
        );
        return ledgerSuccess(account);
      });
    },
    revokeDelegation(input) {
      const scope = validateScope(input);
      return store.transaction((tx) => {
        requireLedgerWallet(tx, scope);
        const previous = tx.getDelegation(scope);
        if (!previous) throw new LedgerError("CONFIGURATION_MISSING");
        return ledgerSuccess(
          activateDelegation(
            dependencies,
            tx,
            Object.freeze({ ...previous.delegation, revoked: true }),
          ),
        );
      });
    },
  };
}
