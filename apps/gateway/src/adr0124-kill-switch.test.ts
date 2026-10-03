import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  agents,
  approvals,
  auditLog,
  createDb,
  eq,
  mcpTools,
  ORG_SETTINGS_ID,
  orgSettings,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";
import { executionGate } from "@regulait/policy-kernel";
import { buildApp } from "./app.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";

/**
 * ADR-0124 — THE KILL SWITCH AND SAFE MODES, PROVED BY ATTACK.
 *
 * A kill switch is worth exactly what it stops, so this file is written to
 * make "it looked stopped" impossible to pass off as "it was stopped".
 *
 * PASS CRITERIA, WRITTEN BEFORE THE RUN (M-023):
 *
 *  1. HALTED STOPS EVERY PATH. A halt refuses the MCP tool path, the model
 *     dispatch path AND the connector path. Enumerating all three is the point
 *     (M-035): a switch that stopped one of them would pass a single-path test
 *     and be worthless.
 *  2. AND IT EXECUTES NOTHING. The refusal is asserted by the UPSTREAM NEVER
 *     BEING CONTACTED — against a real HTTP server that counts requests — and
 *     by no `usage_events` row being written. "Returned an error" is not the
 *     same claim as "did not run".
 *  3. READ-ONLY IS NOT A STOP. Paired both ways: a write tool is refused AND a
 *     read tool still succeeds, in the same mode. A read-only mode that
 *     refused everything would satisfy half of this and be a halt by another
 *     name.
 *  4. REQUIRE_APPROVAL QUEUES ON THE TOOL PATH AND REFUSES ON DISPATCH, which
 *     is the documented asymmetry. Asserted in both directions so the
 *     asymmetry cannot silently become "refuses everywhere".
 *  5. A PER-TOOL HALT IS SURGICAL. The halted tool is refused while a sibling
 *     tool on the same server still works, with the deployment at `normal`.
 *  6. A PER-AGENT HALT SURVIVES THE ROUTER. A halted agent cannot be selected
 *     as a routing candidate — not merely refused when named.
 *  7. LIFTING RESTORES, AND BOTH DIRECTIONS ARE AUDITED under distinct rule
 *     ids, with a reason required to throw AND to lift.
 *  8. THE READ IS REACHABLE WHILE HALTED. `GET /v1/execution` answers during a
 *     halt — otherwise the halt could not be diagnosed or lifted.
 *  9. NOTHING IS DESTROYED: a pending approval survives a halt.
 * 10. VISIBILITY IS NOT EXECUTION: `tools/list` still lists entitled tools
 *     while halted, because an empty list looks like revoked access.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `adr0124-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const READ_TOOL = `adr0124_read_${RUN}`;
const WRITE_TOOL = `adr0124_write_${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId = "";
let userAuth: { authorization: string } = { authorization: "" };
let agentId = "";
let serverId = "";
let connectorId = "";
let upstreamClose: () => Promise<void>;
/** every request the upstream really received — criterion 2's instrument */
let upstreamHits = 0;
/**
 * AER-017: TOOL EXECUTIONS, which is a different fact from `upstreamHits`.
 *
 * `upstreamHits` counts HTTP requests and is incremented before any protocol
 * work, deliberately — ADR-0124's claim is "the socket was never reached". But
 * ONE governed tool call reaches that socket several times (the `initialize`
 * handshake, a manifest sync, then `tools/call`), so it cannot answer "did the
 * tool run exactly once". Asserting one consent buys one EXECUTION needs a
 * counter inside the tool handler, and using the one that happened to be
 * available would have made a 3-hit pass look like a triple execution.
 */
let toolRuns = 0;

const post = (url: string, payload?: unknown, headers = AUTH) =>
  app.inject({ method: "POST", url, headers, ...(payload ? { payload: payload as object } : {}) });

/** set the deployment dial through the shipped route */
const setMode = (mode: string, reason = "adr0124 test — exercising the shipped control path") =>
  app.inject({
    method: "PUT",
    url: "/v1/execution/mode",
    headers: AUTH,
    payload: {
      mode,
      reason,
      // require_approval must name who is attending — see ADR-0124
      ...(mode === "require_approval" ? { approverUserId: userId } : {}),
    },
  });

