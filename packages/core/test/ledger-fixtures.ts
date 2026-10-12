/** @file Fresh mock ledger inputs with explicit atomic units and no execution credentials. */
import type {
  BudgetAccount,
  ExecutionBindingWire,
  WalletConfigurationWire,
} from "../src/ledger-contracts.js";
import { createScope, NOW_MS } from "./fixtures.js";

/** Create a single-profile trusted wallet fixture with bounded execution lifetimes.
 * @param overrides - Field replacements, including intentionally invalid test data.
 * @returns An independent wire configuration for the mock wallet.
 */
export function createWalletConfiguration(
  overrides: Partial<WalletConfigurationWire> = {},
): WalletConfigurationWire {
  return {
    ownerId: "owner-1",
    walletId: "wallet-1",
    network: "mock:local",
    asset: "mock:usd",
    signerId: "mock-signer-1",
    reservationTtlMs: 60_000,
    executionTtlMs: 60_000,
    orphanAfterMs: 60_000,
    ...overrides,
  };
}

/** Create one wallet budget with a 60-second rolling window.
 * @param overrides - Replacement validated account fields.
 * @returns A fresh account whose ceiling defaults to 100 atomic units.
 */
export function createBudgetAccount(overrides: Partial<BudgetAccount> = {}): BudgetAccount {
  return {
    accountId: "wallet-budget",
    scope: { kind: "WALLET", ownerId: "owner-1", walletId: "wallet-1" },
    network: "mock:local",
    asset: "mock:usd",
    windowMs: 60_000,
    ceilingAtomic: 100n,
    revision: 1,
    ...overrides,
  };
}

/** Create unsigned opaque mock payload metadata for local binding checks.
 * @param overrides - Field replacements for identity and mismatch tests.
 * @returns A fresh execution wire binding; no payment is signed or submitted.
 */
export function createExecutionBinding(
  overrides: Partial<ExecutionBindingWire> = {},
): ExecutionBindingWire {
  return {
    scope: createScope(),
    reservationId: "reservation-1",
    intentDigest: "a".repeat(64),
    signerId: "mock-signer-1",
    network: "mock:local",
    asset: "mock:usd",
    recipient: "merchant:weather",
    amountAtomic: "70",
    nonce: "b".repeat(64),
    validAfterMs: NOW_MS,
    validBeforeMs: NOW_MS + 60_000,
    payloadBase64: "cGF5",
    ...overrides,
  };
}
