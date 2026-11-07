/**
 * ADR-0240 — ONE SECOND FACTOR FOR THE EXTERNAL PORTALS (supplier, ADR-0221; auditor, ADR-0225), on a real database
 * through the real app.
 *
 * Pinned, for each portal:
 *  - required by default: a spent link opens a challenge, never a session; the first use enrols (the secret is shown
 *    once), a later link verifies and never re-enrols; the challenge cookie is HttpOnly, SameSite=Strict and scoped
 *    to the portal's `…/session/mfa` path;
 *  - NEGATIVE: a wrong code, a replayed code (the same step again), a link reused after enrolment, a challenge of the
 *    other portal, and a missing data key are all refused;
 *  - lockout: `failuresBeforeLock` wrong codes lock the factor (audited), a locked factor refuses its codes and every
 *    new link; recovery is the inviting admin's reset only (step-up, audited), after which the next link enrols again;
 *  - relaxing the requirement needs a step-up and is audited as a relaxation; relaxed, a link alone opens a session;
 *  - rate limit: the per-challenge bucket answers 429 once exceeded;
 *  - route classes: the two verify routes are public to the platform hooks, the reset and state routes admin-only.
 *
 * Global state (M-068): every setting and the step-up posture are put back to strict, and every row is removed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiVendors,
  and,
  auditLog,
  auditorGrants,
  compliancePackControls,
  compliancePacks,
  createDb,
  desc,
  eq,
  externalMfaFactors,
  inArray,
  runMigrations,
  sql,
  supplierSessions,
  trustPublications,
  type Db,
} from "@regulait/db";
import { EXTERNAL_MFA_COOKIE, EXTERNAL_MFA_LIMITS, SUPPLIER_SESSION_COOKIE } from "@regulait/shared";
import { buildApp } from "./app.js";
import { routeAuthClass } from "./route-classes.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";
import { totpCode, totpStep } from "./totp.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `xm-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "c".repeat(64);
const FRAMEWORK = `xm-standard-${RUN}`;
const CSRF = { "x-regulait-csrf": "1" };

let db: Db;
let app: ReturnType<typeof buildApp>;
let noKey: ReturnType<typeof buildApp>;
let limited: ReturnType<typeof buildApp>;
let restoreStepUp: (() => Promise<void>) | undefined;
let restoreIdentity: (() => Promise<void>) | undefined;
let admin: { id: string; auth: { authorization: string } };
const vendorIds: string[] = [];
const grantIds: string[] = [];
const publicationIds: string[] = [];
let packId: string;

const rnd = () => Math.floor(Math.random() * 250) + 1;
const freshIp = () => `203.0.${rnd()}.${rnd()}`;
type Res = { statusCode: number; headers: Record<string, unknown>; json: () => any; body: string };
const setCookies = (r: Res): string[] => {
  const h = r.headers["set-cookie"];
  return Array.isArray(h) ? h.map(String) : h ? [String(h)] : [];
};
const cookieNamed = (r: Res, name: string) => setCookies(r).find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`));
const pair = (c: string | undefined) => c!.split(";")[0]!;

/** the code for now (a second, different call returns the next step's code: the window allows +1) */
const codeNow = (secret: string, offset = 0) => totpCode(secret, totpStep() + offset);
/** a code that matches no step in the ±1 window */
function wrongCode(secret: string): string {
  const live = new Set([-1, 0, 1].map((d) => codeNow(secret, d)));
  for (let n = 0; ; n++) {
    const c = String(n).padStart(6, "0");
    if (!live.has(c)) return c;
  }
}

async function lastAudit(ruleId: string, objectId: string) {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.ruleId, ruleId), eq(auditLog.objectId, objectId)))
    .orderBy(desc(auditLog.seq))
    .limit(1);
  return row;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  noKey = buildApp(db, { bootstrapToken: BOOT });
  limited = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, trustProxy: false, rateLimit: { enabled: true, globalMax: 100_000, apiKeyMax: 100_000 } });
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `xm-admin-${RUN}@example.com`, displayName: "xm admin", isAdmin: true } });
  expect(u.statusCode, u.body).toBe(201);
  const key = await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: "xm" } });
  admin = { id: u.json().id, auth: { authorization: `Bearer ${key.json().token}` } };
  const [p] = await db
    .insert(compliancePacks)
    .values({
      framework: FRAMEWORK,
      version: 1,
      title: "external mfa test pack",
      description: "authored by the external portal MFA suite",
      provenance: { source: "test suite", reviewedBy: null },
      status: "active",
    } as never)
    .returning({ id: compliancePacks.id });
  packId = p!.id;
  await db.insert(compliancePackControls).values({
    packId,
    controlRef: "xm:1.1",
    title: "Suppliers state their AI controls",
    coverage: "unaddressed",
    collector: "none",
    collectorParams: {},
    minEvidenceCount: 1,
    attestationRequired: true,
    ownerNote: null,
  } as never);
}, 120_000);

