/**
 * B4S-01 (ADR-0186 A / ADR-0180) — the agent stewardship PATCH was a second
 * door to the accountable owner: POST /v1/agents/:id/owner asks for an
 * `owner_change` step-up, PATCH /v1/agents/:id/stewardship {stewardUserId}
 * did not. And lifting a suspension (through that PATCH or POST
 * /v1/agents/:id/lifecycle) is a relaxation with no step-up.
 *
 * Proven here: a steward change through the PATCH is refused 403
 * `step_up_required` bound to `{objectType: "agent", objectId, ownerUserId}`
 * (the same facts as the owner route), from an API key with no methods and
 * from a session without a grant, and admitted with a grant for exactly that
 * owner (a grant for another owner is refused); moving a suspended agent to
 * any status that dispatches again needs `settings_relax` bound to `{agentId,
 * values: {lifecycleStatus}}` through both routes, while suspending, retiring
 * from suspended and other tightening moves need nothing; a write that needs
 * both step-ups names one at a time and spends neither grant on the other's
 * refusal.
 *
 * Runs on its OWN scratch database (prefix `b4s1_`), dropped in afterAll (M-068).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { agents, authSessions, createDb, eq, ORG_SETTINGS_ID, runMigrations, sql, type Db } from "@regulait/db";
import { STEP_UP_HEADER } from "@regulait/shared";
import { buildApp } from "./app.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";
import { drainBackgroundWork } from "./background-work.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `b4s1_st_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const RUN = randomBytes(3).toString("hex");
const BOOT = `b4s1-st-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;

let adminDb: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;
type Person = { id: string; key: { authorization: string }; token: string; auth: SoftAuthenticator };
let admin: Person;
let steward: Person;
const U = {} as Record<"x" | "y" | "z", string>;

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const as = (p: Person, method: Method, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...CSRF, ...headers }, cookies: { regulait_session: p.token }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const viaKey = (p: Person, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: p.key, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function grantFor(p: Person, action: { kind: string; body: Record<string, unknown> }): Promise<string> {
  const o = await as(p, "POST", "/v1/auth/step-up/options", { action });
  expect(o.statusCode, o.body).toBe(200);
  const v = await as(p, "POST", "/v1/auth/step-up/verify", {
    stepUpId: o.json().stepUpId,
    method: "passkey",
    response: p.auth.authenticate(o.json().passkey.options),
  });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().stepUpToken as string;
}

async function mkUser(label: string, isAdmin = false): Promise<string> {
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `b4s1-${label}-${RUN}@example.com`, displayName: `b4s1 ${label}`, isAdmin } });
  expect(u.statusCode, u.body).toBe(201);
  return u.json().id as string;
}

/** a person signed in to a browser session with an enrolled passkey (and an API key, which can never step up) */
async function mkPerson(label: string, isAdmin: boolean): Promise<Person> {
  const id = await mkUser(label, isAdmin);
  const key = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "b4s1" } });
  expect(key.statusCode, key.body).toBe(201);
  const token = "rgls_" + randomBytes(32).toString("hex");
  await db.insert(authSessions).values({
    tokenHash: createHash("sha256").update(token).digest("hex"),
    userId: id,
    origin: "password",
    expiresAt: new Date(Date.now() + 3_600_000),
    idleExpiresAt: new Date(Date.now() + 3_600_000),
    idleMinutes: 60,
  });
  const p: Person = { id, key: { authorization: `Bearer ${key.json().token}` }, token, auth: new SoftAuthenticator({ origin: ORIGIN }) };
  const opt = await as(p, "POST", "/v1/auth/passkeys/registration-options", {});
  expect(opt.statusCode, opt.body).toBe(200);
  const reg = await as(p, "POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: p.auth.register(opt.json().options), label: "b4s1" });
  expect(reg.statusCode, reg.body).toBe(201);
  return p;
}

