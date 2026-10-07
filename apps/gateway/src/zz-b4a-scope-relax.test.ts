/**
 * ADR-0186 A — per-scope and halt-lifting relaxations need a step-up too
 * (ADR-0180: any write that loosens a protection, org-wide or not). Each route:
 * the loosening write without a grant is refused 403 `step_up_required`, bound
 * to the target and the new value; a grant for exactly that admits it once;
 * an API key never can; the tightening direction needs nothing.
 *
 * Global state (the execution mode, overrides, rules, connections) is put back
 * in afterAll (M-068).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  agents,
  approvalRules,
  authSessions,
  chatopsConnections,
  connectors,
  createDb,
  eq,
  guardrailConfigs,
  inArray,
  mcpServers,
  mcpTools,
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
const BOOT = `b4a-scope-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;

let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreIdentity: (() => Promise<void>) | undefined;
const created = { users: [] as string[], sessions: [] as string[], agents: [] as string[], connectors: [] as string[], chatops: [] as string[], rules: [] as string[], servers: [] as string[] };
let admin: { id: string; key: { authorization: string }; token: string; auth: SoftAuthenticator };

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const asAdmin = (method: Method, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...CSRF, ...headers }, cookies: { regulait_session: admin.token }, ...(payload !== undefined ? { payload: payload as object } : {}) });

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

/** refused without a grant (and from an API key), bound to `action`; admitted with a grant for exactly it */
async function provesStepUp(method: Method, url: string, payload: unknown, action: { kind: string; body: Record<string, unknown> }) {
  const viaKey = await app.inject({ method, url, headers: admin.key, payload: payload as object });
  expect(viaKey.statusCode, viaKey.body).toBe(403);
  expect(viaKey.json()).toMatchObject({ error: "step_up_required", methods: [] });
  const refused = await asAdmin(method, url, payload);
  expect(refused.statusCode, refused.body).toBe(403);
  expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: action.kind });
  expect(refused.json().action).toEqual(action);
  const token = await grantFor(refused.json().action);
  const ok = await asAdmin(method, url, payload, { [STEP_UP_HEADER]: token });
  expect(ok.statusCode, ok.body).toBe(200);
  return ok;
}

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  await db.execute(sql`UPDATE org_settings SET step_up_mode = 'required',
    step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change"]'::jsonb
    WHERE id = ${ORG_SETTINGS_ID}`);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `b4a-scope-${RUN}@example.com`, displayName: "b4a scope", isAdmin: true } });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  created.users.push(id);
  const key = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "b4a" } });
  const token = "rgls_" + randomBytes(32).toString("hex");
  const [s] = await db
    .insert(authSessions)
    .values({ tokenHash: createHash("sha256").update(token).digest("hex"), userId: id, origin: "password", expiresAt: new Date(Date.now() + 3_600_000), idleExpiresAt: new Date(Date.now() + 3_600_000), idleMinutes: 60 })
    .returning({ id: authSessions.id });
  created.sessions.push(s!.id);
  admin = { id, key: { authorization: `Bearer ${key.json().token}` }, token, auth: new SoftAuthenticator({ origin: ORIGIN }) };
  const opt = await asAdmin("POST", "/v1/auth/passkeys/registration-options", {});
  expect(opt.statusCode, opt.body).toBe(200);
  const reg = await asAdmin("POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: admin.auth.register(opt.json().options), label: "scope" });
  expect(reg.statusCode, reg.body).toBe(201);
}, 120_000);

