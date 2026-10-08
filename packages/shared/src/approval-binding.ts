/**
 * ADR-0104 — APPROVAL PAYLOAD BINDING, pure half.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * An approved Approvals-Queue entry used to say only "user X may call tool T on
 * server S". It said nothing about the ARGUMENTS the approver was looking at
 * when they signed. The queue row carried no arguments, the approved-approval
 * lookup keyed only on user/server/tool/status, and the tool-call audit row
 * recorded no payload either. So an approver signed off on a call they could
 * not see, and the caller could then spend that consent on an entirely
 * different payload — with no forensic record of which payload actually ran.
 *
 * The fix is a FINGERPRINT of the call the consent was granted for, stored on
 * the queue row and re-derived at match time. Two properties make it a
 * fingerprint rather than a hint:
 *
 *  1. It is computed over the CANONICAL form of the payload, so key order —
 *    which neither JSON nor `jsonb` preserves — is not an input. `{a:1,b:2}`
 *    and `{b:2,a:1}` are the same call and must produce the same digest.
 *  2. It is computed on the RAW arguments, BEFORE the ADR-0099 scrub that
 *    produces the approver-facing preview. Redaction changes what a human
 *    reads; it must never be able to change what the consent is FOR. A digest
 *    taken after scrubbing would make two different secrets look like the same
 *    call, and would make a change in the redactor a silent change in consent
 *    identity.
 *
 * ONE CANONICALIZER, DELIBERATELY REUSED
 * --------------------------------------
 * The serialization is ADR-0060's `canonicalJson` (`audit-chain.ts`), not a
 * second implementation. That function already pins recursive key sorting,
 * array order as data, the `undefined`-is-absent rule and the number rule,
 * against the same `jsonb` round trip this digest has to survive. A second
 * canonicalizer that could drift from it is the bug, not the fix — and the
 * writer (the queueing path) and the matcher (the evaluation path) call the one
 * function below rather than either re-deriving anything.
 *
 * WHAT IS IN THE FINGERPRINT
 * --------------------------
 * `projectId` and `arguments`. The project is part of the identity because
 * pillar 5 attributes spend and pillar 4 scopes context per project: consent
 * granted for a call inside project A must not be spendable inside project B,
 * where the same tool with the same arguments reaches different data, bills a
 * different ledger and may sit under a different compliance cascade.
 *
 * The user, server and tool are NOT in the fingerprint because they are already
 * the lookup key — putting them in twice would only make the digest opaque
 * about which dimension failed to match.
 */
import { canonicalJson, sha256Hex } from "./audit-chain.js";
import { AUDIT_SCRUB_MAX_DEPTH, scrubAuditDetail } from "./audit-scrub.js";
import { INTERNATIONAL_PII_CATEGORIES, type InternationalPiiCategory } from "./pii-international.js";
import { PII_REDACTION_VERSION } from "./pii.js";
import { PII_PAYLOAD_LIMITS, PII_PAYLOAD_VERSION, redactPiiPayload, type PiiJsonValue } from "./pii-payload.js";

/** The scope of an approval rule's consent (`approval_rules.approval_scope`). */
export const APPROVAL_SCOPES = ["action", "tool"] as const;
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number];

/**
 * Every kind of governed object that can sit in THE ONE QUEUE
 * (`approvals.object_type`) — the list `schema.ts` carries as a TS-only
 * widening, named once here so the queue's filter, the portal's select and the
 * saved views all draw on the same ten strings.
 *
 * The column has no DB CHECK (migration 0001), so this constant is the only
 * enumeration there is: a new kind that forgets to be added here is invisible
 * to the queue filter rather than rejected by it, which is why this lives beside
 * the other approval constants instead of being inlined at a call site.
 *
 * MCP tool calls, workflow sign-offs, run escalations, project budget overages,
 * infrastructure operations, MRM model-card sign-offs, copilot proposals,
 * RegulAIt-LLM training runs, certification-campaign items and SoD overrides —
 * ten kinds, one inbox, one decide path. That is the claim, and a per-kind
 * filter is how an approver works it without it becoming a second queue.
 */
export const APPROVAL_OBJECT_TYPES = [
  "mcp_tool",
  "workflow",
  "run",
  "project",
  "infra_operation",
  "model_card",
  "copilot_proposal",
  "training_job",
  "grant_certification",
  "sod_override",
  // ADR-0159: an executable remediation for a governance-monitor alert
  "remediation",
  // ADR-0173 batch 2b: moving a prompt's prod tag (bound to prompt, tag, commit hash)
  "prompt_promotion",
  // ADR-0173 batch 2b: a connector WRITE held by the execution dial
  "connector_call",
] as const;
export type ApprovalObjectType = (typeof APPROVAL_OBJECT_TYPES)[number];

