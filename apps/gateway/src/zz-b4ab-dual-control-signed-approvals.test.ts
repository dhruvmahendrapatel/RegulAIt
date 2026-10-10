/**
 * ADR-0186 A (dual control) and B (passkey-signed approvals) — slice A2+B,
 * proof by attack.
 *
 * Passkeys are driven by the SOFTWARE authenticator (`webauthn-soft-authenticator.ts`),
 * verified by the gateway's real `@simplewebauthn/server` code. Tool calls go
 * through the real governed path (`executeGovernedToolCall`) against a local
 * MCP double that counts every HTTP request and tool invocation, so "nothing
 * ran" is a socket fact.
 *
 * Covered: the queue-time snapshot (rule quorum, sensitive-project quorum,
 * signature mode); the eligible pool (named approver + approver-role members;
 * the caller never, nor anyone delegation-linked to the caller; admins are not
 * approvers of someone's tool call); `duplicate_approver` (same principal
 * twice, directly and via delegation); quorum 2 with one approval does not
 * run; any deny vetoes; concurrent decides serialise on the row lock;
 * `quorum_unsatisfiable` at rule write and a denied, audited call at queue
 * time; signatures over another decision / approval, a changed action, a
 * reused or expired ceremony, another user's credential, a counter replay and
 * a revoked credential; the execution recheck (a tampered approval is
 * superseded, refused and audited, with no upstream contact); bulk refused;
 * step_up and off modes; API keys; RP unset fails closed.
 *
 * Runs on its OWN scratch database (prefix `b4ab_`), dropped in afterAll, so
 * the append-only `approval_decisions` rows it writes leave nothing behind.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  and,
  approvalDecisions,
  approvalRules,
  approvals,
  auditLog,
  authSessions,
  complianceProfiles,
  configVersions,
  createDb,
  desc,
  eq,
  ORG_SETTINGS_ID,
  orgSettings,
  projectMembers,
  projects,
  roleAssignments,
  roles,
  runMigrations,
  sql,
  users as usersTable,
  webauthnCredentials,
  type Db,
} from "@regulait/db";
import { APPROVAL_SIGNATURE_RECHECK_FAILED_RULE, STEP_UP_HEADER, approvalArgumentsDigest } from "@regulait/shared";
import { buildApp } from "./app.js";
import { consumeBoundApproval, executeGovernedToolCall } from "./mcp-proxy.js";
import { approvalQuorumTestHooks, approvalSigningPosture } from "./approval-signatures.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { createApprovalRuleRow } from "./rule-creates.js";
import { ApprovalRuleWriteRefusedError } from "./approval-pool.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";
import { drainBackgroundWork } from "./background-work.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `b4ab_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const RUN = randomBytes(3).toString("hex");
const BOOT = `b4ab-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "a".repeat(64);
const PUBLIC_URL = "http://localhost";
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };

let admin: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;
let upstreamClose: () => Promise<void>;
let serverId: string;
let roleId: string;
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;
const upstreamHits = { http: 0, tool: 0 };

type Who = { id: string; key: { authorization: string } };
type Session = { token: string; sessionId: string };
type Person = Who & { s: Session; auth: SoftAuthenticator };
const P = {} as Record<"caller" | "a" | "b" | "d" | "e" | "outsider" | "adm", Person>;

const TOOLS = Array.from({ length: 24 }, (_, i) => `b4ab_t${i}_${RUN}`);
let toolCursor = 0;
const nextTool = () => TOOLS[toolCursor++]!;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const as = (s: Session, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method,
    url,
    headers: { ...CSRF, ...headers },
    cookies: { regulait_session: s.token },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
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

async function mkPerson(label: string, isAdmin = false): Promise<Person> {
  const u = await withKey(AUTH, "POST", "/v1/users", { email: `b4ab-${label}-${RUN}@example.com`, displayName: `b4ab ${label}`, isAdmin });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  const key = await withKey(AUTH, "POST", `/v1/users/${id}/keys`, { name: "b4ab" });
  expect(key.statusCode, key.body).toBe(201);
  const s = await mkSession(id);
  const opt = await as(s, "POST", "/v1/auth/passkeys/registration-options", {});
  expect(opt.statusCode, opt.body).toBe(200);
  const auth = new SoftAuthenticator({ origin: ORIGIN });
  const reg = await as(s, "POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: auth.register(opt.json().options), label: "laptop" });
  expect(reg.statusCode, reg.body).toBe(201);
  return { id, key: { authorization: `Bearer ${key.json().token}` }, s, auth };
}

function buildUpstream(): McpServer {
  const server = new McpServer({ name: "b4ab-upstream", version: "0.0.1" });
  for (const name of TOOLS) {
    server.registerTool(name, { description: name, inputSchema: { text: z.string() } }, async ({ text }) => {
      upstreamHits.tool++;
      return { content: [{ type: "text", text: `ran: ${text}` }] };
    });
  }
  return server;
}

async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    upstreamHits.http++;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        const server = buildUpstream();
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

/** an approval rule on `tool` for the caller, through the real route */
async function rule(tool: string, body: Record<string, unknown> = {}) {
  return withKey(AUTH, "POST", "/v1/rules/approvals", {
    userId: P.caller.id,
    serverId,
    toolName: tool,
    approverUserId: P.a.id,
    approverRoleId: roleId,
    quorum: 2,
    ...body,
  });
}

const call = (tool: string, args: Record<string, unknown>, projectId?: string) =>
  executeGovernedToolCall(db, undefined, { userId: P.caller.id, serverId, toolName: tool, arguments: args, ...(projectId ? { projectId } : {}) });

/** queue a call and return its pending approval id */
async function queued(tool: string, args: Record<string, unknown>, projectId?: string): Promise<string> {
  const out = await call(tool, args, projectId);
  expect(out.kind, JSON.stringify(out)).toBe("approval_required");
  return (out as { approvalId: string }).approvalId;
}

