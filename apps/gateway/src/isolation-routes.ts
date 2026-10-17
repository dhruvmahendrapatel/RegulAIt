/**
 * ADR-0190 (batch 6 item 3) — isolation and execution profiles. The admin
 * routes the design names (`ISOLATION_ROUTES` in `@regulait/shared`,
 * `isolation/contract.ts`). Slice I1 registered every one as a 501
 * `{error: "not_built"}` stub; I2 and I3 built them all.
 *
 * Admin (every relaxing write also needs a `settings_relax` step-up and is audited):
 *   /v1/execution-profiles[...]     list, create, versions, retire (I2: BUILT)
 *   /v1/execution-profile-assignments/:targetKind/:targetId
 *                                   the profile an agent, builder agent or stdio MCP server runs under (I2: BUILT)
 *   /v1/executors[...]              register, list, inspect, attestations, quarantine,
 *                                   re-enable, revoke, the customer_declared mapping (I3: BUILT)
 *   /v1/execution-placements[...]   placement decisions and refusals (I2: BUILT)
 *   /v1/execution-person-stdio-relaxations[...], /v1/execution-project-sensitivities[...]
 *                                   owner decisions C and D (`isolation-subject-routes.ts`)
 *
 * The executor's own channel (ADR-0188 credentials, the outbound stream, its
 * reports) is `executor-channel.ts` (I3).
 *
 * I3's executor administration:
 *  - REGISTER binds one `worker_runtime` identity (active, in this
 *    deployment's environment) to a name, a backend and the classes the admin
 *    expects it to attest. The classes COUNT only once attested (decision 6).
 *  - QUARANTINE (an admin's own, code `admin`) tightens: no step-up. RE-ENABLE
 *    relaxes: `settings_relax` step-up; the executor then re-attests before
 *    taking work. REVOKE is terminal (the identity stays; a new executor needs
 *    a new identity and key).
 *  - DECLARED CLASS (OWNER DECISION 6): a customer plane maps to NO class until
 *    an admin maps it (`settings_relax` step-up, audited); `null` unmaps.
 *
 * I2's profile administration (decision 2):
 *  - A profile is an immutable, versioned record: its body is canonical JSON
 *    (RFC 8785) and its SHA-256 is the digest every placement names. A change
 *    is version n+1; a running workload keeps the version it started with.
 *  - Any field looser than the shipped `restricted` profile (or, for a new
 *    version, than the version it replaces) is a RELAXATION: a
 *    `settings_relax` step-up and an `execution-profile-relaxed` audit row
 *    naming each field (ADR-0180, ADR-0186 decision 26).
 *  - The shipped profiles are the strict reference: never versioned or
 *    retired here. Retiring a profile is a tightening (its calls then refuse
 *    `profile_retired`), so it needs no step-up; it is audited.
 *  - ASSIGNMENT (decision 7 item 5, decision 8): a profile version on an
 *    agent's workload identity or a stdio MCP server. Assigning a profile
 *    looser than the one in force, or than `restricted`, is a relaxation
 *    (step-up); every assignment is audited `execution-profile-assigned`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  agents,
  and,
  auditLog,
  builderAgents,
  desc,
  eq,
  executionOffers,
  executionPlacementReports,
  executionPlacements,
  executionProfiles,
  executorAttestations,
  executors,
  inArray,
  isNull,
  lt,
  mcpServers,
  sql,
  workloadIdentities,
  type Db,
  type ExecutionProfileRow,
  type ExecutorRow,
} from "@regulait/db";
import {
  canonicalExecutionProfile,
  createExecutionProfileSchema,
  EXECUTION_PROFILE_NAME_RE,
  EXECUTION_PROFILE_TARGET_KINDS,
  executionPlacementsQuerySchema,
  executionProfileBodySchema,
  executionProfileDigest,
  executionProfileRelaxations,
  quarantineExecutorSchema,
  registerExecutorSchema,
  RESTRICTED_EXECUTION_PROFILE,
  retireExecutionProfileSchema,
  setDeclaredClassSchema,
  setExecutionProfileAssignmentSchema,
  SHIPPED_EXECUTION_PROFILES,
  type ExecutionProfileBody,
  type ExecutionProfileTargetKind,
  type ExecutionProfileVersionView,
  type RequirableIsolationClass,
} from "@regulait/shared";
import { identityServiceFailure } from "./delegation.js";
import { auditExecutor, freshAttestation, quarantineExecutor, executorView } from "./executor-channel.js";
import { databaseNow } from "./delegation.js";
import { afterCursorDesc, atTextSql, decodeCursor, encodeCursor } from "./pagination.js";
import { deploymentEnvironment } from "./oauth/common.js";
import { CHANGED_CONCURRENTLY, requireStepUp } from "./step-up.js";
import { registerIsolationSubjectRoutes } from "./isolation-subject-routes.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const idParam = z.object({ executorId: z.string().uuid() });
const nameParam = z.object({ name: z.string().regex(EXECUTION_PROFILE_NAME_RE) });
const placementParam = z.object({ placementId: z.string().uuid() });
const targetParam = z.object({ targetKind: z.enum(EXECUTION_PROFILE_TARGET_KINDS), targetId: z.string().uuid() });
const SHIPPED_NAMES = new Set(Object.keys(SHIPPED_EXECUTION_PROFILES));

// ---------------------------------------------------------------------------
// I2: profile views
// ---------------------------------------------------------------------------

const parseBody = (row: ExecutionProfileRow): ExecutionProfileBody => executionProfileBodySchema.parse(JSON.parse(row.body));

function profileVersionView(row: ExecutionProfileRow): ExecutionProfileVersionView {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    digest: row.digest,
    minClass: row.minClass as RequirableIsolationClass,
    shipped: row.shipped,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    relaxations: executionProfileRelaxations(parseBody(row), RESTRICTED_EXECUTION_PROFILE),
  };
}

/** the shipped default an agent or stdio server runs under when nothing is assigned (decision 2: `restricted`) */
async function latestVersion(db: Db, name: string): Promise<ExecutionProfileRow | null> {
  const [row] = await db.select().from(executionProfiles).where(eq(executionProfiles.name, name)).orderBy(desc(executionProfiles.version)).limit(1);
  return row ?? null;
}

const uniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: { code?: string } };
  return (err?.code ?? err?.cause?.code) === "23505";
};

/** what an admin sees of an executor: the row plus its fresh attestations and open work */
async function adminExecutorView(db: Db, row: ExecutorRow) {
  const now = await databaseNow(db);
  const digests = await db
    .selectDistinct({ profileDigest: executorAttestations.profileDigest })
    .from(executorAttestations)
    .where(eq(executorAttestations.executorId, row.id));
  const attestations = [];
  for (const d of digests) {
    const fresh = await freshAttestation(db, row.id, d.profileDigest, now);
    attestations.push({ profileDigest: d.profileDigest, fresh: fresh !== null, ...(fresh ? { class: fresh.class, expiresAt: fresh.expiresAt.toISOString(), reportSha256: fresh.reportSha256 } : {}) });
  }
  const [open] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(executionOffers)
    .where(and(eq(executionOffers.executorId, row.id), inArray(executionOffers.status, ["offered", "accepted", "placed"])));
  return {
    ...executorView(row),
    workloadIdentityId: row.workloadIdentityId,
    runtimeVersion: row.runtimeVersion,
    declaredClass: row.declaredClass,
    quarantinedAt: row.quarantinedAt?.toISOString() ?? null,
    reenabledAt: row.reenabledAt?.toISOString() ?? null,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    attestations,
    openOffers: open?.n ?? 0,
    /** what every piece of this evidence is (OWNER DECISION 5) */
    attestationStrength: "software_attested" as const,
  };
}

