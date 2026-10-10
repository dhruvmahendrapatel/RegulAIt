/**
 * ADR-0070 — TRACE OBSERVABILITY, proved by attack.
 *
 * WHAT THIS FILE IS TRYING TO MAKE IMPOSSIBLE TO FAKE. Every one of these is a
 * way a "trace feature" can look finished and be worthless:
 *
 *  1. **A FLAT LIST RELABELLED "A TREE".** An orchestration run with a KNOWN
 *     shape (one node, a tool-using worker loop) is driven through the real
 *     endpoints, and the resulting tree's PARENT/CHILD structure is asserted to
 *     match it: `run` -> `run_node` -> `llm` (the turn) -> `tool` (the call that
 *     turn made). Depths are asserted, and each child is asserted to name its
 *     actual parent's id. A recorder that wrote four sibling spans and let the
 *     UI indent them by `kind` fails every assertion here.
 *
 *  2. **A TRACE THAT ONLY SHOWS WHAT WORKED.** The whole product claim is that
 *     a trace explains an ABSENCE. So: a user who is not entitled to an agent
 *     invokes it, and the assertion is that a span EXISTS, that its status is
 *     `denied`, that its `statusReason` is the kernel's own reason, and that it
 *     REFERENCES the audit row. A trace with no span for the refusal fails.
 *
 *  3. **A SILENT FALLBACK.** ADR-0066 hops are audited but auditing requires
 *     knowing to look. A chain is configured, the primary is made to fail at
 *     the TRANSPORT layer (the mock's `<<upstream-error:model>>` sentinel), and
 *     the hop that served is asserted to be a `fallback_hop` span nested UNDER
 *     the failed primary's span. A flat pair of siblings fails.
 *
 *  4. **A COST THE TRACE INVENTED.** The span's cost/token figures are asserted
 *     EQUAL to the `usage_events` row the span REFERENCES — joined by
 *     `usage_event_id`, not merely "both are plausible". A recorder that
 *     recomputed price from the agent's rate card would drift the first time a
 *     rate card changed, and this test is what stops that being invisible.
 *
 *  5. **A READ SURFACE THAT IS DEFAULT-ALLOW.** Another user's trace id is
 *     requested with a real credential, and a 403 is required. The fleet list
 *     is requested by a non-admin naming somebody else, and a 403 is required —
 *     not a silently-narrowed result set, which is the failure mode where a
 *     boundary looks enforced and is not.
 *
 *  6. **AN EXPORTER THAT PRETENDS.** With nothing configured, the export route
 *     must answer a real 409 naming what is missing — because ADR-0041 makes
 *     air-gapped primary and "no exporter" is the SHIPPED state, not a fault.
 *     With an endpoint that is not on the egress allow-list, a real 403 from the
 *     same guard every other outbound surface uses.
 *
 *  7. **AN ORDERING THAT IS "USUALLY RIGHT".** Sibling order is asserted on the
 *     stored `seq`, and the list endpoint's order is asserted explicitly. A list
 *     without an ORDER BY passed here for months once already.
 *
 * SHARED-STATE DISCIPLINE. This file writes `org_settings.tracingEnabled` in
 * exactly one test and restores the ENTIRE singleton snapshot in `afterAll`.
 * Everything it creates is `tr-` prefixed and removed.
 */
import { agentsWithIdentity, sponsorsWithGrants } from "./testing/agent-own-grants.js";
import { autoGrantCreatedAgentsForTest } from "./testing/agent-own-grants.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  agents,
  and,
  auditLog,
  connectors,
  createDb,
  desc,
  eq,
  evalDatasets,
  evalRuns,
  inArray,
  mcpServers,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  TRACE_SPAN_KINDS,
  traceSpans,
  traces,
  usageEvents,
  users,
  workflowTemplates,
  type Db,
  type TraceSpanRow,
} from "@regulait/db";
import { buildSpanTree, flattenSpanTree, buildOtlpPayload, otlpSpanId, otlpTraceId } from "@regulait/shared";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";

// ADR-0181: this file pins behaviour against a LOCAL MCP double (127.0.0.1, registered
// seconds ago), not the strict admission defaults — relaxed explicitly, restored after.
let restoreStrictAdmission: (() => Promise<void>) | undefined;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

// --- upstream test MCP server (stateless: fresh server+transport per request) ---

function buildUpstreamMcpServer(): McpServer {
  const server = new McpServer({ name: "upstream-tools", version: "0.0.1" });
  server.registerTool(
    "get_time",
    { description: "Returns a fixed time", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: "text", text: "12:00" }] }),
  );
  server.registerTool(
    "write_note",
    { description: "Writes a note", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text: `wrote: ${text}` }] }),
  );
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

const BOOT = "tr-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;

let anaId: string;
let anaAuth: { authorization: string };
let borisId: string;
let borisAuth: { authorization: string };
let adminId: string;
let adminAuth: { authorization: string };

let mainAgentId: string; //  tr-main       model tr-main-model      (ANA)
let hopAgentId: string; //   tr-hop        model tr-hop-model       (ANA)
let secretAgentId: string; // tr-secret    model tr-secret-model    (BORIS only)

const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
/** ADR-0070 amendment (2026-08-15) — fixtures for the three seams that had a
 * declared span kind and no writer: connector, workflow_stage, eval_case. */
let trConnectorId: string;
let trTemplateId: string;
let trDatasetId: string;
let priorOrg: Record<string, unknown> | null = null;
let upstream: Awaited<ReturnType<typeof startUpstream>>;
let toolServerId: string;

async function makeUser(email: string, isAdmin = false) {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email, displayName: email.split("@")[0]!, isAdmin },
  });
  expect(u.statusCode, JSON.stringify(u.json())).toBe(201);
  const id = u.json().id as string;
  createdUserIds.push(id);
  const k = await app.inject({
    method: "POST",
    url: `/v1/users/${id}/keys`,
    headers: AUTH,
    payload: { name: "tr" },
  });
  expect(k.statusCode).toBe(201);
  return { id, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function makeAgent(name: string, model: string, tier = 1) {
  const r = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name, provider: "mock", model, tier, costPerMTokIn: 3, costPerMTokOut: 7 },
  });
  expect(r.statusCode, JSON.stringify(r.json())).toBe(201);
  const id = r.json().id as string;
  createdAgentIds.push(id);
  return id;
}

