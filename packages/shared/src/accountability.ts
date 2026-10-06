/**
 * ADR-0182 (ADR-0175 batch D4) — ACCOUNTABILITY RECORDS: the shared contract.
 *
 * Five slices build on this file, each in its own modules:
 *   A11 decision regression        `decision-regression.ts` (shared + gateway)
 *   A12 AI incident register       `incidents.ts`, `incident-clocks.ts` (shared), `incidents.ts` (gateway)
 *   A13 end-user feedback, appeal  `feedback.ts` (shared + gateway)
 *   A14 AI literacy, acceptable use `ai-literacy.ts` (shared + gateway)
 *   S5  alert owner/SLA/ticket, the suggested halt, the packs  `alert-ownership.ts` (shared + gateway)
 *
 * This file holds only what they share: the vocabularies (kept in lockstep
 * with the DB CHECKs of migration 0162, because `schema.ts` imports these very
 * constants), the org settings with their strict defaults and the copy that
 * says what relaxing each one gives up, the request bodies, and the types the
 * slices exchange. It decides nothing.
 *
 * SECURE BY DEFAULT (ADR-0180 §1, ADR-0181). Every setting below starts at its
 * strict value, migration 0162 wrote those values onto the existing org row as
 * for a first load, and an admin relaxes one only through the audited
 * `PUT /v1/org/settings`, whose audit row records `detail.transitions`.
 *
 * Does not import the package barrel (index.ts re-exports this file).
 */
import { z } from "zod";
import { canonicalJson, sha256Hex } from "./audit-chain.js";

// ---------------------------------------------------------------------------
// Org settings: the vocabularies, the strict defaults, the bounds
// ---------------------------------------------------------------------------

/** `decision_regression_gate`, `incident_gate_mode`, `literacy_gate_mode`:
 * `enforce` refuses (or holds); `warn` records the refusal-shaped fact and
 * allows; `off` skips the check and the response says it was skipped. */
export const ACCOUNTABILITY_GATE_MODES = ["off", "warn", "enforce"] as const;
export type AccountabilityGateMode = (typeof ACCOUNTABILITY_GATE_MODES)[number];

/** the regulatory regimes whose incident-notification clocks A12 encodes */
export const INCIDENT_CLOCK_REGIMES = ["eu-ai-act", "hipaa"] as const;
export type IncidentClockRegime = (typeof INCIDENT_CLOCK_REGIMES)[number];

/** `alert_ticket_mode`: `manual` files a PM work item only when a person asks;
 * `auto_high` files one for every new high-severity alert episode, which sends
 * alert data to a third-party PM tool without a person deciding each time. */
export const ALERT_TICKET_MODES = ["manual", "auto_high"] as const;
export type AlertTicketMode = (typeof ALERT_TICKET_MODES)[number];

/** governance alert severities an SLA is set for (the monitor's three) */
export const ALERT_SLA_SEVERITIES = ["high", "medium", "low"] as const;
export type AlertSlaSeverity = (typeof ALERT_SLA_SEVERITIES)[number];
export type AlertSlaHours = Record<AlertSlaSeverity, number>;

/** PF-14: hours from an alert episode's creation to its due time, per severity */
export const ALERT_SLA_DEFAULTS: Readonly<AlertSlaHours> = Object.freeze({ high: 24, medium: 72, low: 168 });

/** the bounds a relaxation stays inside (zod and the DB CHECKs hold the same numbers) */
export const ACCOUNTABILITY_SETTING_LIMITS = {
  decisionRegressionMaxAgeMinutes: { min: 1, max: 1440 },
  feedbackAckSlaHours: { min: 1, max: 168 },
  feedbackResolveSlaDays: { min: 1, max: 90 },
  feedbackRetentionDays: { min: 30, max: 2555 },
  literacyDefaultValidityDays: { min: 30, max: 730 },
  alertSlaHours: { min: 1, max: 720 },
} as const;

/** THE STRICT DEFAULTS. The column defaults of migration 0162 are these values;
 * a fresh org reads exactly this. */
