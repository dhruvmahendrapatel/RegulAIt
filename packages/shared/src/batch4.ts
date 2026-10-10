/**
 * ADR-0186 (batch 4) — the shared contract: dual control, step-up and
 * passkey-signed approvals, signed decision receipts, RFC 3161 anchor
 * timestamps, vendored detection content and the four monitor rules.
 *
 * Six slices build on this file in their own modules (Claude: A dual control
 * and step-up, B passkey-signed approvals, T trace residual; Codex: R receipts,
 * S timestamps, V vendored content, M monitor rules). It holds only what they
 * share: the vocabularies (kept in lockstep with the DB CHECKs of migration
 * 0170, because `schema.ts` imports these very constants), the org settings
 * with their strict defaults and what relaxing each one gives up, the refusal
 * codes, and the receipt payload's type. It decides nothing at request time.
 *
 * SECURE BY DEFAULT (ADR-0180 §1). Every setting below starts at its strict
 * value, migration 0170 wrote it onto the existing org row as for a first load,
 * and an admin relaxes one only through the audited `PUT /v1/org/settings`
 * (`detail.transitions`, and `detail.relaxed` naming every key left looser than
 * its strict default). Slice A adds the `settings_relax` step-up in front of
 * that write (the hook is `settingsRelaxStepUpRefusal` in the gateway's
 * `step-up.ts`).
 *
 * Does not import the package barrel (index.ts re-exports this file).
 */
import { z } from "zod";
import { canonicalJson } from "./audit-chain.js";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/** B: how a tool-call approval must be signed (`org_settings.approval_signature_mode`,
 * snapshotted onto `approvals.signature_mode`). Strictest first. */
export const APPROVAL_SIGNATURE_MODES = ["passkey", "step_up", "off"] as const;
export type ApprovalSignatureMode = (typeof APPROVAL_SIGNATURE_MODES)[number];

/** A: whether the step-up actions demand a fresh second proof (`org_settings.step_up_mode`) */
export const STEP_UP_MODES = ["required", "off"] as const;
export type StepUpMode = (typeof STEP_UP_MODES)[number];

/** A: how a step-up was proven (`step_up_grants.method`). Passkey and TOTP for
 * everyone; `sso` is a fresh login at the identity provider (OIDC `max_age=0`
 * + `prompt=login`, SAML `ForceAuthn`). */
export const STEP_UP_METHODS = ["passkey", "totp", "sso"] as const;
export type StepUpMethod = (typeof STEP_UP_METHODS)[number];

/** A: the actions a step-up grant can be bound to (`step_up_grants.action_kind`,
 * `org_settings.step_up_actions`). Removing one from the setting is a relaxation. */
export const STEP_UP_ACTION_KINDS = [
  "approval_decide",
  "settings_relax",
  "evidence_hold_override",
  "break_glass",
  "passkey_manage",
  "owner_change",
  // ADR-0188 (migration 0180): creating, binding a key to, suspending or revoking a workload identity,
  // and every other identity administration write
  "identity_manage",
] as const;
export type StepUpActionKind = (typeof STEP_UP_ACTION_KINDS)[number];

/** A: the request header that carries a step-up grant (`rgsu_…`) */
export const STEP_UP_HEADER = "x-regulait-step-up";
/** A: the plaintext prefix of a step-up grant token (only its sha256 is stored) */
export const STEP_UP_TOKEN_PREFIX = "rgsu_";

/** A/B: what a `webauthn_challenges` row is for */
export const WEBAUTHN_CHALLENGE_PURPOSES = ["register", "step_up", "approval_sign"] as const;
export type WebauthnChallengePurpose = (typeof WEBAUTHN_CHALLENGE_PURPOSES)[number];

/** A/B: the WebAuthn transports a credential may record (the Level 3
 * `AuthenticatorTransport` values; `cable` is the older name of `hybrid`) */
export const WEBAUTHN_TRANSPORTS = ["usb", "nfc", "ble", "smart-card", "hybrid", "internal", "cable"] as const;
export type WebauthnTransport = (typeof WEBAUTHN_TRANSPORTS)[number];

/** A: the identity-provider kinds a fresh SSO login can come from */
export const SSO_REAUTH_PROVIDER_KINDS = ["oidc", "saml"] as const;
export type SsoReauthProviderKind = (typeof SSO_REAUTH_PROVIDER_KINDS)[number];

