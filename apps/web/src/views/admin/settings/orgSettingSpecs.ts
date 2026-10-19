/**
 * U3 settings batch — the browser's model of the org settings that had no
 * control: their strict defaults, bounds, what relaxing each gives up, and the
 * two predicates that decide what the confirmation says.
 *
 *  - `relaxed(value)`: is the value looser than the strict default? (the
 *    "relaxed (audited)" badge, and the sentence the dialog shows)
 *  - `looser(value, stored)`: is it looser than the value stored NOW? Together
 *    with `relaxed` this is what the gateway's `settings_relax` step-up is
 *    judged on (`org-setting-strictness.ts`, ADR-0186 decision 26), so it
 *    decides whether the dialog says a step-up follows.
 *
 * The SPA does not depend on `@regulait/shared`, so the batch-4, batch-5 and
 * identity rows below mirror `BATCH4_SETTING_COPY`, `BATCH5_SETTING_COPY` and
 * `IDENTITY_SETTING_COPY` (and their strict defaults, bounds and predicates).
 * `orgSettingSpecs.test.ts` imports those modules at test time and fails on any
 * drift. The remaining rows mirror the gateway's strictness registry and the
 * PUT schema in `packages/shared/src/index.ts`.
 *
 * Every stored value is read as unknown input: a missing or mistyped value is
 * "unknown", never the strict default (ADR-0180).
 */

export interface Choice {
  value: string;
  label: string;
}

export type Control =
  | { kind: "enum"; options: readonly Choice[] }
  | { kind: "boolean"; on: string; off: string }
  /** a whole number; `noneLabel` makes it nullable (null = no limit) */
  | { kind: "int"; min: number; max: number; unit: string; noneLabel?: string }
  | { kind: "decimal"; min: number; max: number; unit: string; step: number }
  /** a subset of a vocabulary, sent in vocabulary order */
  | { kind: "set"; options: readonly Choice[] }
  /** ADR-0021 A4: a per-deploy-mode retention map (each entry optional, whole days) */
  | { kind: "modeMap"; modes: readonly Choice[]; min: number };

export interface OrgSettingSpec {
  key: string;
  label: string;
  strictDefault: unknown;
  /** what the strict value does */
  strict: string;
  /** what a looser value gives up */
  relaxed: string;
  control: Control;
  /** looser than the strict default? */
  isRelaxed: (value: unknown) => boolean;
  /** looser than the stored value? (decision 26) */
  looser?: (value: unknown, stored: unknown) => boolean;
}

/** a form's state for one setting; each control reads the part it needs */
export interface Draft {
  text: string;
  none: boolean;
  set: string[];
  map: Record<string, string>;
}

// ---------------------------------------------------------------------------
// comparators (the gateway's, mirrored)
// ---------------------------------------------------------------------------

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** a larger number, or null (= unbounded), is looser */
export const largerLooser = (v: unknown, b: unknown) => v !== b && (v === null || (num(v) && num(b) && v > b));
/** a smaller number is looser */
export const smallerLooser = (v: unknown, b: unknown) => num(v) && num(b) && v < b;
/** a protection list: dropping a stored entry is looser */
export const dropsAny = (v: unknown, b: unknown) => {
  const next = new Set(Array.isArray(v) ? v.map(String) : []);
  return Array.isArray(b) && b.some((x) => !next.has(String(x)));
};
/** a permission list: an entry not stored is looser */
export const addsAny = (v: unknown, b: unknown) => {
  const before = new Set(Array.isArray(b) ? b.map(String) : []);
  return Array.isArray(v) && v.some((x) => !before.has(String(x)));
};
const missingAny = (v: unknown, all: readonly string[]) => !Array.isArray(v) || all.some((x) => !v.includes(x));
const atMost = (strict: number) => (v: unknown) => v === null || (num(v) && v > strict);
const atLeast = (strict: number) => (v: unknown) => num(v) && v < strict;
const notEqual = (strict: unknown) => (v: unknown) => v !== strict;

const values = (choices: readonly Choice[]) => choices.map((c) => c.value);
const onOff = (on: string, off: string): Control => ({ kind: "boolean", on, off });

// ---------------------------------------------------------------------------
// vocabularies (packages/shared, mirrored)
// ---------------------------------------------------------------------------

