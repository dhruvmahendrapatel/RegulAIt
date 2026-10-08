/**
 * ADR-0187 B5-F — THE ENGINES: the shipped manifest synced onto the `engines`
 * rows, the admin routes (enable/disable and dials, self-test, enrolment
 * tokens, runner revocation) and runner registration.
 *
 * SECURE BY DEFAULT (ADR-0180; owner decision 3). Every engine starts off.
 * Enabling needs (1) a passing, fresh runner self-test against the manifest —
 * the reported image digest is the manifest's, the usage-data switches are
 * set, and an egress probe to an external host neither resolved nor connected
 * — and (2) a `settings_relax` step-up bound to exactly that change; raising a
 * timeout, budget ceiling or concurrency is a relaxation too. Each is decided
 * on the unlocked read and again on the locked row (ADR-0186 decision 22:
 * 409 `changed_concurrently` when the row moved). Every change is audited with
 * `detail.transitions`. A manifest change of version or digest switches the
 * engine off again, and so does a failing self-test.
 *
 * Open-source check (ADR-0176): no library fits the governance part (which
 * runner may lease which engine's work, under which self-test); the runners
 * themselves run the upstream engines unmodified (B5-P/M/G build the images).
 */
import type { FastifyInstance } from "fastify";
import {
  and,
  auditLog,
  desc,
  eq,
  engineEnrollmentTokens,
  engineRunners,
  engineRuns,
  engines,
  inArray,
  isNull,
  sql,
  type Db,
  type EngineRow,
} from "@regulait/db";
import {
  ENGINE_IDS,
  ENGINE_MANIFEST,
  ENGINE_SELF_TEST_MAX_AGE_SECONDS,
  ENGINE_TAXONOMY,
  createEnrollmentTokenSchema,
  engineRowRelaxations,
  engineRunnerRegisterSchema,
  evaluateRunnerSelfTest,
  revokeRunnerSchema,
  updateEngineSchema,
  type EngineId,
  type EngineManifestEntry,
  type EngineTaxonomy,
} from "@regulait/shared";
import { z } from "zod";
import { CHANGED_CONCURRENTLY, requireRelaxStepUp } from "./step-up.js";
import { settingTransitions } from "./setting-transitions.js";
import { generateEnrollmentToken, generateRunnerToken } from "./engine-runner-auth.js";
import { endLeasedRunsOfRunner } from "./engine-runs.js";

export const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

/** what the engine routes need beyond the database (test seams are code-only, never env or admin input) */
export interface EngineOptions {
  dataKey?: string | undefined;
  /** the shipped manifest; a test may pass one with a built digest */
  manifest?: Readonly<Record<EngineId, EngineManifestEntry>>;
  /** the shared taxonomy table; a test may pass one with rows */
  taxonomy?: EngineTaxonomy;
  /** the gateway's OpenAI-compatible base as a runner reaches it on the engines network */
  gatewayBaseUrl?: string;
}

export function manifestOf(opts: EngineOptions): Readonly<Record<EngineId, EngineManifestEntry>> {
  return opts.manifest ?? ENGINE_MANIFEST;
}
export function taxonomyOf(opts: EngineOptions): EngineTaxonomy {
  return opts.taxonomy ?? ENGINE_TAXONOMY;
}
export function gatewayBaseUrlOf(opts: EngineOptions): string {
  return opts.gatewayBaseUrl ?? process.env.REGULAIT_ENGINE_GATEWAY_URL ?? "http://gateway:3000/v1";
}

type AuditValues = typeof auditLog.$inferInsert;
export async function auditEngine(db: Db, row: Omit<AuditValues, "ruleChain" | "effect"> & { effect?: AuditValues["effect"] }) {
  await db.insert(auditLog).values({ effect: "allow", ruleChain: [], ...row } as AuditValues);
}

/**
 * Copy the shipped manifest onto the rows. A version or digest that changed
 * switches an enabled engine off and clears its self-test: what was tested is
 * no longer what would run. Idempotent; cheap when nothing changed.
 */
