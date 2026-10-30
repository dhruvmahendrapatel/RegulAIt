import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

/**
 * Owner 2026-10-30, "the external connectors should work": every admin act on an external integration is on the
 * record. Delete was audited (#596); creating a connector, storing / replacing / removing its credential, and creating
 * a git or PM connection were not. Each row is written in the same transaction as the change, names the actor, and
 * never carries the token. Shares one DB; prefix cca-, every lookup by this run's object id (M-040).
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const BOOT = "cca-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Date.now().toString(36);
const N = (name: string) => `cca-${name}-${RUN}`;
const TOKEN = "cca-secret-token-value";

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminAuth: { authorization: string };
let adminId: string;
let restoreAdminKeyMfa: (() => Promise<void>) | undefined;

const rows = (objectType: (typeof auditLog.$inferSelect)["objectType"], objectId: string, ruleId: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.objectType, objectType), eq(auditLog.objectId, objectId), eq(auditLog.ruleId, ruleId)));

const noToken = (detail: unknown) => expect(JSON.stringify(detail)).not.toContain(TOKEN);

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c".repeat(64) });
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: `cca-admin-${RUN}@example.com`, displayName: "cca admin" } });
  expect(u.statusCode).toBe(201);
  adminId = u.json().id;
  const up = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${adminId}/admin`, payload: { isAdmin: true, reason: "cca coverage" } });
  expect(up.statusCode).toBe(200);
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${adminId}/keys`, payload: { name: "cca" } });
  adminAuth = { authorization: `Bearer ${k.json().token}` };
});

afterAll(async () => {
  await restoreAdminKeyMfa?.();
});

describe("connector writes are audited", () => {
  it("create, credential stored, credential replaced and credential removed each leave one row naming the actor", async () => {
    const c = await app.inject({ method: "POST", headers: adminAuth, url: "/v1/connectors", payload: { name: N("conn"), kind: "data", providerKind: "mock" } });
    expect(c.statusCode).toBe(201);
    const id = c.json().id as string;
    const [created] = await rows("connector", id, "connector-created");
    expect(created).toMatchObject({ userId: adminId, effect: "allow" });
    expect(created!.detail).toMatchObject({ phase: "created", name: N("conn"), kind: "data", providerKind: "mock" });

    const url = `/v1/connectors/${id}/credential`;
    expect((await app.inject({ method: "POST", headers: adminAuth, url, payload: { token: TOKEN } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", headers: adminAuth, url, payload: { token: `${TOKEN}-2` } })).statusCode).toBe(201);
    const stored = await rows("connector", id, "connector-credential-stored");
    const replaced = await rows("connector", id, "connector-credential-replaced");
    expect(stored).toHaveLength(1);
    expect(replaced).toHaveLength(1);
    expect(stored[0]).toMatchObject({ userId: adminId });
    expect(replaced[0]).toMatchObject({ userId: adminId });
    for (const r of [...stored, ...replaced]) noToken(r.detail);

    expect((await app.inject({ method: "DELETE", headers: adminAuth, url })).statusCode).toBe(200);
    expect(await rows("connector", id, "connector-credential-removed")).toHaveLength(1);
    // removing a credential that is not there is a 404 and writes nothing
    expect((await app.inject({ method: "DELETE", headers: adminAuth, url })).statusCode).toBe(404);
    expect(await rows("connector", id, "connector-credential-removed")).toHaveLength(1);
  });
});

describe("git and PM connection creation is audited", () => {
  it("a git connection's creation names it, its provider and the actor, never the token", async () => {
    const r = await app.inject({ method: "POST", headers: adminAuth, url: "/v1/git/connections", payload: { name: N("git"), provider: "mock", token: TOKEN } });
    expect(r.statusCode).toBe(201);
    const [row] = await rows("git_connection", r.json().id, "git-connection-created");
    expect(row).toMatchObject({ userId: adminId, effect: "allow" });
    expect(row!.detail).toMatchObject({ phase: "created", name: N("git"), provider: "mock" });
    noToken(row!.detail);
  });

  it("a PM connection's creation names it, its provider and project and the actor, never the token or webhook secret", async () => {
    const r = await app.inject({ method: "POST", headers: adminAuth, url: "/v1/pm/connections", payload: { name: N("pm"), provider: "mock", project: "CCA", token: TOKEN } });
    expect(r.statusCode).toBe(201);
    const [row] = await rows("pm_connection", r.json().id, "pm-connection-created");
    expect(row).toMatchObject({ userId: adminId, effect: "allow" });
    expect(row!.detail).toMatchObject({ phase: "created", name: N("pm"), provider: "mock", project: "CCA" });
    noToken(row!.detail);
    expect(JSON.stringify(row!.detail)).not.toContain(r.json().webhookSecret);
  });

  it("a refused creation writes no creation row", async () => {
    // a second connection under this run's name is refused; the name's creation rows stay at one
    const named = async () =>
      (await db.select().from(auditLog).where(eq(auditLog.ruleId, "git-connection-created"))).filter(
        (r) => (r.detail as { name?: string }).name === N("git"),
      );
    expect(await named()).toHaveLength(1);
    const r = await app.inject({ method: "POST", headers: adminAuth, url: "/v1/git/connections", payload: { name: N("git"), provider: "mock", token: TOKEN } });
    expect(r.statusCode).toBe(409);
    expect(await named()).toHaveLength(1);
  });
});
