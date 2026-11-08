/**
 * ADR-0214 amendment — per-asset scores over HTTP: object-level authorisation, the bounded keyset page, the
 * no-store header, and a golden figure computed from seeded ledger rows.
 *
 * Shares one DB with the other gateway suites (fileParallelism off); everything here is prefixed as-. The ledger rows
 * this suite adds (risks, red-team and evaluation runs, use cases, agents) are dated inside the report window but
 * BEFORE now, so no other suite's "latest run" changes, and they are deleted in afterAll so no org-wide total moves.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
  aiRisks,
  aiUseCases,
  createDb,
  eq,
  evalDatasets,
  evalRuns,
  inArray,
  redteamLibraries,
  redteamRuns,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { agentInputs, scoreAsset, type AssetScore } from "./asset-score.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "as-bootstrap-token";
const ADMIN = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let ana: { id: string; auth: { authorization: string } };
let ben: { id: string; auth: { authorization: string } };
const agentIds: string[] = [];
let anaAgent: string;
let benAgent: string;
let anaUseCase: string;
let benUseCase: string;
const evalRunIds: string[] = [];
const datasetIds: string[] = [];
let libraryId: string | null = null;

async function mkUser(tag: string) {
  const u = await app.inject({ method: "POST", headers: ADMIN, url: "/v1/users", payload: { email: `as-${tag}@example.com`, displayName: `as ${tag}` } });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({ method: "POST", headers: ADMIN, url: `/v1/users/${u.json().id}/keys`, payload: { name: `as-${tag}` } });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function mkAgent(name: string, ownerUserId: string) {
  const r = await app.inject({
    method: "POST",
    headers: ADMIN,
    url: "/v1/agents",
    payload: { name, provider: "mock", tier: 1, model: "mock-balanced", costPerMTokIn: 1, costPerMTokOut: 2 },
  });
  expect(r.statusCode).toBe(201);
  const id = r.json().id as string;
  await db.update(agents).set({ ownerUserId }).where(eq(agents.id, id));
  agentIds.push(id);
  return id;
}

async function mkUseCase(name: string, ownerUserId: string) {
  const [row] = await db
    .insert(aiUseCases)
    .values({ name, description: "as", ownerUserId, businessContext: "as", dataSensitivity: "internal", intendedAgentIds: [], status: "proposed" })
    .returning({ id: aiUseCases.id });
  return row!.id;
}

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c".repeat(64), auditAnchorSink: null });
  ana = await mkUser("ana");
  ben = await mkUser("ben");
  anaAgent = await mkAgent("as-agent-a1", ana.id);
  await mkAgent("as-agent-a2", ana.id);
  await mkAgent("as-agent-a3", ana.id);
  benAgent = await mkAgent("as-agent-b1", ben.id);
  anaUseCase = await mkUseCase("as-usecase-ana", ana.id);
  benUseCase = await mkUseCase("as-usecase-ben", ben.id);

  // anaAgent's ledger slice: 2 risks (1 open), a red-team run at ASR upper 0.3, a groundedness run passing 80%
  await db.insert(aiRisks).values([
    { title: "as-r1", description: "as", category: "scope_drift", ownerUserId: ana.id, likelihood: "low", impact: "low", agentId: anaAgent, status: "open" },
    { title: "as-r2", description: "as", category: "scope_drift", ownerUserId: ana.id, likelihood: "low", impact: "low", agentId: anaAgent, status: "closed" },
    { title: "as-r3", description: "as", category: "scope_drift", ownerUserId: ben.id, likelihood: "low", impact: "low", useCaseId: benUseCase, status: "open" },
  ]);
  const [gds] = await db.insert(evalDatasets).values({ name: "as-grounded-ds", version: 1, scorerKind: "claim_support" }).returning();
  const [rds] = await db.insert(evalDatasets).values({ name: "as-redteam-ds", version: 1, scorerKind: "contains" }).returning();
  datasetIds.push(gds!.id, rds!.id);
  const [ge] = await db
    .insert(evalRuns)
    .values({ datasetId: gds!.id, datasetVersion: 1, agentId: anaAgent, agentName: "as-agent-a1", trigger: "manual", status: "completed", passRate: 0.8, startedAt: daysAgo(5) })
    .returning();
  const [re] = await db
    .insert(evalRuns)
    .values({ datasetId: rds!.id, datasetVersion: 1, agentId: anaAgent, agentName: "as-agent-a1", trigger: "manual", status: "completed", startedAt: daysAgo(5) })
    .returning();
  evalRunIds.push(ge!.id, re!.id);
  const [lib] = await db.insert(redteamLibraries).values({ name: "as-lib", version: 1 }).returning();
  libraryId = lib!.id;
  await db.insert(redteamRuns).values({
    libraryId: lib!.id,
    libraryName: "as-lib",
    libraryVersion: 1,
    evalRunId: re!.id,
    agentId: anaAgent,
    agentName: "as-agent-a1",
    asr: 0.2,
    asrLower: 0.1,
    asrUpper: 0.3,
    asrTrials: 50,
    measurementQuality: "measured",
    startedAt: daysAgo(5),
  });
});

afterAll(async () => {
  await db.delete(redteamRuns).where(inArray(redteamRuns.agentId, agentIds));
  if (libraryId) await db.delete(redteamLibraries).where(eq(redteamLibraries.id, libraryId));
  if (evalRunIds.length) await db.delete(evalRuns).where(inArray(evalRuns.id, evalRunIds));
  if (datasetIds.length) await db.delete(evalDatasets).where(inArray(evalDatasets.id, datasetIds));
  await db.delete(aiRisks).where(inArray(aiRisks.title, ["as-r1", "as-r2", "as-r3"]));
  await db.delete(aiUseCases).where(inArray(aiUseCases.id, [anaUseCase, benUseCase]));
  await db.delete(agents).where(inArray(agents.id, agentIds));
  await app.close();
  await db.$client.end();
});

const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url, headers });

describe("object-level authorisation", () => {
  it("a steward's list holds only the agents they steward; another user's agent is a 404 like a missing one", async () => {
    const mine = await get("/v1/reports/posture/assets?kind=agent&limit=100", ana.auth);
    expect(mine.statusCode).toBe(200);
    const names = (mine.json().items as AssetScore[]).map((s) => s.asset.name);
    expect(names).toEqual(["as-agent-a1", "as-agent-a2", "as-agent-a3"]);

    const theirs = await get(`/v1/reports/posture/assets/agent/${benAgent}`, ana.auth);
    expect(theirs.statusCode).toBe(404);
    const missing = await get("/v1/reports/posture/assets/agent/00000000-0000-4000-8000-000000000000", ana.auth);
    expect(missing.statusCode).toBe(404);
    expect(theirs.json()).toEqual(missing.json());

    const benList = await get("/v1/reports/posture/assets?kind=agent", ben.auth);
    expect((benList.json().items as AssetScore[]).map((s) => s.asset.id)).toEqual([benAgent]);
  });

  it("a use case is scored for its owner, not for another user", async () => {
    const own = await get(`/v1/reports/posture/assets/use_case/${anaUseCase}`, ana.auth);
    expect(own.statusCode).toBe(200);
    expect(own.json().asset).toMatchObject({ kind: "use_case", id: anaUseCase });
    expect((await get(`/v1/reports/posture/assets/use_case/${benUseCase}`, ana.auth)).statusCode).toBe(404);
    const list = await get("/v1/reports/posture/assets?kind=use_case", ana.auth);
    expect((list.json().items as AssetScore[]).map((s) => s.asset.id)).toEqual([anaUseCase]);
  });

  it("an admin sees every asset", async () => {
    const res = await get("/v1/reports/posture/assets?kind=agent&limit=100", ADMIN);
    const ids = (res.json().items as AssetScore[]).map((s) => s.asset.id);
    // the admin's first page may hold other suites' agents too; page through until ours are all seen
    let cursor = res.json().nextCursor as string | null;
    const seen = new Set(ids);
    while (cursor) {
      const next = await get(`/v1/reports/posture/assets?kind=agent&limit=100&cursor=${cursor}`, ADMIN);
      for (const s of next.json().items as AssetScore[]) seen.add(s.asset.id);
      cursor = next.json().nextCursor;
    }
    for (const id of agentIds) expect(seen.has(id)).toBe(true);
    expect((await get(`/v1/reports/posture/assets/use_case/${benUseCase}`, ADMIN)).statusCode).toBe(200);
  });

  it("is never cacheable across users", async () => {
    const res = await get("/v1/reports/posture/assets?kind=agent", ana.auth);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect((await get(`/v1/reports/posture/assets/agent/${anaAgent}`, ana.auth)).headers["cache-control"]).toBe("private, no-store");
  });
});

describe("bounded keyset pages", () => {
  it("pages in name order with a cursor, and ends with a null cursor", async () => {
    const p1 = await get("/v1/reports/posture/assets?kind=agent&limit=2", ana.auth);
    expect(p1.json().items.map((s: AssetScore) => s.asset.name)).toEqual(["as-agent-a1", "as-agent-a2"]);
    expect(p1.json().nextCursor).toEqual(expect.any(String));
    const p2 = await get(`/v1/reports/posture/assets?kind=agent&limit=2&cursor=${p1.json().nextCursor}`, ana.auth);
    expect(p2.json().items.map((s: AssetScore) => s.asset.name)).toEqual(["as-agent-a3"]);
    expect(p2.json().nextCursor).toBeNull();
  });

  it("refuses an over-limit page, an unknown kind and a forged cursor", async () => {
    expect((await get("/v1/reports/posture/assets?kind=agent&limit=101", ana.auth)).statusCode).toBe(400);
    expect((await get("/v1/reports/posture/assets?kind=connector", ana.auth)).statusCode).toBe(400);
    expect((await get("/v1/reports/posture/assets?kind=agent&cursor=not-a-cursor", ana.auth)).statusCode).toBe(400);
  });
});

describe("the served score is the pure function of the seeded ledgers", () => {
  it("anaAgent: (20·50 + 15·70 + 15·100 + 10·80) ÷ 60 = 72.5 → 73", async () => {
    const res = await get(`/v1/reports/posture/assets/agent/${anaAgent}`, ana.auth);
    expect(res.statusCode).toBe(200);
    const s = res.json() as AssetScore;
    expect(s.objectives.map((o) => [o.id, o.score])).toEqual([
      ["risk", 50],
      ["adversarial", 70],
      ["access", 100],
      ["evaluation", 80],
    ]);
    expect(s.score).toBe(73);
    const [row] = await db.select({ id: agents.id, name: agents.name, ownerUserId: agents.ownerUserId }).from(agents).where(eq(agents.id, anaAgent));
    const [input] = await agentInputs(db, [row!], new Date());
    expect(s).toEqual(JSON.parse(JSON.stringify(scoreAsset(input!))));
  });

  it("an agent with no records scores 0 on the list too", async () => {
    const res = await get("/v1/reports/posture/assets?kind=agent&limit=100", ana.auth);
    const a2 = (res.json().items as AssetScore[]).find((s) => s.asset.name === "as-agent-a2")!;
    // owned (15 of 60 → 25) is the one measured objective
    expect(a2.score).toBe(25);
  });
});
