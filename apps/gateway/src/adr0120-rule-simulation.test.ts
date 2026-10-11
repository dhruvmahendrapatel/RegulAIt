import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  and,
  approvals,
  auditLog,
  configVersions,
  createDb,
  eq,
  policySimulationFlips,
  policySimulations,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";

// ADR-0181: this file pins behaviour against a LOCAL MCP double (127.0.0.1, registered
// seconds ago), not the strict admission defaults — relaxed explicitly, restored after.
let restoreStrictAdmission: (() => Promise<void>) | undefined;

/**
 * ADR-0120 — POLICY SIMULATION FOR A PROPOSED APPROVAL RULE.
 *
 * THE TWO CLAIMS WORTH TESTING ARE "IT PREDICTS" AND "IT EXECUTES NOTHING",
 * and the second is the one a compliance buyer actually cares about. A dry run
 * that quietly created an approvals row, or wrote a canary observation per
 * replayed decision, would be worse than no preview — so the execution
 * assertions are deltas around the simulation call, paired with a positive
 * assertion that the simulation really did run and really did find flips
 * (M-033: "nothing happened" is also what a no-op returns).
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `adr0120-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const TOOL = `adr0120_echo_${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let approverId: string;
/** ADR-0120 correction: a caller with NO entitlement to TOOL, so the kernel
 * decides without a stored rule row and hands back a SYMBOLIC rule id. */
let strangerId: string;
let serverId: string;
let ruleId: string;
let upstreamClose: () => Promise<void>;

async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        const mcp = new McpServer({ name: `adr0120-up-${RUN}`, version: "0.0.1" });
        mcp.registerTool(
          TOOL,
          { description: "echo", inputSchema: {}, annotations: { readOnlyHint: true } },
          async () => ({ content: [{ type: "text", text: "ok" }] }),
        );
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

const countAudit = async (rule: string) =>
  (await db.select().from(auditLog).where(eq(auditLog.ruleId, rule))).length;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "f".repeat(64) });

  const mk = async (tag: string) => {
    const u = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: AUTH,
      payload: { email: `adr0120-${tag}-${RUN}@example.com`, displayName: `ADR120 ${tag}` },
    });
    return u.json().id as string;
  };
  userId = await mk("caller");
  approverId = await mk("approver");
  strangerId = await mk("stranger");

  const up = await startUpstream();
  upstreamClose = up.close;
  const s = await app.inject({
    method: "POST",
    url: "/v1/servers",
    headers: AUTH,
    payload: { name: `adr0120-server-${RUN}`, url: up.url },
  });
  serverId = s.json().id;
  await app.inject({ method: "POST", url: `/v1/servers/${serverId}/sync`, headers: AUTH });
  await app.inject({
    method: "POST",
    url: "/v1/grants/tools",
    headers: AUTH,
    payload: { userId, serverId, toolName: TOOL, mode: "readwrite" },
  });

  // THE RECORDED TRANSCRIPT. Three real governed calls, allowed, so the replay
  // below has something to re-decide.
  for (let i = 0; i < 3; i++) {
    const out = await executeGovernedToolCall(db, undefined, {
      userId,
      serverId,
      toolName: TOOL,
      projectId: null,
      arguments: {},
    });
    expect(out.kind).toBe("allowed");
  }

  // A FOURTH transcript row, belonging to somebody who is NOT entitled to this
  // tool. Written straight into the ledger because that is what it is — a
  // historical decision, recorded when the entitlement existed or under an
  // earlier posture — and the replay reads the ledger, not the grants.
  //
  // It is here because of a real defect this suite did not catch. When the
  // replay re-decides this row the kernel has no stored rule to point at, so
  // `Decision.ruleId` comes back SYMBOLIC ('default-deny' and its siblings)
  // rather than as a uuid, and that value was being written into
  // `policy_simulation_flips.policy_id`, a uuid column. The insert failed
  // 22P02 and the whole simulation returned 500 — on precisely the traffic a
  // restrictive-rule preview exists to be run against, while passing here
  // because every fixture caller was entitled and every decision named a row.
  await db.insert(auditLog).values({
    userId: strangerId,
    objectType: "mcp_tool",
    objectId: serverId,
    serverId,
    toolName: TOOL,
    effect: "allow",
    ruleId: "adr0120-historical-allow",
    ruleChain: [],
    reason: "a decision recorded before this caller lost the entitlement",
  });

  // A live approval rule that does NOT match this tool, so today's decisions
  // stand — the candidate below is what changes them.
  const created = await app.inject({
    method: "POST",
    url: "/v1/rules/approvals",
    headers: AUTH,
    payload: {
      userId,
      serverId,
      toolName: `adr0120_unrelated_${RUN}`,
      approverUserId: approverId,
    },
  });
  expect(created.statusCode).toBe(201);
  ruleId = created.json().id;
});

