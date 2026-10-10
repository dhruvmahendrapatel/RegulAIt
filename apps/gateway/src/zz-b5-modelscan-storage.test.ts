/**
 * ADR-0187 decisions 127-128 (PR #212 review follow-up) — BOUNDED MODEL-ARTIFACT STORAGE against the real
 * gateway on a real database:
 *
 *   [4235322397] quotas on stored bytes and artifact count, per uploader and for the deployment, decided
 *                under one lock (concurrent uploads cannot overshoot); DELETE by the uploader or an admin
 *                with a step-up, refused while a scan is cited or a run is unfinished; the retention sweep;
 *                a stored object deleted only after its row is gone and committed, a failed delete retried.
 *   [4235322386] a `clean` scan with a NULL format is refused by the database.
 *
 * Every assertion over shared tables is a delta or scoped to this file's own rows (the suite shares its
 * database with the other gateway files).
 */
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  artifactScans,
  auditLog,
  authSessions,
  createDb,
  engineRuns,
  eq,
  inArray,
  modelArtifactObjectDeletions,
  modelArtifacts,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { BATCH5_STRICT_DEFAULTS, STEP_UP_HEADER } from "@regulait/shared";
import { buildApp } from "./app.js";
import {
  artifactDeleteStepUp,
  artifactStorageKey,
  FileArtifactStore,
  MODEL_ARTIFACT_RETENTION_JOB_NAME,
  modelArtifactTestHooks,
  runModelArtifactRetentionSweep,
  type ArtifactStore,
} from "./model-artifacts.js";
import { schedulerJobRegistry } from "./scheduler-jobs.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { forgetStepUpMethodsForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `b5n-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;
const MIB = 1024 * 1024;

/**
 * The file store, observed: every delete records whether a row still named the key at that moment
 * (read on ANOTHER connection, so only committed state is visible), and the next `failDeletes`
 * deletes throw.
 */
class ObservedStore implements ArtifactStore {
  readonly kind = "filesystem" as const;
  failDeletes = 0;
  deletes: Array<{ key: string; rowVisible: boolean; failed: boolean }> = [];
  constructor(
    readonly inner: FileArtifactStore,
    private readonly observer: () => Db,
  ) {}
  has(key: string) {
    return this.inner.has(key);
  }
  putFile(key: string, file: string, sha256: string, size: number) {
    void sha256;
    void size;
    return this.inner.putFile(key, file);
  }
  open(key: string) {
    return this.inner.open(key);
  }
  async delete(key: string) {
    const named = await this.observer().select({ id: modelArtifacts.id }).from(modelArtifacts).where(eq(modelArtifacts.storageKey, key));
    const failed = this.failDeletes > 0;
    this.deletes.push({ key, rowVisible: named.length > 0, failed });
    if (failed) {
      this.failDeletes -= 1;
      throw new Error("injected object-store failure");
    }
    await this.inner.delete(key);
  }
}

