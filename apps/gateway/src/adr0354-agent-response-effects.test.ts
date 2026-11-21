/**
 * ADR-0354 slice 2 — block_session and disable, end to end on the MCP tool path for a delegated (in-process) agent.
 *
 *   * block_session refuses the call AND ends the agent's session: the leaf delegation grant is revoked with reason
 *     `policy_response`, so the agent's very next call, even to an unrelated tool, is refused by the chain check;
 *   * disable does that AND suspends the agent's workload identity (narrowing only: active → suspended);
 *   * the narrowing-only rule holds: an identity that is already suspended is never moved, and a revoked one never
 *     touched;
 *   * a person's own call (no agent session) is refused as a plain deny and the "no session" outcome is audited;
 *   * the agent is told its session ended, as structured data.
 * Upstream: an address nothing listens on. Every call here is refused before the upstream is contacted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { abacPolicies, and, auditLog, createDb, delegationGrants, desc, eq, runMigrations, workloadIdentities, type Db } from "@regulait/db";
import type { AgentResponse, GovernedActor } from "@regulait/policy-kernel";
import { buildApp } from "./app.js";
import { actorForGrant, startInProcessChain, toolScopeItems } from "./in-process-delegation.js";
import { AGENT_RESPONSE_META_KEY, executeGovernedToolCall, mcpErrorForGovernanceOutcome } from "./mcp-proxy.js";
import { applyAgentResponseEffects, AGENT_RESPONSE_EFFECT_RULE_IDS } from "./agent-response-effects.js";
import { grantAgentOwnGrantsForTest } from "./testing/agent-own-grants.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `e35s2-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let serverId: string;
const restores: Array<() => Promise<void>> = [];
const policies: string[] = [];

const policySource = (tool: string) =>
  `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource) when { resource.toolName == "${tool}" };`;

async function mkUser(label: string): Promise<string> {
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `e35s2-${label}-${RUN}@example.test`, displayName: label } });
  expect(u.statusCode, u.body).toBe(201);
  return u.json().id as string;
}
async function mkAgent(label: string): Promise<string> {
  const r = await app.inject({
    method: "POST", url: "/v1/agents", headers: AUTH,
    payload: { name: `e35s2-${label}-${RUN}`, provider: "mock", tier: 0, modes: ["execute"], costPerMTokIn: 1, costPerMTokOut: 2, model: "mock-1" },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}
async function activePolicy(name: string, tool: string, mode: string): Promise<string> {
  const c = await app.inject({ method: "POST", url: "/v1/abac/policies", headers: AUTH, payload: { name: `${name}-${RUN}`, source: policySource(tool), mode } });
  expect(c.statusCode, c.body).toBe(201);
  const id = c.json().policy.id as string;
  policies.push(id);
  const a = await app.inject({ method: "POST", url: `/v1/abac/policies/${id}/activate`, headers: AUTH, payload: { version: 1 } });
  expect(a.statusCode, a.body).toBe(200);
  return id;
}

/** a person with both tools, an agent whose own grants cover both, and a live in-process chain for it */
async function delegatedSetup(label: string, tools: string[]) {
  const userId = await mkUser(label);
  for (const toolName of tools) {
    const g = await app.inject({ method: "POST", url: "/v1/grants/tools", headers: AUTH, payload: { userId, serverId, toolName } });
    expect(g.statusCode, g.body).toBe(201);
  }
  const agentId = await mkAgent(`${label}-agent`);
  const identityId = await grantAgentOwnGrantsForTest(db, agentId, { tools: tools.map((toolName) => ({ serverId, toolName })) });
  const scope = toolScopeItems(tools.map((toolName) => ({ serverId, toolName, kind: "write" as const })));
  const chain = await startInProcessChain(db, { sponsorUserId: userId, projectId: null, context: { runId: randomUUID() }, hops: [{ identityId, scope, capMicros: null }] });
  const call = (toolName: string) =>
    executeGovernedToolCall(db, undefined, { userId, serverId, toolName, arguments: {}, delegationGrantId: chain.leafGrantId });
  return { userId, identityId, chain, call };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  restores.push(await relaxStrictAdmissionForTest(db));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "s".repeat(64) });
  restores.push(await relaxGovernanceGatesForTest(db, { requirePreviewBeforeActivate: false, mrmEnforced: false, dispatchAttributionRequired: false }));
  const s = await app.inject({ method: "POST", url: "/v1/servers", headers: AUTH, payload: { name: `e35s2-server-${RUN}`, url: "http://127.0.0.1:9" } });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  for (const name of ["e35s2_exfil", "e35s2_other", "e35s2_wipe", "e35s2_person"]) {
    const t = await app.inject({ method: "POST", url: `/v1/servers/${serverId}/tools`, headers: AUTH, payload: { name, kind: "write" } });
    expect(t.statusCode, t.body).toBe(201);
  }
}, 120_000);

