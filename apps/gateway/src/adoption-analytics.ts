/**
 * ADR-0358 (lane E39) — AI ADOPTION ANALYTICS: read-time aggregations, admin-only, under `/v1/adoption/*`.
 *
 * Like the ADR-0082 inventory, nothing here is copied or collected: every figure is a SELECT over ledgers the gateway
 * already writes.
 *
 *   metered   `usage_events` (the gateway's own ledger): a person is active on a tool in a bucket when they made at
 *             least one governed call to it (agent dispatch, connector, MCP server, A2A agent)
 *   imported  `imported_cost_lines` in an applied batch, not superseded (ADR-0069/0076; pulled lines from ADR-0322 land
 *             in the same table): seats are `seat` lines, activity is a `usage` line with a positive quantity or amount
 *
 * The two never blend (ADR-0069): they are separate blocks and no field adds them.
 *
 * PRIVACY (ADR-0180, owner default): the aggregate routes never return a user id, and any count of people below the
 * policy's `minCohortSize` (default 5) is returned as null with `suppressed: true`, together with the figures that
 * would let it be worked back (calls, utilisation). The per-person view is refused unless an admin turned
 * `perPersonRanking` on (step-up, reason, audited), and each read of it is audited.
 *
 * Every route is admin-only (none is in NON_ADMIN_ROUTES) and paginated by `limit` (10, 50, 100, 500) and `offset`.
 * No cache: the reads are bounded and a cache would have to be scoped per caller.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";
import {
  a2aAgents,
  adoptionAnalyticsPolicy,
  ADOPTION_POLICY_ID,
  agents,
  auditLog,
  connectors,
  costImportBatches,
  eq,
  importedCostLines,
  mcpServers,
  projects,
  sql,
  teamMembers,
  teams,
  usageEvents,
  type Db,
  type SQL,
} from "@regulait/db";
import {
  ADOPTION_POLICY_DEFAULTS,
  AdoptionWindowError,
  adoptionActiveUsersQuerySchema,
  adoptionPeopleQuerySchema,
  adoptionPolicyRelaxations,
  adoptionSeatsQuerySchema,
  adoptionTopToolsQuerySchema,
  resolveAdoptionWindow,
  seatUtilisation,
  setAdoptionPolicySchema,
  suppressCount,
  type AdoptionBucket,
  type AdoptionPolicy,
  type AdoptionToolKind,
} from "@regulait/shared";
import { userNameSql } from "./delegations-list.js";
import { CHANGED_CONCURRENTLY, requireRelaxStepUp } from "./step-up.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
export const ADOPTION_POLICY_RULE_ID = "adoption-policy-set";
export const ADOPTION_PEOPLE_READ_RULE_ID = "adoption-people-read";
/** the imported vendor ranking is a short list (one row per vendor), returned whole up to this bound */
export const ADOPTION_IMPORTED_VENDOR_CAP = 100;

const METERED_SOURCE =
  "usage_events: governed calls to agents, connectors, MCP servers and A2A agents (gateway-internal rows such as guardrail scorers are not adoption)";
const IMPORTED_SOURCE =
  "imported_cost_lines in applied batches, not superseded (file imports and opt-in vendor pulls): seats are seat lines, activity is a usage line with a positive quantity or amount";

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

export async function loadAdoptionPolicy(db: Db): Promise<AdoptionPolicy & { updatedAt: Date | null }> {
  const [row] = await db.select().from(adoptionAnalyticsPolicy).where(eq(adoptionAnalyticsPolicy.id, ADOPTION_POLICY_ID));
  if (!row) return { ...ADOPTION_POLICY_DEFAULTS, updatedAt: null };
  return { perPersonRanking: row.perPersonRanking, minCohortSize: row.minCohortSize, updatedAt: row.updatedAt };
}