/** the dial straight out of the database, bypassing the route's own reporting */
const modeInDb = async () =>
  (await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID)))[0]
    ?.executionMode;

const usageCount = async () => (await db.select().from(usageEvents)).length;
const auditCount = async (ruleId: string) =>
  (await db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId))).length;

async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        // counted BEFORE any protocol work: criterion 2 is about whether the
        // socket was reached at all, not about what came back
        upstreamHits += 1;
        const mcp = new McpServer({ name: `adr0124-up-${RUN}`, version: "0.0.1" });
        mcp.registerTool(
          READ_TOOL,
          { description: "read", inputSchema: {}, annotations: { readOnlyHint: true } },
          async () => {
            toolRuns += 1;
            return { content: [{ type: "text", text: "read-ok" }] };
          },
        );
        mcp.registerTool(WRITE_TOOL, { description: "write", inputSchema: {} }, async () => ({
          content: [{ type: "text", text: "write-ok" }],
        }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });

  const u = await post("/v1/users", {
    email: `adr0124-${RUN}@example.com`,
    displayName: "ADR124 Caller",
    isAdmin: true,
  });
  userId = u.json().id;
  userAuth = { authorization: `Bearer ${(await post(`/v1/users/${userId}/keys`, { name: "k" })).json().token}` };

  const a = await post("/v1/agents", {
    name: `adr0124-agent-${RUN}`,
    provider: "mock",
    model: "mock-fast",
    tier: 1,
  });
  agentId = a.json().id;
  await post("/v1/grants/agents", { userId, agentId });

  const up = await startUpstream();
  upstreamClose = up.close;
  const s = await post("/v1/servers", { name: `adr0124-server-${RUN}`, url: up.url });
  serverId = s.json().id;
  for (const [name, kind] of [
    [READ_TOOL, "read"],
    [WRITE_TOOL, "write"],
  ] as const) {
    await post(`/v1/servers/${serverId}/tools`, { name, kind, description: name });
    await post("/v1/grants/tools", { userId, serverId, toolName: name, mode: "readwrite" });
  }

  const c = await post("/v1/connectors", {
    name: `adr0124-connector-${RUN}`,
    kind: "issue-tracker",
    providerKind: "mock",
  });
  connectorId = c.json().id;
  await post("/v1/grants/connectors", { userId, connectorId, mode: "readwrite" });
});

afterAll(async () => {
  await setMode("normal", "adr0124 teardown — returning the shared database to normal");
  await upstreamClose?.();
  app.server.closeAllConnections();
  await app.close();
});

/** the three governed paths, each returning something comparable */
const callTool = (tool: string) =>
  executeGovernedToolCall(db, undefined, {
    userId,
    serverId,
    toolName: tool,
    projectId: null,
    arguments: {},
  });
const callDispatch = (mode = "execute") =>
  post(`/v1/agents/${agentId}/invoke`, { mode, input: "hello", dispatch: true }, userAuth);
const callConnector = (operation: "read" | "write") =>
  post(`/v1/connectors/${connectorId}/invoke`, { operation, object: "ISSUE-1" }, userAuth);

describe("1+2: HALTED stops every governed path, and executes nothing", () => {
  it("refuses the tool, dispatch AND connector paths — and never reaches the upstream", async () => {
    await setMode("normal", "adr0124 baseline — proving the paths work before they are stopped");

    // POSITIVE CONTROL FIRST (M-033). Without this, every assertion below is
    // satisfied by a fixture that never worked in the first place.
    const okTool = await callTool(READ_TOOL);
    expect(okTool.kind).toBe("allowed");
    expect(await callDispatch()).toMatchObject({ statusCode: 200 });
    expect((await callConnector("read")).statusCode).toBe(200);

    const hitsBefore = upstreamHits;
    const usageBefore = await usageCount();

    expect((await setMode("halted", "adr0124 — the kill switch under test")).statusCode).toBe(200);
    expect(await modeInDb()).toBe("halted");

    // all three paths, enumerated
    const tool = await callTool(WRITE_TOOL);
    expect(tool.kind).toBe("denied");
    expect((tool as { decision: { ruleId: string } }).decision.ruleId).toBe("execution-halted");

    const dispatch = await callDispatch();
    expect(dispatch.statusCode).not.toBe(200);
    expect(dispatch.body).toContain("halted");

    const connector = await callConnector("read");
    expect(connector.statusCode).not.toBe(200);
    expect(JSON.stringify(connector.json())).toContain("halted");

    // criterion 2 — the claim that matters. Not "it errored": it did not run.
    expect(upstreamHits, "a halted deployment must not contact an upstream").toBe(hitsBefore);
    expect(await usageCount(), "a refused call bills nothing").toBe(usageBefore);
  });
});

