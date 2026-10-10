/**
 * Batch 4 (ADR-0186) — automated-review fixes on PR #198, round 2, each proven
 * red on the pre-fix head (e2ae0a4) and green after:
 *
 *  F7   the execution recheck recounts approving principals in every
 *       signature mode (step_up / off too, not only passkey).
 *  F8   queue visibility follows the approver NAMED when the call was queued
 *       (the snapshot the decide path uses), not the routed row.
 *  F9   an unversioned approval rule's quorum / approver role is part of the
 *       consent context, so raising it retires consents given under the old one.
 *  F10  the org-settings writer decides the break-glass (and relax) step-up
 *       again on the locked row.
 *  F11  a fresh OIDC login in the same second as the step-up request is fresh.
 *  Class A — every write whose step-up rests on a value it then overwrites
 *       refuses a stale write (409 changed_concurrently) instead of undoing a
 *       concurrent change without the step-up that change back needs.
 *
 * Runs on its OWN scratch database (prefix `b4c2_`), dropped in afterAll, so
 * nothing append-only outlives the run (M-068).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  agents,
  and,
  approvalAssignmentRules,
  approvalDelegations,
  approvals,
  auditLog,
  authSessions,
  chatopsConnections,
  connectors,
  createDb,
  eq,
  guardrailConfigs,
  interceptionSettings,
  isNull,
  mcpServers,
  ORG_SETTINGS_ID,
  orgSettings,
  policySimulationSettings,
  revocations,
  roleAssignments,
  roles,
  runMigrations,
  sql,
  type Db,
  type SsoReauthRequestRow,
} from "@regulait/db";
import { APPROVAL_SIGNATURE_RECHECK_FAILED_RULE, STEP_UP_HEADER } from "@regulait/shared";
import { finishSsoReauth } from "./step-up.js";
import { SIGN_IN_INVARIANT_LOCK_KEY } from "./break-glass.js";
import { buildApp } from "./app.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";
import { drainBackgroundWork } from "./background-work.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `b4c2_rv_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const RUN = randomBytes(3).toString("hex");
const BOOT = `b4c2-rv-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const DATA_KEY = "a".repeat(64);
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;

let admin: Db;
let db: Db;
let locker: Db;
let app: ReturnType<typeof buildApp>;
let upstreamClose: () => Promise<void>;
let serverId: string;
let roleId: string;

type Session = { token: string; sessionId: string };
type Person = { id: string; key: { authorization: string }; s: Session; auth: SoftAuthenticator };
const P = {} as Record<"caller" | "a" | "b" | "adm", Person>;

const TOOLS = Array.from({ length: 16 }, (_, i) => `b4c2_t${i}_${RUN}`);
const upstreamHits = { tool: 0 };
let toolCursor = 0;
const nextTool = () => TOOLS[toolCursor++]!;

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

async function enrol(s: Session): Promise<SoftAuthenticator> {
  const opt = await as(s, "POST", "/v1/auth/passkeys/registration-options", {});
  expect(opt.statusCode, opt.body).toBe(200);
  const auth = new SoftAuthenticator({ origin: ORIGIN });
  const reg = await as(s, "POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: auth.register(opt.json().options), label: `b4c-${randomBytes(2).toString("hex")}` });
  expect(reg.statusCode, reg.body).toBe(201);
  return auth;
}

async function mkUser(label: string, isAdmin = false): Promise<{ id: string; key: { authorization: string }; s: Session }> {
  const u = await withKey(AUTH, "POST", "/v1/users", { email: `b4c2-${label}-${RUN}@example.com`, displayName: `b4c ${label}`, isAdmin });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  const key = await withKey(AUTH, "POST", `/v1/users/${id}/keys`, { name: "b4c" });
  expect(key.statusCode, key.body).toBe(201);
  return { id, key: { authorization: `Bearer ${key.json().token}` }, s: await mkSession(id) };
}

async function mkPerson(label: string, isAdmin = false): Promise<Person> {
  const u = await mkUser(label, isAdmin);
  return { ...u, auth: await enrol(u.s) };
}
const person = (label: string) => mkPerson(`${label}-${randomBytes(2).toString("hex")}`);

async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        const server = new McpServer({ name: "b4c-upstream", version: "0.0.1" });
        for (const name of TOOLS) {
          server.registerTool(name, { description: name, inputSchema: { text: z.string() } }, async ({ text }) => {
            upstreamHits.tool++;
            return { content: [{ type: "text", text: `ran: ${text}` }] };
          });
        }
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (typeof address !== "object" || !address) throw new Error("no address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

/** an approval rule on `tool` for the caller (named approver A, approver role R), through the real route */
async function rule(tool: string, body: Record<string, unknown> = {}) {
  const r = await withKey(AUTH, "POST", "/v1/rules/approvals", {
    userId: P.caller.id,
    serverId,
    toolName: tool,
    approverUserId: P.a.id,
    approverRoleId: roleId,
    quorum: 1,
    ...body,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

const call = (tool: string, args: Record<string, unknown>) =>
  executeGovernedToolCall(db, undefined, { userId: P.caller.id, serverId, toolName: tool, arguments: args });

async function queued(tool: string, args: Record<string, unknown>): Promise<string> {
  const out = await call(tool, args);
  expect(out.kind, JSON.stringify(out)).toBe("approval_required");
  return (out as { approvalId: string }).approvalId;
}

const signingOptions = (p: { s: Session }, approvalId: string) =>
  as(p.s, "POST", `/v1/approvals/${approvalId}/signing-options`, { decision: "approved" });
const queueOf = async (p: { s: Session }) =>
  ((await as(p.s, "GET", "/v1/approvals?status=pending")).json().approvals as Array<{ id: string }>).map((r) => r.id);

const delegate = async (fromUserId: string, toUserId: string) =>
  (
    await db
      .insert(approvalDelegations)
      .values({ fromUserId, toUserId, startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 3_600_000), reason: "b4c" })
      .returning({ id: approvalDelegations.id })
  )[0]!.id;

async function grantFor(p: Person, action: { kind: string; body: Record<string, unknown> }): Promise<string> {
  const o = await as(p.s, "POST", "/v1/auth/step-up/options", { action });
  expect(o.statusCode, o.body).toBe(200);
  const v = await as(p.s, "POST", "/v1/auth/step-up/verify", { stepUpId: o.json().stepUpId, method: "passkey", response: p.auth.authenticate(o.json().passkey.options) });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().stepUpToken as string;
}

/** wait until some backend of the scratch database is blocked on a row lock */
async function untilLockWait(): Promise<void> {
  for (let i = 0; i < 250; i++) {
    const { rows } = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the request never blocked on the row lock");
}

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(urlFor(SCRATCH_DB));
  locker = createDb(urlFor(SCRATCH_DB));
  await runMigrations(db, migrationsFolder);
  await relaxIdentityForTest(db, { mfaRequired: "off" });
  await relaxStrictAdmissionForTest(db);
  await relaxGovernanceGatesForTest(db, { requirePreviewBeforeActivate: false });
  await db.execute(sql`UPDATE org_settings SET step_up_mode = 'required', approval_delegation_enabled = true,
    step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage"]'::jsonb
    WHERE id = ${ORG_SETTINGS_ID}`);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const up = await startUpstream();
  upstreamClose = up.close;
  const s = await withKey(AUTH, "POST", "/v1/servers", { name: `b4c-server-${RUN}`, url: up.url });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  P.caller = await mkPerson("caller");
  P.a = await mkPerson("approver-a");
  P.b = await mkPerson("approver-b");
  P.adm = await mkPerson("admin", true);
  const [role] = await db.insert(roles).values({ name: `b4c approvers ${RUN}` }).returning({ id: roles.id });
  roleId = role!.id;
  await db.insert(roleAssignments).values({ userId: P.b.id, roleId });
  for (const name of TOOLS) {
    const t = await withKey(AUTH, "POST", `/v1/servers/${serverId}/tools`, { name, kind: "write" });
    expect([200, 201]).toContain(t.statusCode);
    const g = await withKey(AUTH, "POST", "/v1/grants/tools", { userId: P.caller.id, serverId, toolName: name });
    expect([200, 201]).toContain(g.statusCode);
  }
}, 180_000);

afterAll(async () => {
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  await closeAll([
    async () => drainBackgroundWork(db),
    async () => app?.server.closeAllConnections(),
    async () => app?.close(),
    async () => upstreamClose?.(),
    async () => locker?.$client.end(),
    async () => db?.$client.end(),
    async () => dropScratchDatabase(admin, SCRATCH_DB),
    async () => admin?.$client.end(),
  ]);
});

/** a fresh admin-session call that needs a step-up: refused, stepped up with a passkey, retried */
async function asSteppedUpAdmin(method: Method, url: string, payload: unknown) {
  const first = await as(P.adm.s, method, url, payload);
  if (first.statusCode !== 403 || first.json().error !== "step_up_required") return first;
  return as(P.adm.s, method, url, payload, { [STEP_UP_HEADER]: await grantFor(P.adm, first.json().action) });
}

type Res = Awaited<ReturnType<typeof as>>;
/**
 * THE STALE-WRITE RACE (Class A). Inside an open transaction on another
 * connection, `mutate` changes the row the request's step-up decision reads
 * (and so holds its lock; `lock` adds the advisory lock a real concurrent
 * writer of that object takes). The request is fired, reads the OLD state
 * (the change is uncommitted), and is let through once it is blocked on a
 * lock; then the change commits. Returns the request's answer.
 */
async function raced(mutate: (tx: Db) => Promise<unknown>, fire: () => Promise<Res>, lock?: ReturnType<typeof sql>): Promise<Res> {
  let res: Res | undefined;
  await locker.transaction(async (tx) => {
    if (lock) await tx.execute(lock);
    await mutate(tx as unknown as Db);
    void fire().then((r) => (res = r));
    await untilLockWait();
  });
  for (let i = 0; i < 250 && !res; i++) await new Promise((r) => setTimeout(r, 20));
  expect(res, "the request never answered").toBeTruthy();
  return res!;
}

async function stepUpDecide(p: Person, approvalId: string) {
  const first = await as(p.s, "POST", `/v1/approvals/${approvalId}/decide`, { decision: "approved", reason: "b4c2" });
  expect(first.statusCode, first.body).toBe(403);
  const token = await grantFor(p, first.json().action);
  return as(p.s, "POST", `/v1/approvals/${approvalId}/decide`, { decision: "approved", reason: "b4c2" }, { [STEP_UP_HEADER]: token });
}

async function signAndDecide(p: Person, approvalId: string) {
  const o = await signingOptions(p, approvalId);
  expect(o.statusCode, o.body).toBe(200);
  return as(p.s, "POST", `/v1/approvals/${approvalId}/decide`, {
    decision: "approved",
    reason: "b4c2",
    passkey: { challengeId: o.json().challengeId, response: p.auth.authenticate(o.json().options) },
  });
}

describe("F7: the execution recheck recounts approving principals in every signature mode", () => {
  it("step_up mode: two approvers delegation-linked after quorum are one principal — the call is refused", async () => {
    await db.execute(sql`UPDATE org_settings SET approval_signature_mode = 'step_up' WHERE id = ${ORG_SETTINGS_ID}`);
    let link: string | undefined;
    try {
      const tool = nextTool();
      await rule(tool, { quorum: 2 });
      const args = { text: "linked after quorum" };
      const id = await queued(tool, args);
      expect((await stepUpDecide(P.a, id)).statusCode).toBe(200);
      const second = await stepUpDecide(P.b, id);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json().status).toBe("approved");
      link = await delegate(P.a.id, P.b.id);
      const before = upstreamHits.tool;
      const out = await call(tool, args);
      expect(upstreamHits.tool - before, JSON.stringify(out)).toBe(0);
      expect(out.kind, JSON.stringify(out)).toBe("denied");
      expect((out as { decision: { ruleId: string } }).decision.ruleId).toBe(APPROVAL_SIGNATURE_RECHECK_FAILED_RULE);
      const [audit] = await db
        .select({ detail: auditLog.detail })
        .from(auditLog)
        .where(and(eq(auditLog.ruleId, APPROVAL_SIGNATURE_RECHECK_FAILED_RULE), sql`${auditLog.detail}->>'approvalId' = ${id}`));
      expect((audit!.detail as { why: string }).why).toBe("below_quorum");
    } finally {
      if (link) await db.delete(approvalDelegations).where(eq(approvalDelegations.id, link));
      await db.execute(sql`UPDATE org_settings SET approval_signature_mode = 'passkey' WHERE id = ${ORG_SETTINGS_ID}`);
    }
  });
});