/** what each queue kind IS, for a select an approver reads rather than decodes */
export const APPROVAL_OBJECT_TYPE_LABELS: Record<ApprovalObjectType, string> = {
  mcp_tool: "MCP tool call",
  workflow: "workflow stage sign-off",
  run: "agent run escalation",
  project: "project budget overage",
  infra_operation: "infrastructure operation",
  model_card: "model-card sign-off (MRM)",
  copilot_proposal: "governance-copilot proposal",
  training_job: "RegulAIt-LLM training run",
  grant_certification: "certification-campaign item",
  sod_override: "separation-of-duties override",
  remediation: "governance remediation",
  prompt_promotion: "prompt promotion to prod",
  connector_call: "connector write",
};

/**
 * ADR-0104: consent is ACTION-scoped unless an operator says otherwise. Pillar
 * 1 is default-deny and this codebase's rule idiom is strictest-wins, so the
 * default is the narrow reading of what an approver signed. This constant is
 * the single place that default is written down in TypeScript; the DDL default
 * on the column mirrors it.
 */
export const DEFAULT_APPROVAL_SCOPE: ApprovalScope = "action";

/**
 * Version tag prefixed onto the canonical payload before hashing, exactly as
 * ADR-0060 does for the audit chain. If the field set or the canonicalization
 * ever changes, this string changes with it — so digests computed under the old
 * rules can never silently be compared against digests computed under the new
 * ones. A version bump makes every pre-existing approved row stop matching,
 * which is a re-queue (fail-closed), not an accidental match.
 */
export const APPROVAL_DIGEST_VERSION = "regulait.approval-binding.v1";

/** The identity of a governed tool call's payload, for consent purposes. */
export interface ApprovalPayloadRef {
  /** pillar-5 attribution; `undefined` and `null` are the same "unattributed" */
  projectId?: string | null;
  /**
   * the call arguments as the caller supplied them, PRE-SCRUB. `undefined`,
   * `null` and `{}` all normalize to the empty bag: the MCP surface treats a
   * missing arguments object and an empty one as the same call, so consent
   * must not be able to distinguish them either.
   */
  arguments?: Record<string, unknown> | null | undefined;
}

/** Normalize the arguments bag. Absent, null and `{}` are ONE value — see the
 * field doc above. Exported so the pinning test asserts the rule directly. */
export function normalizeApprovalArguments(
  args: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return args ?? {};
}

/**
 * The consent fingerprint: sha256 hex over the versioned canonical JSON of
 * `{ projectId, arguments }`.
 *
 * Deterministic and pure — no clock, no database, no I/O — so the writer and
 * the matcher cannot disagree, and a test can assert the exact string.
 */
export function approvalArgumentsDigest(ref: ApprovalPayloadRef): string {
  return sha256Hex(
    `${APPROVAL_DIGEST_VERSION}\n${canonicalJson({
      projectId: ref.projectId ?? null,
      arguments: normalizeApprovalArguments(ref.arguments),
    })}`,
  );
}

/**
 * The approver-facing preview stored on the queue row.
 *
 * This is the ADR-0099/0102 scrubber, called — NOT a second redactor. There is
 * exactly one credential-redaction implementation in this repo and this is a
 * new consumer of it, so a rule added there covers this surface for free.
 *
 * The preview is what a human reads; the digest above is what the machine
 * matches. They are deliberately derived from the same raw value in that order,
 * so a secret can be hidden from the approver without the consent it represents
 * moving an inch.
 */
export function approvalArgumentsPreview(
  args: Record<string, unknown> | null | undefined,
): unknown {
  return scrubAuditDetail(normalizeApprovalArguments(args));
}

/** Separate namespace: legacy raw-only approvals cannot authorize a transform. */
export const PII_APPROVAL_DIGEST_VERSION = "regulait.pii-approval-binding.v1";

/**
 * Prepare one immutable redacted action for approval and eventual execution.
 * The original digest remains bound even when different originals redact to
 * identical effective arguments. The provider must receive effectiveArguments,
 * never the credential-scrubbed preview. Callers must force action scope and
 * recheck live policy/epoch before consuming consent and sending this snapshot.
 * This helper does not perform authorization or enable the redaction mode.
 */