export const APPROVAL_SIGNATURE_MODES: readonly Choice[] = [
  { value: "passkey", label: "Passkey signature" },
  { value: "step_up", label: "Step-up only" },
  { value: "off", label: "Off" },
];
export const STEP_UP_ACTION_KINDS: readonly Choice[] = [
  { value: "approval_decide", label: "Deciding an approval" },
  { value: "settings_relax", label: "Relaxing a setting" },
  { value: "evidence_hold_override", label: "Overriding an evidence hold" },
  { value: "break_glass", label: "Changing break-glass access" },
  { value: "passkey_manage", label: "Managing passkeys" },
  { value: "owner_change", label: "Changing an owner" },
  { value: "identity_manage", label: "Managing agent identities" },
  { value: "pseudonym_reveal", label: "Revealing a person's name" },
  { value: "key_management", label: "Managing signing keys" },
];
export const VENDORED_DETECTION_PACKS: readonly Choice[] = [
  { value: "pipelock-secrets", label: "Secret patterns (pipelock-secrets)" },
  { value: "pipelock-normalise", label: "Text normalisation (pipelock-normalise)" },
  { value: "nemo-yara-injection", label: "Injection rules (nemo-yara-injection)" },
  { value: "agt-mcp-heuristics", label: "MCP manifest heuristics (agt-mcp-heuristics)" },
];
export const WORKLOAD_CLIENT_AUTH_METHODS: readonly Choice[] = [
  { value: "private_key_jwt", label: "Signed assertion from a registered key (private_key_jwt)" },
  { value: "tls_client_auth", label: "CA-issued client certificate (tls_client_auth)" },
  { value: "self_signed_tls_client_auth", label: "Registered self-signed certificate (self_signed_tls_client_auth)" },
  { value: "spiffe_svid", label: "SPIFFE identity (spiffe_svid)" },
  { value: "spiffe_jwt_svid", label: "SPIFFE JWT bearer token (spiffe_jwt_svid)" },
];
export const INTERNATIONAL_PII_CATEGORIES: readonly Choice[] = [
  { value: "aadhaar", label: "India: Aadhaar number" },
  { value: "cpf", label: "Brazil: CPF" },
  { value: "bsn", label: "Netherlands: BSN" },
  { value: "sin", label: "Canada: Social Insurance Number" },
  { value: "tfn", label: "Australia: Tax File Number" },
  { value: "steuer_id", label: "Germany: Steuer-ID" },
  { value: "nir", label: "France: NIR" },
  { value: "dni_nie", label: "Spain: DNI / NIE" },
  { value: "codice_fiscale", label: "Italy: Codice Fiscale" },
  { value: "nino", label: "United Kingdom: National Insurance number" },
];
export const DEPLOY_MODES: readonly Choice[] = [
  { value: "hosted", label: "Hosted" },
  { value: "byoc", label: "BYOC" },
  { value: "air_gapped", label: "Air-gapped" },
];

const STEP_UP_ALL = values(STEP_UP_ACTION_KINDS);
const PACKS_ALL = values(VENDORED_DETECTION_PACKS);
// every method but the bearer JWT-SVID (ADR-0188 S9 follow-up: off by default)
const AUTH_STRICT = values(WORKLOAD_CLIENT_AUTH_METHODS).filter((m) => m !== "spiffe_jwt_svid");
const SIGNATURE_RANK: Record<string, number> = { passkey: 2, step_up: 1, off: 0 };

// ---------------------------------------------------------------------------
// batch 4 (ADR-0186): BATCH4_SETTING_COPY, mirrored
// ---------------------------------------------------------------------------

