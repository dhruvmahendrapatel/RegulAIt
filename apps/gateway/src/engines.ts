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
  engineRunnerSelfTestSchema,
  evaluateRunnerSelfTest,
  type EngineRunnerNext,
  revokeRunnerSchema,
  updateEngineSchema,
  type EngineId,
  type EngineManifestEntry,
  type EngineTaxonomy,
} from "@regulait/shared";
import { z } from "zod";
import { CHANGED_CONCURRENTLY, requireRelaxStepUp } from "./step-up.js";
import { settingTransitions } from "./setting-transitions.js";
import { generateEnrollmentToken } from "./engine-runner-auth.js";
import { hashToken } from "./token-hash.js";
import { endActiveRunsOfEngineTx, endRunsHeldByRevokedRunnersTx, engineRunTestHooks, notifyWorkflowsOfEndedRuns } from "./engine-runs.js";

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
 * PR #205 review round 13 [95]: is the engine row NEWER than this replica's manifest (written by a
 * replica that ships a later generation)? Then this replica must not decide anything about the engine
 * from its own, older manifest: it refuses leases, creation, enabling, self-tests and registration with
 * 409 `engine_manifest_outdated`. Decided from the row each request reads (or locks), so a newer
 * replica that syncs AFTER this one started is seen at once.
 */
export function engineManifestOutdated(row: { manifestGeneration: number }, m: EngineManifestEntry): boolean {
  return row.manifestGeneration > m.generation;
}

/** the 409 body every refusal of an outdated replica sends */
export function engineManifestOutdatedRefusal(id: EngineId, row: { manifestGeneration: number }, m: EngineManifestEntry) {
  return {
    error: "engine_manifest_outdated" as const,
    detail: `this gateway replica ships manifest generation ${m.generation} of engine ${id}, older than the generation ${row.manifestGeneration} already installed: the engine is unavailable on this replica until it is upgraded`,
  };
}

/**
 * The once-per-replica audit of an outdated manifest: keyed by the manifest object this replica runs
 * with (a process normally has one), then by engine and the row's generation. Claimed before the
 * write and released if the write fails, so concurrent requests write it once.
 */
const outdatedAudited = new WeakMap<object, Set<string>>();
async function auditOutdatedOnce(db: Db, manifest: object, id: EngineId, rowGeneration: number, m: EngineManifestEntry): Promise<void> {
  let seen = outdatedAudited.get(manifest);
  if (!seen) outdatedAudited.set(manifest, (seen = new Set()));
  const key = `${id}:${rowGeneration}`;
  if (seen.has(key)) return;
  seen.add(key);
  try {
    await auditEngine(db, {
      userId: NO_IDENTITY,
      objectType: "engine",
      objectId: null,
      ruleId: "engine-manifest-outdated",
      effect: "deny",
      detail: { engineId: id, replicaGeneration: m.generation, rowGeneration, replicaBuild: { version: m.version, digest: m.imageDigest } },
      reason: `engine ${id} is unavailable on this gateway replica: its manifest (generation ${m.generation}) is older than the installed one (generation ${rowGeneration}); nothing was written and nothing was cancelled`,
    });
  } catch (e) {
    seen.delete(key);
    throw e;
  }
}