async function mkAgent(name: string): Promise<string> {
  const r = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name: `${name}-${RUN}`, provider: "mock", tier: 1, model: "mock-balanced", costPerMTokIn: 1, costPerMTokOut: 2 },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}
const agentRow = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
const suspend = async (id: string) => {
  // tightening: no step-up asked
  const r = await as(admin, "POST", `/v1/agents/${id}/lifecycle`, { status: "suspended", reason: "b4s1 incident" });
  expect(r.statusCode, r.body).toBe(200);
};

/** refused from an API key (no methods) and from a session without a grant, with exactly `action`; admitted with a grant for it */
async function provesStepUp(p: Person, method: Method, url: string, payload: unknown, action: { kind: string; body: Record<string, unknown> }) {
  const key = await viaKey(p, method, url, payload);
  expect(key.statusCode, key.body).toBe(403);
  expect(key.json()).toMatchObject({ error: "step_up_required", methods: [] });
  const refused = await as(p, method, url, payload);
  expect(refused.statusCode, refused.body).toBe(403);
  expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: action.kind });
  expect(refused.json().action).toEqual(action);
  const token = await grantFor(p, refused.json().action);
  const ok = await as(p, method, url, payload, { [STEP_UP_HEADER]: token });
  expect(ok.statusCode, ok.body).toBe(200);
  return ok;
}

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  adminDb = createDb(DATABASE_URL);
  await adminDb.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await adminDb.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(urlFor(SCRATCH_DB));
  await runMigrations(db, migrationsFolder);
  await relaxIdentityForTest(db, { mfaRequired: "off" });
  await db.execute(sql`UPDATE org_settings SET step_up_mode = 'required',
    step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change"]'::jsonb
    WHERE id = ${ORG_SETTINGS_ID}`);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  admin = await mkPerson("admin", true);
  steward = await mkPerson("steward", false);
  for (const k of ["x", "y", "z"] as const) U[k] = await mkUser(k);
}, 120_000);

afterAll(async () => {
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  await closeAll([
    async () => drainBackgroundWork(db),
    async () => app?.server.closeAllConnections(),
    async () => app?.close(),
    async () => db?.$client.end(),
    async () => dropScratchDatabase(adminDb, SCRATCH_DB),
    async () => adminDb?.$client.end(),
  ]);
});

describe("B4S-01: a steward change through the stewardship PATCH needs owner_change", () => {
  it("an admin naming a steward is refused without a grant for exactly that owner, and admitted with one", async () => {
    const id = await mkAgent("b4s1-owner");
    const url = `/v1/agents/${id}/stewardship`;
    // a grant for ANOTHER owner of the same agent is not good for this one
    const other = await grantFor(admin, { kind: "owner_change", body: { objectType: "agent", objectId: id, ownerUserId: U.y } });
    const wrong = await as(admin, "PATCH", url, { stewardUserId: U.x }, { [STEP_UP_HEADER]: other });
    expect(wrong.statusCode, wrong.body).toBe(403);
    expect(wrong.json()).toMatchObject({ error: "step_up_required", presentedGrant: "not_valid_for_this_action" });
    expect((await agentRow(id)).ownerUserId).toBeNull();
    await provesStepUp(admin, "PATCH", url, { stewardUserId: U.x }, {
      kind: "owner_change",
      body: { objectType: "agent", objectId: id, ownerUserId: U.x },
    });
    expect((await agentRow(id)).ownerUserId).toBe(U.x);
    // the successor and the review date are not an owner change: nothing asked
    const succ = await as(admin, "PATCH", url, { successorUserId: U.y, nextReviewAt: new Date(Date.now() + 30 * 86_400_000).toISOString() });
    expect(succ.statusCode, succ.body).toBe(200);
    // clearing the steward is an owner change too
    await provesStepUp(admin, "PATCH", url, { stewardUserId: null }, {
      kind: "owner_change",
      body: { objectType: "agent", objectId: id, ownerUserId: null },
    });
    expect((await agentRow(id)).ownerUserId).toBeNull();
  });

  it("a non-admin steward handing the agent over must step up too", async () => {
    const id = await mkAgent("b4s1-handover");
    const set = await app.inject({ method: "PATCH", url: `/v1/agents/${id}/stewardship`, headers: AUTH, payload: { stewardUserId: steward.id } });
    expect(set.statusCode, set.body).toBe(200); // the deploy-time bootstrap credential is the root of the deployment
    await provesStepUp(steward, "PATCH", `/v1/agents/${id}/stewardship`, { stewardUserId: U.z }, {
      kind: "owner_change",
      body: { objectType: "agent", objectId: id, ownerUserId: U.z },
    });
    expect((await agentRow(id)).ownerUserId).toBe(U.z);
  });
});