afterAll(async () => {
  await restoreStepUp?.();
  await db.execute(
    sql`UPDATE org_settings SET supplier_portal_enabled = false, supplier_portal_mfa_required = true, trust_pages_enabled = false, trust_auditor_mfa_required = true`,
  );
  await restoreIdentity?.();
  if (vendorIds.length) await db.delete(aiVendors).where(inArray(aiVendors.id, vendorIds));
  if (grantIds.length) await db.delete(auditorGrants).where(inArray(auditorGrants.id, grantIds));
  if (publicationIds.length) await db.delete(trustPublications).where(inArray(trustPublications.id, publicationIds));
  await db.delete(compliancePackControls).where(eq(compliancePackControls.packId, packId));
  await db.delete(compliancePacks).where(eq(compliancePacks.id, packId));
  for (const a of [app, noKey, limited]) {
    a.server.closeAllConnections();
    await a.close();
  }
});

describe("the settings ship strict", () => {
  it("both portals require the second factor by default, and the verify routes are classed public, the admin routes admin", async () => {
    const [row] = (await db.execute(sql`SELECT supplier_portal_mfa_required AS s, trust_auditor_mfa_required AS t FROM org_settings`)).rows as Array<{ s: boolean; t: boolean }>;
    expect(row).toEqual({ s: true, t: true });
    expect(routeAuthClass("POST", "/supplier/v1/session/mfa")).toBe("public");
    expect(routeAuthClass("POST", "/v1/auditor/session/mfa")).toBe("public");
    expect(routeAuthClass("POST", "/v1/vendors/:vendorId/supplier-access/:accessId/mfa/reset")).toBe("admin");
    expect(routeAuthClass("GET", "/v1/vendors/:vendorId/supplier-access/:accessId/mfa")).toBe("admin");
    expect(routeAuthClass("POST", "/v1/trust/auditor-grants/:grantId/mfa/reset")).toBe("admin");
    expect(routeAuthClass("GET", "/v1/trust/auditor-grants/:grantId/mfa")).toBe("admin");
  });
});

// =================================================================================================================
// the supplier portal
// =================================================================================================================

