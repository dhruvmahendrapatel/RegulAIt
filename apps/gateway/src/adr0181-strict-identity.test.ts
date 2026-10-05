/**
 * ADR-0181 (strict defaults everywhere) — SA: identity and sessions.
 *
 * Each flip is read off a FRESH org: a scratch database that has run every
 * migration and nothing else. The singleton there was inserted by migration
 * 0038 and moved by 0156's UPDATE; a second read inserts a brand-new row
 * inside a rolled-back transaction, so the column defaults are pinned too.
 * Then each strict value is shown doing its job, and each relaxation is shown
 * to go through the admin route and be audited old -> new.
 *
 *  - mfaRequired = admins: an admin session is held at enrolment; a member's
 *    is not; enrolling opens it.
 *  - passwordRequireClasses = 3: a two-class password is refused.
 *  - sessionIdleMinutes = 30: a new session snapshots 30.
 *  - apiKeyDefaultTtlDays / apiKeyMaxTtlDays = 90 / 365.
 *  - approvalDelegationEnabled = false: a delegation window is refused.
 *  - SAML wantAuthnResponseSigned = true, from the API and from the column.
 *  - OIDC JIT requires allowedEmailDomains: create, PATCH (both orders) and
 *    the database CHECK all refuse it.
 *  - REGULAIT_HSTS unset = one year.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  authSessions,
  createDb,
  desc,
  eq,
  oidcProviders,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  samlProviders,
  sql,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { resolveHsts } from "./hsts.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";
import { enrolTotpForTest } from "./testing/identity-posture.js";
import { installLicenseFixture, removeLicenseFixture } from "./testing/license-fixture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
// per-run unique, so a concurrent or crashed run never collides
const SCRATCH_DB = `regulait_adr0181_sa_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + SCRATCH_DB;
  return u.toString();
})();

const BOOT = "adr0181-sa-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
const DAY_MS = 24 * 60 * 60 * 1000;
const CERT = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ2Fz\n-----END CERTIFICATE-----";

let admin: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(scratchUrl);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });
}, 120_000);

afterAll(async () => {
  await closeAll([
    () => app.close(),
    () => (db.$client as { end: () => Promise<void> }).end(),
    () => dropScratchDatabase(admin, SCRATCH_DB),
    () => (admin.$client as { end: () => Promise<void> }).end(),
  ]);
});

const json = (r: { json: () => unknown }) => r.json() as Record<string, any>;
const settings = async () => json(await app.inject({ method: "GET", headers: AUTH, url: "/v1/org/settings" })).settings;
const putSettings = (payload: Record<string, unknown>) =>
  app.inject({ method: "PUT", headers: AUTH, url: "/v1/org/settings", payload });
const latestAudit = async (ruleId: string) => {
  const [row] = await db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId)).orderBy(desc(auditLog.at)).limit(1);
  return row ?? null;
};
let seq = 0;
const mkUser = async (isAdmin: boolean): Promise<{ id: string; email: string }> => {
  const email = `sa0181-${++seq}-${Date.now()}@adr0181.example`;
  const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: `SA ${seq}`, isAdmin } });
  expect(r.statusCode, r.body).toBe(201);
  return { id: json(r).id, email };
};
/** password onboarding: one-time password, sign in, set a real one */
const onboard = async (u: { id: string; email: string }, password = "Sa0181-Strong-pass") => {
  const init = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.id}/set-initial-password`, payload: {} });
  const oneTime = json(init).password as string;
  const login = await app.inject({ method: "POST", url: "/auth/login", headers: CSRF, payload: { email: u.email, password: oneTime } });
  expect(login.statusCode, login.body).toBe(200);
  const cookie = login.cookies.find((c) => c.name === "regulait_session")!.value;
  const changed = await app.inject({
    method: "POST", url: "/auth/change-password", headers: CSRF, cookies: { regulait_session: cookie },
    payload: { currentPassword: oneTime, newPassword: password },
  });
  return { cookie, oneTime, changed };
};

describe("ADR-0181 SA — a fresh org reads the strict identity defaults", () => {
  it("the migrated singleton carries every strict value", async () => {
    const s = await settings();
    expect(s.mfaRequired).toBe("admins");
    expect(s.passwordRequireClasses).toBe(3);
    expect(s.sessionIdleMinutes).toBe(30);
    expect(s.apiKeyDefaultTtlDays).toBe(90);
    expect(s.apiKeyMaxTtlDays).toBe(365);
    expect(s.approvalDelegationEnabled).toBe(false);
  });

  it("a brand-new settings row gets them from the column defaults", async () => {
    const ROLLBACK = new Error("rollback");
    let fresh: Record<string, unknown> | undefined;
    await db
      .transaction(async (tx) => {
        await tx.delete(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
        [fresh] = await tx.insert(orgSettings).values({ id: ORG_SETTINGS_ID }).returning();
        throw ROLLBACK;
      })
      .catch((e) => {
        if (e !== ROLLBACK) throw e;
      });
    expect(fresh).toMatchObject({
      mfaRequired: "admins",
      passwordRequireClasses: 3,
      sessionIdleMinutes: 30,
      apiKeyDefaultTtlDays: 90,
      apiKeyMaxTtlDays: 365,
      approvalDelegationEnabled: false,
    });
  });

  it("REGULAIT_HSTS unset pins one year", () => {
    expect(resolveHsts({})).toBe("max-age=31536000");
  });
});

describe("ADR-0181 SA — MFA required for admins", () => {
  it("an admin session is held at enrolment, a member's is not, and enrolling opens it", async () => {
    const a = await mkUser(true);
    const { cookie } = await onboard(a);
    const held = await app.inject({ method: "GET", url: "/v1/me", cookies: { regulait_session: cookie } });
    expect(held.statusCode).toBe(403);
    expect(json(held).error).toBe("mfa_enrollment_required");
    const me = await app.inject({ method: "GET", url: "/auth/me", cookies: { regulait_session: cookie } });
    expect(json(me).mfaSetupRequired).toBe(true);

    const m = await mkUser(false);
    const member = await onboard(m);
    expect((await app.inject({ method: "GET", url: "/v1/me", cookies: { regulait_session: member.cookie } })).statusCode).toBe(200);

    await enrolTotpForTest(app, cookie);
    expect((await app.inject({ method: "GET", url: "/v1/me", cookies: { regulait_session: cookie } })).statusCode).toBe(200);
  });

  it("an admin may relax it to off; the audit row records old -> new", async () => {
    try {
      const r = await putSettings({ mfaRequired: "off" });
      expect(r.statusCode).toBe(200);
      const row = await latestAudit("org-settings-updated");
      expect((row!.detail as { transitions: unknown }).transitions).toEqual({ mfaRequired: { from: "admins", to: "off" } });
      const a = await mkUser(true);
      const { cookie } = await onboard(a);
      expect((await app.inject({ method: "GET", url: "/v1/me", cookies: { regulait_session: cookie } })).statusCode).toBe(200);
    } finally {
      await putSettings({ mfaRequired: "admins" });
    }
  });
});

describe("ADR-0181 SA — passwords and sessions", () => {
  it("a two-class password is refused; a three-class one is accepted", async () => {
    const u = await mkUser(false);
    const threeClass = await onboard(u, "lowercase-and-1234"); // lower, digit, symbol
    expect(threeClass.changed.statusCode).toBe(200);
    const v = await mkUser(false);
    const twoClass = await onboard(v, "onlylowercase1234"); // lower, digit
    expect(twoClass.changed.statusCode).toBe(422);
    expect(json(twoClass.changed).detail).toContain("at least 3 of");
  });

  it("an admin may relax the classes to 2, audited old -> new", async () => {
    try {
      expect((await putSettings({ passwordRequireClasses: 2 })).statusCode).toBe(200);
      const row = await latestAudit("org-settings-updated");
      expect((row!.detail as { transitions: unknown }).transitions).toEqual({ passwordRequireClasses: { from: 3, to: 2 } });
      const u = await mkUser(false);
      expect((await onboard(u, "onlylowercase1234")).changed.statusCode).toBe(200);
    } finally {
      await putSettings({ passwordRequireClasses: 3 });
    }
  });

  it("a new session snapshots a 30-minute idle window", async () => {
    const u = await mkUser(false);
    const { cookie } = await onboard(u);
    const [row] = await db
      .select({ idleMinutes: authSessions.idleMinutes, idleExpiresAt: authSessions.idleExpiresAt, createdAt: authSessions.createdAt })
      .from(authSessions)
      .where(and(eq(authSessions.userId, u.id)))
      .orderBy(desc(authSessions.createdAt))
      .limit(1);
    expect(cookie).toBeTruthy();
    expect(row!.idleMinutes).toBe(30);
    expect(row!.idleExpiresAt.getTime() - Date.now()).toBeLessThanOrEqual(30 * 60_000 + 5_000);
  });
});

describe("ADR-0181 SA — API keys expire", () => {
  it("a key issued with no expiry lasts 90 days, and 'never' is over the 365-day ceiling", async () => {
    const u = await mkUser(false);
    const issued = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.id}/keys`, payload: { name: "fresh" } });
    expect(issued.statusCode).toBe(201);
    expect(json(issued).expirySource).toBe("org_default");
    const days = (new Date(json(issued).expiresAt).getTime() - Date.now()) / DAY_MS;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
    const never = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.id}/keys`, payload: { name: "never", expiresAt: null } });
    expect(never.statusCode).toBe(422);
    expect(json(never).detail).toContain("365 day(s)");
  });
});

describe("ADR-0181 SA — approver delegation is off", () => {
  it("a delegation window is refused until an admin turns delegation on (audited)", async () => {
    const from = await mkUser(false);
    const to = await mkUser(false);
    const window = {
      fromUserId: from.id, toUserId: to.id,
      startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const refused = await app.inject({ method: "POST", headers: AUTH, url: "/v1/delegations", payload: window });
    expect(refused.statusCode).toBe(409);
    expect(json(refused).error).toBe("delegation_disabled");
    try {
      expect((await putSettings({ approvalDelegationEnabled: true })).statusCode).toBe(200);
      const row = await latestAudit("org-settings-updated");
      expect((row!.detail as { transitions: unknown }).transitions).toEqual({ approvalDelegationEnabled: { from: false, to: true } });
      const ok = await app.inject({ method: "POST", headers: AUTH, url: "/v1/delegations", payload: window });
      expect(ok.statusCode, ok.body).toBe(201);
    } finally {
      await putSettings({ approvalDelegationEnabled: false });
    }
  });
});

describe("ADR-0181 SA — SAML requires a signed Response by default", () => {
  beforeAll(async () => {
    await installLicenseFixture(app, { features: ["sso_saml"], auth: AUTH });
  });
  afterAll(async () => {
    await removeLicenseFixture(db);
  });

  it("a provider created through the API, or as a bare row, requires the Response signature", async () => {
    const created = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/auth/saml-providers",
      payload: { name: "sa0181-saml", entityId: "https://idp.adr0181.example", idpSsoUrl: "https://idp.adr0181.example/sso", idpSigningCerts: [CERT] },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(json(created).wantAuthnResponseSigned).toBe(true);
    const [bare] = await db
      .insert(samlProviders)
      .values({ name: "sa0181-saml-bare", entityId: "https://idp2.adr0181.example", idpSsoUrl: "https://idp2.adr0181.example/sso", idpSigningCerts: [CERT] })
      .returning();
    expect(bare!.wantAuthnResponseSigned).toBe(true);
  });
});

describe("ADR-0181 SA — OIDC JIT provisioning needs allowed email domains", () => {
  const base = { issuerUrl: "https://idp.adr0181.example", clientId: "sa0181", clientSecret: "synthetic-secret" };

  it("create with JIT on and no domains is refused by name, audited, and nothing is saved", async () => {
    const r = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/auth/oidc-providers",
      payload: { ...base, name: "sa0181-jit-nodomains", jitProvisioning: true },
    });
    expect(r.statusCode).toBe(422);
    expect(json(r).error).toBe("jit_requires_allowed_domains");
    const audit = await latestAudit("jit_requires_allowed_domains");
    expect(audit!.effect).toBe("deny");
    expect(await db.select().from(oidcProviders).where(eq(oidcProviders.name, "sa0181-jit-nodomains"))).toHaveLength(0);
  });

  it("PATCH cannot turn JIT on without domains, nor clear the domains under JIT", async () => {
    const [p] = await db
      .insert(oidcProviders)
      .values({ name: "sa0181-jit-patch", issuerUrl: base.issuerUrl, clientId: base.clientId, clientSecretCiphertext: "not-used" })
      .returning();
    const on = await app.inject({ method: "PATCH", headers: AUTH, url: `/v1/auth/oidc-providers/${p!.id}`, payload: { jitProvisioning: true } });
    expect(on.statusCode).toBe(422);
    expect(json(on).error).toBe("jit_requires_allowed_domains");

    const both = await app.inject({
      method: "PATCH", headers: AUTH, url: `/v1/auth/oidc-providers/${p!.id}`,
      payload: { jitProvisioning: true, allowedEmailDomains: ["adr0181.example"] },
    });
    expect(both.statusCode, both.body).toBe(200);
    const audit = await latestAudit("oidc-provider-updated");
    expect((audit!.detail as { transitions: unknown }).transitions).toEqual({
      jitProvisioning: { from: false, to: true },
      allowedEmailDomains: { from: null, to: ["adr0181.example"] },
    });

    const clear = await app.inject({ method: "PATCH", headers: AUTH, url: `/v1/auth/oidc-providers/${p!.id}`, payload: { allowedEmailDomains: null } });
    expect(clear.statusCode).toBe(422);
    expect(json(clear).error).toBe("jit_requires_allowed_domains");
  });

  it("the database refuses the combination too", async () => {
    await expect(
      db.insert(oidcProviders).values({
        name: "sa0181-jit-db", issuerUrl: base.issuerUrl, clientId: base.clientId, clientSecretCiphertext: "not-used", jitProvisioning: true,
      }),
    ).rejects.toThrow();
  });
});