export function preparePiiApproval(
  ref: ApprovalPayloadRef,
  international: readonly InternationalPiiCategory[],
) {
  const raw = normalizeApprovalArguments(ref.arguments);
  // Do not create a persisted preview deeper than the credential scrubber
  // actually visits. At this bound any deepest object can only be empty.
  const transformed = redactPiiPayload(raw, international, { ...PII_PAYLOAD_LIMITS, maxDepth: AUDIT_SCRUB_MAX_DEPTH });
  // The input API requires an arguments bag, not a scalar or array. Check at
  // runtime too, before a loosely typed caller can bind the wrong wire shape.
  if (transformed.value === null || typeof transformed.value !== "object" || Array.isArray(transformed.value)) {
    throw new Error("PII approval arguments must be a JSON object");
  }
  const effectiveArguments = transformed.value as { readonly [key: string]: PiiJsonValue };
  const projectId = ref.projectId ?? null;
  const originalArgumentsDigest = approvalArgumentsDigest({ projectId, arguments: raw });
  const effectiveArgumentsDigest = approvalArgumentsDigest({ projectId, arguments: effectiveArguments });
  const enabled = new Set(international);
  const transformation = Object.freeze({
    mode: "redact" as const,
    textVersion: PII_REDACTION_VERSION,
    payloadVersion: PII_PAYLOAD_VERSION,
    internationalCategories: Object.freeze(INTERNATIONAL_PII_CATEGORIES.filter((category) => enabled.has(category))),
  });
  const argumentsDigest = sha256Hex(`${PII_APPROVAL_DIGEST_VERSION}\n${canonicalJson({
    projectId, originalArgumentsDigest, effectiveArgumentsDigest, transformation,
  })}`);
  // Never put the original payload in the preview. The remaining credentials
  // in the effective payload still use the existing audit scrubber.
  const freezePreview = (value: unknown): unknown => {
    if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) freezePreview(child);
      Object.freeze(value);
    }
    return value;
  };
  const argumentsPreview = freezePreview({
    transformation,
    originalArgumentsDigest,
    effectiveArgumentsDigest,
    effectiveArguments: approvalArgumentsPreview(effectiveArguments),
  });
  return Object.freeze({
    projectId,
    approvalScope: "action" as const,
    argumentsDigest,
    originalArgumentsDigest,
    effectiveArgumentsDigest,
    transformation,
    effectiveArguments,
    argumentsPreview,
    hits: Object.freeze(transformed.hits.map((hit) => Object.freeze(hit))),
  });
}

export type PreparedPiiApproval = ReturnType<typeof preparePiiApproval>;

/**
 * STRICTEST-WINS across every approval rule that matched this call: if ANY of
 * them is action-scoped, the call's consent is action-scoped. A rule body that
 * carries no scope at all (an older `config_versions` version body, say) reads
 * as the default, which is `action` — an absent scope must never be the loose
 * one.
 */
export function effectiveApprovalScope(
  rules: ReadonlyArray<{ approvalScope?: ApprovalScope | null }>,
): ApprovalScope {
  if (rules.length === 0) return DEFAULT_APPROVAL_SCOPE;
  return rules.some((r) => (r.approvalScope ?? DEFAULT_APPROVAL_SCOPE) === "action")
    ? "action"
    : "tool";
}

// ---------------------------------------------------------------------------
// ADR-0105 — CONSENT CONTEXT BINDING.
//
// ADR-0104 bound a consent to its PAYLOAD. It did not bind it to the POLICY
// that demanded the consent in the first place, and that is a second, distinct
// hole: an approval queued and signed under rule/config A stayed spendable
// after a stricter version B activated, or after the required approver
// changed, as long as user/server/tool/project/arguments were unchanged. That
// is an authorization time-of-check/time-of-use gap — the check ran against
// yesterday's policy and the use happens under today's.
//
// The fix is a SECOND digest, kept deliberately separate from the payload one:
//
//   * two digests fail INDEPENDENTLY, so the reason a consent stopped
//     satisfying a call is recoverable ("the payload changed" vs "the policy
//     changed"). One combined hash would collapse both into a single opaque
//     mismatch, and the audit trail would be poorer for it.
//   * the payload digest is a fact about the CALL and never changes for a
//     given call; the context digest is a fact about the GOVERNING POLICY and
//     changes underneath a stationary call. Hashing them together would make
//     the payload digest look mutable.
//
// WHAT IS IN IT
// -------------
//   * the MATCHED approval rules, each paired with the id of the
//     `config_versions` row that is ACTIVE for it (ADR-0073). Matched, not
//     loaded: a rule that does not bind this call is not governing it, so
//     editing it must not invalidate a consent (that is the compatibility rule
//     ADR-0105 states, made mechanical). `null` for a rule with no version rows
//     at all — the byte-identical pre-ADR-0073 case, which must hash to a
//     stable value rather than to "unknown".
//   * the REQUIRED APPROVER for the call as policy currently reads it. If the
//     rule now names a different human, the old signature is a signature from
//     someone who is no longer the person entitled to give it.
//   * the APPROVAL SCOPE ('action' | 'tool'). Flipping a rule from action to
//     tool scope changes what a signature MEANS; a consent granted under one
//     meaning is not consent under the other.
//   * ADR-0186 A: the ORG-WIDE dual control a tool-call consent is judged under
//     (approval signature mode, sensitive-call quorum), when the caller names it.
//   * ADR-0186 A: an UNVERSIONED rule's dual control (quorum, approver role).
//     A versioned rule's is in its version id; an unversioned rule's is edited
//     by a plain row write, so it is named here or raising it would move
//     nothing.
//
// WHAT IS DELIBERATELY NOT IN IT: everything else. The compatibility rule is
// exactly "what is in the digest invalidates, what is not does not", and it is
// only honest if the field list is short and stated.
// ---------------------------------------------------------------------------

