/**
 * D4 review fix DFX2 (D4G-02, D4G-05) — the Art. 73(6) evidence hold reaches
 * EVERY agent-configuration write, through the real app on a real database.
 *
 * Red proofs (each fails with its hold line reverted):
 *  - D4G-02: with the hold binding registry agent A, every
 *    `/v1/config-versions/{agent_system_prompt|agent_config}/A` write that
 *    changes what A serves (create+activate, activate, rollback, canary,
 *    promote, abandon) is 409 `incident_evidence_hold` and nothing moves; a
 *    draft (no activate) is still allowed; an admin's override header lets
 *    one change through, audited on the incident.
 *  - D4G-05: with the hold binding builder agent B: sub-agents, skills,
 *    skill re-attach, autonomy, memory, name — each 409. The registry agent B
 *    runs on (its model) is held too (prompt, model/prices, config versions),
 *    a sub-agent of a held parent is held, and a library change that reaches
 *    B (removing a skill it pinned) is held.
 *
 * Global state (M-040/M-068): `minReleaseAgeDays` is relaxed through the
 * shared helper and restored in afterAll; the incidents this file opens are
 * deleted; every id is this run's own.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, aiIncidents, aiUseCases, and, auditLog, configVersions, desc, eq, inArray } from "@regulait/db";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { EVIDENCE_HOLD_OVERRIDE_HEADER } from "./incidents.js";

let k: BuilderKit;
let owner: Person;
let admin: Person;
let restore: (() => Promise<void>) | undefined;
const created = { incidents: [] as string[], useCases: [] as string[] };

const lastAudit = async (ruleId: string, objectId: string) =>
  (
    await k.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, ruleId), eq(auditLog.objectId, objectId)))
      .orderBy(desc(auditLog.seq))
      .limit(1)
  )[0];

/** a serious incident on a high-tier use case linking `agentIds`: its Art. 73 clock is pending, so the hold binds */
async function holdOn(...agentIds: string[]): Promise<{ id: string; ref: string }> {
  const [uc] = await k.db
    .insert(aiUseCases)
    .values({
      name: `dfx2 hold ${k.RUN} ${created.useCases.length}`,
      description: "synthetic D4 DFX2 fixture",
      ownerUserId: admin.id,
      businessContext: "synthetic",
      dataSensitivity: "internal",
      euAiActTier: "high",
      euAiActRulesetVersion: 1,
      euAiActReasons: [],
    })
    .returning({ id: aiUseCases.id });
  created.useCases.push(uc!.id);
  const r = await k.req("POST", "/v1/incidents", admin.auth, {
    title: `dfx2 incident ${k.RUN}`,
    severity: "high",
    detectionSource: "manual",
    useCaseId: uc!.id,
    serious: true,
    seriousCriteria: ["health"],
    links: agentIds.map((objectId) => ({ objectType: "agent", objectId })),
  });
  expect(r.statusCode, r.body).toBe(201);
  const inc = r.json().incident as { id: string; ref: string };
  created.incidents.push(inc.id);
  return inc;
}

const expectHeld = (r: { statusCode: number; body: string; json: () => any }, what: string) => {
  expect(r.statusCode, `${what}: ${r.body}`).toBe(409);
  expect(r.json().error, what).toBe("incident_evidence_hold");
};

beforeAll(async () => {
  k = await builderKit("dfx2-hold");
  restore = await relaxStrictAdmissionForTest(k.db, ["minReleaseAgeDays"]);
  owner = await k.person("owner");
  admin = await k.person("admin", { admin: true });
}, 120_000);

afterAll(async () => {
  await restore?.();
  if (created.incidents.length) await k.db.delete(aiIncidents).where(inArray(aiIncidents.id, created.incidents));
  if (created.useCases.length) await k.db.delete(aiUseCases).where(inArray(aiUseCases.id, created.useCases));
  await k.close();
});