/** A: the decisions an approving principal records (`approval_decisions.decision`) */
export const APPROVAL_DECISION_VALUES = ["approved", "denied"] as const;
export type ApprovalDecisionValue = (typeof APPROVAL_DECISION_VALUES)[number];

/** A: how an approval decision's identity was proven (`approval_decisions.step_up_method`);
 * `none` = the signature mode was `off` (an audited relaxation) */
export const APPROVAL_DECISION_METHODS = ["passkey", "totp", "sso", "none"] as const;
export type ApprovalDecisionMethod = (typeof APPROVAL_DECISION_METHODS)[number];

/** the approval kinds whose decision is a TOOL-CALL approval: the ones
 * `approval_signature_mode` and the sensitive-data quorum apply to.
 * `approvals.signature_mode` / `quorum` are stored on every row but only
 * these kinds consult them. */
export const TOOL_CALL_APPROVAL_OBJECT_TYPES = ["mcp_tool", "connector_call"] as const;

/** an approval rule's quorum bounds (`approval_rules.quorum`, `approvals.quorum`,
 * `org_settings.tool_approval_sensitive_quorum`) */
export const APPROVAL_QUORUM_LIMITS = { min: 1, max: 5 } as const;

/** R: which audit rows get a signed decision receipt — governed-call decisions
 * (MCP tool and protocol calls, agent dispatches, connector calls) and approval
 * decisions (slices A/B audit each approving principal's decision with
 * objectType `approval`). Admin configuration rows stay on the hash chain only. */
export const RECEIPT_OBJECT_TYPES = ["mcp_tool", "agent", "connector", "approval"] as const;
export type ReceiptObjectType = (typeof RECEIPT_OBJECT_TYPES)[number];

/** R: the receipt sweep's state (`GET /v1/receipts/status`) */
export const RECEIPT_SIGNING_STATES = ["signing", "no_key", "off", "stalled"] as const;
export type ReceiptSigningState = (typeof RECEIPT_SIGNING_STATES)[number];

/** R: one receipt's verification outcome (`POST /v1/receipts/verify`) */
export const RECEIPT_VERIFY_STATUSES = ["valid", "invalid", "unverifiable"] as const;
export type ReceiptVerifyStatus = (typeof RECEIPT_VERIFY_STATUSES)[number];

/** R: the receipt payload's version tag (and the export bundle's `verifier`) */
export const RECEIPT_PAYLOAD_VERSION = "regulait.receipt.v1";
/**
 * ADR-0189 R34 / R42 / R48 (shared with ADR-0188 decision 9, open question 1):
 * receipt payload v2 adds the actor chain and `factsHash`. B1 VERIFIES v2 but
 * still EMITS v1: nothing emits v2 because a binary was deployed. From the
 * recorded boundary (`receipt_payload_versions.from_audit_seq`) on, every
 * receipt is v2 and a v1 receipt there is invalid; below it, always v1.
 */
export const RECEIPT_PAYLOAD_VERSION_V2 = "regulait.receipt.v2";
export const RECEIPT_PAYLOAD_VERSIONS = [RECEIPT_PAYLOAD_VERSION, RECEIPT_PAYLOAD_VERSION_V2] as const;
/** R43: can this build emit v2 receipts with facts? A build that cannot refuses to start once a boundary exists. */
export const RECEIPT_EMITTER_SUPPORTS_V2 = false;
/** R: `prev` of the first receipt */
export const RECEIPT_GENESIS_PREV = "0".repeat(64);

/** S: an audit anchor's RFC 3161 timestamp state (`audit_anchors.tsa_status`) */
export const ANCHOR_TSA_STATUSES = ["not_configured", "pending", "granted", "failed"] as const;
export type AnchorTsaStatus = (typeof ANCHOR_TSA_STATUSES)[number];

/** R: whether decisions get signed receipts (`org_settings.decision_receipts_mode`) */
export const DECISION_RECEIPTS_MODES = ["on", "off"] as const;
export type DecisionReceiptsMode = (typeof DECISION_RECEIPTS_MODES)[number];

/** S: whether anchors are sent for a trusted timestamp (`org_settings.audit_anchor_timestamp_mode`).
 * `required` with no `REGULAIT_TSA_URL` reads honestly as "not timestamped". */
export const AUDIT_ANCHOR_TIMESTAMP_MODES = ["required", "off"] as const;
export type AuditAnchorTimestampMode = (typeof AUDIT_ANCHOR_TIMESTAMP_MODES)[number];