describe("B4S-01: lifting a suspension needs settings_relax, through both routes", () => {
  it("POST /v1/agents/:id/lifecycle: suspended → active and suspended → under_review need it; suspended → retired does not", async () => {
    const id = await mkAgent("b4s1-life");
    await suspend(id);
    await provesStepUp(admin, "POST", `/v1/agents/${id}/lifecycle`, { status: "active" }, {
      kind: "settings_relax",
      body: { agentId: id, values: { lifecycleStatus: "active" } },
    });
    expect((await agentRow(id)).lifecycleStatus).toBe("active");
    await suspend(id);
    await provesStepUp(admin, "POST", `/v1/agents/${id}/lifecycle`, { status: "under_review", reason: "b4s1 back to review" }, {
      kind: "settings_relax",
      body: { agentId: id, values: { lifecycleStatus: "under_review" } },
    });
    await suspend(id);
    const retire = await as(admin, "POST", `/v1/agents/${id}/lifecycle`, { status: "retired", reason: "b4s1 decommissioned" });
    expect(retire.statusCode, retire.body).toBe(200);
  });

  it("PATCH /v1/agents/:id/stewardship: lifting a suspension needs it; suspending does not", async () => {
    const id = await mkAgent("b4s1-patch-life");
    const tighten = await as(admin, "PATCH", `/v1/agents/${id}/stewardship`, { lifecycleStatus: "suspended", lifecycleReason: "b4s1 hold" });
    expect(tighten.statusCode, tighten.body).toBe(200);
    await provesStepUp(admin, "PATCH", `/v1/agents/${id}/stewardship`, { lifecycleStatus: "active" }, {
      kind: "settings_relax",
      body: { agentId: id, values: { lifecycleStatus: "active" } },
    });
    expect((await agentRow(id)).lifecycleStatus).toBe("active");
  });

  it("a write that changes the steward AND lifts a suspension needs both grants, and burns neither on the other's refusal", async () => {
    const id = await mkAgent("b4s1-both");
    await suspend(id);
    const url = `/v1/agents/${id}/stewardship`;
    const body = { stewardUserId: U.x, lifecycleStatus: "active" };
    const first = await as(admin, "PATCH", url, body);
    expect(first.statusCode, first.body).toBe(403);
    expect(first.json().action).toEqual({ kind: "owner_change", body: { objectType: "agent", objectId: id, ownerUserId: U.x } });
    const owner = await grantFor(admin, first.json().action);
    const second = await as(admin, "PATCH", url, body, { [STEP_UP_HEADER]: owner });
    expect(second.statusCode, second.body).toBe(403);
    expect(second.json().action).toEqual({ kind: "settings_relax", body: { agentId: id, values: { lifecycleStatus: "active" } } });
    const relax = await grantFor(admin, second.json().action);
    const ok = await as(admin, "PATCH", url, body, { [STEP_UP_HEADER]: `${owner}, ${relax}` });
    expect(ok.statusCode, ok.body).toBe(200);
    const row = await agentRow(id);
    expect([row.ownerUserId, row.lifecycleStatus]).toEqual([U.x, "active"]);
  });
});