export const ACCOUNTABILITY_STRICT_DEFAULTS = Object.freeze({
  decisionRegressionGate: "enforce" as AccountabilityGateMode,
  decisionRegressionMaxAgeMinutes: 60,
  incidentGateMode: "enforce" as AccountabilityGateMode,
  incidentEvidenceHold: true,
  incidentClockRegimes: ["eu-ai-act", "hipaa"] as IncidentClockRegime[],
  feedbackSignedLinksEnabled: false,
  feedbackAckSlaHours: 72,
  feedbackResolveSlaDays: 30,
  feedbackRetentionDays: 365,
  literacyGateMode: "enforce" as AccountabilityGateMode,
  literacyDefaultValidityDays: 365,
  alertSlaHours: { ...ALERT_SLA_DEFAULTS } as AlertSlaHours,
  alertTicketMode: "manual" as AlertTicketMode,
});
export type AccountabilitySettings = {
  -readonly [K in keyof typeof ACCOUNTABILITY_STRICT_DEFAULTS]: (typeof ACCOUNTABILITY_STRICT_DEFAULTS)[K];
};
export type AccountabilitySettingKey = keyof AccountabilitySettings;
export const ACCOUNTABILITY_SETTING_KEYS = Object.keys(ACCOUNTABILITY_STRICT_DEFAULTS) as AccountabilitySettingKey[];

/**
 * THE "RELAXED" COPY. What the strict default does, and what an admin gives
 * up by relaxing it, one sentence each. The settings screens and the audit
 * reason read this; the words "compliant" and "guaranteed" never appear.
 */
export const ACCOUNTABILITY_SETTING_COPY: Readonly<
  Record<AccountabilitySettingKey, { label: string; strict: string; relaxed: string }>
> = {
  decisionRegressionGate: {
    label: "Decision regression gate",
    strict:
      "Enforce: a change to the review policy, the required tests or an intake template is refused unless a " +
      "regression run of the same body, newer than the maximum age, was previewed, and any changed outcomes were " +
      "accepted with a reason.",
    relaxed:
      "Warn records the missing or stale preview and saves anyway; off skips the check and says so. Either way a " +
      "change can alter past decisions' outcomes without anyone having looked.",
  },
  decisionRegressionMaxAgeMinutes: {
    label: "Regression preview maximum age (minutes)",
    strict: "60 minutes: a preview older than an hour no longer admits the change it previewed.",
    relaxed: "A longer window (up to 1440) admits a preview taken before other changes landed.",
  },
  incidentGateMode: {
    label: "Incident deploy gate",
    strict:
      "Enforce: a high or critical incident, or a serious incident, on a use case holds that use case's deploy " +
      "gate until it is closed (resolved does not release it).",
    relaxed: "Warn reports the open incident without holding; off skips the check and the gate says so.",
  },
  incidentEvidenceHold: {
    label: "Incident evidence hold",
    strict:
      "On: while a serious incident under the EU AI Act has no authority notification sent, a configuration " +
      "change to a linked agent is refused unless an admin overrides it with a reason (Regulation (EU) 2024/1689, " +
      "Article 73(6)).",
    relaxed: "Off lets a linked agent be changed before the authority is told, which may affect the later evaluation of causes.",
  },
  incidentClockRegimes: {
    label: "Incident notification clocks",
    strict:
      "Both regimes: a serious incident starts the EU AI Act clocks and a PHI breach starts the HIPAA clocks. Each " +
      "clock is a reminder computed from the recorded awareness time, not legal advice.",
    relaxed: "Removing a regime stops its clocks from being created for new incidents; existing clocks are kept.",
  },
  feedbackSignedLinksEnabled: {
    label: "Public signed feedback links",
    strict: "Off: only signed-in users can report a problem or appeal a decision.",
    relaxed:
      "On lets a use-case owner or an admin mint a link (at most 30 days, limited uses) that people outside the " +
      "organisation can use without signing in.",
  },
  feedbackAckSlaHours: {
    label: "Feedback acknowledgement time (hours)",
    strict: "72 hours from receipt to acknowledgement; a breach alerts the owner and the admins.",
    relaxed: "A longer time (up to 168 hours) lets a report wait longer before anyone is alerted.",
  },
  feedbackResolveSlaDays: {
    label: "Feedback resolution time (days)",
    strict: "30 days from receipt to resolution; a breach alerts the owner and the admins.",
    relaxed: "A longer time (up to 90 days) lets a report or appeal stay open longer before anyone is alerted.",
  },
  feedbackRetentionDays: {
    label: "Feedback body retention (days)",
    strict: "365 days: the text and contact details are deleted after a year; the resolution record is kept.",
    relaxed: "A longer retention (up to 2555 days) keeps what people wrote, and how to reach them, for longer.",
  },
  literacyGateMode: {
    label: "AI literacy gate",
    strict:
      "Enforce: a person to whom a published AI policy or training applies, and who has not acknowledged its " +
      "current version, cannot make governed calls. With no applicable published document nothing changes.",
    relaxed: "Warn records the gap and allows the call; off skips the check.",
  },
  literacyDefaultValidityDays: {
    label: "Acknowledgement validity (days)",
    strict: "365 days: an acknowledgement expires after a year unless the document sets its own validity.",
    relaxed: "A longer validity (up to 730 days) asks people to re-acknowledge less often.",
  },
  alertSlaHours: {
    label: "Governance alert SLA (hours per severity)",
    strict: "24 hours for high, 72 for medium, 168 for low; a breached episode is escalated to the admins.",
    relaxed: "Longer times (each up to 720 hours) let an alert stay unhandled longer before it is escalated.",
  },
  alertTicketMode: {
    label: "Alert tickets",
    strict: "Manual: a work item is filed in the PM tool only when a person asks for one.",
    relaxed:
      "Automatic for high alerts files a work item in the chosen third-party PM tool for every new high episode, with the " +
      "alert's title in the work item description; people appear as 'a user (id …)'.",
  },
};

