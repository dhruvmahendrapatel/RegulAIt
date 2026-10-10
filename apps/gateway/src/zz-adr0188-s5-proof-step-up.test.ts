/**
 * ADR-0188 S5, Codex X45 I7S5-02 — the step-up a person gives for a delegation
 * proof binds the WHOLE authority the proof will carry: scope, environment,
 * the resolved cap and lifetime, the further depth and the agent's key. A
 * grant made for a narrow delegation is refused for a wider one, and the
 * ceremony (the 403's `action` posted verbatim to /options) admits exactly
 * the request it was made for.
 *
 * Real browser session, real passkey ceremony (soft authenticator), real app,
 * under the strict step-up policy. Global state (M-068): the step-up policy,
 * the identity posture, strict admission and the active issuer key are put
 * back in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeJwt } from "jose";
import { authSessions, createDb, eq, identitySigningKeys, orgSettings, ORG_SETTINGS_ID, runMigrations, sql, type Db } from "@regulait/db";
import { IDENTITY_SIGNING_KEY_ENV, STEP_UP_HEADER } from "@regulait/shared";
import { buildApp } from "./app.js";
import { configuredIdentitySigningKeys, rotateIdentitySigningKey } from "./identity-signing-keys.js";
import { deploymentEnvironment } from "./oauth/common.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `s5su-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;
process.env.REGULAIT_PUBLIC_URL = ORIGIN;
const ENV = deploymentEnvironment();

let db: Db;
let app: ReturnType<typeof buildApp>;
let keyDir: string;
const restores: Array<() => Promise<void>> = [];
let person: { id: string; token: string; auth: SoftAuthenticator };
let agentIdentityId: string;
let serverId: string;
let projectId: string;
const TOOLS = { a: `s5su_a_${RUN}`, b: `s5su_b_${RUN}` };
const rows = <R>(r: unknown) => (r as { rows: R[] }).rows;

const asPerson = (payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/v1/delegations/proofs", headers: { ...CSRF, ...headers }, cookies: { regulait_session: person.token }, payload: payload as object });

async function grantFor(action: { kind: string; body: Record<string, unknown> }): Promise<string> {
  const o = await app.inject({ method: "POST", url: "/v1/auth/step-up/options", headers: CSRF, cookies: { regulait_session: person.token }, payload: { action } });
  expect(o.statusCode, o.body).toBe(200);
  const v = await app.inject({
    method: "POST",
    url: "/v1/auth/step-up/verify",
    headers: CSRF,
    cookies: { regulait_session: person.token },
    payload: { stepUpId: o.json().stepUpId, method: "passkey", response: person.auth.authenticate(o.json().passkey.options) },
  });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().stepUpToken as string;
}

/** a narrow write delegation on the classified project (so it needs the identity_manage step-up) */
const narrow = () => ({
  agentIdentityId,
  authorizationDetails: [{ type: "mcp_tool", serverId, toolNames: [TOOLS.a], kind: "write" }],
  resource: `${ORIGIN}/mcp/${serverId}`,
  projectId,
  env: ENV,
  capMicros: 1000,
  maxDepth: 0,
  lifetimeSeconds: 600,
});

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxStrictAdmissionForTest(db));
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [before] = await db.select({ mode: orgSettings.stepUpMode, actions: orgSettings.stepUpActions }).from(orgSettings);
  await db.execute(sql`UPDATE org_settings SET step_up_mode = 'required',
    step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage"]'::jsonb
    WHERE id = ${ORG_SETTINGS_ID}`);
  restores.push(async () => {
    await db.update(orgSettings).set({ stepUpMode: before!.mode, stepUpActions: before!.actions }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "s5su-synthetic-data-key-".padEnd(64, "q") });

  keyDir = mkdtempSync(path.join(os.tmpdir(), "s5su-issuer-"));
  writeFileSync(path.join(keyDir, "issuer.pem"), generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString(), { mode: 0o600 });
  process.env[IDENTITY_SIGNING_KEY_ENV] = path.join(keyDir, "issuer.pem");
  const k0 = (await configuredIdentitySigningKeys())[0]!;
  const recorded = await db.select({ kid: identitySigningKeys.kid }).from(identitySigningKeys);
  const [active] = await db.select().from(identitySigningKeys).where(sql`activated_at is not null and retired_at is null and revoked_at is null`);
  if (recorded.length > 0 && active?.kid !== k0.kid) await rotateIdentitySigningKey(db, { kid: k0.kid, actorUserId: "00000000-0000-0000-0000-000000000000" });

  // the person: a browser session with an enrolled passkey
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `s5su-${RUN}@example.com`, displayName: `s5su ${RUN}` } });
  expect(u.statusCode, u.body).toBe(201);
  const token = "rgls_" + randomBytes(32).toString("hex");
  await db.insert(authSessions).values({
    tokenHash: createHash("sha256").update(token).digest("hex"),
    userId: u.json().id,
    origin: "password",
    expiresAt: new Date(Date.now() + 3_600_000),
    idleExpiresAt: new Date(Date.now() + 3_600_000),
    idleMinutes: 60,
  });
  person = { id: u.json().id, token, auth: new SoftAuthenticator({ origin: ORIGIN }) };
  const opt = await app.inject({ method: "POST", url: "/v1/auth/passkeys/registration-options", headers: CSRF, cookies: { regulait_session: token }, payload: {} });
  expect(opt.statusCode, opt.body).toBe(200);
  const reg = await app.inject({
    method: "POST",
    url: "/v1/auth/passkeys",
    headers: CSRF,
    cookies: { regulait_session: token },
    payload: { challengeId: opt.json().challengeId, response: person.auth.register(opt.json().options), label: "s5su" },
  });
  expect(reg.statusCode, reg.body).toBe(201);

  const s = await app.inject({ method: "POST", url: "/v1/servers", headers: AUTH, payload: { name: `s5su-server-${RUN}`, url: "http://127.0.0.1:9" } });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  for (const name of [TOOLS.a, TOOLS.b]) expect((await app.inject({ method: "POST", url: `/v1/servers/${serverId}/tools`, headers: AUTH, payload: { name, kind: "write" } })).statusCode).toBe(201);
  const agent = rows<{ id: string }>(await db.execute(sql`insert into agents (name, provider, tier) values (${`s5su-agent-${RUN}`}, 'mock', 1) returning id`))[0]!.id;
  agentIdentityId = rows<{ id: string }>(
    await db.execute(sql`insert into workload_identities (kind, agent_id, identifier, sponsor_user_ids, environments)
      values ('agent', ${agent}, ${`spiffe://s5su.example.org/regulait/a-${RUN}`}, ARRAY[${person.id}]::uuid[], ARRAY[${ENV}]) returning id`),
  )[0]!.id;
  // a CLASSIFIED project the person is an explicit member of: a write delegation on it needs the step-up
  projectId = rows<{ id: string }>(await db.execute(sql`insert into projects (name, classifications) values (${`s5su-proj-${RUN}`}, '["pii"]'::jsonb) returning id`))[0]!.id;
  await db.execute(sql`insert into project_members (project_id, user_id, role) values (${projectId}, ${person.id}, 'contributor')`);
}, 120_000);

