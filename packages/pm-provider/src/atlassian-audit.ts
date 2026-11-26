/**
 * ADR-0356 PR 3 — ATLASSIAN ROVO-AGENT AND MCP AUDIT EVENTS, the pure half.
 *
 * Atlassian's Organizations REST API serves the organisation audit log (`GET /admin/v1/orgs/{orgId}/events-stream`,
 * an org admin API key as a Bearer token, cursor paging). Rovo-agent and Atlassian Remote MCP server activity is in
 * that log. RegulAIt only READS it: this file parses one page and keeps the events whose action matches the source's
 * filters (by default any action naming Rovo or MCP), as bounded, allow-listed evidence. No IP address, geolocation or
 * display name is kept: the actor's Atlassian account id is enough to attribute the event.
 *
 * Untrusted input: every field is bounded and the page is refused whole when its shape is wrong (a partial page would
 * move the cursor past events never stored).
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export const ATLASSIAN_AUDIT_DEFAULT_BASE = "https://api.atlassian.com";
/** events asked for per page (the API's own maximum is larger; one page is one bounded batch) */
export const ATLASSIAN_AUDIT_PAGE_SIZE = 200;
/** the default action filters: an action containing any of these (case-insensitive) is agent activity */
export const ATLASSIAN_AUDIT_DEFAULT_FILTERS = ["rovo", "mcp"] as const;

const str = (max: number) => z.string().max(max);
const ref = z.object({ id: z.union([z.string(), z.number()]).transform(String).optional(), type: z.string().max(100).optional() }).passthrough();

const eventSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    attributes: z
      .object({
        time: str(64),
        action: str(200),
        actor: z.object({ id: z.union([z.string(), z.number()]).transform(String).optional() }).passthrough().nullish(),
        context: z.array(ref).max(100).nullish(),
        container: z.array(ref).max(100).nullish(),
      })
      .passthrough(),
  })
  .passthrough();

const pageSchema = z
  .object({
    data: z.array(z.unknown()).max(1000),
    meta: z.object({ next: z.string().max(2000).nullish() }).passthrough().nullish(),
    links: z.object({ next: z.string().max(4000).nullish() }).passthrough().nullish(),
  })
  .passthrough();

export interface AtlassianAuditEvent {
  eventId: string;
  action: string;
  actorAccountId: string | null;
  observedAt: Date;
  /** allow-listed evidence: the action, the actor id, and the ids and types of the objects it touched */
  attributes: { action: string; actorAccountId: string | null; context: Array<{ id: string; type: string }>; container: Array<{ id: string; type: string }> };
  /** sha256 of the canonical evidence above, for the record */
  recordSha256: string;
}

export interface AtlassianAuditPage {
  /** every event on the page that matched the filters */
  events: AtlassianAuditEvent[];
  /** how many events the page carried in all (matched or not) */
  seen: number;
  /** the cursor for the next page, or null when this was the last one */
  nextCursor: string | null;
}

export class AtlassianAuditPageError extends Error {}

const refs = (v: Array<z.infer<typeof ref>> | null | undefined) =>
  (v ?? [])
    .filter((r) => typeof r.id === "string" && r.id.length > 0 && r.id.length <= 200)
    .slice(0, 20)
    .map((r) => ({ id: r.id!, type: (r.type ?? "").slice(0, 100) }));

/** the cursor of the next page: `meta.next`, or the `cursor` parameter of `links.next` */
function nextCursorOf(page: z.infer<typeof pageSchema>): string | null {
  if (page.meta?.next) return page.meta.next;
  if (page.links?.next) {
    try {
      return new URL(page.links.next, ATLASSIAN_AUDIT_DEFAULT_BASE).searchParams.get("cursor");
    } catch {
      return null;
    }
  }
  return null;
}

export function matchesAuditFilters(action: string, filters: readonly string[]): boolean {
  const a = action.toLowerCase();
  return filters.some((f) => a.includes(f.toLowerCase()));
}

/** Parse one events-stream page and keep the events matching `filters`. Throws AtlassianAuditPageError on a bad page. */
export function parseAtlassianAuditPage(body: unknown, filters: readonly string[]): AtlassianAuditPage {
  const page = pageSchema.safeParse(body);
  if (!page.success) throw new AtlassianAuditPageError("the audit log page is not the documented events shape");
  const events: AtlassianAuditEvent[] = [];
  for (const raw of page.data.data) {
    const e = eventSchema.safeParse(raw);
    if (!e.success || e.data.id.length === 0 || e.data.id.length > 200) {
      throw new AtlassianAuditPageError("an audit log event is not the documented shape");
    }
    const observed = new Date(e.data.attributes.time);
    if (Number.isNaN(observed.getTime())) throw new AtlassianAuditPageError("an audit log event carries no valid time");
    const action = e.data.attributes.action;
    if (!matchesAuditFilters(action, filters)) continue;
    const actorId = e.data.attributes.actor?.id;
    const attributes = {
      action,
      actorAccountId: actorId && actorId.length <= 200 ? actorId : null,
      context: refs(e.data.attributes.context),
      container: refs(e.data.attributes.container),
    };
    events.push({
      eventId: e.data.id,
      action,
      actorAccountId: attributes.actorAccountId,
      observedAt: observed,
      attributes,
      recordSha256: createHash("sha256").update(JSON.stringify({ eventId: e.data.id, time: observed.toISOString(), ...attributes })).digest("hex"),
    });
  }
  return { events, seen: page.data.data.length, nextCursor: nextCursorOf(page.data) };
}

export const atlassianAuditFiltersSchema = z.array(z.string().trim().min(2).max(64)).min(1).max(20);