const sameJson = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/**
 * Is `value` a RELAXATION of the strict default for `key`? Used for the
 * "relaxed" badge and for the audit reason of the settings write. A value
 * that is stricter than the default (a shorter SLA, a shorter acknowledgement
 * validity) is not a relaxation.
 */
export function accountabilitySettingRelaxed<K extends AccountabilitySettingKey>(
  key: K,
  value: AccountabilitySettings[K],
): boolean {
  const strict = ACCOUNTABILITY_STRICT_DEFAULTS[key];
  switch (key) {
    case "decisionRegressionGate":
    case "incidentGateMode":
    case "literacyGateMode":
      return value !== "enforce";
    case "incidentEvidenceHold":
      return value === false;
    case "feedbackSignedLinksEnabled":
      return value === true;
    case "alertTicketMode":
      return value !== "manual";
    case "incidentClockRegimes":
      return (INCIDENT_CLOCK_REGIMES as readonly string[]).some((r) => !(value as string[]).includes(r));
    case "alertSlaHours": {
      const v = value as AlertSlaHours;
      return ALERT_SLA_SEVERITIES.some((s) => v[s] > ALERT_SLA_DEFAULTS[s]);
    }
    case "decisionRegressionMaxAgeMinutes":
    case "feedbackAckSlaHours":
    case "feedbackResolveSlaDays":
    case "feedbackRetentionDays":
    case "literacyDefaultValidityDays":
      return (value as number) > (strict as number);
    default:
      return !sameJson(value, strict);
  }
}

const L = ACCOUNTABILITY_SETTING_LIMITS;
const boundedInt = (b: { min: number; max: number }) => z.number().int().min(b.min).max(b.max);

/**
 * The D4 fields of `PUT /v1/org/settings` (spread into
 * `updateOrgSettingsSchema`). Every one is optional (a partial update), and the
 * route audits each change as `detail.transitions: {key: {from, to}}`.
 */
export const accountabilityOrgSettingsFields = {
  /** strict `enforce`; `warn` or `off` relaxes it (audited) */
  decisionRegressionGate: z.enum(ACCOUNTABILITY_GATE_MODES).optional(),
  /** strict 60; longer, up to 1440, relaxes it */
  decisionRegressionMaxAgeMinutes: boundedInt(L.decisionRegressionMaxAgeMinutes).optional(),
  /** strict `enforce`; `warn` or `off` relaxes it */
  incidentGateMode: z.enum(ACCOUNTABILITY_GATE_MODES).optional(),
  /** strict true (Art. 73(6)); false relaxes it */
  incidentEvidenceHold: z.boolean().optional(),
  /** strict both regimes; removing one relaxes it (no duplicates) */
  incidentClockRegimes: z
    .array(z.enum(INCIDENT_CLOCK_REGIMES))
    .max(INCIDENT_CLOCK_REGIMES.length)
    .refine((a) => new Set(a).size === a.length, "each regime at most once")
    .optional(),
  /** strict false; true relaxes it (public links, built and shipped off) */
  feedbackSignedLinksEnabled: z.boolean().optional(),
  /** strict 72; longer, up to 168, relaxes it */
  feedbackAckSlaHours: boundedInt(L.feedbackAckSlaHours).optional(),
  /** strict 30; longer, up to 90, relaxes it */
  feedbackResolveSlaDays: boundedInt(L.feedbackResolveSlaDays).optional(),
  /** strict 365; longer, up to 2555, relaxes it */
  feedbackRetentionDays: boundedInt(L.feedbackRetentionDays).optional(),
  /** strict `enforce`; `warn` or `off` relaxes it */
  literacyGateMode: z.enum(ACCOUNTABILITY_GATE_MODES).optional(),
  /** strict 365; longer, up to 730, relaxes it */
  literacyDefaultValidityDays: boundedInt(L.literacyDefaultValidityDays).optional(),
  /** strict {high 24, medium 72, low 168}; longer (each up to 720) relaxes it.
   * A full replacement: all three severities are named. */
  alertSlaHours: z
    .object({
      high: boundedInt(L.alertSlaHours),
      medium: boundedInt(L.alertSlaHours),
      low: boundedInt(L.alertSlaHours),
    })
    .strict()
    .optional(),
  /** strict `manual`; `auto_high` relaxes it, and needs alertTicketConnectionId */
  alertTicketMode: z.enum(ALERT_TICKET_MODES).optional(),
  /** S5 (migration 0167): the PM connection `auto_high` files on (null = none);
   * never chosen implicitly (`alertTicketSettingsProblem`) */
  alertTicketConnectionId: z.string().uuid().nullable().optional(),
} as const;