let db: Db;
let observer: Db;
let app: ReturnType<typeof buildApp>;
let storeDir: string;
let store: ObservedStore;
let restoreIdentity: (() => Promise<void>) | undefined;
let restoreGates: (() => Promise<void>) | undefined;
type Person = { id: string; key: { authorization: string }; session: string; auth: SoftAuthenticator };
let admin: Person;
let alice: Person;
let bob: { id: string; key: { authorization: string } };

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const asPerson = (who: Person, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...CSRF, ...headers }, cookies: { regulait_session: who.session }, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function makeUser(email: string, isAdmin = false) {
  const u = await inject("POST", "/v1/users", AUTH, { email, displayName: email.split("@")[0], isAdmin });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  const k = await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "b5n" });
  expect(k.statusCode, k.body).toBe(201);
  return { id, key: { authorization: `Bearer ${k.json().token}` } };
}
/** a person with a browser session and a passkey (only a person in a session can step up) */
async function person(email: string, isAdmin = false): Promise<Person> {
  const u = await makeUser(email, isAdmin);
  const token = "rgls_" + randomBytes(32).toString("hex");
  await db.insert(authSessions).values({
    tokenHash: createHash("sha256").update(token).digest("hex"),
    userId: u.id,
    origin: "password",
    expiresAt: new Date(Date.now() + 3_600_000),
    idleExpiresAt: new Date(Date.now() + 3_600_000),
    idleMinutes: 60,
  });
  const p: Person = { ...u, session: token, auth: new SoftAuthenticator({ origin: ORIGIN }) };
  const opt = await asPerson(p, "POST", "/v1/auth/passkeys/registration-options", {});
  expect(opt.statusCode, opt.body).toBe(200);
  const reg = await asPerson(p, "POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: p.auth.register(opt.json().options), label: "b5n" });
  expect(reg.statusCode, reg.body).toBe(201);
  return p;
}
async function grantFor(who: Person, action: { kind: string; body: Record<string, unknown> }): Promise<string> {
  const o = await asPerson(who, "POST", "/v1/auth/step-up/options", { action });
  expect(o.statusCode, o.body).toBe(200);
  const v = await asPerson(who, "POST", "/v1/auth/step-up/verify", { stepUpId: o.json().stepUpId, method: "passkey", response: who.auth.authenticate(o.json().passkey.options) });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().stepUpToken as string;
}

/** `n` bytes (at least the distinct header) that no other call returns */
const unique = (n: number, tag = "") => {
  const head = Buffer.from(`b5n ${RUN} ${tag} ${randomBytes(8).toString("hex")} `);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, n - head.length), 0x41)]);
};
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
async function upload(who: { key: { authorization: string } }, bytes: Buffer, filename = "model.bin") {
  return app.inject({ method: "POST", url: `/v1/model-artifacts?filename=${encodeURIComponent(filename)}`, headers: { ...who.key, "content-type": "application/octet-stream" }, payload: bytes });
}
async function uploaded(who: { key: { authorization: string } }, bytes: Buffer) {
  const r = await upload(who, bytes);
  expect(r.statusCode, r.body).toBe(201);
  return r.json().artifact as { id: string; sha256: string };
}
const onDisk = async (sha256: string) =>
  stat(path.join(storeDir, artifactStorageKey(sha256))).then(
    () => true,
    () => false,
  );
const setOrg = (values: Partial<typeof orgSettings.$inferInsert>) => db.update(orgSettings).set(values).where(eq(orgSettings.id, ORG_SETTINGS_ID));
const countArtifacts = async () => Number((await db.select({ n: sql<string>`count(*)` }).from(modelArtifacts))[0]!.n);
const auditsFor = async (ruleId: string, since: Date) =>
  db
    .select()
    .from(auditLog)
    .where(sql`${auditLog.ruleId} = ${ruleId} AND ${auditLog.at} >= ${since.toISOString()}::timestamptz`);
/** a scan row of the artifact (as a run's terminal write would make) */
async function scanRow(artifactId: string, sha256: string) {
  const [s] = await db.insert(artifactScans).values({ artifactId, artifactSha256: sha256, format: "unrecognised", verdict: "unknown", scannerVersion: "0.8.8" }).returning();
  return s!;
}

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  db = createDb(DATABASE_URL);
  observer = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, useCaseGateMode: "off" });
  storeDir = await mkdtemp(path.join(tmpdir(), "b5n-store-"));
  store = new ObservedStore(new FileArtifactStore(storeDir), () => observer);
  app = buildApp(db, { bootstrapToken: BOOT, artifactStore: store });
  await app.ready();
  admin = await person(`b5n-admin-${RUN}@example.com`, true);
  alice = await person(`b5n-alice-${RUN}@example.com`);
  bob = await makeUser(`b5n-bob-${RUN}@example.com`);
}, 180_000);