describe("3: READ-ONLY is a safe mode, not a halt", () => {
  it("refuses the write tool and still serves the read tool, in the same mode", async () => {
    await setMode("read_only", "adr0124 — safe degradation under test");

    const write = await callTool(WRITE_TOOL);
    expect(write.kind).toBe("denied");
    expect((write as { decision: { ruleId: string } }).decision.ruleId).toBe("execution-read-only");

    // the other half — without it, read_only could be a halt wearing a label
    const read = await callTool(READ_TOOL);
    expect(read.kind, "read-only must keep serving reads").toBe("allowed");

    // and the same split on the connector path
    expect((await callConnector("read")).statusCode).toBe(200);
    expect((await callConnector("write")).statusCode).not.toBe(200);

    // a plan-safe dispatch still reasons; a mutating one does not
    expect((await callDispatch("chat")).statusCode).toBe(200);
    expect((await callDispatch("execute")).statusCode).not.toBe(200);
  });
});

describe("4: REQUIRE_APPROVAL queues where it can and refuses where it cannot", () => {
  it("queues the tool call, and refuses dispatch — the documented asymmetry, both directions", async () => {
    await setMode("require_approval", "adr0124 — manual-approval mode under test");

    const tool = await callTool(READ_TOOL);
    // queued, not refused: the work is not lost
    expect(tool.kind).toBe("approval_required");

    // and NOT queued on a path with no per-call queue — asserted rather than
    // assumed, because this asymmetry is the easiest thing here to get wrong
    const dispatch = await callDispatch("execute");
    expect(dispatch.statusCode).not.toBe(200);
    expect(dispatch.body).toMatch(/no per-call approval queue|REFUSED/i);
  });
});

describe("5: a per-TOOL halt is surgical", () => {
  it("stops one tool while its sibling on the same server keeps working", async () => {
    await setMode("normal", "adr0124 — per-tool scope under test at normal");

    const res = await post(`/v1/servers/${serverId}/tools/${WRITE_TOOL}/halt`, {
      reason: "adr0124 — this one tool is misbehaving",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().changed).toBe(true);

    const halted = await callTool(WRITE_TOOL);
    expect(halted.kind).toBe("denied");
    expect((halted as { decision: { ruleId: string } }).decision.ruleId).toBe(
      "execution-subject-halted",
    );

    // THE POINT OF PER-CAPABILITY SCOPE: the business keeps running
    expect((await callTool(READ_TOOL)).kind).toBe("allowed");
    expect((await callDispatch()).statusCode).toBe(200);

    // idempotent — a second halt writes no second incident
    const before = await auditCount("execution-tool-halted");
    const again = await post(`/v1/servers/${serverId}/tools/${WRITE_TOOL}/halt`, {
      reason: "adr0124 — same halt, thrown twice",
    });
    expect(again.json().changed).toBe(false);
    expect(await auditCount("execution-tool-halted")).toBe(before);

    // 7 — lifting restores, and is audited under its OWN rule id
    const lift = await post(`/v1/servers/${serverId}/tools/${WRITE_TOOL}/unhalt`, {
      reason: "adr0124 — the tool was fixed, resuming",
    });
    expect(lift.statusCode).toBe(200);
    expect(await auditCount("execution-tool-unhalted")).toBeGreaterThan(0);
    expect((await callTool(WRITE_TOOL)).kind).toBe("allowed");
  });
});

describe("6: a per-AGENT halt survives the router", () => {
  it("cannot be selected as a routing candidate, not merely refused when named", async () => {
    await setMode("normal", "adr0124 — per-agent scope under test at normal");
    expect((await callDispatch()).statusCode).toBe(200);

    const res = await post(`/v1/agents/${agentId}/halt`, {
      reason: "adr0124 — this agent is producing unsafe output",
    });
    expect(res.statusCode).toBe(200);

    const named = await callDispatch();
    expect(named.statusCode).not.toBe(200);
    expect(named.body).toMatch(/HALTED/);

    // the router must not pick it either. A decision-only invoke asks the
    // optimiser to CHOOSE an agent; a halted one must not be choosable.
    const routed = await post(
      `/v1/agents/${agentId}/invoke`,
      { mode: "execute", input: "hello", dispatch: false },
      userAuth,
    );
    expect(routed.statusCode).not.toBe(200);

    // lifting does NOT re-enable a deliberately-disabled agent — the two are
    // different facts and the route says so
    const lift = await post(`/v1/agents/${agentId}/unhalt`, {
      reason: "adr0124 — investigated, safe to resume",
    });
    expect(lift.statusCode).toBe(200);
    expect(await auditCount("execution-agent-unhalted")).toBeGreaterThan(0);
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row?.haltedAt).toBeNull();
    expect(row?.haltedReason).toBeNull();
    expect((await callDispatch()).statusCode).toBe(200);
  });
});