export const BATCH4_SPECS: Readonly<Record<string, OrgSettingSpec>> = {
  approvalSignatureMode: {
    key: "approvalSignatureMode",
    label: "Tool-call approval signature",
    strictDefault: "passkey",
    strict:
      "Passkey: each approver signs the exact call with a passkey, and the gateway re-checks every signature against " +
      "the call that actually runs.",
    relaxed:
      "Step-up asks for a fresh second factor but no signature over the call; off accepts a plain decision, so nothing " +
      "proves which call an approver saw.",
    control: { kind: "enum", options: APPROVAL_SIGNATURE_MODES },
    isRelaxed: (v) => (SIGNATURE_RANK[String(v)] ?? -1) < SIGNATURE_RANK.passkey!,
  },
  stepUpMode: {
    key: "stepUpMode",
    label: "Step-up for sensitive actions",
    strictDefault: "required",
    strict: "Required: the listed actions need a fresh passkey, authenticator code or SSO login, bound to the action.",
    relaxed: "Off: a signed-in session alone can decide approvals, relax settings and manage passkeys.",
    control: { kind: "enum", options: [{ value: "required", label: "Required" }, { value: "off", label: "Off" }] },
    isRelaxed: notEqual("required"),
  },
  stepUpMaxAgeSeconds: {
    key: "stepUpMaxAgeSeconds",
    label: "Step-up lifetime (seconds)",
    strictDefault: 120,
    strict: "120 seconds: a step-up is used once, for the one action it was made for, within two minutes.",
    relaxed: "A longer lifetime (up to 900 seconds) leaves a usable proof waiting for longer.",
    control: { kind: "int", min: 30, max: 900, unit: "seconds" },
    isRelaxed: atMost(120),
    looser: largerLooser,
  },
  stepUpActions: {
    key: "stepUpActions",
    label: "Actions that need a step-up",
    strictDefault: STEP_UP_ALL,
    strict:
      "All nine: deciding an approval, relaxing a setting, overriding an evidence hold, break-glass, managing passkeys, " +
      "changing an owner, managing agent identities, revealing a person's name and managing signing keys.",
    relaxed: "Each action removed from the list can be done with the session alone.",
    control: { kind: "set", options: STEP_UP_ACTION_KINDS },
    isRelaxed: (v) => missingAny(v, STEP_UP_ALL),
  },
  toolApprovalSensitiveQuorum: {
    key: "toolApprovalSensitiveQuorum",
    label: "Approvers for calls on sensitive data",
    strictDefault: 2,
    strict:
      "Two different people approve a call attributed to a project with an in-app-only data classification; the " +
      "caller never counts, and a delegator and their delegate count once.",
    relaxed: "One approver can let such a call through alone.",
    control: { kind: "int", min: 1, max: 5, unit: "approvers" },
    isRelaxed: atLeast(2),
    looser: smallerLooser,
  },
  decisionReceiptsMode: {
    key: "decisionReceiptsMode",
    label: "Signed decision receipts",
    strictDefault: "on",
    strict: "On: every governed-call and approval decision gets a receipt signed with the deployment's key.",
    relaxed: "Off: decisions stay on the hash chain only, with no receipt a third party can verify offline.",
    control: { kind: "enum", options: [{ value: "on", label: "On" }, { value: "off", label: "Off" }] },
    isRelaxed: notEqual("on"),
  },
  auditAnchorTimestampMode: {
    key: "auditAnchorTimestampMode",
    label: "Trusted timestamps on audit anchors",
    strictDefault: "required",
    strict:
      "Required: each anchor is sent to the configured RFC 3161 time-stamping authority; with none configured the " +
      "anchor reads as not timestamped.",
    relaxed: "Off: anchors carry no third-party time, so when the trail existed rests on this deployment's own clock.",
    control: { kind: "enum", options: [{ value: "required", label: "Required" }, { value: "off", label: "Off" }] },
    isRelaxed: notEqual("required"),
  },
  vendoredDetectionPacks: {
    key: "vendoredDetectionPacks",
    label: "Vendored detection content",
    strictDefault: PACKS_ALL,
    strict:
      "All four packs: secret patterns (redacted on match), text normalisation before injection rules, injection " +
      "rules, and MCP manifest heuristics.",
    relaxed: "Each pack turned off stops detecting what it covers.",
    control: { kind: "set", options: VENDORED_DETECTION_PACKS },
    isRelaxed: (v) => missingAny(v, PACKS_ALL),
  },
  outboundCredentialAudience: {
    key: "outboundCredentialAudience",
    label: "Credentials sent to the wrong service",
    strictDefault: "enforce",
    strict:
      "Enforce: a tool or connector call whose own arguments carry a known credential (for example a GitHub or " +
      "cloud API token) is refused unless it goes to that credential's own service. Credentials the gateway adds " +
      "itself are not affected.",
    relaxed: "Off: a call may carry such a credential to any destination the egress rules allow.",
    control: { kind: "enum", options: [{ value: "enforce", label: "Enforce" }, { value: "off", label: "Off" }] },
    isRelaxed: notEqual("enforce"),
  },
};

// ---------------------------------------------------------------------------
// batch 5 (ADR-0187): BATCH5_SETTING_COPY, mirrored
// ---------------------------------------------------------------------------

