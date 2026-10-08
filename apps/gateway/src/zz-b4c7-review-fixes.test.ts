/**
 * Batch 4 (ADR-0186) — automated-review fixes on PR #198, round 7, proven red
 * on the pre-fix head (1826b6c) and green after:
 *
 *  F39  the stored-value rule (decision 26) reaches the former EXEMPTIONS:
 *       leaving a stricter stored posture (sso-only, an IP envelope, a PII
 *       category, a retention override, the env-fallback provider list, the
 *       tracing preview length) needs settings_relax.
 *  F40  the queue's approvals count is the live principal count the decide
 *       path uses (`approvingPrincipals`), not raw distinct approver ids.
 *
 * Runs on its OWN scratch database (prefix `b4c7_`), dropped in afterAll, so
 * nothing append-only outlives the run (M-068).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import {
  approvalDecisions,
  approvalDelegations,
  approvals,
  authSessions,
  createDb,
  eq,
  ORG_SETTINGS_ID,
  orgSettings,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { INTERNATIONAL_PII_CATEGORIES, STEP_UP_HEADER } from "@regulait/shared";
import { buildApp } from "./app.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";
import { drainBackgroundWork } from "./background-work.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `b4c7_rv_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const RUN = randomBytes(3).toString("hex");
const BOOT = `b4c7-rv-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const DATA_KEY = "a".repeat(64);
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;

let admin: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;

type Session = { token: string; sessionId: string };
type Person = { id: string; s: Session; auth: SoftAuthenticator };
let adm: Person;

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const as = (s: Session, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...CSRF, ...headers }, cookies: { regulait_session: s.token }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const withKey = (key: { authorization: string }, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: key, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function mkSession(userId: string): Promise<Session> {
  const token = "rgls_" + randomBytes(32).toString("hex");
  const [row] = await db
    .insert(authSessions)
    .values({
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId,
      origin: "password",
      expiresAt: new Date(Date.now() + 3_600_000),
      idleExpiresAt: new Date(Date.now() + 3_600_000),
      idleMinutes: 60,
    })
    .returning({ id: authSessions.id });
  return { token, sessionId: row!.id };
}

async function mkUser(label: string, isAdmin = false): Promise<{ id: string; s: Session }> {
  const u = await withKey(AUTH, "POST", "/v1/users", { email: `b4c7-${label}-${randomBytes(2).toString("hex")}-${RUN}@example.com`, displayName: `b4c7 ${label}`, isAdmin });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  return { id, s: await mkSession(id) };
}

async function mkPerson(label: string, isAdmin = false): Promise<Person> {
  const u = await mkUser(label, isAdmin);
  const opt = await as(u.s, "POST", "/v1/auth/passkeys/registration-options", {});
  expect(opt.statusCode, opt.body).toBe(200);
  const auth = new SoftAuthenticator({ origin: ORIGIN });
  const reg = await as(u.s, "POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: auth.register(opt.json().options), label: "b4c7" });
  expect(reg.statusCode, reg.body).toBe(201);
  return { ...u, auth };
}

async function grantFor(p: Person, action: { kind: string; body: Record<string, unknown> }): Promise<string> {
  const o = await as(p.s, "POST", "/v1/auth/step-up/options", { action });
  expect(o.statusCode, o.body).toBe(200);
  const v = await as(p.s, "POST", "/v1/auth/step-up/verify", { stepUpId: o.json().stepUpId, method: "passkey", response: p.auth.authenticate(o.json().passkey.options) });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().stepUpToken as string;
}

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(urlFor(SCRATCH_DB));
  await runMigrations(db, migrationsFolder);
  await relaxIdentityForTest(db, { mfaRequired: "off" });
  await relaxStrictAdmissionForTest(db);
  await relaxGovernanceGatesForTest(db, { requirePreviewBeforeActivate: false });
  await db.execute(sql`UPDATE org_settings SET step_up_mode = 'required', approval_delegation_enabled = true,
    step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change"]'::jsonb
    WHERE id = ${ORG_SETTINGS_ID}`);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.listen({ port: 0, host: "127.0.0.1" });
  adm = await mkPerson("admin", true);
}, 180_000);

afterAll(async () => {
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  await closeAll([
    async () => drainBackgroundWork(db),
    async () => app?.server.closeAllConnections(),
    async () => app?.close(),
    async () => db?.$client.end(),
    async () => dropScratchDatabase(admin, SCRATCH_DB),
    async () => admin?.$client.end(),
  ]);
});

/** the stored (tightened) posture, written directly, then the write that leaves it: refused without a grant, admitted with one */
async function leavingStoredNeedsRelax(stored: Partial<typeof orgSettings.$inferInsert>, payload: Record<string, unknown>) {
  await db.update(orgSettings).set(stored).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  const refused = await as(adm.s, "PUT", "/v1/org/settings", payload);
  expect(refused.statusCode, refused.body).toBe(403);
  expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
  const ok = await as(adm.s, "PUT", "/v1/org/settings", payload, { [STEP_UP_HEADER]: await grantFor(adm, refused.json().action) });
  expect(ok.statusCode, ok.body).toBe(200);
}
async function tightens(stored: Partial<typeof orgSettings.$inferInsert>, payload: Record<string, unknown>) {
  await db.update(orgSettings).set(stored).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  const r = await as(adm.s, "PUT", "/v1/org/settings", payload);
  expect(r.statusCode, r.body).toBe(200);
}