/** V: the four vendored detection packs (`org_settings.vendored_detection_packs`) */
export const VENDORED_DETECTION_PACKS = [
  "pipelock-secrets",
  "pipelock-normalise",
  "nemo-yara-injection",
  "agt-mcp-heuristics",
] as const;
export type VendoredDetectionPack = (typeof VENDORED_DETECTION_PACKS)[number];

/** V (decision 32): whether caller-supplied content carrying a `pipelock-secrets` credential may leave for a host
 * outside that credential's audience (`org_settings.outbound_credential_audience`). `enforce` refuses it. */
export const OUTBOUND_CREDENTIAL_AUDIENCE_MODES = ["enforce", "off"] as const;
export type OutboundCredentialAudienceMode = (typeof OUTBOUND_CREDENTIAL_AUDIENCE_MODES)[number];

/** M: the four monitor rules (rule ids in `MONITOR_RULES`) */
export const DETECTION_MONITOR_RULE_IDS = [
  "mcp_server_baseline_drift",
  "sharing_scope_widened",
  "instructions_changed_after_approval",
  "jailbreak_correlation",
] as const;
export type DetectionMonitorRuleId = (typeof DETECTION_MONITOR_RULE_IDS)[number];

/** what every batch-4 route answers until its slice lands */
export const BATCH4_NOT_BUILT = { error: "not_built" } as const;

// ---------------------------------------------------------------------------
// Refusal codes (ADR-0186 A and B; AgentCoordination §4.9)
// ---------------------------------------------------------------------------

/** A: dual control and step-up, with the HTTP status each is sent with */
export const STEP_UP_REFUSALS = {
  step_up_required: 403,
  step_up_unavailable: 422,
  duplicate_approver: 403,
  quorum_unsatisfiable: 422,
  approval_requires_individual_signature: 409,
  chatops_step_up_required: 403,
  sso_reauth_stale: 409,
  sso_reauth_identity_mismatch: 403,
} as const;
export type StepUpRefusalCode = keyof typeof STEP_UP_REFUSALS;

/** B: passkey-signed approvals, with the HTTP status each is sent with */
export const PASSKEY_REFUSALS = {
  passkey_signature_required: 403,
  passkey_signature_invalid: 422,
  passkey_challenge_expired: 409,
  passkey_challenge_used: 409,
  approval_action_changed: 409,
  passkey_rp_unconfigured: 409,
} as const;
export type PasskeyRefusalCode = keyof typeof PASSKEY_REFUSALS;

/** A2+B: the dual-control and signed-approval refusals slice A2+B added, with
 * the HTTP status each is sent with. `caller_cannot_approve`: the caller (or
 * someone delegation-linked to them) decides their own tool call;
 * `approval_not_signable`: signing options for an approval that is not a
 * passkey-mode tool-call approval; `unknown_role`: a rule names an approver role
 * that does not exist; `approval_quorum_unsatisfiable`: a connector write denied
 * at queue time because no pool can approve it; `approval_signature_recheck_failed`:
 * a connector write whose approval failed the execution-time signature recheck. */
export const APPROVAL_REFUSALS = {
  caller_cannot_approve: 403,
  approval_not_signable: 409,
  unknown_role: 422,
  approval_quorum_unsatisfiable: 403,
  approval_signature_recheck_failed: 403,
  // B4S-02: the decider is not an active account that already existed when the call was queued
  approver_not_eligible: 403,
} as const;
export type ApprovalRefusalCode = keyof typeof APPROVAL_REFUSALS;

/** A (slice A1): the passkey-enrolment and step-up ceremony refusals, with the
 * HTTP status each is sent with. `passkey_attestation_refused`: a registration
 * whose attestation format is not `none`; `passkey_already_registered`: that
 * credential id is enrolled already; `fresh_sign_in_required`: a first passkey
 * from a session that is not a fresh human sign-in; `browser_session_required`:
 * a passkey or step-up ceremony from an API key or the bootstrap credential;
 * `unknown_challenge` / `unknown_step_up`: a ceremony id this session does not
 * hold; `step_up_action_too_large`: action facts over the size any action has. */
export const CEREMONY_REFUSALS = {
  passkey_attestation_refused: 422,
  passkey_already_registered: 409,
  fresh_sign_in_required: 403,
  browser_session_required: 403,
  unknown_challenge: 404,
  unknown_step_up: 404,
  step_up_action_too_large: 413,
} as const;
export type CeremonyRefusalCode = keyof typeof CEREMONY_REFUSALS;