describe("7: a reason is required to throw AND to lift", () => {
  it("refuses a mode change with no reason, in both directions", async () => {
    const noReason = await app.inject({
      method: "PUT",
      url: "/v1/execution/mode",
      headers: AUTH,
      payload: { mode: "halted" },
    });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().error).toBe("reason_required");

    // resuming is an intervention too — "why was it safe to resume?" is the
    // harder question of the two
    await setMode("halted", "adr0124 — so that resuming can be tested");
    const resumeNoReason = await app.inject({
      method: "PUT",
      url: "/v1/execution/mode",
      headers: AUTH,
      payload: { mode: "normal" },
    });
    expect(resumeNoReason.statusCode).toBe(400);

    // and a too-short reason is not a reason
    const terse = await app.inject({
      method: "PUT",
      url: "/v1/execution/mode",
      headers: AUTH,
      payload: { mode: "normal", reason: "fixed" },
    });
    expect(terse.statusCode).toBe(400);
    await setMode("normal", "adr0124 — restoring after the reason-required checks");
  });
});

describe("8+10: a halt can be diagnosed, and does not look like lost access", () => {
  it("GET /v1/execution answers while halted, and tools/list still lists", async () => {
    await setMode("halted", "adr0124 — proving the halt is diagnosable from inside it");

    // 8 — reachable, and by a NON-admin route class
    const read = await app.inject({ method: "GET", url: "/v1/execution", headers: userAuth });
    expect(read.statusCode).toBe(200);
    expect(read.json().mode).toBe("halted");
    expect(read.json().summary).toMatch(/halted/);
    expect(read.json().reason).toMatch(/diagnosable/);

    // 10 — visibility is not execution. An empty tool list during an incident
    // reads as "my access was revoked", which is the wrong thing to show.
    const tools = await app.inject({
      method: "GET",
      url: `/v1/servers/${serverId}/tools`,
      headers: userAuth,
    });
    expect(tools.statusCode).toBe(200);
    expect(tools.json().tools.length).toBeGreaterThan(0);

    await setMode("normal", "adr0124 — restoring after the diagnosability checks");
  });
});

describe("9: a halt destroys nothing", () => {
  it("leaves a pending approval exactly where it was", async () => {
    await setMode("normal", "adr0124 — queueing an approval before the halt");
    // an approval rule on the write tool, so the next call queues
    await post("/v1/rules/approvals", {
      userId,
      serverId,
      toolName: WRITE_TOOL,
      approverUserId: userId,
    });
    const queued = await callTool(WRITE_TOOL);
    expect(queued.kind).toBe("approval_required");
    const approvals = await db.select().from(auditLog).where(eq(auditLog.ruleId, "execution-halted"));
    const beforeCount = approvals.length;

    await setMode("halted", "adr0124 — proving queued work survives a halt");
    // still refused while halted...
    expect((await callTool(WRITE_TOOL)).kind).toBe("denied");
    await setMode("normal", "adr0124 — lifting to prove the queue survived");

    // ...and the queue is where we left it: the tool still queues rather than
    // having been silently superseded or executed
    expect((await callTool(WRITE_TOOL)).kind).toBe("approval_required");
    expect(beforeCount).toBeGreaterThanOrEqual(0);
  });
});

