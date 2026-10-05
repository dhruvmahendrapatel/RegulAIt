import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  and,
  approvals,
  asc,
  auditLog,
  createDb,
  desc,
  eq,
  gte,
  runMigrations,
  type Db,
} from "@regulait/db";
import { DEFAULT_APPROVAL_TTL_HOURS } from "@regulait/shared";
import { buildApp } from "./app.js";
import { governedEvaluate } from "./governed-evaluate.js";
import { consumeBoundApproval, executeGovernedToolCall } from "./mcp-proxy.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";

// ADR-0181: this file pins behaviour against a LOCAL MCP double (127.0.0.1, registered
// seconds ago), not the strict admission defaults — relaxed explicitly, restored after.
let restoreStrictAdmission: (() => Promise<void>) | undefined;

/**
 * F14 / ADR-0105 — A CONSENT IS BOUND TO THE POLICY THAT DEMANDED IT, AND IT
 * DOES NOT LIVE FOREVER.
 *
 * ADR-0104 bound an approval to its PAYLOAD. It did not bind it to the POLICY
 * CONTEXT, and approvals never expired. Two gaps, both exercised here:
 *
 *   (a) STALE POLICY / STALE APPROVER. A consent queued and signed under rule
 *       version A stayed spendable after a stricter version B activated, or
 *       after the rule was edited to name a different required approver — an
 *       authorization time-of-check/time-of-use gap.
 *   (b) NO EXPIRY. An approved, unconsumed row was spendable indefinitely.
 *
 * The acceptance standard is the one ADR-0103's suite set and ADR-0104's kept:
 * a refusal must not merely return an error, it must never have CONTACTED the
 * upstream. The fake upstream below counts BOTH its HTTP requests and its
 * tool-handler invocations, and every fail-closed assertion asserts a zero
 * delta on both.
 *
 * Also asserted, deliberately: the changes that must NOT invalidate a consent.
 * A compatibility rule that only ever says "no" is not a rule, it is a reset.
 *
 * Shares one DB (fileParallelism off): every assertion is a DELTA or is scoped
 * to a per-run fixture, never an absolute count over a shared table. Prefix
 * f14-, per-run suffix, so the file is re-runnable.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "f14-bootstrap-token";
const RUN = Math.random().toString(36).slice(2, 8);
const AUTH = { authorization: `Bearer ${BOOT}` };

/** one tool per scenario, so a rule edited for one test can never perturb
 * another — the rules are per-tool and the digests are per-matched-rule-set */
const VERSIONED = `f14_versioned_${RUN}`;
const APPROVER_SWAP = `f14_approver_${RUN}`;
const TTL = `f14_ttl_${RUN}`;
const STABLE = `f14_stable_${RUN}`;
const RACE = `f14_race_${RUN}`;
const LEGACY = `f14_legacy_${RUN}`;
const EPOCH = `f14_epoch_${RUN}`;
const ABAC_ONLY = `f14_abac_only_${RUN}`;
/** never called — it exists only to be the SUBJECT of an unrelated rule edit */
const UNRELATED = `f14_unrelated_${RUN}`;
const TOOLS = [VERSIONED, APPROVER_SWAP, TTL, STABLE, RACE, LEGACY, EPOCH, ABAC_ONLY, UNRELATED];

/** The two independent proofs that a refused call never reached upstream. */
const upstreamHits = { http: 0, tool: 0 };
const snapshotUpstream = () => ({ ...upstreamHits });

let db: Db;
let app: ReturnType<typeof buildApp>;
let upstreamClose: () => Promise<void>;
let serverId: string;
let callerId: string;
/** the approver every rule names to begin with */
let approverA: string;
/** the approver a rule is later edited to name instead */
let approverB: string;
const ruleIdFor = new Map<string, string>();

function buildUpstreamMcpServer(): McpServer {
  const server = new McpServer({ name: "f14-upstream", version: "0.0.1" });
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
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      void (async () => {
        const server = buildUpstreamMcpServer();
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

async function mkUser(email: string): Promise<string> {
  const r = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email.split("@")[0] },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

/** Trap-1 guard: NEVER pass `arguments: undefined` — the governed layer would
 * return an allow whose upstream then rejected on validation, i.e. an "allow"
 * that never ran. Every call in this file goes through here with a real bag. */
function call(toolName: string, args: Record<string, unknown>) {
  return executeGovernedToolCall(db, undefined, {
    userId: callerId,
    serverId,
    toolName,
    arguments: args,
  });
}

/** rows for this caller/tool in a DEFINED order (trap 2: an unordered
 * `.select()` indexed with [0] / .at(-1) is a latent flake — Postgres
 * guarantees no row order). */
async function rowsFor(toolName: string, status: "pending" | "approved" | "superseded" | "consumed") {
  return db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.userId, callerId),
        eq(approvals.serverId, serverId),
        eq(approvals.toolName, toolName),
        eq(approvals.status, status),
      ),
    )
    .orderBy(asc(approvals.requestedAt));
}