afterAll(async () => {
  for (const id of policies) await db.delete(abacPolicies).where(eq(abacPolicies.id, id));
  for (const restore of restores.reverse()) await restore();
  await app?.close();
});

describe("ADR-0354 slice 2: block_session ends the agent's session", () => {
  it("refuses the call, revokes the leaf grant (policy_response), and the agent's next call to another tool is refused", async () => {
    const policyId = await activePolicy("e35s2-block", "e35s2_exfil", "block_session");
    const { identityId, chain, call } = await delegatedSetup("block", ["e35s2_exfil", "e35s2_other"]);

    const out = await call("e35s2_exfil");
    expect(out.kind).toBe("denied");
    if (out.kind !== "denied") throw new Error("unreachable");
    expect(out.decision.ruleId).toBe(policyId);
    expect(out.decision.response).toMatchObject({ kind: "block_session", endSession: true, quarantineAgent: false });
    const err = mcpErrorForGovernanceOutcome(out);
    expect(err.message).toContain("This agent session has ended; do not retry.");
    expect((err as unknown as { data: Record<string, unknown> }).data[AGENT_RESPONSE_META_KEY]).toEqual({ response: "block_session", sessionEnded: true });

    const [grant] = await db.select().from(delegationGrants).where(eq(delegationGrants.id, chain.leafGrantId));
    expect(grant!.revokedAt).not.toBeNull();
    expect(grant!.revokedReason).toBe("policy_response");
    const [ident] = await db.select().from(workloadIdentities).where(eq(workloadIdentities.id, identityId));
    expect(ident!.status).toBe("active");

    // the session is over: an unrelated, otherwise allowed tool is refused at the chain check
    const next = await call("e35s2_other");
    expect(next.kind === "denied" && next.decision.ruleId).toBe("actor-chain-invalid");

    // the decision row records the response, and the session's end has its own audit row
    const [ended] = await db.select().from(auditLog)
      .where(and(eq(auditLog.objectId, chain.leafGrantId), eq(auditLog.ruleId, AGENT_RESPONSE_EFFECT_RULE_IDS.sessionEnded)))
      .orderBy(desc(auditLog.seq)).limit(1);
    expect(ended!.detail).toMatchObject({ response: "block_session", policyId, surface: "mcp_tool" });
  });
});

describe("ADR-0354 slice 2: disable quarantines the agent, narrowing only", () => {
  it("ends the session and suspends the workload identity", async () => {
    await activePolicy("e35s2-disable", "e35s2_wipe", "disable");
    const { identityId, chain, call } = await delegatedSetup("disable", ["e35s2_wipe"]);
    const out = await call("e35s2_wipe");
    expect(out.kind === "denied" && out.decision.response?.kind).toBe("disable");
    const [ident] = await db.select().from(workloadIdentities).where(eq(workloadIdentities.id, identityId));
    expect(ident!.status).toBe("suspended");
    const [grant] = await db.select().from(delegationGrants).where(eq(delegationGrants.id, chain.leafGrantId));
    expect(grant!.revokedReason).toBe("policy_response");
  });

  it("never moves an identity that is not active (no reinstating, no touching a revoked one)", async () => {
    const { identityId, chain } = await delegatedSetup("narrow", ["e35s2_other"]);
    const actor: GovernedActor = await actorForGrant(db, chain.leafGrantId, { costKnown: true });
    const disable: AgentResponse = { kind: "disable", effect: "deny", policyId: randomUUID(), guidance: null, endSession: true, quarantineAgent: true };
    await db.update(workloadIdentities).set({ status: "revoked" }).where(eq(workloadIdentities.id, identityId));
    const outcome = await applyAgentResponseEffects(db, { response: disable, actor, userId: actor.chain.sponsorUserId, surface: "mcp_tool" });
    expect(outcome.agentQuarantined).toBe(false);
    const [ident] = await db.select().from(workloadIdentities).where(eq(workloadIdentities.id, identityId));
    expect(ident!.status).toBe("revoked");
  });
});

describe("ADR-0354 slice 2: a person's own call has no agent session to end", () => {
  it("is refused as a plain deny with the no-session outcome audited", async () => {
    const policyId = await activePolicy("e35s2-person", "e35s2_person", "block_session");
    const userId = await mkUser("person");
    const g = await app.inject({ method: "POST", url: "/v1/grants/tools", headers: AUTH, payload: { userId, serverId, toolName: "e35s2_person" } });
    expect(g.statusCode, g.body).toBe(201);
    const out = await executeGovernedToolCall(db, undefined, { userId, serverId, toolName: "e35s2_person", arguments: {} });
    expect(out.kind === "denied" && out.decision.response?.kind).toBe("block_session");
    const [row] = await db.select().from(auditLog)
      .where(and(eq(auditLog.userId, userId), eq(auditLog.ruleId, AGENT_RESPONSE_EFFECT_RULE_IDS.noSession)))
      .orderBy(desc(auditLog.seq)).limit(1);
    expect(row!.detail).toMatchObject({ response: "block_session", policyId, sessionEnded: false });
  });
});
