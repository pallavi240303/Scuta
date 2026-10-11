/** @file Pure static evaluations, deliberately incapable of reserving funds or authorizing a signer. */
import {
  validateDelegation,
  validateDelegationScope,
  type DelegationReasonCode,
  type Delegation,
  type DelegationWire,
} from "./delegation.js";
import {
  validatePaymentIntent,
  type PaymentIntent,
  type PaymentIntentWire,
} from "./payment-intent.js";
import { validatePolicy, type Policy, type PolicyWire, type RecipientAction } from "./policy.js";
import { computeIntentDigest } from "./canonicalization.js";
import {
  matchesScope,
  validateEvaluationTime,
  validateObject,
  validateScope,
  type TrustedScope,
} from "./validation.js";

/** Stable explanations with hard denials taking precedence over approval conditions. */
export type ReasonCode =
  | DelegationReasonCode
  | "INTENT_EXPIRED"
  | "UNSUPPORTED_CAPABILITY"
  | "UNSUPPORTED_NETWORK"
  | "UNSUPPORTED_ASSET"
  | "RECIPIENT_FORBIDDEN"
  | "HARD_TRANSACTION_LIMIT_EXCEEDED"
  | "APPROVAL_UNAVAILABLE"
  | "RECIPIENT_REQUIRES_APPROVAL"
  | "AUTONOMOUS_LIMIT_EXCEEDED"
  | "WITHIN_STATIC_POLICY";

/** Wire inputs and host-resolved {@link TrustedScope} context, revalidated for one static evaluation. */
export interface PolicyEvaluationInput {
  readonly intent: PaymentIntentWire;
  readonly policy: PolicyWire;
  readonly delegation: DelegationWire;
  readonly scope: TrustedScope;
  readonly nowMs: number;
}

/** Static decision explanation and provenance; no execution, approval or reservation credential. */
export type PolicyEvaluation = Readonly<
  {
    reasonCodes: readonly ReasonCode[];
    policyVersion: string;
    policyDigest: string;
    intentDigest: string;
    evaluatedAtMs: number;
  } & ({ kind: "ALLOW" } | { kind: "DENY" } | { kind: "REQUIRE_APPROVAL" })
>;

/**
 * Evaluate one purchase against delegation and static owner policy.
 *
 * Hard denials take precedence over review conditions. Equality is inside a
 * spending ceiling; expiry at evaluation time is expired. This function neither
 * reserves funds nor contacts a human, signs a payment or evaluates behavior.
 *
 * @param input - Wire proposal, owner policy, delegation, trusted host scope and explicit evaluation time.
 * @returns A frozen ALLOW, DENY or REQUIRE_APPROVAL explanation with ordered reasons and policy/intent digests.
 * An ALLOW is only a static evaluation, not authority to execute or proof of available budget.
 * @throws {ValidationError} If any input shape, field, policy relationship or evaluation time is invalid.
 * Valid but disallowed requests return DENY rather than throwing.
 */
export function evaluatePolicy(input: PolicyEvaluationInput): PolicyEvaluation {
  const context = validateEvaluationInput(input);
  const { intent, policy } = context;
  const recipientAction =
    policy.recipientRules.find((rule) => rule.recipient === intent.recipient)?.action ??
    policy.defaultRecipientAction;
  const denied = collectDenialReasons(context, recipientAction);
  if (denied.length > 0) return createEvaluation(context, "DENY", denied);

  const approval: ReasonCode[] = [];
  if (recipientAction === "REQUIRE_APPROVAL") approval.push("RECIPIENT_REQUIRES_APPROVAL");
  if (intent.amountAtomic > policy.autonomousTransactionLimitAtomic)
    approval.push("AUTONOMOUS_LIMIT_EXCEEDED");
  if (approval.length === 0) return createEvaluation(context, "ALLOW", ["WITHIN_STATIC_POLICY"]);
  if (!policy.approvalEnabled)
    return createEvaluation(context, "DENY", ["APPROVAL_UNAVAILABLE", ...approval]);
  return createEvaluation(context, "REQUIRE_APPROVAL", approval);
}