// ---------------------------------------------------------------------------
// Use cases: the EU AI Act role (owner decision 2)
// ---------------------------------------------------------------------------

/** `ai_use_cases.eu_ai_act_role`. `both` (the strict default) starts every
 * applicable clock; naming one role narrows them. */
export const EU_AI_ACT_ROLES = ["provider", "deployer", "both"] as const;
export type EuAiActRole = (typeof EU_AI_ACT_ROLES)[number];
export const DEFAULT_EU_AI_ACT_ROLE: EuAiActRole = "both";

/** `PUT /v1/use-cases/:useCaseId/eu-ai-act-role`. Moving away from `both`
 * narrows which clocks start, so it is an admin's relaxation and needs a
 * reason; returning to `both` is open to the owner too. */
export const setEuAiActRoleSchema = z
  .object({
    role: z.enum(EU_AI_ACT_ROLES),
    reason: z.string().trim().min(10).max(2000).optional(),
  })
  .strict();
export type SetEuAiActRoleInput = z.infer<typeof setEuAiActRoleSchema>;

// ---------------------------------------------------------------------------
// A11 — decision regression and decision records
// ---------------------------------------------------------------------------

/** the terminal sign-off decision a `use_case_decision_records` row records */
export const USE_CASE_DECISIONS = ["approved", "rejected", "needs_info"] as const;
export type UseCaseDecision = (typeof USE_CASE_DECISIONS)[number];
export const DECISION_REGRESSION_CASE_SOURCES = ["shipped", "override"] as const;
export const DECISION_REGRESSION_TRIGGERS = ["ci", "preview", "activation"] as const;
export const DECISION_REGRESSION_SUBJECTS = ["review_policy", "required_tests", "intake_template"] as const;
export type DecisionRegressionSubject = (typeof DECISION_REGRESSION_SUBJECTS)[number];
export type DecisionRegressionTrigger = (typeof DECISION_REGRESSION_TRIGGERS)[number];

/** what one golden case produces under a given configuration */
export interface DecisionOutcome {
  tier: string | null;
  reasons: string[];
  frameworks: string[];
  requiredRoles: string[];
  requiredTests: string[];
  suggestedControls: string[];
  approverRouting: string | null;
}
export type DecisionOutcomeField = keyof DecisionOutcome;

/** one case whose outcome differs from its expectation or baseline */
export interface RegressionCaseDiff {
  caseId: string;
  label: string;
  /** the fields that differ, in `DecisionOutcome` key order */
  changed: DecisionOutcomeField[];
  before: DecisionOutcome | null;
  after: DecisionOutcome;
}
export interface RegressionDiff {
  cases: number;
  changed: number;
  entries: RegressionCaseDiff[];
}

/** `POST /v1/governance/decision-regression/preview` */
export const decisionRegressionPreviewSchema = z
  .object({
    subject: z.enum(DECISION_REGRESSION_SUBJECTS),
    /** the body the activation would submit; its digest must match later */
    candidate: z.record(z.string(), z.unknown()),
  })
  .strict();
export type DecisionRegressionPreviewInput = z.infer<typeof decisionRegressionPreviewSchema>;

