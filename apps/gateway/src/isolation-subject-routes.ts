/**
 * ADR-0190 owner decisions C and D — the two isolation settings scoped to a SUBJECT (a stdio MCP server or a project)
 * rather than to the org. Registered by `registerIsolationRoutes`; every route is an admin route (`ISOLATION_ROUTES`).
 *
 *   GET /v1/execution-person-stdio-relaxations
 *   PUT /v1/execution-person-stdio-relaxations/:scopeKind/:scopeId      body { relaxed: boolean, renew?: true }
 *       Owner decision C, "a person's own stdio call": the unknown-agent floor of an `mcp_stdio` call with NO agent,
 *       made by a person in an INTERACTIVE session, lowered from L3 to L2 for one stdio MCP server or one project
 *       (never org-wide). Setting it is a relaxation: a `settings_relax` step-up, audited
 *       `execution-person-stdio-relaxed`. Clearing it is a tightening: audited
 *       `execution-person-stdio-relaxation-cleared`, no step-up. The rows are never deleted (migration 0201's
 *       guard): a cleared row keeps its id, so the decisions that relied on it still name it. Enforced in
 *       `resolveRequirement` (execution-placement.ts), never here: this only records the admin's choice.
 *       ADR-0197 Q3: a relaxation expires `PERSON_STDIO_RELAXATION_DAYS` (30) after it is set, and an expired one no
 *       longer applies (fail closed, read on the database clock). `{relaxed: true, renew: true}` renews it (in force
 *       or expired) for 30 days from now: a `settings_relax` step-up bound to the row (op `person_stdio_renew`),
 *       audited `execution-person-stdio-relaxation-renewed`. Setting `true` where the relaxation has expired is
 *       refused 409 `relaxation_expired`: the admin renews it, so the renewal is never an implied side effect.
 *
 *   GET /v1/execution-project-sensitivities
 *   PUT /v1/execution-project-sensitivities/:projectId                    body { sensitivity: ... | null }
 *       Owner decision D: the admin-set project sensitivity. The project's sensitivity for isolation is
 *       MAX(its use cases' strictest, this field), so the field can only raise it. Every change (set, change,
 *       clear) is audited `execution-project-sensitivity-set` and needs a `settings_relax` step-up (the ADR's
 *       choice: no new step-up kind). Neither present = `policy_unresolved` at placement (fail closed).
 *
 * Every write is a compare-and-set on the value the step-up decision rested on (ADR-0186 Class A): if it moved,
 * nothing is written and the answer is `409 changed_concurrently`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  aiUseCases,
  and,
  eq,
  executionPersonStdioRelaxations,
  isNull,
  mcpServers,
  projects,
  sql,
  type Db,
  type ExecutionPersonStdioRelaxationRow,
} from "@regulait/db";
import {
  PERSON_STDIO_RELAXATION_DAYS,
  PERSON_STDIO_RELAXATION_KIND,
  PERSON_STDIO_RELAXATION_SCOPES,
  PERSON_STDIO_RELAXED_FLOOR,
  PERSON_STDIO_SUBJECT_KIND,
  projectIsolationSensitivity,
  setPersonStdioRelaxationSchema,
  setProjectIsolationSensitivitySchema,
  UNKNOWN_AGENT_FLOOR,
  type PersonStdioRelaxationScope,
} from "@regulait/shared";
import { auditExecutor } from "./executor-channel.js";
import { CHANGED_CONCURRENTLY, requireStepUp } from "./step-up.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const scopeParam = z.object({ scopeKind: z.enum(PERSON_STDIO_RELAXATION_SCOPES), scopeId: z.string().uuid() });
const projectParam = z.object({ projectId: z.string().uuid() });

const uniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: { code?: string } };
  return (err?.code ?? err?.cause?.code) === "23505";
};

/** the database clock: expiry is decided on it everywhere (placement reads `expires_at > now()`) */
async function dbNow(db: Db): Promise<Date> {
  const r = (await db.execute(sql`SELECT now() AS now`)) as unknown as { rows: Array<{ now: Date | string }> };
  return new Date(r.rows[0]!.now);
}

