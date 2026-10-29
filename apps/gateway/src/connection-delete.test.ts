import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  eq,
  gitConnections,
  orgSettings,
  ORG_SETTINGS_ID,
  pmConnections,
  pmLinks,
  pmSyncEvents,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

/**
 * #453 — audited Delete for git and PM connections, modelled on the deploy-target delete: admin-only (the route is
 * not in NON_ADMIN_ROUTES), 404 for an unknown name, and the audit row written in the same transaction. A PM delete
 * cascades to its links and sync events and clears the alert-ticket connection; the audit row records all three.
 * Connections are deployment-wide (one organisation per deployment, `org_settings` is a singleton), so there is no
 * second organisation to cross: the object-level check is the admin gate. Shares one DB; prefix cdel-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const BOOT = "cdel-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
/** per-run names, so the suite re-runs on a database that already holds an earlier run */
const RUN = Date.now().toString(36);
const N = (name: string) => `${name}-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let memberAuth: { authorization: string };
let adminAuth: { authorization: string };
let adminId: string;
let restoreAdminKeyMfa: (() => Promise<void>) | undefined;

async function mkUser(email: string, isAdmin: boolean) {
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: email.split("@")[0]!.replace(/-/g, " ") } });
  expect(u.statusCode).toBe(201);
  if (isAdmin) {
    const up = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/admin`, payload: { isAdmin: true, reason: "cdel coverage" } });
    expect(up.statusCode).toBe(200);
  }
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "cdel" } });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function mkGit(name: string) {
  const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/git/connections", payload: { name: N(name), provider: "mock", token: "mock-token" } });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

async function mkPm(name: string) {
  const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/pm/connections", payload: { name: N(name), provider: "mock", project: "CDEL", token: "mock-token" } });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

const removedRow = (objectType: "git_connection" | "pm_connection", objectId: string) =>
  db.select().from(auditLog).where(and(eq(auditLog.objectType, objectType), eq(auditLog.objectId, objectId)));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181 (FX2): an admin's API key answers to mfaRequired. This suite is not about MFA, so it relaxes the dial
  // explicitly and hands the shared database back strict in afterAll (M-068).
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c".repeat(64) });
  memberAuth = (await mkUser(`cdel-member-${RUN}@example.com`, false)).auth;
  const admin = await mkUser(`cdel-admin-${RUN}@example.com`, true);
  adminId = admin.id;
  adminAuth = admin.auth;
});

afterAll(async () => {
  await restoreAdminKeyMfa?.();
});

describe("DELETE /v1/git/connections/:name", () => {
  it("an admin removes the connection; the audit row names it and the actor", async () => {
    const id = await mkGit("cdel-git-a");
    const r = await app.inject({ method: "DELETE", headers: adminAuth, url: `/v1/git/connections/${N("cdel-git-a")}` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ removed: true });
    expect(await db.select().from(gitConnections).where(eq(gitConnections.id, id))).toHaveLength(0);
    const [row] = await removedRow("git_connection", id);
    expect(row).toMatchObject({ userId: adminId, ruleId: "git-connection-removed", effect: "allow" });
    expect(row!.detail).toMatchObject({ phase: "removed", name: N("cdel-git-a"), provider: "mock" });
    // the name is free again: re-creating is how a wrong token is replaced
    await mkGit("cdel-git-a");
  });

  it("a non-admin is refused and nothing is removed", async () => {
    const id = await mkGit("cdel-git-b");
    const r = await app.inject({ method: "DELETE", headers: memberAuth, url: `/v1/git/connections/${N("cdel-git-b")}` });
    expect(r.statusCode).toBe(403);
    expect(await db.select().from(gitConnections).where(eq(gitConnections.id, id))).toHaveLength(1);
    expect(await removedRow("git_connection", id)).toHaveLength(0);
  });

  it("an unauthenticated caller is refused", async () => {
    await mkGit("cdel-git-c");
    const r = await app.inject({ method: "DELETE", url: `/v1/git/connections/${N("cdel-git-c")}` });
    expect(r.statusCode).toBe(401);
  });

  it("an unknown name is a 404", async () => {
    const r = await app.inject({ method: "DELETE", headers: adminAuth, url: `/v1/git/connections/${N("cdel-git-nope")}` });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: "unknown_connection" });
  });
});

