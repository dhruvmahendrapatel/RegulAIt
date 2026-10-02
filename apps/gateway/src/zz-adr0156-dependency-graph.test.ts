/**
 * ADR-0156 — `GET /v1/inventory/graph`.
 *
 * Pinned: declared edges (use case → agent → model → vendor) and observed
 * edges (agent → MCP server from trace spans) are drawn and labelled with
 * their basis; a vendor's risk propagates to the use case that depends on it,
 * with a path a reviewer can walk; residual beats inherent, closed risks do
 * not count; `useCaseId` scopes to what that use case depends on;
 * `includeObserved=false` drops observed edges; admin-only. Assertions are
 * scoped to ids this file creates (M-008) — the database is shared.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
  aiRisks,
  aiUseCases,
  aiVendors,
  createDb,
  mcpServers,
  runMigrations,
  traceSpans,
  traces,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `g156-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
const ids = {} as Record<"owner" | "agentA" | "agentB" | "useCase" | "vendor" | "server" | "riskVendor" | "riskAgent", string>;
let modelKeyA = "";

const get = (url: string, headers: Record<string, string> = AUTH) => app.inject({ method: "GET", url, headers });
type Node = { key: string; type: string; label: string; ownRisk: any; propagatedRisk: any; attributes: any };
type Edge = { from: string; to: string; kind: string; basis: string; observedCount?: number };

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });

  const [owner] = await db
    .insert(users)
    .values({ email: `g156-${RUN}@example.com`, displayName: "Graph owner" })
    .returning({ id: users.id });
  ids.owner = owner!.id;

  const [a] = await db
    .insert(agents)
    .values({ name: `g156-agent-a-${RUN}`, provider: "mock", tier: 1, model: `g156-model-${RUN}` })
    .returning({ id: agents.id });
  const [b] = await db
    .insert(agents)
    .values({ name: `g156-agent-b-${RUN}`, provider: "mock", tier: 1, model: `g156-other-${RUN}` })
    .returning({ id: agents.id });
  ids.agentA = a!.id;
  ids.agentB = b!.id;
  modelKeyA = `model:mock:g156-model-${RUN}`;

  const [uc] = await db
    .insert(aiUseCases)
    .values({
      name: `g156-use-case-${RUN}`,
      description: "synthetic",
      businessContext: "graph test",
      dataSensitivity: "confidential",
      ownerUserId: ids.owner,
      intendedAgentIds: [ids.agentA],
    })
    .returning({ id: aiUseCases.id });
  ids.useCase = uc!.id;

  const [v] = await db
    .insert(aiVendors)
    .values({
      name: `g156-vendor-${RUN}`,
      description: "synthetic model provider",
      category: "model_provider",
      ownerUserId: ids.owner,
      linkedAgentProviders: ["mock"],
    })
    .returning({ id: aiVendors.id });
  ids.vendor = v!.id;

  const [srv] = await db
    .insert(mcpServers)
    .values({ name: `g156-mcp-${RUN}`, url: "https://mcp.example.invalid" })
    .returning({ id: mcpServers.id });
  ids.server = srv!.id;

  // observed: one tool span under an llm span carrying agent A
  const [t] = await db
    .insert(traces)
    .values({ kind: "dispatch", name: "g156", userId: ids.owner })
    .returning({ id: traces.id });
  const [parent] = await db
    .insert(traceSpans)
    .values({ traceId: t!.id, seq: 0, kind: "llm", name: "dispatch", startedAt: new Date(), agentId: ids.agentA })
    .returning({ id: traceSpans.id });
  await db.insert(traceSpans).values([
    { traceId: t!.id, parentSpanId: parent!.id, seq: 1, kind: "tool", name: "lookup", startedAt: new Date(), mcpServerId: ids.server },
    { traceId: t!.id, parentSpanId: parent!.id, seq: 2, kind: "tool", name: "lookup", startedAt: new Date(), mcpServerId: ids.server },
  ]);

  const risk = (v: Partial<typeof aiRisks.$inferInsert>) => ({
    title: `g156 risk ${RUN}`,
    description: "synthetic",
    category: "third_party_ai" as const,
    ownerUserId: ids.owner,
    likelihood: "low" as const,
    impact: "low" as const,
    ...v,
  });
  const inserted = await db
    .insert(aiRisks)
    .values([
      // the vendor's risk: high × high, inherent → 9
      risk({ vendorId: ids.vendor, likelihood: "high", impact: "high" }),
      // agent A: inherent medium × medium, residual low × medium → 2 (residual wins)
      risk({ agentId: ids.agentA, likelihood: "medium", impact: "medium", residualLikelihood: "low", residualImpact: "medium", status: "mitigating" }),
      // closed: would be 9 on the use case, must not count
      risk({ useCaseId: ids.useCase, likelihood: "high", impact: "high", status: "closed" }),
      // agent B: accepted risks still count
      risk({ agentId: ids.agentB, likelihood: "medium", impact: "high", status: "accepted", acceptanceNote: "carried knowingly", acceptedByUserId: ids.owner, acceptedAt: new Date() }),
    ])
    .returning({ id: aiRisks.id });
  ids.riskVendor = inserted[0]!.id;
  ids.riskAgent = inserted[1]!.id;
}, 120_000);

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
});

describe("ADR-0156 the AI-system dependency graph", () => {
  it("draws declared and observed edges with their basis", async () => {
    const r = await get("/v1/inventory/graph");
    expect(r.statusCode, r.body).toBe(200);
    const g = r.json() as { nodes: Node[]; edges: Edge[]; notes: Record<string, string> };
    const has = (from: string, to: string, kind: string, basis: string) =>
      g.edges.some((e) => e.from === from && e.to === to && e.kind === kind && e.basis === basis);
    expect(has(`use_case:${ids.useCase}`, `agent:${ids.agentA}`, "uses_agent", "declared")).toBe(true);
    expect(has(`agent:${ids.agentA}`, modelKeyA, "runs_on", "declared")).toBe(true);
    expect(has(modelKeyA, `vendor:${ids.vendor}`, "supplied_by", "declared")).toBe(true);
    expect(has(`agent:${ids.agentA}`, `mcp_server:${ids.server}`, "calls_tool", "observed")).toBe(true);
    const toolEdge = g.edges.find((e) => e.to === `mcp_server:${ids.server}`)!;
    expect(toolEdge.observedCount).toBe(2);
    // B is not in the use case — no edge invented
    expect(has(`use_case:${ids.useCase}`, `agent:${ids.agentB}`, "uses_agent", "declared")).toBe(false);
    expect(g.notes.propagation).toContain("maximum");
  });

  it("propagates the vendor's risk to the use case, with a walkable path", async () => {
    const g = (await get("/v1/inventory/graph")).json() as { nodes: Node[] };
    const node = (k: string) => g.nodes.find((n) => n.key === k)!;

    const vendor = node(`vendor:${ids.vendor}`);
    expect(vendor.ownRisk).toMatchObject({ score: 9, band: "high", riskId: ids.riskVendor, openRisks: 1 });

    const agentA = node(`agent:${ids.agentA}`);
    // residual (low × medium = 2) is the agent's own rating, not inherent 4
    expect(agentA.ownRisk).toMatchObject({ score: 2, band: "low", riskId: ids.riskAgent });
    expect(agentA.propagatedRisk).toMatchObject({ score: 9, sourceNodeKey: `vendor:${ids.vendor}` });

    const uc = node(`use_case:${ids.useCase}`);
    // the closed 9 on the use case itself does not count
    expect(uc.ownRisk).toMatchObject({ score: 0, band: "none", openRisks: 0 });
    expect(uc.propagatedRisk).toMatchObject({ score: 9, band: "high", sourceRiskId: ids.riskVendor });
    expect(uc.propagatedRisk.path).toEqual([`use_case:${ids.useCase}`, `agent:${ids.agentA}`, modelKeyA, `vendor:${ids.vendor}`]);

    // accepted risk counts (medium × high = 6)
    expect(node(`agent:${ids.agentB}`).ownRisk).toMatchObject({ score: 6, band: "high" });
  });

  it("scopes to what one use case depends on, and can drop observed edges", async () => {
    const r = await get(`/v1/inventory/graph?useCaseId=${ids.useCase}`);
    expect(r.statusCode).toBe(200);
    const g = r.json() as { nodes: Node[]; edges: Edge[]; scope: any };
    const keys = new Set(g.nodes.map((n) => n.key));
    expect(keys).toEqual(
      new Set([`use_case:${ids.useCase}`, `agent:${ids.agentA}`, modelKeyA, `vendor:${ids.vendor}`, `mcp_server:${ids.server}`]),
    );
    for (const e of g.edges) expect(keys.has(e.from) && keys.has(e.to)).toBe(true);
    expect(g.scope).toEqual({ useCaseId: ids.useCase, includeObserved: true });

    const declaredOnly = (await get(`/v1/inventory/graph?useCaseId=${ids.useCase}&includeObserved=false`)).json() as {
      nodes: Node[];
      edges: Edge[];
    };
    expect(declaredOnly.edges.every((e) => e.basis === "declared")).toBe(true);
    expect(declaredOnly.nodes.some((n) => n.type === "mcp_server")).toBe(false);
  });

  it("404s an unknown use case and refuses non-admins", async () => {
    expect((await get(`/v1/inventory/graph?useCaseId=00000000-0000-4000-8000-000000000000`)).statusCode).toBe(404);
    const u = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: AUTH,
      payload: { email: `g156-member-${RUN}@example.com`, displayName: "Member" },
    });
    const key = (
      await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: "k" } })
    ).json().token as string;
    expect((await get("/v1/inventory/graph", { authorization: `Bearer ${key}` })).statusCode).toBe(403);
  });
});
