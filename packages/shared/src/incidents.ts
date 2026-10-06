/**
 * ADR-0182 (ADR-0175 batch D4) A12 — THE AI INCIDENT REGISTER: the pure half.
 *
 * The decisions the gateway and the web both need, with no I/O:
 *  - which notification-state moves are allowed (Art. 73(5): an incomplete
 *    initial report may precede the complete one; a clock set aside or
 *    completed never moves again, and is never deleted);
 *  - what still stands in the way of closing an incident;
 *  - whether Art. 73(6)'s evidence hold binds an incident;
 *  - whether an incident holds its use case's deploy gate;
 *  - how urgent a clock is.
 *
 * Sources: EU AI Act Art. 3(49), 26(5), 73; HIPAA 45 CFR 164.404–164.412
 * (quoted in `incident-clocks.ts`); NIST AI RMF GOVERN 4.3, MANAGE 2.3, 4.1, 4.3.
 */
import {
  TERMINAL_NOTIFICATION_STATUSES,
  type IncidentNotificationStatus,
  type IncidentSeverity,
  type IncidentStatus,
  type SeriousIncidentCriterion,
} from "./accountability.js";
import { EU_AUTHORITY_CLOCK_IDS, EU_SERIOUS_CRITERIA, incidentClockById } from "./incident-clocks.js";

/** the notification states a clock can still move from */
export const OPEN_NOTIFICATION_STATUSES: readonly IncidentNotificationStatus[] = ["pending", "sent_initial"];

export function isTerminalNotificationStatus(s: string): boolean {
  return (TERMINAL_NOTIFICATION_STATUSES as readonly string[]).includes(s);
}

export type IncidentNotificationMove =
  | { kind: "sent"; stage: "initial" | "complete" }
  | { kind: "not_required" }
  | { kind: "toll" };

/**
 * The state a clock moves to, or why it cannot. A terminal clock never moves
 * (set aside, tolled or completed is final; a correction is a new note on the
 * timeline, not a rewrite). `initial` is only for a clock whose text allows
 * an incomplete first report (Art. 73(5)), and only before any report.
 */
export function nextNotificationStatus(
  current: IncidentNotificationStatus,
  move: IncidentNotificationMove,
  clockId: string,
): { ok: true; status: IncidentNotificationStatus } | { ok: false; code: string; detail: string } {
  if (isTerminalNotificationStatus(current)) {
    return {
      ok: false,
      code: "notification_final",
      detail: `this clock is already ${current.replace(/_/g, " ")}; a final clock is never changed or deleted`,
    };
  }
  if (move.kind === "not_required") return { ok: true, status: "not_required" };
  if (move.kind === "toll") return { ok: true, status: "tolled" };
  if (move.stage === "complete") return { ok: true, status: "sent_complete" };
  const def = incidentClockById(clockId);
  if (!def?.allowsInitialReport) {
    return {
      ok: false,
      code: "initial_report_not_allowed",
      detail: "the text behind this clock does not provide for an incomplete initial report; record the complete one",
    };
  }
  if (current !== "pending") {
    return { ok: false, code: "initial_report_already_sent", detail: "the initial report is already recorded; record the complete one" };
  }
  return { ok: true, status: "sent_initial" };
}

export interface IncidentCloseFacts {
  status: IncidentStatus;
  rootCause: string | null | undefined;
  lessonsLearned: string | null | undefined;
  notifications: ReadonlyArray<{ id: string; clockId: string; status: string }>;
  /** corrective actions: closing needs each `done` or `cancelled` (main-session decision 2026-10-06) */
  actions?: ReadonlyArray<{ id: string; status: string }>;
}

/** what stands in the way of closing: missing texts, every clock not in a terminal state, every open action */
export function incidentCloseBlockers(f: IncidentCloseFacts): {
  missing: Array<"rootCause" | "lessonsLearned">;
  openClocks: string[];
  openActions: string[];
} {
  const missing: Array<"rootCause" | "lessonsLearned"> = [];
  if (!f.rootCause || f.rootCause.trim() === "") missing.push("rootCause");
  if (!f.lessonsLearned || f.lessonsLearned.trim() === "") missing.push("lessonsLearned");
  return {
    missing,
    openClocks: f.notifications.filter((n) => !isTerminalNotificationStatus(n.status)).map((n) => n.clockId),
    openActions: (f.actions ?? []).filter((a) => a.status !== "done" && a.status !== "cancelled").map((a) => a.id),
  };
}

/** an Art. 3(49) / Art. 73(3) criterion is listed (anything but `phi_breach`) */
export function hasEuSeriousCriterion(criteria: readonly SeriousIncidentCriterion[]): boolean {
  return criteria.some((c) => EU_SERIOUS_CRITERIA.includes(c));
}