describe("D4G-02: every agent write through /v1/config-versions is held", () => {
  it("create+activate, activate, rollback, canary, promote and abandon → 409; a draft is allowed; the admin override is audited", async () => {
    const a = await k.model("cv");
    const base = `/v1/config-versions/agent_system_prompt/${a}`;
    // before the incident: v1, v2 active (so a rollback exists), v3 a canary, v4 a draft
    for (const [i, activate] of [[1, true], [2, true], [3, false], [4, false]] as const) {
      const r = await k.req("POST", base, admin.auth, { body: { systemPrompt: `prompt v${i} ${k.RUN}` }, activate });
      expect(r.statusCode, r.body).toBe(201);
    }
    expect((await k.req("POST", `${base}/canary`, admin.auth, { version: 3, pct: 10 })).statusCode).toBe(200);
    const inc = await holdOn(a);

    expectHeld(await k.req("POST", base, admin.auth, { body: { systemPrompt: `during ${k.RUN}` }, activate: true }), "create+activate");
    expectHeld(await k.req("POST", `${base}/activate`, admin.auth, { version: 1 }), "activate");
    expectHeld(await k.req("POST", `${base}/rollback`, admin.auth, { reason: "roll back during the incident" }), "rollback");
    expectHeld(await k.req("POST", `${base}/canary`, admin.auth, { version: 4, pct: 20 }), "canary");
    expectHeld(await k.req("POST", `${base}/promote`, admin.auth, { override: true, reason: "promote during the incident" }), "promote");
    expectHeld(await k.req("DELETE", `${base}/canary`, admin.auth), "abandon canary");
    const cfg = `/v1/config-versions/agent_config/${a}`;
    expectHeld(await k.req("POST", cfg, admin.auth, { body: { model: "mock-premium" }, activate: true }), "agent_config create+activate");

    // nothing moved: v2 active, v3 the canary at 10%, the prompt read-model unchanged
    const rows = await k.db.select().from(configVersions).where(and(eq(configVersions.artifactType, "agent_system_prompt"), eq(configVersions.artifactId, a)));
    expect(rows.find((v) => v.status === "active")?.version).toBe(2);
    expect(rows.find((v) => v.status === "canary")).toMatchObject({ version: 3, canaryPct: 10 });
    const [row] = await k.db.select({ p: agents.systemPrompt, m: agents.model }).from(agents).where(eq(agents.id, a));
    expect(row).toEqual({ p: `prompt v2 ${k.RUN}`, m: "mock-balanced" });
    expect((await lastAudit("ai-incident-evidence-hold-refused", inc.id))?.detail).toMatchObject({ agentId: a });

    // a draft changes nothing that serves
    expect((await k.req("POST", base, admin.auth, { body: { systemPrompt: `draft ${k.RUN}` } })).statusCode).toBe(201);
    // the admin override lets one change through, audited on the incident
    const ok = await k.req("POST", `${base}/activate`, { ...admin.auth, [EVIDENCE_HOLD_OVERRIDE_HEADER]: "patient harm continues, revert now" }, { version: 1 });
    expect(ok.statusCode, ok.body).toBe(200);
    const over = await lastAudit("ai-incident-evidence-hold-overridden", inc.id);
    expect(over?.userId).toBe(admin.id);
    expect(over?.reason).toContain("activate version 1 of agent_system_prompt");
  });
});

