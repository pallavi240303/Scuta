/** @file Stable, redacted validation failures shared by the static policy boundary. */

/** Machine-readable malformed-input categories; policy denials use separate reason codes. */
export type ValidationCode =
  | "INVALID_TYPE"
  | "INVALID_SHAPE"
  | "UNKNOWN_FIELD"
  | "INVALID_FORMAT"
  | "OUT_OF_RANGE"
  | "INCONSISTENT_POLICY";

/** Host-resolved owner, wallet, agent and delegation labels; not credentials or proof of authentication. */
export interface TrustedScope {
  readonly ownerId: string;
  readonly walletId: string;
  readonly agentId: string;
  readonly delegationId: string;
}

/** A typed boundary error with a stable code and safe field path. */
export class ValidationError extends Error {
  /**
   * Construct a field-specific error without retaining the rejected value.
   *
   * @param code - Stable malformed-input category for programmatic handling.
   * @param path - Trusted field label safe to expose in a message, never raw rejected input.
   */
  constructor(
    readonly code: ValidationCode,
    readonly path: string,
  ) {
    super(`${code} at ${path}`);
    this.name = "ValidationError";
  }
}

/**
 * Copy permitted own data properties without invoking their getters.
 *
 * Accepts inert plain or null-prototype objects, not a sandbox for Proxy traps.
 * Does not check required-field presence, validate nested values or freeze the copy.
 *
 * @param value - Untrusted object to inspect.
 * @param fields - Allowlist of own string property names; symbols and other names are rejected.
 * @param path - Trusted field label for redacted validation failures.
 * @returns A shallow null-prototype record containing only copied data-property values.
 * @throws {ValidationError} If the value is not an object, has a custom prototype,
 * contains unknown keys or uses accessor properties.
 */
export function validateObject(
  value: unknown,
  fields: readonly string[],
  path: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("INVALID_TYPE", path);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new ValidationError("INVALID_SHAPE", path);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !fields.includes(key))
      throw new ValidationError("UNKNOWN_FIELD", path);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw new ValidationError("INVALID_SHAPE", path);
    output[key] = descriptor.value as unknown;
  }
  return output;
}

/**
 * Validate an ASCII identifier without trimming or case normalization.
 *
 * @param value - Untrusted string of 1–64 characters: alphanumeric first, then alphanumeric, `_` or `-`.
 * @param path - Trusted field label for redacted errors.
 * @returns The original string after a full-value match, including rejection of trailing newlines.
 * @throws {ValidationError} If the value is not a string or does not satisfy the identifier format.
 */
export function validateIdentifier(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ValidationError("INVALID_TYPE", path);
  if (value.length > 64 || /^[A-Za-z0-9][A-Za-z0-9_-]*/u.exec(value)?.[0] !== value) {
    throw new ValidationError("INVALID_FORMAT", path);
  }
  return value;
}

/**
 * Validate an opaque network, asset or recipient label, not a provider address.
 *
 * @param value - Untrusted 1–256-character ASCII string, alphanumeric first,
 * followed by alphanumeric characters or `:`, `.`, `_`, `/`, `-`.
 * @param path - Trusted field label for redacted errors.
 * @returns The original case-sensitive label; no provider lookup or address verification is performed.
 * @throws {ValidationError} If the value is not a string or violates the length or character rules.
 */
export function validateProfileIdentifier(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ValidationError("INVALID_TYPE", path);
  if (value.length > 256 || /^[A-Za-z0-9][A-Za-z0-9:._/-]*/u.exec(value)?.[0] !== value) {
    throw new ValidationError("INVALID_FORMAT", path);
  }
  return value;
}

/**
 * Require an exact match against an explicit list of supported string values.
 *
 * @param value - Untrusted candidate; no coercion or case normalization is allowed.
 * @param choices - Permitted literal values, also defining the narrowed return type.
 * @param path - Trusted field label for redacted errors.
 * @returns The matching supported literal.
 * @throws {ValidationError} If the candidate is not a string or is absent from the choices.
 */
export function validateEnum<const T extends string>(
  value: unknown,
  choices: readonly T[],
  path: string,
): T {
  if (typeof value !== "string") throw new ValidationError("INVALID_TYPE", path);
  const selected = choices.find((choice) => choice === value);
  if (selected === undefined) throw new ValidationError("INVALID_FORMAT", path);
  return selected;
}

