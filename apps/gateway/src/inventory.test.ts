/**
 * ADR-0082 — the standing agent dependency inventory (gap L7).
 *
 * The load-bearing property under test: GRANTED AND OBSERVED NEVER BLEND,
 * and each side is computed from the ledger that owns it —
 *
 *   granted   grant tables + role bundles, minus per-user revocations
 *             (an agent-revoked user is NOT a holder; their tool grants
 *             must not leak into the agent's granted-tool set — a control
 *             below proves both subtractions);
 *   observed  usage_events for dispatches, trace spans for tool/connector
 *             calls attributed through the PARENT span's agent (a tool call
 *             under a DIFFERENT agent's span must not count — control), and
 *             agent→agent feeds aggregated from orchestration run history
 *             (a planned run and a never-started dependent node contribute
 *             NO edge — two controls; a reassigned owner's edge points at
 *             the agent that actually ran — proved).
 *
 * Non-vacuity was proven the M-002 way during review: no-op the feed-edge
 * aggregation (return [] from computeFeedEdges) and the feed tests here fail;
 * constant-ify the posture governance query and the posture suite's delta
 * test fails (documented in ADR-0082).
 *
 * Shares one DB with the other gateway suites (fileParallelism off);
 * everything here is prefixed iv-. Per-OUR-agent numbers are absolute (no
 * other suite touches agents created here); anything org-wide is a delta
 * (M-008). The usage rows this suite adds to the ONE spend ledger are
 * deleted in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
// ADR-0181: this file registers a LOCAL MCP double (127.0.0.1 / localhost, registered seconds ago) to pin
// unrelated behaviour, not the strict admission defaults — relaxed explicitly here, restored in afterAll.
let restoreStrictAdmission: (() => Promise<void>) | undefined;
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiUseCases,
  createDb,
  evalDatasets,
  evalRuns,
  inArray,
  modelCardApprovals,
  modelCards,
  orchestrationRuns,
  redteamLibraries,
  redteamRuns,
  runMigrations,
  traceSpans,
  traces,
  usageEvents,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "iv-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let holderId: string; // direct grant on agent A
let holderAuth: { authorization: string };
let roleUserId: string; // reaches agent A only through a role
let revokedId: string; // direct grant on agent A, then agent-revoked
let agentA: string; // the agent under inventory
let agentB: string; // fed by A in two runs
let agentC: string; // runs a reassigned node
let serverId: string;
let connectorId: string;
const createdUsageIds: string[] = [];

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email.split("@")[0] },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${u.json().id}/keys`,
    payload: { name: "iv-key" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function mkAgent(name: string) {
  const r = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name, provider: "mock", tier: 1, model: "mock-balanced", costPerMTokIn: 1, costPerMTokOut: 2 },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

/** one orchestration run row, verbatim in the shape the kernel persists */
async function seedRun(args: {
  name: string;
  status: "planned" | "running" | "completed" | "aborted";
  nodes: Array<{ id: string; ownerAgentId: string; dependsOn: string[] }>;
  nodeStatuses: Record<string, string>;
  owners?: Record<string, string>;
}) {
  await db.insert(orchestrationRuns).values({
    name: args.name,
    initiatingUserId: holderId,
    graph: {
      run: args.name,
      escalationApproverUserId: holderId,
      nodes: args.nodes.map((n) => ({ ...n, title: n.id, mode: "execute", parallelizable: true })),
    },
    state: {
      status: args.status === "planned" ? "planned" : args.status,
      nodeStatuses: args.nodeStatuses,
      attempts: {},
      owners: args.owners ?? Object.fromEntries(args.nodes.map((n) => [n.id, n.ownerAgentId])),
      lastError: {},
    },
    status: args.status,
  });
}

const listInventory = async (auth = AUTH) =>
  app.inject({ method: "GET", headers: auth, url: "/v1/inventory/agents" });
const detailOf = async (agentId: string, auth = AUTH) =>
  app.inject({ method: "GET", headers: auth, url: `/v1/inventory/agents/${agentId}` });

interface ListedAgent {
  id: string;
  name: string;
  credential: { source: string; platformCredential: boolean };
  modelCard: { cards: number; liveApproved: boolean };
  granted: { directUsers: number; grantingRoles: string[]; revokedUsers: number; effectiveHolders: number };
  observed: { dispatchesInWindow: number; costUsdInWindow: number; lastDispatchAt: string | null; feedsOut: number; feedsIn: number };
  coverage: {
    redteamRunsInWindow: number;
    everProbed: boolean;
    latestAsr: { asr: number | null; asrTrials: number; measurementQuality: string | null } | null;
    evalRunsInWindow: number;
    groundednessRunsInWindow: number;
  };
  links: { useCases: number; risks: number; openRisks: number };
}

