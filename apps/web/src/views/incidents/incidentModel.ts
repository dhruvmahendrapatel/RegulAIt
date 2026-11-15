/**
 * ADR-0182 (ADR-0175 batch D4) A12 — the AI incident register: the web's
 * types, labels and the copy for the three incident settings.
 *
 * The labels mirror `@regulait/shared` (`SERIOUS_INCIDENT_CRITERIA`,
 * `INCIDENT_DETECTION_SOURCES`, `ACCOUNTABILITY_SETTING_COPY`); the server
 * refuses any value outside them, so drift fails loudly.
 */
import type { Tone } from "../../ui/kit";

export type IncidentSeverity = "low" | "medium" | "high" | "critical";
export type IncidentStatus = "open" | "contained" | "resolved" | "closed";
export type ClockUrgency = "done" | "overdue" | "due_soon" | "pending";
export type NotificationStatus = "pending" | "sent_initial" | "sent_complete" | "not_required" | "tolled";
export type GateMode = "enforce" | "warn" | "off";

export interface IncidentListRow {
  id: string;
  ref: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  serious: boolean;
  seriousCriteria: string[];
  detectionSource: string;
  awareAt: string;
  ownerUserId: string | null;
  ownerName: string | null;
  useCaseId: string | null;
  useCaseName: string | null;
  createdAt: string;
  closedAt: string | null;
  clocks: {
    total: number;
    open: number;
    overdue: number;
    nextDue: { clockId: string; paragraph: string; dueAt: string; urgency: ClockUrgency } | null;
  };
  actions: { open: number; overdue: number };
}
export interface IncidentListResponse {
  incidents: IncidentListRow[];
  scope: "all" | "visible" | "none";
  disclaimer: string;
}

export interface IncidentClock {
  id: string;
  regime: IncidentClockRegimeId;
  clockId: string;
  paragraph: string;
  quote: string | null;
  sourceUrl: string | null;
  retrievedOn: string | null;
  period: string | null;
  immediately: boolean;
  allowsInitialReport: boolean;
  caveat: string | null;
  recipient: string | null;
  clockStart: string;
  dueAt: string;
  status: NotificationStatus;
  urgency: ClockUrgency;
  sentAt: string | null;
  sentByName: string | null;
  reference: string | null;
  reason: string | null;
}

export interface IncidentDetail {
  incident: {
    id: string;
    ref: string;
    title: string;
    summary: string;
    severity: IncidentSeverity;
    status: IncidentStatus;
    detectionSource: string;
    sourceRef: string | null;
    occurredAt: string | null;
    awareAt: string;
    ownerUserId: string | null;
    ownerName: string | null;
    useCaseId: string | null;
    serious: boolean;
    seriousCriteria: string[];
    phiIndividuals: number | null;
    rootCause: string | null;
    lessonsLearned: string | null;
    closedAt: string | null;
    closedByName: string | null;
    createdByName: string | null;
    createdAt: string;
  };
  useCase: { id: string; name: string; euAiActTier: string | null; euAiActRole: string } | null;
  links: Array<{ objectType: string; objectId: string; label: string | null; agentKind: "registry" | "builder" | null; halted: boolean | null; createdAt: string }>;
  actions: Array<{ id: string; title: string; ownerUserId: string | null; ownerName: string | null; dueAt: string | null; status: "open" | "done" | "cancelled"; overdue: boolean; doneAt: string | null; evidenceRef: string | null }>;
  notifications: IncidentClock[];
  events: Array<{ id: string; kind: string; at: string; actorName: string | null; note: string | null; detail: Record<string, unknown> }>;
  evidenceHold: { setting: boolean; binds: boolean; paragraph: string; quote: string };
  gate: { mode: GateMode; holds: "open_serious_incident" | "open_high_incident" | null };
  /** canClose: closing a serious, high or critical incident is an admin's (closeNeedsAdmin) */
  permissions: { canEdit: boolean; canClose: boolean; closeNeedsAdmin: boolean; isAdmin: boolean };
  disclaimer: string;
}

export const SEVERITIES: IncidentSeverity[] = ["critical", "high", "medium", "low"];