async function grant(userId: string, agentId: string) {
  const r = await app.inject({
    method: "POST",
    url: "/v1/grants/agents",
    headers: AUTH,
    payload: { userId, agentId },
  });
  expect(r.statusCode, JSON.stringify(r.json())).toBe(201);
}

async function invoke(
  auth: { authorization: string },
  agentId: string,
  input: string,
  extra: Record<string, unknown> = {},
) {
  return app.inject({
    method: "POST",
    url: `/v1/agents/${agentId}/invoke`,
    headers: auth,
    payload: { mode: "execute", input, dispatch: true, ...extra },
  });
}

/** Every span of a trace, in stored order — the same order the API returns. */
async function spansOf(traceId: string): Promise<TraceSpanRow[]> {
  return db
    .select()
    .from(traceSpans)
    .where(eq(traceSpans.traceId, traceId))
    .orderBy(traceSpans.seq);
}

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181 (FX2): an admin's API key now answers to mfaRequired. This suite
  // drives admins through keys and is not about MFA, so it relaxes the dial
  // explicitly and hands the shared database back strict in afterAll (M-068).
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  // ADR-0188 S4: agents created here act under the strict `own_grants` default with grants of their own
  autoGrantCreatedAgentsForTest(app, db, { mirrorTools: true });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  await app.ready();

  const [prior] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  priorOrg = prior ? { ...prior } : null;
  // ADR-0181: content capture ships OFF. This file pins what a CAPTURED
  // preview looks like, so it opts in explicitly; afterAll restores the prior
  // value (the strict default on a fresh database).
  await db.update(orgSettings).set({ tracingCaptureContent: true }).where(eq(orgSettings.id, ORG_SETTINGS_ID));

  const ana = await makeUser("tr-ana@example.com");
  anaId = ana.id;
  anaAuth = ana.auth;
  const boris = await makeUser("tr-boris@example.com");
  borisId = boris.id;
  borisAuth = boris.auth;
  const admin = await makeUser("tr-admin@example.com", true);
  adminId = admin.id;
  adminAuth = admin.auth;

  upstream = await startUpstream();
  const srv = await app.inject({
    method: "POST",
    url: "/v1/servers",
    headers: AUTH,
    payload: { name: "tr-upstream", url: upstream.url },
  });
  expect(srv.statusCode, JSON.stringify(srv.json())).toBe(201);
  toolServerId = srv.json().id as string;

  mainAgentId = await makeAgent("tr-main", "tr-main-model", 2);
  hopAgentId = await makeAgent("tr-hop", "tr-hop-model", 1);
  secretAgentId = await makeAgent("tr-secret", "tr-secret-model", 1);

  await grant(anaId, mainAgentId);
  await grant(anaId, hopAgentId);
  const g = await app.inject({
    method: "POST",
    url: "/v1/grants/tools",
    headers: AUTH,
    payload: { userId: anaId, serverId: toolServerId, toolName: "get_time" },
  });
  expect(g.statusCode, JSON.stringify(g.json())).toBe(201);
  await grant(borisId, secretAgentId);
  await grant(adminId, mainAgentId);

  // --- the three seams ADR-0070 declared and did not write --------------
  const conn = await app.inject({
    method: "POST",
    url: "/v1/connectors",
    headers: AUTH,
    payload: { name: "tr-conn", kind: "data", providerKind: "mock", pricePerCallUsd: 0.002 },
  });
  expect(conn.statusCode, JSON.stringify(conn.json())).toBe(201);
  trConnectorId = conn.json().id as string;
  const cg = await app.inject({
    method: "POST",
    url: "/v1/grants/connectors",
    headers: AUTH,
    payload: { userId: anaId, connectorId: trConnectorId, mode: "readwrite" },
  });
  expect(cg.statusCode, JSON.stringify(cg.json())).toBe(201);
  // BORIS deliberately gets no grant — his invoke is the refusal case.

  const tpl = await app.inject({
    method: "POST",
    url: "/v1/workflows/templates",
    headers: AUTH,
    payload: {
      name: "tr-wf",
      definition: {
        workflow: "tr-wf",
        stages: [
          { id: "intake", type: "trigger" },
          { id: "gate", type: "human_approval", approvers: [anaId] },
        ],
      },
    },
  });
  expect(tpl.statusCode, JSON.stringify(tpl.json())).toBe(201);
  trTemplateId = tpl.json().id as string;
  const rule = await app.inject({
    method: "POST",
    url: "/v1/workflows/assignment-rules",
    headers: AUTH,
    payload: { templateId: trTemplateId, changeType: "tr-change" },
  });
  expect(rule.statusCode, JSON.stringify(rule.json())).toBe(201);

  const ds = await app.inject({
    method: "POST",
    url: "/v1/evals/datasets",
    headers: AUTH,
    payload: { name: "tr-dataset", scorerKind: "contains", scorerConfig: { needles: ["tr"] } },
  });
  expect(ds.statusCode, JSON.stringify(ds.json())).toBe(201);
  trDatasetId = ds.json().id as string;
  for (const input of ["tr: case one", "tr: case two"]) {
    const c = await app.inject({
      method: "POST",
      url: `/v1/evals/datasets/${trDatasetId}/cases`,
      headers: AUTH,
      payload: { input, scorerKind: "contains", scorerConfig: { needles: ["tr"] } },
    });
    expect(c.statusCode, JSON.stringify(c.json())).toBe(201);
  }
}, 180_000);