export const BATCH4_REFUSAL_CODES = [
  ...(Object.keys(STEP_UP_REFUSALS) as StepUpRefusalCode[]),
  ...(Object.keys(PASSKEY_REFUSALS) as PasskeyRefusalCode[]),
  ...(Object.keys(APPROVAL_REFUSALS) as ApprovalRefusalCode[]),
  ...(Object.keys(CEREMONY_REFUSALS) as CeremonyRefusalCode[]),
] as const;
export type Batch4RefusalCode = StepUpRefusalCode | PasskeyRefusalCode | ApprovalRefusalCode | CeremonyRefusalCode;

/** the `step_up_required` body: what the client must prove, and for which action */
export interface StepUpRequiredBody {
  error: "step_up_required";
  actionKind: StepUpActionKind;
  methods: StepUpMethod[];
  detail?: string;
}

/** B: the audit rule id of a failed execution-time signature recheck */
export const APPROVAL_SIGNATURE_RECHECK_FAILED_RULE = "approval-signature-recheck-failed";

// ---------------------------------------------------------------------------
// The receipt payload (R). The canonical bytes are `canonicalJson(payload)`;
// the signature is Ed25519 over exactly those bytes. No reason or detail text.
// ---------------------------------------------------------------------------

export interface DecisionReceiptPayload {
  v: typeof RECEIPT_PAYLOAD_VERSION;
  receiptSeq: number;
  audit: { id: string; seq: number; rowHash: string; contentHash: string };
  decision: {
    /** ISO-8601 with milliseconds, the audit row's `at` */
    at: string;
    userId: string;
    objectType: string;
    objectId: string | null;
    serverId: string | null;
    toolName: string | null;
    /** SHA-256 of an oversized audit tool name; the raw field is null. */
    toolNameHash?: string;
    effect: "allow" | "deny" | "require_approval";
    ruleId: string | null;
    /** SHA-256 of an oversized audit rule id; the raw field is null. */
    ruleIdHash?: string;
  };
  /** the previous receipt's payload hash (sha256 hex), `RECEIPT_GENESIS_PREV` for the first */
  prev: string;
  keyId: string;
}

/**
 * ADR-0189 R34: the v2 payload. Everything v1 carries, plus ADR-0188 decision
 * 9's actor fields and the decision's facts binding. `factsHash` is null only
 * when `decision_facts_capture` was off for that decision, and then
 * `factsStatus` says so inside the signed bytes.
 */
export interface DecisionReceiptPayloadV2 extends Omit<DecisionReceiptPayload, "v"> {
  v: typeof RECEIPT_PAYLOAD_VERSION_V2;
  actor: {
    /** the acting workload identity (ADR-0188), null when a person acted directly */
    identityId: string | null;
    delegationGrantId: string | null;
    /** ordered identity ids, root first; null when there is no chain */
    chain: string[] | null;
  };
  factsStatus: "captured" | "capture_off";
  /** `decision_facts.facts_hash`; null exactly when `factsStatus` is `capture_off` */
  factsHash: string | null;
}
export type AnyDecisionReceiptPayload = DecisionReceiptPayload | DecisionReceiptPayloadV2;

/** the bytes a receipt signature covers */
export function receiptCanonicalBytes(payload: AnyDecisionReceiptPayload): string {
  return canonicalJson(payload);
}

// ---------------------------------------------------------------------------
// Org settings: the strict defaults, the bounds, what relaxing gives up
// ---------------------------------------------------------------------------

/** the bounds (zod and the DB CHECKs of migration 0170 hold the same numbers) */
export const BATCH4_SETTING_LIMITS = {
  stepUpMaxAgeSeconds: { min: 30, max: 900 },
  toolApprovalSensitiveQuorum: APPROVAL_QUORUM_LIMITS,
  monitorMcpBaselineDays: { min: 1, max: 90 },
  monitorJailbreakThreshold: { min: 1, max: 100 },
  monitorJailbreakWindowHours: { min: 1, max: 168 },
} as const;

/** THE STRICT DEFAULTS. The column defaults of migration 0170 are these values;
 * a fresh org reads exactly this. */
