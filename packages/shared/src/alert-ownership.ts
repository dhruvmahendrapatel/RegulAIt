/**
 * ADR-0182 (ADR-0175 batch D4) S5 — ALERT OWNER, SLA AND TICKET (PathForward
 * PF-14 "owner, SLA, status"): the pure half. OWNER: S5 (D4).
 *
 *   THIS FILE                              who may own an episode (in order),
 *                                          when it is due, how its SLA reads,
 *                                          and the words a chat post or a PM
 *                                          ticket carries. No db, no clock.
 *   `apps/gateway/src/alert-ownership.ts`  the lookups, the assignment route,
 *                                          the SLA sweep and the ticket route.
 *
 * OWNER DERIVATION. An episode's subject names what it is about; the owner is
 * the accountable person already recorded for that thing, tried in this order:
 * the use case's owner, the agent's steward, the risk's owner, the vendor's
 * owner. A pair-keyed subject (`use_case:U>agent:A`) is the use case's first,
 * then the agent's. A KRI episode is its agent's when the KRI is agent-scoped
 * (a fleet or project KRI has no single accountable person). Nothing found =
 * unowned, and the SLA sweep escalates it to the admins; an owner is never
 * invented.
 *
 * NO PERSONAL DATA IN CHAT OR TICKET TITLES (ADR-0175 D2 rule 12). A person is
 * "a user (id …)", never a name or an email address.
 */
import type { AlertSlaHours, AlertSlaSeverity, KriOnBreach } from "./accountability.js";
import type { KriScope } from "./kri.js";

/** the kinds of record an episode's owner is read from, in precedence order */
export const ALERT_OWNER_SUBJECT_KINDS = ["use_case", "agent", "risk", "vendor"] as const;
export type AlertOwnerSubjectKind = (typeof ALERT_OWNER_SUBJECT_KINDS)[number];

export interface AlertOwnerCandidate {
  kind: AlertOwnerSubjectKind;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The records whose owner may own this episode, in precedence order (use case,
 * agent, risk, vendor). Reads the subject key's parts (`type:id`, joined by
 * `>`) and, for a KRI episode, the KRI's own scope from the finding's detail.
 * Ids that are not uuids are skipped (a subject key is data, never trusted).
 */