/**
 * B4S-06: once an admin here can step up (P.adm enrolled a passkey in
 * beforeAll), the bootstrap credential no longer passes a step-up, so a
 * protected write (a delegation is a settings_relax act) is made by that admin
 * the real way: refused, a passkey step-up for exactly that action, resent.
 */
async function asSteppedUpAdmin(method: Method, url: string, payload?: unknown) {
  const first = await as(P.adm.s, method, url, payload);
  if (first.statusCode !== 403 || first.json().error !== "step_up_required") return first;
  const o = await as(P.adm.s, "POST", "/v1/auth/step-up/options", { action: first.json().action });
  expect(o.statusCode, o.body).toBe(200);
  const v = await as(P.adm.s, "POST", "/v1/auth/step-up/verify", {
    stepUpId: o.json().stepUpId,
    method: "passkey",
    response: P.adm.auth.authenticate(o.json().passkey.options),
  });
  expect(v.statusCode, v.body).toBe(200);
  return as(P.adm.s, method, url, payload, { [STEP_UP_HEADER]: v.json().stepUpToken as string });
}

const row = async (id: string) => (await db.select().from(approvals).where(eq(approvals.id, id)))[0]!;

/** signing options for `p`, signed by `p`'s (or another) authenticator */
async function signed(p: Person, approvalId: string, decision: "approved" | "denied", signer: SoftAuthenticator = p.auth) {
  const o = await as(p.s, "POST", `/v1/approvals/${approvalId}/signing-options`, { decision });
  expect(o.statusCode, o.body).toBe(200);
  return { challengeId: o.json().challengeId as string, response: signer.authenticate(o.json().options), options: o.json() };
}

const decide = (p: Person, approvalId: string, decision: "approved" | "denied", passkey?: { challengeId: string; response: unknown }) =>
  as(p.s, "POST", `/v1/approvals/${approvalId}/decide`, { decision, reason: "b4ab", ...(passkey ? { passkey } : {}) });

async function signAndDecide(p: Person, approvalId: string, decision: "approved" | "denied" = "approved") {
  const sig = await signed(p, approvalId, decision);
  return decide(p, approvalId, decision, { challengeId: sig.challengeId, response: sig.response });
}

const auditFor = async (ruleId: string, approvalId: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.ruleId, ruleId), sql`${auditLog.detail}->>'approvalId' = ${approvalId}`))
    .orderBy(desc(auditLog.seq));

async function setMode(mode: "passkey" | "step_up" | "off") {
  await db.update(orgSettings).set({ approvalSignatureMode: mode }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = PUBLIC_URL;
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(urlFor(SCRATCH_DB));
  await runMigrations(db, migrationsFolder);
  // this suite is about approvals, not the MFA dial or MCP admission of a local double
  await relaxIdentityForTest(db, { mfaRequired: "off" });
  await relaxStrictAdmissionForTest(db);
  // versions here are activated directly; the preview gate is not what this suite tests
  await relaxGovernanceGatesForTest(db, { requirePreviewBeforeActivate: false });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const up = await startUpstream();
  upstreamClose = up.close;
  const s = await withKey(AUTH, "POST", "/v1/servers", { name: `b4ab-server-${RUN}`, url: up.url });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  P.caller = await mkPerson("caller");
  P.a = await mkPerson("approver-a");
  P.b = await mkPerson("approver-b");
  P.d = await mkPerson("approver-d");
  P.e = await mkPerson("approver-e");
  P.outsider = await mkPerson("outsider");
  P.adm = await mkPerson("admin", true);
  const [role] = await db.insert(roles).values({ name: `b4ab approvers ${RUN}` }).returning({ id: roles.id });
  roleId = role!.id;
  // the caller is IN the approver role on purpose: the pool must still exclude them
  for (const u of [P.b, P.d, P.caller]) await db.insert(roleAssignments).values({ userId: u.id, roleId });
  for (const name of TOOLS) {
    const t = await withKey(AUTH, "POST", `/v1/servers/${serverId}/tools`, { name, kind: "write" });
    expect([200, 201]).toContain(t.statusCode);
    const g = await withKey(AUTH, "POST", "/v1/grants/tools", { userId: P.caller.id, serverId, toolName: name });
    expect([200, 201]).toContain(g.statusCode);
  }
}, 180_000);

afterAll(async () => {
  approvalQuorumTestHooks.afterPrincipalsCounted = null;
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  await closeAll([
    async () => drainBackgroundWork(db),
    async () => app?.server.closeAllConnections(),
    async () => app?.close(),
    async () => upstreamClose?.(),
    async () => db?.$client.end(),
    async () => dropScratchDatabase(admin, SCRATCH_DB),
    async () => admin?.$client.end(),
  ]);
});

// ---------------------------------------------------------------------------
// A — dual control
// ---------------------------------------------------------------------------