function policyView(p: AdoptionPolicy & { updatedAt: Date | null }) {
  return {
    perPersonRanking: p.perPersonRanking,
    minCohortSize: p.minCohortSize,
    defaults: { ...ADOPTION_POLICY_DEFAULTS },
    strictDefault: !p.perPersonRanking && p.minCohortSize >= ADOPTION_POLICY_DEFAULTS.minCohortSize,
    updatedAt: p.updatedAt ? p.updatedAt.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// the metered tool, as SQL over usage_events
// ---------------------------------------------------------------------------

const TOOL_KIND_SQL = sql`CASE ${usageEvents.objectType}
  WHEN 'agent' THEN 'agent' WHEN 'connector' THEN 'connector' WHEN 'mcp_tool' THEN 'mcp_server' WHEN 'a2a_agent' THEN 'a2a_agent' END`;
const TOOL_ID_SQL = sql`CASE ${usageEvents.objectType}
  WHEN 'agent' THEN ${usageEvents.agentId}::text
  WHEN 'connector' THEN ${usageEvents.connectorId}::text
  WHEN 'mcp_tool' THEN ${usageEvents.detail}->>'serverId'
  WHEN 'a2a_agent' THEN ${usageEvents.detail}->>'a2aAgentId' END`;
const KIND_OBJECT_TYPE: Record<AdoptionToolKind, string> = {
  agent: "agent",
  connector: "connector",
  mcp_server: "mcp_tool",
  a2a_agent: "a2a_agent",
};

/** the WHERE over usage_events every metered read shares: the window, the adoption kinds, a real person */
function meteredWhere(from: Date, to: Date, kind?: AdoptionToolKind, toolId?: string, projectId?: string): SQL {
  const parts: SQL[] = [
    sql`${usageEvents.at} >= ${from.toISOString()}::timestamptz`,
    sql`${usageEvents.at} < ${to.toISOString()}::timestamptz`,
    kind
      ? sql`${usageEvents.objectType} = ${KIND_OBJECT_TYPE[kind]}`
      : sql`${usageEvents.objectType} IN ('agent', 'connector', 'mcp_tool', 'a2a_agent')`,
    sql`${usageEvents.userId} <> ${NO_IDENTITY}::uuid`,
    sql`(${TOOL_ID_SQL}) IS NOT NULL`,
  ];
  if (toolId) parts.push(sql`(${TOOL_ID_SQL}) = ${toolId}`);
  if (projectId) parts.push(sql`${usageEvents.projectId} = ${projectId}::uuid`);
  return sql.join(parts, sql` AND `);
}

/** the tool's current name, joined at read time (a deleted tool reads null) */
const toolNameSql = (kind: SQL, id: SQL): SQL<string | null> => sql<string | null>`CASE ${kind}
  WHEN 'agent' THEN (SELECT ${agents.name} FROM ${agents} WHERE ${agents.id}::text = ${id})
  WHEN 'connector' THEN (SELECT ${connectors.name} FROM ${connectors} WHERE ${connectors.id}::text = ${id})
  WHEN 'mcp_server' THEN (SELECT ${mcpServers.name} FROM ${mcpServers} WHERE ${mcpServers.id}::text = ${id})
  WHEN 'a2a_agent' THEN (SELECT ${a2aAgents.name} FROM ${a2aAgents} WHERE ${a2aAgents.id}::text = ${id}) END`;

// `date_trunc`'s unit is a literal from a closed enum, never caller text
const BUCKET_UNIT: Record<AdoptionBucket, SQL> = { day: sql.raw("'day'"), week: sql.raw("'week'"), month: sql.raw("'month'") };

interface Page {
  limit: number;
  offset: number;
}
function paged<T>(rows: T[], page: Page) {
  const more = rows.length > page.limit;
  return { items: rows.slice(0, page.limit), nextOffset: more ? page.offset + page.limit : null };
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export async function adoptionActiveUsers(db: Db, raw: unknown, now: Date) {
  const q = adoptionActiveUsersQuerySchema.parse(raw);
  const { from, to } = resolveAdoptionWindow(q, now, q.bucket);
  const policy = await loadAdoptionPolicy(db);
  const where = meteredWhere(from, to, q.toolKind, q.toolId, q.projectId);
  const unit = BUCKET_UNIT[q.bucket];
  const teamJoin =
    q.groupBy === "team" || q.teamId
      ? sql`JOIN ${teamMembers} tm ON tm.user_id = ev.user_id${q.teamId ? sql` AND tm.team_id = ${q.teamId}::uuid` : sql``}`
      : sql``;
  const groupCol = q.groupBy === "team" ? sql`tm.team_id::text` : q.groupBy === "project" ? sql`ev.project_id::text` : sql`NULL::text`;
  const res = await db.execute<{ b: string; kind: string; tool_id: string; group_id: string | null; users: number; calls: number }>(sql`
    WITH ev AS (
      SELECT date_trunc(${unit}, ${usageEvents.at} AT TIME ZONE 'UTC') AS b, ${TOOL_KIND_SQL} AS kind, ${TOOL_ID_SQL} AS tool_id,
             ${usageEvents.userId} AS user_id, ${usageEvents.projectId} AS project_id
        FROM ${usageEvents} WHERE ${where}
    )
    SELECT to_char(ev.b, 'YYYY-MM-DD') AS b, ev.kind, ev.tool_id, ${groupCol} AS group_id,
           count(DISTINCT ev.user_id)::int AS users, count(*)::int AS calls
      FROM ev ${teamJoin}
     GROUP BY 1, 2, 3, 4
     ORDER BY 1 DESC, 2, 3, 4 NULLS LAST
     LIMIT ${q.limit + 1} OFFSET ${q.offset}`);
  const { items, nextOffset } = paged(res.rows, q);
  const names = await namesFor(db, items, q.groupBy);
  return {
    source: "metered" as const,
    sourceNote: METERED_SOURCE,
    window: { from: from.toISOString(), to: to.toISOString() },
    bucket: q.bucket,
    groupBy: q.groupBy,
    minCohortSize: policy.minCohortSize,
    items: items.map((r) => {
      const users = suppressCount(Number(r.users), policy.minCohortSize);
      return {
        bucketStart: r.b,
        tool: { kind: r.kind, id: r.tool_id, name: names.tools.get(`${r.kind}:${r.tool_id}`) ?? null },
        group:
          q.groupBy === "none"
            ? null
            : { kind: q.groupBy, id: r.group_id, name: r.group_id ? (names.groups.get(r.group_id) ?? null) : null },
        activeUsers: users.value,
        calls: users.suppressed ? null : Number(r.calls),
        suppressed: users.suppressed,
      };
    }),
    nextOffset,
  };
}

/** names for one page, in two bounded reads (never per row) */
async function namesFor(db: Db, rows: Array<{ kind: string; tool_id: string; group_id?: string | null }>, groupBy: string) {
  const tools = new Map<string, string | null>();
  const groups = new Map<string, string | null>();
  const pairs = [...new Map(rows.map((r) => [`${r.kind}:${r.tool_id}`, r])).values()];
  if (pairs.length > 0) {
    const values = sql.join(
      pairs.map((p) => sql`(${p.kind}, ${p.tool_id})`),
      sql`, `,
    );
    const res = await db.execute<{ kind: string; id: string; name: string | null }>(
      sql`SELECT v.kind, v.id, ${toolNameSql(sql`v.kind`, sql`v.id`)} AS name FROM (VALUES ${values}) AS v(kind, id)`,
    );
    for (const r of res.rows) tools.set(`${r.kind}:${r.id}`, r.name);
  }
  const ids = [...new Set(rows.map((r) => r.group_id).filter((g): g is string => !!g))];
  if (ids.length > 0 && (groupBy === "team" || groupBy === "project")) {
    const t = groupBy === "team" ? teams : projects;
    const res = await db.execute<{ id: string; name: string }>(
      sql`SELECT ${t.id}::text AS id, ${t.name} AS name FROM ${t} WHERE ${t.id}::text IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`,
    );
    for (const r of res.rows) groups.set(r.id, r.name);
  }
  return { tools, groups };
}

export async function adoptionTopTools(db: Db, raw: unknown, now: Date) {
  const q = adoptionTopToolsQuerySchema.parse(raw);
  const { from, to } = resolveAdoptionWindow(q, now);
  const policy = await loadAdoptionPolicy(db);
  const res = await db.execute<{ kind: string; tool_id: string; users: number; calls: number }>(sql`
    SELECT ${TOOL_KIND_SQL} AS kind, ${TOOL_ID_SQL} AS tool_id,
           count(DISTINCT ${usageEvents.userId})::int AS users, count(*)::int AS calls
      FROM ${usageEvents} WHERE ${meteredWhere(from, to, q.toolKind)}
     GROUP BY 1, 2
     ORDER BY 3 DESC, 4 DESC, 1, 2
     LIMIT ${q.limit + 1} OFFSET ${q.offset}`);
  const { items, nextOffset } = paged(res.rows, q);
  const names = await namesFor(db, items, "none");
  const imported = await db.execute<{ vendor: string; accounts: number }>(sql`
    SELECT ${importedCostLines.vendor} AS vendor, count(DISTINCT ${importedCostLines.accountKey})::int AS accounts
      FROM ${importedCostLines} JOIN ${costImportBatches} ON ${costImportBatches.id} = ${importedCostLines.batchId}
     WHERE ${liveImportedWhere(from, to)}
       AND ${importedCostLines.billingKind} = 'usage'
       AND (coalesce(${importedCostLines.quantity}, 0) > 0 OR ${importedCostLines.amount} > 0)
     GROUP BY 1
     ORDER BY 2 DESC, 1
     LIMIT ${ADOPTION_IMPORTED_VENDOR_CAP + 1}`);
  return {
    window: { from: from.toISOString(), to: to.toISOString() },
    minCohortSize: policy.minCohortSize,
    metered: {
      sourceNote: METERED_SOURCE,
      items: items.map((r, i) => {
        const users = suppressCount(Number(r.users), policy.minCohortSize);
        return {
          rank: q.offset + i + 1,
          tool: { kind: r.kind, id: r.tool_id, name: names.tools.get(`${r.kind}:${r.tool_id}`) ?? null },
          activeUsers: users.value,
          calls: users.suppressed ? null : Number(r.calls),
          suppressed: users.suppressed,
        };
      }),
      nextOffset,
    },
    imported: {
      sourceNote: IMPORTED_SOURCE,
      items: imported.rows.slice(0, ADOPTION_IMPORTED_VENDOR_CAP).map((r, i) => {
        const accounts = suppressCount(Number(r.accounts), policy.minCohortSize);
        return { rank: i + 1, vendor: r.vendor, activeAccounts: accounts.value, suppressed: accounts.suppressed };
      }),
      truncated: imported.rows.length > ADOPTION_IMPORTED_VENDOR_CAP,
    },
  };
}

/** a live imported line overlapping the window: an applied batch, not superseded */
function liveImportedWhere(from: Date, to: Date): SQL {
  return sql`${costImportBatches.status} = 'applied'
    AND ${importedCostLines.supersededAt} IS NULL
    AND ${importedCostLines.periodStart} < ${to.toISOString()}::timestamptz
    AND ${importedCostLines.periodEnd} > ${from.toISOString()}::timestamptz`;
}

export async function adoptionSeats(db: Db, raw: unknown, now: Date) {
  const q = adoptionSeatsQuerySchema.parse(raw);
  const { from, to } = resolveAdoptionWindow(q, now);
  const policy = await loadAdoptionPolicy(db);
  const vendorWhere = q.vendor ? sql` AND ${importedCostLines.vendor} = ${q.vendor}` : sql``;
  const byTeam = q.groupBy === "team";
  const res = await db.execute<{
    vendor: string;
    team_id: string | null;
    licensed: number;
    active_licensed: number;
    active_without_seat: number;
    activity_known: boolean;
  }>(sql`
    WITH live AS (
      SELECT ${importedCostLines.vendor} AS vendor, ${importedCostLines.accountKey} AS account_key,
             ${importedCostLines.resolvedUserId} AS user_id, ${importedCostLines.billingKind} AS kind,
             (${importedCostLines.billingKind} = 'usage'
               AND (coalesce(${importedCostLines.quantity}, 0) > 0 OR ${importedCostLines.amount} > 0)) AS active
        FROM ${importedCostLines} JOIN ${costImportBatches} ON ${costImportBatches.id} = ${importedCostLines.batchId}
       WHERE ${liveImportedWhere(from, to)} AND ${importedCostLines.billingKind} IN ('seat', 'usage')${vendorWhere}
    ),
    acct AS (
      SELECT vendor, account_key, bool_or(kind = 'seat') AS has_seat, bool_or(active) AS is_active,
             (array_agg(user_id) FILTER (WHERE user_id IS NOT NULL))[1] AS user_id
        FROM live GROUP BY vendor, account_key
    ),
    known AS (SELECT vendor, bool_or(kind = 'usage') AS activity_known FROM live GROUP BY vendor)
    SELECT a.vendor, ${byTeam ? sql`tm.team_id::text` : sql`NULL::text`} AS team_id,
           (count(*) FILTER (WHERE a.has_seat))::int AS licensed,
           (count(*) FILTER (WHERE a.has_seat AND a.is_active))::int AS active_licensed,
           (count(*) FILTER (WHERE a.is_active AND NOT a.has_seat))::int AS active_without_seat,
           k.activity_known
      FROM acct a JOIN known k ON k.vendor = a.vendor
      ${byTeam ? sql`LEFT JOIN ${teamMembers} tm ON tm.user_id = a.user_id` : sql``}
     GROUP BY 1, 2, k.activity_known
     ORDER BY 1, 2 NULLS LAST
     LIMIT ${q.limit + 1} OFFSET ${q.offset}`);
  const { items, nextOffset } = paged(res.rows, q);
  const teamNames = byTeam
    ? (await namesFor(db, items.map((r) => ({ kind: "", tool_id: "", group_id: r.team_id })), "team")).groups
    : new Map<string, string | null>();
  const k = policy.minCohortSize;
  return {
    source: "imported" as const,
    sourceNote: IMPORTED_SOURCE,
    window: { from: from.toISOString(), to: to.toISOString() },
    groupBy: q.groupBy,
    minCohortSize: k,
    items: items.map((r) => {
      const licensed = suppressCount(Number(r.licensed), k);
      const activeLicensed = suppressCount(Number(r.active_licensed), k);
      const idle = suppressCount(Number(r.licensed) - Number(r.active_licensed), k);
      const withoutSeat = suppressCount(Number(r.active_without_seat), k);
      const suppressed = licensed.suppressed || activeLicensed.suppressed || idle.suppressed;
      return {
        vendor: r.vendor,
        team: byTeam ? { id: r.team_id, name: r.team_id ? (teamNames.get(r.team_id) ?? null) : null } : null,
        licensed: licensed.value,
        activeLicensed: suppressed ? null : activeLicensed.value,
        idleLicensed: suppressed ? null : idle.value,
        activeWithoutSeat: withoutSeat.value,
        activityKnown: r.activity_known,
        // a ratio over a suppressed count would give the count back
        utilisation: suppressed
          ? null
          : seatUtilisation({
              licensed: Number(r.licensed),
              activeLicensed: Number(r.active_licensed),
              activeWithoutSeat: Number(r.active_without_seat),
              activityKnown: r.activity_known,
            }),
        suppressed: suppressed || withoutSeat.suppressed,
      };
    }),
    nextOffset,
  };
}

export class PerPersonRankingDisabledError extends Error {}

export async function adoptionPeople(db: Db, raw: unknown, now: Date) {
  const q = adoptionPeopleQuerySchema.parse(raw);
  const { from, to } = resolveAdoptionWindow(q, now);
  const policy = await loadAdoptionPolicy(db);
  if (!policy.perPersonRanking) throw new PerPersonRankingDisabledError();
  const res = await db.execute<{ user_id: string; name: string | null; kind: string; tool_id: string; calls: number; active_days: number }>(sql`
    SELECT ${usageEvents.userId}::text AS user_id, ${userNameSql(usageEvents.userId)} AS name,
           ${TOOL_KIND_SQL} AS kind, ${TOOL_ID_SQL} AS tool_id, count(*)::int AS calls,
           count(DISTINCT date_trunc('day', ${usageEvents.at} AT TIME ZONE 'UTC'))::int AS active_days
      FROM ${usageEvents} WHERE ${meteredWhere(from, to, q.toolKind, q.toolId)}
     GROUP BY ${usageEvents.userId}, 3, 4
     ORDER BY 5 DESC, 6 DESC, 1, 3, 4
     LIMIT ${q.limit + 1} OFFSET ${q.offset}`);
  const { items, nextOffset } = paged(res.rows, q);
  const names = await namesFor(db, items, "none");
  return {
    source: "metered" as const,
    sourceNote: METERED_SOURCE,
    window: { from: from.toISOString(), to: to.toISOString() },
    items: items.map((r, i) => ({
      rank: q.offset + i + 1,
      user: { id: r.user_id, name: r.name },
      tool: { kind: r.kind, id: r.tool_id, name: names.tools.get(`${r.kind}:${r.tool_id}`) ?? null },
      calls: Number(r.calls),
      activeDays: Number(r.active_days),
    })),
    nextOffset,
  };
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

function sendQueryError(reply: FastifyReply, e: unknown) {
  if (e instanceof AdoptionWindowError) return reply.status(400).send({ error: "bad_window", detail: e.message });
  if (e instanceof ZodError) return reply.status(400).send({ error: "invalid_query", detail: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  throw e;
}

/** Admin-only (no route here is in NON_ADMIN_ROUTES). */
export function registerAdoptionAnalyticsRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/adoption/active-users", async (req, reply) => {
    try {
      return await adoptionActiveUsers(db, req.query ?? {}, new Date());
    } catch (e) {
      return sendQueryError(reply, e);
    }
  });

  app.get("/v1/adoption/top-tools", async (req, reply) => {
    try {
      return await adoptionTopTools(db, req.query ?? {}, new Date());
    } catch (e) {
      return sendQueryError(reply, e);
    }
  });

  app.get("/v1/adoption/seats", async (req, reply) => {
    try {
      return await adoptionSeats(db, req.query ?? {}, new Date());
    } catch (e) {
      return sendQueryError(reply, e);
    }
  });

  app.get("/v1/adoption/people", async (req, reply) => {
    let out: Awaited<ReturnType<typeof adoptionPeople>>;
    try {
      out = await adoptionPeople(db, req.query ?? {}, new Date());
    } catch (e) {
      if (e instanceof PerPersonRankingDisabledError) {
        return reply.status(403).send({
          error: "per_person_ranking_disabled",
          detail: "per-person adoption ranking is off (the privacy default); an admin can turn it on at PUT /v1/adoption/policy, with a step-up and a reason",
        });
      }
      return sendQueryError(reply, e);
    }
    // a read of named people is itself evidence: who looked, at what window, how many people were shown
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NO_IDENTITY,
      objectType: "adoption_analytics",
      objectId: null,
      detail: { via: req.authCtx.via, window: out.window, rows: out.items.length, people: new Set(out.items.map((i) => i.user.id)).size },
      effect: "allow",
      ruleId: ADOPTION_PEOPLE_READ_RULE_ID,
      ruleChain: [],
      reason: `per-person adoption ranking read (${out.items.length} rows)`,
    });
    return out;
  });

  app.get("/v1/adoption/policy", async () => policyView(await loadAdoptionPolicy(db)));

  app.put("/v1/adoption/policy", async (req, reply) => {
    const parsed = setAdoptionPolicySchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendQueryError(reply, parsed.error);
    const body = parsed.data;
    const current = await loadAdoptionPolicy(db);
    const relaxed = adoptionPolicyRelaxations(body, current);
    if (!(await requireRelaxStepUp(db, req, reply, relaxed))) return reply;
    const actor = req.authCtx.userId ?? NO_IDENTITY;
    const row = await db.transaction(async (tx) => {
      await tx.insert(adoptionAnalyticsPolicy).values({ id: ADOPTION_POLICY_ID }).onConflictDoNothing();
      const [before] = await tx
        .select()
        .from(adoptionAnalyticsPolicy)
        .where(eq(adoptionAnalyticsPolicy.id, ADOPTION_POLICY_ID))
        .for("update");
      // the step-up was decided on `current`: a policy that moved since is refused, never overwritten
      if (before!.perPersonRanking !== current.perPersonRanking || before!.minCohortSize !== current.minCohortSize) return null;
      const next = {
        perPersonRanking: body.perPersonRanking ?? before!.perPersonRanking,
        minCohortSize: body.minCohortSize ?? before!.minCohortSize,
      };
      const [after] = await tx
        .update(adoptionAnalyticsPolicy)
        .set({ ...next, updatedBy: req.authCtx.userId ?? null, updatedAt: sql`now()` })
        .where(eq(adoptionAnalyticsPolicy.id, ADOPTION_POLICY_ID))
        .returning();
      const isRelaxed = Object.keys(relaxed).length > 0;
      await tx.insert(auditLog).values({
        userId: actor,
        objectType: "adoption_analytics",
        objectId: null,
        detail: {
          via: req.authCtx.via,
          from: { perPersonRanking: before!.perPersonRanking, minCohortSize: before!.minCohortSize },
          to: next,
          relaxed: isRelaxed,
          strictDefault: { ...ADOPTION_POLICY_DEFAULTS },
        },
        effect: "allow",
        ruleId: ADOPTION_POLICY_RULE_ID,
        ruleChain: [],
        reason: `adoption analytics policy set (per-person ranking ${next.perPersonRanking ? "on" : "off"}, minimum cohort ${next.minCohortSize})${isRelaxed ? " — RELAXED below the strict default" : ""}: ${body.reason}`,
      });
      return after!;
    });
    if (!row) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    return policyView({ perPersonRanking: row.perPersonRanking, minCohortSize: row.minCohortSize, updatedAt: row.updatedAt });
  });
}
