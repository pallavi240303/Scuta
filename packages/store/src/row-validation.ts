/** @file Runtime decoding helpers for inert canonical SQLite payloads; no unchecked financial casts. */
import { Buffer } from "node:buffer";
import { LedgerError, parseAtomicAmount, type WalletScope, type TrustedScope } from "@scuta/core";

/** JSON values after checked conversion of bigint money to decimal text. */
type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Enforce a persisted-data invariant without including raw record contents in errors.
 * @param condition - Required decoding condition.
 * @throws {LedgerError} If the condition is false.
 */
export function requireRow(condition: boolean): asserts condition {
  if (!condition) throw new LedgerError("STORE_CORRUPT");
}

/** Read own inert object fields and reject unexpected keys or accessor properties.
 * @param value - Untrusted parsed object or driver row.
 * @param fields - Optional exact allowlist for this record kind.
 * @returns Independently owned raw fields awaiting typed validation.
 * @throws {LedgerError} If shape, prototype or properties are invalid.
 */
export function readObject(value: unknown, fields?: readonly string[]): Record<string, unknown> {
  requireRow(typeof value === "object" && value !== null && !Array.isArray(value));
  const prototype: unknown = Object.getPrototypeOf(value);
  requireRow(prototype === Object.prototype || prototype === null);
  const entries: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(value)) {
    requireRow(typeof key === "string" && (fields === undefined || fields.includes(key)));
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireRow(descriptor !== undefined && "value" in descriptor);
    const field: unknown = descriptor.value;
    entries.push([key, field]);
  }
  return Object.fromEntries(entries);
}

/** Read bounded text without coercing numbers or normalizing content.
 * @param value - Untrusted string value.
 * @param maximum - Maximum code-unit length.
 * @returns Original checked text.
 * @throws {LedgerError} If type or bounds are invalid.
 */
export function readString(value: unknown, maximum = 256): string {
  requireRow(typeof value === "string" && value.length > 0 && value.length <= maximum);
  return value;
}

/** Read a canonical scoped identifier.
 * @param value - Untrusted label.
 * @returns Exact bounded identifier.
 * @throws {LedgerError} If its ASCII syntax is invalid.
 */
export function readIdentifier(value: unknown): string {
  const text = readString(value, 64);
  requireRow(/^[A-Za-z0-9][A-Za-z0-9_-]*/u.exec(text)?.[0] === text);
  return text;
}

/** Read a nonnegative safe integer without numeric-string or bigint coercion in payloads.
 * @param value - Untrusted JSON number.
 * @param positive - Whether zero is forbidden.
 * @returns Exact checked integer.
 * @throws {LedgerError} If type, precision or sign is invalid.
 */
export function readInteger(value: unknown, positive = false): number {
  requireRow(
    typeof value === "number" && Number.isSafeInteger(value) && value >= (positive ? 1 : 0),
  );
  return value;
}

/** Read one member of a closed record discriminator set.
 * @param value - Untrusted discriminator.
 * @param choices - Fixed supported values.
 * @returns The exact recognized member.
 * @throws {LedgerError} If the value is unsupported.
 */
export function readEnum<T extends string>(value: unknown, choices: readonly T[]): T {
  const selected = choices.find((choice) => choice === value);
  requireRow(selected !== undefined);
  return selected;
}

/** Read a canonical digest or nonce.
 * @param value - Untrusted 64-character lowercase hexadecimal value.
 * @returns Exact checked identity.
 * @throws {LedgerError} If its syntax is invalid.
 */
export function readDigest(value: unknown): string {
  const text = readString(value, 64);
  requireRow(text.length === 64 && /^[a-f0-9]{64}/u.exec(text)?.[0] === text);
  return text;
}

/** Read a nullable identifier without treating missing fields as null.
 * @param value - Exact null or identifier.
 * @returns Checked nullable label.
 * @throws {LedgerError} If a non-null label is invalid.
 */
export function readNullableId(value: unknown): string | null {
  return value === null ? null : readIdentifier(value);
}

/** Read a nullable booking/lease instant without filling missing fields.
 * @param value - Exact null or safe integer.
 * @returns Checked nullable instant.
 * @throws {LedgerError} If a non-null value is invalid.
 */
export function readNullableTime(value: unknown): number | null {
  return value === null ? null : readInteger(value);
}