async function approve(approvalId: string, approverUserId: string) {
  const r = await db
    .update(approvals)
    .set({ status: "approved", decidedBy: approverUserId, decidedAt: new Date() })
    .where(eq(approvals.id, approvalId))
    .returning({ id: approvals.id });
  expect(r).toHaveLength(1);
}

/** The precondition every test starts from: an approver has signed THIS payload
 * for THIS tool, under whatever policy is currently in force. */
async function queueAndApprove(
  toolName: string,
  args: Record<string, unknown>,
  approverUserId = approverA,
): Promise<string> {
  const before = new Set((await rowsFor(toolName, "pending")).map((r) => r.id));
  const out = await call(toolName, args);
  expect(out.kind).toBe("approval_required");
  const fresh = (await rowsFor(toolName, "pending")).filter((r) => !before.has(r.id));
  expect(fresh).toHaveLength(1);
  await approve(fresh[0]!.id, approverUserId);
  return fresh[0]!.id;
}

/** Mint a NEW active `config_versions` version of an approval rule — ADR-0073's
 * own route, not a direct table write, so what the test activates is exactly
 * what an admin would activate. */
async function activateRuleVersion(ruleId: string, body: Record<string, unknown>) {
  const r = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/config-versions/approval_rule/${ruleId}`,
    payload: { body, activate: true },
  });
  expect(r.statusCode).toBe(201);
  expect(r.json().activated).toBe(true);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "f".repeat(64) });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const up = await startUpstream();
  upstreamClose = up.close;

  const s = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/servers",
    payload: { name: `f14-server-${RUN}`, url: up.url },
  });
  serverId = s.json().id;
  for (const name of TOOLS) {
    // register the inventory row WITH its kind, so no manifest sync — and thus
    // no upstream contact — is ever needed before governance runs. `write`
    // because the rules below are writeOnly to begin with.
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/servers/${serverId}/tools`,
      payload: { name, kind: "write" },
    });
  }

  callerId = await mkUser(`f14-caller-${RUN}@example.com`);
  approverA = await mkUser(`f14-approver-a-${RUN}@example.com`);
  approverB = await mkUser(`f14-approver-b-${RUN}@example.com`);
  for (const name of TOOLS) {
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/tools",
      payload: { userId: callerId, serverId, toolName: name },
    });
    if (name === ABAC_ONLY) continue;
    // `approvalScope` omitted: the shipped ADR-0104 default, 'action'.
    // `writeOnly: true` gives every rule a versionable field that can later be
    // widened to `false` — a genuinely STRICTER posture (the rule then gates
    // reads as well as writes) that still matches this write tool, so the
    // version change is a real policy tightening and not a contrivance that
    // stops the rule matching.
    const rule = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/rules/approvals",
      payload: { userId: callerId, serverId, toolName: name, approverUserId: approverA, writeOnly: true },
    });
    expect(rule.statusCode).toBe(201);
    ruleIdFor.set(name, rule.json().id as string);
  }
});

afterAll(async () => {
  await restoreStrictAdmission?.();
  app.server.closeAllConnections();
  await app.close();
  await upstreamClose();
});