/** the fields an activation write carries to prove it was previewed */
export const decisionRegressionAcceptanceFields = {
  regressionRunId: z.string().uuid().optional(),
  acceptChangedOutcomes: z.boolean().optional(),
  acceptReason: z.string().trim().min(10).max(2000).optional(),
} as const;

/** `POST /v1/governance/decision-regression/cases` (a reviewer override becomes a case) */
export const createDecisionRegressionCaseSchema = z
  .object({
    fromUseCaseId: z.string().uuid().optional(),
    label: z.string().trim().min(1).max(200),
    answers: z.record(z.string(), z.unknown()).optional(),
    expected: z.record(z.string(), z.unknown()),
  })
  .strict()
  .refine((v) => v.fromUseCaseId !== undefined || v.answers !== undefined, {
    message: "name the use case to snapshot, or give the answers",
    path: ["answers"],
  });

/** the body a review policy version records (`governance_review_policy_versions.body`) */
export interface ReviewPolicyVersionBody {
  roles: unknown[];
  tiers: Record<string, unknown>;
  riskAcceptorUserIds: string[];
  requiredTests: Record<string, unknown>;
}

/**
 * The digest of a configuration body: SHA-256 (hex) of its ADR-0060 canonical
 * JSON. Migration 0162 computes the SAME value in SQL for the backfilled v1
 * policy (`regulait_canonical_json`); a test pins that the two agree.
 */
export function accountabilityDigest(body: unknown): string {
  return sha256Hex(canonicalJson(body));
}

// ---------------------------------------------------------------------------
// A12 — the AI incident register
// ---------------------------------------------------------------------------

export const INCIDENT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export const INCIDENT_STATUSES = ["open", "contained", "resolved", "closed"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const INCIDENT_DETECTION_SOURCES = [
  "monitor_alert",
  "trace_evaluation",
  "user_report",
  "red_team",
  "manual",
  "external",
] as const;
export type IncidentDetectionSource = (typeof INCIDENT_DETECTION_SOURCES)[number];
/** Art. 3(49)(a)–(d), Art. 73(3) "widespread infringement", and a HIPAA PHI breach */
export const SERIOUS_INCIDENT_CRITERIA = [
  "death",
  "health",
  "critical_infrastructure",
  "fundamental_rights",
  "property_environment",
  "widespread_infringement",
  "phi_breach",
] as const;
export type SeriousIncidentCriterion = (typeof SERIOUS_INCIDENT_CRITERIA)[number];
export const INCIDENT_EVENT_KINDS = ["note", "status", "containment", "notification", "link", "action"] as const;
export type IncidentEventKind = (typeof INCIDENT_EVENT_KINDS)[number];
export const INCIDENT_LINK_OBJECT_TYPES = [
  "agent",
  "model",
  "vendor",
  "risk",
  "condition",
  "eval_run",
  "redteam_run",
  "governance_alert",
  "feedback",
  "pm_link",
] as const;
export type IncidentLinkObjectType = (typeof INCIDENT_LINK_OBJECT_TYPES)[number];
export const INCIDENT_ACTION_STATUSES = ["open", "done", "cancelled"] as const;
export const INCIDENT_NOTIFICATION_STATUSES = [
  "pending",
  "sent_initial",
  "sent_complete",
  "not_required",
  "tolled",
] as const;
export type IncidentNotificationStatus = (typeof INCIDENT_NOTIFICATION_STATUSES)[number];
/** the notification states a clock may end in (closing needs every clock here) */
export const TERMINAL_NOTIFICATION_STATUSES = ["sent_complete", "not_required", "tolled"] as const;

/** when a clock falls due, counted from its start (A12 fills the catalogue) */
export type IncidentClockDue =
  /** `dueAt = start + days × 24 h` (the earliest reasonable reading of "N days") */
  | { kind: "days"; days: number }
  /** "immediately" with no number: `dueAt = start`, shown as having no numeric limit */
  | { kind: "immediately" }
  /** "contemporaneously with" another clock: due when that clock is due */
  | { kind: "with_clock"; clockId: string }
  /** N days after the end of the calendar year the clock started in */
  | { kind: "after_calendar_year"; days: number };

/** the facts a clock's applicability is decided from */
export interface IncidentClockFacts {
  incident: {
    serious: boolean;
    seriousCriteria: readonly SeriousIncidentCriterion[];
    phiIndividuals: number | null;
    severity: IncidentSeverity;
  };
  useCase: { tier: string | null; euAiActRole: EuAiActRole } | null;
}

/** one regulatory clock: where it comes from, verbatim, and when it is due */
export interface IncidentClockDefinition {
  regime: IncidentClockRegime;
  /** stable id, e.g. `art73-2-general` */
  id: string;
  /** e.g. "Regulation (EU) 2024/1689, Article 73(2)" */
  paragraph: string;
  /** the text the period is read from, verbatim */
  quote: string;
  sourceUrl: string;
  /** ISO date the text was retrieved */
  retrievedOn: string;
  /** which recorded time starts it */
  start: "aware_at" | "occurred_at";
  due: IncidentClockDue;
  /** Art. 73(5): an incomplete initial report may precede the complete one */
  allowsInitialReport: boolean;
  applies(facts: IncidentClockFacts): boolean;
}

const optionalDate = z.string().datetime({ offset: true }).optional();

/** `POST /v1/incidents` */
export const createIncidentSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().max(8000).default(""),
    severity: z.enum(INCIDENT_SEVERITIES),
    detectionSource: z.enum(INCIDENT_DETECTION_SOURCES),
    sourceRef: z.string().trim().min(1).max(500).optional(),
    occurredAt: optionalDate,
    /** when the organisation became aware; the clocks start here. Defaults to now. */
    awareAt: optionalDate,
    useCaseId: z.string().uuid().optional(),
    ownerUserId: z.string().uuid().optional(),
    serious: z.boolean().default(false),
    seriousCriteria: z.array(z.enum(SERIOUS_INCIDENT_CRITERIA)).max(SERIOUS_INCIDENT_CRITERIA.length).default([]),
    phiIndividuals: z.number().int().min(0).max(1_000_000_000).optional(),
    links: z
      .array(z.object({ objectType: z.enum(INCIDENT_LINK_OBJECT_TYPES), objectId: z.string().trim().min(1).max(200) }).strict())
      .max(50)
      .default([]),
  })
  .strict();