/**
 * Art. 73(6): until the competent authority is informed, the system must not
 * be altered in a way that may affect the later evaluation of causes. The hold
 * binds an incident that is not closed while one of its Article 73 authority
 * clocks is still `pending` or `tolled` (tolled = the report is delayed, so
 * the authority is not yet informed). It lifts when a report is sent (initial
 * or complete) or an admin records, with a reason, that none is required.
 */
export function evidenceHoldBinds(
  incident: { status: IncidentStatus; serious: boolean },
  notifications: ReadonlyArray<{ clockId: string; status: string }>,
): boolean {
  if (incident.status === "closed" || !incident.serious) return false;
  const authority = notifications.filter((n) => EU_AUTHORITY_CLOCK_IDS.includes(n.clockId));
  if (authority.length === 0) return false;
  return !authority.some((n) => n.status === "sent_initial" || n.status === "sent_complete") &&
    authority.some((n) => n.status === "pending" || n.status === "tolled");
}

/**
 * The statuses in which an incident still holds its use case's deploy gate:
 * every status but `closed` (D4 review D4A-01 / D4G-01). `resolved` is a
 * working state the owner may set; it releases nothing, because only closing
 * checks the root cause, the lessons learned, the clocks and the actions.
 */
export const INCIDENT_GATE_HOLDING_STATUSES: readonly IncidentStatus[] = ["open", "contained", "resolved"];

/**
 * Does this incident hold its use case's deploy gate (under `incident_gate_mode`)?
 * An incident that is not closed and is serious, or high or critical.
 * Only `closed` releases it.
 */
export function incidentHoldsGate(i: { status: IncidentStatus; severity: IncidentSeverity; serious: boolean }):
  | "open_serious_incident"
  | "open_high_incident"
  | null {
  if (!INCIDENT_GATE_HOLDING_STATUSES.includes(i.status)) return null;
  if (i.serious) return "open_serious_incident";
  if (i.severity === "high" || i.severity === "critical") return "open_high_incident";
  return null;
}

export type IncidentClockUrgency = "done" | "overdue" | "due_soon" | "pending";
/** the window before the due time in which a clock counts as due soon (and the monitor raises) */
export const INCIDENT_CLOCK_DUE_SOON_MS = 24 * 60 * 60 * 1000;

export function incidentClockUrgency(n: { status: string; dueAt: Date | string }, now: Date): IncidentClockUrgency {
  if (isTerminalNotificationStatus(n.status)) return "done";
  const due = new Date(n.dueAt).getTime();
  if (due <= now.getTime()) return "overdue";
  if (due - now.getTime() <= INCIDENT_CLOCK_DUE_SOON_MS) return "due_soon";
  return "pending";
}

/**
 * Closing this incident is an admin's (D4 review D4A-01 / D4G-01): a serious
 * incident, or a high or critical one — exactly the incidents that can hold
 * the deploy gate, whatever the gate's mode. The owner may close a low or
 * medium incident that is not serious. The close conditions (root cause,
 * lessons learned, final clocks, finished actions) apply to everyone.
 */
export function incidentCloseNeedsAdmin(i: { severity: IncidentSeverity; serious: boolean }): boolean {
  return i.serious || severityRank(i.severity) >= severityRank("high");
}

/**
 * A notification recorded as sent more than this long before the moment it
 * is recorded counts as BACKDATED (D4 review D4G-06): it needs a reason, and
 * the audit row and the timeline say so.
 */
export const INCIDENT_SENT_AT_BACKDATE_MS = 60 * 60 * 1000;

/**
 * Is this `sentAt` acceptable for this clock (D4 review D4G-06)? It must lie
 * within [clock start, now] (one minute of clock skew is tolerated in the
 * future), and a backdated one needs a reason.
 */
export function incidentSentAtVerdict(
  sentAt: Date,
  clockStart: Date,
  now: Date,
  reason: string | null | undefined,
):
  | { ok: true; backdated: boolean }
  | { ok: false; code: "time_in_future" | "sent_before_clock_start" | "backdated_sent_at_reason_required"; detail: string } {
  if (sentAt.getTime() > now.getTime() + 60_000) {
    return { ok: false, code: "time_in_future", detail: "sentAt is in the future; record when the report was actually sent" };
  }
  if (sentAt.getTime() < clockStart.getTime()) {
    return {
      ok: false,
      code: "sent_before_clock_start",
      detail: `a report cannot have been sent before its clock started (${clockStart.toISOString()})`,
    };
  }
  const backdated = now.getTime() - sentAt.getTime() > INCIDENT_SENT_AT_BACKDATE_MS;
  if (backdated && (!reason || reason.trim().length < 10)) {
    return {
      ok: false,
      code: "backdated_sent_at_reason_required",
      detail:
        "this report is recorded more than an hour after it was sent; say why (10 to 2000 characters). " +
        "The record keeps both times and the reason",
    };
  }
  return { ok: true, backdated };
}

/** severities in order, for "is this a downgrade?" */
const SEVERITY_RANK: Record<IncidentSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export function severityRank(s: IncidentSeverity): number {
  return SEVERITY_RANK[s];
}