afterAll(async () => {
  await forgetStepUpMethodsForTest(db, [admin?.id, alice?.id]);
  await db.update(orgSettings).set({ ...BATCH5_STRICT_DEFAULTS }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await restoreGates?.();
  await restoreIdentity?.();
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  app.server.closeAllConnections();
  await app.close();
});

describe("decision 127: storage quotas, strict, decided under one lock", () => {
  it("the defaults are strict, and raising a quota or the retention is a stepped-up relaxation", async () => {
    const [org] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    expect({
      modelArtifactUploaderQuotaMegabytes: org!.modelArtifactUploaderQuotaMegabytes,
      modelArtifactUploaderQuotaCount: org!.modelArtifactUploaderQuotaCount,
      modelArtifactOrgQuotaMegabytes: org!.modelArtifactOrgQuotaMegabytes,
      modelArtifactOrgQuotaCount: org!.modelArtifactOrgQuotaCount,
      modelArtifactRetentionDays: org!.modelArtifactRetentionDays,
    }).toEqual({ modelArtifactUploaderQuotaMegabytes: 2048, modelArtifactUploaderQuotaCount: 20, modelArtifactOrgQuotaMegabytes: 20480, modelArtifactOrgQuotaCount: 200, modelArtifactRetentionDays: 30 });
    let action: { kind: string; body: Record<string, unknown> } | undefined;
    for (const [k, v] of Object.entries({ modelArtifactUploaderQuotaCount: 21, modelArtifactUploaderQuotaMegabytes: 4096, modelArtifactOrgQuotaCount: 201, modelArtifactOrgQuotaMegabytes: 40960, modelArtifactRetentionDays: 31 })) {
      const r = await asPerson(admin, "PUT", "/v1/org/settings", { [k]: v });
      expect(r.statusCode, `${k}: ${r.body}`).toBe(403);
      expect(r.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
      action ??= r.json().action;
    }
    const raised = await asPerson(admin, "PUT", "/v1/org/settings", { modelArtifactUploaderQuotaCount: 21 }, { [STEP_UP_HEADER]: await grantFor(admin, action!) });
    expect(raised.statusCode, raised.body).toBe(200);
    // tightening needs nothing
    const lower = await asPerson(admin, "PUT", "/v1/org/settings", { modelArtifactUploaderQuotaCount: 10, modelArtifactRetentionDays: 7 });
    expect(lower.statusCode, lower.body).toBe(200);
    await setOrg({ ...BATCH5_STRICT_DEFAULTS });
  });

  it("an uploader past the count quota is refused 409, audited, and nothing of the upload is kept", async () => {
    const carol = await makeUser(`b5n-carol-${RUN}@example.com`);
    await setOrg({ modelArtifactUploaderQuotaCount: 2 });
    try {
      const since = new Date();
      await uploaded(carol, unique(100, "c1"));
      await uploaded(carol, unique(100, "c2"));
      const before = await countArtifacts();
      const third = unique(100, "c3");
      const r = await upload(carol, third);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ error: "artifact_quota_exceeded", scope: "uploader", measure: "count", setting: "modelArtifactUploaderQuotaCount", limit: 2, used: 2 });
      expect(await countArtifacts()).toBe(before);
      expect(await onDisk(sha(third))).toBe(false);
      const [audit] = (await auditsFor("model-artifact-upload-refused", since)).filter((a) => a.userId === carol.id);
      expect(audit).toMatchObject({ effect: "deny" });
      expect(audit!.detail).toMatchObject({ refused: "artifact_quota_exceeded", scope: "uploader", measure: "count", sha256: sha(third) });
      // another person is not counted against carol's quota
      expect((await upload(bob, unique(100, "b1"))).statusCode).toBe(201);
    } finally {
      await setOrg({ ...BATCH5_STRICT_DEFAULTS });
    }
  });

  it("an upload past the uploader's stored bytes is refused 413 and leaves no object and no queued delete", async () => {
    const dave = await makeUser(`b5n-dave-${RUN}@example.com`);
    await setOrg({ modelArtifactUploaderQuotaMegabytes: 1 });
    try {
      await uploaded(dave, unique(600_000, "d1"));
      const second = unique(600_000, "d2");
      const r = await upload(dave, second);
      expect(r.statusCode, r.body).toBe(413);
      expect(r.json()).toMatchObject({ error: "artifact_quota_exceeded", scope: "uploader", measure: "bytes", limit: MIB, used: 600_000 });
      expect(await onDisk(sha(second))).toBe(false);
      expect(await db.select().from(modelArtifactObjectDeletions).where(eq(modelArtifactObjectDeletions.storageKey, artifactStorageKey(sha(second))))).toEqual([]);
    } finally {
      await setOrg({ ...BATCH5_STRICT_DEFAULTS });
    }
  });

  it("the deployment-wide count quota counts everyone's artifacts", async () => {
    const erin = await makeUser(`b5n-erin-${RUN}@example.com`);
    await setOrg({ modelArtifactOrgQuotaCount: (await countArtifacts()) + 1 });
    try {
      await uploaded(erin, unique(64, "e1"));
      const r = await upload(bob, unique(64, "b2"));
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ error: "artifact_quota_exceeded", scope: "org", measure: "count", setting: "modelArtifactOrgQuotaCount" });
    } finally {
      await setOrg({ ...BATCH5_STRICT_DEFAULTS });
    }
  });

  it("RED PROOF: concurrent uploads cannot overshoot a quota (the decision is taken under the storage lock)", async () => {
    const frank = await makeUser(`b5n-frank-${RUN}@example.com`);
    await setOrg({ modelArtifactUploaderQuotaCount: 1 });
    // widen the window between reading what is stored and writing the row: without the lock every
    // upload reads "nothing stored" and all of them fit
    modelArtifactTestHooks.afterQuotaRead = () => new Promise((r) => setTimeout(r, 150));
    try {
      const bodies = Array.from({ length: 6 }, (_, i) => unique(200_000, `f${i}`));
      const results = await Promise.all(bodies.map((b) => upload(frank, b)));
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes).toEqual([201, 409, 409, 409, 409, 409]);
      const [n] = await db.select({ n: sql<string>`count(*)` }).from(modelArtifacts).where(eq(modelArtifacts.uploadedByUserId, frank.id));
      expect(Number(n!.n)).toBe(1);
      // the refused uploads' bytes are gone from the store
      const kept = bodies.filter((b, i) => results[i]!.statusCode === 201).map(sha);
      for (const b of bodies) expect(await onDisk(sha(b)), sha(b)).toBe(kept.includes(sha(b)));
    } finally {
      delete modelArtifactTestHooks.afterQuotaRead;
      await setOrg({ ...BATCH5_STRICT_DEFAULTS });
    }
  });
});

