/**
 * ADR-0180 / ADR-0186 A — an approval-rule write that LOOSENS dual control
 * needs a `settings_relax` step-up: lowering the quorum, widening the eligible
 * pool (a role added, the named approver moved to someone outside the pool),
 * deleting the rule, and activating (or rolling back to) a version with a
 * lower quorum — including an edit of a versioned rule, which mints and
 * activates. Each is refused 403 `step_up_required` without a grant (an API
 * key never can give one), bound to `{ruleId, values}`, and admitted with a
 * grant for exactly that. Raising the quorum or narrowing the pool needs none.
 *
 * Runs on its OWN scratch database (prefix `b4q_`), dropped in afterAll, so
 * the version ledger and audit rows it writes leave nothing behind (M-068).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { approvalRules, authSessions, createDb, eq, mcpServers, ORG_SETTINGS_ID, roleAssignments, roles, runMigrations, sql, type Db } from "@regulait/db";
import { STEP_UP_HEADER } from "@regulait/shared";
import { buildApp } from "./app.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";
import { drainBackgroundWork } from "./background-work.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `b4q_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const RUN = randomBytes(3).toString("hex");
const BOOT = `b4q-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;

let adminDb: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;
let serverId: string;
let roleId: string;
const U = {} as Record<"caller" | "a" | "b" | "d" | "e", string>;
let admin: { id: string; key: { authorization: string }; token: string; auth: SoftAuthenticator };

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const asAdmin = (method: Method, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...CSRF, ...headers }, cookies: { regulait_session: admin.token }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const viaKey = (method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: admin.key, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function grantFor(action: { kind: string; body: Record<string, unknown> }): Promise<string> {
  const o = await asAdmin("POST", "/v1/auth/step-up/options", { action });
  expect(o.statusCode, o.body).toBe(200);
  const v = await asAdmin("POST", "/v1/auth/step-up/verify", {
    stepUpId: o.json().stepUpId,
    method: "passkey",
    response: admin.auth.authenticate(o.json().passkey.options),
  });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().stepUpToken as string;
}

/** refused from an API key and from a session without a grant, bound to `values`; admitted with a grant for exactly it */
async function provesStepUp(method: Method, url: string, payload: unknown, ruleId: string, values: Record<string, unknown>) {
  const action = { kind: "settings_relax", body: { ruleId, values } };
  const key = await viaKey(method, url, payload);
  expect(key.statusCode, key.body).toBe(403);
  expect(key.json()).toMatchObject({ error: "step_up_required", methods: [] });
  const refused = await asAdmin(method, url, payload);
  expect(refused.statusCode, refused.body).toBe(403);
  expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
  expect(refused.json().action).toEqual(action);
  const token = await grantFor(refused.json().action);
  const ok = await asAdmin(method, url, payload, { [STEP_UP_HEADER]: token });
  expect(ok.statusCode, ok.body).toBe(200);
  return ok;
}