afterAll(async () => {
  await restoreAdminKeyMfa?.();
  await restoreStrictAdmission?.();
  // Restore the org singleton EXACTLY — every other suite reads it.
  if (priorOrg) {
    await db
      .update(orgSettings)
      .set({
        tracingEnabled: priorOrg["tracingEnabled"] as boolean,
        tracingCaptureContent: priorOrg["tracingCaptureContent"] as boolean,
        tracingPreviewMaxChars: priorOrg["tracingPreviewMaxChars"] as number,
        tracingOtlpEndpoint: (priorOrg["tracingOtlpEndpoint"] ?? null) as string | null,
      })
      .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  }
  if (createdUserIds.length) {
    await db.delete(traces).where(inArray(traces.userId, createdUserIds));
  }
  // ADR-0188 S4: an agent that acted, and the person it acted for, are named by its workload identity and
  // delegation grants, which are never deleted (decisions 2, 4); those rows stay (they are disabled-equivalent
  // history), everything else this file made is removed
  const keepAgents = await agentsWithIdentity(db, createdAgentIds);
  const keepUsers = await sponsorsWithGrants(db, createdUserIds);
  const agentsToDelete = createdAgentIds.filter((id) => !keepAgents.has(id));
  const usersToDelete = createdUserIds.filter((id) => !keepUsers.has(id));
  if (agentsToDelete.length) await db.delete(agents).where(inArray(agents.id, agentsToDelete));
  if (usersToDelete.length) await db.delete(users).where(inArray(users.id, usersToDelete));
  if (toolServerId) await db.delete(mcpServers).where(eq(mcpServers.id, toolServerId));
  // the 2026-08-15 fixtures. Users cascade their grants, instances and runs;
  // these three own no user FK and would otherwise linger for other suites.
  if (trDatasetId) {
    // eval_runs holds a RESTRICT fk on (dataset_id, version); the run this
    // file made must go first or the dataset delete is refused.
    await db.delete(evalRuns).where(eq(evalRuns.datasetId, trDatasetId));
    await db.delete(evalDatasets).where(eq(evalDatasets.id, trDatasetId));
  }
  if (trTemplateId) await db.delete(workflowTemplates).where(eq(workflowTemplates.id, trTemplateId));
  if (trConnectorId) await db.delete(connectors).where(eq(connectors.id, trConnectorId));
  app.server.closeAllConnections();
  await restoreSb2Gates();
  await app.close();
  if (upstream) await upstream.close();
});

// ---------------------------------------------------------------------------

