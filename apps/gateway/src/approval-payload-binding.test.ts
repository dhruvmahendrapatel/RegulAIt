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
  eq,
  runMigrations,
  type Db,
} from "@regulait/db";
import { approvalArgumentsDigest } from "@regulait/shared";
import { buildApp } from "./app.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";

/**
 * F05 / ADR-0104 — AN APPROVAL IS BOUND TO THE ARGUMENTS IT WAS APPROVED FOR.
 *
 * The gap: `approvals` had no arguments column, the approved-approval lookup
 * keyed only on user/server/tool/status, and the queueing path stored no
 * payload. An approver signed off on "user X may call `note` on server Y" and
 * the caller could then execute that tool with entirely different arguments.
 *
 * What is asserted here is the whole contract, in both directions:
 *   - action scope (the DEFAULT) refuses a consent spent on another payload,
 *     on another project, or on no payload at all (a legacy NULL-digest row);
 *   - tool scope (the explicit escape hatch) still permits reuse, so the
 *     opt-out is proved to actually work rather than merely to exist;
 *   - single-use consumption and its atomicity under concurrency are UNCHANGED
 *     — this batch must not regress the compensating control it inherited;
 *   - the approver can SEE the payload, scrubbed, while the digest taken on the
 *     RAW payload is unmoved by that scrubbing.
 *
 * Shares one DB (fileParallelism off): every assertion is a DELTA or is scoped
 * to a per-run fixture, never an absolute count over a shared table. Prefix
 * f05-, per-run suffix, so the file is re-runnable.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "f05-bootstrap-token";
const RUN = Math.random().toString(36).slice(2, 8);
const AUTH = { authorization: `Bearer ${BOOT}` };

/** the tool under an ACTION-scoped rule (the default) */
const BOUND = `f05_bound_${RUN}`;
/** the tool under an explicitly TOOL-scoped rule (the escape hatch) */
const LOOSE = `f05_loose_${RUN}`;

/** how many times the upstream actually RAN a tool — the only honest proof
 * that a governed refusal executed nothing. */
const upstreamHits = { tool: 0 };

let db: Db;
let app: ReturnType<typeof buildApp>;
let upstreamClose: () => Promise<void>;
let serverId: string;
let callerId: string;
let approverId: string;

function buildUpstreamMcpServer(): McpServer {
  const server = new McpServer({ name: "f05-upstream", version: "0.0.1" });
  for (const name of [BOUND, LOOSE]) {
    server.registerTool(
      name,
      { description: `${name}`, inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
      async ({ text }) => {
        upstreamHits.tool++;
        return { content: [{ type: "text", text: `ran: ${text}` }] };
      },
    );
  }
  return server;
}

async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
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
  return r.json().id as string;
}

async function mkProject(name: string): Promise<string> {
  const r = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/projects",
    payload: { name },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

/** Trap-1 guard: NEVER pass `arguments: undefined` — the governed layer would
 * return an allow whose upstream rejected on validation, i.e. an allow that
 * never ran. Every call in this file goes through here with a real bag. */
function call(opts: {
  toolName: string;
  arguments: Record<string, unknown>;
  projectId?: string | null;
}) {
  return executeGovernedToolCall(db, undefined, {
    userId: callerId,
    serverId,
    toolName: opts.toolName,
    arguments: opts.arguments,
    ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
  });
}

/** every pending queue row for this caller/tool, oldest first (trap 2: an
 * unordered `.select()` indexed with [0]/.at(-1) is a latent flake). */
async function pendingRows(toolName: string) {
  return db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.userId, callerId),
        eq(approvals.serverId, serverId),
        eq(approvals.toolName, toolName),
        eq(approvals.status, "pending"),
      ),
    )
    .orderBy(asc(approvals.requestedAt));
}

async function approve(approvalId: string) {
  const r = await db
    .update(approvals)
    .set({ status: "approved", decidedBy: approverId, decidedAt: new Date() })
    .where(eq(approvals.id, approvalId))
    .returning({ id: approvals.id });
  expect(r).toHaveLength(1);
}

/** Queue an approval for exactly these arguments, then approve it, and return
 * the row id — the "an approver signed THIS payload" precondition. */