/** Read exact positive decimal payment money.
 * @param value - Canonical atomic-unit string, never a JSON number.
 * @returns A bounded positive bigint.
 * @throws {LedgerError} If type, syntax or range is invalid.
 * @throws {ValidationError} If the core amount boundary rejects the text.
 */
export function readAmount(value: unknown): bigint {
  return parseAtomicAmount(readString(value, 78));
}

/** Read only owner/wallet labels.
 * @param value - Untrusted wallet object.
 * @returns Independently owned wallet scope.
 * @throws {LedgerError} If shape or labels are invalid.
 */
export function readWallet(value: unknown): WalletScope {
  const raw = readObject(value);
  return { ownerId: readIdentifier(raw.ownerId), walletId: readIdentifier(raw.walletId) };
}

/** Read full ownership labels without authenticating them.
 * @param value - Untrusted scoped record.
 * @returns Independently owned full scope.
 * @throws {LedgerError} If shape or labels are invalid.
 */
export function readScope(value: unknown): TrustedScope {
  const raw = readObject(value, ["ownerId", "walletId", "agentId", "delegationId"]);
  return {
    ownerId: readIdentifier(raw.ownerId),
    walletId: readIdentifier(raw.walletId),
    agentId: readIdentifier(raw.agentId),
    delegationId: readIdentifier(raw.delegationId),
  };
}

/** Parse a dense bounded array with a supplied typed member decoder.
 * @param value - Untrusted JSON array.
 * @param member - Decoder for every member.
 * @returns Independently owned decoded members.
 * @throws {LedgerError} If array shape or length is invalid.
 */
export function readArray<T>(value: unknown, member: (input: unknown) => T): readonly T[] {
  requireRow(
    Array.isArray(value) && value.length <= 100 && Object.getPrototypeOf(value) === Array.prototype,
  );
  requireRow(Reflect.ownKeys(value).length === value.length + 1);
  const output: T[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    requireRow(descriptor !== undefined && "value" in descriptor);
    const input: unknown = descriptor.value;
    output.push(member(input));
  }
  return output;
}

/** Convert inert data into sorted JSON fields, rejecting cycles, unsafe numbers and excessive depth.
 * @param value - Typed input or decoded payload candidate.
 * @param path - Active object traversal path.
 * @param depth - Current bounded nesting depth.
 * @returns Independent JSON data with bigint represented as text.
 * @throws {LedgerError} If the value cannot be safely persisted.
 */
function jsonValue(value: unknown, path: WeakSet<object>, depth: number): JsonValue {
  requireRow(depth <= 32);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    requireRow(value.length <= 131072);
    return value;
  }
  if (typeof value === "number") {
    requireRow(Number.isSafeInteger(value));
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  requireRow(typeof value === "object" && value !== null && !path.has(value));
  path.add(value);
  if (Array.isArray(value)) {
    const result = readArray(value, (input) => jsonValue(input, path, depth + 1));
    path.delete(value);
    return result;
  }
  const raw = readObject(value);
  const result = Object.fromEntries(
    Object.keys(raw)
      .sort()
      .map((key) => [key, jsonValue(raw[key], path, depth + 1)]),
  );
  path.delete(value);
  return result;
}

/** Serialize exact record content into its version-one canonical persisted representation.
 * @param value - Inert typed or decoded record.
 * @returns Bounded canonical JSON text.
 * @throws {LedgerError} If content is invalid or exceeds 128 KiB.
 */
export function canonicalJson(value: unknown): string {
  const payload = JSON.stringify(jsonValue(value, new WeakSet(), 0));
  requireRow(Buffer.byteLength(payload, "utf8") <= 131072);
  return payload;
}

/** Parse bounded persisted JSON; canonical consistency is checked by the table codec.
 * @param value - Driver payload text.
 * @returns Unknown parsed data requiring record-specific validation.
 * @throws {LedgerError} If the text is too large.
 * @throws {SyntaxError} If JSON syntax is malformed.
 */
export function parsePayload(value: unknown): unknown {
  const payload = readString(value, 131072);
  requireRow(Buffer.byteLength(payload, "utf8") <= 131072);
  const parsed: unknown = JSON.parse(payload);
  return parsed;
}

/** Deep-freeze newly reconstructed data, never caller-owned input.
 * @param value - Independently owned validated record.
 * @returns The same immutable record.
 */
export function freezeRecord<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    const children: readonly unknown[] = Object.values(value);
    for (const child of children) freezeRecord(child);
    Object.freeze(value);
  }
  return value;
}