export const BATCH4_STRICT_DEFAULTS = Object.freeze({
  approvalSignatureMode: "passkey" as ApprovalSignatureMode,
  stepUpMode: "required" as StepUpMode,
  stepUpMaxAgeSeconds: 120 as number,
  stepUpActions: [...STEP_UP_ACTION_KINDS] as StepUpActionKind[],
  toolApprovalSensitiveQuorum: 2 as number,
  decisionReceiptsMode: "on" as DecisionReceiptsMode,
  auditAnchorTimestampMode: "required" as AuditAnchorTimestampMode,
  vendoredDetectionPacks: [...VENDORED_DETECTION_PACKS] as VendoredDetectionPack[],
  outboundCredentialAudience: "enforce" as OutboundCredentialAudienceMode,
  monitorMcpBaselineDays: 14 as number,
  monitorJailbreakThreshold: 3 as number,
  monitorJailbreakWindowHours: 24 as number,
});
export type Batch4Settings = {
  -readonly [K in keyof typeof BATCH4_STRICT_DEFAULTS]: (typeof BATCH4_STRICT_DEFAULTS)[K];
};
export type Batch4SettingKey = keyof Batch4Settings;
export const BATCH4_SETTING_KEYS = Object.keys(BATCH4_STRICT_DEFAULTS) as Batch4SettingKey[];

/** the snake_case column of each setting (migration 0170) */
export const BATCH4_SETTING_COLUMNS: Readonly<Record<Batch4SettingKey, string>> = {
  approvalSignatureMode: "approval_signature_mode",
  stepUpMode: "step_up_mode",
  stepUpMaxAgeSeconds: "step_up_max_age_seconds",
  stepUpActions: "step_up_actions",
  toolApprovalSensitiveQuorum: "tool_approval_sensitive_quorum",
  decisionReceiptsMode: "decision_receipts_mode",
  auditAnchorTimestampMode: "audit_anchor_timestamp_mode",
  vendoredDetectionPacks: "vendored_detection_packs",
  outboundCredentialAudience: "outbound_credential_audience",
  monitorMcpBaselineDays: "monitor_mcp_baseline_days",
  monitorJailbreakThreshold: "monitor_jailbreak_threshold",
  monitorJailbreakWindowHours: "monitor_jailbreak_window_hours",
};

/** What the strict default does, and what an admin gives up by relaxing it. */
export const BATCH4_SETTING_COPY: Readonly<Record<Batch4SettingKey, { label: string; strict: string; relaxed: string }>> = {
  approvalSignatureMode: {
    label: "Tool-call approval signature",
    strict:
      "Passkey: each approver signs the exact call with a passkey, and the gateway re-checks every signature against " +
      "the call that actually runs.",
    relaxed:
      "Step-up asks for a fresh second factor but no signature over the call; off accepts a plain decision, so nothing " +
      "proves which call an approver saw.",
  },
  stepUpMode: {
    label: "Step-up for sensitive actions",
    strict: "Required: the listed actions need a fresh passkey, authenticator code or SSO login, bound to the action.",
    relaxed: "Off: a signed-in session alone can decide approvals, relax settings and manage passkeys.",
  },
  stepUpMaxAgeSeconds: {
    label: "Step-up lifetime (seconds)",
    strict: "120 seconds: a step-up is used once, for the one action it was made for, within two minutes.",
    relaxed: "A longer lifetime (up to 900 seconds) leaves a usable proof waiting for longer.",
  },
  stepUpActions: {
    label: "Actions that need a step-up",
    strict:
      "All six: deciding an approval, relaxing a setting, overriding an evidence hold, break-glass, managing passkeys " +
      "and changing an owner.",
    relaxed: "Each action removed from the list can be done with the session alone.",
  },
  toolApprovalSensitiveQuorum: {
    label: "Approvers for calls on sensitive data",
    strict:
      "Two different people approve a call attributed to a project with an in-app-only data classification; the " +
      "caller never counts, and a delegator and their delegate count once.",
    relaxed: "One approver can let such a call through alone.",
  },
  decisionReceiptsMode: {
    label: "Signed decision receipts",
    strict: "On: every governed-call and approval decision gets a receipt signed with the deployment's key.",
    relaxed: "Off: decisions stay on the hash chain only, with no receipt a third party can verify offline.",
  },
  auditAnchorTimestampMode: {
    label: "Trusted timestamps on audit anchors",
    strict:
      "Required: each anchor is sent to the configured RFC 3161 time-stamping authority; with none configured the " +
      "anchor reads as not timestamped.",
    relaxed: "Off: anchors carry no third-party time, so when the trail existed rests on this deployment's own clock.",
  },
  vendoredDetectionPacks: {
    label: "Vendored detection content",
    strict:
      "All four packs: secret patterns (redacted on match), text normalisation before injection rules, injection " +
      "rules, and MCP manifest heuristics.",
    relaxed: "Each pack turned off stops detecting what it covers.",
  },
  outboundCredentialAudience: {
    label: "Credentials sent to the wrong service",
    strict:
      "Enforce: a tool or connector call whose own arguments carry a known credential (for example a GitHub or " +
      "cloud API token) is refused unless it goes to that credential's own service. Credentials the gateway adds " +
      "itself are not affected.",
    relaxed: "Off: a call may carry such a credential to any destination the egress rules allow.",
  },
  monitorMcpBaselineDays: {
    label: "MCP server baseline (days)",
    strict: "14 days: an agent calling a server it did not call in the last 14 days raises an alert.",
    relaxed: "A longer baseline (up to 90 days) treats more servers as already known, so fewer new ones alert.",
  },
  monitorJailbreakThreshold: {
    label: "Jailbreak findings before an alert",
    strict: "3 findings for one person in the window, followed by an allowed tool call, raise an alert.",
    relaxed: "A higher threshold (up to 100) lets more attempts pass before anyone is told.",
  },
  monitorJailbreakWindowHours: {
    label: "Jailbreak correlation window (hours)",
    strict: "24 hours: findings for one person within a day are counted together.",
    relaxed: "A shorter window (down to 1 hour) counts fewer findings together, so spread-out attempts alert less.",
  },
};