function relaxationView(row: ExecutionPersonStdioRelaxationRow, scopeName: string | null, now: Date) {
  return {
    id: row.id,
    kind: PERSON_STDIO_RELAXATION_KIND,
    subjectKind: PERSON_STDIO_SUBJECT_KIND,
    scopeKind: row.scopeKind,
    scopeId: row.scopeId,
    scopeName,
    /** the unknown-agent floor it lowers, and what to (owner decision C: L3 to L2, never lower) */
    from: UNKNOWN_AGENT_FLOOR,
    to: PERSON_STDIO_RELAXED_FLOOR,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    /** ADR-0197 Q3: in force only before this; an expired relaxation lowers nothing until it is renewed */
    expiresAt: row.expiresAt.toISOString(),
    expired: row.expiresAt.getTime() <= now.getTime(),
    renewedByUserId: row.renewedByUserId,
    renewedAt: row.renewedAt ? row.renewedAt.toISOString() : null,
  };
}

async function activeRelaxation(db: Db, scopeKind: PersonStdioRelaxationScope, scopeId: string): Promise<ExecutionPersonStdioRelaxationRow | null> {
  const [row] = await db
    .select()
    .from(executionPersonStdioRelaxations)
    .where(and(eq(executionPersonStdioRelaxations.scopeKind, scopeKind), eq(executionPersonStdioRelaxations.scopeId, scopeId), isNull(executionPersonStdioRelaxations.clearedAt)));
  return row ?? null;
}

/**
 * Owner decision C, review fix: a server-scope relaxation is about ONE program. When a stdio server's command, args
 * or closure digest changes, its active relaxation is cleared in the caller's transaction (`cleared_by` = the actor)
 * and audited, as an ADR-0188 S8 identity opt-in is turned off when the url moves. Returns the cleared row's id, or
 * null when none was active. A project-scope relaxation is not touched: it is about the project, not the program.
 */
export async function clearServerRelaxationOnProgramChange(tx: Db, input: { serverId: string; actorUserId: string | null; label: string }): Promise<string | null> {
  const actorId = input.actorUserId ?? NO_IDENTITY;
  const [cleared] = await tx
    .update(executionPersonStdioRelaxations)
    .set({ clearedAt: sql`now()`, clearedByUserId: actorId })
    .where(and(eq(executionPersonStdioRelaxations.scopeKind, "mcp_server"), eq(executionPersonStdioRelaxations.scopeId, input.serverId), isNull(executionPersonStdioRelaxations.clearedAt)))
    .returning({ id: executionPersonStdioRelaxations.id });
  if (!cleared) return null;
  await auditExecutor(tx, {
    userId: actorId,
    objectType: "mcp_server",
    objectId: input.serverId,
    ruleId: "execution-person-stdio-relaxation-cleared",
    detail: {
      relaxationId: cleared.id,
      kind: PERSON_STDIO_RELAXATION_KIND,
      subjectKind: PERSON_STDIO_SUBJECT_KIND,
      scopeKind: "mcp_server",
      scopeId: input.serverId,
      from: PERSON_STDIO_RELAXED_FLOOR,
      to: UNKNOWN_AGENT_FLOOR,
      relaxation: false,
      cause: "stdio_program_changed",
    },
    reason: `${input.label}: its stdio program changed, so the person's own call relaxation set for the old program is cleared; calls are back at L3 (ADR-0190 owner decision C)`,
  });
  return cleared.id;
}