describe("supplier portal second factor", () => {
  let vendorId: string;
  let accessId: string;
  let firstLink: string;
  let secret: string;

  const signIn = (token: string, a = app, ip = freshIp()) =>
    a.inject({ method: "POST", url: "/supplier/v1/session", headers: CSRF, payload: { token }, remoteAddress: ip }) as Promise<Res>;
  const verify = (challenge: string | undefined, code: string, a = app, ip = freshIp()) =>
    a.inject({ method: "POST", url: "/supplier/v1/session/mfa", headers: { ...CSRF, ...(challenge ? { cookie: challenge } : {}) }, payload: { code }, remoteAddress: ip }) as Promise<Res>;
  async function newLink(): Promise<string> {
    const r = await app.inject({ method: "POST", url: `/v1/vendors/${vendorId}/supplier-access/${accessId}/links`, headers: admin.auth, payload: {} });
    expect(r.statusCode, r.body).toBe(201);
    const url = r.json().link.url as string;
    return url.slice(url.indexOf("#") + 1);
  }
  const challengeOf = (r: Res) => pair(cookieNamed(r, EXTERNAL_MFA_COOKIE));

  beforeAll(async () => {
    restoreStepUp = await relaxStepUpForTest(db);
    const on = await app.inject({ method: "PUT", url: "/v1/supplier-portal/settings", headers: admin.auth, payload: { enabled: true } });
    expect(on.statusCode, on.body).toBe(200);
    const v = await app.inject({
      method: "POST",
      url: "/v1/vendors",
      headers: admin.auth,
      payload: { name: `xm vendor ${RUN}`, description: "synthetic mfa fixture", category: "ai_feature_vendor" },
    });
    expect(v.statusCode, v.body).toBe(201);
    vendorId = v.json().id;
    vendorIds.push(vendorId);
    const g = await app.inject({ method: "POST", url: `/v1/vendors/${vendorId}/supplier-access`, headers: admin.auth, payload: { email: `xm-${RUN}@supplier.example`, framework: FRAMEWORK } });
    expect(g.statusCode, g.body).toBe(201);
    accessId = g.json().access.id;
    const url = g.json().link.url as string;
    firstLink = url.slice(url.indexOf("#") + 1);
  });

  it("without a data key the link is refused before it is spent (fail closed)", async () => {
    const r = await signIn(firstLink, noKey);
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe("mfa_unavailable");
  });

  it("first use enrols: the link opens a challenge (scoped cookie), not a session; the secret is shown once", async () => {
    const r = await signIn(firstLink);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.mfa).toBe("enrol");
    expect(body.secret).toMatch(/^[A-Z2-7]+$/);
    expect(body.otpauthUri).toContain(encodeURIComponent(`RegulAIt:xm-${RUN}@supplier.example`));
    secret = body.secret;
    const c = cookieNamed(r, EXTERNAL_MFA_COOKIE)!;
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Strict/);
    expect(c).toMatch(/Path=\/supplier\/v1\/session\/mfa/);
    expect(cookieNamed(r, SUPPLIER_SESSION_COOKIE)).toBeUndefined();
    const sessions = await db.select().from(supplierSessions).where(eq(supplierSessions.accessId, accessId));
    expect(sessions).toHaveLength(0);
    const [f] = await db.select().from(externalMfaFactors).where(eq(externalMfaFactors.supplierAccessId, accessId));
    expect(f!.activatedAt).toBeNull();
    expect(f!.secretCiphertext).not.toContain(secret);
    expect((await lastAudit("supplier-mfa-challenge", accessId))?.detail).toMatchObject({ phase: "mfa-enrol" });

    // NEGATIVE: a wrong code is refused and counted, nothing opens
    const wrong = await verify(challengeOf(r), wrongCode(secret));
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toBe("mfa_code_invalid");
    expect(cookieNamed(wrong, SUPPLIER_SESSION_COOKIE)).toBeUndefined();
    expect((await lastAudit("supplier-mfa-code-rejected", accessId))?.effect).toBe("deny");

    // the right code proves the enrolment and opens the session; the challenge cookie is cleared
    const ok = await verify(challengeOf(r), codeNow(secret));
    expect(ok.statusCode, ok.body).toBe(200);
    const session = pair(cookieNamed(ok, SUPPLIER_SESSION_COOKIE));
    expect(setCookies(ok).some((x) => x.startsWith(`${EXTERNAL_MFA_COOKIE}=;`))).toBe(true);
    const read = await app.inject({ method: "GET", url: "/supplier/v1/assessment", headers: { cookie: session }, remoteAddress: freshIp() });
    expect(read.statusCode, read.body).toBe(200);
    const [after] = await db.select().from(externalMfaFactors).where(eq(externalMfaFactors.supplierAccessId, accessId));
    expect(after!.activatedAt).not.toBeNull();
    expect(after!.failedAttempts).toBe(0);
    expect((await lastAudit("supplier-session-started", accessId))?.detail).toMatchObject({ mfa: "totp-enrolled" });

    // NEGATIVE: the spent challenge cannot be used twice
    const again = await verify(challengeOf(r), codeNow(secret, 1));
    expect(again.statusCode).toBe(401);
    expect(again.json().error).toBe("mfa_challenge_not_valid");
  });

  it("NEGATIVE: the link is not reusable after enrolment, and a new link verifies without ever re-enrolling", async () => {
    const reused = await signIn(firstLink);
    expect(reused.statusCode).toBe(401);
    expect(reused.json().error).toBe("link_not_valid");
    expect(cookieNamed(reused, EXTERNAL_MFA_COOKIE)).toBeUndefined();

    const r = await signIn(await newLink());
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ mfa: "verify" });
    expect(r.json().secret).toBeUndefined();
    expect(r.json().otpauthUri).toBeUndefined();

    // NEGATIVE: a replayed code (the step already used at enrolment) is refused
    const [f] = await db.select().from(externalMfaFactors).where(eq(externalMfaFactors.supplierAccessId, accessId));
    const replay = await verify(challengeOf(r), totpCode(secret, f!.lastUsedStep!));
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe("mfa_code_invalid");

    // the next step's code is fresh and opens a session
    const ok = await verify(challengeOf(r), totpCode(secret, f!.lastUsedStep! + 1));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(cookieNamed(ok, SUPPLIER_SESSION_COOKIE)).toBeDefined();
    expect((await lastAudit("supplier-session-started", accessId))?.detail).toMatchObject({ mfa: "totp" });
  });

  it("NEGATIVE: a supplier challenge does not work on the auditor portal", async () => {
    const r = await signIn(await newLink());
    expect(r.statusCode).toBe(200);
    await db.execute(sql`UPDATE org_settings SET trust_pages_enabled = true`);
    try {
      const cross = await app.inject({ method: "POST", url: "/v1/auditor/session/mfa", headers: { ...CSRF, cookie: challengeOf(r) }, payload: { code: "123456" } });
      expect(cross.statusCode).toBe(401);
      expect(cross.json().error).toBe("mfa_challenge_not_valid");
    } finally {
      await db.execute(sql`UPDATE org_settings SET trust_pages_enabled = false`);
    }
  });

  it("lockout: repeated wrong codes lock the factor (audited); a locked factor refuses codes and new links", async () => {
    const r = await signIn(await newLink());
    expect(r.statusCode).toBe(200);
    const ch = challengeOf(r);
    let last: Res | undefined;
    for (let i = 0; i < EXTERNAL_MFA_LIMITS.failuresBeforeLock; i++) last = await verify(ch, wrongCode(secret));
    expect(last!.statusCode).toBe(423);
    expect(last!.json().error).toBe("mfa_locked");
    const audit = await lastAudit("supplier-mfa-lockout", accessId);
    expect(audit?.effect).toBe("deny");
    // the right code no longer opens anything: the challenge was revoked with the lock
    const late = await verify(ch, codeNow(secret, 1));
    expect(late.statusCode).toBe(401);
    expect(cookieNamed(late, SUPPLIER_SESSION_COOKIE)).toBeUndefined();
    // and a new link is refused while locked
    const locked = await signIn(await newLink());
    expect(locked.statusCode).toBe(423);
    expect(locked.json().error).toBe("mfa_locked");
    expect((await lastAudit("supplier-mfa-locked-refused", accessId))?.effect).toBe("deny");
    const state = await app.inject({ method: "GET", url: `/v1/vendors/${vendorId}/supplier-access/${accessId}/mfa`, headers: admin.auth });
    expect(state.json()).toMatchObject({ state: "locked" });
  });

  it("recovery is the inviting admin's reset only: step-up, audited, sessions end, and the next link enrols again", async () => {
    await restoreStepUp!();
    try {
      const refused = await app.inject({ method: "POST", url: `/v1/vendors/${vendorId}/supplier-access/${accessId}/mfa/reset`, headers: admin.auth, payload: { reason: "lost phone" } });
      expect(refused.statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: `/v1/vendors/${vendorId}/supplier-access/${accessId}/mfa`, headers: admin.auth })).json().state).toBe("locked");
    } finally {
      restoreStepUp = await relaxStepUpForTest(db);
    }
    const reset = await app.inject({ method: "POST", url: `/v1/vendors/${vendorId}/supplier-access/${accessId}/mfa/reset`, headers: admin.auth, payload: { reason: "lost phone" } });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json()).toMatchObject({ reset: true, hadFactor: true });
    expect((await lastAudit("supplier-mfa-reset", accessId))?.detail).toMatchObject({ wasLocked: true, reason: "lost phone" });
    const live = await db
      .select()
      .from(supplierSessions)
      .where(and(eq(supplierSessions.accessId, accessId), sql`${supplierSessions.revokedAt} IS NULL`));
    expect(live).toHaveLength(0);
    const r = await signIn(await newLink());
    expect(r.json().mfa).toBe("enrol");
    secret = r.json().secret;
    const ok = await verify(challengeOf(r), codeNow(secret));
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("rate limit: the per-challenge bucket answers 429 once exceeded", async () => {
    const r = await signIn(await newLink(), limited);
    expect(r.statusCode, r.body).toBe(200);
    const ch = challengeOf(r);
    const statuses: number[] = [];
    for (let i = 0; i <= EXTERNAL_MFA_LIMITS.perChallenge.max; i++) statuses.push((await verify(ch, "000000", limited, freshIp())).statusCode);
    expect(statuses.at(-1)).toBe(429);
    // put the factor back (the wrong codes above locked it)
    const reset = await app.inject({ method: "POST", url: `/v1/vendors/${vendorId}/supplier-access/${accessId}/mfa/reset`, headers: admin.auth, payload: { reason: "rate test" } });
    expect(reset.statusCode).toBe(200);
  });

  it("relaxing the requirement needs a step-up and is audited as a relaxation; relaxed, a link alone opens a session", async () => {
    await restoreStepUp!();
    try {
      const refused = await app.inject({ method: "PUT", url: "/v1/supplier-portal/settings", headers: admin.auth, payload: { mfaRequired: false } });
      expect(refused.statusCode).toBeGreaterThanOrEqual(400);
      expect((await app.inject({ method: "GET", url: "/v1/supplier-portal/settings", headers: admin.auth })).json().mfaRequired).toBe(true);
    } finally {
      restoreStepUp = await relaxStepUpForTest(db);
    }
    const off = await app.inject({ method: "PUT", url: "/v1/supplier-portal/settings", headers: admin.auth, payload: { mfaRequired: false } });
    expect(off.statusCode, off.body).toBe(200);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "supplier-portal-setting"), eq(auditLog.userId, admin.id)))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    expect((row!.detail as { relaxed: string[] }).relaxed).toEqual(["supplierPortalMfaRequired"]);
    const r = await signIn(await newLink());
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().mfa).toBeUndefined();
    expect(cookieNamed(r, SUPPLIER_SESSION_COOKIE)).toBeDefined();
    const on = await app.inject({ method: "PUT", url: "/v1/supplier-portal/settings", headers: admin.auth, payload: { mfaRequired: true } });
    expect(on.statusCode).toBe(200);
  });
});