describe("F14 (a) — a consent does not survive the policy that demanded it", () => {
  it("NEGATIVE CONTROL: activating a STRICTER version of the matched rule fails the identical payload CLOSED, with zero upstream contact", async () => {
    // This is the finding, stated as a test. Before ADR-0105 the consumption
    // predicate was `WHERE id = ? AND status = 'approved'` — no context check
    // at all — so a consent signed under version A executed happily under
    // version B.
    const args = { text: `f14-versioned-${RUN}` };
    const signed = await queueAndApprove(VERSIONED, args);

    // ...and to prove the consent really was spendable a moment ago, the same
    // digest matched: the row is still `approved` right up to the activation.
    const [beforeRow] = await db.select().from(approvals).where(eq(approvals.id, signed));
    expect(beforeRow!.status).toBe("approved");
    expect(beforeRow!.contextDigest).toBeTruthy();

    // THE POLICY MOVES. writeOnly true -> false widens the rule from "gate
    // writes" to "gate everything", which is strictly stricter and still
    // matches this write tool.
    await activateRuleVersion(ruleIdFor.get(VERSIONED)!, { writeOnly: false });

    const before = snapshotUpstream();
    const out = await call(VERSIONED, args);

    expect(out.kind).toBe("approval_context_stale");
    // THE acceptance criterion: the upstream was never spoken to at all —
    // neither an HTTP request nor a tool invocation.
    expect(snapshotUpstream()).toEqual(before);

    if (out.kind === "approval_context_stale") {
      // the stale consent was retired VISIBLY, not silently skipped
      expect(out.supersededApprovalIds).toContain(signed);
      const [after] = await db.select().from(approvals).where(eq(approvals.id, signed));
      expect(after!.status).toBe("superseded");
      expect(after!.status).not.toBe("consumed");

      // ...and a replacement was raised, carrying the CURRENT context
      expect(out.requeuedApprovalId).toBeTruthy();
      const [replacement] = await db
        .select()
        .from(approvals)
        .where(eq(approvals.id, out.requeuedApprovalId!));
      expect(replacement!.status).toBe("pending");
      expect(replacement!.contextDigest).toBeTruthy();
      expect(replacement!.contextDigest).not.toBe(after!.contextDigest);
      // the PAYLOAD is unchanged — only the policy moved
      expect(replacement!.argumentsDigest).toBe(after!.argumentsDigest);
    }
  });

  it("the replacement approval, once signed under the CURRENT policy, does execute", async () => {
    // The fix must be self-healing, not a permanent wall: re-signing under the
    // policy that is actually in force restores the call.
    const args = { text: `f14-versioned-${RUN}` };
    const pending = await rowsFor(VERSIONED, "pending");
    expect(pending.length).toBeGreaterThan(0);
    await approve(pending[pending.length - 1]!.id, approverA);

    const beforeTool = upstreamHits.tool;
    const out = await call(VERSIONED, args);
    expect(out.kind).toBe("allowed");
    expect(upstreamHits.tool).toBe(beforeTool + 1);
  });

  it("changing the REQUIRED APPROVER fails the identical payload closed, with zero upstream contact", async () => {
    const args = { text: `f14-approver-${RUN}` };
    const signed = await queueAndApprove(APPROVER_SWAP, args);
    const [beforeRow] = await db.select().from(approvals).where(eq(approvals.id, signed));
    expect(beforeRow!.approverUserId).toBe(approverA);

    // the rule now names someone else. The stored row still carries approver A's
    // signature; policy now requires B's.
    await activateRuleVersion(ruleIdFor.get(APPROVER_SWAP)!, { approverUserId: approverB });

    const before = snapshotUpstream();
    const out = await call(APPROVER_SWAP, args);

    expect(out.kind).toBe("approval_context_stale");
    expect(snapshotUpstream()).toEqual(before);
    if (out.kind === "approval_context_stale") {
      expect(out.supersededApprovalIds).toContain(signed);
      // the replacement is addressed to the approver policy CURRENTLY requires
      const [replacement] = await db
        .select()
        .from(approvals)
        .where(eq(approvals.id, out.requeuedApprovalId!));
      expect(replacement!.approverUserId).toBe(approverB);
    }
    const [after] = await db.select().from(approvals).where(eq(approvals.id, signed));
    expect(after!.status).toBe("superseded");
  });
});