/**
 * Version tag for the CONTEXT digest, independent of
 * `APPROVAL_DIGEST_VERSION` above so the two can move separately. Same
 * contract: bumping it makes every pre-existing context digest stop matching,
 * which is a re-queue (fail-closed), never an accidental match.
 */
export const APPROVAL_CONTEXT_DIGEST_VERSION = "regulait.approval-context.v3";

/** One governing approval rule and the `config_versions` row currently ACTIVE
 * for it. `activeVersionId` is null when the rule has no version rows — the
 * pre-ADR-0073 case, and a stable value, not an absence. */
export interface ApprovalRuleVersionRef {
  ruleId: string;
  activeVersionId: string | null;
  /**
   * ADR-0186 A: an UNVERSIONED rule's dual control (`activeVersionId` null). A
   * plain row write of `quorum` / `approverRoleId` mints no version, so without
   * these the context would not move when dual control is raised and a consent
   * given under the weaker snapshot would still satisfy the call. A versioned
   * rule's are already identified by its version. Absent = not part of the
   * digest (the pre-ADR-0186 shape, byte-identical).
   */
  dualControl?: { quorum: number; approverRoleId: string | null } | null;
}

/**
 * AER-039 — WHERE the approved bytes go. The execution-relevant identity of the
 * MCP upstream a consent is spent against: its destination, its private-range
 * egress posture, and the digest of the tool manifest its admission verdict
 * was computed over. An admin editing any of these under the same server id is
 * a NEW action target, so a consent signed for the old one stops matching (it
 * goes stale and is re-queued, fail-closed). Operational churn on the server
 * row — breaker counters, health cursors — is deliberately NOT here.
 */
export type ApprovalTargetRef =
  | {
      kind: "mcp_server";
      serverId: string;
      url: string;
      allowPrivateRanges: boolean | null;
      admissionManifestDigest: string | null;
    }
  /**
   * ADR-0173 batch 2b — a connector write's target: the connector, its
   * provider kind and the EFFECTIVE base URL (the credential's override, else
   * the connector's, else null for the compiled vendor endpoint). Repointing
   * any of them under the same connector id is a new target, so a consent
   * signed for the old one goes stale. The credential token is not here: a
   * rotation does not change where the bytes go.
   */
  | {
      kind: "connector";
      connectorId: string;
      providerKind: string | null;
      baseUrl: string | null;
    };

/** The identity of the POLICY CONTEXT a consent was granted under. */
export interface ApprovalContextRef {
  /** the rules that MATCHED this call, with their resolved active versions */
  ruleVersions: ReadonlyArray<ApprovalRuleVersionRef>;
  /** every active ABAC policy that could govern this call */
  abacPolicies?: ReadonlyArray<{ policyId: string; version: number | null; source: string }>;
  /** who policy currently requires to sign — `decision.approverUserId` */
  requiredApproverUserId?: string | null;
  /** the strictest scope across the matched rules */
  approvalScope: ApprovalScope;
  /** AER-039 — the upstream the call executes against (v3) */
  target?: ApprovalTargetRef | null;
  /**
   * ADR-0186 A — the ORG-WIDE dual-control settings a tool-call consent is
   * judged under: how each approval must be proven (`approval_signature_mode`)
   * and the quorum a sensitive call needs (`tool_approval_sensitive_quorum`).
   * Both are snapshotted on the approval at queue time, so without them here
   * tightening either (off/step_up -> passkey, a higher sensitive quorum) would
   * leave a consent given under the weaker setting spendable. Absent = not part
   * of the digest (the pre-ADR-0186 shape, byte-identical).
   */
  orgDualControl?: { signatureMode: string; sensitiveQuorum: number } | null;
}