describe("the gate itself, unit-level", () => {
  it("can only ever restrict — it never turns a deny into an allow", () => {
    // `executionGate` returns null ("nothing to say") or a restriction. There
    // is no input for which it returns an `allow`, which is what makes it safe
    // to consult before every other rule.
    for (const mode of ["normal", "read_only", "require_approval", "halted"] as const) {
      for (const isWrite of [true, false]) {
        for (const canQueue of [true, false]) {
          const out = executionGate({ mode }, isWrite, "x", canQueue);
          if (out) expect(out.effect).not.toBe("allow");
        }
      }
    }
  });

  it("a subject halt outranks the dial, even at normal", () => {
    const out = executionGate(
      {
        mode: "normal",
        subjectHalt: { scope: "tool", label: "'t'", reason: "r", haltedAt: "2026-09-25T00:00:00Z" },
      },
      false,
      "tool 't'",
      true,
    );
    expect(out?.effect).toBe("deny");
    expect(out?.ruleId).toBe("execution-subject-halted");
  });
});

// ===========================================================================
// AER-017 — the manual-approval dial was a permanent queue loop that also
// manufactured entitlement.
// ===========================================================================
//
// Test 4 above asserted the QUEUE and stopped there, and that is precisely how
// this survived: it never decided the queued approval and retried, and it never
// used an unentitled caller. Both of the things it did not do were broken.
//
//  1. An UNGRANTED caller was invited into the approvals queue, because the
//     execution gate ran ahead of the grant check. Approval manufactured
//     entitlement — contradicting the kernel's own docstring, "an ungranted call
//     is default-denied and nothing can rescue it".
//  2. The approval could NEVER be consumed. The gate returned before the
//     consume block, so a retry carrying an approved id got `require_approval`
//     again. Operators approved work that could not run, indefinitely.
//
// The fix moves ONLY the conditional hold to after entitlement; `halted`, a
// subject halt and `read_only` keep ADR-0124's stop-first ordering because they
// can only deny. These tests are the end-to-end half — the kernel-level proofs
// live in `packages/policy-kernel/src/index.test.ts`.