describe("A — the queue-time snapshot and the eligible pool", () => {
  it("snapshots quorum (the rule's) and signature mode (the org's, strict passkey) onto the approval", async () => {
    const tool = nextTool();
    expect((await rule(tool)).statusCode).toBe(201);
    const id = await queued(tool, { text: "snapshot" });
    const r = await row(id);
    expect(r.quorum).toBe(2);
    expect(r.signatureMode).toBe("passkey");
  });

  it("quorum 2 with one approval does not run; the second distinct approver releases it ONCE; the audit names both", async () => {
    const tool = nextTool();
    expect((await rule(tool)).statusCode).toBe(201);
    const args = { text: "two-people" };
    const id = await queued(tool, args);
    const first = await signAndDecide(P.a, id);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ status: "pending", approvals: 1, quorum: 2 });
    expect(first.json().decisions).toEqual([expect.objectContaining({ principalUserId: P.a.id, decision: "approved", method: "passkey" })]);
    const before = { ...upstreamHits };
    const stillHeld = await call(tool, args);
    expect(stillHeld.kind).toBe("approval_required");
    expect((stillHeld as { approvalId: string }).approvalId).toBe(id);
    expect(upstreamHits.tool).toBe(before.tool);

    const second = await signAndDecide(P.b, id);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toMatchObject({ status: "approved", approvals: 2, quorum: 2 });
    const ran = await call(tool, args);
    expect(ran.kind, JSON.stringify(ran)).toBe("allowed");
    expect(upstreamHits.tool).toBe(before.tool + 1);
    expect((await row(id)).status).toBe("consumed");
    const again = await call(tool, args);
    expect(again.kind).toBe("approval_required"); // spent once
    const [reached] = await auditFor("approval-quorum-reached", id);
    expect(reached!.detail).toMatchObject({ quorum: 2, methods: { [P.a.id]: "passkey", [P.b.id]: "passkey" } });
    expect(new Set((reached!.detail as { approvingPrincipalUserIds: string[] }).approvingPrincipalUserIds)).toEqual(new Set([P.a.id, P.b.id]));
    // the receipt-eligible per-principal rows exist, and NO audit row carries an assertion
    const recorded = await auditFor("approval-decision-recorded", id);
    expect(recorded).toHaveLength(2);
    const stored = await db.select().from(approvalDecisions).where(eq(approvalDecisions.approvalId, id));
    for (const d of stored) {
      const signature = (d.assertion as { response: { signature: string } }).response.signature;
      for (const a of recorded) expect(JSON.stringify(a)).not.toContain(signature);
    }
  });

  it("the caller can never approve their own call (even as a member of the approver role)", async () => {
    const tool = nextTool();
    expect((await rule(tool)).statusCode).toBe(201);
    const id = await queued(tool, { text: "self" });
    const opts = await as(P.caller.s, "POST", `/v1/approvals/${id}/signing-options`, { decision: "approved" });
    expect(opts.statusCode, opts.body).toBe(403);
    expect(opts.json().error).toBe("caller_cannot_approve");
    const d = await decide(P.caller, id, "approved");
    expect(d.statusCode).toBe(403);
    expect(d.json().error).toBe("caller_cannot_approve");
  });

  it("someone delegation-linked to the caller counts as the caller", async () => {
    const tool = nextTool();
    expect((await rule(tool)).statusCode).toBe(201);
    const id = await queued(tool, { text: "linked" });
    await db.update(orgSettings).set({ approvalDelegationEnabled: true }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    const del = await asSteppedUpAdmin("POST", "/v1/delegations", {
      fromUserId: P.caller.id,
      toUserId: P.d.id,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(del.statusCode, del.body).toBe(201);
    try {
      const opts = await as(P.d.s, "POST", `/v1/approvals/${id}/signing-options`, { decision: "approved" });
      expect(opts.statusCode, opts.body).toBe(403);
      expect(opts.json().error).toBe("caller_cannot_approve");
    } finally {
      await asSteppedUpAdmin("DELETE", `/v1/delegations/${del.json().id}`, undefined);
    }
  });

  it("an admin outside the pool is not an approver of someone's tool call", async () => {
    const tool = nextTool();
    expect((await rule(tool)).statusCode).toBe(201);
    const id = await queued(tool, { text: "admin" });
    const r = await as(P.adm.s, "POST", `/v1/approvals/${id}/signing-options`, { decision: "approved" });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("not_the_named_approver");
  });

  it("same principal twice → 403 duplicate_approver, directly and through delegation (a delegate and their delegator are one)", async () => {
    const tool = nextTool();
    expect((await rule(tool, { quorum: 3 })).statusCode).toBe(201);
    // B4S-02: a delegation counts for a decision only when it existed before the call
    // was queued, so a's delegation to e (outside the pool) is set up first
    await db.update(orgSettings).set({ approvalDelegationEnabled: true }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    const delAE = await asSteppedUpAdmin("POST", "/v1/delegations", {
      fromUserId: P.a.id,
      toUserId: P.e.id,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(delAE.statusCode, delAE.body).toBe(201);
    const id = await queued(tool, { text: "dup" });
    expect((await signAndDecide(P.a, id)).statusCode).toBe(200);
    const again = await as(P.a.s, "POST", `/v1/approvals/${id}/signing-options`, { decision: "approved" });
    expect(again.statusCode).toBe(403);
    expect(again.json().error).toBe("duplicate_approver");
    // a decide with no signature is refused the same way (eligibility comes first)
    expect((await decide(P.a, id, "approved")).json().error).toBe("duplicate_approver");

    // b's delegation to d may come later: it only ever MERGES principals (stricter), live
    const delBD = await asSteppedUpAdmin("POST", "/v1/delegations", {
      fromUserId: P.b.id,
      toUserId: P.d.id,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(delBD.statusCode, delBD.body).toBe(201);
    try {
      // e (outside the pool) acting as a's delegate: a already approved
      const viaDelegate = await as(P.e.s, "POST", `/v1/approvals/${id}/signing-options`, { decision: "approved" });
      expect(viaDelegate.statusCode).toBe(403);
      expect(viaDelegate.json().error).toBe("duplicate_approver");
      // b approves; d (a pool member in their own right, but b's delegate) is the same principal as b
      expect((await signAndDecide(P.b, id)).statusCode).toBe(200);
      const dAsB = await as(P.d.s, "POST", `/v1/approvals/${id}/signing-options`, { decision: "approved" });
      expect(dAsB.statusCode).toBe(403);
      expect(dAsB.json().error).toBe("duplicate_approver");
      expect((await row(id)).status).toBe("pending"); // quorum 3, two principals
    } finally {
      await asSteppedUpAdmin("DELETE", `/v1/delegations/${delAE.json().id}`, undefined);
      await asSteppedUpAdmin("DELETE", `/v1/delegations/${delBD.json().id}`, undefined);
    }
  });

  it("any deny vetoes, even after an approval", async () => {
    const tool = nextTool();
    expect((await rule(tool)).statusCode).toBe(201);
    const args = { text: "veto" };
    const id = await queued(tool, args);
    expect((await signAndDecide(P.a, id)).statusCode).toBe(200);
    const deny = await signAndDecide(P.b, id, "denied");
    expect(deny.statusCode, deny.body).toBe(200);
    expect(deny.json()).toMatchObject({ status: "denied", approvals: 1, quorum: 2 });
    expect((await row(id)).status).toBe("denied");
    const [veto] = await auditFor("approval-vetoed", id);
    expect(veto!.detail).toMatchObject({ vetoedByPrincipalUserId: P.b.id, method: "passkey" });
    const late = await as(P.d.s, "POST", `/v1/approvals/${id}/signing-options`, { decision: "approved" });
    expect(late.statusCode).toBe(409);
    const before = upstreamHits.tool;
    expect((await call(tool, args)).kind).toBe("approval_required");
    expect(upstreamHits.tool).toBe(before);
  });

  it("concurrent decides serialise on the approval row lock: two approvals racing reach the quorum", async () => {
    const tool = nextTool();
    expect((await rule(tool)).statusCode).toBe(201);
    const id = await queued(tool, { text: "race" });
    const sigA = await signed(P.a, id, "approved");
    const sigB = await signed(P.b, id, "approved");
    // a barrier inside the decide transaction, after each decision is recorded
    // and the principals counted: if both transactions can be here at once (no
    // row lock) each has counted only itself and the quorum is never reached;
    // with the lock the second waits for the first to commit and counts both
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    approvalQuorumTestHooks.afterPrincipalsCounted = async () => {
      arrived += 1;
      if (arrived >= 2) release();
      await Promise.race([both, new Promise((r) => setTimeout(r, 750))]);
    };
    try {
      const [ra, rb] = await Promise.all([
        decide(P.a, id, "approved", { challengeId: sigA.challengeId, response: sigA.response }),
        decide(P.b, id, "approved", { challengeId: sigB.challengeId, response: sigB.response }),
      ]);
      expect(ra.statusCode, ra.body).toBe(200);
      expect(rb.statusCode, rb.body).toBe(200);
    } finally {
      approvalQuorumTestHooks.afterPrincipalsCounted = null;
    }
    expect((await row(id)).status).toBe("approved");
  });
});

describe("A — a pool that can never reach its quorum", () => {
  it("rule write: 422 quorum_unsatisfiable (role too small; approver is the subject; unknown role)", async () => {
    const tool = nextTool();
    // a + {b, d} = 3 principals (the caller is the user-scoped subject, excluded)
    const tooMany = await rule(tool, { quorum: 4 });
    expect(tooMany.statusCode, tooMany.body).toBe(422);
    expect(tooMany.json()).toMatchObject({ error: "quorum_unsatisfiable", quorum: 4, eligiblePrincipals: 3 });
    const self = await rule(tool, { approverUserId: P.caller.id, approverRoleId: null, quorum: 1 });
    expect(self.statusCode).toBe(422);
    expect(self.json().error).toBe("quorum_unsatisfiable");
    const noRole = await rule(tool, { approverRoleId: "00000000-0000-4000-a000-000000000009" });
    expect(noRole.statusCode).toBe(422);
    expect(noRole.json().error).toBe("unknown_role");
    const ok = await rule(tool, { quorum: 3 });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ quorum: 3, approverRoleId: roleId });
    // moving the rule to an approver who leaves the pool short is refused too
    const patch = await withKey(AUTH, "PATCH", `/v1/rules/approvals/${ok.json().id}`, { approverUserId: P.b.id });
    expect(patch.statusCode, patch.body).toBe(422);
    expect(patch.json().error).toBe("quorum_unsatisfiable");
  });

  it("PATCH runs the same check: quorum and approver role are editable, an unsatisfiable edit is 422 and changes nothing", async () => {
    const tool = nextTool();
    const made = await rule(tool, { quorum: 2 });
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json().id as string;
    const up = await withKey(AUTH, "PATCH", `/v1/rules/approvals/${id}`, { quorum: 3 });
    expect(up.statusCode, up.body).toBe(200);
    expect(up.json()).toMatchObject({ quorum: 3, approverRoleId: roleId });
    const tooMany = await withKey(AUTH, "PATCH", `/v1/rules/approvals/${id}`, { quorum: 4 });
    expect(tooMany.statusCode, tooMany.body).toBe(422);
    expect(tooMany.json()).toMatchObject({ error: "quorum_unsatisfiable", quorum: 4, eligiblePrincipals: 3 });
    const noRole = await withKey(AUTH, "PATCH", `/v1/rules/approvals/${id}`, { approverRoleId: null });
    expect(noRole.statusCode).toBe(422);
    expect(noRole.json().error).toBe("quorum_unsatisfiable");
    const badRole = await withKey(AUTH, "PATCH", `/v1/rules/approvals/${id}`, { approverRoleId: "00000000-0000-4000-a000-000000000009" });
    expect(badRole.statusCode).toBe(422);
    expect(badRole.json().error).toBe("unknown_role");
    const outOfRange = await withKey(AUTH, "PATCH", `/v1/rules/approvals/${id}`, { quorum: 6 });
    expect(outOfRange.statusCode).toBe(400);
    const [after] = await db.select().from(approvalRules).where(eq(approvalRules.id, id));
    expect(after).toMatchObject({ quorum: 3, approverRoleId: roleId });
  });

  it("the version path runs it too: minting (draft or active) and activating an unsatisfiable approval-rule version is 422", async () => {
    const tool = nextTool();
    const made = await rule(tool, { quorum: 2 });
    const id = made.json().id as string;
    const versions = async () => (await db.select().from(configVersions).where(eq(configVersions.artifactId, id))).length;
    // the subject named as approver with no role: nobody else can ever approve
    const self = await withKey(AUTH, "POST", `/v1/config-versions/approval_rule/${id}`, {
      body: { approverUserId: P.caller.id, approverRoleId: null, quorum: 1 },
      activate: true,
    });
    expect(self.statusCode, self.body).toBe(422);
    expect(self.json().error).toBe("quorum_unsatisfiable");
    const draft = await withKey(AUTH, "POST", `/v1/config-versions/approval_rule/${id}`, { body: { quorum: 5 }, activate: false });
    expect(draft.statusCode).toBe(422);
    expect(await versions()).toBe(0);
    // a satisfiable draft is stored; when the pool shrinks before it is activated, activation is refused
    const ok = await withKey(AUTH, "POST", `/v1/config-versions/approval_rule/${id}`, { body: { quorum: 3 }, activate: false });
    expect(ok.statusCode, ok.body).toBe(201);
    await db.update(usersTable).set({ disabledAt: new Date() }).where(eq(usersTable.id, P.d.id));
    try {
      const act = await withKey(AUTH, "POST", `/v1/config-versions/approval_rule/${id}/activate`, { version: ok.json().version.version });
      expect(act.statusCode, act.body).toBe(422);
      expect(act.json().error).toBe("quorum_unsatisfiable");
    } finally {
      await db.update(usersTable).set({ disabledAt: null }).where(eq(usersTable.id, P.d.id));
    }
    const [after] = await db.select().from(approvalRules).where(eq(approvalRules.id, id));
    expect(after!.quorum).toBe(2);
  });

  it("the create choke point the copilot's rule_to_approval applier calls refuses an unsatisfiable rule", async () => {
    const tool = nextTool();
    const before = (await db.select().from(approvalRules).where(eq(approvalRules.toolName, tool))).length;
    await expect(
      createApprovalRuleRow(db, {
        scope: "user",
        serverScope: "server",
        userId: P.caller.id,
        serverId,
        toolName: tool,
        approverUserId: P.caller.id,
      }),
    ).rejects.toBeInstanceOf(ApprovalRuleWriteRefusedError);
    expect((await db.select().from(approvalRules).where(eq(approvalRules.toolName, tool))).length).toBe(before);
  });

  it("queue time: a pool that shrank below the quorum DENIES the call and audits it", async () => {
    const tool = nextTool();
    const [small] = await db.insert(roles).values({ name: `b4ab small ${RUN}` }).returning({ id: roles.id });
    await db.insert(roleAssignments).values({ userId: P.e.id, roleId: small!.id });
    const r = await rule(tool, { approverRoleId: small!.id, quorum: 2 });
    expect(r.statusCode, r.body).toBe(201);
    await db.update(usersTable).set({ disabledAt: new Date() }).where(eq(usersTable.id, P.e.id));
    try {
      const out = await call(tool, { text: "shrunk" });
      expect(out.kind).toBe("denied");
      expect((out as { decision: { ruleId: string } }).decision.ruleId).toBe("approval-quorum-unsatisfiable");
      const [audited] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.ruleId, "approval-quorum-unsatisfiable"), eq(auditLog.toolName, tool)));
      expect(audited!.detail).toMatchObject({ quorum: 2, eligiblePrincipals: 1 });
      expect(await db.select().from(approvals).where(eq(approvals.toolName, tool))).toHaveLength(0);
    } finally {
      await db.update(usersTable).set({ disabledAt: null }).where(eq(usersTable.id, P.e.id));
    }
  });

  it("a call attributed to a project carrying an in-app-only classification needs the sensitive quorum", async () => {
    const [profile] = await db
      .insert(complianceProfiles)
      .values({ tag: `b4ab-sensitive-${RUN}`, piiMode: "block", mcpDefaultMode: "read_write" })
      .returning();
    const [project] = await db
      .insert(projects)
      .values({ name: `b4ab-sensitive-${RUN}`, classifications: [profile!.tag] })
      .returning({ id: projects.id });
    const sensitiveTool = nextTool();
    expect((await rule(sensitiveTool, { quorum: 1 })).statusCode).toBe(201);
    const id = await queued(sensitiveTool, { text: "sensitive" }, project!.id);
    expect((await row(id)).quorum).toBe(2); // max(rule 1, sensitive 2)
    // the same rule shape with nobody but the named approver: dual control cannot be met → denied
    const lonelyTool = nextTool();
    expect((await rule(lonelyTool, { quorum: 1, approverRoleId: null })).statusCode).toBe(201);
    const out = await call(lonelyTool, { text: "alone" }, project!.id);
    expect(out.kind).toBe("denied");
    // B4S-03: the header only RAISES the quorum. A caller who works on no
    // sensitive project, calling unattributed, needs the rule's one approver…
    const plain = await queued(lonelyTool, { text: "unattributed" });
    expect((await row(plain)).quorum).toBe(1);
    // …but once the caller is a member of the sensitive project, leaving the
    // header off (or naming a project that is not sensitive) no longer drops
    // the sensitive quorum: the lonely rule cannot reach it, so the call is denied
    const [plainProject] = await db.insert(projects).values({ name: `b4ab-plain-${RUN}` }).returning({ id: projects.id });
    await db.insert(projectMembers).values({ projectId: project!.id, userId: P.caller.id, role: "contributor" });
    try {
      for (const attributed of [undefined, plainProject!.id]) {
        const out2 = await call(lonelyTool, { text: `member-${attributed ?? "none"}` }, attributed);
        expect(out2.kind, JSON.stringify(out2)).toBe("denied");
        expect((out2 as { decision: { ruleId: string } }).decision.ruleId).toBe("approval-quorum-unsatisfiable");
      }
      const [audited] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.ruleId, "approval-quorum-unsatisfiable"), eq(auditLog.toolName, lonelyTool)))
        .orderBy(desc(auditLog.seq))
        .limit(1);
      expect(audited!.detail).toMatchObject({ quorum: 2, sensitive: true, sensitiveBecause: ["caller_membership"] });
    } finally {
      await db.delete(projectMembers).where(eq(projectMembers.userId, P.caller.id));
    }
  });
});