/** an approval rule over the caller's calls; the pool is A plus the role's B and D (3 principals) */
async function mkRule(body: Record<string, unknown> = {}): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/v1/rules/approvals",
    headers: AUTH,
    payload: {
      scope: "user",
      serverScope: "server",
      userId: U.caller,
      serverId,
      toolName: `b4q_${RUN}_${randomBytes(3).toString("hex")}`,
      approverUserId: U.a,
      approverRoleId: roleId,
      quorum: 2,
      ...body,
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}
const quorumOf = async (id: string) => (await db.select().from(approvalRules).where(eq(approvalRules.id, id)))[0];

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
  const mkUser = async (label: string, isAdmin = false) => {
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `b4q-${label}-${RUN}@example.com`, displayName: `b4q ${label}`, isAdmin } });
    expect(u.statusCode, u.body).toBe(201);
    return u.json().id as string;
  };
  const adminId = await mkUser("admin", true);
  for (const k of ["caller", "a", "b", "d", "e"] as const) U[k] = await mkUser(k);
  const key = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "b4q" } });
  expect(key.statusCode, key.body).toBe(201);
  const token = "rgls_" + randomBytes(32).toString("hex");
  await db.insert(authSessions).values({
    tokenHash: createHash("sha256").update(token).digest("hex"),
    userId: adminId,
    origin: "password",
    expiresAt: new Date(Date.now() + 3_600_000),
    idleExpiresAt: new Date(Date.now() + 3_600_000),
    idleMinutes: 60,
  });
  admin = { id: adminId, key: { authorization: `Bearer ${key.json().token}` }, token, auth: new SoftAuthenticator({ origin: ORIGIN }) };
  const opt = await asAdmin("POST", "/v1/auth/passkeys/registration-options", {});
  expect(opt.statusCode, opt.body).toBe(200);
  const reg = await asAdmin("POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: admin.auth.register(opt.json().options), label: "b4q" });
  expect(reg.statusCode, reg.body).toBe(201);
  const [srv] = await db.insert(mcpServers).values({ name: `b4q-srv-${RUN}`, url: `https://b4q-${RUN}.example.com/mcp` }).returning({ id: mcpServers.id });
  serverId = srv!.id;
  const [role] = await db.insert(roles).values({ name: `b4q approvers ${RUN}` }).returning({ id: roles.id });
  roleId = role!.id;
  for (const u of [U.b, U.d]) await db.insert(roleAssignments).values({ userId: u, roleId });
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

describe("ADR-0180: an approval-rule write that loosens dual control needs settings_relax", () => {
  it("PATCH lowering the quorum needs it; raising it does not", async () => {
    const id = await mkRule({ quorum: 2 });
    const url = `/v1/rules/approvals/${id}`;
    const up = await viaKey("PATCH", url, { quorum: 3 });
    expect(up.statusCode, up.body).toBe(200);
    await provesStepUp("PATCH", url, { quorum: 1 }, id, { quorum: 1, approverRoleId: roleId, approverUserId: U.a });
    expect((await quorumOf(id))!.quorum).toBe(1);
  });

  it("PATCH widening the pool (a role added, the named approver moved outside it) needs it; narrowing does not", async () => {
    const id = await mkRule({ quorum: 1, approverRoleId: null });
    const url = `/v1/rules/approvals/${id}`;
    await provesStepUp("PATCH", url, { approverRoleId: roleId }, id, { quorum: 1, approverRoleId: roleId, approverUserId: U.a });
    // naming a role member as the approver narrows the pool (A, B, D → B, D): nothing asked
    const narrowed = await viaKey("PATCH", url, { approverUserId: U.b });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    const noRole = await viaKey("PATCH", url, { approverRoleId: null });
    expect(noRole.statusCode, noRole.body).toBe(200);
    // the same pool size, but someone who could not approve before now can
    await provesStepUp("PATCH", url, { approverUserId: U.e }, id, { quorum: 1, approverRoleId: null, approverUserId: U.e });
  });

  it("DELETE of an approval rule needs it (removing the rule removes the approval requirement)", async () => {
    const id = await mkRule();
    await provesStepUp("DELETE", `/v1/rules/approvals/${id}`, undefined, id, { deleted: true });
    expect(await quorumOf(id)).toBeUndefined();
  });

  it("activating, or rolling back to, a version with a lower quorum needs it (and so does an edit that mints one); a higher one does not", async () => {
    const id = await mkRule({ quorum: 2 });
    const base = `/v1/config-versions/approval_rule/${id}`;
    const values = (quorum: number) => ({ quorum, approverRoleId: roleId, approverUserId: U.a });
    // raising: minted and activated with no step-up
    const v2 = await viaKey("POST", base, { body: { quorum: 3 }, activate: true });
    expect(v2.statusCode, v2.body).toBe(201);
    const v3 = await viaKey("POST", base, { body: { quorum: 1 }, activate: false });
    expect(v3.statusCode, v3.body).toBe(201); // a draft enforces nothing
    await provesStepUp("POST", `${base}/activate`, { version: v3.json().version.version }, id, values(1));
    // back up to 3: tightening
    const up = await viaKey("POST", `${base}/activate`, { version: v2.json().version.version });
    expect(up.statusCode, up.body).toBe(200);
    // an edit of a versioned rule mints and activates: lowering the quorum that way needs it too
    const minted = await provesStepUp("PATCH", `/v1/rules/approvals/${id}`, { quorum: 2 }, id, values(2));
    expect(minted.json().versionMinted).toBeGreaterThan(v3.json().version.version);
    const tighten = await viaKey("POST", `${base}/activate`, { version: v2.json().version.version });
    expect(tighten.statusCode, tighten.body).toBe(200);
    // rollback re-activates the quorum-2 version: a loosening
    await provesStepUp("POST", `${base}/rollback`, { reason: "b4q drill" }, id, values(2));
    expect((await quorumOf(id))!.quorum).toBe(2);
  });
});
