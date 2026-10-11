/** @file Purchase wire contract, deliberately separate from provider-specific payment challenges. */
import { parseAtomicAmount } from "./amount.js";
import {
  ValidationError,
  validateEnum,
  validateIdentifier,
  validateObject,
  validateProfileIdentifier,
  validateTimestamp,
} from "./validation.js";

/** Purchase identity and financial fields shared by GET and POST wire requests. */
interface PaymentIntentFields {
  readonly schemaVersion: "1";
  readonly idempotencyKey: string;
  readonly delegationId: string;
  readonly network: string;
  readonly asset: string;
  readonly amountAtomic: string;
  readonly recipient: string;
  readonly capability: string;
  readonly expiresAt: string;
  readonly traceId?: string;
}

/** HTTPS purchase fields: GET omits a body digest; POST supplies a lowercase 64-hex SHA-256 digest. */
export type HttpPurchase = Readonly<
  {
    resourceUrl: string;
  } & (
    | {
        method: "GET";
        bodyDigest?: never;
      }
    | {
        method: "POST";
        bodyDigest: string;
      }
  )
>;

/** Unvalidated wire purchase proposal with decimal-string amounts, not an execution credential. */
export type PaymentIntentWire = Readonly<PaymentIntentFields & HttpPurchase>;

/** Validated purchase with bigint atomic units and expiry in milliseconds since the Unix epoch. */
export type PaymentIntent = Readonly<
  Omit<PaymentIntentFields, "amountAtomic" | "expiresAt"> &
    HttpPurchase & {
      amountAtomic: bigint;
      expiresAtMs: number;
    }
>;

/**
 * Validate a payment proposal and create an immutable normalized copy.
 *
 * Normalizes the HTTPS URL, parses the amount to bigint and expiry to epoch
 * milliseconds. Expiry is checked against evaluation time later, not here.
 *
 * @param value - Untrusted, inert wire object; extra fields and accessor properties are rejected.
 * @returns A frozen payment intent with GET/POST body requirements preserved.
 * @throws {ValidationError} If required fields, amount, identifiers, URL, expiry or body-digest rules are invalid.
 */
export function validatePaymentIntent(value: unknown): PaymentIntent {
  const raw = validateObject(
    value,
    [
      "schemaVersion",
      "idempotencyKey",
      "delegationId",
      "network",
      "asset",
      "amountAtomic",
      "recipient",
      "capability",
      "resourceUrl",
      "method",
      "bodyDigest",
      "expiresAt",
      "traceId",
    ],
    "intent",
  );
  const method = validateEnum(raw.method, ["GET", "POST"], "intent.method");
  const fields = {
    schemaVersion: validateEnum(raw.schemaVersion, ["1"], "intent.schemaVersion"),
    idempotencyKey: validateIdentifier(raw.idempotencyKey, "intent.idempotencyKey"),
    delegationId: validateIdentifier(raw.delegationId, "intent.delegationId"),
    network: validateProfileIdentifier(raw.network, "intent.network"),
    asset: validateProfileIdentifier(raw.asset, "intent.asset"),
    amountAtomic: parseAtomicAmount(raw.amountAtomic, "intent.amountAtomic"),
    recipient: validateProfileIdentifier(raw.recipient, "intent.recipient"),
    capability: validateIdentifier(raw.capability, "intent.capability"),
    expiresAtMs: validateTimestamp(raw.expiresAt, "intent.expiresAt"),
  };
  const purchase = validateHttpPurchase(raw, method);
  if (Object.hasOwn(raw, "traceId")) {
    return Object.freeze({
      ...fields,
      ...purchase,
      traceId: validateIdentifier(raw.traceId, "intent.traceId"),
    });
  }
  return Object.freeze({ ...fields, ...purchase });
}

/**
 * Validate the resource URL and the method's body-digest requirement.
 *
 * @param raw - Data-property copy produced by the object validator.
 * @param method - Previously validated GET or POST method.
 * @returns Normalized HTTP fields, omitting the body digest for GET.
 * @throws {ValidationError} If the URL is invalid, GET has a digest or POST lacks a canonical digest.
 */
function validateHttpPurchase(raw: Record<string, unknown>, method: "GET" | "POST"): HttpPurchase {
  const resourceUrl = validateResourceUrl(raw.resourceUrl);
  if (method === "GET") {
    if (Object.hasOwn(raw, "bodyDigest"))
      throw new ValidationError("INVALID_FORMAT", "intent.bodyDigest");
    return { resourceUrl, method };
  }
  const bodyDigest = raw.bodyDigest;
  if (typeof bodyDigest !== "string" || /^[a-f0-9]{64}/u.exec(bodyDigest)?.[0] !== bodyDigest) {
    throw new ValidationError("INVALID_FORMAT", "intent.bodyDigest");
  }
  return { resourceUrl, method, bodyDigest };
}

/**
 * Normalize an HTTPS resource URL without checking the destination's trustworthiness.
 *
 * @param value - Untrusted URL string of at most 2,048 characters.
 * @returns `URL.href` with query ordering preserved; no network request is made.
 * @throws {ValidationError} If the URL cannot be parsed, exceeds the bound, uses another scheme,
 * or contains credentials, a fragment, whitespace or ASCII control characters.
 */
function validateResourceUrl(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("INVALID_TYPE", "intent.resourceUrl");
  if (
    value.length > 2048 ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    ) ||
    value.includes("#")
  ) {
    throw new ValidationError("INVALID_FORMAT", "intent.resourceUrl");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("INVALID_FORMAT", "intent.resourceUrl");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.href.length > 2048) {
    throw new ValidationError("INVALID_FORMAT", "intent.resourceUrl");
  }
  return url.href;
}