const batch5Int = (key: string, label: string, strict: number, min: number, max: number, unit: string, strictCopy: string, relaxedCopy: string): OrgSettingSpec => ({
  key,
  label,
  strictDefault: strict,
  strict: strictCopy,
  relaxed: relaxedCopy,
  control: { kind: "int", min, max, unit },
  isRelaxed: (v) => num(v) && v > strict,
  looser: (v, b) => num(v) && num(b) && v > b,
});
const batch5Usd = (key: string, label: string, strict: number, min: number, max: number, strictCopy: string, relaxedCopy: string): OrgSettingSpec => ({
  key,
  label,
  strictDefault: strict,
  strict: strictCopy,
  relaxed: relaxedCopy,
  control: { kind: "decimal", min, max, unit: "USD", step: 0.01 },
  isRelaxed: (v) => num(v) && v > strict,
  looser: (v, b) => num(v) && num(b) && v > b,
});

export const BATCH5_SPECS: Readonly<Record<string, OrgSettingSpec>> = {
  engineMaxRunTimeoutMinutes: batch5Int(
    "engineMaxRunTimeoutMinutes",
    "Longest engine run (minutes)",
    30,
    1,
    120,
    "minutes",
    "30 minutes: a run still going after that is stopped, its key revoked, and it reads as timed out.",
    "A longer limit (up to 120 minutes) lets a run, and its key, stay live for longer.",
  ),
  engineDefaultRunBudgetUsd: batch5Usd(
    "engineDefaultRunBudgetUsd",
    "Default engine run budget (USD)",
    2,
    0.01,
    1000,
    "$2: a run that names no budget can spend at most this through the gateway before its key stops working.",
    "A higher default lets every run that names no budget spend more before it is cut off.",
  ),
  engineRunApprovalThresholdUsd: batch5Usd(
    "engineRunApprovalThresholdUsd",
    "Engine run budget that needs approval (USD)",
    10,
    0,
    10_000,
    "$10: a run with a larger budget waits in the approvals queue until someone approves it.",
    "A higher threshold lets larger runs start without anyone approving them.",
  ),
  engineRawReportRetentionDays: batch5Int(
    "engineRawReportRetentionDays",
    "Raw engine report retention (days)",
    90,
    1,
    3650,
    "days",
    "90 days: an engine's raw report is kept encrypted for 90 days, then deleted; its sha256 stays with the " + "normalised result.",
    "A longer period keeps raw engine output, which can quote model text, for longer.",
  ),
  engineSensitiveSetApproval: {
    key: "engineSensitiveSetApproval",
    label: "Approval for agentic and offensive engine sets",
    strictDefault: true,
    strict: "On: a run that uses an agentic or offensive set, or a set this build does not classify, needs approval first.",
    relaxed: "Off: such runs start without anyone approving them.",
    control: onOff("On", "Off"),
    isRelaxed: notEqual(true),
    looser: (v, b) => b === true && v === false,
  },
  modelArtifactUploaderQuotaMegabytes: batch5Int(
    "modelArtifactUploaderQuotaMegabytes",
    "Model artifact storage per uploader (MiB)",
    2048,
    1,
    1_048_576,
    "MiB",
    "2048 MiB: an upload that would take one person's stored artifacts past this is refused, and nothing of it is kept.",
    "A larger quota lets one person keep more untrusted model files on the gateway's storage.",
  ),
  modelArtifactUploaderQuotaCount: batch5Int(
    "modelArtifactUploaderQuotaCount",
    "Model artifacts per uploader",
    20,
    1,
    100_000,
    "artifacts",
    "20: a person who already keeps 20 artifacts must delete one before uploading another.",
    "A larger count lets one person keep more untrusted model files on the gateway's storage.",
  ),
  modelArtifactOrgQuotaMegabytes: batch5Int(
    "modelArtifactOrgQuotaMegabytes",
    "Model artifact storage in total (MiB)",
    20480,
    1,
    10_485_760,
    "MiB",
    "20480 MiB: an upload that would take everyone's stored artifacts past this is refused, and nothing of it is kept.",
    "A larger quota lets the artifact store grow further before uploads stop.",
  ),
  modelArtifactOrgQuotaCount: batch5Int(
    "modelArtifactOrgQuotaCount",
    "Model artifacts in total",
    200,
    1,
    1_000_000,
    "artifacts",
    "200: once 200 artifacts are stored, an artifact must be deleted before another is uploaded.",
    "A larger count lets the artifact store hold more files before uploads stop.",
  ),
};

// ---------------------------------------------------------------------------
// identity (ADR-0188): IDENTITY_SETTING_COPY, mirrored
// ---------------------------------------------------------------------------

