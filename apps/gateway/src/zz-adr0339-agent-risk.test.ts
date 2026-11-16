/**
 * ADR-0339 — the agent risk score, on a real database.
 *
 * Pinned:
 *  - THE TRIGGERS mark an agent on every write path, in the change's own transaction: a registry agent's insert
 *    (created), a risk-relevant update (modified; a price edit marks nothing), a grant (access_changed), a config
 *    activation (published, through the real PATCH route); a builder agent's insert, its tools and shares; and a
 *    builder agent bound to a model that changes. The spend-limit lease does not mark.
 *  - THE SWEEP scores exactly the marked agent, appends one assessment and one audit row in one transaction, deletes
 *    the requests it read, and records an unchanged recompute as unchanged.
 *  - EVIDENCE: assessments refuse UPDATE, DELETE and TRUNCATE, and go with their agent's own deletion.
 *  - THE SCORE: the untrusted-input + data + unconfirmed-action combination and an ADR-0091 rule held by the agent
 *    alone are found from real rows.
 *  - THE ROUTES: admin and owner read the live score; anyone else gets 404; the ranked list and the recompute are
 *    admin-only; history pages with a stable cursor.
 *
 * Shares one DB with the other gateway suites (fileParallelism off): every row is prefixed r339-, and every sweep here
 * is scoped to one agent, so no other suite's queue is drained.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentGrants,
  agentRiskAssessments,
  agentRiskRecomputeRequests,
  agents,
  auditLog,
  builderAgentChannels,
  builderAgentShares,
  builderAgentTools,
  builderAgents,
  chatopsConnections,
  configVersions,
  connectors,
  createDb,
  desc,
  eq,
  inArray,
  runMigrations,
  sodRules,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { runAgentRiskRecomputeSweep, type AgentRiskSubject } from "./agent-risk.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `r339-boot-${RUN}`;
const ADMIN = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let owner: { id: string; auth: { authorization: string } };
let other: { id: string; auth: { authorization: string } };
const agentIds: string[] = [];
const builderIds: string[] = [];
const connectorIds: string[] = [];
let sodRuleId: string | null = null;

async function mkUser(tag: string) {
  const u = await app.inject({ method: "POST", headers: ADMIN, url: "/v1/users", payload: { email: `r339-${tag}-${RUN}@example.com`, displayName: `r339 ${tag}` } });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({ method: "POST", headers: ADMIN, url: `/v1/users/${u.json().id}/keys`, payload: { name: `r339-${tag}` } });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function mkAgent(name: string) {
  const r = await app.inject({ method: "POST", headers: ADMIN, url: "/v1/agents", payload: { name: `${name}-${RUN}`, provider: "mock", tier: 1, model: "mock-balanced" } });
  expect(r.statusCode).toBe(201);
  agentIds.push(r.json().id);
  return r.json().id as string;
}

async function mkBuilder(name: string, modelAgentId: string | null) {
  const [b] = await db
    .insert(builderAgents)
    .values({ name: `${name}-${RUN}`, ownerUserId: owner.id, modelAgentId, connectionFormat: "shared", monthlyLimitUsd: 10 })
    .returning({ id: builderAgents.id });
  builderIds.push(b!.id);
  return b!.id;
}

async function mkConnector(tag: string) {
  const [c] = await db.insert(connectors).values({ name: `r339-${tag}-${RUN}`, kind: "slack", providerKind: "slack" }).returning({ id: connectors.id });
  connectorIds.push(c!.id);
  return c!.id;
}

const requests = async (s: AgentRiskSubject) =>
  db
    .select({ trigger: agentRiskRecomputeRequests.trigger })
    .from(agentRiskRecomputeRequests)
    .where(eq(s.kind === "agent" ? agentRiskRecomputeRequests.agentId : agentRiskRecomputeRequests.builderAgentId, s.id))
    .then((rows) => rows.map((r) => r.trigger).sort());

const assessments = async (s: AgentRiskSubject) =>
  db
    .select()
    .from(agentRiskAssessments)
    .where(eq(s.kind === "agent" ? agentRiskAssessments.agentId : agentRiskAssessments.builderAgentId, s.id))
    .orderBy(desc(agentRiskAssessments.computedAt), desc(agentRiskAssessments.id));

const sweep = (s: AgentRiskSubject) => runAgentRiskRecomputeSweep(db, { only: s });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  owner = await mkUser("owner");
  other = await mkUser("other");
});

afterAll(async () => {
  if (sodRuleId) await db.delete(sodRules).where(eq(sodRules.id, sodRuleId));
  if (builderIds.length) await db.delete(builderAgents).where(inArray(builderAgents.id, builderIds));
  if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds));
  if (connectorIds.length) await db.delete(connectors).where(inArray(connectors.id, connectorIds));
  await app.close();
});

describe("ADR-0339 triggers: every write path marks the agent", () => {
  it("a registry agent: created, modified, a price edit marks nothing, a grant is access_changed", async () => {
    const id = await mkAgent("r339-reg");
    const s: AgentRiskSubject = { kind: "agent", id };
    expect(await requests(s)).toEqual(["created"]);
    await sweep(s);
    expect(await requests(s)).toEqual([]);

    await db.update(agents).set({ costPerMTokIn: 9 }).where(eq(agents.id, id));
    expect(await requests(s)).toEqual([]); // not a risk-relevant column

    await db.update(agents).set({ ownerUserId: owner.id }).where(eq(agents.id, id));
    expect(await requests(s)).toEqual(["modified"]);
    await db.insert(agentGrants).values({ userId: other.id, agentId: id });
    expect(await requests(s)).toEqual(["access_changed", "modified"]);
  });

  it("a config edit through the real PATCH route is modified; a config version becoming active is published", async () => {
    const id = await mkAgent("r339-pub");
    const s: AgentRiskSubject = { kind: "agent", id };
    await sweep(s);
    const r = await app.inject({ method: "PATCH", headers: ADMIN, url: `/v1/agents/${id}`, payload: { model: "mock-fast" } });
    expect(r.statusCode).toBe(200);
    expect(await requests(s)).toEqual(["modified"]);
    await sweep(s);
    // a draft is not a publish; its activation is
    const [v] = await db
      .insert(configVersions)
      .values({ artifactType: "agent_config", artifactId: id, version: 1, body: { model: "mock-fast" }, status: "draft" })
      .returning({ id: configVersions.id });
    expect(await requests(s)).toEqual([]);
    await db.update(configVersions).set({ status: "active" }).where(eq(configVersions.id, v!.id));
    expect(await requests(s)).toEqual(["published"]);
    await db.delete(configVersions).where(eq(configVersions.id, v!.id));
  });

  it("a builder agent: created, its tools and shares; the lease does not mark; its model's change marks it", async () => {
    const model = await mkAgent("r339-bmodel");
    const id = await mkBuilder("r339-b1", model);
    const s: AgentRiskSubject = { kind: "builder_agent", id };
    expect(await requests(s)).toEqual(["created"]);
    await sweep(s);
    await db.update(builderAgents).set({ limitLeaseToken: sql`gen_random_uuid()`, limitLeaseUntil: new Date() }).where(eq(builderAgents.id, id));
    expect(await requests(s)).toEqual([]);
    const c = await mkConnector("tool");
    await db.insert(builderAgentTools).values({ agentId: id, kind: "connector", refId: c, requiresApproval: false });
    await db.insert(builderAgentShares).values({ agentId: id, userId: other.id });
    expect(await requests(s)).toEqual(["access_changed", "modified"]);
    await sweep(s);
    await db.update(agents).set({ expectedServedModel: "something-else" }).where(eq(agents.id, model));
    expect(await requests(s)).toEqual(["modified"]);
  });
});

describe("ADR-0339 sweep and evidence", () => {
  it("scores the marked agent: one assessment + one audit row, the requests drained; unchanged is recorded", async () => {
    const id = await mkAgent("r339-sweep");
    const s: AgentRiskSubject = { kind: "agent", id };
    const out = await sweep(s);
    expect(out).toMatchObject({ scored: 1, failed: 0 });
    expect(await requests(s)).toEqual([]);
    const [a] = await assessments(s);
    expect(a!.triggers).toEqual(["created"]);
    expect(a!.score).toBeGreaterThan(0); // no owner, no sign-off, untested: never 0 for a new agent
    expect((a!.assessment as { factors: Array<{ id: string; present: boolean }> }).factors.find((f) => f.id === "ownership")!.present).toBe(true);
    const audit = await db.select().from(auditLog).where(sql`${auditLog.objectId} = ${id} AND ${auditLog.ruleId} = 'agent-risk-recomputed'`);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toMatchObject({ assessmentId: a!.id, score: a!.score, previousScore: null, unchanged: false });

    // a recompute with nothing changed is still an assessment, marked unchanged in its audit row
    await app.inject({ method: "POST", headers: ADMIN, url: "/v1/agent-risk/recompute", payload: { kind: "agent", subjectId: id } });
    const list = await assessments(s);
    expect(list).toHaveLength(2);
    expect(list[0]!.triggers).toEqual(["manual"]);
    expect(list[0]!.assessmentDigest).toBe(list[1]!.assessmentDigest);
    const audit2 = await db.select().from(auditLog).where(sql`${auditLog.objectId} = ${id} AND ${auditLog.ruleId} = 'agent-risk-recomputed'`).orderBy(desc(auditLog.at));
    expect(audit2[0]!.detail).toMatchObject({ unchanged: true, previousScore: a!.score });

    // assigning an owner lowers the score by the ownership factor's 10 points (times the reach multiplier of 1)
    await db.update(agents).set({ ownerUserId: owner.id }).where(eq(agents.id, id));
    await sweep(s);
    const [after] = await assessments(s);
    expect(after!.score).toBe(a!.score - 10);
  });

  it("assessments are append-only and go with their agent's own deletion", async () => {
    const id = await mkAgent("r339-evidence");
    const s: AgentRiskSubject = { kind: "agent", id };
    await sweep(s);
    const [a] = await assessments(s);
    await expect(db.update(agentRiskAssessments).set({ score: 0 }).where(eq(agentRiskAssessments.id, a!.id))).rejects.toThrow();
    await expect(db.delete(agentRiskAssessments).where(eq(agentRiskAssessments.id, a!.id))).rejects.toThrow();
    await expect(db.execute(sql`TRUNCATE agent_risk_assessments`)).rejects.toThrow();
    await db.delete(agents).where(eq(agents.id, id));
    expect(await assessments(s)).toHaveLength(0);
  });

  it("finds the untrusted-input + data + unconfirmed-action combination and an SoD rule the agent alone holds", async () => {
    const model = await mkAgent("r339-tmodel");
    const id = await mkBuilder("r339-toxic", model);
    const s: AgentRiskSubject = { kind: "builder_agent", id };
    const c1 = await mkConnector("pay");
    const c2 = await mkConnector("approve");
    await db.insert(builderAgentTools).values([
      { agentId: id, kind: "connector", refId: c1, requiresApproval: false },
      { agentId: id, kind: "connector", refId: c2, requiresApproval: true },
    ]);
    const [chat] = await db.insert(chatopsConnections).values({ name: `r339-chat-${RUN}`, provider: "slack", connectorId: c1, defaultChannel: "C1", signingSecretCiphertext: "r339-not-a-secret", secretSetAt: new Date() }).returning({ id: chatopsConnections.id });
    await db.insert(builderAgentChannels).values({ agentId: id, provider: "slack", chatopsConnectionId: chat!.id, externalChannelId: "C1" });
    const [rule] = await db
      .insert(sodRules)
      .values({ name: `r339-pay-approve-${RUN}`, reason: "r339", aKind: "connector", aObjectId: c1, bKind: "connector", bObjectId: c2 })
      .returning({ id: sodRules.id });
    sodRuleId = rule!.id;
    await sweep(s);
    const [a] = await assessments(s);
    const toxic = (a!.assessment as { toxicCombinations: Array<{ id: string; present: boolean; evidence: string }> }).toxicCombinations;
    expect(toxic.find((t) => t.id === "untrusted_input_data_action")!.present).toBe(true);
    const sod = toxic.find((t) => t.id === "sod_rule_held_by_agent")!;
    expect(sod.present).toBe(true);
    expect(sod.evidence).toContain(`r339-pay-approve-${RUN}`);
    // negative control: with the rule disabled, the agent no longer holds a rule
    await db.update(sodRules).set({ enabled: false }).where(eq(sodRules.id, rule!.id));
    await app.inject({ method: "POST", headers: ADMIN, url: "/v1/agent-risk/recompute", payload: { kind: "builder_agent", subjectId: id } });
    const [b] = await assessments(s);
    expect((b!.assessment as { toxicCombinations: Array<{ id: string; present: boolean }> }).toxicCombinations.find((t) => t.id === "sod_rule_held_by_agent")!.present).toBe(false);
    expect(b!.score).toBe(a!.score - 15);
  });
});

describe("ADR-0339 routes", () => {
  it("live score: admin and owner read it, anyone else 404; no-store", async () => {
    const id = await mkAgent("r339-route");
    await db.update(agents).set({ ownerUserId: owner.id }).where(eq(agents.id, id));
    await sweep({ kind: "agent", id });
    const url = `/v1/agent-risk/agent/${id}`;
    const asAdmin = await app.inject({ method: "GET", headers: ADMIN, url });
    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.headers["cache-control"]).toBe("private, no-store");
    const body = asAdmin.json();
    expect(body).toMatchObject({ estimate: true, subject: { kind: "agent", id }, recomputePending: false });
    expect(body.latestAssessment.score).toBe(body.score);
    expect(body.factors.every((f: { owasp: string[] }) => f.owasp.length > 0)).toBe(true);
    expect((await app.inject({ method: "GET", headers: owner.auth, url })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", headers: other.auth, url })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", headers: other.auth, url: `/v1/agent-risk/agent/${id}/history` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", headers: ADMIN, url: `/v1/agent-risk/agent/00000000-0000-4000-8000-000000000000` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", headers: ADMIN, url: `/v1/agent-risk/nonsense/${id}` })).statusCode).toBe(404);
  });

  it("history pages newest first with a stable cursor", async () => {
    const id = await mkAgent("r339-hist");
    const s: AgentRiskSubject = { kind: "agent", id };
    for (let i = 0; i < 3; i++) await app.inject({ method: "POST", headers: ADMIN, url: "/v1/agent-risk/recompute", payload: { kind: "agent", subjectId: id } });
    const all = await assessments(s);
    expect(all).toHaveLength(3);
    const p1 = await app.inject({ method: "GET", headers: ADMIN, url: `/v1/agent-risk/agent/${id}/history?limit=2` });
    expect(p1.statusCode).toBe(200);
    expect(p1.json().items.map((r: { id: string }) => r.id)).toEqual([all[0]!.id, all[1]!.id]);
    const p2 = await app.inject({ method: "GET", headers: ADMIN, url: `/v1/agent-risk/agent/${id}/history?limit=2&cursor=${p1.json().nextCursor}` });
    expect(p2.json().items.map((r: { id: string }) => r.id)).toEqual([all[2]!.id]);
    expect(p2.json().nextCursor).toBeNull();
    expect((await app.inject({ method: "GET", headers: ADMIN, url: `/v1/agent-risk/agent/${id}/history?cursor=bad` })).statusCode).toBe(400);
  });

  it("the ranked list and the recompute are admin-only; the list is ordered by score", async () => {
    expect((await app.inject({ method: "GET", headers: owner.auth, url: "/v1/agent-risk" })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", headers: owner.auth, url: "/v1/agent-risk/recompute", payload: {} })).statusCode).toBe(403);
    const r = await app.inject({ method: "GET", headers: ADMIN, url: "/v1/agent-risk?kind=agent&limit=100" });
    expect(r.statusCode).toBe(200);
    const scores = (r.json().items as Array<{ score: number }>).map((i) => i.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(typeof r.json().unscored).toBe("number");
    expect((await app.inject({ method: "GET", headers: ADMIN, url: "/v1/agent-risk?bogus=1" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", headers: ADMIN, url: "/v1/agent-risk/recompute", payload: { kind: "agent" } })).statusCode).toBe(400);
  });
});
