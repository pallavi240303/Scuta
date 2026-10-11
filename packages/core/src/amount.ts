/** @file Exact bounded atomic amounts; payment amounts are positive canonical decimal strings. */
import { ValidationError } from "./validation.js";

/** Maximum atomic value supported by the first core contract, independent of asset decimals. */
export const MAX_ATOMIC_AMOUNT = (1n << 256n) - 1n;

/**
 * Parse an exact positive amount in the asset's smallest units.
 *
 * Accepts canonical decimal strings from 1 through `MAX_ATOMIC_AMOUNT`;
 * signs, whitespace, leading zeros, fractions and exponent notation are invalid.
 *
 * @param value - Untrusted decimal string, without an asset-decimal conversion.
 * @param path - Trusted error-field label; defaults to `amountAtomic`. Never pass sensitive input here.
 * @returns The exact atomic-unit integer, without floating-point conversion.
 * @throws {ValidationError} If the value is not a string, is malformed or exceeds the supported maximum.
 * @example
 * parseAtomicAmount("9007199254740993"); // 9007199254740993n
 */
export function parseAtomicAmount(value: unknown, path = "amountAtomic"): bigint {
  if (typeof value !== "string") throw new ValidationError("INVALID_TYPE", path);
  if (value.length > 78) throw new ValidationError("OUT_OF_RANGE", path);
  if (/^[1-9][0-9]*/u.exec(value)?.[0] !== value) {
    throw new ValidationError("INVALID_FORMAT", path);
  }
  const amount = BigInt(value);
  if (amount > MAX_ATOMIC_AMOUNT) throw new ValidationError("OUT_OF_RANGE", path);
  return amount;
}

/**
 * Serialize an exact atomic-unit amount for a wire contract.
 *
 * @param value - Positive integer no greater than `MAX_ATOMIC_AMOUNT`.
 * @returns A canonical base-10 string; no rounding or decimal scaling is performed.
 * @throws {ValidationError} If the runtime value is not a bigint or is outside the positive supported range.
 */
export function serializeAtomicAmount(value: bigint): string {
  if (typeof value !== "bigint") throw new ValidationError("INVALID_TYPE", "amountAtomic");
  if (value <= 0n || value > MAX_ATOMIC_AMOUNT) {
    throw new ValidationError("OUT_OF_RANGE", "amountAtomic");
  }
  return value.toString();
}

/**
 * Parse a spending cap that may disable autonomous spending with the string `"0"`.
 *
 * @param value - Untrusted canonical decimal string between zero and `MAX_ATOMIC_AMOUNT`.
 * @param path - Trusted error-field label; defaults to `amountAtomic`.
 * @returns The exact cap in atomic units; zero permits no positive autonomous spending.
 * @throws {ValidationError} If a nonzero value fails the positive-amount parsing rules.
 */
export function parseNonnegativeAtomicAmount(value: unknown, path = "amountAtomic"): bigint {
  return value === "0" ? 0n : parseAtomicAmount(value, path);
}