export const IDENTITY_SPECS: Readonly<Record<string, OrgSettingSpec>> = {
  agentEntitlementMode: {
    key: "agentEntitlementMode",
    label: "Least privilege for agents",
    strictDefault: "own_grants",
    strict:
      "On: an agent may do only what its own grants allow AND what the person it works for may do; an agent " +
      "with no grants of its own can do nothing.",
    relaxed:
      "Off (sponsor only): an agent may do anything the person it works for may do. The posture page shows " +
      "\"least privilege for agents: off\".",
    control: {
      kind: "enum",
      options: [
        { value: "own_grants", label: "On: own grants and the sponsor's" },
        { value: "sponsor_only", label: "Off: sponsor only" },
      ],
    },
    isRelaxed: notEqual("own_grants"),
    looser: (v, b) => b === "own_grants" && v === "sponsor_only",
  },
  delegatedTokenTtlSeconds: {
    key: "delegatedTokenTtlSeconds",
    label: "Delegated token lifetime (seconds)",
    strictDefault: 300,
    strict: "300 seconds: a token an agent holds stops working five minutes after it was issued.",
    relaxed: "A longer lifetime (up to 3600 seconds) keeps a copied or leaked token usable for longer.",
    control: { kind: "int", min: 60, max: 3600, unit: "seconds" },
    isRelaxed: (v) => num(v) && v > 300,
    looser: (v, b) => num(v) && num(b) && v > b,
  },
  delegationMaxDepth: {
    key: "delegationMaxDepth",
    label: "Longest delegation chain",
    strictDefault: 3,
    strict:
      "3: the first agent plus up to three delegations below it, so at most four agents in one chain. A fourth " +
      "delegation is refused.",
    relaxed:
      "A longer chain (up to 8 delegations, nine agents) lets authority travel through more agents before it " +
      "reaches a call.",
    control: { kind: "int", min: 0, max: 8, unit: "delegations" },
    isRelaxed: (v) => num(v) && v > 3,
    looser: (v, b) => num(v) && num(b) && v > b,
  },
  workloadClientAuthMethods: {
    key: "workloadClientAuthMethods",
    label: "How workloads may sign in",
    strictDefault: AUTH_STRICT,
    strict:
      "Signed assertions from a registered key, client certificates and SPIFFE identities; not SPIFFE JWT bearer " +
      "tokens. Shared secrets are never offered.",
    relaxed: "Adding a method lets workloads sign in that way.",
    control: { kind: "set", options: WORKLOAD_CLIENT_AUTH_METHODS },
    isRelaxed: (v) => Array.isArray(v) && v.includes("spiffe_jwt_svid"),
    looser: addsAny,
  },
  dpopNonceRequired: {
    key: "dpopNonceRequired",
    label: "Require a server nonce in proof-of-possession",
    strictDefault: true,
    strict: "On: every proof a workload sends must carry a nonce the gateway issued in the last five minutes.",
    relaxed: "Off: a proof made in advance can be used, which widens the window to replay a captured one.",
    control: onOff("On", "Off"),
    isRelaxed: notEqual(true),
    looser: (v, b) => b === true && v === false,
  },
  workloadKeyMaxAgeDays: {
    key: "workloadKeyMaxAgeDays",
    label: "Longest workload key lifetime (days)",
    strictDefault: 90,
    strict: "90 days: a registered workload key or certificate is refused 90 days after it was added.",
    relaxed: "A limit you shortened, set longer again (never past 90 days), keeps keys valid for longer.",
    control: { kind: "int", min: 1, max: 90, unit: "days" },
    isRelaxed: () => false,
    looser: (v, b) => num(v) && num(b) && v > b,
  },
  delegationUncappedRootAllowed: {
    key: "delegationUncappedRootAllowed",
    label: "Allow delegations with no spending cap",
    strictDefault: false,
    strict: "Off: every delegation a person gives an agent has a spending cap; one with no cap is refused.",
    relaxed: "On: a person may delegate to an agent with no cap of its own; only their own budgets still apply.",
    control: onOff("On", "Off"),
    isRelaxed: (v) => v === true,
    looser: (v, b) => b === false && v === true,
  },
  delegationRootDefaultCapMicros: {
    key: "delegationRootDefaultCapMicros",
    label: "Default delegation spending cap (micro-dollars)",
    strictDefault: 0,
    strict: "None: a person must name a cap each time they delegate to an agent.",
    relaxed: "A default cap is applied when a person names none, so a delegation can carry spending nobody chose for it.",
    control: { kind: "int", min: 0, max: 1_000_000_000_000, unit: "micro-dollars" },
    isRelaxed: (v) => num(v) && v > 0,
    looser: (v, b) => num(v) && num(b) && v > b,
  },
  delegationRootMaxLifetimeSeconds: {
    key: "delegationRootMaxLifetimeSeconds",
    label: "Longest delegation lifetime (seconds)",
    strictDefault: 900,
    strict: "900 seconds: a delegation a person gives an agent ends after at most 15 minutes, its default too.",
    relaxed: "A longer limit (up to 24 hours) lets an agent keep acting for a person for longer after they delegated.",
    control: { kind: "int", min: 60, max: 86_400, unit: "seconds" },
    isRelaxed: (v) => num(v) && v > 900,
    looser: (v, b) => num(v) && num(b) && v > b,
  },
};