// ---------------------------------------------------------------------------
// B — passkey signatures
// ---------------------------------------------------------------------------

describe("B — what a signature must be", () => {
  let tool: string;
  beforeAll(async () => {
    tool = nextTool();
    expect((await rule(tool, { quorum: 1 })).statusCode).toBe(201);
  });

  it("the signing options' challenge is base64url(sha256(canonical payload)) of the exact call, user verification required", async () => {
    const id = await queued(tool, { text: "options" });
    const r = await row(id);
    const o = await as(P.a.s, "POST", `/v1/approvals/${id}/signing-options`, { decision: "approved" });
    expect(o.statusCode, o.body).toBe(200);
    const body = o.json();
    expect(body.signedPayload).toMatchObject({
      v: "regulait.approval-sign.v1",
      approvalId: id,
      decision: "approved",
      argumentsDigest: r.argumentsDigest,
      contextDigest: r.contextDigest,
      serverId,
      toolName: tool,
    });
    expect(body.options.userVerification).toBe("required");
    expect(body.options.rpId).toBe("localhost");
    const { canonicalJson } = await import("@regulait/shared");
    expect(body.options.challenge).toBe(createHash("sha256").update(canonicalJson(body.signedPayload)).digest("base64url"));
  });

  it("no signature, or an API key → 403 passkey_signature_required", async () => {
    const id = await queued(tool, { text: "unsigned" });
    const bare = await decide(P.a, id, "approved");
    expect(bare.statusCode).toBe(403);
    expect(bare.json().error).toBe("passkey_signature_required");
    const key = await withKey(P.a.key, "POST", `/v1/approvals/${id}/decide`, { decision: "approved", reason: "key" });
    expect(key.statusCode).toBe(403);
    expect(key.json().error).toBe("passkey_signature_required");
    expect((await row(id)).status).toBe("pending");
  });

  it("a signature over a different decision, or a different approval, is 422 passkey_signature_invalid", async () => {
    const id = await queued(tool, { text: "other-decision" });
    const sig = await signed(P.a, id, "approved");
    const wrongDecision = await decide(P.a, id, "denied", { challengeId: sig.challengeId, response: sig.response });
    expect(wrongDecision.statusCode, wrongDecision.body).toBe(422);
    expect(wrongDecision.json().error).toBe("passkey_signature_invalid");

    const other = await queued(tool, { text: "other-approval" });
    const sig2 = await signed(P.a, id, "approved");
    const wrongApproval = await decide(P.a, other, "approved", { challengeId: sig2.challengeId, response: sig2.response });
    expect(wrongApproval.statusCode).toBe(422);
    expect(wrongApproval.json().error).toBe("passkey_signature_invalid");
    expect((await row(id)).status).toBe("pending");
    expect((await row(other)).status).toBe("pending");
  });

  it("the call changed after the options were issued → 409 approval_action_changed", async () => {
    const id = await queued(tool, { text: "changed" });
    const sig = await signed(P.a, id, "approved");
    await db.update(approvals).set({ argumentsDigest: "f".repeat(64) }).where(eq(approvals.id, id));
    const r = await decide(P.a, id, "approved", { challengeId: sig.challengeId, response: sig.response });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe("approval_action_changed");
  });

  it("a ceremony is single use (409 passkey_challenge_used) and dies (409 passkey_challenge_expired)", async () => {
    const id = await queued(tool, { text: "ceremony" });
    const sig = await signed(P.a, id, "approved");
    // first attempt burns the ceremony even though its assertion is wrong
    const tampered = { ...sig.response, response: { ...(sig.response.response as object), signature: Buffer.from("nope").toString("base64url") } };
    const bad = await decide(P.a, id, "approved", { challengeId: sig.challengeId, response: tampered });
    expect(bad.statusCode).toBe(422);
    const reused = await decide(P.a, id, "approved", { challengeId: sig.challengeId, response: sig.response });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error).toBe("passkey_challenge_used");

    const sig2 = await signed(P.a, id, "approved");
    await db.execute(
      sql`UPDATE webauthn_challenges SET created_at = now() - interval '10 minutes', expires_at = now() - interval '6 minutes' WHERE id = ${sig2.challengeId}`,
    );
    const expired = await decide(P.a, id, "approved", { challengeId: sig2.challengeId, response: sig2.response });
    expect(expired.statusCode).toBe(409);
    expect(expired.json().error).toBe("passkey_challenge_expired");
    expect((await row(id)).status).toBe("pending");
  });

  it("another user's credential, a cloned authenticator (counter replay) and a revoked credential are refused", async () => {
    const id = await queued(tool, { text: "credentials" });
    // b's ceremony signed with a's passkey
    const foreign = await signed(P.b, id, "approved", P.a.auth);
    const r1 = await decide(P.b, id, "approved", { challengeId: foreign.challengeId, response: foreign.response });
    expect(r1.statusCode).toBe(422);
    expect(r1.json().error).toBe("passkey_signature_invalid");

    // a clone of d's authenticator whose counter is behind the server's
    const real = await signed(P.d, id, "approved");
    const clone = Object.assign(Object.create(Object.getPrototypeOf(P.d.auth)), P.d.auth) as SoftAuthenticator;
    expect((await decide(P.d, id, "approved", { challengeId: real.challengeId, response: real.response })).statusCode).toBe(200);
    clone.counter = 0;
    const id2 = await queued(tool, { text: "credentials-2" });
    const replay = await signed(P.d, id2, "approved", clone);
    const r2 = await decide(P.d, id2, "approved", { challengeId: replay.challengeId, response: replay.response });
    expect(r2.statusCode, r2.body).toBe(422);
    expect(r2.json().error).toBe("passkey_signature_invalid");

    // a revoked passkey cannot sign
    await db
      .update(webauthnCredentials)
      .set({ revokedAt: new Date(), revokeReason: "b4ab test" })
      .where(eq(webauthnCredentials.userId, P.b.id));
    const id3 = await queued(tool, { text: "credentials-3" });
    const noKeys = await as(P.b.s, "POST", `/v1/approvals/${id3}/signing-options`, { decision: "approved" });
    expect(noKeys.statusCode).toBe(403);
    expect(noKeys.json()).toMatchObject({ error: "passkey_signature_required", enrolled: false });
    // a ceremony obtained before the revoke cannot be completed after it
    await db.update(webauthnCredentials).set({ revokedAt: null, revokeReason: null }).where(eq(webauthnCredentials.userId, P.b.id));
    const before = await signed(P.b, id3, "approved");
    await db
      .update(webauthnCredentials)
      .set({ revokedAt: new Date(), revokeReason: "b4ab test" })
      .where(eq(webauthnCredentials.userId, P.b.id));
    const r3 = await decide(P.b, id3, "approved", { challengeId: before.challengeId, response: before.response });
    expect(r3.statusCode).toBe(422);
    expect(r3.json().error).toBe("passkey_signature_invalid");
    await db.update(webauthnCredentials).set({ revokedAt: null, revokeReason: null }).where(eq(webauthnCredentials.userId, P.b.id));
    expect((await row(id3)).status).toBe("pending");
  });
});