describe("F8: queue visibility follows the approver named when the call was queued", () => {
  it("a routing rule re-points the row: the original named approver still sees it and may sign it", async () => {
    const routed = await person("routed");
    const r = await asSteppedUpAdmin("POST", "/v1/approvals/assignment-rules", {
      name: `b4c2 route ${RUN}`,
      objectType: "mcp_tool",
      assigneeKind: "user",
      assigneeId: routed.id,
    });
    expect(r.statusCode, r.body).toBe(201);
    try {
      const tool = nextTool();
      await rule(tool, { approverRoleId: null });
      const id = await queued(tool, { text: "routed away" });
      // the first read materializes routing and re-points approver_user_id
      await queueOf(routed);
      expect((await db.select().from(approvals).where(eq(approvals.id, id)))[0]!.approverUserId).toBe(routed.id);
      expect(await queueOf(P.a)).toContain(id);
      const opts = await signingOptions(P.a, id);
      expect(opts.statusCode, opts.body).toBe(200);
    } finally {
      await db.update(approvalAssignmentRules).set({ enabled: false }).where(eq(approvalAssignmentRules.id, r.json().id as string));
    }
  });
});

describe("F9: an unversioned rule's dual control is part of the consent context", () => {
  it("raising the quorum of an unversioned rule retires the consent given under quorum 1", async () => {
    const tool = nextTool();
    const ruleId = await rule(tool);
    const args = { text: "quorum raised after consent" };
    const id = await queued(tool, args);
    const ok = await signAndDecide(P.a, id);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().status).toBe("approved");
    const up = await withKey(AUTH, "PATCH", `/v1/rules/approvals/${ruleId}`, { quorum: 2 });
    expect(up.statusCode, up.body).toBe(200);
    expect(up.json().versionMinted ?? null).toBeNull();
    const before = upstreamHits.tool;
    const out = await call(tool, args);
    expect(upstreamHits.tool - before, JSON.stringify(out)).toBe(0);
    expect(out.kind, JSON.stringify(out)).not.toBe("allowed");
  });
});

