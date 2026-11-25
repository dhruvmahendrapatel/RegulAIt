/**
 * ADR-0356 — WORK ASSIGNED FROM THE PM TOOL: the vendor-neutral half.
 *
 * Three pure pieces, no db, no clock, no network:
 *
 *  1. `extractTriggerSignals(provider, rawBody, query)` reads FACTS from a delivery the gateway has ALREADY verified
 *     and replay-checked (parseInboundWebhook + the S-03 delivery record): which item, who acted, and whether the item
 *     was assigned to someone, mentioned someone, or arrived through an admin's rule. It decides nothing. It is
 *     exhaustive over the provider kinds; a provider without a case returns no signal (Linear, Asana, monday and the
 *     generic webhook follow by adding one).
 *  2. `matchTrigger(signal, settings)` decides whether a signal is a trigger under a connection's settings: the item
 *     was assigned to or mentioned the configured agent identity, or came from a rule, and the mechanism is on.
 *  3. `PM_TRIGGER_TRANSITIONS`: the trigger lifecycle as one declared table. The gateway moves a row only with a
 *     compare-and-set update whose WHERE names `pmTriggerSourcesOf(to)`; the migration's CHECK holds the same states.
 *
 * Everything read here is untrusted input from a third party: every string is bounded, every regex has bounded
 * quantifiers over a bounded input, and the ADF walk is bounded in depth and node count.
 */
import { z } from "zod";
import type { PmProviderKind } from "./index.js";
import { PM_WORK_TRIGGER_MACHINE } from "@regulait/shared";
import { JIRA_TRIGGER_RULE_EVENT } from "./inbound.js";

// ---------------------------------------------------------------------------
// Lifecycle (owner rule 2026-11-17: explicit state machines)
// ---------------------------------------------------------------------------

/** The lifecycle is the ADR-0348 machine `PM_WORK_TRIGGER_MACHINE` (@regulait/shared); the views below derive from it. */
export { PM_WORK_TRIGGER_MACHINE };
export const PM_TRIGGER_STATES = PM_WORK_TRIGGER_MACHINE.def.states;
export type PmTriggerState = (typeof PM_TRIGGER_STATES)[number];
export type PmTriggerEvent = keyof typeof PM_WORK_TRIGGER_MACHINE.def.transitions;

/** from-state → reachable states, derived from the machine (`written_back` and `failed` are terminal) */
export const PM_TRIGGER_TRANSITIONS: Readonly<Record<PmTriggerState, readonly PmTriggerState[]>> = Object.freeze(
  Object.fromEntries(
    PM_TRIGGER_STATES.map((from) => [
      from,
      [...new Set(Object.values(PM_WORK_TRIGGER_MACHINE.def.transitions).filter((t) => (t.from as readonly string[]).includes(from)).map((t) => t.to))],
    ]),
  ) as Record<PmTriggerState, PmTriggerState[]>,
);

/** States in which an item's trigger is still open: one item has at most one (a partial unique index holds it). */
export const PM_TRIGGER_OPEN_STATES: readonly PmTriggerState[] = ["received", "accepted", "running"];

export function canPmTriggerTransition(from: PmTriggerState, to: PmTriggerState): boolean {
  return PM_WORK_TRIGGER_MACHINE.canMove(from, to);
}

/** The states a row may be moved to `to` from: what the gateway's compare-and-set update puts in its WHERE. */
export function pmTriggerSourcesOf(to: PmTriggerState): PmTriggerState[] {
  return PM_TRIGGER_STATES.filter((from) => PM_TRIGGER_TRANSITIONS[from].includes(to));
}

// ---------------------------------------------------------------------------
// Settings (per connection, admin-managed; off by default — ADR-0180)
// ---------------------------------------------------------------------------

const pmIdentity = z.string().trim().min(1).max(200);

export const pmTriggerSettingsSchema = z
  .object({
    /** off until an admin turns it on: a connection without settings, or disabled, ignores every signal */
    enabled: z.boolean().default(false),
    /** the RegulAIt agent user's identity in the PM tool: a Jira accountId; an Azure DevOps identity id (guid) and/or
     * its unique name. Assigning to or mentioning any of these is a trigger. */
    agentIdentities: z.array(pmIdentity).min(1).max(5),
    /** which mechanisms start work; each can be turned off. `rule` is off by default (ADR-0180): on a rule delivery the
     * actor is whatever the rule's body names, as trustworthy as whoever can edit a rule holding the connection's
     * webhook secret, so an admin turns it on explicitly, with a step-up */
    mechanisms: z
      .object({
        assignment: z.boolean().default(true),
        mention: z.boolean().default(true),
        rule: z.boolean().default(false),
      })
      .strict()
      .default({ assignment: true, mention: true, rule: false }),
    /** the RegulAIt registry agent the work runs on: the triggering person must be entitled to it */
    agentId: z.string().uuid(),
    /** the change attributes the normal template assignment reads (ADR-0018) */
    change: z
      .object({
        changeType: z.string().trim().min(1).max(200).default("pm_work_item"),
        environment: z.string().trim().min(1).max(200),
        targetSystem: z.string().trim().min(1).max(200).optional(),
      })
      .strict(),
  })
  .strict();