describe("B — the execution recheck", () => {
  it("an approval whose row was tampered to another payload is superseded, the call refused and audited, the tool never runs", async () => {
    const tool = nextTool();
    expect((await rule(tool, { quorum: 1 })).statusCode).toBe(201);
    const id = await queued(tool, { text: "signed-args" });
    expect((await signAndDecide(P.a, id)).json()).toMatchObject({ status: "approved" });
    // someone rewrites the approved row's digest to a different payload
    const mutated = { text: "mutated-args" };
    await db
      .update(approvals)
      .set({ argumentsDigest: approvalArgumentsDigest({ projectId: null, arguments: mutated }) })
      .where(eq(approvals.id, id));
    const before = { ...upstreamHits };
    const out = await call(tool, mutated);
    expect(out.kind, JSON.stringify(out)).toBe("denied");
    expect((out as { decision: { ruleId: string } }).decision.ruleId).toBe(APPROVAL_SIGNATURE_RECHECK_FAILED_RULE);
    // the tool never ran (the consent is spent right before tools/call, after the session opens)
    expect(upstreamHits.tool).toBe(before.tool);
    expect((await row(id)).status).toBe("superseded");
    const [audited] = await auditFor(APPROVAL_SIGNATURE_RECHECK_FAILED_RULE, id);
    expect(audited!.detail).toMatchObject({ why: "payload_mismatch", principalUserId: P.a.id });
  });

  it("the recheck binds the target and tool too, and fails closed without call facts or a relying party", async () => {
    const tool = nextTool();
    expect((await rule(tool, { quorum: 1 })).statusCode).toBe(201);
    const fresh = async () => {
      const id = await queued(tool, { text: `facts-${randomBytes(2).toString("hex")}` });
      expect((await signAndDecide(P.a, id)).json()).toMatchObject({ status: "approved" });
      return row(id);
    };
    const epoch = Number(((await db.execute(sql`SELECT epoch FROM governance_policy_epoch`)).rows[0] as { epoch: number }).epoch);
    const spend = (r: Awaited<ReturnType<typeof fresh>>, callFacts?: { serverId?: string; toolName: string }) =>
      consumeBoundApproval(db, {
        approvalId: r.id,
        policyEpoch: Number(epoch),
        approvalScope: "action",
        argumentsDigest: r.argumentsDigest!,
        contextDigest: r.contextDigest!,
        ...(callFacts ? { call: callFacts } : {}),
      });
    const otherTool = await fresh();
    expect(await spend(otherTool, { serverId, toolName: `${tool}_renamed` })).toBe(false);
    expect((await row(otherTool.id)).status).toBe("superseded");
    const noFacts = await fresh();
    expect(await spend(noFacts)).toBe(false);
    expect((await row(noFacts.id)).status).toBe("superseded");
    const good = await fresh();
    delete process.env.REGULAIT_PUBLIC_URL;
    try {
      expect(await spend(good, { serverId, toolName: tool })).toBe(false);
    } finally {
      process.env.REGULAIT_PUBLIC_URL = PUBLIC_URL;
    }
    expect((await row(good.id)).status).toBe("superseded");
    const fine = await fresh();
    expect(await spend(fine, { serverId, toolName: tool })).toBe(true);
    const whys = (await db.select().from(auditLog).where(eq(auditLog.ruleId, APPROVAL_SIGNATURE_RECHECK_FAILED_RULE)))
      .map((a) => (a.detail as { why: string }).why);
    expect(whys).toEqual(expect.arrayContaining(["payload_mismatch", "no_call_facts", "passkey_rp_unconfigured"]));
  });
});