describe("DELETE /v1/pm/connections/:name", () => {
  it("an admin removes the connection; links and sync events cascade, the alert-ticket connection is cleared, and the audit row records all three", async () => {
    const id = await mkPm("cdel-pm-a");
    await db.insert(pmLinks).values([
      { connectionId: id, objectType: "run", objectId: randomUUID(), externalId: "CDEL-1", externalUrl: "https://pm.example/CDEL-1" },
      { connectionId: id, objectType: "run", objectId: randomUUID(), externalId: "CDEL-2", externalUrl: "https://pm.example/CDEL-2" },
    ]);
    await db.insert(pmSyncEvents).values({ connectionId: id, externalId: "CDEL-1", kind: "updated" });
    await db
      .insert(orgSettings)
      .values({ id: ORG_SETTINGS_ID, alertTicketConnectionId: id })
      .onConflictDoUpdate({ target: orgSettings.id, set: { alertTicketConnectionId: id } });

    const r = await app.inject({ method: "DELETE", headers: adminAuth, url: `/v1/pm/connections/${N("cdel-pm-a")}` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ removed: true, links: 2, syncEvents: 1, alertTicketConnectionCleared: true });
    expect(await db.select().from(pmConnections).where(eq(pmConnections.id, id))).toHaveLength(0);
    expect(await db.select().from(pmLinks).where(eq(pmLinks.connectionId, id))).toHaveLength(0);
    expect(await db.select().from(pmSyncEvents).where(eq(pmSyncEvents.connectionId, id))).toHaveLength(0);
    const [settings] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    expect(settings!.alertTicketConnectionId).toBeNull();
    const [row] = await removedRow("pm_connection", id);
    expect(row).toMatchObject({ userId: adminId, ruleId: "pm-connection-removed", effect: "allow" });
    expect(row!.detail).toMatchObject({
      phase: "removed", name: N("cdel-pm-a"), provider: "mock", project: "CDEL",
      links: 2, syncEvents: 1, alertTicketConnectionCleared: true,
    });
  });

  it("a connection with nothing attached records zero links and leaves another alert-ticket connection alone", async () => {
    const keep = await mkPm("cdel-pm-keep");
    await db.update(orgSettings).set({ alertTicketConnectionId: keep }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    await mkPm("cdel-pm-bare");
    const r = await app.inject({ method: "DELETE", headers: adminAuth, url: `/v1/pm/connections/${N("cdel-pm-bare")}` });
    expect(r.json()).toEqual({ removed: true, links: 0, syncEvents: 0, alertTicketConnectionCleared: false });
    const [settings] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    expect(settings!.alertTicketConnectionId).toBe(keep);
  });

  it("a non-admin is refused and nothing is removed", async () => {
    const id = await mkPm("cdel-pm-b");
    const r = await app.inject({ method: "DELETE", headers: memberAuth, url: `/v1/pm/connections/${N("cdel-pm-b")}` });
    expect(r.statusCode).toBe(403);
    expect(await db.select().from(pmConnections).where(eq(pmConnections.id, id))).toHaveLength(1);
    expect(await removedRow("pm_connection", id)).toHaveLength(0);
  });

  it("an unknown name is a 404", async () => {
    const r = await app.inject({ method: "DELETE", headers: adminAuth, url: `/v1/pm/connections/${N("cdel-pm-nope")}` });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: "unknown_connection" });
  });

  it("re-creating the connection mints a new inbound webhook secret", async () => {
    const first = await app.inject({ method: "POST", headers: AUTH, url: "/v1/pm/connections", payload: { name: N("cdel-pm-re"), provider: "mock", project: "CDEL", token: "t" } });
    await app.inject({ method: "DELETE", headers: adminAuth, url: `/v1/pm/connections/${N("cdel-pm-re")}` });
    const second = await app.inject({ method: "POST", headers: AUTH, url: "/v1/pm/connections", payload: { name: N("cdel-pm-re"), provider: "mock", project: "CDEL", token: "t" } });
    expect(second.statusCode).toBe(201);
    expect(second.json().webhookSecret).not.toBe(first.json().webhookSecret);
  });
});
