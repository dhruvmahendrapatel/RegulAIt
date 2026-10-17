/**
 * ADR-0190 I5 follow-up (review of #397) — THE L1 ENGINE PATH END TO END, and THE REVERT, on a SCRATCH database (its
 * own, created and dropped here), because both write engine-worker versions: in the shared test database that would
 * change the profile every later suite's engine tasks are placed under.
 *  - L1 PLACES ONLY WITH EVERY RELAXATION: the org's engine_worker floor and the project's sensitivity floor at L1, an
 *    engine-worker version at L1 (a `settings_relax` step-up), and a runc executor's fresh L1 attestation of that
 *    version: an engine task is then OFFERED at `hardened_container`, and the first-enable basis is met at L1.
 *  - THE REVERT: a new version whose body equals the shipped version 1 puts v1 back in force WITHOUT a step-up (going
 *    back to a stricter version is free), audited `execution-profile-reverted`, and v2 is withdrawn; engines require
 *    L2 again (the runc executor is refused `class_below_required`). Reverting to a LOOSER earlier version needs the
 *    step-up. A withdrawn version is not reinstated.
 *  - After a revert, versioning again works once migration 0203 (the profile guard) is applied; before that the
 *    gateway refuses it 409 `execution_profile_retired`, never a 500. The expectation follows the journal.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { aiUseCases, and, auditLog, createDb, desc, eq, executionProfiles, orgSettings, ORG_SETTINGS_ID, runMigrations, sql, type Db } from "@regulait/db";
import { EXECUTION_PROFILE_SCHEMA, executionProfileDigest, SHIPPED_EXECUTION_PROFILES, type ExecutionProfileBody } from "@regulait/shared";
import { buildApp } from "./app.js";
import { decidePlacement } from "./execution-placement.js";
import { engineWorkerAttestationBasis } from "./engine-worker-attestation.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const RUN = Math.random().toString(36).slice(2, 8);
const SCRATCH = `a190_ewl1_${process.pid}_${RUN}`;
const scratchUrl = (() => {
  const u = new URL(DATABASE_URL);
  u.pathname = `/${SCRATCH}`;
  return u.toString();
})();
const BOOT = `ewl1-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const IMAGE = `sha256:${"9".repeat(64)}`;
const ENGINE = SHIPPED_EXECUTION_PROFILES["engine-worker"];
const ENGINE_DIGEST = executionProfileDigest(ENGINE);
/** is migration 0203 (the profile guard that allows a version after a revert) in the journal yet? */
const GUARD_0203 = (JSON.parse(readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> }).entries.some((e) =>
  e.tag.startsWith("0203_"),
);