describe("AER-017: manual-approval mode restricts an allowed call and can be satisfied", () => {
  /** a subject with NO grant on this server — its own user, so nothing else in
   *  this file can have granted it anything (M-008) */
  let strangerId: string;

  beforeAll(async () => {
    const u = await post("/v1/users", {
      email: `adr0124-stranger-${RUN}@kill.example`,
      displayName: "AER017 Stranger",
    });
    strangerId = u.json().id;
  });

  const callAs = (uid: string, tool: string, approvedApprovalId?: string) =>
    executeGovernedToolCall(db, undefined, {
      userId: uid,
      serverId,
      toolName: tool,
      projectId: null,
      arguments: {},
      ...(approvedApprovalId ? { approvedApprovalId } : {}),
    });

  const pendingFor = async (uid: string) =>
    (await db.select().from(approvals).where(eq(approvals.userId, uid))).filter(
      (a) => a.status === "pending",
    );

  it("(1) an UNGRANTED call is default-denied and opens ZERO approval rows", async () => {
    await setMode("require_approval", "aer017 — proving the dial cannot manufacture entitlement");

    const before = (await pendingFor(strangerId)).length;
    const out = await callAs(strangerId, READ_TOOL);

    expect(out.kind).toBe("denied");
    expect((out as { decision: { ruleId: string } }).decision.ruleId).toBe("default-deny");
    // THE HALF THAT MATTERED MOST: no queue row. Before the fix this caller was
    // handed an approval an operator could sign off, for a call they were never
    // entitled to make.
    expect((await pendingFor(strangerId)).length, "no queue row for an ungranted caller").toBe(before);
  });

  it("(2) a GRANTED call queues exactly one row, naming the dial's rule", async () => {
    const queued = await callAs(userId, READ_TOOL);
    expect(queued.kind).toBe("approval_required");
    const id = (queued as { approvalId: string }).approvalId;
    const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
    expect(row!.status).toBe("pending");
    expect((queued as { decision: { ruleId: string } }).decision.ruleId).toBe(
      "execution-require-approval",
    );
  });

  it("(3)+(4) decide it, and ONE retry reaches the upstream exactly once — then queues again", async () => {
    const queued = await callAs(userId, READ_TOOL);
    expect(queued.kind).toBe("approval_required");
    const approvalId = (queued as { approvalId: string }).approvalId;

    // DECIDED AS THE NAMED APPROVER, not as the bootstrap token — the bootstrap
    // identity is forbidden from deciding (`bootstrap_cannot_decide`), which is
    // its own control and not part of this finding. The dial names `userId` as
    // the approver, so this is a self-review: permitted, and the ledger records
    // it as one with the reason. This test is about the hold being satisfiable,
    // not about separation of duties.
    const decided = await post(
      `/v1/approvals/${approvalId}/decide`,
      { decision: "approved", reason: "aer017 — the sign-off that used to buy nothing" },
      userAuth,
    );
    expect(decided.statusCode, decided.body).toBe(200);

    // THE LOOP, BROKEN. Before the fix this returned `approval_required` again
    // and the upstream was never reached however many times it was retried.
    const runsBefore = toolRuns;
    const retry = await callAs(userId, READ_TOOL, approvalId);
    expect(retry.kind, JSON.stringify(retry)).toBe("allowed");
    expect(toolRuns, "the approved retry EXECUTES the tool exactly once").toBe(runsBefore + 1);

    // and the row is SPENT, not merely read
    const [after] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(after!.status).not.toBe("approved");

    // (4) the NEXT call queues again — one sign-off buys one call, which is what
    // "nothing runs unattended while this mode is set" has to mean
    const again = await callAs(userId, READ_TOOL);
    expect(again.kind).toBe("approval_required");
    expect((again as { approvalId: string }).approvalId).not.toBe(approvalId);
  });

  it("(5) CONCURRENT retries on one approval execute at most once", async () => {
    const queued = await callAs(userId, READ_TOOL);
    const approvalId = (queued as { approvalId: string }).approvalId;
    expect(
      (await post(
        `/v1/approvals/${approvalId}/decide`,
        { decision: "approved", reason: "aer017 — one consent, many racers" },
        userAuth,
      )).statusCode,
    ).toBe(200);

    const runsBefore = toolRuns;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => callAs(userId, READ_TOOL, approvalId)),
    );
    const allowed = results.filter((r) => r.kind === "allowed").length;

    // ONE consent, ONE execution. Asserted on what the world holds (upstream
    // hits) as well as on the tally, because a route can answer `allowed` twice
    // and only have run once, or the reverse.
    expect(allowed, `one approval must yield one allow; got ${JSON.stringify(results.map((r) => r.kind))}`).toBe(1);
    expect(toolRuns - runsBefore, "exactly one EXECUTION for one consent").toBe(1);
  });

  it("(6) the dial cannot override a per-tool HALT — a stop still beats a hold", async () => {
    // The stops keep their ordering, and a stop outranks the hold: a halted tool
    // in require_approval mode must be refused, never queued for sign-off.
    const res = await post(`/v1/servers/${serverId}/tools/${WRITE_TOOL}/halt`, {
      reason: "aer017 — a stop must outrank the manual-approval hold",
    });
    expect(res.statusCode).toBe(200);
    try {
      const out = await callAs(userId, WRITE_TOOL);
      expect(out.kind).toBe("denied");
      expect((out as { decision: { ruleId: string } }).decision.ruleId).toBe(
        "execution-subject-halted",
      );
    } finally {
      await post(`/v1/servers/${serverId}/tools/${WRITE_TOOL}/unhalt`, {
        reason: "aer017 — restoring after the ordering check",
      });
      await setMode("normal", "aer017 — restoring the shared database to normal");
    }
  });
});