async function listedAgent(agentId: string): Promise<ListedAgent> {
  const res = await listInventory();
  expect(res.statusCode).toBe(200);
  const row = (res.json().agents as ListedAgent[]).find((a) => a.id === agentId);
  expect(row, `agent ${agentId} missing from the inventory`).toBeTruthy();
  return row!;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c".repeat(64) });

  const holder = await makeUser("iv-holder@example.com");
  holderId = holder.id;
  holderAuth = holder.auth;
  roleUserId = (await makeUser("iv-role-user@example.com")).id;
  revokedId = (await makeUser("iv-revoked@example.com")).id;

  agentA = await mkAgent("iv-agent-a");
  agentB = await mkAgent("iv-agent-b");
  agentC = await mkAgent("iv-agent-c");

  // grants on A: holder DIRECT; roleUser via a role bundle; revoked DIRECT
  // then agent-revoked (the subtraction the granted block must honour)
  await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: holderId, agentId: agentA } });
  await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: revokedId, agentId: agentA } });
  const role = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/roles",
    payload: { name: "iv-analyst", description: "iv analyst" },
  });
  const roleId = role.json().id as string;
  await app.inject({ method: "POST", headers: AUTH, url: `/v1/roles/${roleId}/grants/agents`, payload: { agentId: agentA } });
  await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${roleUserId}/roles`, payload: { roleId } });
  const revoke = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${revokedId}/revocations/agents`,
    payload: { agentId: agentA, reason: "iv-revoked for the inventory suite" },
  });
  expect(revoke.statusCode, revoke.body).toBe(201);

  // MCP server + tool grants for the HOLDER: one granted tool, one granted
  // tool that is then fully revoked, and one tool granted only to the
  // NON-holder (revoked user) — the last two must NOT appear as granted
  const server = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/servers",
    payload: { name: "iv-server", url: "http://127.0.0.1:9" },
  });
  serverId = server.json().id;
  for (const [userId, toolName] of [
    [holderId, "iv-tool-granted"],
    [holderId, "iv-tool-revoked"],
    [revokedId, "iv-tool-nonholder"],
  ] as const) {
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/tools",
      payload: { userId, serverId, toolName },
    });
  }
  const toolRevoke = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/revocations",
    payload: { userId: holderId, serverId, toolName: "iv-tool-revoked" },
  });
  expect(toolRevoke.statusCode, toolRevoke.body).toBe(201);

  // a connector granted to the holder
  const connector = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/connectors",
    payload: { name: "iv-connector", kind: "data" },
  });
  connectorId = connector.json().id;
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/connectors",
    payload: { userId: holderId, connectorId, mode: "readwrite" },
  });
});

afterAll(async () => {
  await restoreStrictAdmission?.();
  if (createdUsageIds.length) {
    await db.delete(usageEvents).where(inArray(usageEvents.id, createdUsageIds));
  }
  await app.close();
  await db.$client.end();
});

describe("scoping", () => {
  it("both inventory endpoints are admin-only via the default gate; unknown agent is a 404", async () => {
    expect((await listInventory(holderAuth)).statusCode).toBe(403);
    expect((await detailOf(agentA, holderAuth)).statusCode).toBe(403);
    expect((await detailOf("00000000-0000-0000-0000-0000000000ab")).statusCode).toBe(404);
  });
});

