/**
 * ADR-0190 (batch 6 item 3) — isolation and execution profiles. The admin
 * routes the design names (`ISOLATION_ROUTES` in `@regulait/shared`,
 * `isolation/contract.ts`). Slice I1 registered every one as a 501
 * `{error: "not_built"}` stub; each slice replaces its own.
 *
 * Admin (every relaxing write also needs a `settings_relax` step-up and is audited):
 *   /v1/execution-profiles[...]     list, create, versions, retire (I2: still stubs)
 *   /v1/executors[...]              register, list, inspect, attestations, quarantine,
 *                                   re-enable, revoke, the customer_declared mapping (I3: BUILT)
 *   /v1/execution-placements[...]   placement decisions and refusals (I2: still stubs)
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
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, desc, eq, executionOffers, executorAttestations, executors, inArray, sql, workloadIdentities, type Db, type ExecutorRow } from "@regulait/db";
import { ISOLATION_NOT_BUILT, quarantineExecutorSchema, registerExecutorSchema, setDeclaredClassSchema } from "@regulait/shared";
import { identityServiceFailure } from "./delegation.js";
import { auditExecutor, freshAttestation, quarantineExecutor, executorView } from "./executor-channel.js";
import { databaseNow } from "./delegation.js";
import { deploymentEnvironment } from "./oauth/common.js";
import { requireStepUp } from "./step-up.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const idParam = z.object({ executorId: z.string().uuid() });

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
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    attestations,
    openOffers: open?.n ?? 0,
    /** what every piece of this evidence is (OWNER DECISION 5) */
    attestationStrength: "software_attested" as const,
  };
}

export function registerIsolationRoutes(app: FastifyInstance, db: Db): void {
  const notBuilt = async (_req: unknown, reply: FastifyReply) => reply.status(501).send(ISOLATION_NOT_BUILT);
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

  // execution profiles (I2)
  app.get("/v1/execution-profiles", notBuilt);
  app.post("/v1/execution-profiles", notBuilt);
  app.get("/v1/execution-profiles/:name", notBuilt);
  app.post("/v1/execution-profiles/:name/versions", notBuilt);
  app.post("/v1/execution-profiles/:name/retire", notBuilt);

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
    await db
      .update(executors)
      .set({ status: "active", quarantineCode: null, quarantinedAt: null, updatedAt: sql`now()` })
      .where(and(eq(executors.id, row.id), eq(executors.status, "quarantined")));
    await auditExecutor(db, {
      userId: actor(req),
      objectType: "executor",
      objectId: row.id,
      ruleId: "executor-reenabled",
      detail: { executorName: row.name, backend: row.backend, previousQuarantineCode: row.quarantineCode, stepUp: su.method },
      reason: `executor ${row.name} re-enabled by an admin after quarantine (${row.quarantineCode}); it re-attests before taking work (ADR-0190 decision 6)`,
    });
    const [after] = await db.select().from(executors).where(eq(executors.id, row.id));
    return reply.send(await adminExecutorView(db, after!));
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

  // placements (I2)
  app.get("/v1/execution-placements", notBuilt);
  app.get("/v1/execution-placements/:placementId", notBuilt);
}