// ---------------------------------------------------------------------------
// the rest: the gateway's strictness registry and PUT schema, mirrored
// ---------------------------------------------------------------------------

export const CORE_SPECS: Readonly<Record<string, OrgSettingSpec>> = {
  piiInternationalCategories: {
    key: "piiInternationalCategories",
    label: "International national identifiers",
    strictDefault: [],
    strict:
      "None by default: the four base detectors (email, SSN, card number, phone) always run, and no jurisdiction is " +
      "added on your behalf because each one adds false positives on unstructured text.",
    relaxed: "Removing a jurisdiction you turned on stops detecting that identifier.",
    control: { kind: "set", options: INTERNATIONAL_PII_CATEGORIES },
    isRelaxed: () => false,
    looser: dropsAny,
  },
  modeAuditRetention: {
    key: "modeAuditRetention",
    label: "Audit retention per deploy mode (days)",
    strictDefault: {},
    strict:
      "No overrides: every audit row follows the global retention floor. An override only ever keeps that mode's rows " +
      "longer than the floor; it can never shorten anything.",
    relaxed: "Removing or lowering an override you set lets that mode's audit rows be pruned sooner.",
    control: { kind: "modeMap", modes: DEPLOY_MODES, min: 1 },
    isRelaxed: () => false,
    looser: (v, b) => {
      const next = (v ?? {}) as Record<string, number>;
      const stored = (b ?? {}) as Record<string, number>;
      return Object.entries(stored).some(([mode, days]) => !(mode in next) || next[mode]! < days);
    },
  },
  canaryObservationRetentionDays: {
    key: "canaryObservationRetentionDays",
    label: "Shadow-canary evidence retention (days)",
    strictDefault: 90,
    strict:
      "90 days: shadow-canary observations are kept at least 90 days before the prune removes them. Config versions " +
      "themselves are never pruned.",
    relaxed: "A shorter period deletes the evidence of how a rule behaved in shadow sooner.",
    control: { kind: "int", min: 1, max: 3650, unit: "days" },
    isRelaxed: atLeast(90),
    looser: smallerLooser,
  },
  backupVerifyEnabled: {
    key: "backupVerifyEnabled",
    label: "Scheduled backup verification",
    strictDefault: true,
    strict: "On: backups are restored and checked on a schedule, so a backup that cannot be restored is found before it is needed.",
    relaxed: "Off: nothing checks that backups restore until someone tries.",
    control: onOff("On", "Off"),
    isRelaxed: notEqual(true),
  },
  backupVerifyIntervalHours: {
    key: "backupVerifyIntervalHours",
    label: "Backup verification interval (hours)",
    strictDefault: 24,
    strict: "Every 24 hours.",
    relaxed: "A longer interval (up to 720 hours) leaves a broken backup unnoticed for longer.",
    control: { kind: "int", min: 1, max: 720, unit: "hours" },
    isRelaxed: atMost(24),
    looser: largerLooser,
  },
  mcpAdmissionMode: {
    key: "mcpAdmissionMode",
    label: "MCP admission scan",
    strictDefault: "enforce",
    strict:
      "Enforce: every manifest sync is scanned, and a server whose scan holds it is refused before any upstream " +
      "connection and offers no tools until an admin clears it with a reason.",
    relaxed: "Log records each verdict but refuses nothing; off runs no scan at all.",
    control: {
      kind: "enum",
      options: [
        { value: "enforce", label: "Enforce" },
        { value: "log", label: "Log only" },
        { value: "off", label: "Off" },
      ],
    },
    isRelaxed: notEqual("enforce"),
  },
  apiKeyDefaultTtlDays: {
    key: "apiKeyDefaultTtlDays",
    label: "Default API key lifetime (days)",
    strictDefault: 90,
    strict: "90 days: a key issued with no expiry of its own stops working 90 days after it was issued.",
    relaxed: "A longer default, or none, leaves keys nobody chose a lifetime for working for longer.",
    control: { kind: "int", min: 1, max: 3650, unit: "days", noneLabel: "No default (keys never expire unless the issuer sets one)" },
    isRelaxed: atMost(90),
    looser: largerLooser,
  },
  apiKeyMaxTtlDays: {
    key: "apiKeyMaxTtlDays",
    label: "Longest API key lifetime (days)",
    strictDefault: 365,
    strict: "365 days: a request for a longer lifetime, or for no expiry, is refused by name, never silently shortened.",
    relaxed: "A longer ceiling, or none, lets keys be issued that work for longer or forever.",
    control: { kind: "int", min: 1, max: 3650, unit: "days", noneLabel: "No ceiling (a key may be issued that never expires)" },
    isRelaxed: atMost(365),
    looser: largerLooser,
  },
  approvalTtlHours: {
    key: "approvalTtlHours",
    label: "Approved tool-call lifetime (hours)",
    strictDefault: 72,
    strict: "72 hours: an approved MCP tool call that is not used within 72 hours of being queued can no longer be spent.",
    relaxed: "A longer lifetime, or none, keeps an approval spendable long after the person decided it.",
    control: { kind: "int", min: 1, max: 8760, unit: "hours", noneLabel: "Never expires" },
    isRelaxed: atMost(72),
    looser: largerLooser,
  },
  approvalBulkMaxItems: {
    key: "approvalBulkMaxItems",
    label: "Most approvals in one bulk action",
    strictDefault: 25,
    strict: "25: one bulk approve, deny or reassign decides at most 25 approvals.",
    relaxed: "A larger cap (up to 500) lets one click decide more approvals nobody looked at one by one.",
    control: { kind: "int", min: 1, max: 500, unit: "approvals" },
    isRelaxed: atMost(25),
    looser: largerLooser,
  },
  approvalBulkSensitiveBlocked: {
    key: "approvalBulkSensitiveBlocked",
    label: "Bulk actions on PII-blocking projects",
    strictDefault: true,
    strict: "Refused: approvals attributed to a project whose compliance profile blocks PII are decided one at a time.",
    relaxed: "Allowed: such approvals can be decided in bulk with everything else.",
    control: onOff("Refused", "Allowed"),
    isRelaxed: notEqual(true),
  },
  mrmExpiryWarnDays: {
    key: "mrmExpiryWarnDays",
    label: "Model card expiry warning (days)",
    strictDefault: 30,
    strict:
      "30 days: a signed-off model card is listed as expiring this many days before its sign-off lapses. It informs " +
      "only; a lapsed sign-off is refused on its end date whatever this is.",
    relaxed: "A shorter window gives less notice before a model stops being dispatchable.",
    control: { kind: "int", min: 0, max: 3650, unit: "days" },
    // exempt in the gateway's registry: no value asks for a step-up
    isRelaxed: () => false,
  },
};