describe("GRANTED — the entitlement rows, with the revocation subtractions proven", () => {
  it("counts direct, role-derived and revoked holders apart, and the effective set honours the revocation", async () => {
    const a = await listedAgent(agentA);
    // holder + revoked hold DIRECT grants; roleUser arrives via the role;
    // the revocation removes ONE of the direct holders from the effective set
    expect(a.granted.directUsers).toBe(2);
    expect(a.granted.grantingRoles).toContain("iv-analyst");
    expect(a.granted.revokedUsers).toBe(1);
    expect(a.granted.effectiveHolders).toBe(2);
    // an ungranted agent is visibly ungranted, not absent from the inventory
    const c = await listedAgent(agentC);
    expect(c.granted.effectiveHolders).toBe(0);
  });

  it("detail names the holders with HOW they hold (direct vs role), and lists the revoked user apart", async () => {
    const res = await detailOf(agentA);
    expect(res.statusCode).toBe(200);
    const granted = res.json().granted as {
      note: string;
      users: Array<{ id: string; name: string | null; via: string[] }>;
      revokedUsers: Array<{ id: string }>;
      tools: Array<{ serverId: string; serverName: string | null; toolName: string; holders: number }>;
      connectors: Array<{ connectorId: string; connectorName: string | null; modes: string[]; holders: number }>;
    };
    expect(granted.note).toMatch(/not a\s+policy simulation/);
    const holder = granted.users.find((u) => u.id === holderId);
    expect(holder?.via).toEqual(["direct"]);
    const viaRole = granted.users.find((u) => u.id === roleUserId);
    expect(viaRole?.via).toEqual(["role: iv-analyst"]);
    expect(granted.users.some((u) => u.id === revokedId)).toBe(false);
    expect(granted.revokedUsers.map((u) => u.id)).toEqual([revokedId]);
  });

  it("the granted tool/connector sets are the HOLDERS' grant rows: a revoked tool and a non-holder's tool are both absent", async () => {
    const res = await detailOf(agentA);
    const granted = res.json().granted as {
      tools: Array<{ serverName: string | null; toolName: string }>;
      connectors: Array<{ connectorName: string | null; modes: string[] }>;
    };
    const toolNames = granted.tools.map((t) => t.toolName);
    expect(toolNames).toContain("iv-tool-granted");
    // subtracted: the holder's grant on this tool is fully revoked
    expect(toolNames).not.toContain("iv-tool-revoked");
    // subtracted: its only grantee is agent-revoked, hence not a holder
    expect(toolNames).not.toContain("iv-tool-nonholder");
    expect(granted.tools.find((t) => t.toolName === "iv-tool-granted")?.serverName).toBe("iv-server");
    expect(granted.connectors).toEqual([
      expect.objectContaining({ connectorName: "iv-connector", modes: ["readwrite"] }),
    ]);
  });
});