/**
 * Copy the shipped manifest onto the rows. A version or digest that changed
 * switches an enabled engine off and clears its self-test: what was tested is
 * no longer what would run. Idempotent; cheap when nothing changed.
 *
 * PR #205 review round 13 [95]: MONOTONIC. The row records the manifest generation it was written
 * from, and a replica only ever moves it forward, compared under the row's FOR UPDATE lock: a replica
 * whose manifest generation is OLDER than the row's (an old replica during a rolling upgrade) writes
 * nothing, cancels nothing, disables nothing, and treats the engine as unavailable
 * (`engineManifestOutdated`), audited once per replica.
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
      row.manifestGeneration === m.generation &&
      row.kind === m.kind &&
      row.licence === m.licence &&
      row.maintainerCount === m.maintainerCount &&
      row.lastVerified === m.lastVerified &&
      row.reCheckBy === m.reCheckBy &&
      JSON.stringify(row.usageDataPosture) === JSON.stringify(posture);
    // the unlocked read above only decides whether to look closer (`same`); nothing is decided from it
    if (same) continue;
    await engineRunTestHooks.beforeSyncTx?.(id);
    // PR #205 review round 6 [71]: a build change switches the engine off under the engine row's
    // FOR UPDATE lock, so it serialises with a lease deciding under FOR SHARE.
    // PR #205 review round 8 [78]: and EVERYTHING the build change does — switching the engine off,
    // clearing its self-test, cancelling waiting runs, the audit — is decided from the LOCKED row: a
    // concurrent sync that already installed the new build (and a self-test refreshed since) is seen,
    // and this one is then a no-op for the build.
    const out = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(engines).where(eq(engines.id, id)).for("update");
      if (!locked) return null;
      // round 13 [95]: an older manifest never writes the row (nor cancels, nor disables)
      if (engineManifestOutdated(locked, m)) return { kind: "outdated" as const, rowGeneration: locked.manifestGeneration };
      const buildChanges = locked.version !== m.version || locked.imageDigest !== m.imageDigest;
      await tx
        .update(engines)
        .set({
          kind: m.kind,
          version: m.version,
          imageDigest: m.imageDigest,
          manifestGeneration: m.generation,
          licence: m.licence,
          maintainerCount: m.maintainerCount,
          lastVerified: m.lastVerified,
          reCheckBy: m.reCheckBy,
          usageDataPosture: posture,
          ...(buildChanges ? { enabled: false, selfTestPassedAt: null, selfTest: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(engines.id, id));
      // PR #205 review round 7 [75]: runs still waiting were requested (and approved) against the old
      // build: they are cancelled (`engine_build_changed`, audited) in this transaction. Picked over
      // re-versioning them: an approval given for one build is not silently carried to another.
      const cancelled = buildChanges ? await endActiveRunsOfEngineTx(tx, id, "engine_build_changed") : [];
      // round 11 (sweep): the switch-off's audit commits with it
      if (buildChanges && locked.enabled) {
        await auditEngine(tx as unknown as Db, {
          userId: NO_IDENTITY,
          objectType: "engine",
          objectId: null,
          ruleId: "engine-disabled-manifest-changed",
          effect: "deny",
          detail: { engineId: id, from: { version: locked.version, digest: locked.imageDigest }, to: { version: m.version, digest: m.imageDigest } },
          reason: `engine ${id} switched off: the shipped build changed, so its self-test no longer describes what would run`,
        });
      }
      return { kind: "written" as const, cancelled };
    });
    if (!out) continue;
    if (out.kind === "outdated") {
      await auditOutdatedOnce(db, manifest, id, out.rowGeneration, m);
      continue;
    }
    await notifyWorkflowsOfEndedRuns(db, out.cancelled);
  }
}

/**
 * PR #205 review round 12: THE definition of "the current build" — the manifest's digest (never
 * null: an unbuilt engine has no current build) and version. Every reader and writer of self-test
 * state decides through this (and `runnerCountsForCurrentBuild`), nowhere else.
 */
export function isCurrentBuild(manifest: EngineManifestEntry, build: { digest: string | null | undefined; version: string | null | undefined }): boolean {
  return manifest.imageDigest !== null && build.digest === manifest.imageDigest && build.version === manifest.version;
}

/**
 * PR #205 review round 12: a runner's reports count for the current build only when the build it
 * REGISTERED with is the current build — and, for a report it presents now, when that report is for
 * the current build too. An obsolete-build runner's reports never change the engine.
 */
export function runnerCountsForCurrentBuild(
  manifest: EngineManifestEntry,
  runner: { reportedDigest: string; reportedVersion: string },
  report?: { imageDigest: string; engineVersion: string },
): boolean {
  if (!isCurrentBuild(manifest, { digest: runner.reportedDigest, version: runner.reportedVersion })) return false;
  return report === undefined || isCurrentBuild(manifest, { digest: report.imageDigest, version: report.engineVersion });
}

/** is the stored self-test of this engine a fresh pass against the manifest as it is now? */
export function selfTestAdmitsEnable(row: EngineRow, manifest: EngineManifestEntry, now: Date): { ok: boolean; why: string | null } {
  const t = row.selfTest as { passed?: boolean; imageDigest?: string; version?: string } | null;
  if (!row.selfTestPassedAt || !t?.passed) return { ok: false, why: "no passing runner self-test is recorded" };
  if (now.getTime() - row.selfTestPassedAt.getTime() > ENGINE_SELF_TEST_MAX_AGE_SECONDS * 1000) {
    return { ok: false, why: "the last passing self-test is older than 24 hours" };
  }
  if (!isCurrentBuild(manifest, { digest: t.imageDigest, version: t.version })) {
    return { ok: false, why: "the self-test was for a different build than the shipped manifest names" };
  }
  return { ok: true, why: null };
}

const engineParam = z.object({ engineId: z.enum(ENGINE_IDS) });

/** B5W-07 (ADR-0187 decision 178): does this acceptance name the engine's current build? */
function acceptsBuild(body: { expectedVersion?: string; expectedDigest?: string }, row: Pick<EngineRow, "version" | "imageDigest">): boolean {
  return body.expectedVersion === row.version && body.expectedDigest === row.imageDigest;
}