export type CreateIncidentInput = z.infer<typeof createIncidentSchema>;

/** `PATCH /v1/incidents/:incidentId` (closing has its own route) */
export const updateIncidentSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().max(8000).optional(),
    severity: z.enum(INCIDENT_SEVERITIES).optional(),
    status: z.enum(["open", "contained", "resolved"]).optional(),
    occurredAt: z.string().datetime({ offset: true }).nullable().optional(),
    ownerUserId: z.string().uuid().nullable().optional(),
    useCaseId: z.string().uuid().nullable().optional(),
    serious: z.boolean().optional(),
    seriousCriteria: z.array(z.enum(SERIOUS_INCIDENT_CRITERIA)).max(SERIOUS_INCIDENT_CRITERIA.length).optional(),
    phiIndividuals: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
    rootCause: z.string().trim().max(8000).optional(),
    lessonsLearned: z.string().trim().max(8000).optional(),
  })
  .strict();

/** `POST /v1/incidents/:incidentId/events` (a note on the timeline) */
export const incidentNoteSchema = z.object({ note: z.string().trim().min(1).max(8000) }).strict();

/** `POST /v1/incidents/:incidentId/links` */
export const incidentLinkSchema = z
  .object({ objectType: z.enum(INCIDENT_LINK_OBJECT_TYPES), objectId: z.string().trim().min(1).max(200) })
  .strict();

/** `POST /v1/incidents/:incidentId/actions` */
export const createIncidentActionSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    ownerUserId: z.string().uuid().optional(),
    dueAt: optionalDate,
  })
  .strict();

/** `PATCH /v1/incidents/:incidentId/actions/:actionId` */
export const updateIncidentActionSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    ownerUserId: z.string().uuid().nullable().optional(),
    dueAt: z.string().datetime({ offset: true }).nullable().optional(),
    status: z.enum(INCIDENT_ACTION_STATUSES).optional(),
    evidenceRef: z.string().trim().min(1).max(1000).optional(),
    /** required (by the route) when the status moves to `cancelled`; audited and kept on the timeline */
    reason: z.string().trim().min(10).max(2000).optional(),
  })
  .strict();

/** `POST …/notifications/:notificationId/sent` */
export const incidentNotificationSentSchema = z
  .object({
    /** `initial` only where the clock allows an incomplete first report (Art. 73(5)) */
    stage: z.enum(["initial", "complete"]),
    recipient: z.string().trim().min(1).max(500),
    reference: z.string().trim().min(1).max(500).optional(),
    /** within [the clock's start, now]; more than an hour back it is BACKDATED and needs `reason` (D4G-06) */
    sentAt: optionalDate,
    /** why a backdated report is recorded late (required then; audited and kept on the timeline) */
    reason: z.string().trim().min(10).max(2000).optional(),
  })
  .strict();