describe("OBSERVED — what the run history recorded, never what a grant implies", () => {
  it("dispatch observations come from the usage ledger and move by exactly the rows written", async () => {
    const before = await listedAgent(agentA);
    const at = new Date();
    const rows = await db
      .insert(usageEvents)
      .values([
        { userId: holderId, objectType: "agent", agentId: agentA, provider: "mock", model: "m", inputTokens: 5, outputTokens: 2, costUsd: 0.5, at },
        { userId: holderId, objectType: "agent", agentId: agentA, provider: "mock", model: "m", inputTokens: 5, outputTokens: 2, costUsd: 0.25, at },
      ])
      .returning({ id: usageEvents.id });
    createdUsageIds.push(...rows.map((r) => r.id));
    const after = await listedAgent(agentA);
    expect(after.observed.dispatchesInWindow).toBe(before.observed.dispatchesInWindow + 2);
    expect(after.observed.costUsdInWindow).toBeCloseTo(before.observed.costUsdInWindow + 0.75, 6);
    expect(after.observed.lastDispatchAt).toBeTruthy();
  });

  it("agent→agent feeds are aggregated from run history: run counts and last-seen ride each edge; planned runs, never-started dependents and self-edges contribute NOTHING; reassignment is honoured", async () => {
    // two REAL completed runs where a's output fed b (the dependent started)
    await seedRun({
      name: "iv-run-1",
      status: "completed",
      nodes: [
        { id: "a", ownerAgentId: agentA, dependsOn: [] },
        { id: "b", ownerAgentId: agentB, dependsOn: ["a"] },
      ],
      nodeStatuses: { a: "done", b: "done" },
    });
    await seedRun({
      name: "iv-run-2",
      status: "completed",
      nodes: [
        { id: "a", ownerAgentId: agentA, dependsOn: [] },
        { id: "b", ownerAgentId: agentB, dependsOn: ["a"] },
        // a self-feed inside one agent: never a cross-agent edge
        { id: "b2", ownerAgentId: agentB, dependsOn: ["b"] },
      ],
      nodeStatuses: { a: "done", b: "done", b2: "done" },
    });
    // CONTROL: a planned run never dispatched — no edge
    await seedRun({
      name: "iv-run-planned",
      status: "planned",
      nodes: [
        { id: "a", ownerAgentId: agentA, dependsOn: [] },
        { id: "x", ownerAgentId: agentC, dependsOn: ["a"] },
      ],
      nodeStatuses: { a: "not_started", x: "not_started" },
    });
    // CONTROL: a running run whose dependent never started — nothing was fed
    await seedRun({
      name: "iv-run-unstarted-dependent",
      status: "running",
      nodes: [
        { id: "a", ownerAgentId: agentA, dependsOn: [] },
        { id: "x", ownerAgentId: agentC, dependsOn: ["a"] },
      ],
      nodeStatuses: { a: "done", x: "not_started" },
    });
    // REASSIGNMENT: the graph says B owns the dependent, the run STATE says C
    // actually ran it — the observed edge must point at C
    await seedRun({
      name: "iv-run-reassigned",
      status: "completed",
      nodes: [
        { id: "a", ownerAgentId: agentA, dependsOn: [] },
        { id: "b", ownerAgentId: agentB, dependsOn: ["a"] },
      ],
      nodeStatuses: { a: "done", b: "done" },
      owners: { a: agentA, b: agentC },
    });

    const res = await detailOf(agentA);
    const feeds = res.json().observed.feeds as {
      out: Array<{ agentId: string; agentName: string | null; observedRuns: number; lastSeenAt: string | null }>;
      in: Array<{ agentId: string }>;
      note: string;
    };
    const toB = feeds.out.find((e) => e.agentId === agentB);
    expect(toB, "A→B must be observed").toBeTruthy();
    expect(toB!.observedRuns).toBe(2); // the two completed runs, NOT the controls
    expect(toB!.agentName).toBe("iv-agent-b");
    expect(toB!.lastSeenAt).toBeTruthy();
    const toC = feeds.out.find((e) => e.agentId === agentC);
    expect(toC, "the reassigned run feeds C, not B").toBeTruthy();
    expect(toC!.observedRuns).toBe(1);
    expect(feeds.note).toMatch(/Only governed runs are visible/);

    // the inbound view agrees, and the list rollup counts the edges
    const bDetail = await detailOf(agentB);
    expect((bDetail.json().observed.feeds.in as Array<{ agentId: string }>).some((e) => e.agentId === agentA)).toBe(true);
    const aRow = await listedAgent(agentA);
    expect(aRow.observed.feedsOut).toBe(2); // A→B and A→C
    const bRow = await listedAgent(agentB);
    expect(bRow.observed.feedsIn).toBe(1);
  });

  it("tool observations attribute through the PARENT span's agent — a call under another agent's dispatch never counts here", async () => {
    const [trace] = await db
      .insert(traces)
      .values({ kind: "dispatch", name: "iv-trace", userId: holderId })
      .returning();
    const now = new Date();
    const [parentA] = await db
      .insert(traceSpans)
      .values({ traceId: trace!.id, seq: 1, kind: "llm", name: "iv-agent-a", status: "ok", startedAt: now, agentId: agentA })
      .returning();
    const [parentB] = await db
      .insert(traceSpans)
      .values({ traceId: trace!.id, seq: 2, kind: "llm", name: "iv-agent-b", status: "ok", startedAt: now, agentId: agentB })
      .returning();
    await db.insert(traceSpans).values([
      // two calls to the same tool under A, one under B (the control)
      { traceId: trace!.id, parentSpanId: parentA!.id, seq: 3, kind: "tool", name: "iv-observed-tool", status: "ok", startedAt: now, mcpServerId: serverId },
      { traceId: trace!.id, parentSpanId: parentA!.id, seq: 4, kind: "tool", name: "iv-observed-tool", status: "ok", startedAt: now, mcpServerId: serverId },
      { traceId: trace!.id, parentSpanId: parentB!.id, seq: 5, kind: "tool", name: "iv-observed-tool", status: "ok", startedAt: now, mcpServerId: serverId },
      // a governed connector call under A
      { traceId: trace!.id, parentSpanId: parentA!.id, seq: 6, kind: "connector", name: "iv-connector.list", status: "ok", startedAt: now, connectorId },
    ]);

    const aDetail = await detailOf(agentA);
    const observed = aDetail.json().observed as {
      note: string;
      mcpTools: Array<{ serverName: string | null; toolName: string; calls: number; lastSeenAt: string }>;
      connectors: Array<{ connectorName: string | null; calls: number }>;
    };
    expect(observed.note).toMatch(/UNOBSERVED/);
    const tool = observed.mcpTools.find((t) => t.toolName === "iv-observed-tool");
    expect(tool).toBeTruthy();
    expect(tool!.calls).toBe(2); // A's two calls — never B's
    expect(tool!.serverName).toBe("iv-server");
    expect(observed.connectors).toEqual([
      expect.objectContaining({ connectorName: "iv-connector", calls: 1 }),
    ]);

    const bDetail = await detailOf(agentB);
    const bTool = (bDetail.json().observed.mcpTools as Array<{ toolName: string; calls: number }>).find(
      (t) => t.toolName === "iv-observed-tool",
    );
    expect(bTool?.calls).toBe(1);
  });
});

