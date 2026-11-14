/**
 * ADR-0226 (P2 batch D) — the measured usage ledger (`GET /v1/usage-events`) under the shared list contract: the
 * Spend page's agent invocations and the Optimization page's usage events. The visibility rule is the route's own:
 * a non-admin's `userId` is forced to themselves (the query string is never trusted); an admin may name one user or
 * read the organisation's; a bootstrap operator with no user identity is refused, as on the legacy read.
 */
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { and, eq, getTableColumns, ne, sql, usageEvents, type Db, type PgColumn, type SQL } from "@regulait/db";
import type { ListReader, ListSpec } from "./list-contract.js";

export type UsageEventListRow = typeof usageEvents.$inferSelect & {
  userName: string | null;
  agentName: string | null;
  projectName: string | null;
};

/**
 * Correlated name lookups. Each inner table is aliased and named through its alias, so the outer `usage_events`
 * column can never bind to the inner table.
 */
const userName = (col: PgColumn) => sql<string | null>`(select coalesce(nullif(u.display_name, ''), u.email) from users u where u.id = ${col})`;
const agentName = (col: PgColumn) => sql<string | null>`(select ag.name from agents ag where ag.id = ${col})`;
const projectName = (col: PgColumn) => sql<string | null>`(select pr.name from projects pr where pr.id = ${col})`;
const lower = (e: SQL) => sql`lower(${e})`;
const credentialSource = sql`(${usageEvents.detail} ->> 'credentialSource')`;

export const USAGE_EVENTS_LIST: ListSpec<UsageEventListRow> = {
  id: "usage-events",
  sorts: {
    at: { expr: usageEvents.at, keysetAt: usageEvents.at },
    user: { expr: lower(userName(usageEvents.userId)) },
    object: { expr: usageEvents.objectType },
    agent: { expr: lower(agentName(usageEvents.agentId)) },
    model: { expr: usageEvents.model },
    key: { expr: credentialSource },
    tokens: { expr: sql`(coalesce(${usageEvents.inputTokens}, 0) + coalesce(${usageEvents.outputTokens}, 0))` },
    cost: { expr: usageEvents.costUsd },
    saved: { expr: usageEvents.measuredCostSavedUsd },
    project: { expr: lower(projectName(usageEvents.projectId)) },
  },
  columns: {
    at: { label: "When", value: (r) => r.at },
    user: { label: "User", value: (r) => r.userName },
    object: { label: "Object", value: (r) => r.objectType },
    agent: { label: "Agent", value: (r) => r.agentName },
    model: { label: "Model served", value: (r) => r.model },
    key: { label: "Key used", value: (r) => (r.detail as { credentialSource?: string } | null)?.credentialSource ?? null },
    tokens: { label: "Tokens in → out", value: (r) => `${r.inputTokens ?? 0} → ${r.outputTokens ?? 0}` },
    cost: { label: "Cost (USD)", value: (r) => r.costUsd },
    saved: { label: "Saved (USD)", value: (r) => r.measuredCostSavedUsd },
    project: { label: "Project", value: (r) => r.projectName ?? (r.projectId ? r.projectId : "unattributed") },
    refusal: { label: "Refused", value: (r) => r.refusal },
  },
  filters: ["userId", "objectType", "excludeObjectType"],
  defaultSort: { col: "at", dir: "desc" },
  idCol: usageEvents.id,
};

const objectTypeSchema = z.string().min(1).max(64);
export const usageEventsFilterQuery = z
  .object({
    userId: z.string().uuid().optional(),
    objectType: objectTypeSchema.optional(),
    /** e.g. `connector`: the Spend page lists agent calls, never connector rows */
    excludeObjectType: objectTypeSchema.optional(),
  })
  .strict();
export type UsageEventsFilters = z.infer<typeof usageEventsFilterQuery>;

/** the one predicate for the page, its count and the export; null = a caller who has no ledger (refused) */
export function usageEventsWhere(req: FastifyRequest, f: UsageEventsFilters): SQL | undefined | null {
  const userId = req.authCtx.isAdmin ? f.userId : req.authCtx.userId;
  if (!req.authCtx.isAdmin && !userId) return null;
  const conds: SQL[] = [];
  if (userId) conds.push(eq(usageEvents.userId, userId));
  if (f.objectType) conds.push(eq(usageEvents.objectType, f.objectType));
  if (f.excludeObjectType) conds.push(ne(usageEvents.objectType, f.excludeObjectType));
  return conds.length ? and(...conds) : undefined;
}

export const usageEventsReader = (db: Db): ListReader<UsageEventListRow> => ({
  fetch: (q) =>
    db
      .select({
        ...getTableColumns(usageEvents),
        userName: userName(usageEvents.userId),
        agentName: agentName(usageEvents.agentId),
        projectName: projectName(usageEvents.projectId),
        _cursorAt: q.cursorAt,
      })
      .from(usageEvents)
      .where(q.where)
      .orderBy(...q.orderBy)
      .limit(q.limit)
      .offset(q.offset),
  countable: (where) => db.select({ one: sql`1` }).from(usageEvents).where(where),
  idOf: (r) => r.id,
});