export function registerIsolationSubjectRoutes(app: FastifyInstance, db: Db): void {
  const actor = (req: FastifyRequest) => req.authCtx?.userId ?? NO_IDENTITY;

  /** the scope a relaxation is set on: an existing STDIO server (a remote one runs `external`) or an existing project */
  async function loadScope(req: FastifyRequest, reply: FastifyReply): Promise<{ kind: PersonStdioRelaxationScope; id: string; name: string; programDigest?: string | null } | null> {
    const p = scopeParam.safeParse(req.params);
    if (!p.success) {
      await reply.status(400).send({ error: "invalid_scope", detail: "the scope is an MCP server or a project, by id; there is no org-wide scope (ADR-0190 owner decision C)" });
      return null;
    }
    const { scopeKind, scopeId } = p.data;
    if (scopeKind === "mcp_server") {
      const [srv] = await db
        .select({ id: mcpServers.id, name: mcpServers.name, transport: mcpServers.transport, digest: mcpServers.stdioCommandDigest })
        .from(mcpServers)
        .where(eq(mcpServers.id, scopeId));
      if (!srv) {
        await reply.status(404).send({ error: "scope_not_found" });
        return null;
      }
      if (srv.transport !== "stdio") {
        await reply.status(409).send({ error: "not_a_stdio_server", detail: "a remote MCP server runs on its own host; it has no isolation floor to relax (ADR-0190 decision 3)" });
        return null;
      }
      return { kind: "mcp_server", id: srv.id, name: srv.name, programDigest: srv.digest };
    }
    const [proj] = await db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.id, scopeId));
    if (!proj) {
      await reply.status(404).send({ error: "scope_not_found" });
      return null;
    }
    return { kind: "project", id: proj.id, name: proj.name };
  }

  /**
   * ADR-0197 Q3: renew a relaxation (in force or expired, never a cleared one) for `PERSON_STDIO_RELAXATION_DAYS` from
   * now. A relaxation again: a `settings_relax` step-up bound to the row and, for a server, to the stdio program (as a
   * set is), audited with the expiry before and after. Compare-and-set on the row still uncleared.
   */
  async function renew(
    req: FastifyRequest,
    reply: FastifyReply,
    scope: { kind: PersonStdioRelaxationScope; id: string; name: string; programDigest?: string | null },
    current: ExecutionPersonStdioRelaxationRow,
  ) {
    const programDigest = scope.kind === "mcp_server" ? (scope.programDigest ?? null) : undefined;
    const su = await requireStepUp(db, req, reply, {
      kind: "settings_relax",
      facts: { op: "person_stdio_renew", relaxationId: current.id, scopeKind: scope.kind, scopeId: scope.id, ...(programDigest !== undefined ? { stdioCommandDigest: programDigest } : {}) },
    });
    if (!su.ok) return reply;
    const row = await db.transaction(async (tx) => {
      if (programDigest !== undefined) {
        const locked = await tx.execute(sql`SELECT stdio_command_digest AS d FROM mcp_servers WHERE id = ${scope.id} FOR UPDATE`);
        const now = (locked as unknown as { rows: Array<{ d: string | null }> }).rows[0];
        if (!now || now.d !== programDigest) return null;
      }
      const [renewed] = await tx
        .update(executionPersonStdioRelaxations)
        .set({ renewedAt: sql`now()`, renewedByUserId: actor(req), expiresAt: sql`now() + make_interval(days => ${PERSON_STDIO_RELAXATION_DAYS})` })
        .where(and(eq(executionPersonStdioRelaxations.id, current.id), isNull(executionPersonStdioRelaxations.clearedAt)))
        .returning();
      if (!renewed) return null;
      await auditExecutor(tx as unknown as Db, {
        userId: actor(req),
        objectType: scope.kind,
        objectId: scope.id,
        ruleId: "execution-person-stdio-relaxation-renewed",
        detail: {
          relaxationId: current.id,
          kind: PERSON_STDIO_RELAXATION_KIND,
          subjectKind: PERSON_STDIO_SUBJECT_KIND,
          scopeKind: scope.kind,
          scopeId: scope.id,
          ...(programDigest !== undefined ? { stdioCommandDigest: programDigest } : {}),
          from: UNKNOWN_AGENT_FLOOR,
          to: PERSON_STDIO_RELAXED_FLOOR,
          relaxation: true,
          previousExpiresAt: current.expiresAt.toISOString(),
          expiresAt: renewed.expiresAt.toISOString(),
          stepUp: su.method,
        },
        reason:
          `a person's own stdio call on ${scope.kind} ${scope.name} may run at L2 instead of L3 until ${renewed.expiresAt.toISOString()} ` +
          `(renewed; it was due to expire at ${current.expiresAt.toISOString()}; step-up ${su.method}) (ADR-0190 owner decision C; ADR-0197 Q3)`,
      });
      return renewed;
    });
    if (!row) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    return reply.send({ relaxation: relaxationView(row, scope.name, await dbNow(db)), changed: true, renewed: true });
  }

  // ---- owner decision C ------------------------------------------------------------------------------------------
  app.get("/v1/execution-person-stdio-relaxations", async (_req, reply) => {
    // every uncleared row, expired ones too (flagged `expired`), so an admin can see and renew them
    const rows = await db.select().from(executionPersonStdioRelaxations).where(isNull(executionPersonStdioRelaxations.clearedAt));
    const now = await dbNow(db);
    const serverNames = new Map((await db.select({ id: mcpServers.id, name: mcpServers.name }).from(mcpServers)).map((s) => [s.id, s.name]));
    const projectNames = new Map((await db.select({ id: projects.id, name: projects.name }).from(projects)).map((p) => [p.id, p.name]));
    const relaxations = rows
      .map((r) => relaxationView(r, (r.scopeKind === "mcp_server" ? serverNames.get(r.scopeId) : projectNames.get(r.scopeId)) ?? null, now))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
    return reply.send({ relaxations, default: UNKNOWN_AGENT_FLOOR, relaxedTo: PERSON_STDIO_RELAXED_FLOOR, expiresAfterDays: PERSON_STDIO_RELAXATION_DAYS });
  });

  app.put("/v1/execution-person-stdio-relaxations/:scopeKind/:scopeId", async (req, reply) => {
    const params = scopeParam.safeParse(req.params);
    const b = setPersonStdioRelaxationSchema.safeParse(req.body ?? {});
    // review LOW: an active relaxation whose server or project was deleted can still be cleared (clearing tightens and
    // needs no live scope); setting one, or a clear with nothing active, needs the scope to exist
    const orphan =
      params.success && b.success && !b.data.relaxed ? await activeRelaxation(db, params.data.scopeKind, params.data.scopeId) : null;
    const scopeNameOf = async (kind: PersonStdioRelaxationScope, id: string): Promise<string | null> =>
      kind === "mcp_server"
        ? ((await db.select({ name: mcpServers.name }).from(mcpServers).where(eq(mcpServers.id, id)))[0]?.name ?? null)
        : ((await db.select({ name: projects.name }).from(projects).where(eq(projects.id, id)))[0]?.name ?? null);
    const scope = orphan
      ? { kind: orphan.scopeKind, id: orphan.scopeId, name: (await scopeNameOf(orphan.scopeKind, orphan.scopeId)) ?? `${orphan.scopeId} (deleted)`, programDigest: undefined as string | null | undefined }
      : await loadScope(req, reply);
    if (!scope) return reply;
    if (!b.success) return reply.status(400).send({ error: "invalid_body", issues: b.error.issues });
    const current = orphan ?? (await activeRelaxation(db, scope.kind, scope.id));
    if (b.data.relaxed && b.data.renew) {
      if (!current) return reply.status(404).send({ error: "no_relaxation", detail: "there is no relaxation on this scope to renew; set one instead" });
      return renew(req, reply, scope, current);
    }
    if (b.data.relaxed) {
      if (current) {
        const now = await dbNow(db);
        if (current.expiresAt.getTime() <= now.getTime()) {
          return reply.status(409).send({
            error: "relaxation_expired",
            detail: `this relaxation expired at ${current.expiresAt.toISOString()} and no longer applies; renew it (send renew: true), which asks you to confirm it's you and is audited (ADR-0197 Q3)`,
            relaxation: relaxationView(current, scope.name, now),
          });
        }
        return reply.send({ relaxation: relaxationView(current, scope.name, now), changed: false });
      }
      // the relaxation: a fresh step-up bound to this scope (ADR-0180; owner decision C) and, for a server, to the
      // stdio program it was decided on (review: a set racing a program change never lands on the new program)
      const programDigest = scope.kind === "mcp_server" ? (scope.programDigest ?? null) : undefined;
      const su = await requireStepUp(db, req, reply, {
        kind: "settings_relax",
        facts: { op: "person_stdio_relax", scopeKind: scope.kind, scopeId: scope.id, ...(programDigest !== undefined ? { stdioCommandDigest: programDigest } : {}) },
      });
      if (!su.ok) return reply;
      let row: ExecutionPersonStdioRelaxationRow | "program_changed";
      try {
        row = await db.transaction(async (tx) => {
          if (programDigest !== undefined) {
            // compare-and-set on the program, under the server row's lock: a program-change PATCH holds the same lock
            // and clears any active relaxation in its own transaction, so neither order leaves one on the new program
            const locked = await tx.execute(sql`SELECT stdio_command_digest AS d FROM mcp_servers WHERE id = ${scope.id} FOR UPDATE`);
            const now = (locked as unknown as { rows: Array<{ d: string | null }> }).rows[0];
            if (!now || now.d !== programDigest) return "program_changed" as const;
          }
          // compare-and-set: the partial unique index admits one active row per scope, so a racing set fails here
          const [inserted] = await tx
            .insert(executionPersonStdioRelaxations)
            .values({ scopeKind: scope.kind, scopeId: scope.id, createdByUserId: actor(req), expiresAt: sql`now() + make_interval(days => ${PERSON_STDIO_RELAXATION_DAYS})` })
            .returning();
          await auditExecutor(tx as unknown as Db, {
            userId: actor(req),
            objectType: scope.kind,
            objectId: scope.id,
            ruleId: "execution-person-stdio-relaxed",
            detail: {
              relaxationId: inserted!.id,
              kind: PERSON_STDIO_RELAXATION_KIND,
              subjectKind: PERSON_STDIO_SUBJECT_KIND,
              scopeKind: scope.kind,
              scopeId: scope.id,
              ...(programDigest !== undefined ? { stdioCommandDigest: programDigest } : {}),
              from: UNKNOWN_AGENT_FLOOR,
              to: PERSON_STDIO_RELAXED_FLOOR,
              relaxation: true,
              expiresAt: inserted!.expiresAt.toISOString(),
              stepUp: su.method,
            },
            reason:
              `a person's own stdio call (no agent, interactive session only, never an API key) on ${scope.kind} ${scope.name} ` +
              `may now run at L2 instead of L3 until ${inserted!.expiresAt.toISOString()} (step-up ${su.method}); every other floor still applies (ADR-0190 owner decision C; ADR-0197 Q3)`,
          });
          return inserted!;
        });
      } catch (e) {
        if (uniqueViolation(e)) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
        throw e;
      }
      if (row === "program_changed") return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
      return reply.send({ relaxation: relaxationView(row, scope.name, await dbNow(db)), changed: true });
    }
    if (!current) return reply.send({ relaxation: null, changed: false });
    // clearing tightens: no step-up. Compare-and-set on the row read (cleared once, by the guard too)
    const cleared = await db.transaction(async (tx) => {
      const moved = await tx
        .update(executionPersonStdioRelaxations)
        .set({ clearedAt: sql`now()`, clearedByUserId: actor(req) })
        .where(and(eq(executionPersonStdioRelaxations.id, current.id), isNull(executionPersonStdioRelaxations.clearedAt)))
        .returning({ id: executionPersonStdioRelaxations.id });
      if (moved.length === 0) return false;
      await auditExecutor(tx as unknown as Db, {
        userId: actor(req),
        objectType: scope.kind,
        objectId: scope.id,
        ruleId: "execution-person-stdio-relaxation-cleared",
        detail: { relaxationId: current.id, kind: PERSON_STDIO_RELAXATION_KIND, subjectKind: PERSON_STDIO_SUBJECT_KIND, scopeKind: scope.kind, scopeId: scope.id, from: PERSON_STDIO_RELAXED_FLOOR, to: UNKNOWN_AGENT_FLOOR, relaxation: false },
        reason: `a person's own stdio call on ${scope.kind} ${scope.name} is back to the strict L3 floor (ADR-0190 owner decision C)`,
      });
      return true;
    });
    if (!cleared) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    return reply.send({ relaxation: null, changed: true });
  });

  // ---- owner decision D ------------------------------------------------------------------------------------------
  /** each project's sensitivity inputs and result (null effective = does not resolve: `policy_unresolved`) */
  async function projectSensitivityViews(onlyId?: string) {
    const list = onlyId
      ? await db.select({ id: projects.id, name: projects.name, field: projects.isolationSensitivity }).from(projects).where(eq(projects.id, onlyId))
      : await db.select({ id: projects.id, name: projects.name, field: projects.isolationSensitivity }).from(projects).orderBy(projects.name);
    const useCases = await db
      .select({ projectId: aiUseCases.projectId, s: aiUseCases.dataSensitivity })
      .from(aiUseCases)
      .where(onlyId ? eq(aiUseCases.projectId, onlyId) : sql`${aiUseCases.projectId} IS NOT NULL`);
    const byProject = new Map<string, unknown[]>();
    for (const u of useCases) if (u.projectId) byProject.set(u.projectId, [...(byProject.get(u.projectId) ?? []), u.s]);
    const relaxed = await db
      .select({ id: executionPersonStdioRelaxations.id, scopeId: executionPersonStdioRelaxations.scopeId })
      .from(executionPersonStdioRelaxations)
      .where(and(eq(executionPersonStdioRelaxations.scopeKind, "project"), isNull(executionPersonStdioRelaxations.clearedAt), sql`${executionPersonStdioRelaxations.expiresAt} > now()`));
    const relaxedBy = new Map(relaxed.map((r) => [r.scopeId, r.id]));
    return list.map((p) => {
      const cases = byProject.get(p.id) ?? [];
      return {
        projectId: p.id,
        name: p.name,
        useCaseCount: cases.length,
        /** the strictest sensitivity of the project's use cases, or null (none, or one outside the vocabulary) */
        useCaseSensitivity: cases.length > 0 ? (projectIsolationSensitivity(cases, null) ?? null) : null,
        /** the admin-set field (owner decision D), or null */
        adminSensitivity: p.field,
        /** MAX of the two; null = the fact does not resolve and an isolable call in this project is refused */
        effectiveSensitivity: projectIsolationSensitivity(cases, p.field) ?? null,
        /** owner decision C: the project-scope relaxation in force (not cleared, not expired: ADR-0197 Q3), or null */
        personStdioRelaxationId: relaxedBy.get(p.id) ?? null,
      };
    });
  }

  app.get("/v1/execution-project-sensitivities", async (_req, reply) => {
    return reply.send({ projects: await projectSensitivityViews() });
  });

  app.put("/v1/execution-project-sensitivities/:projectId", async (req, reply) => {
    const p = projectParam.safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_project_id" });
    const b = setProjectIsolationSensitivitySchema.safeParse(req.body ?? {});
    if (!b.success) return reply.status(400).send({ error: "invalid_body", issues: b.error.issues });
    const [before] = await projectSensitivityViews(p.data.projectId);
    if (!before) return reply.status(404).send({ error: "project_not_found" });
    const next = b.data.sensitivity;
    if (next === before.adminSensitivity) return reply.send({ project: before, changed: false });
    // owner decision D: every change to the field is audited and needs a fresh step-up (`settings_relax`)
    const su = await requireStepUp(db, req, reply, {
      kind: "settings_relax",
      facts: { op: "project_isolation_sensitivity", projectId: before.projectId, from: before.adminSensitivity, to: next },
    });
    if (!su.ok) return reply;
    // a use case outside the vocabulary leaves the fact unresolved whatever the field says (never masked by it)
    const useCasesUnreadable = before.useCaseCount > 0 && before.useCaseSensitivity === null;
    const effectiveAfter = useCasesUnreadable ? null : (projectIsolationSensitivity(before.useCaseSensitivity === null ? [] : [before.useCaseSensitivity], next) ?? null);
    const written = await db.transaction(async (tx) => {
      // compare-and-set on the value the step-up decision rested on (ADR-0186 Class A)
      const moved = await tx
        .update(projects)
        .set({ isolationSensitivity: next })
        .where(and(eq(projects.id, before.projectId), before.adminSensitivity === null ? isNull(projects.isolationSensitivity) : eq(projects.isolationSensitivity, before.adminSensitivity)))
        .returning({ id: projects.id });
      if (moved.length === 0) return false;
      await auditExecutor(tx as unknown as Db, {
        userId: actor(req),
        objectType: "project",
        objectId: before.projectId,
        ruleId: "execution-project-sensitivity-set",
        detail: {
          previous: before.adminSensitivity,
          sensitivity: next,
          useCaseSensitivity: before.useCaseSensitivity,
          effectiveBefore: before.effectiveSensitivity,
          effectiveAfter,
          stepUp: su.method,
        },
        reason:
          `project ${before.name}: the admin-set isolation sensitivity is now ${next ?? "not set"} (was ${before.adminSensitivity ?? "not set"}); ` +
          `effective ${effectiveAfter ?? "unresolved (calls refused policy_unresolved)"}, the MAX with its use cases' ` +
          `${before.useCaseSensitivity ?? "none"} (step-up ${su.method}; ADR-0190 owner decision D)`,
      });
      return true;
    });
    if (!written) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    const [after] = await projectSensitivityViews(before.projectId);
    return reply.send({ project: after, changed: true });
  });
}
