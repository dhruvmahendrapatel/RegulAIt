/**
 * ADR-0356 PR 3 — ATLASSIAN ROVO-AGENT AND MCP AUDIT EVENTS AS READ-ONLY EVIDENCE.
 *
 * An admin attaches a read-only feed of an Atlassian organisation's audit log to the PM connection of that
 * organisation's Jira (`pm_audit_sources`). The poll reads `GET {base}/admin/v1/orgs/{orgId}/events-stream` with the
 * org admin API key, keeps the events whose action matches the source's filters (Rovo and MCP by default) and stores
 * each once (`pm_audit_events`, append-only) under ONE audit-chain row per page, marked
 * `attribution: third_party, enforcement: false`.
 *
 * What this is NOT: nothing here authorises, refuses or rate-limits anything, and nothing drives a state machine. It
 * writes nothing to Atlassian (a GET only, no write scope).
 *
 * Posture (ADR-0180): a source is created disabled; enabling it, and replacing its key, is a settings_relax step-up,
 * audited. Every fetch goes through the connection egress guard, so `api.atlassian.com` (or the admin's base url) must
 * be on the egress allow-list: air-gapped, the poll is refused and says so. The key is stored encrypted and never
 * appears in a response, a log or an error (only the HTTP status is kept).
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  and,
  asc,
  auditLog,
  desc,
  eq,
  lt,
  pmAuditEvents,
  pmAuditSources,
  pmConnections,
  sql,
  type Db,
  type PmAuditSourceRow,
} from "@regulait/db";
import {
  ATLASSIAN_AUDIT_DEFAULT_BASE,
  ATLASSIAN_AUDIT_DEFAULT_FILTERS,
  ATLASSIAN_AUDIT_PAGE_SIZE,
  AtlassianAuditPageError,
  atlassianAuditFiltersSchema,
  parseAtlassianAuditPage,
} from "@regulait/pm-provider";
import { guardConnectionCall } from "./connection-egress.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { requireStepUp } from "./step-up.js";
import { errMessage } from "./err-serializer.js";
import type { SchedulerJobDefinition } from "./scheduler.js";

const SYSTEM_IDENTITY = "00000000-0000-0000-0000-000000000000";
/** pages read per poll of one source (a bounded pass; the next pass continues from the stored cursor) */
export const PM_AUDIT_PAGES_PER_POLL = 5;
/** the largest response body read */
export const PM_AUDIT_MAX_BODY_BYTES = 5 * 1024 * 1024;
const EVENTS_LIST_DEFAULT = 50;
const EVENTS_LIST_MAX = 200;

export const PM_AUDIT_RULE_IDS = {
  sourceCreated: "pm-audit-source-created",
  sourceUpdated: "pm-audit-source-updated",
  batchStored: "pm-audit-batch-stored",
  pollRefused: "pm-audit-poll-refused",
} as const;