let admin: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminAuth: { authorization: string };
let projectId: string;
let runcExecutorId: string;
let l1Digest: string;
const rows = <R>(r: unknown) => (r as { rows: R[] }).rows;
const inject = (method: "GET" | "POST", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const engineBody = (over: Partial<ExecutionProfileBody> = {}): ExecutionProfileBody => ({ ...structuredClone(ENGINE), schema: EXECUTION_PROFILE_SCHEMA, ...over });
const engineVersions = async () =>
  (await db.select({ version: executionProfiles.version, retiredAt: executionProfiles.retiredAt }).from(executionProfiles).where(eq(executionProfiles.name, "engine-worker")).orderBy(desc(executionProfiles.version))).map(
    (r) => ({ version: r.version, live: r.retiredAt === null }),
  );

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH}`));
  db = createDb(scratchUrl);
  await runMigrations(db, migrationsFolder);
  await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "ewl1".padEnd(64, "k") });
  const adm = await inject("POST", "/v1/users", AUTH, { email: `ewl1-admin-${RUN}@example.com`, displayName: `ewl1 admin ${RUN}`, isAdmin: true });
  expect(adm.statusCode, adm.body).toBe(201);
  adminId = adm.json().id;
  adminAuth = { authorization: `Bearer ${(await inject("POST", `/v1/users/${adminId}/keys`, AUTH, { name: "ewl1" })).json().token}` };
  projectId = rows<{ id: string }>(await db.execute(sql`insert into projects (name, classifications) values (${`ewl1-p-${RUN}`}, '[]'::jsonb) returning id`))[0]!.id;
  await db.insert(aiUseCases).values({ name: `ewl1-uc-${RUN}`, description: "d", ownerUserId: adminId, businessContext: "b", dataSensitivity: "internal", projectId });
  const identityId = rows<{ id: string }>(
    await db.execute(
      sql`insert into workload_identities (kind, identifier, sponsor_user_ids) values ('worker_runtime', ${`spiffe://ewl1.example.org/regulait/worker_runtime/runc-${RUN}`}, ARRAY[${adminId}]::uuid[]) returning id`,
    ),
  )[0]!.id;
  runcExecutorId = rows<{ id: string }>(
    await db.execute(
      sql`insert into executors (workload_identity_id, name, backend, runtime_version, classes_declared) values (${identityId}, ${`ewl1-runc-${RUN}`}, 'runc', '1.2.6', '["hardened_container"]'::jsonb) returning id`,
    ),
  )[0]!.id;
}, 120_000);

afterAll(async () => {
  await closeAll([async () => app?.close(), async () => db?.$client.end(), async () => dropScratchDatabase(admin, SCRATCH), async () => admin?.$client.end()]);
});

describe("the L1 engine path places at L1 only when every relaxation and a fresh L1 attestation exist", () => {
  it("strict first: the shipped L2 profile and the runc executor give class_below_required", async () => {
    // even with a fresh L1 pass of the shipped profile's digest
    await db.execute(
      sql`insert into executor_attestations (executor_id, profile_digest, class, report_sha256, report, verdict, observed_at, expires_at)
          values (${runcExecutorId}, ${ENGINE_DIGEST}, 'hardened_container', ${"a".repeat(64)}, '{}'::jsonb, 'pass', now(), now() + interval '1 hour')`,
    );
    const d = await decidePlacement(db, { workloadKind: "engine_worker", projectId, agent: null, imageDigest: IMAGE, onlyExecutorIds: [runcExecutorId], actorUserId: adminId });
    expect(d).toMatchObject({ kind: "refused", code: "class_below_required" });
  });

  it("org floors at L1 + an engine-worker version at L1 (step-up) + a fresh L1 attestation: offered at hardened_container", async () => {
    await db.update(orgSettings).set({ isolationFloorEngineWorker: "hardened_container", isolationFloorInternal: "hardened_container" }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    // the L1 version is a relaxation: refused without the step-up, written with it (this scratch database only)
    const refused = await inject("POST", "/v1/execution-profiles/engine-worker/versions", adminAuth, { body: engineBody({ minClass: "hardened_container" }) });
    expect(refused.statusCode, refused.body).toBe(403);
    const restore = await relaxStepUpForTest(db);
    try {
      const v2 = await inject("POST", "/v1/execution-profiles/engine-worker/versions", adminAuth, { body: engineBody({ minClass: "hardened_container" }) });
      expect(v2.statusCode, v2.body).toBe(201);
      expect(v2.json()).toMatchObject({ name: "engine-worker", version: 2, minClass: "hardened_container" });
      l1Digest = v2.json().digest;
    } finally {
      await restore();
    }
    // before the executor attests the new version, nothing places (its L1 pass is for v1's digest)
    const stale = await decidePlacement(db, { workloadKind: "engine_worker", projectId, agent: null, imageDigest: IMAGE, onlyExecutorIds: [runcExecutorId], actorUserId: adminId });
    expect(stale).toMatchObject({ kind: "refused" });
    await db.execute(
      sql`insert into executor_attestations (executor_id, profile_digest, class, report_sha256, report, verdict, observed_at, expires_at)
          values (${runcExecutorId}, ${l1Digest}, 'hardened_container', ${"b".repeat(64)}, '{}'::jsonb, 'pass', now(), now() + interval '1 hour')`,
    );
    const d = await decidePlacement(db, { workloadKind: "engine_worker", projectId, agent: null, imageDigest: IMAGE, onlyExecutorIds: [runcExecutorId], actorUserId: adminId });
    expect(d.kind, JSON.stringify(d)).toBe("offered");
    if (d.kind !== "offered") return;
    expect(d).toMatchObject({ executorId: runcExecutorId, attestedClass: "hardened_container" });
    expect(d.requirement).toMatchObject({ requiredClass: "hardened_container", profile: { name: "engine-worker", version: 2, digest: l1Digest } });
    expect(await engineWorkerAttestationBasis(db, { onlyExecutorIds: [runcExecutorId] })).toMatchObject({ attested: true, requiredClass: "hardened_container", profileDigest: l1Digest });
  });
});

describe("the revert: back to the exact shipped body, free, audited, and engines require L2 again", () => {
  it("a version equal to v1 reverts without a step-up (an API key suffices), withdraws v2, and is audited", async () => {
    const r = await inject("POST", "/v1/execution-profiles/engine-worker/versions", adminAuth, { body: engineBody() });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ name: "engine-worker", version: 1, digest: ENGINE_DIGEST, minClass: "user_space_kernel", revertedFrom: { version: 2 }, withdrawnVersions: [2] });
    expect(await engineVersions()).toEqual([
      { version: 2, live: false },
      { version: 1, live: true },
    ]);
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "execution-profile-reverted"), eq(auditLog.objectType, "execution_profile")));
    expect(audit?.detail).toMatchObject({ name: "engine-worker", version: 1, revertedFrom: { version: 2 }, relaxations: [], stepUp: null });
  });

  it("engines require L2 again: the runc executor is refused class_below_required and the first-enable basis is not met", async () => {
    // the org floors are still at L1 here: the profile in force (v1, L2) binds
    const d = await decidePlacement(db, { workloadKind: "engine_worker", projectId, agent: null, imageDigest: IMAGE, onlyExecutorIds: [runcExecutorId], actorUserId: adminId });
    expect(d).toMatchObject({ kind: "refused", code: "class_below_required" });
    expect(await engineWorkerAttestationBasis(db, { onlyExecutorIds: [runcExecutorId] })).toMatchObject({ attested: false, requiredClass: "user_space_kernel", profileDigest: ENGINE_DIGEST });
  });

  it("v1 again is unchanged; the withdrawn v2 is not reinstated", async () => {
    const same = await inject("POST", "/v1/execution-profiles/engine-worker/versions", adminAuth, { body: engineBody() });
    expect(same.statusCode, same.body).toBe(409);
    expect(same.json()).toMatchObject({ error: "execution_profile_unchanged" });
    const restore = await relaxStepUpForTest(db);
    try {
      const v2again = await inject("POST", "/v1/execution-profiles/engine-worker/versions", adminAuth, { body: engineBody({ minClass: "hardened_container" }) });
      expect(v2again.statusCode, v2again.body).toBe(409);
      expect(v2again.json()).toMatchObject({ error: "execution_profile_unchanged", detail: expect.stringMatching(/withdrawn/) });
    } finally {
      await restore();
    }
  });

  it(`after a revert a new version is ${GUARD_0203 ? "written (migration 0203)" : "refused 409 execution_profile_retired until migration 0203 is applied"}`, async () => {
    // a tightening (L3): no step-up either way
    const r = await inject("POST", "/v1/execution-profiles/engine-worker/versions", adminAuth, { body: engineBody({ minClass: "microvm" }) });
    if (GUARD_0203) {
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json()).toMatchObject({ version: 3, minClass: "microvm" });
    } else {
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ error: "execution_profile_retired" });
    }
  });

  it("reverting to a LOOSER earlier version is a relaxation: settings_relax step-up", async () => {
    const name = `ewl1-custom-${RUN}`;
    const v1Body: ExecutionProfileBody = { ...structuredClone(SHIPPED_EXECUTION_PROFILES.restricted), schema: EXECUTION_PROFILE_SCHEMA, name, minClass: "microvm" };
    const v1 = await inject("POST", "/v1/execution-profiles", adminAuth, { body: v1Body });
    expect(v1.statusCode, v1.body).toBe(201);
    const v2 = await inject("POST", `/v1/execution-profiles/${name}/versions`, adminAuth, { body: { ...v1Body, resources: { ...v1Body.resources, cpuMillis: 500 } } });
    expect(v2.statusCode, v2.body).toBe(201);
    const back = await inject("POST", `/v1/execution-profiles/${name}/versions`, adminAuth, { body: v1Body });
    expect(back.statusCode, back.body).toBe(403);
    expect(back.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    const live = await db.select({ version: executionProfiles.version }).from(executionProfiles).where(and(eq(executionProfiles.name, name), sql`${executionProfiles.retiredAt} is null`));
    expect(live.map((x) => x.version).sort()).toEqual([1, 2]);
  });
});
