/**
 * ADR-0181 FX2 — identity and keys, from the security review of the
 * integrated strict-defaults batch. Each block pins one finding:
 *
 *  3   an admin's API key answers to the org MFA requirement: an un-enrolled
 *      admin's key is refused (403), cannot be exchanged for a session, and no
 *      key is issued to them (409) — the bootstrap token is not a user key;
 *  4   issuing and revoking an API key are audited (never the token);
 *  5   SAML JIT provisioning needs allowed email domains (API + CHECK);
 *  12  an unsigned SAML Response names wantAuthnResponseSigned (saml.test.ts
 *      covers the wire; here: migration 0160 audits every provider with it on);
 *  10a no grandfathering: 0160 gives never-expiring keys the 365-day ceiling
 *      (one summary audit row), and a live session follows a tightened idle
 *      window on its next request;
 *  9   the dev box's compose override keeps a one-day HSTS.
 *
 * Runs on its own scratch databases: one migrated in full (a fresh org), and
 * one migrated to 0159, given pre-0160 records, then migrated to 0160.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  and,
  apiKeys,
  auditLog,
  authSessions,
  createDb,
  desc,
  eq,
  isNotNull,
  migrationAuditOutbox,
  runMigrations,
  samlProviders,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { resolveHsts } from "./hsts.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";
import { enrolAdminTotpForTest } from "./testing/identity-posture.js";
import { installLicenseFixture, removeLicenseFixture } from "./testing/license-fixture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../../packages/db/migrations");
const RUN = `${process.pid}_${Date.now()}`;
const SCRATCH_DB = `regulait_fx2_${RUN}`;
const UPGRADE_DB = `regulait_fx2_up_${RUN}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const BOOT = "adr0181-fx2-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
const CERT = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ2Fz\n-----END CERTIFICATE-----";
const SYSTEM = "00000000-0000-0000-0000-000000000000";

let admin: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  for (const name of [SCRATCH_DB, UPGRADE_DB]) {
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    await admin.execute(sql.raw(`CREATE DATABASE ${name}`));
  }
  db = createDb(urlFor(SCRATCH_DB));
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "f".repeat(64) });
}, 180_000);

afterAll(async () => {
  await closeAll([
    () => app.close(),
    () => (db.$client as { end: () => Promise<void> }).end(),
    () => dropScratchDatabase(admin, SCRATCH_DB),
    () => dropScratchDatabase(admin, UPGRADE_DB),
    () => (admin.$client as { end: () => Promise<void> }).end(),
  ]);
});

const json = (r: { json: () => unknown }) => r.json() as Record<string, any>;
const putSettings = (payload: Record<string, unknown>) =>
  app.inject({ method: "PUT", headers: AUTH, url: "/v1/org/settings", payload });
const latestAudit = async (ruleId: string, x: Db = db) => {
  const [row] = await x.select().from(auditLog).where(eq(auditLog.ruleId, ruleId)).orderBy(desc(auditLog.at)).limit(1);
  return row ?? null;
};
let seq = 0;
const mkUser = async (isAdmin: boolean): Promise<{ id: string; email: string }> => {
  const email = `fx2-${++seq}-${Date.now()}@fx2.example`;
  const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: `FX2 ${seq}`, isAdmin } });
  expect(r.statusCode, r.body).toBe(201);
  return { id: json(r).id, email };
};
const issueKey = (userId: string, name = "fx2-key") =>
  app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${userId}/keys`, payload: { name } });

// ---------------------------------------------------------------------------
// finding 3 — an API key is not a way around MFA
// ---------------------------------------------------------------------------
describe("ADR-0181 FX2 finding 3 — an admin's API key answers to mfaRequired", () => {
  it("a fresh org refuses to ISSUE a key to an admin who has not enrolled TOTP, by name and audited", async () => {
    const a = await mkUser(true);
    const r = await issueKey(a.id);
    expect(r.statusCode).toBe(409);
    expect(json(r).error).toBe("mfa_enrollment_required");
    expect(json(r).token).toBeUndefined();
    expect(await db.select().from(apiKeys).where(eq(apiKeys.userId, a.id))).toHaveLength(0);
    const audit = await latestAudit("mfa_enrollment_required");
    expect(audit!.effect).toBe("deny");
    expect(audit!.detail).toMatchObject({ phase: "issue-refused", targetUserId: a.id, mfaRequired: "admins" });
  });

  it("an admin key that exists without TOTP is refused on use (403) and audited; enrolling opens it", async () => {
    const a = await mkUser(true);
    // a key minted while an admin had relaxed the dial (audited), then the
    // dial goes back to strict: the key must not keep admin power
    expect((await putSettings({ mfaRequired: "off" })).statusCode).toBe(200);
    const minted = await issueKey(a.id);
    expect((await putSettings({ mfaRequired: "admins" })).statusCode).toBe(200);
    expect(minted.statusCode, minted.body).toBe(201);
    const key = { authorization: `Bearer ${json(minted).token}` };

    const refused = await app.inject({ method: "GET", url: "/v1/audit", headers: key });
    expect(refused.statusCode).toBe(403);
    expect(json(refused).error).toBe("mfa_enrollment_required");
    // a non-admin route is refused too: the gate is on the credential
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: key })).statusCode).toBe(403);
    const audit = await latestAudit("api-key-mfa-enrollment-required");
    expect(audit!.effect).toBe("deny");
    expect(audit!.objectId).toBe(json(minted).id);
    expect(audit!.detail).toMatchObject({ mfaRequired: "admins", isAdmin: true });

    // ...and it buys no browser session (where the self-service TOTP routes
    // would let the key's holder enrol THEIR OWN authenticator)
    const exchanged = await app.inject({ method: "POST", url: "/auth/login-with-key", headers: CSRF, payload: { apiKey: json(minted).token } });
    expect(exchanged.statusCode).toBe(403);
    expect(json(exchanged).error).toBe("mfa_enrollment_required");
    // ADR-0183 2.3: the web app tells "this key" apart from the session gate by this field
    expect(json(exchanged).credential).toBe("api_key");
    expect(exchanged.cookies.find((c) => c.name === "regulait_session")).toBeUndefined();

    await enrolAdminTotpForTest(app, BOOT, a.id);
    expect((await app.inject({ method: "GET", url: "/v1/audit", headers: key })).statusCode).toBe(200);
  });

  it("a member's key is untouched under 'admins' and answers to 'all'", async () => {
    const m = await mkUser(false);
    const minted = await issueKey(m.id);
    expect(minted.statusCode, minted.body).toBe(201);
    const key = { authorization: `Bearer ${json(minted).token}` };
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: key })).statusCode).toBe(200);
    expect((await putSettings({ mfaRequired: "all" })).statusCode).toBe(200);
    try {
      const refused = await app.inject({ method: "GET", url: "/v1/me", headers: key });
      expect(refused.statusCode).toBe(403);
      expect(json(refused).error).toBe("mfa_enrollment_required");
      expect((await issueKey(m.id, "second")).statusCode).toBe(409);
    } finally {
      expect((await putSettings({ mfaRequired: "admins" })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: key })).statusCode).toBe(200);
  });

  it("the bootstrap token is no user's key and is unaffected", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/audit", headers: AUTH })).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// finding 4 — issuing and revoking a key are audited
// ---------------------------------------------------------------------------
describe("ADR-0181 FX2 finding 4 — API key issue and revoke are audited", () => {
  it("records who issued which key to whom with its lifetime, and the revocation — never the token", async () => {
    const m = await mkUser(false);
    const minted = await issueKey(m.id, "fx2-audited");
    expect(minted.statusCode, minted.body).toBe(201);
    const { id, token, expiresAt, expirySource } = json(minted);
    const issued = await latestAudit("api-key-issued");
    expect(issued!.effect).toBe("allow");
    expect(issued!.objectType).toBe("api_key");
    expect(issued!.objectId).toBe(id);
    expect(issued!.detail).toMatchObject({
      phase: "api-key-issued",
      actorVia: "bootstrap",
      targetUserId: m.id,
      keyId: id,
      name: "fx2-audited",
      expiresAt,
      expirySource,
    });
    expect(JSON.stringify(issued)).not.toContain(token);

    const revoked = await app.inject({ method: "POST", headers: AUTH, url: `/v1/keys/${id}/revoke`, payload: {} });
    expect(revoked.statusCode).toBe(200);
    expect(Object.keys(json(revoked)).sort()).toEqual(["id", "revokedAt"]);
    const row = await latestAudit("api-key-revoked");
    expect(row!.objectId).toBe(id);
    expect(row!.detail).toMatchObject({ phase: "api-key-revoked", targetUserId: m.id, keyId: id, name: "fx2-audited" });
    expect(JSON.stringify(row)).not.toContain(token);
  });
});

// ---------------------------------------------------------------------------
// finding 10a (sessions) — a tightened idle window binds live sessions
// ---------------------------------------------------------------------------
describe("ADR-0181 FX2 finding 10a — no grandfathered idle window", () => {
  it("a session opened under a longer idle window follows the org's tightened one on its next request", async () => {
    expect((await putSettings({ sessionIdleMinutes: 120 })).statusCode).toBe(200);
    const m = await mkUser(false);
    const init = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${m.id}/set-initial-password`, payload: {} });
    const oneTime = json(init).password as string;
    const login = await app.inject({ method: "POST", url: "/auth/login", headers: CSRF, payload: { email: m.email, password: oneTime } });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = login.cookies.find((c) => c.name === "regulait_session")!.value;
    const changed = await app.inject({
      method: "POST", url: "/auth/change-password", headers: CSRF, cookies: { regulait_session: cookie },
      payload: { currentPassword: oneTime, newPassword: "Fx2-Strong-pass-1" },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const live = changed.cookies.find((c) => c.name === "regulait_session")?.value ?? cookie;
    const [s] = await db.select().from(authSessions).where(and(eq(authSessions.userId, m.id), sql`${authSessions.revokedAt} is null`));
    expect(s!.idleMinutes).toBe(120);

    // the admin tightens the window back to strict; the session was last used
    // 40 minutes ago — inside its own 120-minute snapshot, outside the org's 30
    expect((await putSettings({ sessionIdleMinutes: 30 })).statusCode).toBe(200);
    await db
      .update(authSessions)
      .set({ lastSeenAt: new Date(Date.now() - 40 * 60_000) })
      .where(eq(authSessions.id, s!.id));
    const res = await app.inject({ method: "GET", url: "/v1/me", cookies: { regulait_session: live } });
    expect(res.statusCode).toBe(401);
  });

  it("a session inside the tightened window keeps working and now slides by it", async () => {
    expect((await putSettings({ sessionIdleMinutes: 120 })).statusCode).toBe(200);
    const m = await mkUser(false);
    const init = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${m.id}/set-initial-password`, payload: {} });
    const oneTime = json(init).password as string;
    const login = await app.inject({ method: "POST", url: "/auth/login", headers: CSRF, payload: { email: m.email, password: oneTime } });
    const cookie = login.cookies.find((c) => c.name === "regulait_session")!.value;
    expect((await putSettings({ sessionIdleMinutes: 30 })).statusCode).toBe(200);
    // one-time password session: /auth/me is reachable before the change
    const me = await app.inject({ method: "GET", url: "/auth/me", cookies: { regulait_session: cookie } });
    expect(me.statusCode).toBe(200);
    const [s] = await db.select().from(authSessions).where(eq(authSessions.userId, m.id));
    expect(s!.idleMinutes).toBe(30);
    expect(s!.idleExpiresAt.getTime() - Date.now()).toBeLessThanOrEqual(30 * 60_000 + 5_000);
  });
});

// ---------------------------------------------------------------------------
// finding 5 — SAML JIT needs allowed email domains
// ---------------------------------------------------------------------------
describe("ADR-0181 FX2 finding 5 — SAML JIT provisioning needs allowed email domains", () => {
  const base = { entityId: "https://idp.fx2.example", idpSsoUrl: "https://idp.fx2.example/sso", idpSigningCerts: [CERT] };
  beforeAll(async () => {
    await installLicenseFixture(app, { features: ["sso_saml"], auth: AUTH });
  });
  afterAll(async () => {
    await removeLicenseFixture(db);
  });

  it("create with JIT on and no domains is refused by name, audited, and nothing is saved", async () => {
    for (const allowedEmailDomains of [undefined, null] as const) {
      const name = `fx2-saml-jit-${String(allowedEmailDomains)}`;
      const r = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/auth/saml-providers",
        payload: { ...base, name, jitProvisioning: true, ...(allowedEmailDomains !== undefined ? { allowedEmailDomains } : {}) },
      });
      expect(r.statusCode, r.body).toBe(422);
      expect(json(r).error).toBe("jit_requires_allowed_domains");
      expect(await db.select().from(samlProviders).where(eq(samlProviders.name, name))).toHaveLength(0);
    }
    const audit = await latestAudit("jit_requires_allowed_domains");
    expect(audit!.effect).toBe("deny");
    expect(audit!.objectType).toBe("saml_provider");
    // an EMPTY list never reaches the rule: the request schema refuses it
    const empty = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/auth/saml-providers",
      payload: { ...base, name: "fx2-saml-jit-empty", jitProvisioning: true, allowedEmailDomains: [] },
    });
    expect(empty.statusCode).toBe(400);
  });

  it("PATCH cannot turn JIT on without domains, nor clear the domains under JIT", async () => {
    const [p] = await db.insert(samlProviders).values({ ...base, name: "fx2-saml-patch" }).returning();
    const on = await app.inject({ method: "PATCH", headers: AUTH, url: `/v1/auth/saml-providers/${p!.id}`, payload: { jitProvisioning: true } });
    expect(on.statusCode).toBe(422);
    expect(json(on).error).toBe("jit_requires_allowed_domains");
    const both = await app.inject({
      method: "PATCH", headers: AUTH, url: `/v1/auth/saml-providers/${p!.id}`,
      payload: { jitProvisioning: true, allowedEmailDomains: ["fx2.example"] },
    });
    expect(both.statusCode, both.body).toBe(200);
    const clear = await app.inject({ method: "PATCH", headers: AUTH, url: `/v1/auth/saml-providers/${p!.id}`, payload: { allowedEmailDomains: null } });
    expect(clear.statusCode).toBe(422);
    const [after] = await db.select().from(samlProviders).where(eq(samlProviders.id, p!.id));
    expect(after!.allowedEmailDomains).toEqual(["fx2.example"]);
  });

  it("the database refuses the combination too", async () => {
    await expect(db.insert(samlProviders).values({ ...base, name: "fx2-saml-db", jitProvisioning: true })).rejects.toThrow();
    await expect(
      db.insert(samlProviders).values({ ...base, name: "fx2-saml-db2", jitProvisioning: true, allowedEmailDomains: [] }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// migration 0160 — upgrading a database that holds pre-0160 records
// ---------------------------------------------------------------------------
describe("ADR-0181 FX2 migration 0160 — no grandfathering, every change audited", () => {
  let up: Db;
  let partial = "";
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    // a copy of the migrations folder whose journal stops at 0159
    partial = mkdtempSync(path.join(tmpdir(), "fx2-migrations-"));
    cpSync(migrationsFolder, partial, { recursive: true });
    const journalPath = path.join(partial, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.some((e) => e.tag === "0160_strict_identity_followups")).toBe(true);
    journal.entries = journal.entries.filter((e) => e.idx < 160);
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    rmSync(path.join(partial, "0160_strict_identity_followups.sql"));

    up = createDb(urlFor(UPGRADE_DB));
    await runMigrations(up, partial);
    const [u] = await up.insert(users).values({ email: "fx2-up@fx2.example", displayName: "Up" }).returning();
    const key = (name: string, expiresAt: Date | null, revokedAt: Date | null = null) =>
      up.insert(apiKeys).values({ userId: u!.id, name, tokenHash: `fx2-${name}-${RUN}`, expiresAt, revokedAt }).returning();
    ids.never = (await key("never", null))[0]!.id;
    ids.far = (await key("far", new Date(Date.now() + 5 * 365 * 86_400_000)))[0]!.id;
    ids.soon = (await key("soon", new Date(Date.now() + 10 * 86_400_000)))[0]!.id;
    ids.revoked = (await key("revoked", null, new Date()))[0]!.id;
    const cert = { idpSigningCerts: [CERT], idpSsoUrl: "https://idp.fx2.example/sso" };
    const p = (name: string, v: Record<string, unknown>) =>
      up.insert(samlProviders).values({ ...cert, entityId: `https://${name}.fx2.example`, name, ...v }).returning();
    ids.jitNoDomains = (await p("jit-none", { jitProvisioning: true, allowedEmailDomains: null }))[0]!.id;
    ids.jitEmpty = (await p("jit-empty", { jitProvisioning: true, allowedEmailDomains: [] }))[0]!.id;
    ids.jitOk = (await p("jit-ok", { jitProvisioning: true, allowedEmailDomains: ["fx2.example"] }))[0]!.id;
    ids.assertionOnly = (await p("assertion-only", { wantAuthnResponseSigned: false }))[0]!.id;

    await runMigrations(up, migrationsFolder);
  }, 180_000);

  afterAll(async () => {
    await (up.$client as { end: () => Promise<void> }).end();
    if (partial) rmSync(partial, { recursive: true, force: true });
  });

  it("gives every live key without an expiry, or beyond the 365-day ceiling, the ceiling — and leaves the rest", async () => {
    const rows = new Map((await up.select().from(apiKeys)).map((k) => [k.id, k]));
    const inDays = (id: string) => (rows.get(id)!.expiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(inDays(ids.never!)).toBeGreaterThan(364);
    expect(inDays(ids.never!)).toBeLessThanOrEqual(365);
    expect(inDays(ids.far!)).toBeLessThanOrEqual(365);
    expect(inDays(ids.soon!)).toBeLessThan(11);
    expect(rows.get(ids.revoked!)!.expiresAt).toBeNull();
    const audit = await latestAudit("api-key-expiry-backfilled", up);
    expect(audit!.userId).toBe(SYSTEM);
    expect(audit!.objectType).toBe("api_key");
    expect(audit!.detail).toMatchObject({
      phase: "migration-0160", migration: "0160_strict_identity_followups",
      keys: 2, neverExpiring: 1, beyondCeiling: 1, ceilingDays: 365,
    });
    expect(((audit!.detail as { keyIds: string[] }).keyIds).sort()).toEqual([ids.never!, ids.far!].sort());
  });

  it("turns SAML JIT off where no domains are named, one audit row each, and adds the CHECK", async () => {
    const rows = new Map((await up.select().from(samlProviders)).map((p) => [p.id, p]));
    expect(rows.get(ids.jitNoDomains!)!.jitProvisioning).toBe(false);
    expect(rows.get(ids.jitEmpty!)!.jitProvisioning).toBe(false);
    expect(rows.get(ids.jitOk!)!.jitProvisioning).toBe(true);
    const audits = await up.select().from(auditLog).where(eq(auditLog.ruleId, "jit_requires_allowed_domains"));
    expect(audits.map((a) => a.objectId).sort()).toEqual([ids.jitNoDomains!, ids.jitEmpty!].sort());
    expect(audits[0]!.detail).toMatchObject({ transitions: { jitProvisioning: { from: true, to: false } } });
    await expect(up.update(samlProviders).set({ jitProvisioning: true }).where(eq(samlProviders.id, ids.jitEmpty!))).rejects.toThrow();
  });

  it("records every provider that requires a signed Response (strict since 0156), so a lock-out has a trail", async () => {
    const audits = await up.select().from(auditLog).where(eq(auditLog.ruleId, "saml-response-signing-required"));
    const expected = (await up.select().from(samlProviders).where(eq(samlProviders.wantAuthnResponseSigned, true))).map((p) => p.id);
    expect(audits.map((a) => a.objectId).sort()).toEqual(expected.sort());
    expect(audits.map((a) => a.objectId)).not.toContain(ids.assertionOnly);
    expect(audits[0]!.reason).toContain("wantAuthnResponseSigned");
  });

  it("the migration's audit rows are CHAINED (drained through createDb), and the outbox is empty", async () => {
    const rows = await up
      .select()
      .from(auditLog)
      .where(sql`${auditLog.detail}->>'migration' = '0160_strict_identity_followups'`);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const r of rows) {
      expect(r.seq).not.toBeNull();
      expect(r.rowHash).not.toBeNull();
    }
    expect(await up.select().from(migrationAuditOutbox)).toHaveLength(0);
    expect(await up.select().from(auditLog).where(and(isNotNull(auditLog.id), sql`${auditLog.seq} is null`, sql`${auditLog.detail}->>'migration' is not null`))).toHaveLength(0);
  });

  it("a fresh org has nothing to migrate: no 0160 rows at all", async () => {
    expect(await db.select().from(auditLog).where(sql`${auditLog.detail}->>'migration' = '0160_strict_identity_followups'`)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// finding 9 — the dev box keeps a bounded HSTS
// ---------------------------------------------------------------------------
describe("ADR-0181 FX2 finding 9 — the dev box overrides the one-year HSTS default", () => {
  const repo = path.resolve(here, "../../..");
  it("the compose override in user-data sets REGULAIT_HSTS to one day, and the gateway accepts it", () => {
    const tpl = readFileSync(path.join(repo, "infra/modules/app-instance/user-data.sh.tftpl"), "utf8");
    const start = tpl.indexOf("cat > docker-compose.override.yml");
    const override = tpl.slice(start, tpl.indexOf("\nEOF", start));
    const m = /REGULAIT_HSTS:\s*(\S+)/.exec(override);
    expect(m?.[1]).toBe("max-age=86400");
    expect(resolveHsts({ REGULAIT_HSTS: m![1] })).toBe("max-age=86400");
  });

  it("the Caddyfile no longer claims the gateway default is one day", () => {
    const caddy = readFileSync(path.join(repo, "infra/caddy/Caddyfile"), "utf8");
    expect(caddy).not.toContain("Its default is now a bounded `max-age=86400`");
    expect(caddy).toContain("max-age=31536000");
  });
});