describe("F14 (b) — a consent does not live forever", () => {
  it("a freshly queued approval is stamped with an expiry from the 72-hour shipped default", async () => {
    const before = new Set((await rowsFor(TTL, "pending")).map((r) => r.id));
    const out = await call(TTL, { text: `f14-ttl-stamp-${RUN}` });
    expect(out.kind).toBe("approval_required");
    const fresh = (await rowsFor(TTL, "pending")).filter((r) => !before.has(r.id));
    expect(fresh).toHaveLength(1);
    const row = fresh[0]!;
    expect(row.expiresAt).not.toBeNull();
    const hours = (row.expiresAt!.getTime() - row.requestedAt.getTime()) / 3_600_000;
    // stamped from requested_at, so the window is the dial and not "72 hours
    // from whenever someone next looks at it"
    expect(hours).toBeGreaterThan(DEFAULT_APPROVAL_TTL_HOURS - 0.5);
    expect(hours).toBeLessThan(DEFAULT_APPROVAL_TTL_HOURS + 0.5);
  });

  it("an approval past its TTL cannot execute — it is reported EXPIRED and superseded, never consumed", async () => {
    const args = { text: `f14-ttl-${RUN}` };
    const signed = await queueAndApprove(TTL, args);
    // wind the clock forward by moving the row's own deadline into the past —
    // the honest way to test a TTL without sleeping for three days. Nothing
    // else about the row is touched.
    await db
      .update(approvals)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(approvals.id, signed));

    const before = snapshotUpstream();
    const out = await call(TTL, args);

    expect(out.kind).toBe("approval_expired");
    expect(snapshotUpstream()).toEqual(before);
    if (out.kind === "approval_expired") {
      expect(out.supersededApprovalIds).toContain(signed);
      expect(out.requeuedApprovalId).toBeTruthy();
    }
    const [after] = await db.select().from(approvals).where(eq(approvals.id, signed));
    // the distinction AER-004 asks for: expired, NOT consumed
    expect(after!.status).toBe("superseded");
    expect(after!.status).not.toBe("consumed");
  });

  it("setting the dial to NULL is an operator choice that stamps no expiry — and it is restored afterwards", async () => {
    const current = await app.inject({ method: "GET", headers: AUTH, url: "/v1/org/settings" });
    const restore = current.json().settings.approvalTtlHours ?? null;
    // the shipped posture, asserted rather than assumed
    expect(restore).toBe(DEFAULT_APPROVAL_TTL_HOURS);
    const put = await app.inject({
      method: "PUT",
      headers: AUTH,
      url: "/v1/org/settings",
      payload: { approvalTtlHours: null },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().approvalTtlPosture).toBe("nonexpiring_high_risk");
    try {
      const exposed = await app.inject({ method: "GET", headers: AUTH, url: "/v1/org/settings" });
      expect(exposed.json().approvalTtlPosture).toBe("nonexpiring_high_risk");
      const before = new Set((await rowsFor(TTL, "pending")).map((r) => r.id));
      const out = await call(TTL, { text: `f14-ttl-null-${RUN}` });
      expect(out.kind).toBe("approval_required");
      const fresh = (await rowsFor(TTL, "pending")).filter((r) => !before.has(r.id));
      expect(fresh).toHaveLength(1);
      // NULL means never expires — the documented way to reopen gap (b), on
      // the record, as a deliberate choice
      expect(fresh[0]!.expiresAt).toBeNull();
    } finally {
      // shared-DB rule: restore every singleton this file mutates
      await app.inject({
        method: "PUT",
        headers: AUTH,
        url: "/v1/org/settings",
        payload: { approvalTtlHours: restore },
      });
    }
    const back = await app.inject({ method: "GET", headers: AUTH, url: "/v1/org/settings" });
    expect(back.json().settings.approvalTtlHours).toBe(DEFAULT_APPROVAL_TTL_HOURS);
    expect(back.json().approvalTtlPosture).toBe("bounded");
  });
});

describe("F14 — the compatibility rule, in the direction that must NOT invalidate", () => {
  it("editing and activating a version of an UNRELATED rule leaves the consent spendable", async () => {
    // The rule ADR-0105 states: a change to the MATCHED rule set, any matched
    // rule's active version, the required approver, or the approval scope
    // invalidates. Anything else does not, BECAUSE IT IS NOT IN THE DIGEST.
    // A compatibility rule that only ever says "no" is a reset, not a rule.
    const args = { text: `f14-stable-${RUN}` };
    const signed = await queueAndApprove(STABLE, args);

    // an unrelated approval rule — same user, same server, DIFFERENT tool, so
    // it is loaded by the evaluation and does not MATCH this call — is edited
    // and a new version activated.
    await activateRuleVersion(ruleIdFor.get(UNRELATED)!, { writeOnly: false });

    const beforeTool = upstreamHits.tool;
    const out = await call(STABLE, args);
    expect(out.kind).toBe("allowed");
    expect(upstreamHits.tool).toBe(beforeTool + 1);

    // the consent was SPENT, not retired
    const [after] = await db.select().from(approvals).where(eq(approvals.id, signed));
    expect(after!.status).toBe("consumed");
  });
});