describe("F10: the settings writer decides break-glass on the locked row", () => {
  it("a stale request cannot revert a break-glass change made while it waited, without a break_glass step-up", async () => {
    try {
      const res = await raced(
        (tx) => tx.update(orgSettings).set({ breakGlassUserIds: [P.adm.id] }).where(eq(orgSettings.id, ORG_SETTINGS_ID)),
        () => as(P.adm.s, "PUT", "/v1/org/settings", { breakGlassUserIds: [] }),
        sql`select pg_advisory_xact_lock(${SIGN_IN_INVARIANT_LOCK_KEY})`,
      );
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toMatchObject({ error: "step_up_required", actionKind: "break_glass" });
      const [org] = await db.select({ ids: orgSettings.breakGlassUserIds }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
      expect(org!.ids).toEqual([P.adm.id]);
    } finally {
      await db.update(orgSettings).set({ breakGlassUserIds: null }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    }
  });
});

describe("F11: a fresh OIDC login in the same second as the request is fresh", () => {
  const rowAt = (requestedAt: Date) =>
    ({ id: randomUUID(), userId: P.a.id, providerKind: "oidc", stepUpId: randomUUID(), requestedAt }) as unknown as SsoReauthRequestRow;
  it("auth_time (whole seconds) equal to the request's second is accepted; an earlier second is stale", async () => {
    const sec = Math.floor(Date.now() / 1000);
    const requestedAt = new Date(sec * 1000 + 400);
    const same = await finishSsoReauth(db, rowAt(requestedAt), { linkedUserId: P.a.id, authTime: new Date(sec * 1000), providerName: "b4c2" });
    expect(same).toEqual({ ok: true });
    const earlier = await finishSsoReauth(db, rowAt(requestedAt), { linkedUserId: P.a.id, authTime: new Date((sec - 1) * 1000), providerName: "b4c2" });
    expect(earlier).toMatchObject({ ok: false, error: "sso_reauth_stale" });
    const sub = await finishSsoReauth(db, rowAt(requestedAt), { linkedUserId: P.a.id, authTime: new Date(sec * 1000 + 100), providerName: "b4c2" });
    expect(sub).toMatchObject({ ok: false, error: "sso_reauth_stale" });
  });
});

describe("Class A: a step-up decided on an unlocked read never lets a stale write undo a concurrent change", () => {
  it("assurance gate mode", async () => {
    await db.update(orgSettings).set({ assuranceGateMode: "warn" }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    try {
      const res = await raced(
        (tx) => tx.update(orgSettings).set({ assuranceGateMode: "enforce" }).where(eq(orgSettings.id, ORG_SETTINGS_ID)),
        () => as(P.adm.s, "PUT", "/v1/org/settings/assurance-gate-mode", { mode: "warn" }),
      );
      expect(res.statusCode, res.body).toBe(409);
      expect((await db.select({ m: orgSettings.assuranceGateMode }).from(orgSettings))[0]!.m).toBe("enforce");
    } finally {
      await db.update(orgSettings).set({ assuranceGateMode: "enforce" }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    }
  });

  it("interception settings", async () => {
    expect((await as(P.adm.s, "GET", "/v1/interception/settings")).statusCode).toBe(200);
    await db.update(interceptionSettings).set({ strictFieldRejection: false });
    try {
      const res = await raced(
        (tx) => tx.update(interceptionSettings).set({ strictFieldRejection: true }),
        () => as(P.adm.s, "PUT", "/v1/interception/settings", { strictFieldRejection: false }),
      );
      expect(res.statusCode, res.body).toBe(409);
      expect((await db.select({ v: interceptionSettings.strictFieldRejection }).from(interceptionSettings))[0]!.v).toBe(true);
    } finally {
      await db.update(interceptionSettings).set({ strictFieldRejection: true });
    }
  });

  it("MRM enforcement", async () => {
    await db.update(orgSettings).set({ mrmEnforced: false }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    try {
      const res = await raced(
        (tx) => tx.update(orgSettings).set({ mrmEnforced: true }).where(eq(orgSettings.id, ORG_SETTINGS_ID)),
        () => as(P.adm.s, "POST", "/v1/mrm/enforcement", { enforced: false }),
      );
      expect(res.statusCode, res.body).toBe(409);
      expect((await db.select({ v: orgSettings.mrmEnforced }).from(orgSettings))[0]!.v).toBe(true);
    } finally {
      await db.update(orgSettings).set({ mrmEnforced: true }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    }
  });

  it("policy-simulation preview dial", async () => {
    expect((await as(P.adm.s, "GET", "/v1/policy-simulations/settings")).statusCode).toBe(200);
    await db.update(policySimulationSettings).set({ requirePreviewBeforeActivate: false });
    try {
      const res = await raced(
        (tx) => tx.update(policySimulationSettings).set({ requirePreviewBeforeActivate: true }),
        () => as(P.adm.s, "PUT", "/v1/policy-simulations/settings", { requirePreviewBeforeActivate: false }),
      );
      expect(res.statusCode, res.body).toBe(409);
      expect((await db.select({ v: policySimulationSettings.requirePreviewBeforeActivate }).from(policySimulationSettings))[0]!.v).toBe(true);
    } finally {
      await db.update(policySimulationSettings).set({ requirePreviewBeforeActivate: false });
    }
  });

  it("org guardrail defaults", async () => {
    const set = await asSteppedUpAdmin("PUT", "/v1/guardrails/config", { modes: { prompt_injection: "log" } });
    expect(set.statusCode, set.body).toBe(200);
    const orgRow = () => db.select().from(guardrailConfigs).where(and(eq(guardrailConfigs.scope, "org"), isNull(guardrailConfigs.scopeId)));
    try {
      const res = await raced(
        (tx) => tx.update(guardrailConfigs).set({ promptInjectionMode: "block" }).where(and(eq(guardrailConfigs.scope, "org"), isNull(guardrailConfigs.scopeId))),
        () => as(P.adm.s, "PUT", "/v1/guardrails/config", { modes: { prompt_injection: "log" } }),
        sql`select pg_advisory_xact_lock(${6_000_000_186}::bigint)`,
      );
      expect(res.statusCode, res.body).toBe(409);
      expect((await orgRow())[0]!.promptInjectionMode).toBe("block");
    } finally {
      await db.update(guardrailConfigs).set({ promptInjectionMode: "block" }).where(and(eq(guardrailConfigs.scope, "org"), isNull(guardrailConfigs.scopeId)));
    }
  });

  it("revocation scope", async () => {
    const [rv] = await db.insert(revocations).values({ userId: P.caller.id, serverId, scope: "read_only" }).returning({ id: revocations.id });
    const res = await raced(
      (tx) => tx.update(revocations).set({ scope: "full" }).where(eq(revocations.id, rv!.id)),
      () => as(P.adm.s, "PATCH", `/v1/revocations/mcp/${rv!.id}/scope`, { scope: "read_only" }),
    );
    expect(res.statusCode, res.body).toBe(409);
    expect((await db.select({ s: revocations.scope }).from(revocations).where(eq(revocations.id, rv!.id)))[0]!.s).toBe("full");
  });

  it("MCP server owner", async () => {
    const [srv] = await db.insert(mcpServers).values({ name: `b4c2-own-${RUN}`, url: `https://b4c2-own-${RUN}.example.com/mcp`, ownerUserId: P.a.id }).returning({ id: mcpServers.id });
    const res = await raced(
      (tx) => tx.update(mcpServers).set({ ownerUserId: P.b.id }).where(eq(mcpServers.id, srv!.id)),
      () => as(P.adm.s, "PUT", `/v1/servers/${srv!.id}/owner`, { ownerUserId: P.a.id }),
    );
    expect(res.statusCode, res.body).toBe(409);
    expect((await db.select({ o: mcpServers.ownerUserId }).from(mcpServers).where(eq(mcpServers.id, srv!.id)))[0]!.o).toBe(P.b.id);
  });

  it("agent steward", async () => {
    const [a] = await db.insert(agents).values({ name: `b4c2-stew-${RUN}`, provider: "mock", tier: 1, ownerUserId: P.a.id }).returning({ id: agents.id });
    const res = await raced(
      (tx) => tx.update(agents).set({ ownerUserId: P.b.id }).where(eq(agents.id, a!.id)),
      () => as(P.adm.s, "PATCH", `/v1/agents/${a!.id}/stewardship`, { successorUserId: P.caller.id }),
    );
    expect(res.statusCode, res.body).toBe(409);
    expect((await db.select({ o: agents.ownerUserId }).from(agents).where(eq(agents.id, a!.id)))[0]!.o).toBe(P.b.id);
  });

  it("outlook recipient allow-list", async () => {
    const [conn] = await db.insert(connectors).values({ name: `b4c2-mail-${RUN}`, kind: "email", providerKind: "outlook" }).returning({ id: connectors.id });
    const [c] = await db
      .insert(chatopsConnections)
      .values({
        name: `b4c2-outlook-${RUN}`,
        provider: "outlook",
        connectorId: conn!.id,
        defaultChannel: "governance@example.com",
        enabled: false,
        outlookRecipientAllowList: ["a@example.com", "b@example.com"],
      })
      .returning({ id: chatopsConnections.id });
    const res = await raced(
      (tx) => tx.update(chatopsConnections).set({ outlookRecipientAllowList: ["a@example.com"] }).where(eq(chatopsConnections.id, c!.id)),
      () => as(P.adm.s, "PATCH", `/v1/chatops/connections/${c!.id}`, { outlookRecipientAllowList: ["a@example.com", "b@example.com"] }),
    );
    expect(res.statusCode, res.body).toBe(409);
    expect((await db.select({ l: chatopsConnections.outlookRecipientAllowList }).from(chatopsConnections).where(eq(chatopsConnections.id, c!.id)))[0]!.l).toEqual(["a@example.com"]);
  });
});
