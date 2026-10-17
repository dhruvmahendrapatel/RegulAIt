/**
 * ADR-0190 I5 follow-up (review of #397) — THE L1 ENGINE PATH END TO END, and THE REVERT, on a SCRATCH database (its
 * own, created and dropped here), because both write engine-worker versions: in the shared test database that would
 * change the profile every later suite's engine tasks are placed under.
 *  - L1 PLACES ONLY WITH EVERY RELAXATION: the org's engine_worker floor and the project's sensitivity floor at L1, an
 *    engine-worker version at L1 (a `settings_relax` step-up), and a runc executor's fresh L1 attestation of that
 *    version: an engine task is then OFFERED at `hardened_container`, and the first-enable basis is met at L1.
 *  - THE REVERT is a NEW version: a body equal to the shipped version 1 is written as v3 (v1's controls plus the
 *    gateway's `revertOf` marker, so its digest differs) WITHOUT a step-up (going back to a stricter body is free),
 *    audited `execution-profile-reverted`; nothing is retired or changed, and engines require L2 again. Reverting to a
 *    LOOSER earlier version needs the step-up and is audited `execution-profile-relaxed`.
 *  - RETIREMENT STAYS TERMINAL (migration 0183's guard, unchanged): a reverted profile, once retired, is never
 *    un-retired, changed or versioned again.
 *  - A new version is a compare-and-set under the per-name lock: another version landing first refuses
 *    `changed_concurrently`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiUseCases, and, auditLog, createDb, desc, eq, executionProfiles, orgSettings, ORG_SETTINGS_ID, runMigrations, sql, type Db } from "@regulait/db";
import { canonicalExecutionProfile, EXECUTION_PROFILE_SCHEMA, executionProfileDigest, SHIPPED_EXECUTION_PROFILES, type ExecutionProfileBody } from "@regulait/shared";
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

describe("the revert: a NEW version with the exact shipped controls, free, audited, and engines require L2 again", () => {
  let v3: { id: string; digest: string };
  it("a version equal to v1 is written as v3 (v1's body plus the gateway's marker) without a step-up; nothing is retired", async () => {
    const r = await inject("POST", "/v1/execution-profiles/engine-worker/versions", adminAuth, { body: engineBody() });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ name: "engine-worker", version: 3, minClass: "user_space_kernel", revertOf: { version: 1, digest: ENGINE_DIGEST, replacing: 2 } });
    v3 = { id: r.json().id, digest: r.json().digest };
    expect(v3.digest).not.toBe(ENGINE_DIGEST);
    // every control is v1's: only the marker differs
    const { revertOf, ...controls } = r.json().body as ExecutionProfileBody;
    expect(revertOf).toEqual({ version: 1, digest: ENGINE_DIGEST, replacing: 2 });
    expect(executionProfileDigest(controls as ExecutionProfileBody)).toBe(ENGINE_DIGEST);
    // retirement untouched: v1, v2 and v3 are all live, v1 and v2 unchanged
    expect(await engineVersions()).toEqual([
      { version: 3, live: true },
      { version: 2, live: true },
      { version: 1, live: true },
    ]);
    const [reverted] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "execution-profile-reverted"), eq(auditLog.objectId, v3.id)));
    expect(reverted?.detail).toMatchObject({ name: "engine-worker", version: 3, revertOf: { version: 1, replacing: 2 }, relaxations: [], stepUp: null });
  });

  it("engines require L2 again: the runc executor is refused class_below_required and the first-enable basis is not met", async () => {
    // the org floors are still at L1 here: the profile in force (v3, L2) binds
    const d = await decidePlacement(db, { workloadKind: "engine_worker", projectId, agent: null, imageDigest: IMAGE, onlyExecutorIds: [runcExecutorId], actorUserId: adminId });
    expect(d).toMatchObject({ kind: "refused" });
    if (d.kind === "refused") expect(["class_below_required", "attestation_stale", "no_executor"]).toContain(d.code);
    // with a fresh L1 pass of v3's digest it is exactly class_below_required (L1 never meets the L2 floor)
    await db.execute(
      sql`insert into executor_attestations (executor_id, profile_digest, class, report_sha256, report, verdict, observed_at, expires_at)
          values (${runcExecutorId}, ${v3.digest}, 'hardened_container', ${"c".repeat(64)}, '{}'::jsonb, 'pass', now(), now() + interval '1 hour')`,
    );
    const again = await decidePlacement(db, { workloadKind: "engine_worker", projectId, agent: null, imageDigest: IMAGE, onlyExecutorIds: [runcExecutorId], actorUserId: adminId });
    expect(again).toMatchObject({ kind: "refused", code: "class_below_required" });
    // the profile in force is the revert version v3 itself (its digest), not v1
    if (again.kind === "refused" && again.requirement.kind === "required") {
      expect(again.requirement.profile).toMatchObject({ name: "engine-worker", version: 3, digest: v3.digest, minClass: "user_space_kernel" });
    } else {
      throw new Error(`expected a resolved requirement, got ${JSON.stringify(again)}`);
    }
    expect(await engineWorkerAttestationBasis(db, { onlyExecutorIds: [runcExecutorId] })).toMatchObject({ attested: false, requiredClass: "user_space_kernel", profileDigest: v3.digest });
  });

  it("the same controls again are unchanged; a client's own marker on NEW controls is dropped (a plain version)", async () => {
    const same = await inject("POST", "/v1/execution-profiles/engine-worker/versions", adminAuth, { body: engineBody() });
    expect(same.statusCode, same.body).toBe(409);
    expect(same.json()).toMatchObject({ error: "execution_profile_unchanged" });
    // a tightening (L3) with a forged marker: written as a plain v4, the marker stripped from the answer and the row
    const forgedMarker = { version: 1, digest: "f".repeat(64), replacing: 9 };
    const v4 = await inject("POST", "/v1/execution-profiles/engine-worker/versions", adminAuth, { body: { ...engineBody({ minClass: "microvm" }), revertOf: forgedMarker } });
    expect(v4.statusCode, v4.body).toBe(201);
    expect(v4.json()).toMatchObject({ version: 4, minClass: "microvm" });
    expect(v4.json().revertOf).toBeUndefined();
    expect(v4.json().body.revertOf).toBeUndefined();
    const [stored] = await db.select().from(executionProfiles).where(eq(executionProfiles.id, v4.json().id));
    expect(JSON.parse(stored!.body).revertOf).toBeUndefined();
    expect(stored!.digest).toBe(executionProfileDigest(engineBody({ minClass: "microvm" })));
    expect(await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "execution-profile-reverted"), eq(auditLog.objectId, v4.json().id)))).toEqual([]);
  });

  it("reverting to a LOOSER earlier version is a relaxation: step-up, and audited execution-profile-relaxed", async () => {
    const name = `ewl1-custom-${RUN}`;
    const v1Body: ExecutionProfileBody = { ...structuredClone(SHIPPED_EXECUTION_PROFILES.restricted), schema: EXECUTION_PROFILE_SCHEMA, name, minClass: "microvm" };
    const v1 = await inject("POST", "/v1/execution-profiles", adminAuth, { body: v1Body });
    expect(v1.statusCode, v1.body).toBe(201);
    const v2 = await inject("POST", `/v1/execution-profiles/${name}/versions`, adminAuth, { body: { ...v1Body, resources: { ...v1Body.resources, cpuMillis: 500 } } });
    expect(v2.statusCode, v2.body).toBe(201);
    const back = await inject("POST", `/v1/execution-profiles/${name}/versions`, adminAuth, { body: v1Body });
    expect(back.statusCode, back.body).toBe(403);
    expect(back.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    const restore = await relaxStepUpForTest(db);
    let v3id: string;
    try {
      const done = await inject("POST", `/v1/execution-profiles/${name}/versions`, adminAuth, { body: v1Body });
      expect(done.statusCode, done.body).toBe(201);
      expect(done.json()).toMatchObject({ version: 3, revertOf: { version: 1, replacing: 2 } });
      v3id = done.json().id;
    } finally {
      await restore();
    }
    const [reverted] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "execution-profile-reverted"), eq(auditLog.objectId, v3id)));
    expect(reverted?.detail).toMatchObject({ relaxations: ["resources"] });
    const [relaxed] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "execution-profile-relaxed"), eq(auditLog.objectId, v3id)));
    expect(relaxed?.detail).toMatchObject({ name, version: 3, revert: true, relaxedAgainstPrevious: ["resources"] });
  });
});

describe("retirement stays terminal after a revert (the 0183 guard is unchanged)", () => {
  it("a reverted profile, once retired, is never un-retired, changed or versioned again", async () => {
    const name = `ewl1-terminal-${RUN}`;
    const v1Body: ExecutionProfileBody = { ...structuredClone(SHIPPED_EXECUTION_PROFILES.restricted), schema: EXECUTION_PROFILE_SCHEMA, name, minClass: "microvm" };
    expect((await inject("POST", "/v1/execution-profiles", adminAuth, { body: v1Body })).statusCode).toBe(201);
    expect((await inject("POST", `/v1/execution-profiles/${name}/versions`, adminAuth, { body: { ...v1Body, resources: { ...v1Body.resources, cpuMillis: 500 } } })).statusCode).toBe(201);
    const restore = await relaxStepUpForTest(db);
    try {
      expect((await inject("POST", `/v1/execution-profiles/${name}/versions`, adminAuth, { body: v1Body })).statusCode).toBe(201);
    } finally {
      await restore();
    }
    expect((await inject("POST", `/v1/execution-profiles/${name}/retire`, adminAuth, {})).statusCode).toBe(200);
    // the route refuses a version of a retired profile, including another revert
    for (const body of [v1Body, { ...v1Body, resources: { ...v1Body.resources, cpuMillis: 250 } }]) {
      const r = await inject("POST", `/v1/execution-profiles/${name}/versions`, adminAuth, { body });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ error: "execution_profile_retired" });
    }
    // the guard refuses un-retiring, re-stamping and a new version row, whatever the gateway does
    const refused = async (stmt: ReturnType<typeof sql>) =>
      db.execute(stmt).then(
        () => "",
        (e: unknown) => String((e as Error)?.message ?? "") + String((e as { cause?: Error })?.cause?.message ?? ""),
      );
    expect(await refused(sql`update execution_profiles set retired_at = null, retired_by = null where name = ${name} and version = 3`)).toMatch(/retirement is terminal/);
    expect(await refused(sql`update execution_profiles set retired_at = now() where name = ${name} and version = 1`)).toMatch(/retirement is terminal/);
    // a body no row holds (so only the retirement can refuse it)
    const fresh: ExecutionProfileBody = { ...v1Body, resources: { ...v1Body.resources, cpuMillis: 125 } };
    expect(await refused(sql`insert into execution_profiles (name, version, body, digest, min_class) values (${name}, 4, ${canonicalExecutionProfile(fresh)}, ${executionProfileDigest(fresh)}, 'microvm')`)).toMatch(/is retired/);
    const live = await db.select({ version: executionProfiles.version }).from(executionProfiles).where(and(eq(executionProfiles.name, name), sql`${executionProfiles.retiredAt} is null`));
    expect(live).toEqual([]);
  });
});

describe("review of #397: two versions cannot interleave", () => {
  it("a version judged against v2 refuses changed_concurrently when another version lands before its insert", async () => {
    const name = `ewl1-race-${RUN}`;
    const v1Body: ExecutionProfileBody = { ...structuredClone(SHIPPED_EXECUTION_PROFILES.restricted), schema: EXECUTION_PROFILE_SCHEMA, name, minClass: "microvm" };
    expect((await inject("POST", "/v1/execution-profiles", adminAuth, { body: v1Body })).statusCode).toBe(201);
    const v2 = await inject("POST", `/v1/execution-profiles/${name}/versions`, adminAuth, { body: { ...v1Body, resources: { ...v1Body.resources, cpuMillis: 500 } } });
    expect(v2.statusCode).toBe(201);
    let pending: ReturnType<typeof inject> | undefined;
    await db.transaction(async (tx) => {
      // hold the per-name lock the route takes before its insert
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`execution_profiles:${name}`}))`);
      pending = inject("POST", `/v1/execution-profiles/${name}/versions`, adminAuth, { body: { ...v1Body, resources: { ...v1Body.resources, cpuMillis: 400 } } });
      // wait until the request has read the state and is blocked on the lock (an ungranted advisory lock here)
      let waiting = 0;
      for (let i = 0; i < 400 && waiting === 0; i++) {
        waiting = rows<{ n: number }>(
          await db.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`),
        )[0]!.n;
        if (waiting === 0) await new Promise((r) => setTimeout(r, 25));
      }
      expect(waiting).toBeGreaterThan(0);
      // another version (here a revert to v1's controls, as the route would write it) lands first, as v3
      const marked: ExecutionProfileBody = { ...v1Body, revertOf: { version: 1, digest: executionProfileDigest(v1Body), replacing: 2 } };
      await tx.insert(executionProfiles).values({ name, version: 3, body: canonicalExecutionProfile(marked), digest: executionProfileDigest(marked), minClass: "microvm", shipped: false, createdBy: adminId });
    });
    const r = await pending!;
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json()).toMatchObject({ error: "changed_concurrently" });
    const versions = await db.select({ version: executionProfiles.version }).from(executionProfiles).where(eq(executionProfiles.name, name));
    expect(versions.map((x) => x.version).sort()).toEqual([1, 2, 3]);
  });
});