export type PmTriggerSettings = z.infer<typeof pmTriggerSettingsSchema>;

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export type PmTriggerMechanism = "assignment" | "mention" | "rule";

export interface PmTriggerSignal {
  /** the provider's id for the item (the same key pm_links / the importer record) */
  externalId: string;
  mechanism: PmTriggerMechanism;
  /** who acted, as the PM tool reports it: the canonical id first, then aliases (an Azure DevOps unique name).
   * An ASSERTION until an admin's identity link maps it to a RegulAIt user. Empty when the tool names nobody. */
  actorIds: string[];
  /** assignment: the new assignee's ids; mention: the mentioned ids; rule: empty */
  targetIds: string[];
}

const MAX_TEXT = 100_000;
const MAX_IDS = 50;
const MAX_ADF_NODES = 5_000;
const MAX_ADF_DEPTH = 32;

const bounded = (v: unknown): string | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  return s === "" || s.length > 200 ? null : s;
};
const ids = (...vs: unknown[]): string[] => [...new Set(vs.map(bounded).filter((v): v is string => v !== null))];
const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function parseBody(rawBody: string): Record<string, unknown> | null {
  try {
    return obj(JSON.parse(rawBody));
  } catch {
    return null;
  }
}

/** Jira wiki-markup mentions: `[~accountid:<id>]`. Bounded quantifier over a bounded string. */
const JIRA_WIKI_MENTION = /\[~accountid:([A-Za-z0-9:_-]{1,128})\]/g;

function jiraMentions(body: unknown): string[] {
  const out = new Set<string>();
  if (typeof body === "string") {
    for (const m of body.slice(0, MAX_TEXT).matchAll(JIRA_WIKI_MENTION)) {
      out.add(m[1]!);
      if (out.size >= MAX_IDS) break;
    }
    return [...out];
  }
  // ADF (REST v3): walk for `mention` nodes, bounded
  let seen = 0;
  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_ADF_DEPTH || seen >= MAX_ADF_NODES || out.size >= MAX_IDS) return;
    const n = obj(node);
    if (!n) return;
    seen++;
    if (n.type === "mention") {
      const id = bounded(obj(n.attrs)?.id);
      if (id) out.add(id);
    }
    if (Array.isArray(n.content)) for (const c of n.content) walk(c, depth + 1);
  };
  walk(body, 0);
  return [...out];
}

function jiraSignals(rawBody: string): PmTriggerSignal[] {
  const b = parseBody(rawBody);
  if (!b) return [];
  const issue = obj(b.issue);
  const externalId = bounded(issue?.id);
  if (!externalId) return [];
  const event = b.webhookEvent;
  if (event === JIRA_TRIGGER_RULE_EVENT) {
    return [{ externalId, mechanism: "rule", actorIds: ids(obj(b.user)?.accountId), targetIds: [] }];
  }
  if (event === "jira:issue_updated" || event === "jira:issue_created") {
    const items = Array.isArray(obj(b.changelog)?.items) ? (obj(b.changelog)!.items as unknown[]) : [];
    const assigned = items
      .map(obj)
      .filter((i): i is Record<string, unknown> => i !== null && (i.fieldId === "assignee" || i.field === "assignee"))
      .flatMap((i) => ids(i.to));
    // an issue CREATED already assigned carries the assignee on the issue rather than in a changelog
    const createdAssignee = event === "jira:issue_created" ? ids(obj(obj(issue?.fields)?.assignee)?.accountId) : [];
    const targetIds = [...new Set([...assigned, ...createdAssignee])];
    if (targetIds.length === 0) return [];
    return [{ externalId, mechanism: "assignment", actorIds: ids(obj(b.user)?.accountId), targetIds }];
  }
  if (event === "comment_created" || event === "comment_updated") {
    const comment = obj(b.comment);
    const author = event === "comment_updated" ? (obj(comment?.updateAuthor) ?? obj(comment?.author)) : obj(comment?.author);
    const targetIds = jiraMentions(comment?.body);
    if (targetIds.length === 0) return [];
    return [{ externalId, mechanism: "mention", actorIds: ids(author?.accountId), targetIds }];
  }
  return [];
}