afterAll(async () => {
  await db.execute(sql`UPDATE org_settings SET execution_mode = 'normal', execution_mode_reason = NULL, execution_mode_approver_user_id = NULL WHERE id = ${ORG_SETTINGS_ID}`);
  await restoreIdentity?.();
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  if (created.agents.length) await db.delete(guardrailConfigs).where(inArray(guardrailConfigs.scopeId, created.agents));
  if (created.rules.length) await db.delete(approvalRules).where(inArray(approvalRules.id, created.rules));
  if (created.servers.length) await db.delete(mcpServers).where(inArray(mcpServers.id, created.servers));
  if (created.chatops.length) await db.delete(chatopsConnections).where(inArray(chatopsConnections.id, created.chatops));
  if (created.connectors.length) await db.delete(connectors).where(inArray(connectors.id, created.connectors));
  if (created.agents.length) await db.delete(agents).where(inArray(agents.id, created.agents));
  await db.delete(stepUpGrants).where(inArray(stepUpGrants.userId, created.users));
  await db.delete(webauthnChallenges).where(inArray(webauthnChallenges.userId, created.users));
  await db.delete(webauthnCredentials).where(inArray(webauthnCredentials.userId, created.users));
  await db.delete(authSessions).where(inArray(authSessions.id, created.sessions));
  app.server.closeAllConnections();
  await app.close();
});

