import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  auditLog,
  configCanaryObservations,
  configVersions,
  createDb,
  eq,
  inArray,
  ORG_SETTINGS_ID,
  orgSettings,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { runCanaryObservationPrune } from "./config-versions.js";
import { SCHEDULER_JOB_NAMES, schedulerJobRegistry } from "./scheduler-jobs.js";

/**
 * Batch B7c — ADR-0073 disclosure 5 ("no pruning") CLOSED for
 * `config_canary_observations`, and ONLY for it.
 *
 * The three boundaries this file pins:
 *
 *  1. OBSERVATIONS PRUNE; VERSIONS NEVER DO. Every pass deletes only
 *     observation rows older than the org retention window. The
 *     `config_versions` rows — including the superseded one whose evidence
 *     was just pruned — are asserted PRESENT afterwards, because version
 *     history is the audit substrate (rollback re-points at it, the ledger
 *     references it, the usage stamp names it).
 *
 *  2. A LIVE CANARY'S EVIDENCE IS LIVE EVIDENCE. An observation older than
 *     the cutoff whose candidate version is currently in CANARY status is
 *     kept regardless of age — pruning it would empty the divergence report
 *     an operator is about to promote or abandon on.
 *
 *  3. ONE IMPLEMENTATION, THREE DOORS (ADR-0064 §7): the exported function,
 *     the manual endpoint and the scheduler job are the same code path. The
 *     job itself stays subject to the scheduler's off-by-default posture, so
 *     a fresh install prunes nothing until an operator opts in.
 *
 * SHARED-STATE DISCIPLINE: artifacts are fresh random uuids owned by this
 * suite; assertions are on THIS suite's row ids (never absolute table
 * counts); audit assertions are deltas; the org-settings retention knob is
 * restored in afterAll.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "cop-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

const DAY_MS = 24 * 3600 * 1000;

let db: Db;
let app: ReturnType<typeof buildApp>;
/** artifact whose candidate is a LIVE canary — its old evidence must survive */
let liveArtifactId: string;
/** artifact whose versions exist but none is canarying — prunable evidence */
let deadArtifactId: string;
let liveCanaryVersionId: string;
let supersededVersionId: string;
let oldLiveObsId: string;
let oldDeadObsId: string;
let oldDanglingObsId: string;
let freshObsId: string;
let priorRetentionDays: number | null = null;

async function insertObservation(args: {
  artifactId: string;
  candidateVersionId: string;
  at: Date;
}): Promise<string> {
  const [row] = await db
    .insert(configCanaryObservations)
    .values({
      artifactType: "approval_rule",
      artifactId: args.artifactId,
      candidateVersionId: args.candidateVersionId,
      candidateVersion: 1,
      servedEffect: "allow",
      candidateEffect: "require_approval",
      diverged: true,
      at: args.at,
    })
    .returning({ id: configCanaryObservations.id });
  return row!.id;
}

async function obsById(ids: string[]) {
  return db
    .select({ id: configCanaryObservations.id })
    .from(configCanaryObservations)
    .where(inArray(configCanaryObservations.id, ids));
}

async function prunedAuditRows() {
  return db.select().from(auditLog).where(eq(auditLog.ruleId, "canary-observations-pruned"));
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });

  const [org] = await db
    .select({ days: orgSettings.canaryObservationRetentionDays })
    .from(orgSettings);
  priorRetentionDays = org?.days ?? null;

  liveArtifactId = randomUUID();
  deadArtifactId = randomUUID();

  const [live] = await db
    .insert(configVersions)
    .values({
      artifactType: "approval_rule",
      artifactId: liveArtifactId,
      version: 1,
      body: { toolName: "cop_live" },
      status: "canary",
      canaryPct: 25,
    })
    .returning({ id: configVersions.id });
  liveCanaryVersionId = live!.id;

  const [dead] = await db
    .insert(configVersions)
    .values({
      artifactType: "approval_rule",
      artifactId: deadArtifactId,
      version: 1,
      body: { toolName: "cop_dead" },
      status: "superseded",
    })
    .returning({ id: configVersions.id });
  supersededVersionId = dead!.id;

  const old = new Date(Date.now() - 100 * DAY_MS);
  oldLiveObsId = await insertObservation({
    artifactId: liveArtifactId,
    candidateVersionId: liveCanaryVersionId,
    at: old,
  });
  oldDeadObsId = await insertObservation({
    artifactId: deadArtifactId,
    candidateVersionId: supersededVersionId,
    at: old,
  });
  // FK-free by design, so a dangling candidate id is representable — and it is
  // certainly not a live canary, so age alone prunes it
  oldDanglingObsId = await insertObservation({
    artifactId: deadArtifactId,
    candidateVersionId: randomUUID(),
    at: old,
  });
  freshObsId = await insertObservation({
    artifactId: deadArtifactId,
    candidateVersionId: supersededVersionId,
    at: new Date(),
  });
});

afterAll(async () => {
  await db
    .delete(configCanaryObservations)
    .where(inArray(configCanaryObservations.artifactId, [liveArtifactId, deadArtifactId]));
  await db
    .delete(configVersions)
    .where(inArray(configVersions.artifactId, [liveArtifactId, deadArtifactId]));
  // restore the org-settings singleton this suite mutated (the row is shared
  // with every other suite in this database). 90 is the column default, so a
  // suite that started before the singleton existed still leaves it stock.
  await db
    .update(orgSettings)
    .set({ canaryObservationRetentionDays: priorRetentionDays ?? 90 })
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
});