const baseUrlSchema = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((u) => /^https?:\/\//.test(u), "an http(s) url");

const createSchema = z
  .object({
    connectionName: z.string().min(1).max(200),
    orgId: z.string().trim().min(1).max(200),
    apiKey: z.string().min(8).max(4096),
    baseUrl: baseUrlSchema.optional(),
    actionFilters: atlassianAuditFiltersSchema.optional(),
  })
  .strict();

const patchSchema = z
  .object({ enabled: z.boolean().optional(), apiKey: z.string().min(8).max(4096).optional(), actionFilters: atlassianAuditFiltersSchema.optional() })
  .strict();

const eventsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(EVENTS_LIST_MAX).default(EVENTS_LIST_DEFAULT),
    before: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

function view(s: PmAuditSourceRow, connectionName?: string) {
  return {
    id: s.id,
    connectionId: s.connectionId,
    ...(connectionName ? { connectionName } : {}),
    orgId: s.orgId,
    baseUrl: s.baseUrl,
    actionFilters: s.actionFilters,
    enabled: s.enabled,
    lastPolledAt: s.lastPolledAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

async function audit(db: Db, userId: string, objectId: string, ruleId: string, effect: "allow" | "deny", reason: string, detail: Record<string, unknown>, id?: string) {
  await db.insert(auditLog).values({
    ...(id ? { id } : {}),
    userId,
    objectType: "pm_audit_source",
    objectId,
    detail: { phase: "pm-audit-ingest", ...detail },
    effect,
    ruleId,
    ruleChain: [],
    reason,
  });
}

export interface PmAuditPollResult {
  sourceId: string;
  pages: number;
  seen: number;
  stored: number;
  refused?: string;
}

/**
 * Poll one source: up to PM_AUDIT_PAGES_PER_POLL pages from its stored cursor. Each page is stored atomically (its
 * audit row, its events, the cursor after it), so a failure part-way keeps every page already stored and resumes after
 * it. A refused fetch or page is audited and stops the pass.
 */
export async function pollPmAuditSource(db: Db, dataKey: string, sourceId: string, actorUserId: string | null): Promise<PmAuditPollResult> {
  const out: PmAuditPollResult = { sourceId, pages: 0, seen: 0, stored: 0 };
  const [source] = await db.select().from(pmAuditSources).where(eq(pmAuditSources.id, sourceId));
  if (!source) return { ...out, refused: "unknown_source" };
  if (!source.enabled) return { ...out, refused: "disabled" };
  const actor = actorUserId ?? SYSTEM_IDENTITY;
  const refuse = async (code: string, reason: string, detail: Record<string, unknown> = {}) => {
    await audit(db, actor, source.id, PM_AUDIT_RULE_IDS.pollRefused, "deny", `Atlassian audit feed for org ${source.orgId}: ${reason}`, { code, ...detail });
    return { ...out, refused: code };
  };
  let fetchImpl: typeof fetch;
  try {
    ({ fetchImpl } = await guardConnectionCall(db, {
      surface: "pm_connection",
      baseUrl: source.baseUrl,
      userId: actorUserId,
      objectId: source.connectionId,
      label: `Atlassian audit feed for org ${source.orgId}`,
      detail: { phase: "pm-audit-ingest", sourceId: source.id },
    }));
  } catch (err) {
    return refuse("egress_refused", `the egress guard refused the fetch (${errMessage(err).slice(0, 200)})`);
  }
  const apiKey = decryptSecret(dataKey, source.apiKeyCiphertext);
  let cursor = source.cursor;
  for (let i = 0; i < PM_AUDIT_PAGES_PER_POLL; i++) {
    const url = new URL(`/admin/v1/orgs/${encodeURIComponent(source.orgId)}/events-stream`, source.baseUrl);
    url.searchParams.set("limit", String(ATLASSIAN_AUDIT_PAGE_SIZE));
    if (cursor) url.searchParams.set("cursor", cursor);
    let body: unknown;
    try {
      const res = await fetchImpl(url.toString(), { method: "GET", headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" } });
      if (!res.ok) return refuse("http_error", `the audit log answered HTTP ${res.status}`, { status: res.status });
      const text = await res.text();
      if (text.length > PM_AUDIT_MAX_BODY_BYTES) return refuse("too_large", "the audit log page is larger than the ingest accepts");
      body = JSON.parse(text) as unknown;
    } catch (err) {
      // never the key: the error text is the transport's, and the key is only ever in a header
      return refuse("fetch_failed", `the audit log could not be read (${errMessage(err).slice(0, 200).split(apiKey).join("[key]")})`);
    }
    let page;
    try {
      page = parseAtlassianAuditPage(body, source.actionFilters);
    } catch (err) {
      if (err instanceof AtlassianAuditPageError) return refuse("bad_page", err.message);
      throw err;
    }
    const auditId = randomUUID();
    let stored = 0;
    await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      await audit(t, actor, source.id, PM_AUDIT_RULE_IDS.batchStored, "allow",
        `Atlassian audit feed for org ${source.orgId}: ${page.events.length} Rovo/MCP event(s) of ${page.seen} read as third-party evidence`,
        { attribution: "third_party", enforcement: false, seen: page.seen, matched: page.events.length, orgId: source.orgId }, auditId);
      if (page.events.length > 0) {
        const rows = await t
          .insert(pmAuditEvents)
          .values(page.events.map((e) => ({
            sourceId: source.id,
            eventId: e.eventId,
            action: e.action,
            actorAccountId: e.actorAccountId,
            attributes: e.attributes,
            observedAt: e.observedAt,
            recordSha256: e.recordSha256,
            auditLogId: auditId,
          })))
          .onConflictDoNothing()
          .returning({ id: pmAuditEvents.id });
        stored = rows.length;
      }
      await t
        .update(pmAuditSources)
        .set({ cursor: page.nextCursor ?? cursor, lastPolledAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(pmAuditSources.id, source.id));
    });
    out.pages++;
    out.seen += page.seen;
    out.stored += stored;
    if (!page.nextCursor || page.seen === 0 || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

export function registerPmAuditIngestRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined } = {}): void {
  const loadSource = async (id: string) => {
    const [s] = await db.select().from(pmAuditSources).where(eq(pmAuditSources.id, id));
    return s ?? null;
  };
  const idParam = z.object({ sourceId: z.string().uuid() });

  app.post("/v1/pm/audit-sources", async (req, reply) => {
    if (!opts.dataKey) return reply.status(503).send({ error: "data_key_unavailable", detail: "the gateway has no data key to encrypt the API key with" });
    const body = createSchema.parse(req.body);
    const [conn] = await db.select().from(pmConnections).where(eq(pmConnections.name, body.connectionName));
    if (!conn) return reply.status(400).send({ error: "invalid_reference", detail: "connectionName names no PM connection" });
    if (conn.provider !== "jira") {
      return reply.status(422).send({ error: "provider_not_supported", detail: "the Atlassian audit feed attaches to a Jira connection" });
    }
    const [row] = await db
      .insert(pmAuditSources)
      .values({
        connectionId: conn.id,
        orgId: body.orgId,
        baseUrl: body.baseUrl ?? ATLASSIAN_AUDIT_DEFAULT_BASE,
        apiKeyCiphertext: encryptSecret(opts.dataKey, body.apiKey),
        actionFilters: body.actionFilters ?? [...ATLASSIAN_AUDIT_DEFAULT_FILTERS],
        createdByUserId: req.authCtx.userId ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return reply.status(409).send({ error: "audit_source_exists", detail: "this connection already reads this organisation's audit log" });
    await audit(db, req.authCtx.userId ?? SYSTEM_IDENTITY, row.id, PM_AUDIT_RULE_IDS.sourceCreated, "allow",
      `added a read-only Atlassian audit feed for org ${row.orgId} on PM connection '${conn.name}' (disabled until enabled)`,
      { connection: conn.name, orgId: row.orgId, baseUrl: row.baseUrl, actionFilters: row.actionFilters });
    return reply.status(201).send(view(row, conn.name));
  });

  app.get("/v1/pm/audit-sources", async () => {
    const rows = await db
      .select({ s: pmAuditSources, connectionName: pmConnections.name })
      .from(pmAuditSources)
      .innerJoin(pmConnections, eq(pmConnections.id, pmAuditSources.connectionId))
      .orderBy(asc(pmConnections.name), asc(pmAuditSources.orgId))
      .limit(500);
    return { sources: rows.map((r) => view(r.s, r.connectionName)) };
  });

  app.patch<{ Params: { sourceId: string } }>("/v1/pm/audit-sources/:sourceId", async (req, reply) => {
    const { sourceId } = idParam.parse(req.params);
    const body = patchSchema.parse(req.body);
    const source = await loadSource(sourceId);
    if (!source) return reply.status(404).send({ error: "unknown_source" });
    if (body.apiKey !== undefined && !opts.dataKey) return reply.status(503).send({ error: "data_key_unavailable" });
    // turning the feed on, or replacing its credential, is a relaxation: a step-up, audited (ADR-0180)
    if (body.enabled === true || body.apiKey !== undefined) {
      const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { pmAuditFeed: body.enabled ? "enable" : "credential", sourceId } });
      if (!su.ok) return reply;
    }
    const [row] = await db
      .update(pmAuditSources)
      .set({
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.actionFilters ? { actionFilters: body.actionFilters } : {}),
        ...(body.apiKey !== undefined ? { apiKeyCiphertext: encryptSecret(opts.dataKey!, body.apiKey) } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(pmAuditSources.id, sourceId))
      .returning();
    await audit(db, req.authCtx.userId ?? SYSTEM_IDENTITY, sourceId, PM_AUDIT_RULE_IDS.sourceUpdated, "allow",
      `updated the Atlassian audit feed for org ${source.orgId}: ${[
        body.enabled !== undefined ? (body.enabled ? "enabled" : "disabled") : null,
        body.apiKey !== undefined ? "API key replaced" : null,
        body.actionFilters ? "filters changed" : null,
      ].filter(Boolean).join(", ") || "no change"}`,
      { enabled: row!.enabled, actionFilters: row!.actionFilters, keyReplaced: body.apiKey !== undefined });
    return view(row!);
  });

  app.post<{ Params: { sourceId: string } }>("/v1/pm/audit-sources/:sourceId/poll", async (req, reply) => {
    const { sourceId } = idParam.parse(req.params);
    if (!opts.dataKey) return reply.status(503).send({ error: "data_key_unavailable" });
    const source = await loadSource(sourceId);
    if (!source) return reply.status(404).send({ error: "unknown_source" });
    if (!source.enabled) return reply.status(409).send({ error: "source_disabled", detail: "enable the feed before polling it" });
    const result = await pollPmAuditSource(db, opts.dataKey, sourceId, req.authCtx.userId ?? null);
    return reply.status(result.refused ? 502 : 200).send(result);
  });

  app.get<{ Params: { sourceId: string } }>("/v1/pm/audit-sources/:sourceId/events", async (req, reply) => {
    const { sourceId } = idParam.parse(req.params);
    const q = eventsQuery.parse(req.query);
    if (!(await loadSource(sourceId))) return reply.status(404).send({ error: "unknown_source" });
    const rows = await db
      .select({
        id: pmAuditEvents.id,
        eventId: pmAuditEvents.eventId,
        action: pmAuditEvents.action,
        actorAccountId: pmAuditEvents.actorAccountId,
        attributes: pmAuditEvents.attributes,
        observedAt: pmAuditEvents.observedAt,
        receivedAt: pmAuditEvents.receivedAt,
        recordSha256: pmAuditEvents.recordSha256,
        auditLogId: pmAuditEvents.auditLogId,
      })
      .from(pmAuditEvents)
      .where(and(eq(pmAuditEvents.sourceId, sourceId), q.before ? lt(pmAuditEvents.observedAt, new Date(q.before)) : undefined))
      .orderBy(desc(pmAuditEvents.observedAt), desc(pmAuditEvents.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    return { events: page, nextBefore: rows.length > q.limit ? page[page.length - 1]!.observedAt.toISOString() : null };
  });
}

/** The scheduler job: poll every enabled source once per pass. */
export function pmAuditIngestJobDefinitions(opts: { dataKey?: string | undefined }): SchedulerJobDefinition[] {
  return [
    {
      name: "pm-audit-ingest-sweep",
      description:
        "Read Rovo-agent and Atlassian Remote MCP events from each enabled Atlassian organisation audit feed (a GET, " +
        "through the egress guard) and store them as append-only third-party evidence, each once. Decides nothing.",
      adr: "ADR-0356",
      defaultIntervalSeconds: 3600,
      run: async (ctx) => {
        if (!opts.dataKey) return { itemsProcessed: 0, detail: { skipped: "no data key" } };
        const sources = await ctx.db.select({ id: pmAuditSources.id }).from(pmAuditSources).where(eq(pmAuditSources.enabled, true)).limit(200);
        let stored = 0;
        let refused = 0;
        for (const s of sources) {
          const r = await pollPmAuditSource(ctx.db, opts.dataKey, s.id, null);
          stored += r.stored;
          if (r.refused) refused++;
        }
        return { itemsProcessed: sources.length, detail: { sources: sources.length, stored, refused } };
      },
    },
  ];
}