describe("D4G-05: builder sub-agents, skills, re-attach, autonomy, memory, and the agents a change reaches", () => {
  it("every configuration write on a held builder agent → 409, and the registry agent it runs on is held too", async () => {
    const model = await k.model("bmodel");
    await k.grantModel(admin.id, model);
    const mk = async (name: string) => {
      const r = await k.req("POST", "/v1/builder/agents", admin.auth, { name: `${name} ${k.RUN}`, connectionFormat: "shared", computerUse: false, projectId: admin.projectId, modelAgentId: model });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().agent.id as string;
    };
    const b = await mk("held");
    const child = await mk("child");
    const s = await k.req("POST", "/v1/builder/skills", admin.auth, { name: `Cite ${k.RUN}`, description: "", body: "Always cite the section.", visibility: "private" });
    expect(s.statusCode, s.body).toBe(201);
    const skillId = s.json().skill.id as string;
    expect((await k.req("PUT", `/v1/builder/agents/${b}/skills`, admin.auth, { skillIds: [skillId] })).statusCode).toBe(200);
    // a newer library version, so a re-attach would move B to new prompt text
    expect((await k.req("PATCH", `/v1/builder/skills/${skillId}`, admin.auth, { body: "Always cite the section and the page." })).statusCode).toBe(200);
    const inc = await holdOn(b);

    expectHeld(await k.req("PUT", `/v1/builder/agents/${b}/subagents`, admin.auth, { subagents: [{ childId: child, name: "Helper", description: "helps" }] }), "sub-agents");
    expectHeld(await k.req("PUT", `/v1/builder/agents/${b}/skills`, admin.auth, { skillIds: [] }), "skills");
    expectHeld(await k.req("POST", `/v1/builder/agents/${b}/skills/${skillId}/reattach`, admin.auth), "skill re-attach");
    expectHeld(await k.req("PUT", `/v1/builder/agents/${b}/autonomy`, admin.auth, { class: "supervised", note: "raised during the incident" }), "autonomy");
    expectHeld(await k.req("POST", `/v1/builder/agents/${b}/memory`, admin.auth, { content: "remember this" }), "memory");
    expectHeld(await k.req("PATCH", `/v1/builder/agents/${b}`, admin.auth, { name: `renamed ${k.RUN}` }), "name");
    // a library change that reaches the held agent
    expectHeld(await k.req("DELETE", `/v1/builder/skills/${skillId}`, admin.auth), "removing a pinned skill");
    // the model behind the builder agent
    expectHeld(await k.req("POST", `/v1/agents/${model}/system-prompt`, admin.auth, { systemPrompt: `model edit ${k.RUN}` }), "model's prompt");
    expectHeld(await k.req("PATCH", `/v1/agents/${model}`, admin.auth, { model: "mock-premium" }), "model's model");
    expectHeld(await k.req("POST", `/v1/config-versions/agent_system_prompt/${model}`, admin.auth, { body: { systemPrompt: "x" }, activate: true }), "model's config version");
    const refused = await lastAudit("ai-incident-evidence-hold-refused", inc.id);
    expect(refused?.reason).toContain(`which agent ${b} is built on`);

    // nothing moved
    const [m] = await k.db.select({ p: agents.systemPrompt, model: agents.model }).from(agents).where(eq(agents.id, model));
    expect(m).toEqual({ p: null, model: "mock-balanced" });
    const detail = (await k.req("GET", `/v1/builder/agents/${b}`, admin.auth)).json().agent;
    expect(detail.name).toBe(`held ${k.RUN}`);
    expect(detail.skills.map((x: { id: string }) => x.id)).toEqual([skillId]);
    expect(detail.subagents).toEqual([]);

    // a change outside the configuration under investigation still works (its spending limit)
    expect((await k.req("PATCH", `/v1/builder/agents/${b}`, admin.auth, { monthlyLimitUsd: 25 })).statusCode).toBe(200);
    // and the admin override lets one change through, audited
    const ok = await k.req("PUT", `/v1/builder/agents/${b}/subagents`, { ...admin.auth, [EVIDENCE_HOLD_OVERRIDE_HEADER]: "split the work to contain the harm" }, { subagents: [{ childId: child, name: "Helper", description: "helps" }] });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await lastAudit("ai-incident-evidence-hold-overridden", inc.id))?.reason).toContain("sub-agents");
  });

  it("a sub-agent of a held parent is held; archiving it is held (it leaves the parent); archiving the held agent itself is containment", async () => {
    const model = await k.model("pmodel");
    await k.grantModel(admin.id, model);
    const mk = async (name: string) =>
      (await k.req("POST", "/v1/builder/agents", admin.auth, { name: `${name} ${k.RUN}`, connectionFormat: "shared", computerUse: false, projectId: admin.projectId, modelAgentId: model })).json().agent.id as string;
    const parent = await mk("parent");
    const child = await mk("sub");
    expect((await k.req("PUT", `/v1/builder/agents/${parent}/subagents`, admin.auth, { subagents: [{ childId: child, name: "Sub", description: "sub" }] })).statusCode).toBe(200);
    await holdOn(parent);
    expectHeld(await k.req("PATCH", `/v1/builder/agents/${child}`, admin.auth, { instructions: "new behaviour" }), "child instructions");
    expectHeld(await k.req("DELETE", `/v1/builder/agents/${child}`, admin.auth), "archive the child");
    expect((await k.req("DELETE", `/v1/builder/agents/${parent}`, admin.auth)).statusCode).toBe(204);
  });

  it("a non-admin owner's override is refused 403 on a builder route", async () => {
    const model = await k.model("omodel");
    await k.grantModel(owner.id, model);
    const r = await k.req("POST", "/v1/builder/agents", owner.auth, { name: `mine ${k.RUN}`, connectionFormat: "shared", computerUse: false, projectId: owner.projectId, modelAgentId: model });
    expect(r.statusCode, r.body).toBe(201);
    const b = r.json().agent.id as string;
    await holdOn(b);
    expectHeld(await k.req("POST", `/v1/builder/agents/${b}/memory`, owner.auth, { content: "x" }), "owner memory");
    const over = await k.req("POST", `/v1/builder/agents/${b}/memory`, { ...owner.auth, [EVIDENCE_HOLD_OVERRIDE_HEADER]: "I really need to change it now" }, { content: "x" });
    expect(over.statusCode).toBe(403);
    expect(over.json().error).toBe("evidence_hold_override_admin_only");
  });
});