export function alertOwnerCandidates(subjectKey: string, detail: Record<string, unknown> | null | undefined): AlertOwnerCandidate[] {
  const found: AlertOwnerCandidate[] = [];
  for (const part of subjectKey.split(">")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const type = part.slice(0, i);
    const id = part.slice(i + 1);
    if (!UUID.test(id)) continue;
    if ((ALERT_OWNER_SUBJECT_KINDS as readonly string[]).includes(type)) found.push({ kind: type as AlertOwnerSubjectKind, id });
  }
  // a KRI episode (`kri:<id>`) belongs to its agent when the KRI is agent-scoped
  if (subjectKey.startsWith("kri:") && detail && detail.scope === "agent" && typeof detail.scopeId === "string" && UUID.test(detail.scopeId)) {
    found.push({ kind: "agent", id: detail.scopeId });
  }
  const rank = (k: AlertOwnerSubjectKind) => ALERT_OWNER_SUBJECT_KINDS.indexOf(k);
  const seen = new Set<string>();
  return found
    .map((c, order) => ({ c, order }))
    .sort((a, b) => rank(a.c.kind) - rank(b.c.kind) || a.order - b.order)
    .map((x) => x.c)
    .filter((c) => {
      const key = `${c.kind}:${c.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

const HOUR_MS = 3_600_000;

/** an SLA severity for any alert severity (the monitor uses these three) */
export function alertSlaSeverity(severity: string): AlertSlaSeverity {
  return severity === "high" || severity === "medium" ? severity : "low";
}

/** due time = the episode's creation + the org's hours for its severity (UTC instant) */
export function alertDueAt(severity: string, from: Date, hours: AlertSlaHours): Date {
  return new Date(from.getTime() + hours[alertSlaSeverity(severity)] * HOUR_MS);
}

export const ALERT_SLA_STATES = ["none", "on_track", "due_soon", "breached", "met"] as const;
export type AlertSlaState = (typeof ALERT_SLA_STATES)[number];

/**
 * How an episode stands against its SLA. An episode is due until it is
 * RESOLVED (acknowledging records who is responding; it does not stop the
 * clock). `breached` once the sweep marked it or its due time has passed;
 * `due_soon` in the last quarter of its window; `met` when it resolved in
 * time; `none` when it has no due time.
 */
export function alertSlaState(
  a: { status: string; firstDetectedAt: Date | string; dueAt: Date | string | null; slaBreachedAt: Date | string | null; resolvedAt?: Date | string | null },
  now: Date,
): AlertSlaState {
  if (a.slaBreachedAt) return "breached";
  if (!a.dueAt) return "none";
  const due = new Date(a.dueAt).getTime();
  if (a.status === "resolved") {
    const at = a.resolvedAt ? new Date(a.resolvedAt).getTime() : now.getTime();
    return at <= due ? "met" : "breached";
  }
  if (now.getTime() >= due) return "breached";
  const window = due - new Date(a.firstDetectedAt).getTime();
  return window > 0 && due - now.getTime() <= window / 4 ? "due_soon" : "on_track";
}

/** "a user (id …)", the only way a person appears in chat or a ticket */
export function personRef(userId: string | null): string {
  return userId ? `a user (id ${userId})` : "nobody (unowned)";
}

/**
 * The chat text for an SLA breach or an unowned episode. Built from the rule
 * label, the severity, the due time and ids only: never the alert's title
 * (which may name a person or a caller) and never a name or an email.
 */
export function alertSlaChatText(input: {
  kind: "breached" | "unowned";
  ruleLabel: string;
  severity: string;
  dueAt: Date | null;
  ownerUserId: string | null;
}): string {
  const due = input.dueAt ? ` It was due ${input.dueAt.toISOString()}.` : "";
  if (input.kind === "unowned") {
    return (
      `regulAIt: a ${input.severity} governance alert (${input.ruleLabel}) has no owner and has been escalated to the ` +
      `admins to assign one.${due}`
    );
  }
  return (
    `regulAIt: a ${input.severity} governance alert (${input.ruleLabel}) is past its due time and has been escalated ` +
    `to the admins. Owner: ${personRef(input.ownerUserId)}.${due} It stays open until the condition clears.`
  );
}

/**
 * The PM work item for an episode. The title carries the rule label and the
 * severity; the description carries the alert's own title EXCEPT for a subject
 * that is a person (`caller:`), where the person is "a user (id …)".
 */
export function alertTicketText(input: {
  alertId: string;
  ruleLabel: string;
  severity: string;
  title: string;
  subjectKey: string;
  dueAt: Date | null;
  portalPath: string;
}): { title: string; description: string } {
  const person = /(?:^|>)caller:([^>]+)/.exec(input.subjectKey);
  const what = person ? `${input.ruleLabel}: AI use by ${personRef(person[1]!)}` : input.title;
  return {
    title: `[regulAIt] ${input.severity} governance alert: ${input.ruleLabel}`,
    description:
      `${what}\n\nAlert ${input.alertId}` +
      (input.dueAt ? `, due ${input.dueAt.toISOString()}` : "") +
      `. Open it in regulAIt: ${input.portalPath}\n\nThis work item tracks the response; the alert resolves in regulAIt ` +
      "when its condition clears, not when this item closes.",
  };
}

/**
 * ADR-0182 S5 (PF-03) — why a KRI cannot carry this `onBreach`, or null.
 * Only an agent-scoped KRI may suggest a halt: there is one agent to halt.
 * The gateway answers 422 with this text; the DB CHECK
 * `kris_on_breach_scope_check` refuses the row whatever the route does.
 * Owner decision 4: a suggestion only — nothing is filed and nothing halts on
 * its own. (Here rather than in kri.ts so the package barrel's `export *` of
 * this file carries it.)
 */
export function kriOnBreachProblem(scope: KriScope, onBreach: KriOnBreach): string | null {
  if (onBreach === "propose_halt" && scope !== "agent") {
    return `only an agent-scoped KRI can suggest a halt (this one is ${scope === "fleet" ? "fleet-wide" : `${scope}-scoped`})`;
  }
  return null;
}

/**
 * ADR-0182 S5 (PF-14, main-session decision 2026-10-06) — the alert ticket
 * settings must hang together. `auto_high` sends alert data to an outside PM
 * tool without a person deciding each time, so the tool is never an implicit
 * choice (ADR-0180): relaxing to `auto_high` needs `alertTicketConnectionId`,
 * set in the same write or an earlier one, naming a connection that exists.
 * A named connection must exist in either mode. Returns the 422 body, or null.
 * `PUT /v1/org/settings` calls this over the MERGED values.
 */
export function alertTicketSettingsProblem(next: {
  mode: "manual" | "auto_high";
  connectionId: string | null;
  connectionExists: boolean;
}): { error: string; detail: string } | null {
  if (next.connectionId && !next.connectionExists) {
    return {
      error: "unknown_pm_connection",
      detail: "alertTicketConnectionId names no PM connection. Nothing was saved.",
    };
  }
  if (next.mode === "auto_high" && !next.connectionId) {
    return {
      error: "alert_ticket_connection_required",
      detail:
        "automatic tickets for high alerts need the PM connection they are filed on: set alertTicketConnectionId in " +
        "the same write (or an earlier one). regulAIt never picks a connection for you. Nothing was saved.",
    };
  }
  return null;
}