/** Parsed immutable snapshots used only after the runtime boundary has been checked. */
interface ValidatedEvaluationInput {
  readonly intent: PaymentIntent;
  readonly policy: Policy;
  readonly delegation: Delegation;
  readonly scope: TrustedScope;
  readonly nowMs: number;
}

/** Preserve the public explanation order independently of rule evaluation order. */
const DENIAL_REASON_ORDER: readonly ReasonCode[] = [
  "SCOPE_MISMATCH",
  "DELEGATION_REVOKED",
  "DELEGATION_EXPIRED",
  "INTENT_EXPIRED",
  "CAPABILITY_NOT_DELEGATED",
  "UNSUPPORTED_CAPABILITY",
  "UNSUPPORTED_NETWORK",
  "UNSUPPORTED_ASSET",
  "RECIPIENT_FORBIDDEN",
  "HARD_TRANSACTION_LIMIT_EXCEEDED",
];

/**
 * Parse the evaluation envelope before any policy rule reads its values.
 *
 * @param input - Untrusted envelope, including callers that bypass the public types.
 * @returns Validated, independently copied snapshots and a checked evaluation time.
 * @throws {ValidationError} If the envelope or any nested contract is malformed.
 */
function validateEvaluationInput(input: unknown): ValidatedEvaluationInput {
  const raw = validateObject(
    input,
    ["intent", "policy", "delegation", "scope", "nowMs"],
    "evaluation",
  );
  const nowMs = validateEvaluationTime(raw.nowMs);
  const scope = validateScope(raw.scope);
  const intent = validatePaymentIntent(raw.intent);
  const policy = validatePolicy(raw.policy);
  const delegation = validateDelegation(raw.delegation);
  return { intent, policy, delegation, scope, nowMs };
}

/**
 * Collect hard denial reasons without including approval-only conditions.
 *
 * @param context - Previously validated evaluation snapshots and time.
 * @param recipientAction - Explicit recipient rule or the owner's configured default.
 * @returns Deduplicated denial reasons in the fixed public explanation order.
 */
function collectDenialReasons(
  context: ValidatedEvaluationInput,
  recipientAction: RecipientAction,
): readonly ReasonCode[] {
  const { intent, policy, delegation, scope, nowMs } = context;
  const denied = new Set<ReasonCode>(validateDelegationScope(delegation, scope, intent, nowMs));
  if (!matchesScope(policy.scope, scope)) denied.add("SCOPE_MISMATCH");
  if (intent.expiresAtMs <= nowMs) denied.add("INTENT_EXPIRED");
  if (intent.capability !== "PAY_HTTP_RESOURCE") denied.add("UNSUPPORTED_CAPABILITY");
  if (intent.network !== policy.network) denied.add("UNSUPPORTED_NETWORK");
  if (intent.asset !== policy.asset) denied.add("UNSUPPORTED_ASSET");
  if (recipientAction === "DENY") denied.add("RECIPIENT_FORBIDDEN");
  if (intent.amountAtomic > policy.hardTransactionLimitAtomic)
    denied.add("HARD_TRANSACTION_LIMIT_EXCEEDED");
  return DENIAL_REASON_ORDER.filter((reason) => denied.has(reason));
}

/**
 * Construct an immutable explanation from validated snapshots and selected reasons.
 *
 * @param context - Validated purchase, owner policy, scope and time used for provenance.
 * @param kind - Static evaluation outcome chosen by the evaluator.
 * @param reasonCodes - Ordered reasons owned by the evaluator; this function freezes the array.
 * @returns A frozen evaluation with frozen reasons and computed purchase binding, not an execution credential.
 */
function createEvaluation(
  context: ValidatedEvaluationInput,
  kind: PolicyEvaluation["kind"],
  reasonCodes: readonly ReasonCode[],
): PolicyEvaluation {
  const { intent, policy, scope, nowMs } = context;
  return Object.freeze({
    kind,
    reasonCodes: Object.freeze(reasonCodes),
    policyVersion: policy.version,
    policyDigest: policy.digest,
    intentDigest: computeIntentDigest(intent, scope),
    evaluatedAtMs: nowMs,
  });
}