describe("F39: leaving a stored posture stricter than the default is a relaxation, for every former exemption", () => {
  it("sso-only turned off", async () => {
    await leavingStoredNeedsRelax({ ssoOnly: true }, { ssoOnly: false });
  });
  it("the API-key IP policy turned down", async () => {
    await leavingStoredNeedsRelax({ apiKeyIpPolicy: "enforce_continuous" }, { apiKeyIpPolicy: "enforce_at_login" });
  });
  it("the session IP allowlist widened or emptied; narrowing asks for nothing", async () => {
    await leavingStoredNeedsRelax({ sessionIpAllowlist: ["10.0.0.0/24"] }, { sessionIpAllowlist: ["10.0.0.0/16"] });
    await leavingStoredNeedsRelax({ sessionIpAllowlist: ["10.0.0.0/24"] }, { sessionIpAllowlist: null });
    await tightens({ sessionIpAllowlist: ["10.0.0.0/24", "10.1.0.0/24"] }, { sessionIpAllowlist: ["10.0.0.0/24"] });
  });
  it("an international PII category the org turned on, removed", async () => {
    await leavingStoredNeedsRelax({ piiInternationalCategories: [INTERNATIONAL_PII_CATEGORIES[0]] }, { piiInternationalCategories: [] });
  });
  it("a per-mode retention override removed", async () => {
    await leavingStoredNeedsRelax({ modeAuditRetention: { hosted: 400 } }, { modeAuditRetention: {} });
  });
  it("an env-fallback provider the org removed, added back", async () => {
    await leavingStoredNeedsRelax({ envFallbackProviders: ["anthropic"] }, { envFallbackProviders: ["anthropic", "openai"] });
  });
  it("the tracing preview lengthened", async () => {
    await leavingStoredNeedsRelax({ tracingPreviewMaxChars: 1000 }, { tracingPreviewMaxChars: 4000 });
  });
});

describe("F40: the queue counts approving principals as the decide path does", () => {
  it("three approvers who became delegation-linked count as two", async () => {
    const caller = await mkUser("f40-caller");
    const [a, b, c] = [await mkUser("f40-a"), await mkUser("f40-b"), await mkUser("f40-c")];
    const [ap] = await db
      .insert(approvals)
      .values({ objectType: "mcp_tool", userId: caller.id, approverUserId: a.id, status: "pending", quorum: 3, requestPayload: {} } as never)
      .returning({ id: approvals.id });
    for (const u of [a, b, c]) {
      await db.insert(approvalDecisions).values({ approvalId: ap!.id, deciderUserId: u.id, principalUserId: u.id, decision: "approved", stepUpMethod: "none" });
    }
    // after deciding, a delegates to b: they are one principal now (as `approvingPrincipals` counts)
    await db.insert(approvalDelegations).values({
      fromUserId: a.id,
      toUserId: b.id,
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 3_600_000),
      reason: "b4c7",
    });
    const list = await withKey(AUTH, "GET", "/v1/approvals?status=pending");
    expect(list.statusCode, list.body).toBe(200);
    const row = (list.json().approvals as Array<{ id: string; approvalsCount?: number }>).find((r) => r.id === ap!.id);
    expect(row, "the approval is listed").toBeTruthy();
    expect(row!.approvalsCount).toBe(2);
  });
});