describe("a governed dispatch is one span that REFERENCES its ledger row", () => {
  it("writes one llm span whose cost and tokens EQUAL the usage_events row it names", async () => {
    const r = await invoke(anaAuth, mainAgentId, "tr: reconcile my cost against the ledger");
    expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
    const body = r.json();
    expect(body.dispatch.costUsd).toBeGreaterThan(0);

    const [t] = await db
      .select()
      .from(traces)
      .where(and(eq(traces.userId, anaId), eq(traces.kind, "dispatch")))
      .orderBy(traces.startedAt);
    expect(t).toBeTruthy();

    const spans = await spansOf(t!.id);
    const llm = spans.filter((s) => s.kind === "llm");
    expect(llm).toHaveLength(1);
    const span = llm[0]!;
    expect(span.status).toBe("ok");
    expect(span.usageEventId).toBeTruthy();

    // THE RECONCILIATION. Join the span back to the ledger row it names and
    // require every copied figure to still agree. A recomputed price fails.
    const [ledger] = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.id, span.usageEventId!));
    expect(ledger, "the span references a usage_events row that does not exist").toBeTruthy();
    expect(span.costUsd).toBe(ledger!.costUsd);
    expect(span.inputTokens).toBe(ledger!.inputTokens);
    expect(span.outputTokens).toBe(ledger!.outputTokens);
    expect(span.model).toBe(ledger!.model);
    expect(span.provider).toBe(ledger!.provider);
    // and the figure the CALLER was told is the same figure again
    expect(span.costUsd).toBe(body.dispatch.costUsd);

    // The trace's own rollup is the sum of its spans, not an independent number.
    const [reloaded] = await db.select().from(traces).where(eq(traces.id, t!.id));
    expect(reloaded!.inputTokens).toBe(span.inputTokens);
    expect(reloaded!.outputTokens).toBe(span.outputTokens);
    expect(reloaded!.costUsd).toBeCloseTo(span.costUsd!, 9);
    expect(reloaded!.spanCount).toBe(spans.length);
    expect(reloaded!.status).toBe("ok");
  });

  it("stores the output preview the CALLER was given, not a second copy of the raw text", async () => {
    const r = await invoke(anaAuth, mainAgentId, "tr: preview parity");
    expect(r.statusCode).toBe(200);
    const traceId = r.json().dispatch.trace?.traceId as string | undefined;
    expect(traceId, "a successful dispatch must hand back its trace coordinates").toBeTruthy();
    const spans = await spansOf(traceId!);
    const llm = spans.find((s) => s.kind === "llm")!;
    expect(llm.outputPreview).toBe(r.json().dispatch.outputText);
    expect(llm.contentWithheld).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("a governance DENY is a PRESENT span with its reason", () => {
  it("records a denied policy span for an entitlement refusal, referencing the audit row", async () => {
    // BORIS is not granted tr-main. Nothing dispatches; nothing is billed.
    const r = await invoke(borisAuth, mainAgentId, "tr: I should not be allowed here");
    expect(r.statusCode).toBe(403);

    const rows = await db
      .select()
      .from(traces)
      .where(and(eq(traces.userId, borisId), eq(traces.status, "denied")));
    expect(rows.length, "a refusal produced NO trace — the absence IS the bug").toBeGreaterThan(0);
    const t = rows[rows.length - 1]!;
    expect(t.deniedSpanCount).toBeGreaterThan(0);

    const spans = await spansOf(t.id);
    const policy = spans.find((s) => s.kind === "policy");
    expect(policy, "no policy span for a pillar-1 denial").toBeTruthy();
    expect(policy!.status).toBe("denied");
    expect(policy!.statusReason, "a deny span with no reason explains nothing").toBeTruthy();
    expect(policy!.agentId).toBe(mainAgentId);

    // IT REFERENCES THE DECISION, rather than restating it.
    expect(policy!.auditLogId).toBeTruthy();
    const [audited] = await db.select().from(auditLog).where(eq(auditLog.id, policy!.auditLogId!));
    expect(audited).toBeTruthy();
    expect(audited!.effect).toBe("deny");
    expect(policy!.statusReason).toBe(audited!.reason);

    // AND NOTHING WAS BILLED. A refusal that produced a ledger row is a
    // refusal that did not happen.
    const billed = await db
      .select()
      .from(usageEvents)
      .where(and(eq(usageEvents.userId, borisId), eq(usageEvents.agentId, mainAgentId)));
    expect(billed).toHaveLength(0);
  });

  it("records a denied span for a refusal decided INSIDE the dispatch core", async () => {
    // An agent with a model but an unknown provider is `agent_not_dispatchable`
    // — a config refusal decided in the core, not at the entry point.
    const [broken] = await db
      .insert(agents)
      .values({
        name: "tr-broken",
        provider: "mock",
        model: "tr-broken-model",
        tier: 1,
        enabled: true,
      })
      .returning();
    createdAgentIds.push(broken!.id);
    await grant(anaId, broken!.id);
    // strip the model so the core's own dispatchability guard fires
    await db.update(agents).set({ model: null }).where(eq(agents.id, broken!.id));

    const r = await invoke(anaAuth, broken!.id, "tr: config refusal");
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("agent_not_dispatchable");

    const traceId = r.json().trace?.traceId ?? r.json().dispatch?.trace?.traceId;
    const candidates = traceId
      ? await spansOf(traceId as string)
      : (
          await db
            .select()
            .from(traceSpans)
            .where(eq(traceSpans.agentId, broken!.id))
        ).slice();
    const denied = candidates.find((s) => s.status === "denied");
    expect(denied, "a core-side config refusal produced no denied span").toBeTruthy();
    expect(denied!.statusReason).toContain("needs a model id");
  });
});

// ---------------------------------------------------------------------------

describe("a fallback hop is VISIBLE, nested under the attempt that failed", () => {
  it("records the served hop as a fallback_hop span whose parent is the failed primary span", async () => {
    const set = await app.inject({
      method: "PUT",
      url: `/v1/agents/${mainAgentId}/fallbacks`,
      headers: AUTH,
      payload: { fallbackAgentIds: [hopAgentId] },
    });
    expect(set.statusCode, JSON.stringify(set.json())).toBe(200);

    // Only tr-main-model fails; the hop's model answers the SAME prompt.
    const r = await invoke(
      anaAuth,
      mainAgentId,
      "tr: fallback please <<upstream-error:tr-main-model>>",
      { routingMode: "passthrough" },
    );
    expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
    const dispatch = r.json().dispatch;
    expect(dispatch.fallback, "ADR-0066 must have disclosed the hop").toBeTruthy();
    expect(dispatch.fallback.servedAgentId).toBe(hopAgentId);

    const traceId = dispatch.trace.traceId as string;
    const spans = await spansOf(traceId);
    const primary = spans.find((s) => s.kind === "llm" && s.status === "error");
    expect(primary, "the failed primary attempt must itself be a span").toBeTruthy();
    const hop = spans.find((s) => s.kind === "fallback_hop");
    expect(hop, "the hop that actually answered is invisible — this is the silent fallback").toBeTruthy();
    expect(hop!.status).toBe("ok");
    expect(hop!.agentId).toBe(hopAgentId);
    // NESTED, not a sibling. This is the assertion a flat recorder fails.
    expect(hop!.parentSpanId).toBe(primary!.id);

    const tree = buildSpanTree(spans.map(toRecord));
    const flat = flattenSpanTree(tree);
    const hopNode = flat.find((n) => n.id === hop!.id)!;
    const primaryNode = flat.find((n) => n.id === primary!.id)!;
    expect(hopNode.depth).toBe(primaryNode.depth + 1);

    await app.inject({
      method: "PUT",
      url: `/v1/agents/${mainAgentId}/fallbacks`,
      headers: AUTH,
      payload: { fallbackAgentIds: [] },
    });
  });
});

// ---------------------------------------------------------------------------

describe("an orchestration run produces a real TREE, not a flat list relabelled", () => {
  it("nests run -> run_node -> model turn -> tool call, each child naming its true parent", async () => {
    const run = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: anaAuth,
      payload: {
        graph: {
          run: "tr-shape",
          escalationApproverUserId: adminId,
          nodes: [
            {
              id: "solo",
              title: "tr solo node",
              mode: "execute",
              ownerAgentId: mainAgentId,
              dependsOn: [],
              // a REAL tool call, through the real governed tool path against a
              // real local MCP upstream — so the fourth level of the tree is
              // an actual event and not a simulated one
              toolServers: [toolServerId],
              estimate: { in: 1, out: 1 },
              instruction: "check the clock: please <<use-tool:get_time>> and report it",
            },
          ],
        },
      },
    });
    expect(run.statusCode, JSON.stringify(run.json())).toBe(201);
    const runId = run.json().id as string;

    const auto = await app.inject({
      method: "POST",
      url: `/v1/runs/${runId}/auto`,
      headers: anaAuth,
      payload: { acceptReviews: true },
    });
    expect(auto.statusCode, JSON.stringify(auto.json())).toBe(200);

    const [t] = await db
      .select()
      .from(traces)
      .where(and(eq(traces.kind, "run"), eq(traces.rootRefId, runId)));
    expect(t, "an orchestration run produced no trace").toBeTruthy();
    const spans = await spansOf(t!.id);

    const runSpan = spans.find((s) => s.kind === "run");
    const nodeSpan = spans.find((s) => s.kind === "run_node");
    const turnSpan = spans.find((s) => s.kind === "llm");
    expect(runSpan, "no run span").toBeTruthy();
    expect(nodeSpan, "no run_node span").toBeTruthy();
    expect(turnSpan, "no model-turn span").toBeTruthy();

    // THE SHAPE. Each of these is a real parent link in the database, not a
    // rendering convention.
    expect(runSpan!.parentSpanId).toBeNull();
    expect(nodeSpan!.parentSpanId).toBe(runSpan!.id);
    expect(turnSpan!.parentSpanId).toBe(nodeSpan!.id);
    expect(nodeSpan!.runId).toBe(runId);
    expect(nodeSpan!.nodeId).toBe("solo");

    const tree = buildSpanTree(spans.map(toRecord));
    expect(tree, "more than one root means the tree fell apart").toHaveLength(1);
    const flat = flattenSpanTree(tree);
    expect(flat.find((n) => n.id === runSpan!.id)!.depth).toBe(0);
    expect(flat.find((n) => n.id === nodeSpan!.id)!.depth).toBe(1);
    expect(flat.find((n) => n.id === turnSpan!.id)!.depth).toBe(2);
    // THE FOURTH LEVEL: the tool the model asked for, hanging from the TURN
    // that asked for it — not from the node, and not from the run.
    const toolSpan = spans.find((s) => s.kind === "tool");
    expect(toolSpan, "the worker's governed tool call is not in the tree").toBeTruthy();
    expect(toolSpan!.name).toBe("get_time");
    expect(toolSpan!.status).toBe("ok");
    expect(toolSpan!.parentSpanId, "a tool call must name the model turn that asked for it").toBe(
      turnSpan!.id,
    );
    expect(toolSpan!.mcpServerId).toBe(toolServerId);
    expect(flat.find((n) => n.id === toolSpan!.id)!.depth).toBe(3);

    // NOT a flat list: a relabelled flat list has maxDepth 0.
    expect(Math.max(...flat.map((n) => n.depth))).toBeGreaterThanOrEqual(3);

    // The session grouping: a run's trace is grouped by the run.
    expect(t!.sessionId).toBe(runId);

    // Sibling order is the stored seq, never the timestamp.
    const seqs = spans.map((s) => s.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

  });
});

// ---------------------------------------------------------------------------

describe("reading a trace is default-deny", () => {
  it("refuses another user's trace with a stated reason", async () => {
    const r = await invoke(anaAuth, mainAgentId, "tr: ana's private prompt");
    expect(r.statusCode).toBe(200);
    const traceId = r.json().dispatch.trace.traceId as string;

    const mine = await app.inject({ method: "GET", url: `/v1/traces/${traceId}`, headers: anaAuth });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().trace.id).toBe(traceId);

    const theirs = await app.inject({
      method: "GET",
      url: `/v1/traces/${traceId}`,
      headers: borisAuth,
    });
    expect(theirs.statusCode, "another user could read a colleague's prompts").toBe(403);
    expect(theirs.json().detail).toContain("your own traces");

    // the admin CAN, and the refusal was audited
    const asAdmin = await app.inject({
      method: "GET",
      url: `/v1/traces/${traceId}`,
      headers: adminAuth,
    });
    expect(asAdmin.statusCode).toBe(200);
    const refusals = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, borisId), eq(auditLog.ruleId, "trace-read")));
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals[0]!.effect).toBe("deny");
  });

  it("refuses — rather than silently narrowing — a non-admin listing somebody else's traces", async () => {
    const r = await app.inject({
      method: "GET",
      url: `/v1/traces?userId=${anaId}`,
      headers: borisAuth,
    });
    expect(r.statusCode, "a silently-narrowed result set looks enforced and is not").toBe(403);
  });

  it("forces a non-admin's own list and returns a deterministic order", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/traces", headers: anaAuth });
    expect(r.statusCode).toBe(200);
    const list = r.json().traces as Array<{ userId: string; startedAt: string; id: string }>;
    expect(list.length).toBeGreaterThan(0);
    expect(r.json().scope).toBe("self");
    // scoping is FORCED, not defaulted
    expect(list.every((t) => t.userId === anaId)).toBe(true);
    // ORDER IS EXPLICIT: startedAt DESC, id DESC. Asserted so a missing
    // ORDER BY cannot pass here the way one passed for months elsewhere.
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!;
      const cur = list[i]!;
      const cmp = prev.startedAt === cur.startedAt ? (prev.id > cur.id ? -1 : 1) : prev.startedAt > cur.startedAt ? -1 : 1;
      expect(cmp, `row ${i} is out of order`).toBe(-1);
    }
  });

  it("groups traces into sessions, self-scoped the same way", async () => {
    const c = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      headers: anaAuth,
      payload: { agentId: mainAgentId, title: "tr-thread" },
    });
    expect(c.statusCode).toBe(201);
    const conversationId = c.json().id as string;
    for (const turn of ["tr: first turn", "tr: second turn"]) {
      const t = await invoke(anaAuth, mainAgentId, turn, { conversationId });
      expect(t.statusCode).toBe(200);
    }
    const s = await app.inject({ method: "GET", url: "/v1/sessions", headers: anaAuth });
    expect(s.statusCode).toBe(200);
    const sessions = s.json().sessions as Array<{ sessionId: string; traceCount: number }>;
    const thread = sessions.find((x) => x.sessionId === conversationId);
    expect(thread, "two turns of one conversation did not group into one session").toBeTruthy();
    expect(thread!.traceCount).toBeGreaterThanOrEqual(2);

    const denied = await app.inject({
      method: "GET",
      url: `/v1/sessions?userId=${anaId}`,
      headers: borisAuth,
    });
    expect(denied.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------

describe("the exporter refuses honestly and never dials by default", () => {
  it("answers 409 with a stated reason when no endpoint is configured", async () => {
    await db
      .update(orgSettings)
      .set({ tracingOtlpEndpoint: null })
      .where(eq(orgSettings.id, ORG_SETTINGS_ID));
    const r = await app.inject({ method: "POST", url: "/v1/tracing/export", headers: adminAuth, payload: {} });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("otlp_not_configured");
    expect(r.json().detail).toContain("air-gapped");
  });

  it("reports the shipped posture as unconfigured, with its limits stated", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/tracing/config", headers: adminAuth });
    expect(r.statusCode).toBe(200);
    expect(r.json().otlp.configured).toBe(false);
    expect(r.json().otlp.endpoint).toBeNull();
    expect(r.json().limits).toContain("PULL");
    expect(r.json().retention).toContain("compliance-cascade");
  });

  it("refuses to save an OTLP endpoint the egress guard has not approved", async () => {
    const r = await app.inject({
      method: "PUT",
      url: "/v1/org/settings",
      headers: AUTH,
      payload: { tracingOtlpEndpoint: "https://collector.not-allow-listed.example/v1/traces" },
    });
    expect(r.statusCode, "an unapproved outbound destination was accepted").toBe(400);
    expect(r.json().error).toBe("egress_blocked");
    const [after] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    expect(after!.tracingOtlpEndpoint, "nothing should have been saved").toBeNull();
  });

  it("is a non-admin-forbidden surface", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/tracing/config", headers: anaAuth });
    expect(r.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------

describe("the OTLP encoding is a real one", () => {
  it("emits gen_ai.* semantic-convention attributes and a hex trace id that IS our uuid", async () => {
    const r = await invoke(anaAuth, mainAgentId, "tr: otel shape");
    expect(r.statusCode).toBe(200);
    const traceId = r.json().dispatch.trace.traceId as string;
    const spans = await spansOf(traceId);
    const [t] = await db.select().from(traces).where(eq(traces.id, traceId));

    const payload = buildOtlpPayload({
      serviceName: "tr-service",
      includeContent: true,
      traces: [
        {
          trace: {
            ...t!,
            startedAt: t!.startedAt.toISOString(),
            endedAt: t!.endedAt?.toISOString() ?? null,
          },
          spans: spans.map(toRecord),
        },
      ],
    });
    const rs = payload.body["resourceSpans"] as Array<Record<string, unknown>>;
    const scope = (rs[0]!["scopeSpans"] as Array<Record<string, unknown>>)[0]!;
    const emitted = scope["spans"] as Array<Record<string, unknown>>;
    expect(emitted.length).toBe(spans.length);
    const llm = emitted.find((s) => (s["name"] as string) === "tr-main")!;
    expect(llm["traceId"]).toBe(otlpTraceId(traceId));
    expect((llm["traceId"] as string)).toHaveLength(32);
    expect((llm["spanId"] as string)).toHaveLength(16);
    const attrs = Object.fromEntries(
      (llm["attributes"] as Array<{ key: string; value: Record<string, unknown> }>).map((a) => [
        a.key,
        Object.values(a.value)[0],
      ]),
    );
    expect(attrs["gen_ai.system"]).toBe("mock");
    expect(attrs["gen_ai.request.model"]).toBe("tr-main-model");
    expect(attrs["gen_ai.operation.name"]).toBe("chat");
    expect(Number(attrs["gen_ai.usage.input_tokens"])).toBeGreaterThan(0);
    // the lossy span-id mapping is DISCLOSED by carrying the full uuid
    expect(attrs["regulait.span.id"]).toBe(spans.find((s) => s.kind === "llm")!.id);
    expect(otlpSpanId(attrs["regulait.span.id"] as string)).toBe(llm["spanId"]);
    // no standard gen_ai cost key exists, so ours is namespaced as ours
    expect(attrs["regulait.cost.usd"]).toBeDefined();
    expect(attrs["gen_ai.cost.usd"]).toBeUndefined();
  });

  /**
   * REWRITTEN, NOT DELETED, by ADR-0070's 2026-08-15 amendment. This test was
   * "exports a DENY as OTel ERROR carrying its reason and regulait.decision"
   * and it pinned the behaviour ADR-0070 itself disclosed as a fidelity loss:
   * "in someone else's Grafana a governance refusal will look like a failure."
   * That is the ADR-0057/0072 inversion — defences working scored the same as
   * defences failing — and the amendment corrects it. Asserted here on a REAL
   * refusal produced by the real kernel, not on a hand-built span.
   */
  it("does NOT export a real governance DENY as an OTel error, and keeps it queryable", async () => {
    const rows = await db
      .select()
      .from(traces)
      .where(and(eq(traces.userId, borisId), eq(traces.status, "denied")));
    expect(rows.length).toBeGreaterThan(0);
    const t = rows[0]!;
    const spans = await spansOf(t.id);
    const payload = buildOtlpPayload({
      serviceName: "tr-service",
      includeContent: false,
      traces: [
        {
          trace: { ...t, startedAt: t.startedAt.toISOString(), endedAt: t.endedAt?.toISOString() ?? null },
          spans: spans.map(toRecord),
        },
      ],
    });
    const rs = payload.body["resourceSpans"] as Array<Record<string, unknown>>;
    const emitted = ((rs[0]!["scopeSpans"] as Array<Record<string, unknown>>)[0]!["spans"]) as Array<
      Record<string, unknown>
    >;
    const denied = emitted[0]!;
    // OTel StatusCode 0 = Unset. The spec defines Error as "the operation
    // contains an error"; a refusal contains none — it IS the product working.
    expect((denied["status"] as Record<string, unknown>)["code"]).toBe(0);
    // and the spec says a Description is ignored on a non-Error status, so the
    // reason must NOT be hidden there.
    expect((denied["status"] as Record<string, unknown>)["message"]).toBeUndefined();
    const attrs = Object.fromEntries(
      (denied["attributes"] as Array<{ key: string; value: Record<string, unknown> }>).map((a) => [
        a.key,
        Object.values(a.value)[0],
      ]),
    );
    // THE TRACE IS STILL DIAGNOSTIC. The reason and the rule that refused ride
    // attributes, and the deny/failure split is ONE filter clause.
    expect(attrs["regulait.outcome"]).toBe("denied");
    expect(attrs["regulait.decision"]).toBe("denied");
    expect(attrs["regulait.reason"]).toBe(spans[0]!.statusReason);
    expect(attrs["regulait.rule.id"], "a refusal that names no rule is unactionable").toBeTruthy();
    // and it is invisible to a standard error dashboard, which is the point
    expect(attrs["error.type"]).toBeUndefined();
    // includeContent:false means no prompt leaves the deployment
    expect(attrs["gen_ai.input.messages"]).toBeUndefined();
  });

  it("CONTROL: a genuine transport FAILURE still exports as OTel ERROR with error.type", async () => {
    // The other half of the boundary, on a real span the dispatch core wrote.
    // Without this, the fix above could have been "map everything to Unset",
    // which would buy honesty about refusals by hiding real outages.
    const errored = await db
      .select()
      .from(traceSpans)
      .where(eq(traceSpans.status, "error"))
      .limit(1);
    expect(errored.length, "no error span exists to control against").toBeGreaterThan(0);
    const [tr] = await db.select().from(traces).where(eq(traces.id, errored[0]!.traceId));
    const payload = buildOtlpPayload({
      serviceName: "tr-service",
      includeContent: false,
      traces: [
        {
          trace: {
            ...tr!,
            startedAt: tr!.startedAt.toISOString(),
            endedAt: tr!.endedAt?.toISOString() ?? null,
          },
          spans: [toRecord(errored[0]!)],
        },
      ],
    });
    const rs = payload.body["resourceSpans"] as Array<Record<string, unknown>>;
    const emitted = ((rs[0]!["scopeSpans"] as Array<Record<string, unknown>>)[0]!["spans"]) as Array<
      Record<string, unknown>
    >;
    const failed = emitted[0]!;
    expect((failed["status"] as Record<string, unknown>)["code"]).toBe(2);
    const attrs = Object.fromEntries(
      (failed["attributes"] as Array<{ key: string; value: Record<string, unknown> }>).map((a) => [
        a.key,
        Object.values(a.value)[0],
      ]),
    );
    expect(attrs["regulait.outcome"]).toBe("error");
    expect(attrs["error.type"]).toBeTruthy();
    expect(attrs["regulait.decision"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("the master switch is a real switch", () => {
  it("writes no trace or span at all when tracing is disabled, and the dispatch is unchanged", async () => {
    await db
      .update(orgSettings)
      .set({ tracingEnabled: false })
      .where(eq(orgSettings.id, ORG_SETTINGS_ID));
    const before = await db.select().from(traces).where(eq(traces.userId, adminId));
    const r = await invoke(adminAuth, mainAgentId, "tr: switched off");
    expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
    expect(r.json().dispatch.outputText).toBeTruthy();
    expect(r.json().dispatch.trace, "a disabled recorder still handed back coordinates").toBeUndefined();
    const after = await db.select().from(traces).where(eq(traces.userId, adminId));
    expect(after.length).toBe(before.length);
    await db
      .update(orgSettings)
      .set({ tracingEnabled: true })
      .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });

  it("keeps the tree and the deny reasons but stores no prompt when content capture is off", async () => {
    await db
      .update(orgSettings)
      .set({ tracingCaptureContent: false })
      .where(eq(orgSettings.id, ORG_SETTINGS_ID));
    const r = await invoke(anaAuth, mainAgentId, "tr: this prompt must not be stored anywhere");
    expect(r.statusCode).toBe(200);
    const traceId = r.json().dispatch.trace.traceId as string;
    const spans = await spansOf(traceId);
    const llm = spans.find((s) => s.kind === "llm")!;
    expect(llm.inputPreview).toBeNull();
    expect(llm.outputPreview).toBeNull();
    // but everything that is NOT content survives
    expect(llm.costUsd).toBeGreaterThan(0);
    expect(llm.inputTokens).toBeGreaterThan(0);
    expect(llm.status).toBe("ok");
    // and the prompt is nowhere in any span of this trace
    const dumped = JSON.stringify(spans);
    expect(dumped).not.toContain("this prompt must not be stored anywhere");
    await db
      .update(orgSettings)
      .set({ tracingCaptureContent: true })
      .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });
});

/** Row -> the shared package's structural SpanRecord. */
function toRecord(s: TraceSpanRow) {
  return {
    ...s,
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt ? s.endedAt.toISOString() : null,
    attributes: (s.attributes ?? null) as Record<string, unknown> | null,
  };
}

// ---------------------------------------------------------------------------
// ADR-0070 amendment (2026-08-15) — GAP A: A DECLARED SPAN KIND WITH NO WRITER.
//
// ADR-0070 shipped `connector`, `workflow_stage` and `eval_case` as declared
// kinds that nothing ever wrote, and — unnoticed by the ADR's own disclosure —
// `guardrail` as a fourth. A vocabulary that promises coverage the product does
// not have is the same class of dishonesty as a score that inverts.
//
// The three real seams now emit; `guardrail` was REMOVED rather than faked
// (see the comment on TRACE_SPAN_KINDS: an ADR-0042 verdict is a property of a
// call, not a call, and it already rides the span it acted on).
//
// The LAST test here is the one that keeps it true: it enumerates the declared
// vocabulary and requires every member to have been written by a path this file
// actually drove. Adding a kind to the list without a writer turns it red.
// ---------------------------------------------------------------------------

describe("every DECLARED span kind is written by a real path", () => {
  it("a governed CONNECTOR call writes a connector span that references its ledger row", async () => {
    const inv = await app.inject({
      method: "POST",
      url: `/v1/connectors/${trConnectorId}/invoke`,
      headers: anaAuth,
      payload: { operation: "read", object: "records", payload: { q: "tr-connector-ok" } },
    });
    expect(inv.statusCode, JSON.stringify(inv.json())).toBe(200);

    const [t] = await db
      .select()
      .from(traces)
      .where(and(eq(traces.userId, anaId), eq(traces.sessionId, `connector:${trConnectorId}`)))
      .orderBy(desc(traces.startedAt));
    expect(t, "a governed connector call produced no trace at all").toBeTruthy();
    const spans = await spansOf(t!.id);
    const conn = spans.find((s) => s.kind === "connector");
    expect(conn, "`connector` is declared and nothing wrote it").toBeTruthy();
    expect(conn!.status).toBe("ok");
    expect(conn!.connectorId).toBe(trConnectorId);
    // RULE 1 — it REFERENCES the ledger row and its figure agrees with it.
    expect(conn!.usageEventId, "the connector span invented its cost").toBeTruthy();
    const [ledger] = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.id, conn!.usageEventId!));
    expect(ledger).toBeTruthy();
    expect(conn!.costUsd).toBe(ledger!.costUsd);
  });

  it("a connector call the kernel REFUSES is a denied span with the kernel's reason — not an absent one", async () => {
    // BORIS holds no grant on this connector. Nothing executes and nothing is
    // billed, which is exactly the case a trace of only the successes loses.
    const inv = await app.inject({
      method: "POST",
      url: `/v1/connectors/${trConnectorId}/invoke`,
      headers: borisAuth,
      payload: { operation: "read", object: "records", payload: { q: "tr-connector-denied" } },
    });
    expect(inv.statusCode).toBe(403);

    const [t] = await db
      .select()
      .from(traces)
      .where(and(eq(traces.userId, borisId), eq(traces.sessionId, `connector:${trConnectorId}`)))
      .orderBy(desc(traces.startedAt));
    expect(t, "a refused connector call produced NO trace — the absence IS the bug").toBeTruthy();
    const spans = await spansOf(t!.id);
    const conn = spans.find((s) => s.kind === "connector")!;
    expect(conn.status).toBe("denied");
    expect(conn.statusReason, "a deny span with no reason explains nothing").toBeTruthy();
    expect(conn.statusReason).toBe(inv.json().decision.reason);
    // the rule that refused, so the export can carry `regulait.rule.id`
    expect((conn.attributes as Record<string, unknown>)["ruleId"]).toBe(inv.json().decision.ruleId);
    // NOTHING WAS BILLED, so the span names no ledger row rather than a zero.
    expect(conn.usageEventId).toBeNull();
    expect(t!.deniedSpanCount).toBeGreaterThan(0);
  });

  it("a workflow transition writes a workflow_stage span, and an ABORT is DENIED rather than error", async () => {
    const started = await app.inject({
      method: "POST",
      url: "/v1/workflows/instances",
      headers: anaAuth,
      payload: {
        change: { description: "tr wf", paths: ["src/"], changeType: "tr-change", environment: "dev" },
      },
    });
    expect(started.statusCode, JSON.stringify(started.json())).toBe(201);
    const instanceId = started.json().id as string;

    const aborted = await app.inject({
      method: "POST",
      url: `/v1/workflows/instances/${instanceId}/abort`,
      headers: anaAuth,
      payload: {},
    });
    expect(aborted.statusCode, JSON.stringify(aborted.json())).toBe(200);

    const [t] = await db
      .select()
      .from(traces)
      .where(and(eq(traces.kind, "workflow"), eq(traces.rootRefId, instanceId)));
    expect(t, "`workflow_stage` is declared and no transition wrote one").toBeTruthy();
    const spans = await spansOf(t!.id);
    const stages = spans.filter((s) => s.kind === "workflow_stage");
    // ONE TREE PER INSTANCE, not one trace per event: the start and the abort
    // are siblings of the same tree, in seq order.
    expect(stages.length, "each transition should be a span of ONE instance tree").toBeGreaterThan(1);
    expect(stages.map((s) => (s.attributes as Record<string, unknown>)["event"])).toContain("abort");
    const abortSpan = stages.find(
      (s) => (s.attributes as Record<string, unknown>)["event"] === "abort",
    )!;
    // THE POLARITY. An abort is a DECISION — the workflow engine doing its job.
    // Recording it as `error` is the ADR-0057/0072 inversion a third time.
    expect(abortSpan.status).toBe("denied");
    expect(abortSpan.status).not.toBe("error");
    expect(abortSpan.statusReason).toBeTruthy();
    // and the start transition, which refused nothing, is not denied
    const startSpan = stages.find(
      (s) => (s.attributes as Record<string, unknown>)["event"] === "start",
    );
    expect(startSpan, "the instance's own start transition was not traced").toBeTruthy();
    expect(startSpan!.status).toBe("ok");
  });

  it("an eval run is ONE tree whose eval_case spans PARENT the dispatches they made", async () => {
    const run = await app.inject({
      method: "POST",
      url: "/v1/evals/runs",
      headers: anaAuth,
      payload: { datasetId: trDatasetId, agentId: mainAgentId },
    });
    expect(run.statusCode, JSON.stringify(run.json())).toBe(201);
    const runId = run.json().run.id as string;

    const [t] = await db
      .select()
      .from(traces)
      .where(and(eq(traces.kind, "eval"), eq(traces.rootRefId, runId)));
    expect(t, "`eval_case` is declared and an eval run wrote no tree").toBeTruthy();
    const spans = await spansOf(t!.id);
    const cases = spans.filter((s) => s.kind === "eval_case");
    expect(cases.length).toBe(2);
    expect(cases.every((c) => c.status === "ok")).toBe(true);

    // THE GROUPING IS THE POINT. Before this, an eval's dispatches produced
    // `llm` spans scattered across N unrelated one-span traces. Each dispatch
    // must now name its CASE as its parent — asserted by parent id, never by
    // "they are in the same trace".
    const llms = spans.filter((s) => s.kind === "llm");
    expect(llms.length).toBe(2);
    for (const llm of llms) {
      expect(cases.map((c) => c.id)).toContain(llm.parentSpanId);
    }
    // and the case span is a real container, not a zero-duration marker
    expect(cases.some((c) => (c.durationMs ?? 0) >= 0)).toBe(true);
    expect(t!.spanCount).toBe(spans.length);
  });

  it("THE ENUMERATION: no DECLARED span kind is left with nothing writing it", async () => {
    // Restricted to the traces THIS FILE produced, so a sibling suite running
    // against the same database can never lend this test a kind it did not
    // itself drive.
    const mine = await db
      .select({ kind: traceSpans.kind })
      .from(traceSpans)
      .innerJoin(traces, eq(traces.id, traceSpans.traceId))
      .where(inArray(traces.userId, createdUserIds));
    const written = new Set<string>(mine.map((r) => r.kind as string));

    for (const kind of TRACE_SPAN_KINDS) {
      expect(
        written.has(kind),
        `span kind '${kind}' is DECLARED in TRACE_SPAN_KINDS and no real path writes it — ` +
          "either give it a writer or remove it from the vocabulary",
      ).toBe(true);
    }
    // and the converse, so a writer can never emit a kind the vocabulary and
    // the UI's label map have never heard of
    for (const kind of written) {
      expect(TRACE_SPAN_KINDS as readonly string[]).toContain(kind);
    }
    // `guardrail` was REMOVED, not given a writer. If somebody re-adds it to
    // the list, the loop above turns red until something emits it.
    const declared = TRACE_SPAN_KINDS.map((k) => k as string);
    expect(declared).not.toContain("guardrail");
    expect(written.has("guardrail")).toBe(false);
  });
});