/**
 * Rule/version pairs in a DETERMINISTIC order.
 *
 * Rules reach the evaluator in whatever order Postgres returned them — there
 * is no `ORDER BY` on the rule loads and none is owed, because the kernel's
 * decision does not depend on it. A digest that DID depend on it would be a
 * consent that spontaneously stops matching when the planner changes its mind,
 * which reads exactly like a policy change and is not one. Sorted by ruleId,
 * then by version id so a (theoretically impossible) duplicate rule id still
 * orders stably. Exported so the pinning test asserts the rule directly.
 */
export function sortApprovalRuleVersions(
  pairs: ReadonlyArray<ApprovalRuleVersionRef>,
): ApprovalRuleVersionRef[] {
  return [...pairs].sort(
    (a, b) =>
      a.ruleId.localeCompare(b.ruleId) ||
      (a.activeVersionId ?? "").localeCompare(b.activeVersionId ?? ""),
  );
}

/**
 * The consent-context fingerprint: sha256 hex over the versioned canonical
 * JSON of the governing policy identity.
 *
 * Deterministic and pure — no clock, no database, no I/O — exactly like
 * `approvalArgumentsDigest`, and using the SAME `canonicalJson` + `sha256Hex`
 * for the same reason: one canonicalizer that already survives the `jsonb`
 * round trip, never a second one that could drift from it.
 */
export function approvalContextDigest(ref: ApprovalContextRef): string {
  return sha256Hex(
    `${APPROVAL_CONTEXT_DIGEST_VERSION}\n${canonicalJson({
      ruleVersions: sortApprovalRuleVersions(ref.ruleVersions).map((p) => ({
        ruleId: p.ruleId,
        activeVersionId: p.activeVersionId ?? null,
        ...(p.dualControl && (p.activeVersionId ?? null) === null
          ? { dualControl: { quorum: p.dualControl.quorum, approverRoleId: p.dualControl.approverRoleId ?? null } }
          : {}),
      })),
      abacPolicies: [...(ref.abacPolicies ?? [])]
        .sort((a, b) => a.policyId.localeCompare(b.policyId))
        .map((p) => ({ policyId: p.policyId, version: p.version, source: p.source })),
      requiredApproverUserId: ref.requiredApproverUserId ?? null,
      approvalScope: ref.approvalScope,
      ...(ref.orgDualControl
        ? { orgDualControl: { signatureMode: ref.orgDualControl.signatureMode, sensitiveQuorum: ref.orgDualControl.sensitiveQuorum } }
        : {}),
      target: !ref.target
        ? null
        : ref.target.kind === "connector"
          ? {
              kind: ref.target.kind,
              connectorId: ref.target.connectorId,
              providerKind: ref.target.providerKind ?? null,
              baseUrl: ref.target.baseUrl ?? null,
            }
          : {
              kind: ref.target.kind,
              serverId: ref.target.serverId,
              url: ref.target.url,
              allowPrivateRanges: ref.target.allowPrivateRanges ?? null,
              admissionManifestDigest: ref.target.admissionManifestDigest ?? null,
            },
    })}`,
  );
}

/**
 * ADR-0105 — the DEFAULT approval time-to-live, in hours, applied when
 * `org_settings.approval_ttl_hours` has never been set.
 *
 * 72 hours is a deliberate, documented upgrade-day behaviour change. An
 * approval is a human decision about ONE pending action; indefinite validity
 * is the defect, not a feature, and shipping the dial as NULL ("never
 * expires") would have left the gap open for exactly the population that
 * already has it — the same argument ADR-0104 made for `approval_scope`
 * defaulting to 'action'. An operator who genuinely wants the old posture sets
 * the dial to NULL, on the record, and reopens the gap knowingly.
 */
export const DEFAULT_APPROVAL_TTL_HOURS = 72;

/** Why a stored consent stopped satisfying the call it was granted for. Kept
 * as a closed vocabulary so the audit trail, the outcome variants and the
 * approver-facing reason all name the same conditions. */
export const CONSENT_RETIREMENT_REASONS = ["expired", "context_changed"] as const;
export type ConsentRetirementReason = (typeof CONSENT_RETIREMENT_REASONS)[number];