export const ALL_SPECS: Readonly<Record<string, OrgSettingSpec>> = {
  ...BATCH4_SPECS,
  ...BATCH5_SPECS,
  ...IDENTITY_SPECS,
  ...CORE_SPECS,
};

/** the specs for `keys`, in that order (a key with no spec is a programming error) */
export function specsFor(keys: readonly string[]): OrgSettingSpec[] {
  return keys.map((k) => {
    const spec = ALL_SPECS[k];
    if (!spec) throw new Error(`no org setting spec for ${k}`);
    return spec;
  });
}

// ---------------------------------------------------------------------------
// reading, parsing and comparing values
// ---------------------------------------------------------------------------

const WHOLE = /^-?[0-9]+$/;
const DECIMAL = /^[0-9]+(\.[0-9]{1,2})?$/;

/**
 * The stored value, checked for its type. `undefined` = unknown (missing or
 * mistyped), which the form shows as unknown and never edits.
 */
export function storedValue(spec: OrgSettingSpec, raw: unknown): unknown {
  const c = spec.control;
  switch (c.kind) {
    case "enum":
      return typeof raw === "string" && c.options.some((o) => o.value === raw) ? raw : undefined;
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "int":
      if (raw === null && c.noneLabel) return null;
      return num(raw) && Number.isInteger(raw) ? raw : undefined;
    case "decimal":
      return num(raw) ? raw : undefined;
    case "set": {
      if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) return undefined;
      const known = values(c.options);
      // an entry this build does not know is kept as it is, so a save never drops it silently
      return [...known.filter((v) => raw.includes(v)), ...raw.filter((v) => !known.includes(v))];
    }
    case "modeMap": {
      if (raw === null) return {};
      if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
      const entries = Object.entries(raw as Record<string, unknown>);
      if (!entries.every(([, d]) => num(d) && Number.isInteger(d))) return undefined;
      return Object.fromEntries(entries);
    }
  }
}

