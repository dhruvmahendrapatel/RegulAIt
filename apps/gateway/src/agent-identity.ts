/**
 * ADR-0339 slice 2 — AUTHOR VS RUNNER, NON-HUMAN IDENTITY LINKS AND ORPHANED AGENTS: the gateway side.
 *
 *  - AUTHOR is read from `agent_authorship`, which the insert triggers write in the creating transaction (the request's
 *    principal for a registry agent, the owner at creation for a builder agent; `unknown` for anything older).
 *  - RUNNER is computed on read and never stored: the ADR-0188 workload identity the agent runs as (with its human
 *    sponsors), the people the ledgers saw invoking it in the window (usage events for a registry agent, chat threads
 *    for a builder agent), and, for a builder agent, whose connections its tools use and who its unattended runs run as
 *    (the owner, ADR-0172).
 *  - OWNERSHIP widens the ADR-0089 flag with `inactive`: the owner is in the directory but has not been seen (session,
 *    API key, federated sign-in; the account's creation as a floor) within AGENT_OWNER_INACTIVE_DAYS. The same flag
 *    feeds the ADR-0339 risk score's ownership factor, and `GET /v1/agent-identity/ownership-findings` lists every
 *    agent whose flag is not `owned`.
 *  - NON-HUMAN IDENTITY LINKS are staged by an admin (or later an importer) and confirmed or rejected by a SECOND,
 *    named admin with an `identity_manage` step-up; the same transaction writes the audit row. A link calls nothing on
 *    the vendor (read-only toward vendor platforms) and confers nothing.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  agentAuthorship,
  agentIdentityLinks,
  agents,
  and,
  asc,
  auditLog,
  builderAgents,
  builderThreads,
  desc,
  eq,
  gte,
  isNull,
  sql,
  usageEvents,
  users,
  workloadIdentities,
  type Db,
  type PgColumn,
  type SQL,
} from "@regulait/db";
import {
  AGENT_NHI_LINK_MACHINE,
  AGENT_OWNER_INACTIVE_DAYS,
  AGENT_OWNERSHIP_FLAGS,
  AGENT_RISK_SUBJECT_KINDS,
  agentOwnershipFlag,
  decideAgentNhiLinkSchema,
  stageAgentNhiLinkSchema,
  type AgentNhiLinkStatus,
  type AgentOwnershipFlag,
} from "@regulait/shared";
import { databaseNow } from "./db-clock.js";
import type { ListSpec } from "./list-contract.js";
import { answerListExport, answerListPage, type ContractList } from "./list-contract-route.js";
import { whereFrom } from "./state-transition.js";
import { requireStepUp } from "./step-up.js";

export const AGENT_RUNNER_WINDOW_DAYS = 30;
const RUNNER_TOP = 10;
const LINKS_MAX = 100;
const DAY_MS = 86_400_000;
const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";

type SubjectKind = (typeof AGENT_RISK_SUBJECT_KINDS)[number];
interface Subject {
  kind: SubjectKind;
  id: string;
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/**
 * When a user was last seen: the newest session, API key use or federated sign-in, never before their creation. One
 * SQL expression, so the view, the risk score and the findings list cannot disagree about who is inactive.
 */
function lastActiveSql(userId: SQL, createdAt: SQL): SQL {
  // explicit aliases: inside a correlated subquery an unqualified column would resolve to the inner table
  return sql`GREATEST(
    ${createdAt},
    (SELECT max(s.last_seen_at) FROM auth_sessions s WHERE s.user_id = ${userId}),
    (SELECT max(k.last_used_at) FROM api_keys k WHERE k.user_id = ${userId}),
    (SELECT max(f.last_login_at) FROM federated_identities f WHERE f.user_id = ${userId})
  )`;
}

/** when each user was last seen (see `lastActiveSql`) and whether they are deactivated */
export async function ownerLastActive(db: Db, userIds: ReadonlyArray<string | null>): Promise<Map<string, { disabled: boolean; lastActiveAt: Date | null }>> {
  const ids = [...new Set(userIds.filter((u): u is string => !!u))];
  const out = new Map<string, { disabled: boolean; lastActiveAt: Date | null }>();
  if (!ids.length) return out;
  const rows = (
    await db.execute<{ id: string; disabled: boolean; last_active_at: string | Date | null }>(sql`
      SELECT u.id, u.disabled_at IS NOT NULL AS disabled, ${lastActiveSql(sql`u.id`, sql`u.created_at`)} AS last_active_at
      FROM users u WHERE u.id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`)
  ).rows.map((r) => ({ id: r.id, disabled: !!r.disabled, lastActiveAt: r.last_active_at ? new Date(r.last_active_at) : null }));
  for (const r of rows) out.set(r.id, { disabled: !!r.disabled, lastActiveAt: r.lastActiveAt });
  return out;
}