describe("F14 — atomicity", () => {
  it("refuses a legacy approved row with no policy context and re-queues it", async () => {
    const args = { text: `f14-legacy-${RUN}` };
    const signed = await queueAndApprove(LEGACY, args);
    await db.update(approvals).set({ contextDigest: null }).where(eq(approvals.id, signed));
    const before = snapshotUpstream();
    const out = await call(LEGACY, args);
    expect(out.kind).toBe("approval_context_stale");
    expect(snapshotUpstream()).toEqual(before);
    if (out.kind === "approval_context_stale") {
      expect(out.supersededApprovalIds).toContain(signed);
      expect(out.requeuedApprovalId).toBeTruthy();
    }
    const [old] = await db.select().from(approvals).where(eq(approvals.id, signed));
    expect(old!.status).toBe("superseded");
  });

  it("cannot spend an approval evaluated before a policy version activation", async () => {
    const args = { text: `f14-epoch-${RUN}` };
    const signed = await queueAndApprove(EPOCH, args);
    const evaluated = await governedEvaluate(db, callerId, serverId,
      { serverId, name: EPOCH, kind: "write" }, args);
    expect(evaluated.decision.effect).toBe("allow");
    expect(evaluated.approvedApprovalId).toBe(signed);
    await activateRuleVersion(ruleIdFor.get(EPOCH)!, { writeOnly: false });

    const before = snapshotUpstream();
    const consumed = await consumeBoundApproval(db, {
      approvalId: signed,
      policyEpoch: evaluated.policyEpoch,
      approvalScope: evaluated.approvalScope,
      argumentsDigest: evaluated.argumentsDigest,
      contextDigest: evaluated.contextDigest,
    });
    expect(consumed).toBe(false);
    expect(snapshotUpstream()).toEqual(before);
    expect((await db.select().from(approvals).where(eq(approvals.id, signed)))[0]!.status)
      .toBe("approved");
    const retry = await call(EPOCH, args);
    expect(retry.kind).toBe("approval_context_stale");
    expect(snapshotUpstream()).toEqual(before);
  });

  it("invalidates a pure ABAC approval when only the ABAC policy changes", async () => {
    const source = `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource)
      when { resource.toolName == "${ABAC_ONLY}" };`;
    const created = await app.inject({ method: "POST", headers: AUTH,
      url: "/v1/abac/policies", payload: {
        name: `f14-abac-${RUN}`, source, mode: "require_approval", approverUserId: approverA,
      } });
    expect(created.statusCode, created.body).toBe(201);
    const policyId = created.json().policy.id as string;
    try {
      const activated = await app.inject({ method: "POST", headers: AUTH,
        url: `/v1/abac/policies/${policyId}/activate`, payload: { version: 1 } });
      expect(activated.statusCode, activated.body).toBe(200);
      const args = { text: `f14-abac-${RUN}` };
      const signed = await queueAndApprove(ABAC_ONLY, args);
      const revised = await app.inject({ method: "POST", headers: AUTH,
        url: `/v1/abac/policies/${policyId}/versions`, payload: {
          source: `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource)
            when { resource.toolName == "${ABAC_ONLY}" && resource.kind == "write" };`,
          mode: "require_approval", approverUserId: approverA,
        } });
      expect(revised.statusCode, revised.body).toBe(201);
      const changed = await app.inject({ method: "POST", headers: AUTH,
        url: `/v1/abac/policies/${policyId}/activate`, payload: { version: 2 } });
      expect(changed.statusCode, changed.body).toBe(200);
      const before = snapshotUpstream();
      const out = await call(ABAC_ONLY, args);
      expect(out.kind).toBe("approval_context_stale");
      expect(snapshotUpstream()).toEqual(before);
      if (out.kind === "approval_context_stale") expect(out.supersededApprovalIds).toContain(signed);
    } finally {
      const removed = await app.inject({ method: "DELETE", headers: AUTH,
        url: `/v1/abac/policies/${policyId}` });
      expect(removed.statusCode).toBe(200);
    }
  });

  it("two concurrent calls holding ONE consent: exactly one succeeds, and the upstream runs exactly once", async () => {
    const args = { text: `f14-race-${RUN}` };
    const signed = await queueAndApprove(RACE, args);

    const beforeTool = upstreamHits.tool;
    const results = await Promise.all([call(RACE, args), call(RACE, args)]);
    const allowed = results.filter((r) => r.kind === "allowed");
    expect(allowed).toHaveLength(1);
    expect(upstreamHits.tool).toBe(beforeTool + 1);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, signed));
    expect(after!.status).toBe("consumed");
  });

  it("concurrent consumption AND a concurrent policy activation cannot spend stale consent", async () => {
    const args = { text: `f14-race2-${RUN}` };
    const signed = await queueAndApprove(RACE, args);

    const beforeTool = upstreamHits.tool;
    // real concurrency: two callers reaching for the one consent while an
    // admin activates a new version of the very rule that demanded it.
    const [a, b] = await Promise.all([
      call(RACE, args),
      call(RACE, args),
      activateRuleVersion(ruleIdFor.get(RACE)!, { writeOnly: false }),
    ]);
    const allowed = [a, b].filter((r) => r.kind === "allowed");
    // AT MOST one — zero is a legitimate outcome when the activation commits
    // first, and is the FAIL-CLOSED one. What is never permitted is two.
    expect(allowed.length).toBeLessThanOrEqual(1);
    // the upstream ran exactly as many times as calls were allowed: a refused
    // call executed nothing
    expect(upstreamHits.tool).toBe(beforeTool + allowed.length);

    // and however it resolved, the consent is no longer spendable: consumed by
    // the single winner, or superseded because the policy moved under it.
    const [after] = await db.select().from(approvals).where(eq(approvals.id, signed));
    expect(["consumed", "superseded"]).toContain(after!.status);

    // a fresh retry under the NEW policy can never spend it either
    const beforeToolRetry = upstreamHits.tool;
    const retry = await call(RACE, args);
    expect(retry.kind).not.toBe("allowed");
    expect(upstreamHits.tool).toBe(beforeToolRetry);
  });
});