/** the refusal for an acceptance of a build that is no longer current; it names the current one */
function buildChangedRefusal(engineId: EngineId, row: Pick<EngineRow, "version" | "imageDigest">) {
  return {
    error: "engine_build_changed",
    version: row.version,
    imageDigest: row.imageDigest,
    detail:
      `engine ${engineId}'s current build is ${row.version} (${row.imageDigest ?? "not built"}), not the one this acceptance names. ` +
      "Nothing was changed; review the current build and accept its risk again if you still want it enabled.",
  };
}
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
      // PR #230 review: the report's own time, which the lease judges against
      // ENGINE_SELF_TEST_MAX_AGE_SECONDS (evaluateRunnerSelfTest's `stale`). Without it a
      // reader cannot tell that a recorded "passed" no longer counts.
      selfTestReportedAt: typeof (r.selfTest as { at?: unknown } | null)?.at === "string" ? (r.selfTest as { at: string }).at : null,
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
    // PR #205 review round 13 [95]: an outdated replica never enables (its manifest would judge the
    // self-test against an older build); switching off and lowering dials stay available
    if (body.enabled === true && engineManifestOutdated(current, manifest[engineId])) {
      return reply.status(409).send(engineManifestOutdatedRefusal(engineId, current, manifest[engineId]));
    }
    if (body.enabled === true && !current.enabled) {
      const admit = selfTestAdmitsEnable(current, manifest[engineId], now);
      if (!admit.ok) {
        return reply.status(409).send({
          error: "engine_self_test_required",
          detail: `engine ${engineId} cannot be enabled: ${admit.why}. Register a runner from the signed image and run the self-test first.`,
        });
      }
      // PR #205 review round 9 [79]: a build whose engine process can read the runner credential
      // (no separate OS identity or container yet) is OFF until an admin accepts that risk
      // explicitly — a relaxation, so it rides the step-up below and is audited (ADR-0180)
      // B5W-07 (ADR-0187 decision 178): an acceptance names a build; one that is no longer
      // current is refused (here, before any step-up, and again under the row lock below)
      if (body.acceptCredentialIsolationRisk === true && !acceptsBuild(body, current)) {
        return reply.status(409).send(buildChangedRefusal(engineId, current));
      }
      if (!manifest[engineId].credentialIsolation && body.acceptCredentialIsolationRisk !== true) {
        return reply.status(409).send({
          error: "engine_credential_isolation_missing",
          // B5W-07: the build this refusal is about, which an acceptance must name back
          version: current.version,
          imageDigest: current.imageDigest,
          detail:
            `engine ${engineId}'s build runs the engine process as the runner's own user, so a compromised engine could read the runner token ` +
            "(it can lease this engine's runs and post their results; it cannot reach any other route). " +
            "To enable it anyway, send acceptCredentialIsolationRisk: true with a step-up; the isolating build is ADR-0187 slice B5-P2.",
        });
      }
    }
    const relaxed = engineRowRelaxations(engineId, body, current);
    if (!(await requireRelaxStepUp(db, req, reply, relaxed))) return reply;
    const actor = req.authCtx.userId;
    const out = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(engines).where(eq(engines.id, engineId)).for("update");
      if (!locked) return { kind: "missing" as const };
      if (body.enabled === true && engineManifestOutdated(locked, manifest[engineId])) return { kind: "outdated" as const, row: locked };
      // B5W-07: the build may have rolled over since the unlocked read; the acceptance is for the one it names
      if (body.acceptCredentialIsolationRisk === true && !acceptsBuild(body, locked)) return { kind: "build_changed" as const, row: locked };
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
      const transitions = settingTransitions(locked, body, ["acceptCredentialIsolationRisk"]);
      if (body.enabled === true && !locked.enabled && !manifest[engineId].credentialIsolation) {
        // round 9 [79]: the accepted risk is its own audit row, naming who accepted it and for which build
        await tx.insert(auditLog).values({
          userId: actor ?? NO_IDENTITY,
          objectType: "engine",
          objectId: null,
          // B5W-07: the build accepted is the locked row's, which equals the one the request named
          detail: { engineId, version: locked.version, imageDigest: locked.imageDigest, credentialIsolation: false },
          effect: "allow",
          ruleId: "engine-credential-isolation-risk-accepted",
          ruleChain: [],
          reason: `engine ${engineId} enabled although its engine process can read the runner token: the admin accepted that risk with a step-up (ADR-0187 decision 79)`,
        });
      }
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
      // PR #205 review round 10 [84]: switching the engine off ends its active runs (leased, queued,
      // awaiting approval) and revokes their keys in this transaction, which holds the engine row
      const ended = body.enabled === false ? await endActiveRunsOfEngineTx(tx, engineId, "engine_disabled") : [];
      return { kind: "ok" as const, after: after!, ended };
    });
    if (out.kind === "missing") return reply.status(404).send({ error: "engine_not_found" });
    if (out.kind === "outdated") return reply.status(409).send(engineManifestOutdatedRefusal(engineId, out.row, manifest[engineId]));
    if (out.kind === "build_changed") return reply.status(409).send(buildChangedRefusal(engineId, out.row));
    if (out.kind === "moved") return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    await notifyWorkflowsOfEndedRuns(db, out.ended);
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
    // PR #205 review round 6 [71]: the engine row is taken FOR UPDATE, so a failing verdict that
    // switches the engine off serialises with a lease deciding under its FOR SHARE lock.
    // PR #205 review round 11 (sweep): the report judged is read in the same transaction, locked
    // (FOR SHARE, taken before the engine row: the lock order of the lease and the runner self-test),
    // so the verdict recorded is the one on the report as it stands; the audit commits with it.
    const m = manifest[engineId];
    const out = await db.transaction(async (tx) => {
      // PR #205 review round 12 [91]: only a runner of the CURRENT build counts — the newest live one
      // whose registered build is the manifest's (an obsolete runner's report can never fail the
      // verdict and switch the current engine off). With none, nothing is judged and nothing changes.
      const [runner] =
        m.imageDigest === null
          ? []
          : await tx
              .select()
              .from(engineRunners)
              .where(
                and(
                  eq(engineRunners.engineId, engineId),
                  isNull(engineRunners.revokedAt),
                  eq(engineRunners.reportedDigest, m.imageDigest),
                  eq(engineRunners.reportedVersion, m.version),
                ),
              )
              .orderBy(desc(engineRunners.registeredAt))
              .limit(1)
              .for("share");
      if (!runner || !runnerCountsForCurrentBuild(m, runner)) return { kind: "no_current_runner" as const };
      const report = runner.selfTest as Parameters<typeof evaluateRunnerSelfTest>[1];
      const verdict = evaluateRunnerSelfTest(m, report, now);
      const record = {
        passed: verdict.passed,
        failures: verdict.failures,
        runnerId: runner.id,
        imageDigest: report?.imageDigest ?? null,
        version: report?.engineVersion ?? null,
        egress: report?.egress ?? null,
        at: now.toISOString(),
      };
      const [locked] = await tx.select().from(engines).where(eq(engines.id, engineId)).for("update");
      // PR #205 review round 13 [95]: an outdated replica judges nothing (and so switches nothing off)
      if (locked && engineManifestOutdated(locked, m)) return { kind: "outdated" as const, row: locked };
      await tx
        .update(engines)
        .set({
          selfTest: record,
          ...(verdict.passed ? { selfTestPassedAt: now } : { selfTestPassedAt: null, enabled: false }),
          updatedAt: now,
          updatedByUserId: req.authCtx.userId,
        })
        .where(eq(engines.id, engineId));
      // PR #205 review round 10 [84]: a failing verdict switches the engine off AND ends its active
      // runs, revoking their keys, in this same transaction
      const ended = verdict.passed ? [] : await endActiveRunsOfEngineTx(tx, engineId, "engine_self_test_failed");
      await auditEngine(tx as unknown as Db, {
        userId: req.authCtx.userId ?? NO_IDENTITY,
        objectType: "engine",
        objectId: null,
        ruleId: verdict.passed ? "engine-self-test-passed" : "engine-self-test-failed",
        effect: verdict.passed ? "allow" : "deny",
        detail: { engineId, ...record, disabled: !verdict.passed && locked?.enabled === true },
        reason: verdict.passed
          ? `engine ${engineId} self-test passed (runner ${runner.id})`
          : `engine ${engineId} self-test failed: ${verdict.failures.join(", ")}` + (locked?.enabled ? " — the engine is switched off" : ""),
      });
      return { kind: "judged" as const, record, ended };
    });
    if (out.kind === "outdated") return reply.status(409).send(engineManifestOutdatedRefusal(engineId, out.row, m));
    if (out.kind === "no_current_runner") {
      return reply.status(409).send({
        error: "engine_no_current_build_runner",
        detail: `engine ${engineId}'s self-test cannot run: no live runner is registered for the current build (${m.version}, ${m.imageDigest ?? "not built"}). Deploy the current image and enrol its runner; nothing was changed.`,
      });
    }
    await notifyWorkflowsOfEndedRuns(db, out.ended);
    return reply.send(out.record);
  });

  // ---- POST /v1/engines/:engineId/enrollment-tokens (admin; shown once) ------
  app.post("/v1/engines/:engineId/enrollment-tokens", async (req, reply) => {
    const { engineId } = engineParam.parse(req.params);
    const body = createEnrollmentTokenSchema.parse(req.body ?? {});
    const { token, tokenHash } = generateEnrollmentToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + body.ttlMinutes * 60_000);
    // round 11 (sweep): the token and its audit commit together (a minted credential is never unaudited)
    const row = await db.transaction(async (tx) => {
      const [r] = await tx
        .insert(engineEnrollmentTokens)
        .values({ engineId, tokenHash, label: body.label ?? null, createdByUserId: req.authCtx.userId, createdAt: now, expiresAt })
        .returning();
      await auditEngine(tx as unknown as Db, {
        userId: req.authCtx.userId ?? NO_IDENTITY,
        objectType: "engine_runner",
        objectId: r!.id,
        ruleId: "engine-enrollment-token-minted",
        detail: { engineId, expiresAt: expiresAt.toISOString(), label: body.label ?? null },
        reason: `one-time enrolment token minted for engine ${engineId}, valid until ${expiresAt.toISOString()}`,
      });
      return r!;
    });
    return reply.status(201).send({ id: row.id, engineId, token, expiresAt: expiresAt.toISOString() });
  });

  // ---- DELETE /v1/engine-runners/:runnerId (admin) ----------------------------
  app.delete("/v1/engine-runners/:runnerId", async (req, reply) => {
    const { runnerId } = runnerParam.parse(req.params);
    const body = revokeRunnerSchema.parse(req.body ?? {});
    const [row] = await db.select().from(engineRunners).where(eq(engineRunners.id, runnerId));
    if (!row) return reply.status(404).send({ error: "engine_runner_not_found" });
    const reason = body.reason ?? "revoked by an administrator";
    // the runs it holds end now, and their keys with them: the runner is never trusted to stop itself.
    // PR #205 review round 7 [76]: in the revocation's own transaction (and again when it was already
    // revoked: the call reconciles), so no failure after a commit leaves a usable key
    const { revoked, endedRuns } = await db.transaction(async (tx) => {
      const [r] = await tx
        .update(engineRunners)
        .set({ revokedAt: new Date(), revokedByUserId: req.authCtx.userId, revokeReason: reason })
        .where(and(eq(engineRunners.id, runnerId), isNull(engineRunners.revokedAt)))
        .returning();
      const ended = await endRunsHeldByRevokedRunnersTx(tx, row.engineId, req.authCtx.userId ?? NO_IDENTITY, runnerId);
      // round 11 (sweep): the revocation's audit commits with it
      await auditEngine(tx as unknown as Db, {
        userId: req.authCtx.userId ?? NO_IDENTITY,
        objectType: "engine_runner",
        objectId: runnerId,
        ruleId: "engine-runner-revoked",
        detail: { engineId: row.engineId, alreadyRevoked: !r, endedRuns: ended.length },
        reason: `engine runner ${row.name} (${row.engineId}) revoked: its token authenticates nothing from now on`,
      });
      return { revoked: r, endedRuns: ended };
    });
    await notifyWorkflowsOfEndedRuns(db, endedRuns);
    const ended = endedRuns.length;
    return reply.send({ id: runnerId, revokedAt: (revoked ?? row).revokedAt, endedRuns: ended });
  });

  // ---- POST /v1/engine-runner/register (one-time enrolment token) ------------
  // PR #205 review [54]: the runner brings its own runner token and sends only its sha256, which
  // is stored as the credential. Nothing secret is returned, so a lost response loses nothing: a
  // retry with the same (now spent, unexpired) enrolment token and the SAME hash is answered with
  // the same runner; any other hash is refused. A spent token never mints a second runner.
  app.post("/v1/engine-runner/register", async (req, reply) => {
    const body = engineRunnerRegisterSchema.parse(req.body);
    const tokenId = req.authCtx.engineEnrollmentTokenId;
    const engineId = req.authCtx.engineId as EngineId | undefined;
    if (!tokenId || !engineId) return reply.status(401).send({ error: "engine_enrollment_invalid" });
    if (body.selfTest.imageDigest !== body.imageDigest || body.selfTest.engineVersion !== body.engineVersion) {
      return reply.status(422).send({ error: "engine_self_test_inconsistent", detail: "the self-test must describe the image being registered" });
    }
    // PR #205 review round 13 [95]: an outdated replica registers nothing for this engine (its idea of
    // the current build is older than the installed one). Decided on an unlocked read, before the
    // enrolment token is spent: a registration that slips past a concurrent upgrade is of an obsolete
    // build, which every later report and lease refuses by the current-build predicate.
    const [engineRow] = await db.select().from(engines).where(eq(engines.id, engineId));
    if (engineRow && engineManifestOutdated(engineRow, manifest[engineId])) {
      return reply.status(409).send(engineManifestOutdatedRefusal(engineId, engineRow, manifest[engineId]));
    }
    // PR #205 review round 12 [91]: a runner of a build that is not the current one is refused
    // outright (decided before the enrolment token is spent), so an old container can never come back
    // as a live runner whose reports might count. Secure by default; audited.
    if (!isCurrentBuild(manifest[engineId], { digest: body.imageDigest, version: body.engineVersion })) {
      await auditEngine(db, {
        userId: NO_IDENTITY,
        objectType: "engine_runner",
        objectId: null,
        ruleId: "engine-runner-register-obsolete-build",
        effect: "deny",
        detail: { engineId, name: body.name, reported: { digest: body.imageDigest, version: body.engineVersion }, current: { digest: manifest[engineId].imageDigest, version: manifest[engineId].version } },
        reason: `a runner (${body.name}) tried to register for ${engineId} with a build that is not the current one: refused`,
      });
      return reply.status(409).send({
        error: "engine_runner_build_obsolete",
        detail: "this image is not the engine's current build: deploy the current image (the engine's manifest names its digest and version), then enrol its runner",
      });
    }
    const verdict = evaluateRunnerSelfTest(manifest[engineId], body.selfTest, new Date());
    const replay = async () => {
      const [existing] = await db.select().from(engineRunners).where(eq(engineRunners.enrollmentTokenId, tokenId));
      if (!existing || existing.tokenHash !== body.tokenHash || existing.revokedAt !== null) {
        return reply.status(401).send({ error: "engine_enrollment_invalid", detail: "this enrolment token was already used" });
      }
      // PR #205 review round 7 [76]: a replay reconciles, idempotently — any run still leased by a
      // revoked runner of this engine (a superseded one included) ends now, with its key
      // round 11 (sweep): the reconciliation and its audits commit together
      const reconciled = await db.transaction(async (tx) => {
        const ended = await endRunsHeldByRevokedRunnersTx(tx, engineId, NO_IDENTITY);
        if (ended.length > 0) {
          await auditEngine(tx as unknown as Db, {
            userId: NO_IDENTITY,
            objectType: "engine_runner",
            objectId: existing.id,
            ruleId: "engine-runner-revoked-runs-reconciled",
            detail: { engineId, endedRuns: ended.map((r) => r.id) },
            reason: `${ended.length} run(s) still held by a revoked ${engineId} runner were ended on a registration replay`,
          });
        }
        await auditEngine(tx as unknown as Db, {
          userId: NO_IDENTITY,
          objectType: "engine_runner",
          objectId: existing.id,
          ruleId: "engine-runner-register-replayed",
          detail: { engineId, name: existing.name },
          reason: `engine runner ${existing.name} (${engineId}) re-presented its registration; the same runner was returned`,
        });
        return ended;
      });
      await notifyWorkflowsOfEndedRuns(db, reconciled);
      return reply
        .status(201)
        .send({ runnerId: existing.id, engineId, selfTest: { passed: existing.selfTestPassed, failures: existing.selfTestFailures }, replayed: true });
    };
    if (req.authCtx.engineEnrollmentSpent) return replay();
    // PR #205 review round 8 [77]: a fresh enrolment token with a hash that is ALREADY a runner's
    // credential (a registration whose response was lost, retried after its token expired) is a clear
    // 409, decided before the token is spent — the runner then tries its secret as the credential.
    // Nothing is relaxed: the existing registration is not re-bound to this token.
    const alreadyRegistered = () =>
      reply.status(409).send({
        error: "engine_runner_already_registered",
        detail: "that runner token is already registered: use it as this runner's credential (an earlier registration's response was lost), or generate a new one",
      });
    const [already] = await db.select({ id: engineRunners.id }).from(engineRunners).where(eq(engineRunners.tokenHash, body.tokenHash));
    if (already) return alreadyRegistered();
    let out: (typeof engineRunners.$inferSelect & { superseded: { id: string; name: string } | null; ended: Awaited<ReturnType<typeof endRunsHeldByRevokedRunnersTx>> }) | null;
    try {
      out = await db.transaction(async (tx) => {
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
            tokenHash: body.tokenHash,
            enrollmentTokenId: tokenId,
            reportedDigest: body.imageDigest,
            reportedVersion: body.engineVersion,
            selfTest: body.selfTest,
            selfTestPassed: verdict.passed,
            selfTestFailures: verdict.failures,
          })
          .returning();
        await tx.update(engineEnrollmentTokens).set({ runnerId: runner!.id }).where(eq(engineEnrollmentTokens.id, tokenId));
        // PR #205 review round 5 [67]: a re-enrolment after a build change presents the runner token
        // it held; that registration (a live runner of THIS engine) is revoked in the same transaction,
        // so an upgraded runner never leaves a live credential behind. Anything else is ignored.
        let superseded: { id: string; name: string } | null = null;
        let ended: Awaited<ReturnType<typeof endRunsHeldByRevokedRunnersTx>> = [];
        if (body.supersedes) {
          const [old] = await tx
            .update(engineRunners)
            .set({ revokedAt: new Date(), revokeReason: `superseded: re-enrolled as runner ${runner!.id} after a build change` })
            .where(and(eq(engineRunners.tokenHash, hashToken(body.supersedes)), eq(engineRunners.engineId, engineId), isNull(engineRunners.revokedAt)))
            .returning({ id: engineRunners.id, name: engineRunners.name });
          superseded = old ?? null;
          if (old) {
            // PR #205 review round 7 [76]: the runs it held end, and their keys are revoked, IN THIS
            // transaction — a crash or a failure after the commit can no longer leave a usable key
            ended = await endRunsHeldByRevokedRunnersTx(tx, engineId, NO_IDENTITY, old.id);
            await auditEngine(tx as unknown as Db, {
              userId: NO_IDENTITY,
              objectType: "engine_runner",
              objectId: old.id,
              ruleId: "engine-runner-superseded",
              detail: { engineId, replacedBy: runner!.id, endedRuns: ended.length },
              reason: `engine runner ${old.name} (${engineId}) revoked: it re-enrolled as ${body.name} after a build change`,
            });
          }
        }
        // round 11 (sweep): the registration's audit commits with it
        await auditEngine(tx as unknown as Db, {
          userId: NO_IDENTITY,
          objectType: "engine_runner",
          objectId: runner!.id,
          ruleId: "engine-runner-registered",
          effect: verdict.passed ? "allow" : "deny",
          detail: { engineId, name: body.name, imageDigest: body.imageDigest, engineVersion: body.engineVersion, selfTest: verdict },
          reason:
            `engine runner ${body.name} registered for ${engineId}` +
            (verdict.passed ? " with a passing self-test" : `; its self-test failed (${verdict.failures.join(", ")}), so it can lease nothing`),
        });
        return { ...runner!, superseded, ended };
      });
    } catch (e) {
      // the hash is already some runner's credential (token_hash is unique): a credential is never shared
      // (a concurrent registration of the same hash, past the check above)
      const pg = (e as { code?: string; cause?: { code?: string } }) ?? {};
      if (pg.code === "23505" || pg.cause?.code === "23505") return alreadyRegistered();
      throw e;
    }
    // a concurrent request spent it first: it may have been this runner's own retry
    if (!out) return replay();
    await engineRunTestHooks.afterRegisterTx?.();
    await notifyWorkflowsOfEndedRuns(db, out.ended);
    return reply.status(201).send({ runnerId: out.id, engineId, selfTest: verdict, supersededRunnerId: out.superseded?.id ?? null });
  });

  // ---- POST /v1/engine-runner/self-test (runner token) — PR #205 review [53] --
  // A runner refreshes its own report: the lease refuses a report older than 24 hours, and before
  // this route only registration (a new enrolment token) accepted one. Evaluated exactly like
  // registration's report (manifest, digest, version, switches, egress, freshness) and audited.
  // The report must describe the image this runner registered with (a different image re-enrols).
  // A passing report also refreshes the engine's recorded self-test, but ONLY for the build the
  // admin enabled (the engine's record passed, for the manifest's digest and version); a failing
  // one switches the engine off, like a failing admin self-test.
  app.post("/v1/engine-runner/self-test", async (req, reply) => {
    const { selfTest } = engineRunnerSelfTestSchema.parse(req.body);
    const runnerId = req.authCtx.engineRunnerId!;
    const engineId = req.authCtx.engineId as EngineId;
    await syncEngineManifest(db, manifest);
    const [runner] = await db.select().from(engineRunners).where(eq(engineRunners.id, runnerId));
    if (!runner) return reply.status(401).send({ error: "engine_runner_token_required", next: "revoked" satisfies EngineRunnerNext });
    // PR #205 review round 13 [95]: an outdated replica takes no report (its older manifest would call
    // a current runner obsolete, or judge it against the wrong build). No `next`: the runner retries.
    const [engineNow] = await db.select().from(engines).where(eq(engines.id, engineId));
    if (engineNow && engineManifestOutdated(engineNow, manifest[engineId])) {
      return reply.status(409).send(engineManifestOutdatedRefusal(engineId, engineNow, manifest[engineId]));
    }
    // PR #205 review round 5 [67]: a report of another build means the runner was upgraded under a
    // credential registered for the old one. That is not an inconsistency to wait out: it re-enrols.
    if (selfTest.imageDigest !== runner.reportedDigest || selfTest.engineVersion !== runner.reportedVersion) {
      return reply.status(409).send({
        error: "engine_runner_reenrol_required",
        next: "reenrol_required" satisfies EngineRunnerNext,
        detail: "this runner token was registered for another build: re-enrol this runner with a new enrolment token (the old registration is revoked when it does)",
      });
    }
    // PR #205 review round 10 [85]: a report of a build that is not the CURRENT manifest build (an
    // old runner during a rolling upgrade) changes nothing — neither this runner's stored report nor
    // the engine — and is audited: an obsolete runner can never switch the current build's engine off
    const m = manifest[engineId];
    if (!runnerCountsForCurrentBuild(m, runner, selfTest)) {
      await auditEngine(db, {
        userId: NO_IDENTITY,
        objectType: "engine_runner",
        objectId: runnerId,
        ruleId: "engine-runner-self-test-obsolete-build",
        effect: "deny",
        detail: { engineId, reported: { digest: selfTest.imageDigest, version: selfTest.engineVersion }, current: { digest: m.imageDigest, version: m.version } },
        reason: `engine runner ${runner.name} (${engineId}) reported a self-test for a build that is not the current one: refused, nothing changed`,
      });
      return reply.status(409).send({
        error: "engine_runner_reenrol_required",
        next: "reenrol_required" satisfies EngineRunnerNext,
        detail: "this runner runs a build that is not the current one: deploy the current image and re-enrol it with a new enrolment token",
      });
    }
    const now = new Date();
    const verdict = evaluateRunnerSelfTest(m, selfTest, now);
    await engineRunTestHooks.beforeSelfTestTx?.(runnerId);
    const out = await db.transaction(async (tx) => {
      // PR #205 review round 4 [65]: the runner row is LOCKED and its revocation re-read here, like
      // the lease: a report that lands after a revocation touches neither the runner nor the engine
      // (revocation UPDATEs this row, so it either waits for this transaction or this one sees it)
      const [live] = await tx.select({ revokedAt: engineRunners.revokedAt }).from(engineRunners).where(eq(engineRunners.id, runnerId)).for("update");
      if (!live || live.revokedAt !== null) return { kind: "revoked" as const };
      const [engine] = await tx.select().from(engines).where(eq(engines.id, engineId)).for("update");
      // PR #205 review round 13 [95]: decided again on the locked row — an outdated replica stores
      // nothing, neither the runner's report nor anything on the engine
      if (engine && engineManifestOutdated(engine, m)) return { kind: "outdated" as const, row: engine };
      await tx.update(engineRunners).set({ selfTest, selfTestPassed: verdict.passed, selfTestFailures: verdict.failures }).where(eq(engineRunners.id, runnerId));
      const recorded = engine?.selfTest as { passed?: boolean; imageDigest?: string; version?: string } | null;
      const sameBuild = !!recorded?.passed && isCurrentBuild(m, { digest: recorded.imageDigest, version: recorded.version });
      let engineRefreshed = false;
      let engineDisabled = false;
      if (verdict.passed && sameBuild) {
        await tx
          .update(engines)
          .set({
            selfTest: { ...recorded, passed: true, failures: [], runnerId, egress: selfTest.egress, at: now.toISOString(), refreshedBy: "runner" },
            selfTestPassedAt: now,
            updatedAt: now,
          })
          .where(eq(engines.id, engineId));
        engineRefreshed = true;
      } else if (!verdict.passed && engine) {
        // PR #205 review round 12 [93]: a failing current-build report ALWAYS records the failure and
        // clears the engine's pass, whatever its state — an engine already off can no longer be
        // re-enabled on the earlier (now contradicted) evidence. Only ending its runs depends on this
        // switching it off (true → false).
        await tx
          .update(engines)
          .set({
            selfTest: { passed: false, failures: verdict.failures, runnerId, imageDigest: selfTest.imageDigest, version: selfTest.engineVersion, egress: selfTest.egress, at: now.toISOString() },
            selfTestPassedAt: null,
            enabled: false,
            updatedAt: now,
          })
          .where(eq(engines.id, engineId));
        engineDisabled = engine.enabled;
      }
      // PR #205 review round 10 [84]: the engine switched off here takes its active runs (every
      // runner's) with it, keys revoked, in this transaction — no run keeps calling models after an
      // egress-policy failure
      const ended = engineDisabled ? await endActiveRunsOfEngineTx(tx, engineId, "engine_self_test_failed") : [];
      const engineOn = !!engine?.enabled && !engineDisabled;
      // round 11 (sweep): the report's audit commits with the report (and with any switch-off)
      await auditEngine(tx as unknown as Db, {
        userId: NO_IDENTITY,
        objectType: "engine_runner",
        objectId: runnerId,
        ruleId: verdict.passed ? "engine-runner-self-test-refreshed" : "engine-runner-self-test-failed",
        effect: verdict.passed ? "allow" : "deny",
        detail: { engineId, selfTest: verdict, egress: selfTest.egress, engineRefreshed, engineDisabled },
        reason:
          `engine runner ${runner.name} (${engineId}) submitted a fresh self-test: ` +
          (verdict.passed ? "passed" : `failed (${verdict.failures.join(", ")})`) +
          (engineDisabled ? " — the engine is switched off" : engineRefreshed ? "; the engine's recorded self-test is refreshed" : ""),
      });
      return { kind: "done" as const, engineRefreshed, engineDisabled, engineOn, ended };
    });
    if (out.kind === "done") await notifyWorkflowsOfEndedRuns(db, out.ended);
    if (out.kind === "outdated") return reply.status(409).send(engineManifestOutdatedRefusal(engineId, out.row, m));
    if (out.kind === "revoked") {
      return reply
        .status(401)
        .send({ error: "engine_runner_revoked", next: "revoked" satisfies EngineRunnerNext, detail: "this runner was revoked: its token authenticates nothing" });
    }
    // round 5: the same signal the lease gives — a failing report must be re-proved; a passing one
    // leases when the engine is on and waits for an admin when it is off (never re-enables it)
    const next: EngineRunnerNext = !verdict.passed ? "self_test_required" : out.engineOn ? "ok" : "admin_disabled";
    return reply.send({ selfTest: verdict, next, engineRefreshed: out.engineRefreshed, engineDisabled: out.engineDisabled });
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