describe("coverage and links — the governance objects already pointing at the agent", () => {
  it("red-team and eval coverage, model-card standing, and use-case/risk links all read their own ledgers", async () => {
    // red-team run for A, with the full FK chain the ledger requires
    const [ds] = await db
      .insert(evalDatasets)
      .values({ name: "iv-redteam-ds", version: 1, scorerKind: "contains" })
      .returning();
    const [er] = await db
      .insert(evalRuns)
      .values({ datasetId: ds!.id, datasetVersion: 1, agentId: agentA, agentName: "iv-agent-a", trigger: "manual", status: "completed" })
      .returning();
    const [lib] = await db.insert(redteamLibraries).values({ name: "iv-lib", version: 1 }).returning();
    await db.insert(redteamRuns).values({
      libraryId: lib!.id,
      libraryName: "iv-lib",
      libraryVersion: 1,
      evalRunId: er!.id,
      agentId: agentA,
      agentName: "iv-agent-a",
      probes: 4,
      resisted: 3,
      defeated: 1,
      trials: 3,
      asr: 0.25,
      asrLower: 0.1,
      asrUpper: 0.5,
      asrTrials: 12,
      measurementQuality: "measured",
    });
    // a groundedness eval for A
    const [gds] = await db
      .insert(evalDatasets)
      .values({ name: "iv-grounded-ds", version: 1, scorerKind: "claim_support" })
      .returning();
    await db.insert(evalRuns).values({
      datasetId: gds!.id,
      datasetVersion: 1,
      agentId: agentA,
      agentName: "iv-agent-a",
      trigger: "manual",
      status: "completed",
      passRate: 0.9,
    });
    // a LIVE model card sign-off
    const [card] = await db
      .insert(modelCards)
      .values({ agentId: agentA, intendedUse: "iv inventory coverage" })
      .returning();
    await db.insert(modelCardApprovals).values({
      cardId: card!.id,
      status: "approved",
      approverUserId: holderId,
      validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    // a use case naming A, and a risk scoped to A
    await db.insert(aiUseCases).values({
      name: "iv-use-case",
      description: "iv",
      ownerUserId: holderId,
      businessContext: "iv",
      dataSensitivity: "internal",
      intendedAgentIds: [agentA],
    });
    const risk = await app.inject({
      method: "POST",
      headers: holderAuth,
      url: "/v1/risks",
      payload: {
        title: "iv-risk",
        description: "iv scenario",
        category: "prompt_injection",
        likelihood: "medium",
        impact: "medium",
        agentId: agentA,
      },
    });
    expect(risk.statusCode).toBe(201);

    const a = await listedAgent(agentA);
    expect(a.coverage.everProbed).toBe(true);
    expect(a.coverage.redteamRunsInWindow).toBe(1);
    // the ASR never travels bare: denominator and quality label ride along
    expect(a.coverage.latestAsr).toMatchObject({ asr: 0.25, asrTrials: 12, measurementQuality: "measured" });
    expect(a.coverage.evalRunsInWindow).toBe(2);
    expect(a.coverage.groundednessRunsInWindow).toBe(1);
    expect(a.modelCard).toEqual({ cards: 1, liveApproved: true });
    expect(a.links).toEqual({ useCases: 1, risks: 1, openRisks: 1 });

    // an unprobed agent reads as UNPROBED, never as clean
    const c = await listedAgent(agentC);
    expect(c.coverage.everProbed).toBe(false);
    expect(c.coverage.latestAsr).toBeNull();
    expect(c.modelCard.liveApproved).toBe(false);

    // the detail lists the linked objects by name
    const detail = await detailOf(agentA);
    expect(detail.json().links.useCases).toEqual([
      expect.objectContaining({ name: "iv-use-case", status: "proposed" }),
    ]);
    expect(detail.json().links.risks).toEqual([
      expect.objectContaining({ title: "iv-risk", category: "prompt_injection", status: "open" }),
    ]);
  });

  it("the list separates the two sides structurally: granted and observed are sibling blocks and the notes say what each is", async () => {
    const res = await listInventory();
    const body = res.json() as { notes: { granted: string; observed: string }; agents: ListedAgent[] };
    expect(body.notes.granted).toMatch(/MAY happen/);
    expect(body.notes.observed).toMatch(/DID happen/);
    const a = body.agents.find((x) => x.id === agentA)!;
    expect(a).toHaveProperty("granted");
    expect(a).toHaveProperty("observed");
    expect(a.credential.source).toMatch(/mock/);
  });
});