/** `POST …/notifications/:notificationId/not-required` and `…/toll` (admin, reason required) */
export const incidentNotificationReasonSchema = z
  .object({ reason: z.string().trim().min(10).max(2000) })
  .strict();

/** `POST /v1/incidents/:incidentId/close`: both texts are required (and a DB CHECK holds it) */
export const closeIncidentSchema = z
  .object({
    rootCause: z.string().trim().min(1).max(8000),
    lessonsLearned: z.string().trim().min(1).max(8000),
  })
  .strict();

/** `POST /v1/incidents/:incidentId/contain` (admin): halts a linked agent */
export const containIncidentSchema = z
  .object({
    agentId: z.string().uuid(),
    reason: z.string().trim().min(10).max(2000),
  })
  .strict();

// ---------------------------------------------------------------------------
// A13 — end-user feedback and appeal
// ---------------------------------------------------------------------------

export const FEEDBACK_KINDS = ["problem", "appeal"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const FEEDBACK_CHANNELS = ["in_app", "signed_link"] as const;
export const FEEDBACK_STATUSES = [
  "received",
  "acknowledged",
  "in_review",
  "upheld",
  "overturned",
  "no_change",
  "rejected",
] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];
/** an appeal's outcomes; a problem report cannot end in them (DB CHECK) */
export const APPEAL_OUTCOMES = ["upheld", "overturned"] as const;
export const RESOLVED_FEEDBACK_STATUSES = ["upheld", "overturned", "no_change", "rejected"] as const;
/** the most characters a feedback body may carry, on every channel */
export const FEEDBACK_BODY_MAX_CHARS = 4000;
/** a signed link lives at most this long (and a DB CHECK holds it) */
export const FEEDBACK_LINK_MAX_DAYS = 30;

/** `POST /v1/use-cases/:useCaseId/feedback` (signed in) */
export const submitFeedbackSchema = z
  .object({
    kind: z.enum(FEEDBACK_KINDS),
    body: z.string().trim().min(1).max(FEEDBACK_BODY_MAX_CHARS),
    contact: z.string().trim().min(1).max(500).optional(),
    traceId: z.string().uuid().optional(),
    spanId: z.string().uuid().optional(),
  })
  .strict()
  .refine((v) => v.spanId === undefined || v.traceId !== undefined, {
    message: "a span is cited with its trace",
    path: ["traceId"],
  });

/** `POST /v1/feedback/l/:token` (public): no trace citation from outside */
export const publicFeedbackSchema = z
  .object({
    kind: z.enum(FEEDBACK_KINDS),
    body: z.string().trim().min(1).max(FEEDBACK_BODY_MAX_CHARS),
    contact: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/** `PATCH /v1/feedback/:feedbackId` */
export const updateFeedbackSchema = z
  .object({
    status: z.enum(FEEDBACK_STATUSES).optional(),
    ownerUserId: z.string().uuid().optional(),
    resolutionNote: z.string().trim().min(1).max(4000).optional(),
  })
  .strict();

/** `POST /v1/use-cases/:useCaseId/feedback-links` */
export const createFeedbackLinkSchema = z
  .object({
    expiresInDays: z.number().int().min(1).max(FEEDBACK_LINK_MAX_DAYS),
    maxUses: z.number().int().min(1).max(10_000),
  })
  .strict();

/** `POST /v1/feedback/:feedbackId/open-incident` */
export const openIncidentFromFeedbackSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    severity: z.enum(INCIDENT_SEVERITIES),
  })
  .strict();

// ---------------------------------------------------------------------------
// A14 — AI literacy and acceptable-use acknowledgements
// ---------------------------------------------------------------------------

export const AI_POLICY_KINDS = ["acceptable_use", "training"] as const;
export type AiPolicyKind = (typeof AI_POLICY_KINDS)[number];
export const AI_POLICY_STATUSES = ["draft", "published", "retired"] as const;
export type AiPolicyStatus = (typeof AI_POLICY_STATUSES)[number];
export const AI_POLICY_ACK_METHODS = ["acknowledged", "training_completed", "admin_recorded"] as const;
export type AiPolicyAckMethod = (typeof AI_POLICY_ACK_METHODS)[number];