describe("decision 127: DELETE /v1/model-artifacts/:artifactId", () => {
  it("only the uploader or an admin, and only with a step-up; the row, its scans and then its object go, audited", async () => {
    const bytes = unique(500, "del");
    const a = await uploaded(alice, bytes);
    const s = await scanRow(a.id, a.sha256);
    expect((await inject("DELETE", `/v1/model-artifacts/${a.id}`, bob.key)).statusCode).toBe(404);
    // an API key can never step up
    const byKey = await inject("DELETE", `/v1/model-artifacts/${a.id}`, alice.key);
    expect(byKey.statusCode, byKey.body).toBe(403);
    expect(byKey.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    const asked = await asPerson(alice, "DELETE", `/v1/model-artifacts/${a.id}`);
    expect(asked.statusCode, asked.body).toBe(403);
    expect(asked.json().action).toEqual({ kind: "settings_relax", body: artifactDeleteStepUp(a.id).facts });
    // a grant for another artifact does not delete this one
    const other = await uploaded(alice, unique(500, "other"));
    const wrong = await asPerson(alice, "DELETE", `/v1/model-artifacts/${a.id}`, undefined, { [STEP_UP_HEADER]: await grantFor(alice, { kind: "settings_relax", body: artifactDeleteStepUp(other.id).facts }) });
    expect(wrong.statusCode, wrong.body).toBe(403);
    const since = new Date();
    store.deletes.length = 0;
    const ok = await asPerson(alice, "DELETE", `/v1/model-artifacts/${a.id}`, undefined, { [STEP_UP_HEADER]: await grantFor(alice, asked.json().action) });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().deleted).toEqual({ id: a.id, sha256: a.sha256, scansDeleted: 1, object: "deleted" });
    expect(await db.select().from(modelArtifacts).where(eq(modelArtifacts.id, a.id))).toEqual([]);
    expect(await db.select().from(artifactScans).where(eq(artifactScans.id, s.id))).toEqual([]);
    expect(await onDisk(a.sha256)).toBe(false);
    // the object was deleted only once the row's removal was committed (seen from another connection)
    expect(store.deletes).toEqual([{ key: artifactStorageKey(a.sha256), rowVisible: false, failed: false }]);
    const [deleted] = (await auditsFor("model-artifact-deleted", since)).filter((x) => x.objectId === a.id);
    expect(deleted!.detail).toMatchObject({ phase: "delete", sha256: a.sha256, scansDeleted: [s.id], objectQueued: true });
    const objectAudit = (await auditsFor("model-artifact-object-deleted", since)).filter((x) => (x.detail as { storageKey?: string }).storageKey === artifactStorageKey(a.sha256));
    expect(objectAudit).toHaveLength(1);
    // an admin may delete anyone's artifact (with their own step-up)
    const byAdmin = await asPerson(admin, "DELETE", `/v1/model-artifacts/${other.id}`, undefined, { [STEP_UP_HEADER]: await grantFor(admin, { kind: "settings_relax", body: artifactDeleteStepUp(other.id).facts }) });
    expect(byAdmin.statusCode, byAdmin.body).toBe(200);
    expect((await inject("DELETE", `/v1/model-artifacts/${a.id}`, alice.key)).statusCode).toBe(404);
  });

  it("bytes another artifact still names stay stored until the last one goes", async () => {
    const bytes = unique(300, "shared");
    const first = await uploaded(alice, bytes);
    const second = await uploaded(alice, bytes);
    const del = async (id: string) => asPerson(alice, "DELETE", `/v1/model-artifacts/${id}`, undefined, { [STEP_UP_HEADER]: await grantFor(alice, { kind: "settings_relax", body: artifactDeleteStepUp(id).facts }) });
    const one = await del(first.id);
    expect(one.json().deleted.object, one.body).toBe("shared");
    expect(await onDisk(first.sha256)).toBe(true);
    const two = await del(second.id);
    expect(two.json().deleted.object, two.body).toBe("deleted");
    expect(await onDisk(first.sha256)).toBe(false);
  });

  it("RED PROOF: refused 409 while a scan is cited as model-card evidence or a run on it is unfinished — before a step-up is asked for", async () => {
    const cited = await uploaded(alice, unique(300, "cited"));
    const s = await scanRow(cited.id, cited.sha256);
    const ag = await inject("POST", "/v1/agents", AUTH, { name: `b5n-agent-${RUN}`, provider: "mock", tier: 1, costPerMTokIn: 1, costPerMTokOut: 2, model: "b5n-model" });
    expect(ag.statusCode, ag.body).toBe(201);
    const card = await inject("POST", "/v1/mrm/cards", admin.key, { agentId: ag.json().id, intendedUse: `b5n storage ${RUN}` });
    expect(card.statusCode, card.body).toBe(201);
    const cardId = (card.json().card?.id ?? card.json().id) as string;
    expect((await inject("POST", `/v1/mrm/cards/${cardId}/evidence`, admin.key, { kind: "engine_scan", artifactScanId: s.id })).statusCode).toBe(201);
    const since = new Date();
    const r = await asPerson(alice, "DELETE", `/v1/model-artifacts/${cited.id}`);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json()).toMatchObject({ error: "artifact_in_use", citedScans: 1, unfinishedRuns: 0 });
    const [refused] = (await auditsFor("model-artifact-delete-refused", since)).filter((x) => x.objectId === cited.id);
    expect(refused).toMatchObject({ effect: "deny" });

    const running = await uploaded(alice, unique(300, "running"));
    const [run] = await db
      .insert(engineRuns)
      .values({
        engineId: "modelscan",
        engineVersion: "0.8.8",
        status: "queued",
        trigger: "manual",
        runAsUserId: alice.id,
        targetKind: "artifact",
        targetArtifactId: running.id,
        config: { sets: ["scan"], params: {} } as never,
        configHash: "b5n",
        budgetUsd: 1,
        timeoutSeconds: 600,
        queueExpiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning();
    try {
      const busy = await asPerson(alice, "DELETE", `/v1/model-artifacts/${running.id}`);
      expect(busy.statusCode, busy.body).toBe(409);
      expect(busy.json()).toMatchObject({ error: "artifact_in_use", citedScans: 0, unfinishedRuns: 1 });
      // the run ends: now it can go
      await db.update(engineRuns).set({ status: "cancelled", finishedAt: new Date(), errorCode: "test_cleanup" }).where(eq(engineRuns.id, run!.id));
      const ok = await asPerson(alice, "DELETE", `/v1/model-artifacts/${running.id}`, undefined, { [STEP_UP_HEADER]: await grantFor(alice, { kind: "settings_relax", body: artifactDeleteStepUp(running.id).facts }) });
      expect(ok.statusCode, ok.body).toBe(200);
      const [after] = await db.select().from(engineRuns).where(eq(engineRuns.id, run!.id));
      expect(after!.targetArtifactId).toBeNull();
    } finally {
      await db.update(engineRuns).set({ status: "cancelled", finishedAt: new Date(), errorCode: "test_cleanup" }).where(eq(engineRuns.id, run!.id));
    }
    expect(await db.select().from(modelArtifacts).where(eq(modelArtifacts.id, cited.id))).toHaveLength(1);
  });

  it("RED PROOF: a failed object delete is never half-done: the row is gone, the delete stays queued, the sweep retries it", async () => {
    const bytes = unique(300, "flaky");
    const a = await uploaded(alice, bytes);
    const key = artifactStorageKey(a.sha256);
    const since = new Date();
    store.failDeletes = 1;
    onTestFinished(() => {
      store.failDeletes = 0;
    });
    const r = await asPerson(alice, "DELETE", `/v1/model-artifacts/${a.id}`, undefined, { [STEP_UP_HEADER]: await grantFor(alice, { kind: "settings_relax", body: artifactDeleteStepUp(a.id).facts }) });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().deleted.object).toBe("queued");
    expect(await db.select().from(modelArtifacts).where(eq(modelArtifacts.id, a.id))).toEqual([]);
    expect(await onDisk(a.sha256)).toBe(true);
    const [queued] = await db.select().from(modelArtifactObjectDeletions).where(eq(modelArtifactObjectDeletions.storageKey, key));
    expect(queued).toMatchObject({ attempts: 1, lastErrorCode: "object_delete_failed" });
    const [failed] = (await auditsFor("model-artifact-object-delete-failed", since)).filter((x) => (x.detail as { storageKey?: string }).storageKey === key);
    expect(failed).toMatchObject({ effect: "deny" });
    expect(failed!.detail).toMatchObject({ attempts: 1, error: "Error" });
    // the sweep, once the retry is due, finishes it
    const out = await runModelArtifactRetentionSweep(db, store, { now: new Date(queued!.notBefore.getTime() + 1000) });
    expect(out.objectsDeleted).toBeGreaterThanOrEqual(1);
    expect(await onDisk(a.sha256)).toBe(false);
    expect(await db.select().from(modelArtifactObjectDeletions).where(eq(modelArtifactObjectDeletions.storageKey, key))).toEqual([]);
  });
});