// =================================================================================================================
// the auditor portal
// =================================================================================================================

describe("auditor portal second factor", () => {
  let grantId: string;
  let firstLink: string;
  let secret: string;

  const redeem = (token: string, a = app) => a.inject({ method: "POST", url: "/v1/auditor/session", headers: CSRF, payload: { token }, remoteAddress: freshIp() }) as Promise<Res>;
  const verify = (challenge: string | undefined, code: string) =>
    app.inject({ method: "POST", url: "/v1/auditor/session/mfa", headers: { ...CSRF, ...(challenge ? { cookie: challenge } : {}) }, payload: { code }, remoteAddress: freshIp() }) as Promise<Res>;
  const challengeOf = (r: Res) => pair(cookieNamed(r, EXTERNAL_MFA_COOKIE));
  async function newLink(): Promise<string> {
    const r = await app.inject({ method: "POST", url: `/v1/trust/auditor-grants/${grantId}/links`, headers: admin.auth, payload: {} });
    expect(r.statusCode, r.body).toBe(201);
    return String(r.json().link.path).split("#")[1]!;
  }

  beforeAll(async () => {
    restoreStepUp ??= await relaxStepUpForTest(db);
    const on = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: admin.auth, payload: { trustPagesEnabled: true } });
    expect(on.statusCode, on.body).toBe(200);
    const [p] = await db
      .insert(trustPublications)
      .values({
        kind: "control",
        publicSlug: `xm-item-${RUN}`,
        sourceRef: `control:xm-${RUN}`,
        title: `XM control ${RUN}`,
        content: { summary: "What the control is." },
        status: "published",
        audience: "auditors",
        publishedAt: new Date(),
      } as never)
      .returning({ id: trustPublications.id });
    publicationIds.push(p!.id);
    const g = await app.inject({
      method: "POST",
      url: "/v1/trust/auditor-grants",
      headers: admin.auth,
      payload: { auditorName: `XM Auditor ${RUN}`, auditorEmail: `xm-auditor-${RUN}@example.com`, auditorOrganisation: "Example Audit LLP", days: 14, publicationIds: [p!.id] },
    });
    expect(g.statusCode, g.body).toBe(201);
    grantId = g.json().grant.id;
    grantIds.push(grantId);
    firstLink = String(g.json().link.path).split("#")[1]!;
  });

  it("without a data key the link is refused before it is spent (fail closed)", async () => {
    const r = await redeem(firstLink, noKey);
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe("mfa_unavailable");
  });

  it("first use enrols and a code opens the session; NEGATIVE: a wrong code, the reused link, a replayed code", async () => {
    const r = await redeem(firstLink);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().mfa).toBe("enrol");
    secret = r.json().secret;
    const c = cookieNamed(r, EXTERNAL_MFA_COOKIE)!;
    expect(c).toMatch(/Path=\/v1\/auditor\/session\/mfa/);
    expect(c).toMatch(/HttpOnly/);
    expect(cookieNamed(r, "regulait_auditor")).toBeUndefined();

    const wrong = await verify(challengeOf(r), wrongCode(secret));
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toBe("mfa_code_invalid");
    expect((await lastAudit("auditor-mfa-code-rejected", grantId))?.effect).toBe("deny");

    const ok = await verify(challengeOf(r), codeNow(secret));
    expect(ok.statusCode, ok.body).toBe(201);
    const session = setCookies(ok).find((x) => !x.startsWith(`${EXTERNAL_MFA_COOKIE}=`))!;
    const portal = await app.inject({ method: "GET", url: "/v1/auditor/session", headers: { cookie: pair(session) } });
    expect(portal.statusCode, portal.body).toBe(200);
    expect(portal.json().items).toHaveLength(1);

    const reused = await redeem(firstLink);
    expect(reused.statusCode).toBe(401);
    expect(reused.json().error).toBe("link_not_valid");

    const next = await redeem(await newLink());
    expect(next.json()).toMatchObject({ mfa: "verify" });
    expect(next.json().secret).toBeUndefined();
    const [f] = await db.select().from(externalMfaFactors).where(eq(externalMfaFactors.auditorGrantId, grantId));
    const replay = await verify(challengeOf(next), totpCode(secret, f!.lastUsedStep!));
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe("mfa_code_invalid");
  });

  it("lockout, then the admin reset (step-up, audited) is the only way back; the next link enrols again", async () => {
    const r = await redeem(await newLink());
    const ch = challengeOf(r);
    // failures are consecutive across challenges: the replay above already counted one, so the lock comes sooner
    const [before] = await db.select().from(externalMfaFactors).where(eq(externalMfaFactors.auditorGrantId, grantId));
    expect(before!.failedAttempts).toBe(1);
    let last: Res | undefined;
    for (let i = 1; i < EXTERNAL_MFA_LIMITS.failuresBeforeLock; i++) last = await verify(ch, wrongCode(secret));
    expect(last!.statusCode).toBe(423);
    expect((await lastAudit("auditor-mfa-lockout", grantId))?.effect).toBe("deny");
    const locked = await redeem(await newLink());
    expect(locked.statusCode).toBe(423);
    expect((await app.inject({ method: "GET", url: `/v1/trust/auditor-grants/${grantId}/mfa`, headers: admin.auth })).json().state).toBe("locked");

    await restoreStepUp!();
    try {
      const refused = await app.inject({ method: "POST", url: `/v1/trust/auditor-grants/${grantId}/mfa/reset`, headers: admin.auth, payload: { reason: "new phone" } });
      expect(refused.statusCode).toBe(403);
    } finally {
      restoreStepUp = await relaxStepUpForTest(db);
    }
    const reset = await app.inject({ method: "POST", url: `/v1/trust/auditor-grants/${grantId}/mfa/reset`, headers: admin.auth, payload: { reason: "new phone" } });
    expect(reset.statusCode, reset.body).toBe(200);
    expect((await lastAudit("auditor-mfa-reset", grantId))?.detail).toMatchObject({ wasLocked: true });
    const again = await redeem(await newLink());
    expect(again.json().mfa).toBe("enrol");
  });

  it("relaxing the requirement rides PUT /v1/org/settings: step-up, audited as a relaxation; relaxed, the link alone opens a session", async () => {
    await restoreStepUp!();
    try {
      const refused = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: admin.auth, payload: { trustAuditorMfaRequired: false } });
      expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    } finally {
      restoreStepUp = await relaxStepUpForTest(db);
    }
    const off = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: admin.auth, payload: { trustAuditorMfaRequired: false } });
    expect(off.statusCode, off.body).toBe(200);
    const [row] = (await db.execute(sql`SELECT trust_auditor_mfa_required AS t FROM org_settings`)).rows as Array<{ t: boolean }>;
    expect(row!.t).toBe(false);
    const r = await redeem(await newLink());
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().mfa).toBeUndefined();
    const on = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: admin.auth, payload: { trustAuditorMfaRequired: true } });
    expect(on.statusCode, on.body).toBe(200);
  });
});
