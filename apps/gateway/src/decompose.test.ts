import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { autoGrantCreatedAgentsForTest } from "./testing/agent-own-grants.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditLog, createDb, eq, runMigrations, usageEvents, type Db } from "@regulait/db";
import { resolveModelProvider, type MockModelProvider } from "@regulait/model-provider";
import { buildApp } from "./app.js";
import { installLicenseFixture, removeLicenseFixture } from "./testing/license-fixture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

/**
 * PILLAR 7 agent-driven task decomposition end to end: POST /v1/runs/decompose
 * has a LEAD agent draft a proposal (governed, metered, project-attributed,
 * audit-marked purpose:"decompose") that the human then submits through the
 * normal POST /v1/runs — plus the failure surfaces: ungranted suggestions
 * substituted and recorded, unparseable output retried ONCE then 422 with the
 * raw output, lead entitlement denials in the normal 403 decision shape, and
 * the project budget gate applying to the lead dispatch like any other.
 *
 * Shares one database with the other gateway suites (fileParallelism is off);
 * everything here is prefixed dcmp- and ledger asserts filter by user id.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "dcmp-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);

const GOAL = "Add rate-limit headers to the public API and document them";

let db: Db;
let app: ReturnType<typeof buildApp>;
let mock: MockModelProvider;
let deeId: string;
let deeAuth: { authorization: string };
let rvkId: string;
let rvkAuth: { authorization: string };
let fastId: string;
let balancedId: string;
let premiumId: string;
let projectId: string;

async function makeUser(email: string, displayName: string) {
  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName },
  });
  expect(user.statusCode).toBe(201);
  const key = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${user.json().id}/keys`,
    payload: { name: "test" },
  });
  expect(key.statusCode).toBe(201);
  return { id: user.json().id as string, auth: { authorization: `Bearer ${key.json().token}` } };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  // ADR-0188 S4: agents created here act under the strict `own_grants` default with grants of their own
  autoGrantCreatedAgentsForTest(app, db, { mirrorTools: true });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  // ADR-0052 §4: POST /v1/runs/decompose is tier-gated on
  // `advanced_orchestration` (the flag the ADR names "advanced orchestration
  // fan-out") and now ENFORCED at the route, so this suite runs under a real
  // signed license granting it. This suite's 200s ARE the licensed-succeeds
  // proof for the whole decompose surface. Removed in afterAll — the
  // deployment ends UNLICENSED exactly as it started.
  await installLicenseFixture(app, { features: ["advanced_orchestration"], auth: AUTH });
  mock = resolveModelProvider({ provider: "mock" }) as MockModelProvider;

  const dee = await makeUser("dcmp-dee@example.com", "Dcmp Dee");
  deeId = dee.id;
  deeAuth = dee.auth;
  const rvk = await makeUser("dcmp-rvk@example.com", "Dcmp Revoked");
  rvkId = rvk.id;
  rvkAuth = rvk.auth;

  const specs = [
    { name: "dcmp-fast-mock", tier: 0, costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-fast" },
    { name: "dcmp-balanced-mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
    { name: "dcmp-premium-mock", tier: 2, costPerMTokIn: 15, costPerMTokOut: 75, model: "mock-premium" },
  ];
  const ids: string[] = [];
  for (const spec of specs) {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/agents",
      payload: { ...spec, provider: "mock" },
    });
    expect(res.statusCode).toBe(201);
    ids.push(res.json().id);
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/agents",
      payload: { userId: deeId, agentId: res.json().id },
    });
  }
  [fastId, balancedId, premiumId] = ids as [string, string, string];
  // dee's default agent = the balanced mock — the lead fallback AND the
  // substitution fallback both point here
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${deeId}/agent-policy`,
    payload: { defaultAgentId: balancedId },
  });

  const project = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/projects",
    payload: { name: "dcmp-project" },
  });
  expect(project.statusCode).toBe(201);
  projectId = project.json().id;
});

afterAll(async () => {
  // `licenses` is an org singleton — leave the deployment UNLICENSED
  await removeLicenseFixture(db);
  await restoreSb2Gates();
});

describe("POST /v1/runs/decompose — happy path", () => {
  it("drafts a 4-node proposal through a governed lead dispatch and never creates a run", async () => {
    const before = (
      await app.inject({ method: "GET", headers: deeAuth, url: "/v1/runs" })
    ).json().runs.length;
    const res = await app.inject({
      method: "POST",
      headers: deeAuth,
      url: "/v1/runs/decompose",
      payload: { goal: GOAL, projectId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.retried).toBe(false);

    // lead = dee's default agent (no explicit pick)
    expect(body.dispatch.servedAgentId).toBe(balancedId);
    expect(body.dispatch.modelUsed).toBe("mock-balanced");
    expect(body.dispatch.costUsd).toBeGreaterThan(0);
    expect(body.dispatch.tokens.inputTokens).toBeGreaterThan(0);
    expect(body.dispatch.tokens.outputTokens).toBeGreaterThan(0);

    // the mock lead's deterministic shape: analyze → two parallel middles → integrate
    const nodes = body.proposal.nodes;
    expect(nodes).toHaveLength(4);
    expect(nodes[0].dependsOn).toEqual([]);
    expect(nodes[1].dependsOn).toEqual([nodes[0].id]);
    expect(nodes[2].dependsOn).toEqual([nodes[0].id]);
    expect(nodes[3].dependsOn).toEqual([nodes[1].id, nodes[2].id]);
    for (const n of nodes) {
      expect(n.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect([fastId, balancedId, premiumId]).toContain(n.ownerAgentId);
      expect(n.instruction.length).toBeGreaterThan(40);
      expect(n.mode).toBe("execute");
      expect(n.substituted).toBeUndefined();
    }
    // roster preferences: cheap for analysis/verify, mid for builds
    expect(nodes[0].agentName).toBe("dcmp-fast-mock");
    expect(nodes[1].agentName).toBe("dcmp-balanced-mock");

    // NOTHING was created — the plan gate stays human
    const after = (
      await app.inject({ method: "GET", headers: deeAuth, url: "/v1/runs" })
    ).json().runs.length;
    expect(after).toBe(before);

    // billed and audited as a decompose dispatch, attributed to the project
    const usage = await db.select().from(usageEvents).where(eq(usageEvents.userId, deeId));
    const decomposeUsage = usage.filter(
      (u) => (u.detail as { purpose?: string } | null)?.purpose === "decompose",
    );
    expect(decomposeUsage).toHaveLength(1);
    expect(decomposeUsage[0]!.projectId).toBe(projectId);
    expect(decomposeUsage[0]!.costUsd).toBeGreaterThan(0);
    const audit = await db.select().from(auditLog).where(eq(auditLog.userId, deeId));
    const marked = audit.filter((a) => a.ruleId === "run-decomposed");
    expect(marked).toHaveLength(1);
    expect((marked[0]!.detail as { purpose?: string }).purpose).toBe("decompose");

    // the accepted proposal submits through the NORMAL plan endpoint as-is
    const planned = await app.inject({
      method: "POST",
      headers: deeAuth,
      url: "/v1/runs",
      payload: {
        graph: { run: body.proposal.name, escalationApproverUserId: deeId, nodes },
        projectId,
      },
    });
    expect(planned.statusCode).toBe(201);
    // and the planned graph is executable: one auto-advance step runs a node
    const auto = await app.inject({
      method: "POST",
      headers: deeAuth,
      url: `/v1/runs/${planned.json().id}/auto`,
      payload: { maxNodes: 1, acceptReviews: true },
    });
    expect(auto.statusCode).toBe(200);
    expect(auto.json().steps).toHaveLength(1);
    expect(auto.json().steps[0].action).toBe("accepted");
  });
});

describe("substitution — a suggested agent outside the caller's grants", () => {
  it("falls back to the default agent and records the substitution on the node", async () => {
    const res = await app.inject({
      method: "POST",
      headers: deeAuth,
      url: "/v1/runs/decompose",
      payload: { goal: `${GOAL} <<rogueagent>>` },
    });
    expect(res.statusCode).toBe(200);
    const substituted = res.json().proposal.nodes.filter((n: any) => n.substituted);
    expect(substituted).toHaveLength(1);
    expect(substituted[0].substituted.requestedAgentName).toBe("shadow-unsanctioned-agent");
    expect(substituted[0].substituted.reason).toBe("unknown_or_ungranted_agent");
    // the fallback is dee's own default agent — never anything wider
    expect(substituted[0].ownerAgentId).toBe(balancedId);
    expect(substituted[0].agentName).toBe("dcmp-balanced-mock");
  });
});

describe("invalid model output — one retry, then 422, never a half-created run", () => {
  it("retries once with the validation errors, then 422 decomposition_invalid with rawOutput", async () => {
    const dispatchesBefore = mock.dispatches.length;
    const res = await app.inject({
      method: "POST",
      headers: deeAuth,
      url: "/v1/runs/decompose",
      payload: { goal: `${GOAL} <<badplan>>` },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe("decomposition_invalid");
    expect(body.detail).toContain("JSON");
    expect(body.rawOutput).toContain("broken plan");

    // the retry HAPPENED: two lead dispatches, the second carrying the errors
    const mine = mock.dispatches
      .slice(dispatchesBefore)
      .filter((d) => d.input.includes("<<badplan>>"));
    expect(mine).toHaveLength(2);
    expect(mine[1]!.system).toContain("Your previous plan failed validation");
    // both attempts were billed — the ledger never under-reports lead spend
    const usage = await db.select().from(usageEvents).where(eq(usageEvents.userId, deeId));
    const retryRows = usage.filter(
      (u) => (u.detail as { retry?: boolean } | null)?.retry === true,
    );
    expect(retryRows).toHaveLength(1);
  });
});

describe("lead entitlement — checked like any invoke", () => {
  it("a revoked lead agent yields the normal 403 decision shape", async () => {
    // grant, then revoke — the lead check runs under CURRENT grants
    const grant = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/agents",
      payload: { userId: rvkId, agentId: fastId },
    });
    expect(grant.statusCode).toBe(201);
    const removed = await app.inject({
      method: "DELETE",
      headers: AUTH,
      url: `/v1/grants/agents/${grant.json().id}`,
    });
    expect(removed.statusCode).toBe(200);
    const res = await app.inject({
      method: "POST",
      headers: rvkAuth,
      url: "/v1/runs/decompose",
      payload: { goal: GOAL, leadAgentId: fastId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().decision.effect).toBe("deny");
    expect(res.json().decision.ruleId).toBeTruthy();
  });

  it("bootstrap has no identity and cannot decompose", async () => {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/runs/decompose",
      payload: { goal: GOAL },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("bootstrap_cannot_decompose");
  });
});

describe("project budget gate — the lead dispatch is a dispatch like any other", () => {
  it("blocks decompose once the project's measured spend is at the cap", async () => {
    const capped = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/projects",
      payload: { name: "dcmp-capped", budgetUsd: 0.000001, budgetApproverUserId: rvkId },
    });
    expect(capped.statusCode).toBe(201);
    const cappedId = capped.json().id;
    // first crossing is allowed (measured cost arrives after the call)…
    const first = await app.inject({
      method: "POST",
      headers: deeAuth,
      url: `/v1/agents/${balancedId}/invoke`,
      payload: { mode: "execute", input: GOAL, dispatch: true, projectId: cappedId },
    });
    expect(first.statusCode).toBe(200);
    // …and the pre-gate blocks everything after it, decompose included
    const res = await app.inject({
      method: "POST",
      headers: deeAuth,
      url: "/v1/runs/decompose",
      payload: { goal: GOAL, projectId: cappedId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("project_budget_exceeded");
  });
});

describe("POST /v1/runs/decompose — §5.1 Team-Lead two-level plan", () => {
  it("drafts a lead + workers with leadNodeId and a ceiling narrowed to the caller's grants (over-broad dropped-and-recorded)", async () => {
    const res = await app.inject({
      method: "POST",
      headers: deeAuth,
      url: "/v1/runs/decompose",
      payload: { goal: `${GOAL} <<lead-plan>>`, projectId },
    });
    expect(res.statusCode).toBe(200);
    const nodes = res.json().proposal.nodes as Array<{
      id: string;
      ownerAgentId: string;
      leadNodeId?: string;
      allowedAgentIds?: string[];
      droppedAllowedAgents?: string[];
    }>;
    expect(nodes).toHaveLength(3);

    // the lead node carries a ceiling resolved to the caller's OWN entitled agents
    const lead = nodes.find((n) => n.id === "coordinate")!;
    expect(lead.leadNodeId).toBeUndefined();
    expect(lead.allowedAgentIds).toEqual(expect.arrayContaining([fastId, balancedId]));
    // the over-broad "shadow-unsanctioned-agent" the lead named was DROPPED and RECORDED
    expect(lead.droppedAllowedAgents).toContain("shadow-unsanctioned-agent");
    // nothing outside the caller's grants leaked into the ceiling
    for (const id of lead.allowedAgentIds ?? []) {
      expect([fastId, balancedId, premiumId]).toContain(id);
    }

    // the two workers delegate to the lead and are owned within its ceiling
    const workers = nodes.filter((n) => n.leadNodeId === "coordinate");
    expect(workers).toHaveLength(2);
    for (const w of workers) {
      expect(lead.allowedAgentIds).toContain(w.ownerAgentId);
    }

    // the drafted two-level plan submits through the NORMAL plan endpoint as-is —
    // the resolved leadNodeId/allowedAgentIds pass kernel validation + entitlement
    const planned = await app.inject({
      method: "POST",
      headers: deeAuth,
      url: "/v1/runs",
      payload: {
        graph: { run: res.json().proposal.name, escalationApproverUserId: deeId, nodes },
        projectId,
      },
    });
    expect(planned.statusCode).toBe(201);
  });
});