describe("decision 127: the retention sweep", () => {
  it("RED PROOF: deletes old artifacts nothing uses, keeps cited, running and recent ones, and is a scheduler job", async () => {
    expect(schedulerJobRegistry({ artifactStore: store }).get(MODEL_ARTIFACT_RETENTION_JOB_NAME)?.adr).toBe("ADR-0187");
    const old = await uploaded(alice, unique(300, "old"));
    const oldScan = await scanRow(old.id, old.sha256);
    const recent = await uploaded(alice, unique(300, "recent"));
    const citedOld = await uploaded(alice, unique(300, "cited-old"));
    const cs = await scanRow(citedOld.id, citedOld.sha256);
    const ag = await inject("POST", "/v1/agents", AUTH, { name: `b5n-agent2-${RUN}`, provider: "mock", tier: 1, costPerMTokIn: 1, costPerMTokOut: 2, model: "b5n-model" });
    const card = await inject("POST", "/v1/mrm/cards", admin.key, { agentId: ag.json().id, intendedUse: `b5n retention ${RUN}` });
    const cardId = (card.json().card?.id ?? card.json().id) as string;
    expect((await inject("POST", `/v1/mrm/cards/${cardId}/evidence`, admin.key, { kind: "engine_scan", artifactScanId: cs.id })).statusCode).toBe(201);
    const runningOld = await uploaded(alice, unique(300, "running-old"));
    const [run] = await db
      .insert(engineRuns)
      .values({
        engineId: "modelscan",
        engineVersion: "0.8.8",
        status: "awaiting_approval",
        trigger: "manual",
        runAsUserId: alice.id,
        targetKind: "artifact",
        targetArtifactId: runningOld.id,
        config: { sets: ["scan"], params: {} } as never,
        configHash: "b5n",
        budgetUsd: 1,
        timeoutSeconds: 600,
        queueExpiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning();
    try {
      // 31 days old, against the strict 30
      await db.execute(sql`UPDATE model_artifacts SET created_at = now() - interval '31 days' WHERE id IN (${old.id}, ${citedOld.id}, ${runningOld.id})`);
      const since = new Date();
      store.deletes.length = 0;
      const out = await runModelArtifactRetentionSweep(db, store);
      expect(out.expired).toBeGreaterThanOrEqual(1);
      const left = await db.select({ id: modelArtifacts.id }).from(modelArtifacts).where(inArray(modelArtifacts.id, [old.id, recent.id, citedOld.id, runningOld.id]));
      expect(left.map((x) => x.id).sort()).toEqual([recent.id, citedOld.id, runningOld.id].sort());
      expect(await db.select().from(artifactScans).where(eq(artifactScans.id, oldScan.id))).toEqual([]);
      expect(await onDisk(old.sha256)).toBe(false);
      expect(await onDisk(citedOld.sha256)).toBe(true);
      expect(store.deletes.find((d) => d.key === artifactStorageKey(old.sha256))).toEqual({ key: artifactStorageKey(old.sha256), rowVisible: false, failed: false });
      const [expired] = (await auditsFor("model-artifact-expired", since)).filter((x) => x.objectId === old.id);
      expect(expired!.detail).toMatchObject({ phase: "retention", retentionDays: 30, sha256: old.sha256 });
      // lowering the retention applies to what is already stored
      await setOrg({ modelArtifactRetentionDays: 1 });
      await db.execute(sql`UPDATE model_artifacts SET created_at = now() - interval '2 days' WHERE id = ${recent.id}`);
      await runModelArtifactRetentionSweep(db, store);
      expect(await db.select().from(modelArtifacts).where(eq(modelArtifacts.id, recent.id))).toEqual([]);
    } finally {
      await setOrg({ ...BATCH5_STRICT_DEFAULTS });
      await db.update(engineRuns).set({ status: "cancelled", finishedAt: new Date(), errorCode: "test_cleanup" }).where(eq(engineRuns.id, run!.id));
    }
  });

  it("an object an upload wrote but never named (a crash before its row) is removed once its write-ahead record is due; an upload of the same bytes claims it back", async () => {
    // the crash: the write-ahead record and the object exist, no row names them
    const bytes = unique(300, "orphan");
    const key = artifactStorageKey(sha(bytes));
    const src = path.join(storeDir, `src-${RUN}.bin`);
    await writeFile(src, bytes);
    await db.insert(modelArtifactObjectDeletions).values({ storageKey: key, notBefore: new Date(Date.now() + 6 * 3_600_000) });
    await store.putFile(key, src, sha(bytes), bytes.length);
    // not yet due: kept
    await runModelArtifactRetentionSweep(db, store);
    expect(await onDisk(sha(bytes))).toBe(true);
    // an upload of the same bytes names the key again: the queued delete is dropped, the object stays
    const again = await uploaded(alice, bytes);
    expect(await db.select().from(modelArtifactObjectDeletions).where(eq(modelArtifactObjectDeletions.storageKey, key))).toEqual([]);
    await runModelArtifactRetentionSweep(db, store, { now: new Date(Date.now() + 7 * 3_600_000) });
    expect(await onDisk(sha(bytes))).toBe(true);
    expect((await db.select().from(modelArtifacts).where(eq(modelArtifacts.id, again.id))).length).toBe(1);
    // a queued delete of a key a row names (however it came to be queued) never removes the object
    await db.insert(modelArtifactObjectDeletions).values({ storageKey: key, notBefore: new Date(Date.now() - 1000) });
    await runModelArtifactRetentionSweep(db, store);
    expect(await onDisk(sha(bytes))).toBe(true);
    expect(await db.select().from(modelArtifactObjectDeletions).where(eq(modelArtifactObjectDeletions.storageKey, key))).toEqual([]);
    // a true orphan (no upload ever names it) goes once due
    const orphan = unique(300, "orphan2");
    const okey = artifactStorageKey(sha(orphan));
    await writeFile(src, orphan);
    await db.insert(modelArtifactObjectDeletions).values({ storageKey: okey, notBefore: new Date(Date.now() + 6 * 3_600_000) });
    await store.putFile(okey, src, sha(orphan), orphan.length);
    await runModelArtifactRetentionSweep(db, store, { now: new Date(Date.now() + 7 * 3_600_000) });
    expect(await onDisk(sha(orphan))).toBe(false);
    expect((await readdir(path.join(storeDir, "sha256"))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("decision 128: a clean scan with no format is refused by the database [4235322386]", () => {
  it("RED PROOF: clean with a NULL format fails; clean is accepted only for safetensors", async () => {
    const a = await uploaded(alice, unique(200, "nullfmt"));
    const clean = (format: string | null) =>
      db.insert(artifactScans).values({ artifactId: a.id, artifactSha256: a.sha256, format, verdict: "clean", scannerVersion: "0.8.8" }).returning();
    const constraintOf = (p: Promise<unknown>) =>
      p.then(
        () => "accepted",
        (err: { cause?: { constraint?: string }; constraint?: string }) => err.cause?.constraint ?? err.constraint ?? String(err),
      );
    expect(await constraintOf(clean(null))).toBe("artifact_scans_clean_format_check");
    expect(await constraintOf(clean("pickle"))).toBe("artifact_scans_clean_format_check");
    const [ok] = await clean("safetensors");
    expect(ok!.verdict).toBe("clean");
    // any other verdict may carry no format
    const [unknown] = await db.insert(artifactScans).values({ artifactId: a.id, artifactSha256: a.sha256, format: null, verdict: "unknown", scannerVersion: "0.8.8" }).returning();
    expect(unknown!.format).toBeNull();
  });
});