const SIGNATURE_RANK: Record<ApprovalSignatureMode, number> = { passkey: 2, step_up: 1, off: 0 };
const sameJson = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const missingAny = (value: readonly string[], strict: readonly string[]) => strict.some((s) => !value.includes(s));

/**
 * Is `value` a RELAXATION of the strict default for `key`? A weaker signature
 * mode, step-up off, a longer step-up lifetime, any step-up action or pack
 * removed, a smaller sensitive quorum, receipts, timestamps or outbound credential audience off, a longer MCP
 * baseline, a higher jailbreak threshold and a shorter jailbreak window are
 * relaxations; the opposite moves are stricter.
 */
export function batch4SettingRelaxed<K extends Batch4SettingKey>(key: K, value: Batch4Settings[K]): boolean {
  switch (key) {
    case "approvalSignatureMode":
      return SIGNATURE_RANK[value as ApprovalSignatureMode] < SIGNATURE_RANK.passkey;
    case "stepUpMode":
      return value !== "required";
    case "stepUpMaxAgeSeconds":
    case "monitorMcpBaselineDays":
    case "monitorJailbreakThreshold":
      return (value as number) > (BATCH4_STRICT_DEFAULTS[key] as number);
    case "toolApprovalSensitiveQuorum":
    case "monitorJailbreakWindowHours":
      return (value as number) < (BATCH4_STRICT_DEFAULTS[key] as number);
    case "stepUpActions":
      return missingAny(value as string[], STEP_UP_ACTION_KINDS);
    case "vendoredDetectionPacks":
      return missingAny(value as string[], VENDORED_DETECTION_PACKS);
    case "decisionReceiptsMode":
      return value !== "on";
    case "auditAnchorTimestampMode":
      return value !== "required";
    case "outboundCredentialAudience":
      return value !== "enforce";
    default:
      return !sameJson(value, BATCH4_STRICT_DEFAULTS[key]);
  }
}

/** which of the changed keys are batch-4 settings now looser than their strict default */
export function relaxedBatch4Keys(changed: Record<string, unknown>): Batch4SettingKey[] {
  return BATCH4_SETTING_KEYS.filter((k) => k in changed && batch4SettingRelaxed(k, changed[k] as never));
}

const boundedInt = (b: { min: number; max: number }) => z.number().int().min(b.min).max(b.max);
const uniqueSubset = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .array(z.enum(values))
    .max(values.length)
    .refine((a) => new Set(a).size === a.length, "each value at most once")
    // stored in vocabulary order, so the same set always reads (and audits) the same
    .transform((a) => values.filter((v) => a.includes(v)) as T[number][]);

/**
 * The batch-4 fields of `PUT /v1/org/settings` (spread into
 * `updateOrgSettingsSchema`). Every one is optional (a partial update); out of
 * range or unknown values are a 400.
 */