async function queueAndApprove(opts: {
  toolName: string;
  arguments: Record<string, unknown>;
  projectId?: string | null;
}): Promise<string> {
  const before = new Set((await pendingRows(opts.toolName)).map((r) => r.id));
  const out = await call(opts);
  expect(out.kind).toBe("approval_required");
  const after = await pendingRows(opts.toolName);
  const fresh = after.filter((r) => !before.has(r.id));
  expect(fresh).toHaveLength(1);
  await approve(fresh[0]!.id);
  return fresh[0]!.id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const up = await startUpstream();
  upstreamClose = up.close;

  const s = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/servers",
    payload: { name: `f05-server-${RUN}`, url: up.url },
  });
  serverId = s.json().id;
  for (const name of [BOUND, LOOSE]) {
    // register the inventory row WITH its kind, so no manifest sync (and thus
    // no upstream contact) is needed before governance runs
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/servers/${serverId}/tools`,
      payload: { name, kind: "read" },
    });
  }

  callerId = await mkUser(`f05-caller-${RUN}@example.com`);
  approverId = await mkUser(`f05-approver-${RUN}@example.com`);
  for (const name of [BOUND, LOOSE]) {
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/tools",
      payload: { userId: callerId, serverId, toolName: name },
    });
  }

  // The DEFAULT rule: `approvalScope` is deliberately OMITTED, so this asserts
  // the shipped default is 'action' rather than asserting a value we typed.
  const bound = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/rules/approvals",
    payload: { userId: callerId, serverId, toolName: BOUND, approverUserId: approverId },
  });
  expect(bound.statusCode).toBe(201);
  expect(bound.json().approvalScope).toBe("action");

  // The escape hatch, which an operator has to ASK for by name.
  const loose = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/rules/approvals",
    payload: {
      userId: callerId,
      serverId,
      toolName: LOOSE,
      approverUserId: approverId,
      approvalScope: "tool",
    },
  });
  expect(loose.statusCode).toBe(201);
  expect(loose.json().approvalScope).toBe("tool");
});

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
  await upstreamClose();
});

describe("F05 — action-scoped consent is bound to the payload", () => {
  it("NEGATIVE CONTROL: an approval signed for one payload does NOT execute another", async () => {
    // This is the finding, stated as a test. Before ADR-0104 this call ran the
    // tool: the lookup keyed on user/server/tool/status and nothing else, so an
    // approval for {text:"safe"} was spendable on {text:"exfiltrate"}.
    const approvalId = await queueAndApprove({ toolName: BOUND, arguments: { text: "safe" } });

    const ranBefore = upstreamHits.tool;
    const out = await call({ toolName: BOUND, arguments: { text: "exfiltrate" } });

    expect(out.kind).toBe("approval_required");
    // and it EXECUTED NOTHING — an error coming back is not the assertion
    expect(upstreamHits.tool).toBe(ranBefore);

    // the signed consent is untouched: still approved, not consumed, still
    // spendable on the payload it was actually granted for
    const [signed] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(signed!.status).toBe("approved");

    // the mismatched call raised its OWN queue row, carrying its OWN digest —
    // the dedup did not fold it into the signed one
    if (out.kind === "approval_required") {
      expect(out.approvalId).not.toBe(approvalId);
      const [fresh] = await db.select().from(approvals).where(eq(approvals.id, out.approvalId));
      expect(fresh!.argumentsDigest).toBe(
        approvalArgumentsDigest({ projectId: null, arguments: { text: "exfiltrate" } }),
      );
      expect(fresh!.argumentsDigest).not.toBe(signed!.argumentsDigest);
    }

    // and the approval signed for {text:"safe"} still spends on {text:"safe"}
    const ok = await call({ toolName: BOUND, arguments: { text: "safe" } });
    expect(ok.kind).toBe("allowed");
    expect(upstreamHits.tool).toBe(ranBefore + 1);
  });

  it("the matching payload executes EXACTLY ONCE, and the second identical call re-queues", async () => {
    // single-use consumption is a pre-existing compensating control; ADR-0104
    // must not regress it. Same arguments, twice: one run, one re-queue.
    const approvalId = await queueAndApprove({ toolName: BOUND, arguments: { text: "once" } });

    const ranBefore = upstreamHits.tool;
    const first = await call({ toolName: BOUND, arguments: { text: "once" } });
    expect(first.kind).toBe("allowed");
    expect(upstreamHits.tool).toBe(ranBefore + 1);

    const [consumed] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(consumed!.status).toBe("consumed");

    const second = await call({ toolName: BOUND, arguments: { text: "once" } });
    expect(second.kind).toBe("approval_required");
    expect(upstreamHits.tool).toBe(ranBefore + 1);
  });

  it("the same arguments in a DIFFERENT project do not satisfy the consent", async () => {
    // projectId is part of the fingerprint: the same tool with the same
    // arguments reaches different data, bills a different ledger and may sit
    // under a different compliance cascade in another project.
    const projectA = await mkProject(`f05-a-${RUN}`);
    const projectB = await mkProject(`f05-b-${RUN}`);
    await queueAndApprove({ toolName: BOUND, arguments: { text: "cross" }, projectId: projectA });

    const ranBefore = upstreamHits.tool;
    const inB = await call({ toolName: BOUND, arguments: { text: "cross" }, projectId: projectB });
    expect(inB.kind).toBe("approval_required");
    expect(upstreamHits.tool).toBe(ranBefore);

    const inA = await call({ toolName: BOUND, arguments: { text: "cross" }, projectId: projectA });
    expect(inA.kind).toBe("allowed");
    expect(upstreamHits.tool).toBe(ranBefore + 1);
  });

  it("a LEGACY approved row with a NULL digest does not satisfy an action-scoped rule", async () => {
    // Rows queued before migration 0106 have no digest, and one cannot be
    // invented for them. Under the default action scope they fail closed: the
    // call re-queues, and the re-queued row is born with a digest, so the
    // population heals itself. This IS the documented upgrade-day change.
    const [legacy] = await db
      .insert(approvals)
      .values({
        userId: callerId,
        serverId,
        toolName: BOUND,
        approverUserId: approverId,
        status: "approved",
        decidedBy: approverId,
        decidedAt: new Date(),
        // arguments_digest / arguments_preview deliberately absent
      })
      .returning({ id: approvals.id, argumentsDigest: approvals.argumentsDigest });
    expect(legacy!.argumentsDigest).toBeNull();

    const ranBefore = upstreamHits.tool;
    const out = await call({ toolName: BOUND, arguments: { text: "legacy" } });
    expect(out.kind).toBe("approval_required");
    expect(upstreamHits.tool).toBe(ranBefore);

    // the legacy row was NOT consumed — a consent that never bound a payload
    // cannot be spent on one
    const [after] = await db.select().from(approvals).where(eq(approvals.id, legacy!.id));
    expect(after!.status).toBe("approved");

    // ...and the re-queued row IS bound
    if (out.kind === "approval_required") {
      const [fresh] = await db.select().from(approvals).where(eq(approvals.id, out.approvalId));
      expect(fresh!.argumentsDigest).toBe(
        approvalArgumentsDigest({ projectId: null, arguments: { text: "legacy" } }),
      );
    }

    // leave the shared table as we found it — this row is a fixture for one
    // assertion, not a permanent legacy approval for every later test
    await db.delete(approvals).where(eq(approvals.id, legacy!.id));
  });

  it("key ORDER in the arguments does not change the consent (the jsonb round trip)", async () => {
    await queueAndApprove({ toolName: BOUND, arguments: { alpha: "1", beta: "2", text: "order" } });
    const ranBefore = upstreamHits.tool;
    // the same call, written the other way round
    const out = await call({ toolName: BOUND, arguments: { text: "order", beta: "2", alpha: "1" } });
    expect(out.kind).toBe("allowed");
    expect(upstreamHits.tool).toBe(ranBefore + 1);
  });
});

describe("F05 — the 'tool' escape hatch really is an escape hatch", () => {
  it("a tool-scoped approval IS reusable across differing arguments", async () => {
    const approvalId = await queueAndApprove({ toolName: LOOSE, arguments: { text: "signed" } });

    const ranBefore = upstreamHits.tool;
    // an entirely different payload — permitted here, and ONLY here, because an
    // operator explicitly said this rule's consent is about the tool
    const out = await call({ toolName: LOOSE, arguments: { text: "totally-different" } });
    expect(out.kind).toBe("allowed");
    expect(upstreamHits.tool).toBe(ranBefore + 1);

    // still single-use: the escape hatch loosens WHICH call may spend the
    // consent, never HOW MANY times it may be spent
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row!.status).toBe("consumed");
    const again = await call({ toolName: LOOSE, arguments: { text: "totally-different" } });
    expect(again.kind).toBe("approval_required");
    expect(upstreamHits.tool).toBe(ranBefore + 1);
  });

  it("a tool-scoped rule reuses ONE pending entry across differing arguments", async () => {
    // the deliberate counterpart to the action-scoped dedup: under tool scope
    // the digest is NOT in the dedup key, so two payloads share one queue row.
    const before = (await pendingRows(LOOSE)).length;
    const first = await call({ toolName: LOOSE, arguments: { text: "dedup-a" } });
    const second = await call({ toolName: LOOSE, arguments: { text: "dedup-b" } });
    expect(first.kind).toBe("approval_required");
    expect(second.kind).toBe("approval_required");
    if (first.kind === "approval_required" && second.kind === "approval_required") {
      // ONE row for two different payloads — the deliberate counterpart to the
      // action-scoped dedup, where these two would have to be separate rows
      expect(second.approvalId).toBe(first.approvalId);
      const ids = (await pendingRows(LOOSE)).map((r) => r.id);
      expect(ids).toContain(first.approvalId);
    }
    // a DELTA, not an absolute count: an earlier test in this file may already
    // have left a pending LOOSE row, and reusing THAT one is the same property
    const after = (await pendingRows(LOOSE)).length;
    expect(after - before).toBeLessThanOrEqual(1);
  });
});

describe("F05 — the approver can see what they are signing", () => {
  it("GET /v1/approvals returns the SCRUBBED payload, and the digest still matches the raw one", async () => {
    // A synthetic credential (never a real one) in the arguments. Two things
    // must both be true: the approver does not read it, and the consent still
    // identifies the exact call that carried it.
    const SECRET = "sk-test-F05-SYNTHETIC-NOT-A-REAL-KEY-0000";
    const args = { text: "publish", apiKey: SECRET };

    const before = new Set((await pendingRows(BOUND)).map((r) => r.id));
    const out = await call({ toolName: BOUND, arguments: args });
    expect(out.kind).toBe("approval_required");
    const fresh = (await pendingRows(BOUND)).filter((r) => !before.has(r.id));
    expect(fresh).toHaveLength(1);
    const approvalId = fresh[0]!.id;

    // the approver's own inbox view — no route change was needed for this, the
    // queue already selects the whole row
    const queue = await app.inject({
      method: "GET",
      headers: AUTH,
      url: "/v1/approvals?status=pending",
    });
    const row = queue.json().approvals.find((a: { id: string }) => a.id === approvalId);
    expect(row).toBeDefined();
    const preview = row.argumentsPreview as Record<string, unknown>;

    // they CAN see the payload...
    expect(preview.text).toBe("publish");
    // ...but not the credential in it
    expect(String(preview.apiKey)).not.toContain("SYNTHETIC-NOT-A-REAL-KEY");
    expect(JSON.stringify(preview)).not.toContain(SECRET);

    // and the digest — taken on the RAW arguments, before that scrub — is
    // exactly the fingerprint of the call as it was actually made. Scrubbing
    // cannot move consent identity.
    expect(row.argumentsDigest).toBe(
      approvalArgumentsDigest({ projectId: null, arguments: args }),
    );

    // proof that it is really the same consent: approve it, and the ORIGINAL
    // unscrubbed call goes through
    await approve(approvalId);
    const ranBefore = upstreamHits.tool;
    const ok = await call({ toolName: BOUND, arguments: args });
    expect(ok.kind).toBe("allowed");
    expect(upstreamHits.tool).toBe(ranBefore + 1);
  });

  it("the tool-call audit row records the EXECUTED digest, whatever the scope", async () => {
    // the forensic half, independent of the consent half: before ADR-0104 the
    // audit row said nothing at all about the payload.
    const args = { text: `audited-${RUN}` };
    const expected = approvalArgumentsDigest({ projectId: null, arguments: args });

    await queueAndApprove({ toolName: BOUND, arguments: args });
    const ok = await call({ toolName: BOUND, arguments: args });
    expect(ok.kind).toBe("allowed");

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, callerId), eq(auditLog.toolName, BOUND)))
      .orderBy(asc(auditLog.at));
    const allows = rows.filter(
      (r) => r.effect === "allow" && (r.detail as { argumentsDigest?: string })?.argumentsDigest === expected,
    );
    expect(allows.length).toBeGreaterThanOrEqual(1);
    // the require_approval row for the SAME payload carries it too — the record
    // of what was attempted is owed on a refusal as much as on a run
    const paused = rows.filter(
      (r) =>
        r.effect === "require_approval" &&
        (r.detail as { argumentsDigest?: string })?.argumentsDigest === expected,
    );
    expect(paused.length).toBeGreaterThanOrEqual(1);
    // never the arguments themselves
    expect(JSON.stringify(rows.map((r) => r.detail))).not.toContain(args.text.slice(0, 3) + "ited");
  });
});

describe("F05 — atomic single-use consumption is NOT regressed", () => {
  it("two concurrent identical calls spend the approval exactly once", async () => {
    await queueAndApprove({ toolName: BOUND, arguments: { text: "race" } });

    const ranBefore = upstreamHits.tool;
    const [a, b] = await Promise.all([
      call({ toolName: BOUND, arguments: { text: "race" } }),
      call({ toolName: BOUND, arguments: { text: "race" } }),
    ]);

    const kinds = [a.kind, b.kind].sort();
    // exactly one ran; the loser is either the consumption race or a fresh
    // pause (it depends purely on which side read the row first) — what is NOT
    // permitted is two allows
    expect(kinds.filter((k) => k === "allowed")).toHaveLength(1);
    expect(upstreamHits.tool).toBe(ranBefore + 1);
  });
});