/** who a document applies to. `all` (the default, and the strictest) = everyone */
export interface AiPolicyAudience {
  all: boolean;
  teamIds: string[];
  roleIds: string[];
}
export const aiPolicyAudienceSchema = z
  .object({
    all: z.boolean(),
    teamIds: z.array(z.string().uuid()).max(200).default([]),
    roleIds: z.array(z.string().uuid()).max(200).default([]),
  })
  .strict()
  .refine((a) => a.all || a.teamIds.length + a.roleIds.length > 0, {
    message: "name at least one team or role, or apply it to everyone",
  });

/** `POST /v1/ai-policies` (admin): a new draft, or the next version of `key` */
export const createAiPolicySchema = z
  .object({
    key: z.string().trim().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/, "lower-case letters, digits and dashes"),
    kind: z.enum(AI_POLICY_KINDS),
    title: z.string().trim().min(1).max(200),
    url: z.string().trim().url().max(2048).optional(),
    attachmentId: z.string().uuid().optional(),
    audience: aiPolicyAudienceSchema.default({ all: true, teamIds: [], roleIds: [] }),
    /** null = the org's `literacy_default_validity_days` */
    validityDays: z.number().int().min(L.literacyDefaultValidityDays.min).max(L.literacyDefaultValidityDays.max).optional(),
  })
  .strict()
  .refine((v) => v.url !== undefined || v.attachmentId !== undefined, {
    message: "a document is a link or an attachment",
    path: ["url"],
  });

/** `POST /v1/ai-policies/:policyId/publish` (admin). An editorial version keeps
 * existing acknowledgements, and needs a reason (audited, transition recorded). */
export const publishAiPolicySchema = z
  .object({
    editorial: z.boolean().default(false),
    editorialReason: z.string().trim().min(10).max(2000).optional(),
  })
  .strict()
  .refine((v) => !v.editorial || v.editorialReason !== undefined, {
    message: "an editorial change states why it does not need re-acknowledgement",
    path: ["editorialReason"],
  });

/** `POST /v1/ai-policies/:policyId/acknowledge` (self only): the version and
 * digest the person saw, so an acknowledgement is of exactly that text */
export const acknowledgeAiPolicySchema = z
  .object({
    version: z.number().int().min(1),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/** `POST /v1/ai-policies/:policyId/records` (admin): completion recorded from
 * an external training system, with its evidence reference */
export const recordAiPolicyCompletionSchema = z
  .object({
    userId: z.string().uuid(),
    method: z.enum(["training_completed", "admin_recorded"]),
    evidenceRef: z.string().trim().min(1).max(1000),
    completedAt: optionalDate,
  })
  .strict();

/** one applicable document, as `GET /v1/me/ai-literacy` reports it */
export interface LiteracyDocumentStatus {
  documentId: string;
  key: string;
  version: number;
  kind: AiPolicyKind;
  title: string;
  state: "current" | "missing" | "expired" | "superseded";
  acknowledgedAt: string | null;
  expiresAt: string | null;
}
/** a person's literacy status: `required` = at least one published document
 * applies to them; `current` = every one is acknowledged at its current
 * version and unexpired (vacuously true when none applies) */
export interface LiteracyStatus {
  required: boolean;
  current: boolean;
  documents: LiteracyDocumentStatus[];
}

// ---------------------------------------------------------------------------
// S5 — PF-14 alert owner/SLA/ticket and PF-03 the suggested halt
// ---------------------------------------------------------------------------

/** `kris.on_breach`. `propose_halt` (agent-scoped KRIs only, DB CHECK) makes a
 * breach episode carry a suggested halt that a PERSON may file as a proposal.
 * Owner decision 4: nothing is filed automatically and nothing trips. */
export const KRI_ON_BREACH = ["alert", "propose_halt"] as const;
export type KriOnBreach = (typeof KRI_ON_BREACH)[number];

/** `governance_alerts.owner_source` */
export const ALERT_OWNER_SOURCES = ["derived", "assigned"] as const;
export type AlertOwnerSource = (typeof ALERT_OWNER_SOURCES)[number];

/** the suggestion a `propose_halt` KRI breach carries on its episode */
export interface SuggestedHaltAction {
  kind: "halt_agent";
  agentId: string;
}

/** `PUT /v1/governance/alerts/:alertId/owner` (admin or the current owner) */
export const setAlertOwnerSchema = z.object({ userId: z.string().uuid() }).strict();

/** `POST /v1/governance/alerts/:alertId/ticket` (admin) */
export const createAlertTicketSchema = z.object({ connectionId: z.string().uuid() }).strict();
