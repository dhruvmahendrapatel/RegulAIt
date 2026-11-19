/**
 * ADR-0339 — the agent risk score, on a real database.
 *
 * Pinned:
 *  - THE TRIGGERS mark an agent on every write path, in the change's own transaction: a registry agent's insert
 *    (created), a risk-relevant update (modified; a price edit marks nothing), a grant (access_changed), a config
 *    activation (published, through the real PATCH route); a builder agent's insert, its tools and shares; and a
 *    builder agent bound to a model that changes. The spend-limit lease does not mark.
 *  - EVIDENCE INPUTS mark too (review round 1): an agent guardrail override, a model card and its sign-off, a finished
 *    red-team run, an SoD rule, the owner's account being disabled, a skill's admission, a use case naming the agent,
 *    a sub-agent link (the child's reach), a builder agent binding to a model (the model's reach), and the daily mark.
 *  - THE LATEST POINTER moves forward with every append and serves the ranked list.
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
  agentRiskLatest,
  aiUseCases,
  builderAgentSkills,
  builderAgentSubagents,
  builderSkills,
  evalDatasets,
  evalRuns,
  guardrailConfigs,
  modelCardApprovals,
  modelCards,
  redteamLibraries,
  redteamRuns,
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
import { markAllAgentRisk, runAgentRiskRecomputeSweep, type AgentRiskSubject } from "./agent-risk.js";

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

describe("ADR-0339 triggers: the score's other inputs mark the agent (evidence_changed)", () => {
  const drain = async (...ss: AgentRiskSubject[]) => {
    for (const x of ss) await sweep(x);
  };

  it("an agent guardrail override marks the agent and the builder agents bound to it", async () => {
    const model = await mkAgent("r339-gr");
    const b = await mkBuilder("r339-gr-b", model);
    const sm: AgentRiskSubject = { kind: "agent", id: model };
    const sb: AgentRiskSubject = { kind: "builder_agent", id: b };
    await drain(sm, sb);
    const [g] = await db.insert(guardrailConfigs).values({ scope: "agent", scopeId: model, promptInjectionMode: "warn" }).returning({ id: guardrailConfigs.id });
    expect(await requests(sm)).toEqual(["evidence_changed"]);
    expect(await requests(sb)).toEqual(["evidence_changed"]);
    await drain(sm, sb);
    await db.delete(guardrailConfigs).where(eq(guardrailConfigs.id, g!.id));
    expect(await requests(sm)).toEqual(["evidence_changed"]);
  });

  it("a model card and its sign-off mark the agent the card describes", async () => {
    const id = await mkAgent("r339-card");
    const s: AgentRiskSubject = { kind: "agent", id };
    await drain(s);
    const [card] = await db.insert(modelCards).values({ agentId: id, intendedUse: `r339 ${RUN}` }).returning({ id: modelCards.id });
    expect(await requests(s)).toEqual(["evidence_changed"]);
    await drain(s);
    await db.insert(modelCardApprovals).values({ cardId: card!.id, approverUserId: owner.id });
    expect(await requests(s)).toEqual(["evidence_changed"]);
  });

  it("a red-team run marks the agent when it finishes, not while it runs", async () => {
    const id = await mkAgent("r339-rt");
    const s: AgentRiskSubject = { kind: "agent", id };
    await drain(s);
    const [lib] = await db.insert(redteamLibraries).values({ name: `r339-lib-${RUN}` }).returning();
    const [ds] = await db.insert(evalDatasets).values({ name: `r339-ds-${RUN}` }).returning();
    const [ev] = await db.insert(evalRuns).values({ datasetId: ds!.id, datasetVersion: ds!.version, agentName: "r339", trigger: "manual" }).returning();
    const [run] = await db
      .insert(redteamRuns)
      .values({ libraryId: lib!.id, libraryName: lib!.name, libraryVersion: 1, evalRunId: ev!.id, agentId: id, agentName: "r339" })
      .returning({ id: redteamRuns.id });
    expect(await requests(s)).toEqual([]);
    await db.update(redteamRuns).set({ finishedAt: new Date(), classSummary: [{ attackClass: "jailbreak", probes: 1, resisted: 1, defeated: 0 }] }).where(eq(redteamRuns.id, run!.id));
    expect(await requests(s)).toEqual(["evidence_changed"]);
  });

  it("an SoD rule toggled marks every agent; the owner's account disabled marks the agents they own", async () => {
    const id = await mkAgent("r339-own");
    const peer = await mkAgent("r339-own-peer");
    const gone = await mkUser("gone");
    const s: AgentRiskSubject = { kind: "agent", id };
    await db.update(agents).set({ ownerUserId: gone.id }).where(eq(agents.id, id));
    await drain(s);
    const [rule] = await db.insert(sodRules).values({ name: `r339-toggle-${RUN}`, reason: "r339", aKind: "agent", aObjectId: id, bKind: "agent", bObjectId: peer, enabled: false }).returning({ id: sodRules.id });
    expect(await requests(s)).toEqual(["evidence_changed"]);
    await drain(s);
    await db.update(sodRules).set({ enabled: true }).where(eq(sodRules.id, rule!.id));
    expect(await requests(s)).toEqual(["evidence_changed"]);
    await db.delete(sodRules).where(eq(sodRules.id, rule!.id));
    await drain(s);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, gone.id));
    expect(await requests(s)).toEqual(["evidence_changed"]);
    await drain(s);
    // a second write that does not change disabled-or-not marks nothing
    await db.update(users).set({ disabledAt: new Date(Date.now() - 1000) }).where(eq(users.id, gone.id));
    expect(await requests(s)).toEqual([]);
    await db.update(users).set({ disabledAt: null }).where(eq(users.id, gone.id));
    expect(await requests(s)).toEqual(["evidence_changed"]);
  });

  it("a skill's admission, a use case, a sub-agent link and a model binding each mark the agent whose score reads them", async () => {
    const model = await mkAgent("r339-reach");
    const parent = await mkBuilder("r339-parent", null);
    const child = await mkBuilder("r339-child", null);
    const sm: AgentRiskSubject = { kind: "agent", id: model };
    const sp: AgentRiskSubject = { kind: "builder_agent", id: parent };
    const sc: AgentRiskSubject = { kind: "builder_agent", id: child };
    await drain(sm, sp, sc);

    const [skill] = await db.insert(builderSkills).values({ name: `r339-skill-${RUN}`, ownerUserId: owner.id }).returning({ id: builderSkills.id });
    await db.insert(builderAgentSkills).values({ agentId: parent, skillId: skill!.id });
    await drain(sp);
    await db.update(builderSkills).set({ admissionState: "held" }).where(eq(builderSkills.id, skill!.id));
    expect(await requests(sp)).toEqual(["evidence_changed"]);
    await drain(sp);

    await db.insert(builderAgentSubagents).values({ parentId: parent, childId: child, name: "r339-child" });
    expect(await requests(sc)).toEqual(["access_changed"]);
    expect(await requests(sp)).toEqual(["modified"]);
    await drain(sp, sc);

    await db.update(builderAgents).set({ modelAgentId: model }).where(eq(builderAgents.id, child));
    expect(await requests(sm)).toEqual(["access_changed"]);
    await drain(sm, sc);

    const [uc] = await db
      .insert(aiUseCases)
      .values({ name: `r339-uc-${RUN}`, description: "r339", ownerUserId: owner.id, businessContext: "r339", dataSensitivity: "internal", intendedAgentIds: [model] })
      .returning({ id: aiUseCases.id });
    expect(await requests(sm)).toEqual(["access_changed"]);
    await db.delete(aiUseCases).where(eq(aiUseCases.id, uc!.id));
    await db.delete(builderSkills).where(eq(builderSkills.id, skill!.id));
  });

  it("the daily mark queues every agent 'scheduled', so time alone reaches the stored score", async () => {
    const id = await mkAgent("r339-daily");
    const s: AgentRiskSubject = { kind: "agent", id };
    await drain(s);
    const n = await markAllAgentRisk(db, "scheduled");
    expect(n).toBeGreaterThan(0);
    expect(await requests(s)).toEqual(["scheduled"]);
    await drain(s);
    const [a] = await assessments(s);
    expect(a!.triggers).toEqual(["scheduled"]);
    // the daily mark is not left behind for other suites' agents
    await db.delete(agentRiskRecomputeRequests).where(eq(agentRiskRecomputeRequests.trigger, "scheduled"));
  });
});

describe("ADR-0339 the latest pointer", () => {
  it("moves forward with every append and is what the ranked list reads", async () => {
    const id = await mkAgent("r339-latest");
    const s: AgentRiskSubject = { kind: "agent", id };
    await sweep(s);
    await db.update(agents).set({ ownerUserId: owner.id }).where(eq(agents.id, id));
    await sweep(s);
    const [newest] = await assessments(s);
    const [p] = await db.select().from(agentRiskLatest).where(eq(agentRiskLatest.agentId, id));
    expect(p!.assessmentId).toBe(newest!.id);
    let found: { id: string; score: number; assessmentId: string } | undefined;
    let cursor: string | null = null;
    do {
      const r: { statusCode: number; json: () => { items: Array<{ id: string; score: number; assessmentId: string }>; nextCursor: string | null } } = await app.inject({ method: "GET", headers: ADMIN, url: `/v1/agent-risk?limit=100${cursor ? `&cursor=${cursor}` : ""}` });
      expect(r.statusCode).toBe(200);
      found = r.json().items.find((i) => i.id === id);
      cursor = r.json().nextCursor;
    } while (!found && cursor);
    expect(found).toMatchObject({ score: newest!.score, assessmentId: newest!.id });
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