/** Art. 3(49)(a)–(d), Art. 73(3) and HIPAA, in plain words */
export const CRITERIA: Array<{ id: string; label: string; cite: string }> = [
  { id: "death", label: "Death of a person", cite: "Art. 3(49)(a)" },
  { id: "health", label: "Serious harm to a person's health", cite: "Art. 3(49)(a)" },
  { id: "critical_infrastructure", label: "Serious, irreversible disruption of critical infrastructure", cite: "Art. 3(49)(b)" },
  { id: "fundamental_rights", label: "Infringement of obligations protecting fundamental rights", cite: "Art. 3(49)(c)" },
  { id: "property_environment", label: "Serious harm to property or the environment", cite: "Art. 3(49)(d)" },
  { id: "widespread_infringement", label: "Widespread infringement", cite: "Art. 73(3)" },
  { id: "phi_breach", label: "Breach of unsecured protected health information", cite: "45 CFR 164.402" },
  // ADR-0296: the facts that start the GDPR, NIS2, DORA and CRA clocks (none is serious under the EU AI Act)
  { id: "personal_data_breach", label: "Personal data breach", cite: "GDPR Art. 4(12)" },
  { id: "significant_cyber_incident", label: "Significant incident (NIS2)", cite: "NIS2 Art. 23(3)" },
  { id: "major_ict_incident", label: "Major ICT-related incident (DORA)", cite: "DORA Art. 18" },
  { id: "exploited_vulnerability", label: "Actively exploited vulnerability in a product", cite: "CRA Art. 14(1)" },
  { id: "severe_product_incident", label: "Severe incident affecting a product's security", cite: "CRA Art. 14(3)" },
];
export const CRITERION_LABEL: Record<string, string> = Object.fromEntries(CRITERIA.map((c) => [c.id, c.label]));
/** the criteria that make an incident serious under the EU AI Act: Art. 3(49) and Art. 73(3) only */
export const EU_CRITERIA = CRITERIA.filter((c) => c.cite.startsWith("Art. ")).map((c) => c.id);

export const DETECTION_SOURCES: Array<{ id: string; label: string }> = [
  { id: "manual", label: "Reported by a person" },
  { id: "monitor_alert", label: "A governance monitor alert" },
  { id: "trace_evaluation", label: "A trace evaluation" },
  { id: "user_report", label: "An end-user report or appeal" },
  { id: "red_team", label: "A red-team run" },
  { id: "external", label: "An outside party" },
];
export const DETECTION_LABEL: Record<string, string> = Object.fromEntries(DETECTION_SOURCES.map((d) => [d.id, d.label]));

export const LINK_TYPES: Array<{ id: string; label: string }> = [
  { id: "agent", label: "Agent" },
  { id: "model", label: "Model" },
  { id: "vendor", label: "Vendor" },
  { id: "risk", label: "Risk" },
  { id: "condition", label: "Approval condition" },
  { id: "eval_run", label: "Eval run" },
  { id: "redteam_run", label: "Red-team run" },
  { id: "governance_alert", label: "Monitor alert" },
  { id: "feedback", label: "Feedback item" },
  { id: "pm_link", label: "PM work item" },
];
export const LINK_LABEL: Record<string, string> = Object.fromEntries(LINK_TYPES.map((l) => [l.id, l.label]));

export const STATUS_TONE: Record<IncidentStatus, Tone> = { open: "danger", contained: "warn", resolved: "info", closed: "ok" };
export const NOTIFICATION_LABEL: Record<NotificationStatus, string> = {
  pending: "Not sent",
  sent_initial: "Initial report sent",
  sent_complete: "Sent",
  not_required: "Not required",
  tolled: "Tolled",
};
export const NOTIFICATION_TONE: Record<NotificationStatus, Tone> = {
  pending: "warn",
  sent_initial: "info",
  sent_complete: "ok",
  not_required: "neutral",
  tolled: "neutral",
};
export const URGENCY_LABEL: Record<ClockUrgency, string> = { done: "final", overdue: "overdue", due_soon: "due within 24 h", pending: "running" };
export const URGENCY_TONE: Record<ClockUrgency, Tone> = { done: "ok", overdue: "danger", due_soon: "warn", pending: "neutral" };

export const CLOCK_DISCLAIMER =
  "Each clock is a reminder computed from the recorded awareness time and the cited text. It is not legal advice.";
export const EU_CAVEAT = "Statutory applicability depends on your role and the system's classification date — confirm with counsel.";

/** the three settings this page administers, with their strict default and what relaxing gives up
 * (mirrors ACCOUNTABILITY_SETTING_COPY in @regulait/shared) */
