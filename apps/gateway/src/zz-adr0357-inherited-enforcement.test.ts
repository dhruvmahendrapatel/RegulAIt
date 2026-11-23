/**
 * ADR-0357 §4 enforcement (owner decision D-2026-11-23-02, lane L1): the ADR-0251 governed decision core applies the
 * effective inherited policy (org → business unit → project) on every governed call, on a real database.
 *
 *  - each call type: a model dispatch through the real invoke route (a NON-admin caller, whose own scope cannot read
 *    the admin-only policy tables, so this also proves the read is not silently empty), a connector call and an A2A
 *    call through the core, an MCP tool call through `governedEvaluate`;
 *  - precedence: deny wins over an entitlement, a hold and a grant; a child level only narrows (the project's
 *    allow-list governs inside it, the org's outside it); the deny-list unites;
 *  - the audit trail names the level that supplied the rule, on a refusal and on an allow;
 *  - fail closed: an unresolvable policy (an unknown project) refuses every call type, and a read whose RLS reason
 *    cannot take effect (the handle is already inside a transaction) throws rather than reading "no policy".
 *
 * Runs on its OWN scratch database: policy layers are global configuration and must not reach other suites.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, and, auditLog, businessUnits, desc, eq, governancePolicyLayers, mcpServers, mcpTools, projects, toolGrants, type Db } from "@regulait/db";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { governedEvaluateResource } from "./governed-core.js";
import { governedEvaluate } from "./governed-evaluate.js";
import { InheritedPolicyUnavailable, resolveInheritedPolicy } from "./governance-policy.js";

let k: BuilderKit;
let restoreGates: () => Promise<void> = async () => {};
let caller: Person;
let MODEL = "";
let MODEL_NAME = "";
let buId = "";
let serverId = "";
let serverName = "";
const allow = { effect: "allow" as const, ruleId: "g", reason: "granted", ruleChain: [] };

async function layer(level: "org" | "business_unit" | "project", policy: Record<string, unknown>): Promise<void> {
  await k.db.insert(governancePolicyLayers).values({
    level,
    ...(level === "business_unit" ? { businessUnitId: buId } : level === "project" ? { projectId: caller.projectId } : {}),
    policy,
  });
}
const lastDecision = async (ruleId: string) =>
  (await k.db.select().from(auditLog).where(and(eq(auditLog.userId, caller.id), eq(auditLog.ruleId, ruleId))).orderBy(desc(auditLog.seq)).limit(1))[0];
const core = (resource: Parameters<typeof governedEvaluateResource>[1]["resource"], projectId: string | null = caller.projectId) =>
  governedEvaluateResource(k.db, { userId: caller.id, resource, projectId, base: allow, canQueue: true });
const mcp = (toolName: string, projectId: string | null = caller.projectId) =>
  governedEvaluate(k.db, caller.id, serverId, { serverId, name: toolName, kind: "write" }, undefined, null, projectId, undefined, undefined, undefined, undefined, { actor: null }).then((r) => r.decision);
const invoke = () => k.req("POST", `/v1/agents/${MODEL}/invoke`, caller.auth, { mode: "chat", input: "inheritance probe", dispatch: true, projectId: caller.projectId });

beforeAll(async () => {
  k = await builderKit("adr0357-enf", { scratch: true });
  restoreGates = await relaxGovernanceGatesForTest(k.db, { mrmEnforced: false });
  caller = await k.person("caller");
  MODEL = await k.model("enf", { price: 1 });
  MODEL_NAME = (await k.db.select({ name: agents.name }).from(agents).where(eq(agents.id, MODEL)))[0]!.name;
  await k.grantModel(caller.id, MODEL);
  const [bu] = await k.db.insert(businessUnits).values({ name: `enf-bu-${k.RUN}` }).returning({ id: businessUnits.id });
  buId = bu!.id;
  await k.db.update(projects).set({ businessUnitId: buId }).where(eq(projects.id, caller.projectId));
  serverName = `enf-server-${k.RUN}`;
  // the registry rows directly: the call is only decided here, never sent, so no egress check applies
  const [s] = await k.db.insert(mcpServers).values({ name: serverName, url: "https://mcp.example.com/enf" }).returning({ id: mcpServers.id });
  serverId = s!.id;
  for (const name of ["create_issue", "delete_repo"]) {
    await k.db.insert(mcpTools).values({ serverId, name, kind: "write" });
    await k.db.insert(toolGrants).values({ userId: caller.id, serverId, toolName: name });
  }
}, 120_000);

afterEach(async () => {
  await k.db.delete(governancePolicyLayers);
});

afterAll(async () => {
  await restoreGates();
  await k.close();
});

describe("ADR-0357 §4 enforcement: each governed call type applies the inherited policy", () => {
  it("model: an org allow-list without the agent refuses a non-admin's dispatch (403), audited with the level", async () => {
    expect((await invoke()).statusCode).toBe(200);
    await layer("org", { allowedAgents: ["some-other-agent"] });
    const r = await invoke();
    expect(r.statusCode, r.body).toBe(403);
    const row = await lastDecision("inherited-policy");
    expect(row).toBeDefined();
    expect(row!.ruleChain).toContainEqual({ rule: "inherited-policy", outcome: "deny", grantId: "allowedAgents@org" });
    // the agent on the list runs, and the applied rule is traced on the allow
    await k.db.delete(governancePolicyLayers);
    await layer("org", { allowedAgents: [MODEL_NAME] });
    expect((await invoke()).statusCode).toBe(200);
  });

  it("connector: the business unit's allow-list governs its projects, naming the unit", async () => {
    await layer("business_unit", { allowedConnectors: ["crm"] });
    const refused = await core({ type: "connector", id: randomUUID(), name: "billing", operation: "read" });
    expect(refused).toMatchObject({ effect: "deny", ruleId: "inherited-policy" });
    expect(refused.ruleChain).toContainEqual({ rule: "inherited-policy", outcome: "deny", grantId: `allowedConnectors@business_unit:${buId}` });
    const ok = await core({ type: "connector", id: randomUUID(), name: "crm", operation: "read" });
    expect(ok.effect).toBe("allow");
    expect(ok.ruleChain).toContainEqual({ rule: "inherited-policy", outcome: "allow", grantId: `allowedConnectors@business_unit:${buId}` });
  });

  it("A2A: resolved like every call (no inherited rule names remote agents yet), so the call is decided as before", async () => {
    await layer("org", { allowedAgents: ["x"], allowedConnectors: ["y"] });
    const d = await core({ type: "a2a", id: randomUUID(), name: "remote", skillId: null });
    expect(d.effect).toBe("allow");
    expect(d.ruleChain.some((t) => t.rule === "inherited-policy")).toBe(false);
  });

  it("MCP: allowedMcpServers and deniedTools refuse a granted tool call, naming the level", async () => {
    expect((await mcp("create_issue")).effect).toBe("allow");
    await layer("org", { allowedMcpServers: ["another-server"] });
    expect(await mcp("create_issue")).toMatchObject({ effect: "deny", ruleId: "inherited-policy" });
    await k.db.delete(governancePolicyLayers);
    await layer("project", { deniedTools: [`${serverName}/delete_repo`] });
    const denied = await mcp("delete_repo");
    expect(denied).toMatchObject({ effect: "deny", ruleId: "inherited-policy" });
    expect(denied.ruleChain.at(-1)).toEqual({ rule: "inherited-policy", outcome: "deny", grantId: `deniedTools@project:${caller.projectId}` });
    const other = await mcp("create_issue");
    expect(other.effect).toBe("allow");
    expect(other.ruleChain).toContainEqual({ rule: "inherited-policy", outcome: "allow", grantId: `deniedTools@project:${caller.projectId}` });
  });
});

describe("ADR-0357 §4 enforcement: precedence", () => {
  it("a child only narrows: the project's narrower list governs inside it, the org's outside it", async () => {
    await layer("org", { allowedConnectors: ["crm", "billing"] });
    await layer("project", { allowedConnectors: ["crm"] });
    const inside = await core({ type: "connector", id: randomUUID(), name: "billing", operation: "read" });
    expect(inside).toMatchObject({ effect: "deny", ruleId: "inherited-policy" });
    expect(inside.ruleChain).toContainEqual({ rule: "inherited-policy", outcome: "deny", grantId: `allowedConnectors@project:${caller.projectId}` });
    // an unattributed call is placed at the org, whose list allows it
    const outside = await core({ type: "connector", id: randomUUID(), name: "billing", operation: "read" }, null);
    expect(outside.ruleChain).toContainEqual({ rule: "inherited-policy", outcome: "allow", grantId: "allowedConnectors@org" });
  });

  it("deny wins: a deny-list entry at the org refuses a tool the project leaves alone, and a hold never survives it", async () => {
    await layer("org", { deniedTools: [`${serverName}/delete_repo`] });
    await layer("project", { deniedTools: [] });
    expect(await mcp("delete_repo")).toMatchObject({ effect: "deny", ruleId: "inherited-policy" });
    await layer("business_unit", { allowedConnectors: ["crm"] });
    const held = await governedEvaluateResource(k.db, {
      userId: caller.id,
      resource: { type: "connector", id: randomUUID(), name: "billing", operation: "write" },
      projectId: caller.projectId,
      base: { effect: "require_approval", ruleId: "execution-require-approval", reason: "held", approverUserId: caller.id, ruleChain: [] },
      canQueue: true,
    });
    expect(held).toMatchObject({ effect: "deny", ruleId: "inherited-policy" });
  });
});

describe("ADR-0357 §4 enforcement: fail closed", () => {
  it("an unresolvable policy (an unknown project) refuses model, connector and A2A calls, and MCP evaluation throws", async () => {
    const ghost = randomUUID();
    for (const resource of [
      { type: "model" as const, id: MODEL, name: MODEL_NAME, mode: "chat" },
      { type: "connector" as const, id: randomUUID(), name: "crm", operation: "read" as const },
      { type: "a2a" as const, id: randomUUID(), name: "remote", skillId: null },
    ]) {
      expect(await core(resource, ghost), resource.type).toMatchObject({ effect: "deny", ruleId: "governed-core-error" });
    }
    await expect(mcp("create_issue", ghost)).rejects.toThrow();
  });

  it("a read whose RLS reason cannot take effect throws instead of reading 'no policy'", async () => {
    await layer("org", { allowedConnectors: ["crm"] });
    await expect(k.db.transaction(async (tx) => resolveInheritedPolicy(tx as unknown as Db, { projectId: caller.projectId }))).rejects.toBeInstanceOf(InheritedPolicyUnavailable);
    // on the pool it reads the layer
    const p = await resolveInheritedPolicy(k.db, { projectId: caller.projectId });
    expect(p.rules.find((r) => r.rule === "allowedConnectors")).toMatchObject({ value: ["crm"], setBy: { level: "org", subjectId: null } });
  });
});