export async function syncEngineManifest(db: Db, manifest: Readonly<Record<EngineId, EngineManifestEntry>>): Promise<void> {
  for (const id of ENGINE_IDS) {
    const m = manifest[id];
    const [row] = await db.select().from(engines).where(eq(engines.id, id));
    if (!row) continue; // migration 0173 inserts every engine; a missing row stays missing (and unleasable)
    const posture = { switches: m.usageDataEnv, unverified: m.unverified, airGappedReducedSet: m.airGappedReducedSet };
    const changedBuild = row.version !== m.version || row.imageDigest !== m.imageDigest;
    const same =
      !changedBuild &&
      row.kind === m.kind &&
      row.licence === m.licence &&
      row.maintainerCount === m.maintainerCount &&
      row.lastVerified === m.lastVerified &&
      row.reCheckBy === m.reCheckBy &&
      JSON.stringify(row.usageDataPosture) === JSON.stringify(posture);
    if (same) continue;
    await db
      .update(engines)
      .set({
        kind: m.kind,
        version: m.version,
        imageDigest: m.imageDigest,
        licence: m.licence,
        maintainerCount: m.maintainerCount,
        lastVerified: m.lastVerified,
        reCheckBy: m.reCheckBy,
        usageDataPosture: posture,
        ...(changedBuild ? { enabled: false, selfTestPassedAt: null, selfTest: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(engines.id, id));
    if (changedBuild && row.enabled) {
      await auditEngine(db, {
        userId: NO_IDENTITY,
        objectType: "engine",
        objectId: null,
        ruleId: "engine-disabled-manifest-changed",
        effect: "deny",
        detail: { engineId: id, from: { version: row.version, digest: row.imageDigest }, to: { version: m.version, digest: m.imageDigest } },
        reason: `engine ${id} switched off: the shipped build changed, so its self-test no longer describes what would run`,
      });
    }
  }
}

/** is the stored self-test of this engine a fresh pass against the manifest as it is now? */
export function selfTestAdmitsEnable(row: EngineRow, manifest: EngineManifestEntry, now: Date): { ok: boolean; why: string | null } {
  const t = row.selfTest as { passed?: boolean; imageDigest?: string; version?: string } | null;
  if (!row.selfTestPassedAt || !t?.passed) return { ok: false, why: "no passing runner self-test is recorded" };
  if (now.getTime() - row.selfTestPassedAt.getTime() > ENGINE_SELF_TEST_MAX_AGE_SECONDS * 1000) {
    return { ok: false, why: "the last passing self-test is older than 24 hours" };
  }
  if (manifest.imageDigest === null || t.imageDigest !== manifest.imageDigest || t.version !== manifest.version) {
    return { ok: false, why: "the self-test was for a different build than the shipped manifest names" };
  }
  return { ok: true, why: null };
}

const engineParam = z.object({ engineId: z.enum(ENGINE_IDS) });
const runnerParam = z.object({ runnerId: z.string().uuid() });

function publicEngine(row: EngineRow, manifest: EngineManifestEntry, runners: Array<typeof engineRunners.$inferSelect>, lastRun: { id: string; status: string; createdAt: Date } | null) {
  const live = runners.filter((r) => r.revokedAt === null);
  return {
    id: row.id,
    kind: row.kind,
    displayName: manifest.displayName,
    version: row.version,
    imageDigest: row.imageDigest,
    /** the image is signed and verified in the engine's own PR; null = not built yet */
    signature: row.imageDigest ? "unverified" : "not_built",
    licence: row.licence,
    maintainerCount: row.maintainerCount,
    usageDataPosture: row.usageDataPosture,
    lastVerified: row.lastVerified,
    reCheckBy: row.reCheckBy,
    enabled: row.enabled,
    timeoutSeconds: row.timeoutSeconds,
    maxBudgetUsd: row.maxBudgetUsd,
    maxConcurrent: row.maxConcurrent,
    selfTest: row.selfTest,
    selfTestPassedAt: row.selfTestPassedAt,
    needsModelAccess: manifest.needsModelAccess,
    airGappedReducedSet: manifest.airGappedReducedSet,
    unverified: manifest.unverified,
    runners: live.map((r) => ({
      id: r.id,
      name: r.name,
      reportedDigest: r.reportedDigest,
      reportedVersion: r.reportedVersion,
      selfTestPassed: r.selfTestPassed,
      selfTestFailures: r.selfTestFailures,
      registeredAt: r.registeredAt,
      lastSeenAt: r.lastSeenAt,
    })),
    lastRun,
  };
}

export function registerEngineRoutes(app: FastifyInstance, db: Db, opts: EngineOptions = {}): void {
  const manifest = manifestOf(opts);

  async function view(id: EngineId) {
    const [row] = await db.select().from(engines).where(eq(engines.id, id));
    if (!row) return null;
    const runners = await db.select().from(engineRunners).where(eq(engineRunners.engineId, id)).orderBy(desc(engineRunners.registeredAt));
    const [lastRun] = await db
      .select({ id: engineRuns.id, status: engineRuns.status, createdAt: engineRuns.createdAt })
      .from(engineRuns)
      .where(eq(engineRuns.engineId, id))
      .orderBy(desc(engineRuns.createdAt))
      .limit(1);
    return publicEngine(row, manifest[id], runners, lastRun ?? null);
  }

  // ---- GET /v1/engines (any signed-in user: no secret in it) -----------------
  app.get("/v1/engines", async () => {
    await syncEngineManifest(db, manifest);
    const out = [];
    for (const id of ENGINE_IDS) {
      const v = await view(id);
      if (v) out.push(v);
    }
    return { engines: out, taxonomyVersion: taxonomyOf(opts).version };
  });

  app.get("/v1/engines/:engineId", async (req, reply) => {
    const { engineId } = engineParam.parse(req.params);
    await syncEngineManifest(db, manifest);
    const v = await view(engineId);
    if (!v) return reply.status(404).send({ error: "engine_not_found" });
    return v;
  });

  // ---- PATCH /v1/engines/:engineId (admin; relaxations need a step-up) -------
  app.patch("/v1/engines/:engineId", async (req, reply) => {
    const { engineId } = engineParam.parse(req.params);
    const body = updateEngineSchema.parse(req.body ?? {});
    await syncEngineManifest(db, manifest);
    const [current] = await db.select().from(engines).where(eq(engines.id, engineId));
    if (!current) return reply.status(404).send({ error: "engine_not_found" });
    const now = new Date();
    if (body.enabled === true && !current.enabled) {
      const admit = selfTestAdmitsEnable(current, manifest[engineId], now);
      if (!admit.ok) {
        return reply.status(409).send({
          error: "engine_self_test_required",
          detail: `engine ${engineId} cannot be enabled: ${admit.why}. Register a runner from the signed image and run the self-test first.`,
        });
      }
    }
    const relaxed = engineRowRelaxations(engineId, body, current);
    if (!(await requireRelaxStepUp(db, req, reply, relaxed))) return reply;
    const actor = req.authCtx.userId;
    const out = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(engines).where(eq(engines.id, engineId)).for("update");
      if (!locked) return { kind: "missing" as const };
      // the step-up was decided on `current`: anything it rested on that moved is refused, never overwritten
      if (JSON.stringify(engineRowRelaxations(engineId, body, locked)) !== JSON.stringify(relaxed)) return { kind: "moved" as const };
      if (body.enabled === true && !locked.enabled && !selfTestAdmitsEnable(locked, manifest[engineId], now).ok) {
        return { kind: "moved" as const };
      }
      const set: Partial<typeof engines.$inferInsert> = { updatedAt: now, updatedByUserId: actor };
      if (body.enabled !== undefined) set.enabled = body.enabled;
      if (body.enabled === true && !locked.enabled) {
        set.enabledAt = now;
        set.enabledByUserId = actor;
      }
      if (body.timeoutSeconds !== undefined) set.timeoutSeconds = body.timeoutSeconds;
      if (body.maxBudgetUsd !== undefined) set.maxBudgetUsd = body.maxBudgetUsd;
      if (body.maxConcurrent !== undefined) set.maxConcurrent = body.maxConcurrent;
      const [after] = await tx.update(engines).set(set).where(eq(engines.id, engineId)).returning();
      const transitions = settingTransitions(locked, body);
      if (Object.keys(transitions).length > 0) {
        await tx.insert(auditLog).values({
          userId: actor ?? NO_IDENTITY,
          objectType: "engine",
          objectId: null,
          detail: { engineId, transitions, relaxed: Object.keys(relaxed) },
          effect: "allow",
          ruleId: "engine-updated",
          ruleChain: [],
          reason:
            `engine ${engineId} updated` +
            (Object.keys(relaxed).length ? ` (relaxed with a step-up: ${Object.keys(relaxed).join(", ")})` : ""),
        });
      }
      return { kind: "ok" as const, after: after! };
    });
    if (out.kind === "missing") return reply.status(404).send({ error: "engine_not_found" });
    if (out.kind === "moved") return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    return view(engineId);
  });

  // ---- POST /v1/engines/:engineId/self-test (admin) ---------------------------
  // The gateway never starts a container: the self-test is what the runner ran
  // when it registered (digest, usage-data switches, the egress probe). This
  // route evaluates the newest live runner's report against the manifest as it
  // is NOW and records the verdict. A failing verdict switches the engine off.
  app.post("/v1/engines/:engineId/self-test", async (req, reply) => {
    const { engineId } = engineParam.parse(req.params);
    await syncEngineManifest(db, manifest);
    const now = new Date();
    const [runner] = await db
      .select()
      .from(engineRunners)
      .where(and(eq(engineRunners.engineId, engineId), isNull(engineRunners.revokedAt)))
      .orderBy(desc(engineRunners.registeredAt))
      .limit(1);
    const report = runner ? (runner.selfTest as Parameters<typeof evaluateRunnerSelfTest>[1]) : null;
    const verdict = report
      ? evaluateRunnerSelfTest(manifest[engineId], report, now)
      : { passed: false, failures: ["no_runner" as const] };
    const record = {
      passed: verdict.passed,
      failures: verdict.failures,
      runnerId: runner?.id ?? null,
      imageDigest: report?.imageDigest ?? null,
      version: report?.engineVersion ?? null,
      egress: report?.egress ?? null,
      at: now.toISOString(),
    };
    const [before] = await db.select().from(engines).where(eq(engines.id, engineId));
    await db
      .update(engines)
      .set({
        selfTest: record,
        ...(verdict.passed ? { selfTestPassedAt: now } : { selfTestPassedAt: null, enabled: false }),
        updatedAt: now,
        updatedByUserId: req.authCtx.userId,
      })
      .where(eq(engines.id, engineId));
    await auditEngine(db, {
      userId: req.authCtx.userId ?? NO_IDENTITY,
      objectType: "engine",
      objectId: null,
      ruleId: verdict.passed ? "engine-self-test-passed" : "engine-self-test-failed",
      effect: verdict.passed ? "allow" : "deny",
      detail: { engineId, ...record, disabled: !verdict.passed && before?.enabled === true },
      reason: verdict.passed
        ? `engine ${engineId} self-test passed (runner ${runner!.id})`
        : `engine ${engineId} self-test failed: ${verdict.failures.join(", ")}` +
          (before?.enabled ? " — the engine is switched off" : ""),
    });
    return reply.send(record);
  });

  // ---- POST /v1/engines/:engineId/enrollment-tokens (admin; shown once) ------
  app.post("/v1/engines/:engineId/enrollment-tokens", async (req, reply) => {
    const { engineId } = engineParam.parse(req.params);
    const body = createEnrollmentTokenSchema.parse(req.body ?? {});
    const { token, tokenHash } = generateEnrollmentToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + body.ttlMinutes * 60_000);
    const [row] = await db
      .insert(engineEnrollmentTokens)
      .values({ engineId, tokenHash, label: body.label ?? null, createdByUserId: req.authCtx.userId, createdAt: now, expiresAt })
      .returning();
    await auditEngine(db, {
      userId: req.authCtx.userId ?? NO_IDENTITY,
      objectType: "engine_runner",
      objectId: row!.id,
      ruleId: "engine-enrollment-token-minted",
      detail: { engineId, expiresAt: expiresAt.toISOString(), label: body.label ?? null },
      reason: `one-time enrolment token minted for engine ${engineId}, valid until ${expiresAt.toISOString()}`,
    });
    return reply.status(201).send({ id: row!.id, engineId, token, expiresAt: expiresAt.toISOString() });
  });

  // ---- DELETE /v1/engine-runners/:runnerId (admin) ----------------------------
  app.delete("/v1/engine-runners/:runnerId", async (req, reply) => {
    const { runnerId } = runnerParam.parse(req.params);
    const body = revokeRunnerSchema.parse(req.body ?? {});
    const [row] = await db.select().from(engineRunners).where(eq(engineRunners.id, runnerId));
    if (!row) return reply.status(404).send({ error: "engine_runner_not_found" });
    const reason = body.reason ?? "revoked by an administrator";
    const [revoked] = await db
      .update(engineRunners)
      .set({ revokedAt: new Date(), revokedByUserId: req.authCtx.userId, revokeReason: reason })
      .where(and(eq(engineRunners.id, runnerId), isNull(engineRunners.revokedAt)))
      .returning();
    // the runs it holds end now, and their keys with them: the runner is never trusted to stop itself
    const ended = await endLeasedRunsOfRunner(db, runnerId, req.authCtx.userId ?? NO_IDENTITY);
    await auditEngine(db, {
      userId: req.authCtx.userId ?? NO_IDENTITY,
      objectType: "engine_runner",
      objectId: runnerId,
      ruleId: "engine-runner-revoked",
      detail: { engineId: row.engineId, alreadyRevoked: !revoked, endedRuns: ended },
      reason: `engine runner ${row.name} (${row.engineId}) revoked: its token authenticates nothing from now on`,
    });
    return reply.send({ id: runnerId, revokedAt: (revoked ?? row).revokedAt, endedRuns: ended });
  });

  // ---- POST /v1/engine-runner/register (one-time enrolment token) ------------
  app.post("/v1/engine-runner/register", async (req, reply) => {
    const body = engineRunnerRegisterSchema.parse(req.body);
    const tokenId = req.authCtx.engineEnrollmentTokenId;
    const engineId = req.authCtx.engineId as EngineId | undefined;
    if (!tokenId || !engineId) return reply.status(401).send({ error: "engine_enrollment_invalid" });
    if (body.selfTest.imageDigest !== body.imageDigest || body.selfTest.engineVersion !== body.engineVersion) {
      return reply.status(422).send({ error: "engine_self_test_inconsistent", detail: "the self-test must describe the image being registered" });
    }
    const verdict = evaluateRunnerSelfTest(manifest[engineId], body.selfTest, new Date());
    const { token, tokenHash } = generateRunnerToken();
    const out = await db.transaction(async (tx) => {
      // spend the enrolment token: one winner
      const [spent] = await tx
        .update(engineEnrollmentTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(engineEnrollmentTokens.id, tokenId), isNull(engineEnrollmentTokens.usedAt), sql`${engineEnrollmentTokens.expiresAt} > now()`))
        .returning();
      if (!spent) return null;
      const [runner] = await tx
        .insert(engineRunners)
        .values({
          engineId,
          name: body.name,
          tokenHash,
          enrollmentTokenId: tokenId,
          reportedDigest: body.imageDigest,
          reportedVersion: body.engineVersion,
          selfTest: body.selfTest,
          selfTestPassed: verdict.passed,
          selfTestFailures: verdict.failures,
        })
        .returning();
      await tx.update(engineEnrollmentTokens).set({ runnerId: runner!.id }).where(eq(engineEnrollmentTokens.id, tokenId));
      return runner!;
    });
    if (!out) return reply.status(401).send({ error: "engine_enrollment_invalid", detail: "this enrolment token was already used or has expired" });
    await auditEngine(db, {
      userId: NO_IDENTITY,
      objectType: "engine_runner",
      objectId: out.id,
      ruleId: "engine-runner-registered",
      effect: verdict.passed ? "allow" : "deny",
      detail: { engineId, name: body.name, imageDigest: body.imageDigest, engineVersion: body.engineVersion, selfTest: verdict },
      reason:
        `engine runner ${body.name} registered for ${engineId}` +
        (verdict.passed ? " with a passing self-test" : `; its self-test failed (${verdict.failures.join(", ")}), so it can lease nothing`),
    });
    return reply.status(201).send({ runnerId: out.id, engineId, token, selfTest: verdict });
  });
}

/** the newest live runners of some engines (for the lease's admission check) */
export async function liveRunnerIds(db: Db, engineIds: EngineId[]): Promise<string[]> {
  if (engineIds.length === 0) return [];
  const rows = await db
    .select({ id: engineRunners.id })
    .from(engineRunners)
    .where(and(inArray(engineRunners.engineId, engineIds), isNull(engineRunners.revokedAt)));
  return rows.map((r) => r.id);
}