// ---------------------------------------------------------------------------

describe("B7c — the observation retention sweep prunes evidence, never history", () => {
  it("prunes only rows older than the window, keeps a LIVE canary's old evidence, and NEVER touches config_versions", async () => {
    // DELTA, BY ID, not by physical row order. `prunedAuditRows()` has no
    // ORDER BY, so `at(-1)` was reading whatever Postgres handed back first —
    // stable only while `audit_log` happened to be laid out a particular way.
    // Identifying the new row by id is deterministic regardless of what else
    // the suite has written, and weakens no assertion below.
    const auditRowsBefore = await prunedAuditRows();
    const auditIdsBefore = new Set(auditRowsBefore.map((r) => r.id));
    const auditBefore = auditRowsBefore.length;

    const out = await runCanaryObservationPrune(db, { actorUserId: null });
    expect(out.retainedDays).toBe(90);
    expect(out.pruned).toBeGreaterThanOrEqual(2);
    expect(out.keptLiveCanary).toBeGreaterThanOrEqual(1);

    // the two prunable old rows are gone; the live canary's old evidence and
    // the fresh row are not
    expect(await obsById([oldDeadObsId, oldDanglingObsId])).toEqual([]);
    expect((await obsById([oldLiveObsId, freshObsId])).length).toBe(2);

    // THE BOUNDARY: both version rows survive every pass — including the
    // superseded one whose observations were just deleted. Version history is
    // the audit substrate; nothing in this slice may prune it.
    const versions = await db
      .select({ id: configVersions.id, status: configVersions.status })
      .from(configVersions)
      .where(inArray(configVersions.id, [liveCanaryVersionId, supersededVersionId]));
    expect(versions.length).toBe(2);
    expect(versions.find((v) => v.id === liveCanaryVersionId)!.status).toBe("canary");

    // the audited fact: one new row carrying count + cutoff + what was protected
    const audits = await prunedAuditRows();
    expect(audits.length).toBe(auditBefore + 1);
    const fresh = audits.find((r) => !auditIdsBefore.has(r.id))!;
    expect(fresh).toBeDefined();
    const detail = fresh.detail as Record<string, unknown>;
    expect(detail.pruned).toBe(out.pruned);
    expect(detail.retainedDays).toBe(90);
    expect(typeof detail.cutoff).toBe("string");
    expect(fresh.reason).toMatch(/never pruned/);
  });

  it("a second pass finds nothing new — idempotent by data", async () => {
    const out = await runCanaryObservationPrune(db, { actorUserId: null });
    expect(out.pruned).toBe(0);
    expect((await obsById([oldLiveObsId, freshObsId])).length).toBe(2);
  });

  it("the org-settings knob narrows the window, through the ordinary settings surface", async () => {
    const put = await app.inject({
      method: "PUT",
      headers: AUTH,
      url: "/v1/org/settings",
      payload: { canaryObservationRetentionDays: 30 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().settings.canaryObservationRetentionDays).toBe(30);

    const fortyDaysOld = await insertObservation({
      artifactId: deadArtifactId,
      candidateVersionId: supersededVersionId,
      at: new Date(Date.now() - 40 * DAY_MS),
    });

    // the MANUAL DOOR — the same function, exposed exactly as the other
    // sweeps expose theirs
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/config-versions/observations/prune",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().retainedDays).toBe(30);
    expect(res.json().pruned).toBeGreaterThanOrEqual(1);
    expect(res.json().note).toMatch(/config_versions are NEVER pruned/);

    expect(await obsById([fortyDaysOld])).toEqual([]);
    // the live canary's 100-day-old evidence STILL survives a 30-day window
    expect((await obsById([oldLiveObsId])).length).toBe(1);
  });

  it("the manual door is admin-only", async () => {
    const u = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "cop-nonadmin@example.com", displayName: "cop nonadmin" },
    });
    const k = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${u.json().id}/keys`,
      payload: { name: "cop" },
    });
    const res = await app.inject({
      method: "POST",
      headers: { authorization: `Bearer ${k.json().token}` },
      url: "/v1/config-versions/observations/prune",
    });
    expect(res.statusCode).toBe(403);
  });

  it("the ADR-0064 job is registered and CALLS the same function (extract, don't duplicate)", async () => {
    const registry = schedulerJobRegistry();
    const def = registry.get(SCHEDULER_JOB_NAMES.canaryObservationPrune);
    expect(def).toBeDefined();
    expect(def!.adr).toBe("ADR-0073");
    expect(def!.description).toMatch(/Never touches config_versions/);

    const tenDaysOld = await insertObservation({
      artifactId: deadArtifactId,
      candidateVersionId: supersededVersionId,
      at: new Date(Date.now() - 10 * DAY_MS),
    });
    // window is 30d from the previous test: a 10-day-old row must survive a
    // job pass, proving the job reads the same knob the endpoint reads
    const out = await def!.run({ db, actorUserId: null, now: new Date(), runId: randomUUID() });
    expect(out.detail).toMatchObject({ retainedDays: 30 });
    expect((await obsById([tenDaysOld, oldLiveObsId])).length).toBe(2);
  });
});