export function registerIsolationRoutes(app: FastifyInstance, db: Db): void {
  // owner decisions C and D: the person's own stdio relaxation and the admin-set project sensitivity
  registerIsolationSubjectRoutes(app, db);
  const actor = (req: FastifyRequest) => req.authCtx?.userId ?? NO_IDENTITY;
  const byId = async (req: FastifyRequest, reply: FastifyReply): Promise<ExecutorRow | null> => {
    const p = idParam.safeParse(req.params);
    if (!p.success) {
      await reply.status(400).send({ error: "invalid_executor_id" });
      return null;
    }
    const [row] = await db.select().from(executors).where(eq(executors.id, p.data.executorId));
    if (!row) {
      await reply.status(404).send({ error: "executor_not_found" });
      return null;
    }
    return row;
  };

  // ---- execution profiles (I2) ---------------------------------------------
  app.get("/v1/execution-profiles", async (_req, reply) => {
    const rows = await db.select().from(executionProfiles).orderBy(executionProfiles.name, desc(executionProfiles.version));
    return reply.send({ profiles: rows.map(profileVersionView), reference: "restricted" });
  });

  app.get("/v1/execution-profiles/:name", async (req, reply) => {
    const p = nameParam.safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_profile_name" });
    const rows = await db.select().from(executionProfiles).where(eq(executionProfiles.name, p.data.name)).orderBy(desc(executionProfiles.version));
    if (rows.length === 0) return reply.status(404).send({ error: "execution_profile_not_found" });
    return reply.send({ name: p.data.name, versions: rows.map((r) => ({ ...profileVersionView(r), body: parseBody(r) })) });
  });

  /** create version 1, or version n+1 of `name`; every relaxation is a step-up and an audited relaxation */
  async function writeVersion(req: FastifyRequest, reply: FastifyReply, name: string | null) {
    const parsed = createExecutionProfileSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", issues: parsed.error.issues });
    const body = parsed.data.body;
    if (name !== null && body.name !== name) return reply.status(400).send({ error: "profile_name_mismatch", detail: "the body names another profile" });
    const latest = await latestVersion(db, body.name);
    if (name === null && latest) return reply.status(409).send({ error: "execution_profile_exists", detail: "a profile of that name exists; add a version instead" });
    if (name !== null && !latest) return reply.status(404).send({ error: "execution_profile_not_found" });
    if (SHIPPED_NAMES.has(body.name)) return reply.status(409).send({ error: "shipped_profile_immutable", detail: "a shipped profile is the strict reference; create a profile of your own" });
    if (latest?.retiredAt) return reply.status(409).send({ error: "execution_profile_retired", detail: "a retired profile is not versioned again" });
    const text = canonicalExecutionProfile(body);
    const digest = executionProfileDigest(body);
    const [same] = await db.select({ id: executionProfiles.id }).from(executionProfiles).where(eq(executionProfiles.digest, digest));
    if (same) return reply.status(409).send({ error: "execution_profile_unchanged", detail: "a version with this exact body exists" });
    // judged against the strict reference AND the version it replaces (ADR-0186 decision 26)
    const vsRestricted = executionProfileRelaxations(body, RESTRICTED_EXECUTION_PROFILE);
    const vsPrevious = latest ? executionProfileRelaxations(body, parseBody(latest)) : [];
    const relaxations = [...new Set([...vsRestricted, ...vsPrevious])];
    let stepUp: string | null = null;
    if (relaxations.length > 0) {
      const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { op: name === null ? "execution_profile_create" : "execution_profile_version", name: body.name, digest, relaxations } });
      if (!su.ok) return reply;
      stepUp = su.method;
    }
    const version = (latest?.version ?? 0) + 1;
    let row: ExecutionProfileRow;
    try {
      [row] = (await db
        .insert(executionProfiles)
        .values({ name: body.name, version, body: text, digest, minClass: body.minClass, shipped: false, createdBy: req.authCtx?.userId ?? null })
        .returning()) as [ExecutionProfileRow];
    } catch (e) {
      // a concurrent version took the number (the guard serialises versioning per name)
      if (uniqueViolation(e) || String((e as Error)?.message ?? "").includes("must be version")) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
      throw e;
    }
    await auditExecutor(db, {
      userId: actor(req),
      objectType: "execution_profile",
      objectId: row.id,
      ruleId: version === 1 ? "execution-profile-created" : "execution-profile-versioned",
      detail: { name: row.name, version, digest, minClass: row.minClass, previousDigest: latest?.digest ?? null, relaxations },
      reason: `execution profile ${row.name} v${version} (${row.minClass}) ${version === 1 ? "created" : "versioned"}; digest ${digest.slice(0, 12)} (ADR-0190 decision 2)`,
    });
    if (relaxations.length > 0) {
      await auditExecutor(db, {
        userId: actor(req),
        objectType: "execution_profile",
        objectId: row.id,
        ruleId: "execution-profile-relaxed",
        detail: { name: row.name, version, digest, relaxedAgainstRestricted: vsRestricted, relaxedAgainstPrevious: vsPrevious, stepUp },
        reason: `execution profile ${row.name} v${version} is looser than ${vsPrevious.length > 0 ? "the version it replaces" : "the shipped restricted profile"} in: ${relaxations.join(", ")} (ADR-0180; step-up ${stepUp})`,
      });
    }
    return reply.status(201).send({ ...profileVersionView(row), body: parseBody(row) });
  }

  app.post("/v1/execution-profiles", async (req, reply) => writeVersion(req, reply, null));

  app.post("/v1/execution-profiles/:name/versions", async (req, reply) => {
    const p = nameParam.safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_profile_name" });
    return writeVersion(req, reply, p.data.name);
  });

  app.post("/v1/execution-profiles/:name/retire", async (req, reply) => {
    const p = nameParam.safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_profile_name" });
    const b = retireExecutionProfileSchema.safeParse(req.body ?? {});
    if (!b.success) return reply.status(400).send({ error: "invalid_body", issues: b.error.issues });
    if (SHIPPED_NAMES.has(p.data.name)) return reply.status(409).send({ error: "shipped_profile_immutable", detail: "a shipped profile is the strict reference and is never retired" });
    const latest = await latestVersion(db, p.data.name);
    if (!latest) return reply.status(404).send({ error: "execution_profile_not_found" });
    // retiring tightens (its calls refuse `profile_retired`, decision 7): no step-up, audited
    const retired = await db
      .update(executionProfiles)
      .set({ retiredAt: sql`now()`, retiredBy: req.authCtx?.userId ?? null })
      .where(and(eq(executionProfiles.name, p.data.name), isNull(executionProfiles.retiredAt)))
      .returning();
    if (retired.length === 0) return reply.status(409).send({ error: "execution_profile_retired" });
    const ids = retired.map((r) => r.id);
    const [assigned] = await db.execute<{ n: number }>(
      sql`select ((select count(*) from ${workloadIdentities} where ${inArray(workloadIdentities.executionProfileId, ids)}) + (select count(*) from ${mcpServers} where ${inArray(mcpServers.executionProfileId, ids)}))::int as n`,
    ).then((r) => r.rows);
    await auditExecutor(db, {
      userId: actor(req),
      objectType: "execution_profile",
      objectId: latest.id,
      ruleId: "execution-profile-retired",
      effect: "deny",
      detail: { name: p.data.name, retiredVersions: retired.map((r) => ({ version: r.version, digest: r.digest })), assignmentsNowRefused: assigned?.n ?? 0 },
      reason: `execution profile ${p.data.name} retired (${retired.length} version(s)); calls placed under it now refuse profile_retired, with no fallback (ADR-0190 decision 7)`,
    });
    const rows = await db.select().from(executionProfiles).where(eq(executionProfiles.name, p.data.name)).orderBy(desc(executionProfiles.version));
    return reply.send({ name: p.data.name, versions: rows.map(profileVersionView), assignmentsNowRefused: assigned?.n ?? 0 });
  });

  // ---- profile assignments (I2: decision 7 item 5, decision 8) --------------
  type Target =
    | { kind: "agent" | "builder_agent"; id: string; identityId: string; current: string | null }
    | { kind: "mcp_server"; id: string; current: string | null };
  async function loadTarget(req: FastifyRequest, reply: FastifyReply): Promise<Target | null> {
    const p = targetParam.safeParse(req.params);
    if (!p.success) {
      await reply.status(400).send({ error: "invalid_target" });
      return null;
    }
    const { targetKind, targetId } = p.data;
    if (targetKind === "mcp_server") {
      const [srv] = await db.select({ id: mcpServers.id, transport: mcpServers.transport, current: mcpServers.executionProfileId }).from(mcpServers).where(eq(mcpServers.id, targetId));
      if (!srv) {
        await reply.status(404).send({ error: "target_not_found" });
        return null;
      }
      if (srv.transport !== "stdio") {
        await reply.status(409).send({ error: "not_a_stdio_server", detail: "a remote MCP server runs on its own host; its execution is recorded as external, never a class (ADR-0190 decision 3)" });
        return null;
      }
      return { kind: "mcp_server", id: srv.id, current: srv.current };
    }
    const exists =
      targetKind === "agent"
        ? (await db.select({ id: agents.id }).from(agents).where(eq(agents.id, targetId)))[0]
        : (await db.select({ id: builderAgents.id }).from(builderAgents).where(and(eq(builderAgents.id, targetId), isNull(builderAgents.archivedAt))))[0];
    if (!exists) {
      await reply.status(404).send({ error: "target_not_found" });
      return null;
    }
    const col = targetKind === "agent" ? workloadIdentities.agentId : workloadIdentities.builderAgentId;
    const [ident] = await db.select({ id: workloadIdentities.id, status: workloadIdentities.status, current: workloadIdentities.executionProfileId }).from(workloadIdentities).where(eq(col, targetId));
    if (!ident) {
      await reply.status(409).send({ error: "no_workload_identity", detail: "the agent has no ADR-0188 workload identity: it is an unknown agent and runs only under the most restrictive profile (ADR-0190 decision 7 item 5)" });
      return null;
    }
    return { kind: targetKind, id: targetId, identityId: ident.id, current: ident.current };
  }
  const byProfileId = async (id: string) => (await db.select().from(executionProfiles).where(eq(executionProfiles.id, id)))[0] ?? null;
  async function effectiveFor(current: string | null): Promise<ExecutionProfileRow | null> {
    return current ? byProfileId(current) : latestVersion(db, "restricted");
  }
  const assignmentView = async (t: Target) => {
    const assigned = t.current ? await byProfileId(t.current) : null;
    const effective = await effectiveFor(t.current);
    return {
      target: { kind: t.kind, id: t.id },
      assigned: assigned ? profileVersionView(assigned) : null,
      effective: effective ? profileVersionView(effective) : null,
      /** where the effective profile comes from */
      source: assigned ? "assigned" : "shipped_default",
      /** an unknown or low-assurance agent still runs only under the most restrictive profile (decision 7 item 5) */
      unknownAgentProfile: "restricted-microvm",
    };
  };

  app.get("/v1/execution-profile-assignments/:targetKind/:targetId", async (req, reply) => {
    const t = await loadTarget(req, reply);
    if (!t) return reply;
    return reply.send(await assignmentView(t));
  });

  app.put("/v1/execution-profile-assignments/:targetKind/:targetId", async (req, reply) => {
    const t = await loadTarget(req, reply);
    if (!t) return reply;
    const b = setExecutionProfileAssignmentSchema.safeParse(req.body ?? {});
    if (!b.success) return reply.status(400).send({ error: "invalid_body", issues: b.error.issues });
    const next = b.data.profileId ? await byProfileId(b.data.profileId) : null;
    if (b.data.profileId && !next) return reply.status(404).send({ error: "execution_profile_not_found" });
    if (next?.retiredAt) return reply.status(409).send({ error: "execution_profile_retired" });
    const nextEffective = next ?? (await latestVersion(db, "restricted"));
    if (!nextEffective) return reply.status(409).send({ error: "execution_profile_not_found", detail: "the shipped restricted profile is missing" });
    const kind = t.kind === "mcp_server" ? "mcp_stdio" : null;
    if (next && kind && !parseBody(next).workloadKinds.includes(kind)) {
      return reply.status(409).send({ error: "profile_not_for_workload", detail: "the profile does not run mcp_stdio workloads" });
    }
    if ((b.data.profileId ?? null) === t.current) return reply.send(await assignmentView(t));
    // a relaxation against the profile in force AND the strict reference (ADR-0186 decision 26)
    const currentEffective = await effectiveFor(t.current);
    const nextBody = parseBody(nextEffective);
    const relaxations = [
      ...new Set([
        ...executionProfileRelaxations(nextBody, RESTRICTED_EXECUTION_PROFILE),
        ...(currentEffective ? executionProfileRelaxations(nextBody, parseBody(currentEffective)) : []),
      ]),
    ];
    let stepUp: string | null = null;
    if (relaxations.length > 0) {
      const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { op: "execution_profile_assign", targetKind: t.kind, targetId: t.id, profileId: b.data.profileId, relaxations } });
      if (!su.ok) return reply;
      stepUp = su.method;
    }
    // compare-and-set on the value the decision rested on (ADR-0186 Class A)
    const moved =
      t.kind === "mcp_server"
        ? await db
            .update(mcpServers)
            .set({ executionProfileId: b.data.profileId })
            .where(and(eq(mcpServers.id, t.id), t.current === null ? isNull(mcpServers.executionProfileId) : eq(mcpServers.executionProfileId, t.current)))
            .returning({ id: mcpServers.id })
        : await db
            .update(workloadIdentities)
            .set({ executionProfileId: b.data.profileId, updatedAt: sql`now()` })
            .where(and(eq(workloadIdentities.id, t.identityId), t.current === null ? isNull(workloadIdentities.executionProfileId) : eq(workloadIdentities.executionProfileId, t.current)))
            .returning({ id: workloadIdentities.id });
    if (moved.length === 0) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    await auditExecutor(db, {
      userId: actor(req),
      objectType: "execution_profile",
      objectId: nextEffective.id,
      ruleId: "execution-profile-assigned",
      detail: {
        targetKind: t.kind,
        targetId: t.id,
        ...(t.kind === "mcp_server" ? {} : { workloadIdentityId: t.identityId }),
        previousProfileId: t.current,
        profileId: b.data.profileId,
        effectiveName: nextEffective.name,
        effectiveVersion: nextEffective.version,
        effectiveDigest: nextEffective.digest,
        relaxations,
        stepUp,
      },
      reason:
        `${t.kind} ${t.id} now runs its isolable workloads under ${nextEffective.name} v${nextEffective.version} (${nextEffective.minClass})` +
        (b.data.profileId ? "" : ", the shipped default") +
        (relaxations.length > 0 ? `; looser in: ${relaxations.join(", ")} (step-up ${stepUp})` : "") +
        " (ADR-0190 decisions 7 and 8)",
    });
    return reply.send(await assignmentView({ ...t, current: b.data.profileId } as Target));
  });

  // executors (I3)
  app.get("/v1/executors", async (_req, reply) => {
    const rows = await db.select().from(executors).orderBy(executors.name);
    const out = [];
    for (const row of rows) out.push(await adminExecutorView(db, row));
    return reply.send({ executors: out });
  });

  app.post("/v1/executors", async (req, reply) => {
    const body = registerExecutorSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid_body", issues: body.error.issues });
    const [ident] = await db.select().from(workloadIdentities).where(eq(workloadIdentities.id, body.data.workloadIdentityId));
    if (!ident || ident.kind !== "worker_runtime") return reply.status(400).send({ error: "identity_not_worker_runtime", detail: "an executor authenticates as an ADR-0188 worker_runtime identity" });
    const service = identityServiceFailure({ ...ident, agentHaltedAt: null, agentLifecycle: null, agentEnabled: true, builderArchivedAt: null, runnerRevokedAt: null }, deploymentEnvironment());
    if (service) return reply.status(400).send({ error: "identity_not_in_service", code: service });
    const [existing] = await db.select({ id: executors.id }).from(executors).where(eq(executors.workloadIdentityId, ident.id));
    if (existing) return reply.status(409).send({ error: "identity_already_registered", executorId: existing.id });
    const [byName] = await db.select({ id: executors.id }).from(executors).where(eq(executors.name, body.data.name));
    if (byName) return reply.status(409).send({ error: "executor_name_taken" });
    const [row] = await db
      .insert(executors)
      .values({
        workloadIdentityId: ident.id,
        name: body.data.name,
        backend: body.data.backend,
        runtimeVersion: body.data.runtimeVersion,
        classesDeclared: body.data.classesDeclared,
        createdBy: req.authCtx?.userId ?? null,
      })
      .returning();
    await auditExecutor(db, {
      userId: actor(req),
      objectType: "executor",
      objectId: row!.id,
      ruleId: "executor-registered",
      detail: { executorName: row!.name, backend: row!.backend, classesDeclared: row!.classesDeclared, workloadIdentityId: ident.id, identifier: ident.identifier },
      reason: `executor ${row!.name} (${row!.backend}) registered against identity ${ident.identifier}; its classes count only once attested (ADR-0190 decisions 4 and 6)`,
    });
    return reply.status(201).send(await adminExecutorView(db, row!));
  });

  app.get("/v1/executors/:executorId", async (req, reply) => {
    const row = await byId(req, reply);
    if (!row) return reply;
    return reply.send(await adminExecutorView(db, row));
  });

  app.get("/v1/executors/:executorId/attestations", async (req, reply) => {
    const row = await byId(req, reply);
    if (!row) return reply;
    const rows = await db
      .select()
      .from(executorAttestations)
      .where(eq(executorAttestations.executorId, row.id))
      .orderBy(desc(executorAttestations.observedAt), desc(executorAttestations.createdAt))
      .limit(100);
    return reply.send({
      attestations: rows.map((a) => ({
        id: a.id,
        profileDigest: a.profileDigest,
        class: a.class,
        verdict: a.verdict,
        reportSha256: a.reportSha256,
        report: a.report,
        observedAt: a.observedAt.toISOString(),
        expiresAt: a.expiresAt.toISOString(),
      })),
      attestationStrength: "software_attested",
    });
  });

  app.post("/v1/executors/:executorId/quarantine", async (req, reply) => {
    const row = await byId(req, reply);
    if (!row) return reply;
    const body = quarantineExecutorSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid_body", issues: body.error.issues });
    if (row.status === "revoked") return reply.status(409).send({ error: "executor_revoked" });
    if (row.status === "quarantined") return reply.status(409).send({ error: "executor_already_quarantined", quarantineCode: row.quarantineCode });
    await quarantineExecutor(db, row.id, "admin", { actorUserId: actor(req) });
    const [after] = await db.select().from(executors).where(eq(executors.id, row.id));
    return reply.send(await adminExecutorView(db, after!));
  });

  app.post("/v1/executors/:executorId/reenable", async (req, reply) => {
    const row = await byId(req, reply);
    if (!row) return reply;
    if (row.status !== "quarantined") return reply.status(409).send({ error: "executor_not_quarantined", status: row.status });
    // re-enabling restores the classes a quarantine withdrew: a relaxation, with the step-up every relaxation needs
    const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { op: "executor_reenable", executorId: row.id, quarantineCode: row.quarantineCode } });
    if (!su.ok) return reply;
    // amendment T: `reenabled_at` (database clock) voids every earlier attestation; the executor must pass again
    const [moved] = await db
      .update(executors)
      .set({ status: "active", quarantineCode: null, quarantinedAt: null, reenabledAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(executors.id, row.id), eq(executors.status, "quarantined")))
      .returning();
    // review L4: a concurrent re-enable (or revoke) moved the row first: nothing changed here, so nothing is audited
    if (!moved) {
      const [now] = await db.select({ status: executors.status }).from(executors).where(eq(executors.id, row.id));
      return reply.status(409).send({ error: "executor_not_quarantined", status: now?.status ?? row.status });
    }
    await auditExecutor(db, {
      userId: actor(req),
      objectType: "executor",
      objectId: row.id,
      ruleId: "executor-reenabled",
      detail: { executorName: row.name, backend: row.backend, previousQuarantineCode: row.quarantineCode, reenabledAt: moved.reenabledAt?.toISOString() ?? null, stepUp: su.method },
      reason: `executor ${row.name} re-enabled by an admin after quarantine (${row.quarantineCode}); its earlier attestations no longer count and it takes no work before a new self-test pass (ADR-0190 decision 6, amendment T)`,
    });
    return reply.send(await adminExecutorView(db, moved));
  });

  app.post("/v1/executors/:executorId/revoke", async (req, reply) => {
    const row = await byId(req, reply);
    if (!row) return reply;
    if (row.status === "revoked") return reply.status(409).send({ error: "executor_already_revoked" });
    if (row.status === "active") await quarantineExecutor(db, row.id, "admin", { actorUserId: actor(req), detail: { beforeRevoke: true } });
    // a revoke also withdraws what a quarantine left open (an offer accepted while the row moved)
    await db.update(executors).set({ status: "revoked", updatedAt: sql`now()` }).where(and(eq(executors.id, row.id), sql`${executors.status} <> 'revoked'`));
    await auditExecutor(db, {
      userId: actor(req),
      objectType: "executor",
      objectId: row.id,
      ruleId: "executor-revoked",
      effect: "deny",
      detail: { executorName: row.name, backend: row.backend, workloadIdentityId: row.workloadIdentityId },
      reason: `executor ${row.name} revoked by an admin: terminal; a new executor needs a new identity and key (ADR-0190 decision 13)`,
    });
    const [after] = await db.select().from(executors).where(eq(executors.id, row.id));
    return reply.send(await adminExecutorView(db, after!));
  });

  app.put("/v1/executors/:executorId/declared-class", async (req, reply) => {
    const row = await byId(req, reply);
    if (!row) return reply;
    const body = setDeclaredClassSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid_body", issues: body.error.issues });
    if (row.backend !== "customer") return reply.status(409).send({ error: "not_a_customer_plane", detail: "only a customer_declared plane is mapped to a class (OWNER DECISION 6)" });
    if (row.status === "revoked") return reply.status(409).send({ error: "executor_revoked" });
    // mapping a declaration to a class is the relaxation (the strict default maps to nothing); unmapping is not
    if (body.data.class !== null) {
      const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { op: "executor_declared_class", executorId: row.id, class: body.data.class } });
      if (!su.ok) return reply;
    }
    await db.update(executors).set({ declaredClass: body.data.class, updatedAt: sql`now()` }).where(eq(executors.id, row.id));
    await auditExecutor(db, {
      userId: actor(req),
      objectType: "executor",
      objectId: row.id,
      ruleId: "executor-declared-class-set",
      effect: body.data.class === null ? "deny" : "allow",
      detail: { executorName: row.name, previous: row.declaredClass, class: body.data.class, relaxation: body.data.class !== null },
      reason:
        body.data.class === null
          ? `the customer plane ${row.name} is unmapped: its declared isolation satisfies no class (OWNER DECISION 6, the strict default)`
          : `the customer plane ${row.name} is mapped to ${body.data.class} by an admin; its evidence says "declared", never "verified" (OWNER DECISION 6)`,
    });
    const [after] = await db.select().from(executors).where(eq(executors.id, row.id));
    return reply.send(await adminExecutorView(db, after!));
  });

  // ---- placements (I2) ---------------------------------------------------------
  // I4 (migration 0198): a governed stdio decision's row is `offered`; how it ended is its linked report row. The
  // view shows the EFFECTIVE outcome (the report's, else `offered`: still awaiting the sandbox's report), and names
  // the decision-time evidence (image, runtime flags hash, attestation) beside it.
  const placementView = (r: {
    placement: typeof executionPlacements.$inferSelect;
    report: typeof executionPlacementReports.$inferSelect | null;
    profileName: string | null;
    profileVersion: number | null;
    executorName: string | null;
  }) => ({
    id: r.placement.id,
    auditId: r.placement.auditId,
    workloadKind: r.placement.workloadKind,
    requiredClass: r.placement.requiredClass,
    requiredBy: r.placement.requiredBy,
    enforcement: r.placement.enforcement,
    profileDigest: r.placement.profileDigest,
    profileName: r.profileName,
    profileVersion: r.profileVersion,
    executorId: r.placement.executorId,
    executorName: r.executorName,
    appliedClass: r.report?.appliedClass ?? r.placement.appliedClass,
    reportSha256: r.report?.reportSha256 ?? r.placement.reportSha256,
    outcome: r.report?.outcome ?? r.placement.outcome,
    refusalCode: r.report?.refusalCode ?? r.placement.refusalCode,
    imageDigest: r.placement.imageDigest,
    runtimeFlagsSha256: r.placement.runtimeFlagsSha256,
    attestationId: r.placement.attestationId,
    decidedAs: r.placement.outcome,
    createdAt: r.placement.createdAt.toISOString(),
  });
  const placementSelect = () =>
    db
      .select({
        placement: executionPlacements,
        report: executionPlacementReports,
        profileName: executionProfiles.name,
        profileVersion: executionProfiles.version,
        executorName: executors.name,
        // the keyset cursor's microsecond-exact instant (pagination.ts)
        atText: atTextSql(executionPlacements.createdAt),
      })
      .from(executionPlacements)
      .leftJoin(executionPlacementReports, eq(executionPlacementReports.placementId, executionPlacements.id))
      .leftJoin(executionProfiles, eq(executionProfiles.digest, executionPlacements.profileDigest))
      .leftJoin(executors, eq(executors.id, executionPlacements.executorId));

  app.get("/v1/execution-placements", async (req, reply) => {
    const q = executionPlacementsQuerySchema.safeParse(req.query ?? {});
    if (!q.success) return reply.status(400).send({ error: "invalid_query", issues: q.error.issues });
    const { limit, outcome, workloadKind, reason, before } = q.data;
    // N11: an `(at, id)` keyset cursor per list, so rows sharing the last row's instant are never skipped
    const cursor = q.data.cursor ? decodeCursor(q.data.cursor) : null;
    const refusalsCursor = q.data.refusalsCursor ? decodeCursor(q.data.refusalsCursor) : null;
    if ((q.data.cursor && !cursor) || (q.data.refusalsCursor && !refusalsCursor)) return reply.status(400).send({ error: "invalid_cursor" });
    const continuing = cursor !== null || refusalsCursor !== null;
    const conds = [
      // the effective outcome: a linked report's, else the row's own
      outcome ? sql`coalesce(${executionPlacementReports.outcome}, ${executionPlacements.outcome}) = ${outcome}` : undefined,
      workloadKind ? eq(executionPlacements.workloadKind, workloadKind) : undefined,
      reason ? sql`coalesce(${executionPlacementReports.refusalCode}, ${executionPlacements.refusalCode}) = ${reason}` : undefined,
      before ? lt(executionPlacements.createdAt, new Date(before)) : undefined,
      cursor ? afterCursorDesc(executionPlacements.createdAt, executionPlacements.id, cursor) : undefined,
    ].filter((c) => c !== undefined);
    // one extra row decides whether there is a next page
    const fetched =
      !continuing || cursor
        ? await placementSelect()
            .where(conds.length ? and(...conds) : undefined)
            .orderBy(desc(executionPlacements.createdAt), desc(executionPlacements.id))
            .limit(limit + 1)
        : [];
    const rows = fetched.slice(0, limit);
    const lastRow = fetched.length > limit ? rows[rows.length - 1] : undefined;
    // refusals decided before any placement row could be written (policy_unresolved; a digest no profile names):
    // they exist only as audit rows, and are listed so none is hidden (owner decision B)
    const showUnrecorded = (!continuing || refusalsCursor !== null) && (!outcome || outcome === "refused");
    const unrecordedFetched =
      showUnrecorded && !workloadKind && (!reason || reason === "policy_unresolved" || reason === "profile_retired")
        ? await db
            .select({ id: auditLog.id, at: auditLog.at, detail: auditLog.detail, reason: auditLog.reason, atText: atTextSql(auditLog.at) })
            .from(auditLog)
            .where(
              and(
                eq(auditLog.objectType, "execution_placement"),
                eq(auditLog.ruleId, "execution-refused"),
                isNull(auditLog.objectId),
                ...(reason ? [sql`${auditLog.detail} ->> 'code' = ${reason}`] : []),
                ...(before ? [lt(auditLog.at, new Date(before))] : []),
                ...(refusalsCursor ? [afterCursorDesc(auditLog.at, auditLog.id, refusalsCursor)] : []),
              ),
            )
            .orderBy(desc(auditLog.at), desc(auditLog.id))
            .limit(limit + 1)
        : [];
    const unrecorded = unrecordedFetched.slice(0, limit);
    const lastUnrecorded = unrecordedFetched.length > limit ? unrecorded[unrecorded.length - 1] : undefined;
    return reply.send({
      placements: rows.map(placementView),
      refusalsWithoutPlacement: unrecorded.map((a) => {
        const d = (a.detail ?? {}) as Record<string, unknown>;
        return {
          auditId: a.id,
          at: a.at.toISOString(),
          code: typeof d.code === "string" ? d.code : null,
          unresolvedFact: typeof d.unresolvedFact === "string" ? d.unresolvedFact : null,
          workloadKind: typeof d.workloadKind === "string" ? d.workloadKind : null,
          reason: a.reason,
        };
      }),
      nextCursor: lastRow ? encodeCursor({ at: lastRow.atText, id: lastRow.placement.id }) : null,
      refusalsNextCursor: lastUnrecorded ? encodeCursor({ at: lastUnrecorded.atText, id: lastUnrecorded.id }) : null,
      attestationStrength: "software_attested",
    });
  });

  app.get("/v1/execution-placements/:placementId", async (req, reply) => {
    const p = placementParam.safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_placement_id" });
    const [row] = await placementSelect().where(eq(executionPlacements.id, p.data.placementId));
    if (!row) return reply.status(404).send({ error: "placement_not_found" });
    const [audit] = await db
      .select({ id: auditLog.id, at: auditLog.at, ruleId: auditLog.ruleId, effect: auditLog.effect, reason: auditLog.reason, detail: auditLog.detail })
      .from(auditLog)
      .where(eq(auditLog.id, row.placement.auditId));
    return reply.send({
      ...placementView(row),
      audit: audit ? { id: audit.id, at: audit.at.toISOString(), ruleId: audit.ruleId, effect: audit.effect, reason: audit.reason, detail: audit.detail } : null,
      attestationStrength: "software_attested",
    });
  });
}