afterAll(async () => {
  await restoreStrictAdmission?.();
  await upstreamClose?.();
  await app.close();
});

/** propose a version of the live rule that WOULD catch the replayed tool */
async function proposeRuleVersion(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/config-versions/approval_rule/${ruleId}`,
    headers: AUTH,
    payload: { body: { toolName: TOOL, approverUserId: approverId } },
  });
  expect(res.statusCode).toBe(201);
  // The create returns { version, activated } where `version` is the ROW, not
  // the number — so the id comes off it directly.
  const created = res.json().version as { id: string; version: number };
  expect(typeof created.id).toBe("string");
  return created.id;
}

describe("a proposed APPROVAL RULE can be previewed", () => {
  it("predicts the flips, and the stored preview names the rule candidate", async () => {
    const versionId = await proposeRuleVersion();

    const res = await app.inject({
      method: "POST",
      url: "/v1/policy-simulations",
      headers: AUTH,
      payload: { ruleVersionId: versionId, windowDays: 1 },
    });
    expect(res.statusCode, res.body).toBe(201);
    const sim = res.json().simulation ?? res.json();

    // it really replayed something — without this the zero-execution
    // assertions below would be the zeros of a run that did nothing
    expect(sim.considered).toBeGreaterThan(0);
    expect(sim.newlyApprovalRequired).toBeGreaterThan(0);

    const [row] = await db
      .select()
      .from(policySimulations)
      .where(eq(policySimulations.id, sim.id));
    expect(row!.candidateArtifactType).toBe("approval_rule");
    expect(row!.candidateVersionId).toBe(versionId);
    // the ABAC column is empty for this kind — the CHECK allows exactly one
    expect(row!.policyVersionId).toBeNull();
  });

  it("EXECUTES NOTHING — no approval queued, and no canary observation written", async () => {
    const versionId = await proposeRuleVersion();

    const approvalsBefore = (
      await db.select().from(approvals).where(eq(approvals.userId, userId))
    ).length;
    const canaryBefore = await countAudit("config-canary-observed");
    const auditBefore = (
      await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.objectType, "mcp_tool"), eq(auditLog.userId, userId)))
    ).length;

    const res = await app.inject({
      method: "POST",
      url: "/v1/policy-simulations",
      headers: AUTH,
      payload: { ruleVersionId: versionId, windowDays: 1 },
    });
    expect(res.statusCode).toBe(201);
    // positive control: the run found flips, so the deltas below are the
    // deltas of a simulation that genuinely replayed the transcript
    const sim = res.json().simulation ?? res.json();
    expect(sim.newlyApprovalRequired).toBeGreaterThan(0);

    expect((await db.select().from(approvals).where(eq(approvals.userId, userId))).length).toBe(
      approvalsBefore,
    );
    expect(await countAudit("config-canary-observed")).toBe(canaryBefore);
    // and it did not append to the transcript it was reading
    expect(
      (
        await db
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.objectType, "mcp_tool"), eq(auditLog.userId, userId)))
      ).length,
    ).toBe(auditBefore);
  });

  it("the preview itself is audited as a restriction-rule event", async () => {
    const versionId = await proposeRuleVersion();
    const before = await countAudit("policy-simulation-run");
    await app.inject({
      method: "POST",
      url: "/v1/policy-simulations",
      headers: AUTH,
      payload: { ruleVersionId: versionId, windowDays: 1 },
    });
    expect(await countAudit("policy-simulation-run")).toBe(before + 1);
  });
});

describe("what it refuses rather than approximates", () => {
  it("a DATA-SCOPE rule is refused, because the transcript records counts and never arguments", async () => {
    // a real data_scope_rule version, so the refusal is about the KIND rather
    // than about an unknown id
    const [inserted] = await db
      .insert(configVersions)
      .values({
        artifactType: "data_scope_rule",
        artifactId: ruleId,
        version: 1,
        status: "draft",
        body: { toolName: TOOL },
        authorUserId: null,
      })
      .returning();

    const res = await app.inject({
      method: "POST",
      url: "/v1/policy-simulations",
      headers: AUTH,
      payload: { ruleVersionId: inserted!.id, windowDays: 1 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("artifact_not_simulable");
    // the refusal explains itself — an operator should not have to read an ADR
    expect(res.json().detail).toMatch(/argument/i);

    // and nothing was stored: a refused preview is not a preview
    const rows = await db
      .select()
      .from(policySimulations)
      .where(eq(policySimulations.candidateVersionId, inserted!.id));
    expect(rows.length).toBe(0);
  });

  it("naming both candidates, or neither, is refused before anything runs", async () => {
    const versionId = await proposeRuleVersion();
    const both = await app.inject({
      method: "POST",
      url: "/v1/policy-simulations",
      headers: AUTH,
      payload: { ruleVersionId: versionId, policyVersionId: versionId, windowDays: 1 },
    });
    expect(both.statusCode).toBe(400);

    const neither = await app.inject({
      method: "POST",
      url: "/v1/policy-simulations",
      headers: AUTH,
      payload: { windowDays: 1 },
    });
    expect(neither.statusCode).toBe(400);
  });

  it("an unknown rule version is a 404, not an empty preview", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/policy-simulations",
      headers: AUTH,
      payload: { ruleVersionId: "00000000-0000-4000-8000-0000000000ff", windowDays: 1 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("unknown_rule_version");
  });
});

describe("the flip row can name a rule that is not a row", () => {
  /**
   * PASS CRITERIA, WRITTEN BEFORE THE RUN (M-023):
   *
   *  1. The simulation returns 201 over a transcript containing a decision the
   *     kernel reaches WITHOUT a stored rule. It used to return 500.
   *  2. At least one stored flip carries a NON-UUID `decisionRuleId` — the
   *     symbolic id, kept rather than dropped, because it is the reason the row
   *     flipped and a blast-radius preview is read for exactly that.
   *  3. `policyId` is NULL on every flip of a rule simulation. It is an
   *     `abac_policies` reference and a rule candidate has no policy; writing
   *     the kernel's id there is the defect itself, so asserting 2 without 3
   *     would leave the bad write available under a new name.
   */
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it("survives a decision with a SYMBOLIC rule id, and keeps it", async () => {
    const versionId = await proposeRuleVersion();
    const res = await app.inject({
      method: "POST",
      url: "/v1/policy-simulations",
      headers: AUTH,
      payload: { ruleVersionId: versionId, windowDays: 1 },
    });
    // criterion 1 — the body is attached because "500 internal" told us
    // nothing the first time this failed
    expect(res.statusCode, res.body).toBe(201);
    const simId = (res.json().simulation ?? res.json()).id as string;

    const flips = await db
      .select()
      .from(policySimulationFlips)
      .where(eq(policySimulationFlips.simulationId, simId));
    expect(flips.length).toBeGreaterThan(0);

    // criterion 2 — the symbolic id is PRESENT, not silently nulled. Asserting
    // only "no crash" would pass against a fix that dropped the value.
    const symbolic = flips.filter(
      (f) => f.decisionRuleId !== null && !UUID.test(f.decisionRuleId),
    );
    expect(symbolic.length).toBeGreaterThan(0);

    // criterion 3 — and it did not simply move into the uuid column
    for (const f of flips) expect(f.policyId).toBeNull();
  });
});