afterAll(async () => {
  await db.execute(sql`update identity_signing_keys set retired_at = now() where activated_at is not null and retired_at is null and revoked_at is null`);
  for (const r of restores.reverse()) await r();
  await app?.close();
  rmSync(keyDir, { recursive: true, force: true });
  delete process.env[IDENTITY_SIGNING_KEY_ENV];
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
});

describe("X45 I7S5-02 — the delegation step-up binds the whole authority", () => {
  it("ceremony to route: the 403 hands back the full resolved facts; a grant for exactly them admits exactly that proof", async () => {
    const req = { ...narrow(), lifetimeSeconds: undefined, capMicros: 2500 };
    const refused = await asPerson(req);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "identity_manage" });
    // the resolved values, not the request's: the default lifetime (900 s) and the cap
    expect(refused.json().action.body).toMatchObject({
      op: "delegation_proof",
      agentIdentityId,
      projectId,
      env: ENV,
      authorizationDetails: req.authorizationDetails,
      capMicros: 2500,
      maxDepth: 0,
      lifetimeSeconds: 900,
      agentKeyThumbprint: null,
    });
    const token = await grantFor(refused.json().action);
    const ok = await asPerson(req, { [STEP_UP_HEADER]: token });
    expect(ok.statusCode, ok.body).toBe(201);
    const d = JSON.parse(decodeJwt(ok.json().proof).delegation as string);
    expect(d).toMatchObject({ cap_micros: 2500, max_depth: 0 });
  });

  it("a grant made for a narrow delegation is refused for a wider scope, a higher cap, a deeper chain, a longer life or another key", async () => {
    const refused = await asPerson(narrow());
    expect(refused.statusCode, refused.body).toBe(403);
    const token = await grantFor(refused.json().action);
    const wider: Array<[string, Record<string, unknown>]> = [
      ["scope", { authorizationDetails: [{ type: "mcp_tool", serverId, toolNames: [TOOLS.a, TOOLS.b], kind: "write" }] }],
      ["cap", { capMicros: 1_000_000 }],
      ["depth", { maxDepth: 2 }],
      ["lifetime", { lifetimeSeconds: 900 }],
      ["key", { agentKeyThumbprint: "A".repeat(43) }],
    ];
    for (const [label, change] of wider) {
      const r = await asPerson({ ...narrow(), ...change }, { [STEP_UP_HEADER]: token });
      expect(r.statusCode, `${label}: ${r.body}`).toBe(403);
      expect(r.json().error, label).toBe("step_up_required");
    }
    // the grant was not spent by any of those: the request it was made for still passes with it
    const ok = await asPerson(narrow(), { [STEP_UP_HEADER]: token });
    expect(ok.statusCode, ok.body).toBe(201);
  });
});