/** Azure DevOps identity: an object `{ id, uniqueName }` or the legacy string `Display Name <unique@name>`. */
function adoIdentity(v: unknown): string[] {
  const o = obj(v);
  if (o) return ids(o.id, typeof o.uniqueName === "string" ? o.uniqueName.toLowerCase() : undefined);
  if (typeof v === "string") {
    const m = /<([^<>]{1,200})>\s*$/.exec(v.slice(0, 500));
    return m ? ids(m[1]!.toLowerCase()) : [];
  }
  return [];
}
const adoNew = (v: unknown): unknown => {
  const o = obj(v);
  return o && "newValue" in o ? o.newValue : v;
};
/** Azure DevOps comment mentions: `data-vss-mention="version:2.0,<guid>"`. Bounded. */
const ADO_MENTION = /data-vss-mention="version:[0-9.]{1,8},([0-9a-fA-F-]{36})"/g;

function adoSignals(rawBody: string, query: Record<string, string | undefined>): PmTriggerSignal[] {
  const b = parseBody(rawBody);
  if (!b || typeof b.eventType !== "string") return [];
  const r = obj(b.resource);
  if (!r) return [];
  const fields = obj(r.fields) ?? {};
  const revision = obj(r.revision);
  const revFields = obj(revision?.fields) ?? {};
  switch (b.eventType) {
    case "workitem.updated": {
      const externalId = bounded(r.workItemId ?? revision?.id);
      if (!externalId) return [];
      // the actor is `revisedBy`; a payload without it carries the same person as the revision's System.ChangedBy
      // (ported from #986, lane L6), so a hand-over is never denied as "not linked" for a missing field
      const revisedBy = adoIdentity(r.revisedBy);
      const actorIds = revisedBy.length > 0 ? revisedBy : adoIdentity(adoNew(revFields["System.ChangedBy"] ?? fields["System.ChangedBy"]));
      if (query.trigger === "rule") return [{ externalId, mechanism: "rule", actorIds, targetIds: [] }];
      const assigned = fields["System.AssignedTo"];
      // only a CHANGE of assignee in this update is an assignment (an unrelated edit of an assigned item is not)
      if (!obj(assigned) || !("newValue" in obj(assigned)!)) return [];
      const targetIds = adoIdentity(adoNew(assigned));
      return targetIds.length === 0 ? [] : [{ externalId, mechanism: "assignment", actorIds, targetIds }];
    }
    case "workitem.created": {
      const externalId = bounded(r.id);
      if (!externalId) return [];
      const actorIds = adoIdentity(fields["System.CreatedBy"]);
      if (query.trigger === "rule") return [{ externalId, mechanism: "rule", actorIds, targetIds: [] }];
      const targetIds = adoIdentity(fields["System.AssignedTo"]);
      return targetIds.length === 0 ? [] : [{ externalId, mechanism: "assignment", actorIds, targetIds }];
    }
    case "workitem.commented": {
      const externalId = bounded(r.id ?? r.workItemId);
      if (!externalId) return [];
      const history = adoNew(fields["System.History"] ?? revFields["System.History"]);
      if (typeof history !== "string") return [];
      const targetIds = new Set<string>();
      for (const m of history.slice(0, MAX_TEXT).matchAll(ADO_MENTION)) {
        targetIds.add(m[1]!.toLowerCase());
        if (targetIds.size >= MAX_IDS) break;
      }
      if (targetIds.size === 0) return [];
      const actorIds = adoIdentity(adoNew(fields["System.ChangedBy"]) ?? r.revisedBy);
      return [{ externalId, mechanism: "mention", actorIds, targetIds: [...targetIds] }];
    }
    default:
      return [];
  }
}

/**
 * The trigger signals in a VERIFIED delivery. Call only after parseInboundWebhook accepted it and the gateway recorded
 * it (S-03): this function proves nothing about the sender.
 */
export function extractTriggerSignals(
  provider: PmProviderKind,
  rawBody: string,
  query: Record<string, string | undefined> = {},
): PmTriggerSignal[] {
  switch (provider) {
    case "jira":
      return jiraSignals(rawBody);
    case "azure_devops":
      return adoSignals(rawBody, query);
    case "linear":
    case "asana":
    case "monday":
    case "generic_webhook":
    case "mock":
      return [];
  }
}

const norm = (s: string) => s.trim().toLowerCase();

/** Is this signal a trigger under these settings? Pure. A disabled connection or mechanism, or a signal whose actor is
 * the agent itself (its own write-back), is not. */
export function matchTrigger(signal: PmTriggerSignal, settings: PmTriggerSettings): boolean {
  if (!settings.enabled || !settings.mechanisms[signal.mechanism]) return false;
  const agent = new Set(settings.agentIdentities.map(norm));
  if (signal.actorIds.some((a) => agent.has(norm(a)))) return false;
  if (signal.mechanism === "rule") return true;
  return signal.targetIds.some((t) => agent.has(norm(t)));
}
