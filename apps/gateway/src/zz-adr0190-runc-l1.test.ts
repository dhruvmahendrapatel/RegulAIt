/**
 * ADR-0190 I5 follow-up — AN L1 (runc) EXECUTOR NEVER SATISFIES AN L2 OR L3 FLOOR, and THE VERSIONED engine-worker
 * PROFILE, on a real database through the real app:
 *  - THE DATABASE: a runc executor that declares L2 is refused (`executors_classes_declared_check`).
 *  - THE BROKER: a runc executor with a fresh L1 attestation of an L1 profile is offered an L1 placement, and is
 *    refused `class_below_required` for an L2 or an L3 one (no offer, no fallback).
 *  - THE READ-SIDE BACKSTOP: a (forged) L2 pass row on a runc executor never counts (`freshAttestation` is null), so
 *    the broker refuses and nothing is offered.
 *  - ENGINES: an engine task's placement (agent null) with only a runc executor attesting L1 refuses
 *    `class_below_required` under the strict defaults, and STILL refuses when the org's engine_worker and sensitivity
 *    floors are relaxed to L1, because the engine-worker profile in force (the shipped version 1) is L2. The
 *    first-enable basis is not met by it either.
 *  - THE PROFILE ROUTES: engine-worker is versioned through the ordinary version flow (an unchanged body is refused
 *    `execution_profile_unchanged`, not `shipped_profile_immutable`); an L1 version needs the `settings_relax` step-up
 *    (an API key cannot give it); a version must keep the engine shape; engine-worker is never retired; `restricted`
 *    is still never versioned.
 *
 * Global state (M-068): the org floors changed in one test are put back to the values read in `beforeAll` (not the
 * strict defaults: another suite may run with other values); every executor this file registers is revoked in
 * `afterAll` and its open offers withdrawn; other rows are scoped by this run's ids. This file NEVER writes an
 * engine-worker version: in this shared database that would change the profile every later suite's engine tasks are
 * placed under. The L1 engine path that does write one (placed at L1 with all three relaxations, then reverted to the
 * shipped body) runs on its own scratch database: `zz-adr0190-engine-worker-l1.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  aiUseCases,
  and,
  createDb,
  desc,
  eq,
  executionOffers,
  executionPlacements,
  executionProfiles,
  executors,
  inArray,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import {
  canonicalExecutionProfile,
  EXECUTION_PROFILE_SCHEMA,
  executionProfileDigest,
  SHIPPED_EXECUTION_PROFILES,
  type ExecutionProfileBody,
} from "@regulait/shared";
import { buildApp } from "./app.js";
import { decidePlacement } from "./execution-placement.js";
import { offerPlacement } from "./executor-channel.js";
import { attestableBy, freshAttestation } from "./executor-attestation.js";
import { engineWorkerAttestationBasis } from "./engine-worker-attestation.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `l1-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ENV = `l1-${RUN}`;
const IMAGE = `sha256:${"b".repeat(64)}`;
const ENGINE = SHIPPED_EXECUTION_PROFILES["engine-worker"];
const ENGINE_DIGEST = executionProfileDigest(ENGINE);
const RESTRICTED_DIGEST = executionProfileDigest(SHIPPED_EXECUTION_PROFILES.restricted);

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminAuth: { authorization: string };
/** an admin's L1 profile (the shipped restricted at hardened_container), written as its own row for this run */
let l1Digest: string;
const restores: Array<() => Promise<void>> = [];
/** every executor this file registers (revoked in afterAll, its open offers withdrawn) */
const createdExecutors: string[] = [];
/** the org floors as they were before this file ran (put back after the one test that changes them) */
let priorFloors: { isolationFloorEngineWorker: string; isolationFloorInternal: string };
const rows = <R>(r: unknown) => (r as { rows: R[] }).rows;
const inject = (method: "GET" | "POST", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const offersFor = async (executorId: string) => (await db.select().from(executionOffers).where(eq(executionOffers.executorId, executorId))).length;
const errorText = (e: unknown) => String((e as Error)?.message ?? "") + String((e as { cause?: Error })?.cause?.message ?? "");

async function workerIdentity(name: string): Promise<string> {
  return rows<{ id: string }>(
    await db.execute(
      sql`insert into workload_identities (kind, identifier, sponsor_user_ids, environments)
          values ('worker_runtime', ${`spiffe://l1.example.org/regulait/worker_runtime/${name}-${RUN}`}, ARRAY[${adminId}]::uuid[], ARRAY[${ENV}]) returning id`,
    ),
  )[0]!.id;
}

/** a runc executor (L1 only, as its registration must say) and one fresh pass per (profile digest, class) given */
async function runcExecutor(name: string, attest: Array<{ digest: string; cls: string }>): Promise<string> {
  const identityId = await workerIdentity(name);
  const executorId = rows<{ id: string }>(
    await db.execute(
      sql`insert into executors (workload_identity_id, name, backend, runtime_version, classes_declared)
          values (${identityId}, ${`l1-${name}-${RUN}`}, 'runc', '1.2.6', '["hardened_container"]'::jsonb) returning id`,
    ),
  )[0]!.id;
  createdExecutors.push(executorId);
  for (const a of attest) {
    await db.execute(
      sql`insert into executor_attestations (executor_id, profile_digest, class, report_sha256, report, verdict, observed_at, expires_at)
          values (${executorId}, ${a.digest}, ${a.cls}, ${"a".repeat(64)}, '{}'::jsonb, 'pass', now(), now() + interval '1 hour')`,
    );
  }
  return executorId;
}

async function newProject(sensitivity: "public" | "internal" | "confidential" | "regulated"): Promise<string> {
  const projectId = rows<{ id: string }>(await db.execute(sql`insert into projects (name, classifications) values (${`l1-p-${RUN}-${randomUUID().slice(0, 8)}`}, '[]'::jsonb) returning id`))[0]!.id;
  await db.insert(aiUseCases).values({ name: `l1-uc-${RUN}`, description: "d", ownerUserId: adminId, businessContext: "b", dataSensitivity: sensitivity, projectId });
  return projectId;
}

const engineVersions = async () => (await db.select({ version: executionProfiles.version }).from(executionProfiles).where(eq(executionProfiles.name, "engine-worker")).orderBy(desc(executionProfiles.version))).map((r) => r.version);
const engineBody = (over: Partial<ExecutionProfileBody> = {}): ExecutionProfileBody => ({ ...structuredClone(ENGINE), schema: EXECUTION_PROFILE_SCHEMA, ...over });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "l1".padEnd(64, "k") });
  const adm = await inject("POST", "/v1/users", AUTH, { email: `l1-admin-${RUN}@example.com`, displayName: `l1 admin ${RUN}`, isAdmin: true });
  expect(adm.statusCode, adm.body).toBe(201);
  adminId = adm.json().id;
  adminAuth = { authorization: `Bearer ${(await inject("POST", `/v1/users/${adminId}/keys`, AUTH, { name: "l1" })).json().token}` };
  // an L1 profile of this run's own, inserted as version 1 (canonical body and digest, as the route would write it)
  const l1: ExecutionProfileBody = { ...structuredClone(SHIPPED_EXECUTION_PROFILES.restricted), schema: EXECUTION_PROFILE_SCHEMA, name: `l1-team-${RUN}`, minClass: "hardened_container" };
  l1Digest = executionProfileDigest(l1);
  await db.insert(executionProfiles).values({ name: l1.name, version: 1, body: canonicalExecutionProfile(l1), digest: l1Digest, minClass: "hardened_container", shipped: false, createdBy: adminId });
  const [floors] = await db.select({ isolationFloorEngineWorker: orgSettings.isolationFloorEngineWorker, isolationFloorInternal: orgSettings.isolationFloorInternal }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  priorFloors = { isolationFloorEngineWorker: String(floors!.isolationFloorEngineWorker), isolationFloorInternal: String(floors!.isolationFloorInternal) };
}, 120_000);