/** the flag for one owner id, given the activity map (an owner id with no user row reads as orphaned) */
export function flagFor(ownerUserId: string | null, activity: Map<string, { disabled: boolean; lastActiveAt: Date | null }>, now: Date): AgentOwnershipFlag {
  if (!ownerUserId) return "unowned";
  const a = activity.get(ownerUserId);
  return agentOwnershipFlag(ownerUserId, !a || a.disabled, a?.lastActiveAt ?? null, now);
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

async function loadSubject(db: Db, s: Subject) {
  if (s.kind === "agent") {
    const [a] = await db.select({ id: agents.id, name: agents.name, ownerUserId: agents.ownerUserId }).from(agents).where(eq(agents.id, s.id));
    return a ? { ...a, connectionFormat: null as string | null } : null;
  }
  const [b] = await db
    .select({ id: builderAgents.id, name: builderAgents.name, ownerUserId: builderAgents.ownerUserId, connectionFormat: builderAgents.connectionFormat })
    .from(builderAgents)
    .where(and(eq(builderAgents.id, s.id), isNull(builderAgents.archivedAt)));
  return b ?? null;
}

const subjectCol = <T extends { agentId: unknown; builderAgentId: unknown }>(t: T, kind: SubjectKind) => (kind === "agent" ? t.agentId : t.builderAgentId);

export async function agentIdentityView(db: Db, s: Subject, now: Date) {
  const subject = await loadSubject(db, s);
  if (!subject) return null;
  const since = new Date(now.getTime() - AGENT_RUNNER_WINDOW_DAYS * DAY_MS);

  const [author] = await db
    .select({
      source: agentAuthorship.source,
      userId: agentAuthorship.authorUserId,
      displayName: users.displayName,
      vendorCreatorPseudonym: agentAuthorship.vendorCreatorPseudonym,
      recordedAt: agentAuthorship.recordedAt,
    })
    .from(agentAuthorship)
    .leftJoin(users, eq(users.id, agentAuthorship.authorUserId))
    .where(eq(subjectCol(agentAuthorship, s.kind) as typeof agentAuthorship.agentId, s.id));

  const [identity] = await db
    .select({ id: workloadIdentities.id, identifier: workloadIdentities.identifier, status: workloadIdentities.status, sponsorUserIds: workloadIdentities.sponsorUserIds })
    .from(workloadIdentities)
    .where(s.kind === "agent" ? eq(workloadIdentities.agentId, s.id) : eq(workloadIdentities.builderAgentId, s.id));

  // the people the ledgers saw running it in the window, most active first
  const invokers =
    s.kind === "agent"
      ? await db
          .select({ userId: usageEvents.userId, displayName: users.displayName, calls: sql<number>`count(*)::int` })
          .from(usageEvents)
          .leftJoin(users, eq(users.id, usageEvents.userId))
          .where(and(eq(usageEvents.agentId, s.id), gte(usageEvents.at, since)))
          .groupBy(usageEvents.userId, users.displayName)
          .orderBy(desc(sql`count(*)`), asc(usageEvents.userId))
          .limit(RUNNER_TOP + 1)
      : await db
          .select({ userId: builderThreads.userId, displayName: users.displayName, calls: sql<number>`count(*)::int` })
          .from(builderThreads)
          .leftJoin(users, eq(users.id, builderThreads.userId))
          .where(and(eq(builderThreads.agentId, s.id), gte(builderThreads.createdAt, since)))
          .groupBy(builderThreads.userId, users.displayName)
          .orderBy(desc(sql`count(*)`), asc(builderThreads.userId))
          .limit(RUNNER_TOP + 1);

  const links = await db
    .select()
    .from(agentIdentityLinks)
    .where(eq(subjectCol(agentIdentityLinks, s.kind) as typeof agentIdentityLinks.agentId, s.id))
    .orderBy(asc(agentIdentityLinks.provider), asc(agentIdentityLinks.externalId))
    .limit(LINKS_MAX);

  const activity = await ownerLastActive(db, [subject.ownerUserId]);
  const owner = subject.ownerUserId ? activity.get(subject.ownerUserId) : undefined;
  return {
    subject: { kind: s.kind, id: subject.id, name: subject.name },
    author: author
      ? { source: author.source, userId: author.userId, displayName: author.displayName ?? null, vendorCreatorPseudonym: author.vendorCreatorPseudonym, recordedAt: author.recordedAt }
      : { source: "unknown" as const, userId: null, displayName: null, vendorCreatorPseudonym: null, recordedAt: null },
    ownership: {
      flag: flagFor(subject.ownerUserId, activity, now),
      ownerUserId: subject.ownerUserId,
      ownerLastActiveAt: owner?.lastActiveAt ?? null,
      inactiveAfterDays: AGENT_OWNER_INACTIVE_DAYS,
    },
    runner: {
      workloadIdentity: identity ?? null,
      invokers: invokers.slice(0, RUNNER_TOP).map((i) => ({ userId: i.userId, displayName: i.displayName ?? null, calls: Number(i.calls) })),
      moreInvokers: invokers.length > RUNNER_TOP,
      windowDays: AGENT_RUNNER_WINDOW_DAYS,
      ...(s.kind === "builder_agent"
        ? {
            connections: subject.connectionFormat === "per_user" ? "each caller's own connections" : "the owner's shared connections",
            unattendedRunsAs: "the owner (schedules and inbound channels, ADR-0172)",
          }
        : {}),
    },
    nonHumanIdentities: links,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const subjectParams = z.object({ kind: z.enum(AGENT_RISK_SUBJECT_KINDS), subjectId: z.string().uuid() });
const linkParams = z.object({ linkId: z.string().uuid() });
const findingsFilters = z
  .object({
    kind: z.enum(AGENT_RISK_SUBJECT_KINDS).default("agent"),
    flag: z.enum(AGENT_OWNERSHIP_FLAGS.filter((f) => f !== "owned") as ["inactive", "unowned", "orphaned"]).optional(),
  })
  .strict();

interface OwnershipFinding {
  kind: SubjectKind;
  id: string;
  name: string;
  ownerUserId: string | null;
  flag: AgentOwnershipFlag;
  ownerLastActiveAt: string | null;
}

/**
 * The ADR-0089 flag (widened with `inactive`) in SQL, over a row joined to its owner: the same rule as
 * `agentOwnershipFlag`, so the findings list filters before paging instead of after. A test holds the two equal.
 */
function ownershipFlagSql(ownerUserId: PgColumn): SQL<AgentOwnershipFlag> {
  const last = lastActiveSql(sql`${users.id}`, sql`${users.createdAt}`);
  return sql<AgentOwnershipFlag>`(CASE
    WHEN ${ownerUserId} IS NULL THEN 'unowned'
    WHEN ${users.id} IS NULL OR ${users.disabledAt} IS NOT NULL THEN 'orphaned'
    WHEN ${last} < now() - make_interval(days => ${AGENT_OWNER_INACTIVE_DAYS}) THEN 'inactive'
    ELSE 'owned' END)`;
}

/** ADR-0226: the findings list under the shared list contract, one spec per agent kind (each has its own id column) */
function findingsList(db: Db, kind: SubjectKind): ContractList<OwnershipFinding, z.infer<typeof findingsFilters>> {
  const t = kind === "agent" ? agents : builderAgents;
  const live = kind === "agent" ? sql`${agents.lifecycleStatus} <> 'retired'` : isNull(builderAgents.archivedAt);
  const flag = ownershipFlagSql(t.ownerUserId);
  const spec: ListSpec<OwnershipFinding> = {
    id: `agent-ownership-findings-${kind}`,
    sorts: { name: { expr: sql`lower(${t.name})` }, flag: { expr: flag } },
    columns: {
      name: { label: "Agent", value: (r) => r.name },
      flag: { label: "Ownership", value: (r) => r.flag },
      owner: { label: "Owner", value: (r) => r.ownerUserId },
      lastActive: { label: "Owner last active", value: (r) => r.ownerLastActiveAt },
    },
    filters: ["kind", "flag"],
    defaultSort: { col: "name", dir: "asc" },
    idCol: t.id,
  };
  return {
    spec,
    filters: findingsFilters,
    reader: {
      fetch: async (q) => {
        const rows = await db
          .select({
            id: t.id,
            name: t.name,
            ownerUserId: t.ownerUserId,
            flag,
            ownerLastActiveAt: sql<string | null>`CASE WHEN ${users.id} IS NULL THEN NULL ELSE ${lastActiveSql(sql`${users.id}`, sql`${users.createdAt}`)} END`,
            _cursorAt: q.cursorAt,
          })
          .from(t)
          .leftJoin(users, eq(users.id, t.ownerUserId))
          .where(q.where)
          .orderBy(...q.orderBy)
          .limit(q.limit)
          .offset(q.offset);
        return rows.map((r) => ({ kind, ...r, ownerLastActiveAt: r.ownerLastActiveAt ? new Date(r.ownerLastActiveAt).toISOString() : null }));
      },
      countable: (where) => db.select({ one: sql`1` }).from(t).leftJoin(users, eq(users.id, t.ownerUserId)).where(where),
      idOf: (r) => r.id,
    },
    where: (_req, f) => and(live, sql`${flag} <> 'owned'`, f.flag ? sql`${flag} = ${f.flag}` : undefined),
    extra: () => ({ kind, inactiveAfterDays: AGENT_OWNER_INACTIVE_DAYS }),
  };
}

function privateNoStore(reply: FastifyReply) {
  reply.header("cache-control", "private, no-store");
}
const notFound = (reply: FastifyReply) => reply.status(404).send({ error: "not_found" });
const issues = (e: z.ZodError) => e.issues.map((i) => ({ path: i.path, message: i.message }));

async function mayRead(db: Db, req: FastifyRequest, s: Subject): Promise<boolean> {
  const subject = await loadSubject(db, s);
  if (!subject) return false;
  return !!req.authCtx.isAdmin || (!!req.authCtx.userId && subject.ownerUserId === req.authCtx.userId);
}

export function registerAgentIdentityRoutes(app: FastifyInstance, db: Db): void {
  /** Author, runner, ownership and linked non-human identities of one agent: an admin or its own steward/owner. */
  app.get("/v1/agent-identity/:kind/:subjectId", async (req, reply) => {
    privateNoStore(reply);
    const p = subjectParams.safeParse(req.params);
    if (!p.success) return notFound(reply);
    const s: Subject = { kind: p.data.kind, id: p.data.subjectId };
    if (!(await mayRead(db, req, s))) return notFound(reply);
    const view = await agentIdentityView(db, s, await databaseNow(db));
    return view ?? notFound(reply);
  });

  /**
   * Admin: agents whose owner is missing, deactivated or inactive, filtered in SQL and paged by the ADR-0226 list
   * contract (sort, cursor or offset, count). `kind` picks the agent registry or the builder agents.
   */
  const findings = { agent: findingsList(db, "agent"), builder_agent: findingsList(db, "builder_agent") } as const;
  app.get("/v1/agent-identity/ownership-findings", async (req, reply) => {
    privateNoStore(reply);
    const k = z.object({ kind: z.enum(AGENT_RISK_SUBJECT_KINDS).default("agent") }).safeParse({ kind: (req.query as { kind?: unknown } | undefined)?.kind });
    if (!k.success) return reply.status(400).send({ error: "invalid_query", issues: issues(k.error) });
    return answerListPage(db, req, reply, findings[k.data.kind]);
  });
  /** Admin: the same findings as an Excel download (ADR-0226), every matching row, with the columns on screen */
  app.get("/v1/agent-identity/ownership-findings/export.xlsx", async (req, reply) => {
    privateNoStore(reply);
    const k = z.object({ kind: z.enum(AGENT_RISK_SUBJECT_KINDS).default("agent") }).safeParse({ kind: (req.query as { kind?: unknown } | undefined)?.kind });
    if (!k.success) return reply.status(400).send({ error: "invalid_query", issues: issues(k.error) });
    return answerListExport(db, req, reply, findings[k.data.kind]);
  });

  /** Admin: stage a non-human identity link. Staged confers nothing; a second admin confirms it. Audited in the same transaction. */
  app.post("/v1/agent-identity/:kind/:subjectId/links", async (req, reply) => {
    const p = subjectParams.safeParse(req.params);
    if (!p.success) return notFound(reply);
    const body = stageAgentNhiLinkSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid_body", issues: issues(body.error) });
    const s: Subject = { kind: p.data.kind, id: p.data.subjectId };
    const subject = await loadSubject(db, s);
    if (!subject) return notFound(reply);
    const actor = req.authCtx.userId ?? null;
    try {
      const row = await db.transaction(async (tx) => {
        const [link] = await tx
          .insert(agentIdentityLinks)
          .values({
            agentId: s.kind === "agent" ? s.id : null,
            builderAgentId: s.kind === "builder_agent" ? s.id : null,
            kind: body.data.kind,
            provider: body.data.provider,
            externalId: body.data.externalId,
            source: "admin",
            note: body.data.note ?? null,
            stagedByUserId: actor,
          })
          .returning();
        await tx.insert(auditLog).values({
          userId: actor ?? SYSTEM_ACTOR,
          objectType: s.kind,
          objectId: s.id,
          detail: { phase: "agent-nhi-link-staged", linkId: link!.id, kind: link!.kind, provider: link!.provider, externalId: link!.externalId, receiptClass: "configuration" },
          effect: "allow",
          ruleId: "agent-nhi-link-staged",
          ruleChain: [],
          reason: `${link!.provider} ${link!.kind} staged for '${subject.name}'; it confers nothing until a second admin confirms it`,
        });
        return link!;
      });
      return reply.status(201).send(row);
    } catch (err) {
      const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
      if (code === "23505") return reply.status(409).send({ error: "conflict", detail: "this identity is already linked to this agent" });
      throw err;
    }
  });

  /**
   * Admin: confirm or reject a staged link. Four eyes: a named admin who did not stage it (the bootstrap credential
   * names nobody, so it cannot decide). Needs an `identity_manage` step-up bound to the link and the decision.
   */
  app.post("/v1/agent-identity/links/:linkId/decision", async (req, reply) => {
    const p = linkParams.safeParse(req.params);
    if (!p.success) return notFound(reply);
    const body = decideAgentNhiLinkSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid_body", issues: issues(body.error) });
    const [link] = await db.select().from(agentIdentityLinks).where(eq(agentIdentityLinks.id, p.data.linkId));
    if (!link) return notFound(reply);
    const event = body.data.decision === "confirmed" ? "confirm" : "reject";
    if (!AGENT_NHI_LINK_MACHINE.can(link.status as AgentNhiLinkStatus, event)) return reply.status(409).send({ error: "already_decided", status: link.status });
    const decider = req.authCtx.userId ?? null;
    if (!decider) return reply.status(403).send({ error: "named_admin_required", detail: "a link is confirmed or rejected by a named admin, not the bootstrap credential" });
    if (link.stagedByUserId === decider) {
      return reply.status(403).send({ error: "four_eyes", detail: "the admin who staged a link cannot also decide it" });
    }
    const su = await requireStepUp(db, req, reply, {
      kind: "identity_manage",
      facts: { op: "agent_nhi_link_decide", linkId: link.id, decision: body.data.decision },
    });
    if (!su.ok) return reply;
    const row = await db.transaction(async (tx) => {
      // ADR-0348: the declared machine's guard, re-checked in the UPDATE, so two deciders cannot both win
      const [updated] = await tx
        .update(agentIdentityLinks)
        .set({ status: AGENT_NHI_LINK_MACHINE.next("staged", event), decidedByUserId: decider, decidedAt: sql`now()`, decisionNote: body.data.note ?? null })
        .where(and(eq(agentIdentityLinks.id, link.id), whereFrom(agentIdentityLinks.status, AGENT_NHI_LINK_MACHINE, event)))
        .returning();
      if (!updated) return null;
      const kind: SubjectKind = updated.agentId ? "agent" : "builder_agent";
      await tx.insert(auditLog).values({
        userId: decider,
        objectType: kind,
        objectId: (updated.agentId ?? updated.builderAgentId)!,
        detail: {
          phase: "agent-nhi-link-decided",
          linkId: updated.id,
          decision: updated.status,
          provider: updated.provider,
          kind: updated.kind,
          externalId: updated.externalId,
          stagedBy: updated.stagedByUserId,
          stepUp: su.method,
          receiptClass: "configuration",
        },
        effect: "allow",
        ruleId: "agent-nhi-link-decided",
        ruleChain: [],
        reason: `${updated.provider} ${updated.kind} link ${updated.status}`,
      });
      return updated;
    });
    if (!row) return reply.status(409).send({ error: "already_decided" });
    return row;
  });
}