export const batch4OrgSettingsFields = {
  /** strict "passkey"; step_up or off relaxes it */
  approvalSignatureMode: z.enum(APPROVAL_SIGNATURE_MODES).optional(),
  /** strict "required"; off relaxes it */
  stepUpMode: z.enum(STEP_UP_MODES).optional(),
  /** strict 120; longer, up to 900, relaxes it */
  stepUpMaxAgeSeconds: boundedInt(BATCH4_SETTING_LIMITS.stepUpMaxAgeSeconds).optional(),
  /** strict: all six; removing one relaxes it */
  stepUpActions: uniqueSubset(STEP_UP_ACTION_KINDS).optional(),
  /** strict 2; 1 relaxes it */
  toolApprovalSensitiveQuorum: boundedInt(BATCH4_SETTING_LIMITS.toolApprovalSensitiveQuorum).optional(),
  /** strict "on"; off relaxes it */
  decisionReceiptsMode: z.enum(DECISION_RECEIPTS_MODES).optional(),
  /** strict "required"; off relaxes it */
  auditAnchorTimestampMode: z.enum(AUDIT_ANCHOR_TIMESTAMP_MODES).optional(),
  /** strict: all four; removing one relaxes it */
  vendoredDetectionPacks: uniqueSubset(VENDORED_DETECTION_PACKS).optional(),
  /** strict "enforce"; off relaxes it */
  outboundCredentialAudience: z.enum(OUTBOUND_CREDENTIAL_AUDIENCE_MODES).optional(),
  /** strict 14; longer, up to 90, relaxes it */
  monitorMcpBaselineDays: boundedInt(BATCH4_SETTING_LIMITS.monitorMcpBaselineDays).optional(),
  /** strict 3; higher, up to 100, relaxes it */
  monitorJailbreakThreshold: boundedInt(BATCH4_SETTING_LIMITS.monitorJailbreakThreshold).optional(),
  /** strict 24; shorter, down to 1, relaxes it */
  monitorJailbreakWindowHours: boundedInt(BATCH4_SETTING_LIMITS.monitorJailbreakWindowHours).optional(),
} as const;

// ---------------------------------------------------------------------------
// Request bodies (§4.9). Structural only: the slices validate the facts.
// ---------------------------------------------------------------------------

/** POST /v1/auth/step-up/options */
export const stepUpOptionsSchema = z
  .object({ action: z.object({ kind: z.enum(STEP_UP_ACTION_KINDS), body: z.record(z.unknown()).default({}) }).strict() })
  .strict();
export type StepUpOptionsInput = z.infer<typeof stepUpOptionsSchema>;

/** POST /v1/auth/step-up/verify */
export const stepUpVerifySchema = z.discriminatedUnion("method", [
  z.object({ stepUpId: z.string().uuid(), method: z.literal("totp"), code: z.string().regex(/^\d{6}$/) }).strict(),
  z.object({ stepUpId: z.string().uuid(), method: z.literal("passkey"), response: z.record(z.unknown()) }).strict(),
]);
export type StepUpVerifyInput = z.infer<typeof stepUpVerifySchema>;

/** POST /v1/auth/passkeys */
export const registerPasskeySchema = z
  .object({ challengeId: z.string().uuid(), response: z.record(z.unknown()), label: z.string().trim().min(1).max(100) })
  .strict();
export type RegisterPasskeyInput = z.infer<typeof registerPasskeySchema>;

/** PATCH /v1/auth/passkeys/:id */
export const renamePasskeySchema = z.object({ label: z.string().trim().min(1).max(100) }).strict();

/** POST /v1/approvals/:id/signing-options */
export const approvalSigningOptionsSchema = z.object({ decision: z.enum(APPROVAL_DECISION_VALUES) }).strict();
export type ApprovalSigningOptionsInput = z.infer<typeof approvalSigningOptionsSchema>;

/** the `passkey` member of the extended POST /v1/approvals/:id/decide body */
export const approvalDecidePasskeyField = z
  .object({ challengeId: z.string().uuid(), response: z.record(z.unknown()) })
  .strict();

/** POST/PATCH /v1/rules/approvals gain these (slice A) */
export const approvalRuleQuorumFields = {
  quorum: boundedInt(APPROVAL_QUORUM_LIMITS).optional(),
  approverRoleId: z.string().uuid().nullable().optional(),
} as const;