afterAll(async () => {
  // M-068: nothing this file registered can take work after it: open offers withdrawn, executors revoked (terminal; an
  // executor is never deleted), through the admin route so the revoke is audited like any other
  if (createdExecutors.length > 0) {
    await db.execute(
      sql`update execution_offers set status = 'withdrawn', ended_at = now() where executor_id in (${sql.join(createdExecutors.map((id) => sql`${id}::uuid`), sql`, `)}) and status in ('offered', 'accepted')`,
    );
    for (const id of createdExecutors) {
      const r = await inject("POST", `/v1/executors/${id}/revoke`, adminAuth, {});
      if (r.statusCode !== 200) await db.update(executors).set({ status: "revoked", updatedAt: sql`now()` }).where(and(eq(executors.id, id), sql`${executors.status} <> 'revoked'`));
    }
    const left = await db.select({ id: executors.id }).from(executors).where(and(inArray(executors.id, createdExecutors), sql`${executors.status} <> 'revoked'`));
    expect(left).toEqual([]);
  }
  for (const r of restores.reverse()) await r();
  await app.close();
});

// ---------------------------------------------------------------------------
describe("an L1 (runc) executor never satisfies an L2 or L3 floor", () => {
  it("the database refuses a runc executor that declares L2 (the registration backstop)", async () => {
    const identityId = await workerIdentity("declares-l2");
    const refused = await db
      .execute(
        sql`insert into executors (workload_identity_id, name, backend, runtime_version, classes_declared)
            values (${identityId}, ${`l1-declares-l2-${RUN}`}, 'runc', '1.2.6', '["hardened_container", "user_space_kernel"]'::jsonb)`,
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(errorText(refused)).toMatch(/executors_classes_declared_check/);
  });

  it("the broker: an L1 attestation is offered an L1 placement, and refused class_below_required at L2 and at L3", async () => {
    const ex = await runcExecutor("broker", [{ digest: l1Digest, cls: "hardened_container" }]);
    // negative control: the L1 requirement is met
    const ok = await offerPlacement(db, { workloadKind: "mcp_stdio", requiredClass: "hardened_container", requiredBy: "configured_profile", profileDigest: l1Digest, imageDigest: IMAGE, onlyExecutorIds: [ex] });
    expect(ok).toMatchObject({ kind: "offered", executorId: ex, attestedClass: "hardened_container" });
    expect(await offersFor(ex)).toBe(1);
    for (const requiredClass of ["user_space_kernel", "microvm"] as const) {
      const r = await offerPlacement(db, { workloadKind: "mcp_stdio", requiredClass, requiredBy: "data_sensitivity", profileDigest: l1Digest, imageDigest: IMAGE, onlyExecutorIds: [ex] });
      expect(r, requiredClass).toMatchObject({ kind: "refused", code: "class_below_required" });
      if (r.kind === "refused" && r.placementId) {
        const [p] = await db.select().from(executionPlacements).where(eq(executionPlacements.id, r.placementId));
        expect(p).toMatchObject({ outcome: "refused", refusalCode: "class_below_required", requiredClass, executorId: null });
      }
    }
    // the two refusals made no offer: still only the L1 one
    expect(await offersFor(ex)).toBe(1);
  });

  it("the read-side backstop: a forged L2 pass row on a runc executor never counts, so nothing is offered", async () => {
    expect(attestableBy("runc", ["hardened_container"], "user_space_kernel")).toBe(false);
    expect(attestableBy("runc", ["hardened_container"], "microvm")).toBe(false);
    expect(attestableBy("runc", ["hardened_container"], "hardened_container")).toBe(true);
    expect(attestableBy("gvisor", ["hardened_container"], "user_space_kernel")).toBe(false);
    // the row a broken writer (or a hand edit) might leave: the executor's backend cannot attest it
    const ex = await runcExecutor("forged", [{ digest: RESTRICTED_DIGEST, cls: "user_space_kernel" }]);
    const now = rows<{ now: Date }>(await db.execute(sql`select now() as now`))[0]!.now;
    expect(await freshAttestation(db, ex, RESTRICTED_DIGEST, new Date(now))).toBeNull();
    const r = await offerPlacement(db, { workloadKind: "mcp_stdio", requiredClass: "user_space_kernel", requiredBy: "workload_kind", profileDigest: RESTRICTED_DIGEST, imageDigest: IMAGE, onlyExecutorIds: [ex] });
    expect(r).toMatchObject({ kind: "refused", code: "attestation_stale" });
    expect(await offersFor(ex)).toBe(0);
  });
});

describe("engine tasks: the engine_worker floor stays L2 (OWNER DECISION 4) against an L1 executor", () => {
  it("strict defaults: an engine task with only a runc executor attesting L1 refuses class_below_required, no offer", async () => {
    // the runc executor even holds a fresh L1 pass for the engine-worker profile's digest: L1 never meets its L2 floor
    const ex = await runcExecutor("engine", [{ digest: ENGINE_DIGEST, cls: "hardened_container" }]);
    const projectId = await newProject("internal");
    const d = await decidePlacement(db, { workloadKind: "engine_worker", projectId, agent: null, imageDigest: IMAGE, onlyExecutorIds: [ex], actorUserId: adminId });
    expect(d).toMatchObject({ kind: "refused", code: "class_below_required" });
    expect(await offersFor(ex)).toBe(0);
    const basis = await engineWorkerAttestationBasis(db, { onlyExecutorIds: [ex] });
    expect(basis).toMatchObject({ attested: false, reason: "no_fresh_attestation", requiredClass: "user_space_kernel", profileDigest: ENGINE_DIGEST });
  });

  it("with the org's engine_worker and sensitivity floors relaxed to L1, the L2 engine-worker profile still binds", async () => {
    const ex = await runcExecutor("engine-relaxed", [{ digest: ENGINE_DIGEST, cls: "hardened_container" }]);
    const projectId = await newProject("internal");
    try {
      await db.update(orgSettings).set({ isolationFloorEngineWorker: "hardened_container", isolationFloorInternal: "hardened_container" }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
      const d = await decidePlacement(db, { workloadKind: "engine_worker", projectId, agent: null, imageDigest: IMAGE, onlyExecutorIds: [ex], actorUserId: adminId });
      expect(d).toMatchObject({ kind: "refused", code: "class_below_required" });
      if (d.kind === "refused" && d.placementId) {
        const [p] = await db.select().from(executionPlacements).where(eq(executionPlacements.id, d.placementId));
        // the broker raised the requirement to the profile's own floor: named for what it is
        expect(p).toMatchObject({ outcome: "refused", refusalCode: "class_below_required", requiredClass: "user_space_kernel", requiredBy: "configured_profile" });
      }
      expect(await offersFor(ex)).toBe(0);
      expect(await engineWorkerAttestationBasis(db, { onlyExecutorIds: [ex] })).toMatchObject({ attested: false, requiredClass: "user_space_kernel" });
    } finally {
      await db
        .update(orgSettings)
        .set(priorFloors as Partial<typeof orgSettings.$inferInsert>)
        .where(eq(orgSettings.id, ORG_SETTINGS_ID));
    }
  });
});

describe("the engine-worker profile is versioned through the ordinary flow (refusals only: nothing is written)", () => {
  it("is versionable: an unchanged body is execution_profile_unchanged, not shipped_profile_immutable; restricted still is", async () => {
    const before = await engineVersions();
    const same = await inject("POST", "/v1/execution-profiles/engine-worker/versions", adminAuth, { body: engineBody() });
    expect(same.statusCode, same.body).toBe(409);
    expect(same.json()).toMatchObject({ error: "execution_profile_unchanged" });
    const restricted = await inject("POST", "/v1/execution-profiles/restricted/versions", adminAuth, { body: { ...structuredClone(SHIPPED_EXECUTION_PROFILES.restricted), minClass: "microvm" } });
    expect(restricted.statusCode, restricted.body).toBe(409);
    expect(restricted.json()).toMatchObject({ error: "shipped_profile_immutable" });
    expect(await engineVersions()).toEqual(before);
  });

  it("an L1 version is a relaxation: settings_relax step-up, which an API key cannot give; nothing is written", async () => {
    const before = await engineVersions();
    const r = await inject("POST", "/v1/execution-profiles/engine-worker/versions", adminAuth, { body: engineBody({ minClass: "hardened_container" }) });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    expect(await engineVersions()).toEqual(before);
  });

  it("a version keeps the engine shape; the name must match; engine-worker is never created again nor retired", async () => {
    const before = await engineVersions();
    const kinds = await inject("POST", "/v1/execution-profiles/engine-worker/versions", adminAuth, { body: engineBody({ workloadKinds: ["engine_worker", "mcp_stdio"] }) });
    expect(kinds.statusCode, kinds.body).toBe(400);
    expect(kinds.json()).toMatchObject({ error: "engine_worker_profile_shape" });
    const noInput = await inject("POST", "/v1/execution-profiles/engine-worker/versions", adminAuth, { body: engineBody({ filesystem: { ...structuredClone(ENGINE.filesystem), inputs: [] } }) });
    expect(noInput.statusCode, noInput.body).toBe(400);
    expect(noInput.json()).toMatchObject({ error: "engine_worker_profile_shape" });
    const other = await inject("POST", "/v1/execution-profiles/engine-worker/versions", adminAuth, { body: engineBody({ name: `l1-other-${RUN}` }) });
    expect(other.statusCode, other.body).toBe(400);
    expect(other.json()).toMatchObject({ error: "profile_name_mismatch" });
    const create = await inject("POST", "/v1/execution-profiles", adminAuth, { body: engineBody({ minClass: "microvm" }) });
    expect(create.statusCode, create.body).toBe(409);
    expect(create.json()).toMatchObject({ error: "execution_profile_exists" });
    const retire = await inject("POST", "/v1/execution-profiles/engine-worker/retire", adminAuth, {});
    expect(retire.statusCode, retire.body).toBe(409);
    expect(retire.json()).toMatchObject({ error: "shipped_profile_immutable" });
    expect(await engineVersions()).toEqual(before);
  });
});