export function draftOf(spec: OrgSettingSpec, value: unknown): Draft {
  const blank: Draft = { text: "", none: false, set: [], map: {} };
  if (value === undefined) return blank;
  switch (spec.control.kind) {
    case "boolean":
      return { ...blank, text: value === true ? "true" : "false" };
    case "int":
      return value === null ? { ...blank, none: true } : { ...blank, text: String(value) };
    case "set":
      return { ...blank, set: [...(value as string[])] };
    case "modeMap":
      return { ...blank, map: Object.fromEntries(Object.entries(value as Record<string, number>).map(([k, d]) => [k, String(d)])) };
    default:
      return { ...blank, text: String(value) };
  }
}

export type Parsed = { ok: true; value: unknown } | { ok: false; problem: string };

/** the draft as the value the gateway's PUT schema accepts, or the reason it would refuse it */
export function parseDraft(spec: OrgSettingSpec, draft: Draft): Parsed {
  const c = spec.control;
  switch (c.kind) {
    case "enum":
      return c.options.some((o) => o.value === draft.text) ? { ok: true, value: draft.text } : { ok: false, problem: "Choose a value." };
    case "boolean":
      return draft.text === "true" || draft.text === "false" ? { ok: true, value: draft.text === "true" } : { ok: false, problem: "Choose a value." };
    case "int": {
      if (draft.none && c.noneLabel) return { ok: true, value: null };
      const t = draft.text.trim();
      if (!WHOLE.test(t)) return { ok: false, problem: `Enter a whole number from ${c.min} to ${c.max}.` };
      const n = Number(t);
      return n >= c.min && n <= c.max ? { ok: true, value: n } : { ok: false, problem: `Enter a whole number from ${c.min} to ${c.max}.` };
    }
    case "decimal": {
      const t = draft.text.trim();
      if (!DECIMAL.test(t)) return { ok: false, problem: `Enter an amount from ${c.min} to ${c.max}, with at most two decimals.` };
      const n = Number(t);
      return n >= c.min && n <= c.max ? { ok: true, value: n } : { ok: false, problem: `Enter an amount from ${c.min} to ${c.max}.` };
    }
    case "set": {
      const known = values(c.options);
      // vocabulary order, so the same set always reads (and audits) the same; unknown stored entries are kept
      return { ok: true, value: [...known.filter((v) => draft.set.includes(v)), ...draft.set.filter((v) => !known.includes(v))] };
    }
    case "modeMap": {
      const out: Record<string, number> = {};
      for (const mode of c.modes) {
        const t = (draft.map[mode.value] ?? "").trim();
        if (t === "") continue;
        if (!WHOLE.test(t) || Number(t) < c.min) return { ok: false, problem: `${mode.label}: enter a whole number of days (${c.min} or more), or leave it empty.` };
        out[mode.value] = Number(t);
      }
      return { ok: true, value: out };
    }
  }
}

/** compare by content (object keys sorted, so a map's order never reads as a change) */
export function sameValue(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)))
      : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/** will the gateway ask for a `settings_relax` step-up for this change? (registry semantics) */
export function needsStepUp(spec: OrgSettingSpec, value: unknown, stored: unknown): boolean {
  if (sameValue(value, stored)) return false;
  return spec.isRelaxed(value) || (spec.looser?.(value, stored) ?? false);
}

/** the value in words, for the badge line and the dialog */
export function describeValue(spec: OrgSettingSpec, value: unknown): string {
  const c = spec.control;
  if (value === undefined) return "not reported";
  switch (c.kind) {
    case "enum":
      return c.options.find((o) => o.value === value)?.label ?? String(value);
    case "boolean":
      return value ? c.on : c.off;
    case "int":
      return value === null ? (c.noneLabel ?? "none") : `${value} ${c.unit}`;
    case "decimal":
      return c.unit === "USD" ? `$${value}` : `${value} ${c.unit}`;
    case "set": {
      const list = value as string[];
      if (list.length === 0) return "none";
      return list.map((v) => c.options.find((o) => o.value === v)?.label ?? v).join("; ");
    }
    case "modeMap": {
      const entries = Object.entries(value as Record<string, number>);
      if (entries.length === 0) return "no overrides";
      return entries.map(([m, d]) => `${c.modes.find((x) => x.value === m)?.label ?? m}: ${d} days`).join("; ");
    }
  }
}