export const INCIDENT_SETTING_COPY = {
  incidentGateMode: {
    label: "Incident deploy gate",
    strict:
      "Enforce: a high or critical incident, or a serious incident, on a use case holds that use case's deploy gate until it is closed (resolved does not release it).",
    relaxed: "Warn reports the open incident without holding; off skips the check and the gate says so.",
  },
  incidentEvidenceHold: {
    label: "Incident evidence hold",
    strict:
      "On: while a serious incident under the EU AI Act has no authority notification sent, a configuration change to a linked agent is refused unless an admin overrides it with a reason (Regulation (EU) 2024/1689, Article 73(6)).",
    relaxed: "Off lets a linked agent be changed before the authority is told, which may affect the later evaluation of causes.",
  },
  incidentClockRegimes: {
    label: "Incident notification clocks",
    strict:
      "Every regime: a serious incident starts the EU AI Act clocks, a PHI breach the HIPAA clocks, a personal data breach the GDPR clocks, a significant incident the NIS2 clocks, a major ICT incident the DORA clocks, and an exploited vulnerability or severe product incident the CRA clocks. Each clock is a reminder computed from the recorded awareness time, not legal advice.",
    relaxed: "Removing a regime stops its clocks from being created for new incidents; existing clocks are kept.",
  },
} as const;
/** mirrors `INCIDENT_CLOCK_REGIMES` in @regulait/shared (ADR-0296 added the last four) */
export type IncidentClockRegimeId = "eu-ai-act" | "hipaa" | "gdpr" | "nis2" | "dora" | "cra";
export const REGIMES: Array<{ id: IncidentClockRegimeId; label: string }> = [
  { id: "eu-ai-act", label: "EU AI Act (Regulation (EU) 2024/1689)" },
  { id: "hipaa", label: "HIPAA breach notification (45 CFR 164.404–164.410)" },
  { id: "gdpr", label: "GDPR breach notification (Regulation (EU) 2016/679, Art. 33–34)" },
  { id: "nis2", label: "NIS2 incident reporting (Directive (EU) 2022/2555, Art. 23)" },
  { id: "dora", label: "DORA major ICT incident reporting (Regulation (EU) 2022/2554, Art. 19)" },
  { id: "cra", label: "Cyber Resilience Act reporting (Regulation (EU) 2024/2847, Art. 14)" },
];

/** a timestamp the way the register shows it: UTC, to the minute */
export function utc(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** `<input type="datetime-local">` value (local time) -> ISO, or undefined when empty */
export function localInputToIso(v: string): string | undefined {
  if (!v.trim()) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Is a report's sentAt backdated (more than an hour before now)? The server
 * then requires a reason (D4 review D4G-06); the form asks for one up front.
 */
export function sentAtBackdated(iso: string | undefined, now = new Date()): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && now.getTime() - t > SENT_AT_BACKDATE_MS;
}
/** mirrors `INCIDENT_SENT_AT_BACKDATE_MS` in @regulait/shared (one hour) */
const SENT_AT_BACKDATE_MS = 60 * 60 * 1000;

/** now, as a `<input type="datetime-local">` value */
export function nowLocalInput(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** does a set of criteria make the incident serious under the EU AI Act? (the server derives the same) */
export function impliesSerious(criteria: readonly string[]): boolean {
  return criteria.some((c) => EU_CRITERIA.includes(c));
}

/** one timeline event in a sentence (no free text beyond the event's own note) */
export function eventSentence(e: { kind: string; detail: Record<string, unknown> }): string {
  const d = e.detail ?? {};
  switch (e.kind) {
    case "status":
      return d.from ? `Status ${String(d.from)} → ${String(d.to)}` : `Opened (${String(d.severity ?? "")}${d.serious ? ", serious" : ""})`;
    case "notification":
      if (d.started) return `Clock started: ${String(d.paragraph ?? d.clockId)} — due ${utc(String(d.dueAt))}`;
      if (d.flag) return `Clock ${String(d.clockId)} ${d.flag === "overdue" ? "is overdue" : "falls due within 24 hours"}`;
      return (
        `Clock ${String(d.clockId)}: ${String(d.from ?? "").replace(/_/g, " ")} → ${String(d.to ?? "").replace(/_/g, " ")}` +
        (d.backdated ? ` (recorded late: sent ${utc(String(d.sentAt))}, recorded ${utc(String(d.recordedAt))})` : "")
      );
    case "link":
      return `Linked ${LINK_LABEL[String(d.objectType)] ?? String(d.objectType)} ${String(d.objectId)}${d.byContainment ? " (by containment)" : ""}`;
    case "containment":
      return `Contained: agent ${String(d.agentId)} halted${d.changed === false ? " (it was already halted)" : ""}`;
    case "action":
      return d.created ? "Corrective action added" : d.cancelled ? "Corrective action cancelled" : "Corrective action updated";
    case "note":
      if (d.evidenceHoldOverride) return "Evidence hold overridden by an admin";
      if (Array.isArray(d.changed)) return `Changed: ${(d.changed as string[]).join(", ")}`;
      return "Note";
    default:
      return e.kind;
  }
}

/** the settings this page reads from GET /v1/org/settings */
export interface IncidentSettings {
  incidentGateMode: GateMode;
  incidentEvidenceHold: boolean;
  incidentClockRegimes: IncidentClockRegimeId[];
}
export function settingRelaxed(key: keyof IncidentSettings, value: IncidentSettings[keyof IncidentSettings]): boolean {
  if (key === "incidentGateMode") return value !== "enforce";
  if (key === "incidentEvidenceHold") return value === false;
  return !REGIMES.every((r) => (value as string[]).includes(r.id));
}
