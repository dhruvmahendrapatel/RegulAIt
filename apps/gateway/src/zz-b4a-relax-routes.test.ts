/**
 * ADR-0186 A — a relaxation never skips the `settings_relax` step-up because
 * it has its own route. Each dedicated setting route: a relaxation without a
 * grant is refused 403 `step_up_required`, bound to the setting and its new
 * value (`action.body.values`); with a grant for exactly that it is written;
 * an API key cannot do it at all; putting the strict value back (tightening)
 * needs no step-up.
 *
 * Global state is restored to the strict values in afterAll (M-068).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import {
  authSessions,
  createDb,
  eq,
  inArray,
  ORG_SETTINGS_ID,
  runMigrations,
  sql,
  stepUpGrants,
  webauthnChallenges,
  webauthnCredentials,
  type Db,
} from "@regulait/db";
import { STEP_UP_HEADER } from "@regulait/shared";
import { buildApp } from "./app.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `b4a-relax-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;

let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreIdentity: (() => Promise<void>) | undefined;
const created = { users: [] as string[], sessions: [] as string[] };
let admin: { id: string; key: { authorization: string }; session: { token: string }; auth: SoftAuthenticator };

type Method = "GET" | "PUT" | "POST";
const asAdmin = (method: Method, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...CSRF, ...headers }, cookies: { regulait_session: admin.session.token }, payload: payload as object });

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

const STRICT_SQL = sql`UPDATE org_settings SET assurance_gate_mode = 'enforce', mrm_enforced = true,
  mrm_staleness_recert_enabled = true, mrm_staleness_recert_threshold = 1, step_up_mode = 'required',
  step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change"]'::jsonb
  WHERE id = ${ORG_SETTINGS_ID}`;

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  await db.execute(STRICT_SQL);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `b4a-relax-${RUN}@example.com`, displayName: "b4a relax", isAdmin: true } });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  created.users.push(id);
  const key = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "b4a" } });
  const token = "rgls_" + randomBytes(32).toString("hex");
  const [s] = await db
    .insert(authSessions)
    .values({
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId: id,
      origin: "password",
      expiresAt: new Date(Date.now() + 3_600_000),
      idleExpiresAt: new Date(Date.now() + 3_600_000),
      idleMinutes: 60,
    })
    .returning({ id: authSessions.id });
  created.sessions.push(s!.id);
  admin = { id, key: { authorization: `Bearer ${key.json().token}` }, session: { token }, auth: new SoftAuthenticator({ origin: ORIGIN }) };
  const opt = await asAdmin("POST", "/v1/auth/passkeys/registration-options", {});
  expect(opt.statusCode, opt.body).toBe(200);
  const reg = await asAdmin("POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: admin.auth.register(opt.json().options), label: "relax" });
  expect(reg.statusCode, reg.body).toBe(201);
}, 120_000);

afterAll(async () => {
  await db.execute(STRICT_SQL);
  await db.execute(sql`UPDATE interception_settings SET require_project_attribution = true`);
  await db.execute(sql`UPDATE policy_simulation_settings SET require_preview_before_activate = true`);
  await restoreIdentity?.();
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  await db.delete(stepUpGrants).where(inArray(stepUpGrants.userId, created.users));
  await db.delete(webauthnChallenges).where(inArray(webauthnChallenges.userId, created.users));
  await db.delete(webauthnCredentials).where(inArray(webauthnCredentials.userId, created.users));
  await db.delete(authSessions).where(inArray(authSessions.id, created.sessions));
  app.server.closeAllConnections();
  await app.close();
});

/** one dedicated route: its relaxing write, the facts it binds, and the strict write that puts it back */
interface Case {
  name: string;
  method: "PUT" | "POST";
  url: string;
  relax: Record<string, unknown>;
  values: Record<string, unknown>;
  restore: Record<string, unknown>;
}
const CASES: Case[] = [
  {
    name: "PUT /v1/org/settings/assurance-gate-mode",
    method: "PUT",
    url: "/v1/org/settings/assurance-gate-mode",
    relax: { mode: "warn" },
    values: { assuranceGateMode: "warn" },
    restore: { mode: "enforce" },
  },
  {
    name: "POST /v1/mrm/enforcement",
    method: "POST",
    url: "/v1/mrm/enforcement",
    relax: { enforced: false },
    values: { mrmEnforced: false },
    restore: { enforced: true },
  },
  {
    name: "PUT /v1/interception/settings",
    method: "PUT",
    url: "/v1/interception/settings",
    relax: { requireProjectAttribution: false },
    values: { "interception.requireProjectAttribution": false },
    restore: { requireProjectAttribution: true },
  },
  {
    name: "PUT /v1/policy-simulations/settings",
    method: "PUT",
    url: "/v1/policy-simulations/settings",
    relax: { requirePreviewBeforeActivate: false },
    values: { "policySimulation.requirePreviewBeforeActivate": false },
    restore: { requirePreviewBeforeActivate: true },
  },
  {
    name: "PUT /v1/guardrails/config",
    method: "PUT",
    url: "/v1/guardrails/config",
    relax: { modes: { prompt_injection: "warn" } },
    values: { "guardrails.prompt_injection": "warn" },
    restore: { modes: { prompt_injection: "block" } },
  },
];

describe("ADR-0186 A: settings_relax on the dedicated setting routes", () => {
  for (const c of CASES) {
    it(`${c.name}: a relaxation needs a step-up bound to the setting and value; tightening does not`, async () => {
      // an API key can never relax it
      const viaKey = await app.inject({ method: c.method, url: c.url, headers: admin.key, payload: c.relax });
      expect(viaKey.statusCode, viaKey.body).toBe(403);
      expect(viaKey.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax", methods: [] });
      // a person without a grant is asked, for exactly this setting and value
      const refused = await asAdmin(c.method, c.url, c.relax);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax", methods: ["passkey"] });
      expect(refused.json().action).toEqual({ kind: "settings_relax", body: { values: c.values } });
      // a grant for some other relaxation does not do
      const other = await grantFor({ kind: "settings_relax", body: { values: { someOtherSetting: false } } });
      expect((await asAdmin(c.method, c.url, c.relax, { [STEP_UP_HEADER]: other })).statusCode).toBe(403);
      // a grant for exactly this one does
      const token = await grantFor(refused.json().action);
      const ok = await asAdmin(c.method, c.url, c.relax, { [STEP_UP_HEADER]: token });
      expect(ok.statusCode, ok.body).toBe(200);
      // putting the strict value back needs nothing
      const back = await asAdmin(c.method, c.url, c.restore);
      expect(back.statusCode, back.body).toBe(200);
    });
  }

  it("a write that relaxes nothing (the strict value, unchanged) is never asked", async () => {
    for (const c of CASES) {
      const r = await asAdmin(c.method, c.url, c.restore);
      expect(r.statusCode, `${c.name}: ${r.body}`).toBe(200);
    }
    const [row] = await db.execute(sql`SELECT count(*)::int AS n FROM step_up_grants WHERE user_id = ${admin.id} AND used_at IS NULL`).then((r) => (r as unknown as { rows: Array<{ n: number }> }).rows);
    expect(row!.n).toBe(5); // the five "other" grants were never spent
    void eq;
  });
});