describe("A — the recheck counts principals as the decide does", () => {
  it("two approvals that became one principal (a delegation since) no longer meet a quorum of 2 at execution", async () => {
    const tool = nextTool();
    expect((await rule(tool)).statusCode).toBe(201);
    const args = { text: "collapsed" };
    const id = await queued(tool, args);
    expect((await signAndDecide(P.a, id)).statusCode).toBe(200);
    expect((await signAndDecide(P.b, id)).json()).toMatchObject({ status: "approved", approvals: 2 });
    await db.update(orgSettings).set({ approvalDelegationEnabled: true }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    const del = await asSteppedUpAdmin("POST", "/v1/delegations", {
      fromUserId: P.a.id,
      toUserId: P.b.id,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(del.statusCode, del.body).toBe(201);
    try {
      const before = upstreamHits.tool;
      const out = await call(tool, args);
      expect(out.kind).toBe("denied");
      expect(upstreamHits.tool).toBe(before);
      const [audited] = await auditFor(APPROVAL_SIGNATURE_RECHECK_FAILED_RULE, id);
      expect(audited!.detail).toMatchObject({ why: "below_quorum" });
    } finally {
      await asSteppedUpAdmin("DELETE", `/v1/delegations/${del.json().id}`, undefined);
    }
  });
});

describe("B — channels, modes and the relying party", () => {
  it("bulk decide refuses an individual-signature approval by name", async () => {
    const tool = nextTool();
    expect((await rule(tool, { quorum: 1 })).statusCode).toBe(201);
    const id = await queued(tool, { text: "bulk" });
    const r = await as(P.a.s, "POST", "/v1/approvals/bulk", { approvalIds: [id], decision: "approved", reason: "bulk" });
    expect(r.statusCode, r.body).toBe(207);
    expect(r.json().results).toEqual([expect.objectContaining({ approvalId: id, ok: false, status: 409, error: "approval_requires_individual_signature" })]);
    expect((await row(id)).status).toBe("pending");
  });

  it("step_up mode: the decide needs an approval_decide step-up bound to this approval and decision; an API key cannot", async () => {
    await setMode("step_up");
    try {
      const tool = nextTool();
      expect((await rule(tool, { quorum: 1 })).statusCode).toBe(201);
      const id = await queued(tool, { text: "step-up" });
      expect((await row(id)).signatureMode).toBe("step_up");
      const refused = await decide(P.a, id, "approved");
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json()).toMatchObject({
        error: "step_up_required",
        actionKind: "approval_decide",
        action: { kind: "approval_decide", body: { approvalId: id, decision: "approved" } },
      });
      const o = await as(P.a.s, "POST", "/v1/auth/step-up/options", { action: refused.json().action });
      const v = await as(P.a.s, "POST", "/v1/auth/step-up/verify", {
        stepUpId: o.json().stepUpId,
        method: "passkey",
        response: P.a.auth.authenticate(o.json().passkey.options),
      });
      expect(v.statusCode, v.body).toBe(200);
      const ok = await as(P.a.s, "POST", `/v1/approvals/${id}/decide`, { decision: "approved" }, { [STEP_UP_HEADER]: v.json().stepUpToken });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({ status: "approved", decisions: [expect.objectContaining({ method: "passkey" })] });
      const [stored] = await db.select().from(approvalDecisions).where(eq(approvalDecisions.approvalId, id));
      expect(stored!.signedPayload).toBeNull(); // a step-up is not a signature over the call

      const id2 = await queued(tool, { text: "step-up-key" });
      const key = await withKey(P.a.key, "POST", `/v1/approvals/${id2}/decide`, { decision: "approved" });
      expect(key.statusCode).toBe(403);
      expect(key.json()).toMatchObject({ error: "step_up_required", methods: [] });
      const bulk = await as(P.a.s, "POST", "/v1/approvals/bulk", { approvalIds: [id2], decision: "approved", reason: "bulk" });
      expect(bulk.json().results[0]).toMatchObject({ ok: false, error: "approval_requires_individual_signature" });
    } finally {
      await setMode("passkey");
    }
  });

  it("off mode (an audited relaxation): a plain decision is recorded with method none, quorum still applies", async () => {
    await setMode("off");
    try {
      const tool = nextTool();
      expect((await rule(tool)).statusCode).toBe(201);
      const id = await queued(tool, { text: "off" });
      const first = await decide(P.a, id, "approved");
      expect(first.json()).toMatchObject({ status: "pending", approvals: 1, decisions: [expect.objectContaining({ method: "none" })] });
      expect((await decide(P.a, id, "approved")).json().error).toBe("duplicate_approver");
      expect((await decide(P.b, id, "approved")).json()).toMatchObject({ status: "approved", approvals: 2 });
    } finally {
      await setMode("passkey");
    }
  });

  it("REGULAIT_PUBLIC_URL unset: passkey-mode approvals fail closed (409 passkey_rp_unconfigured) and posture says so", async () => {
    const tool = nextTool();
    expect((await rule(tool, { quorum: 1 })).statusCode).toBe(201);
    const id = await queued(tool, { text: "no-rp" });
    delete process.env.REGULAIT_PUBLIC_URL;
    try {
      const o = await as(P.a.s, "POST", `/v1/approvals/${id}/signing-options`, { decision: "approved" });
      expect(o.statusCode).toBe(409);
      expect(o.json().error).toBe("passkey_rp_unconfigured");
      const d = await decide(P.a, id, "approved", { challengeId: "00000000-0000-4000-a000-000000000001", response: {} });
      expect(d.statusCode).toBe(409);
      expect(d.json().error).toBe("passkey_rp_unconfigured");
      const posture = await withKey(AUTH, "GET", "/v1/org/posture");
      expect(posture.json().approvalSigning).toMatchObject({ mode: "passkey", rpConfigured: false, failClosed: true });
      expect(approvalSigningPosture("off")).toMatchObject({ failClosed: false });
    } finally {
      process.env.REGULAIT_PUBLIC_URL = PUBLIC_URL;
    }
    expect((await row(id)).status).toBe("pending");
  });

  it("the queue shows quorum progress and per-principal decisions, and role members see the row", async () => {
    const tool = nextTool();
    expect((await rule(tool)).statusCode).toBe(201);
    const id = await queued(tool, { text: "queue" });
    expect((await signAndDecide(P.a, id)).statusCode).toBe(200);
    const list = await as(P.d.s, "GET", "/v1/approvals?status=pending");
    expect(list.statusCode).toBe(200);
    const mine = (list.json().approvals as Array<Record<string, unknown>>).find((r) => r.id === id);
    expect(mine).toMatchObject({ quorum: 2, approvalsCount: 1, signatureMode: "passkey", myDecision: null });
    expect(mine!.decisions).toEqual([expect.objectContaining({ principalUserId: P.a.id, principalName: "b4ab approver-a", method: "passkey" })]);
    const aView = (await as(P.a.s, "GET", "/v1/approvals")).json().approvals.find((r: { id: string }) => r.id === id);
    expect(aView.myDecision).toBe("approved");
    // the caller (a role member) does not get their own call in the queue
    const callerView = (await as(P.caller.s, "GET", "/v1/approvals")).json().approvals as Array<{ id: string }>;
    expect(callerView.find((r) => r.id === id)).toBeUndefined();
  });
});