/**
 * Require a boolean without applying truthiness conversion.
 *
 * @param value - Untrusted candidate; strings and numbers are not accepted.
 * @param path - Trusted field label for redacted errors.
 * @returns The unchanged boolean.
 * @throws {ValidationError} If the candidate is not a boolean.
 */
export function validateBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ValidationError("INVALID_TYPE", path);
  return value;
}

/**
 * Parse a real calendar instant using exactly `YYYY-MM-DDTHH:mm:ss.sssZ`.
 *
 * @param value - Untrusted UTC timestamp string with three fractional-second digits.
 * @param path - Trusted field label for redacted errors.
 * @returns Safe-integer milliseconds since the Unix epoch; this does not check whether the instant has passed.
 * @throws {ValidationError} If the candidate is not a string, differs from the exact syntax
 * or fails the calendar-date parse/format round trip.
 */
export function validateTimestamp(value: unknown, path: string): number {
  if (typeof value !== "string") throw new ValidationError("INVALID_TYPE", path);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/u.exec(value)?.[0] !== value) {
    throw new ValidationError("INVALID_FORMAT", path);
  }
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new ValidationError("INVALID_FORMAT", path);
  }
  return timestamp;
}

/**
 * Validate an explicit evaluation time without reading the system clock.
 *
 * @param value - Untrusted candidate for nonnegative safe-integer epoch milliseconds.
 * @returns The unchanged evaluation instant.
 * @throws {ValidationError} If the candidate is not a number or is negative, fractional, nonfinite or unsafe.
 */
export function validateEvaluationTime(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError("OUT_OF_RANGE", "nowMs");
  }
  return value;
}

/**
 * Copy at most 100 consecutive array entries without invoking element getters.
 *
 * Values remain unvalidated and are copied shallowly; the returned array is not frozen.
 *
 * @param value - Untrusted ordinary array; sparse entries, accessor entries and extra keys are rejected.
 * @param path - Trusted field label for redacted errors.
 * @returns A new array of the original data-property values, in index order.
 * @throws {ValidationError} If the value is not an array or violates its prototype, size or property rules.
 */
export function validateArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new ValidationError("INVALID_TYPE", path);
  if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 100) {
    throw new ValidationError("INVALID_SHAPE", path);
  }
  const permitted = new Set<string>(["length"]);
  for (let index = 0; index < value.length; index += 1) permitted.add(String(index));
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !permitted.has(key))
      throw new ValidationError("UNKNOWN_FIELD", path);
  }
  const items: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) throw new ValidationError("INVALID_SHAPE", path);
    items.push(descriptor.value as unknown);
  }
  return items;
}

/**
 * Compare all four labels of two validated scopes using exact equality.
 *
 * @param left - First validated owner/wallet/agent/delegation scope.
 * @param right - Second validated scope to compare; neither scope is authenticated here.
 * @returns Whether every label matches, without coercion or mutation.
 */
export function matchesScope(left: TrustedScope, right: TrustedScope): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.walletId === right.walletId &&
    left.agentId === right.agentId &&
    left.delegationId === right.delegationId
  );
}

/**
 * Validate all ownership/delegation identifiers and freeze a separate scope copy.
 *
 * @param value - Untrusted, inert object with exactly the four required scope fields.
 * @param path - Trusted field-path prefix; defaults to `scope`.
 * @returns An independent frozen scope, not proof that the supplying caller owns it.
 * @throws {ValidationError} If any field is missing, unknown or fails the bounded identifier rules.
 */
export function validateScope(value: unknown, path = "scope"): TrustedScope {
  const record = validateObject(value, ["ownerId", "walletId", "agentId", "delegationId"], path);
  return Object.freeze({
    ownerId: validateIdentifier(record.ownerId, `${path}.ownerId`),
    walletId: validateIdentifier(record.walletId, `${path}.walletId`),
    agentId: validateIdentifier(record.agentId, `${path}.agentId`),
    delegationId: validateIdentifier(record.delegationId, `${path}.delegationId`),
  });
}