describe("ADR-0186 A: per-scope and halt-lifting relaxations", () => {
  it("PUT /v1/execution/mode: entering a halt needs nothing; lifting it (and a lateral move) needs settings_relax", async () => {
    try {
      const halt = await asAdmin("PUT", "/v1/execution/mode", { mode: "halted", reason: "b4a incident drill" });
      expect(halt.statusCode, halt.body).toBe(200);
      await provesStepUp("PUT", "/v1/execution/mode", { mode: "read_only", reason: "b4a partial resume" }, {
        kind: "settings_relax",
        body: { values: { executionMode: "read_only" } },
      });
      await provesStepUp("PUT", "/v1/execution/mode", { mode: "require_approval", reason: "b4a lateral", approverUserId: admin.id }, {
        kind: "settings_relax",
        body: { values: { executionMode: "require_approval" } },
      });
      await provesStepUp("PUT", "/v1/execution/mode", { mode: "normal", reason: "b4a resolved" }, {
        kind: "settings_relax",
        body: { values: { executionMode: "normal" } },
      });
    } finally {
      await db.execute(sql`UPDATE org_settings SET execution_mode = 'normal' WHERE id = ${ORG_SETTINGS_ID}`);
    }
  });

  it("PUT /v1/guardrails/config/:scope/:scopeId: lowering below the org mode, or a window, needs settings_relax; raising does not", async () => {
    const [a] = await db.insert(agents).values({ name: `b4a-gr-${RUN}`, provider: "mock", tier: 1 }).returning({ id: agents.id });
    created.agents.push(a!.id);
    const url = `/v1/guardrails/config/agent/${a!.id}`;
    await provesStepUp("PUT", url, { modes: { prompt_injection: "warn" } }, {
      kind: "settings_relax",
      body: { scope: "agent", scopeId: a!.id, values: { prompt_injection: "warn" } },
    });
    // raising it back to the org mode is no relaxation
    expect((await asAdmin("PUT", url, { modes: { prompt_injection: "block" } })).statusCode).toBe(200);
    expect((await asAdmin("DELETE", url, undefined)).statusCode).toBe(200);
    // opening the time-boxed assurance window is a relaxation even with no lowered mode
    await provesStepUp("PUT", url, { modes: { prompt_injection: "block" }, assuranceWindow: { ttlMinutes: 5 } }, {
      kind: "settings_relax",
      body: { scope: "agent", scopeId: a!.id, values: { assuranceWindowMinutes: 5 } },
    });
  });

  it("PATCH /v1/chatops/connections/:id: adding an Outlook recipient needs settings_relax; removing one does not", async () => {
    const [con] = await db.insert(connectors).values({ name: `b4a-chat-${RUN}`, kind: "chat" }).returning();
    created.connectors.push(con!.id);
    const [outlook] = await db
      .insert(chatopsConnections)
      .values({ name: `b4a-outlook-${RUN}`, provider: "outlook", connectorId: con!.id, defaultChannel: "cab@example.com" })
      .returning();
    created.chatops.push(outlook!.id);
    const url = `/v1/chatops/connections/${outlook!.id}`;
    await provesStepUp("PATCH", url, { outlookRecipientAllowList: ["ops@example.com", "risk@example.com"] }, {
      kind: "settings_relax",
      body: { connectionId: outlook!.id, values: { outlookRecipientsAdded: ["ops@example.com", "risk@example.com"] } },
    });
    const narrowed = await asAdmin("PATCH", url, { outlookRecipientAllowList: ["ops@example.com"] });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
  });

  it("PATCH /v1/rules/:kind/:ruleId/deploy-mode: narrowing where a rule applies needs settings_relax; every mode (null) does not", async () => {
    const [srv] = await db.insert(mcpServers).values({ name: `b4a-srv-${RUN}`, url: `https://b4a-${RUN}.example.com/mcp` }).returning({ id: mcpServers.id });
    created.servers.push(srv!.id);
    // ADR-0186 B: a rule's approver pool never counts the caller, so a rule over the admin's own calls
    // that names the admin as its approver is unsatisfiable (quorum_unsatisfiable). A second person approves.
    const approver = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `b4a-scope-approver-${RUN}@example.com`, displayName: "b4a scope approver" } });
    expect(approver.statusCode, approver.body).toBe(201);
    created.users.push(approver.json().id as string);
    const rule = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/rules/approvals",
      payload: { scope: "user", serverScope: "server", userId: admin.id, serverId: srv!.id, toolName: `b4a_${RUN}`, approverUserId: approver.json().id },
    });
    expect(rule.statusCode, rule.body).toBe(201);
    created.rules.push(rule.json().id);
    const ruleId = created.rules.at(-1)!;
    const url = `/v1/rules/approvals/${ruleId}/deploy-mode`;
    await provesStepUp("PATCH", url, { deployMode: "byoc" }, {
      kind: "settings_relax",
      body: { ruleKind: "approvals", ruleId, values: { deployMode: "byoc" } },
    });
    expect((await asAdmin("PATCH", url, { deployMode: null })).statusCode).toBe(200);
  });

  it("POST /v1/agents/:id/unhalt and the per-tool unhalt: halting needs nothing; lifting the halt needs settings_relax", async () => {
    const [a] = await db.insert(agents).values({ name: `b4a-halt-${RUN}`, provider: "mock", tier: 1 }).returning({ id: agents.id });
    created.agents.push(a!.id);
    expect((await asAdmin("POST", `/v1/agents/${a!.id}/halt`, { reason: "b4a incident drill halt" })).statusCode).toBe(200);
    await provesStepUp("POST", `/v1/agents/${a!.id}/unhalt`, { reason: "b4a incident drill is over" }, {
      kind: "settings_relax",
      body: { agentId: a!.id, values: { halted: false } },
    });
    // nothing halted: nothing to lift, nothing asked
    expect((await asAdmin("POST", `/v1/agents/${a!.id}/unhalt`, { reason: "b4a incident drill again" })).statusCode).toBe(200);

    const [srv] = await db.insert(mcpServers).values({ name: `b4a-halt-srv-${RUN}`, url: `https://b4a-halt-${RUN}.example.com/mcp` }).returning({ id: mcpServers.id });
    created.servers.push(srv!.id);
    await db.insert(mcpTools).values({ serverId: srv!.id, name: "b4a_tool", kind: "write" });
    const tool = `/v1/servers/${srv!.id}/tools/b4a_tool`;
    expect((await asAdmin("POST", `${tool}/halt`, { reason: "b4a incident drill halt" })).statusCode).toBe(200);
    await provesStepUp("POST", `${tool}/unhalt`, { reason: "b4a incident drill is over" }, {
      kind: "settings_relax",
      body: { serverId: srv!.id, toolName: "b4a_tool", values: { halted: false } },
    });
  });

  it("POST /v1/retention-holds/release: releasing held evidence needs evidence_hold_override", async () => {
    const traceId = randomUUID();
    await provesStepUp("POST", "/v1/retention-holds/release", { reason: "admin", traceIds: [traceId], reference: `b4a-${RUN}` }, {
      kind: "evidence_hold_override",
      body: { release: "admin", userId: null, traceIds: [traceId], reference: `b4a-${RUN}` },
    });
  });
});