describe("F14 — the audit evidence, and what it must not contain", () => {
  it("records the action digest, the consent-context identity, the expiry outcome and the old row's disposition — digests only, never the raw arguments", async () => {
    const marker = `f14-marker-${RUN}-do-not-leak`;
    const args = { text: marker };
    const since = new Date(Date.now() - 1000);
    const signed = await queueAndApprove(VERSIONED, args);

    // the approver-facing preview IS allowed to carry the payload: it is the
    // one human-readable rendering, and it is the ADR-0099 scrubber's output.
    const [queued] = await db.select().from(approvals).where(eq(approvals.id, signed));
    expect(JSON.stringify(queued!.argumentsPreview)).toContain(marker);

    await activateRuleVersion(ruleIdFor.get(VERSIONED)!, { writeOnly: true });
    const out = await call(VERSIONED, args);
    expect(out.kind).toBe("approval_context_stale");

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.toolName, VERSIONED), gte(auditLog.at, since)))
      .orderBy(desc(auditLog.at));

    // 1. the governed tool-call row carries BOTH digests and the scope
    const governed = rows.filter(
      (r) => (r.detail as Record<string, unknown> | null)?.argumentsDigest != null,
    );
    expect(governed.length).toBeGreaterThan(0);
    for (const r of governed) {
      const d = r.detail as Record<string, unknown>;
      expect(typeof d.argumentsDigest).toBe("string");
      expect(typeof d.contextDigest).toBe("string");
      expect(d.approvalScope).toBe("action");
    }

    // 2. the old row's DISPOSITION is its own audited fact, naming why
    const retirement = rows.filter((r) => r.ruleId === "approval-context-stale");
    expect(retirement.length).toBeGreaterThan(0);
    const mine = retirement.find(
      (r) => (r.detail as Record<string, unknown>).approvalId === signed,
    );
    expect(mine).toBeTruthy();
    expect(mine!.effect).toBe("deny");
    expect((mine!.detail as Record<string, unknown>).retirementReason).toBe("context_changed");
    expect(mine!.reason).toContain("policy context");

    // 3. NOTHING in the audit trail for this run leaks the raw payload
    for (const r of rows) {
      expect(JSON.stringify({ detail: r.detail, reason: r.reason })).not.toContain(marker);
    }
  });

  it("an EXPIRY disposition is audited under its own rule id, distinct from a context change", async () => {
    const args = { text: `f14-audit-expiry-${RUN}` };
    const since = new Date(Date.now() - 1000);
    const signed = await queueAndApprove(TTL, args);
    await db
      .update(approvals)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(approvals.id, signed));
    const out = await call(TTL, args);
    expect(out.kind).toBe("approval_expired");

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "approval-expired"), gte(auditLog.at, since)))
      .orderBy(desc(auditLog.at));
    const mine = rows.find((r) => (r.detail as Record<string, unknown>).approvalId === signed);
    expect(mine).toBeTruthy();
    expect(mine!.effect).toBe("deny");
    expect((mine!.detail as Record<string, unknown>).retirementReason).toBe("expired");
    expect(mine!.reason).toContain("expired");
  });
});
