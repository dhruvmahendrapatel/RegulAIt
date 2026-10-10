/**
 * ADR-0188 S2 — the gateway's Cedar wiring per principal (decision 18), through the real enforcement entry point
 * (`governedEvaluate`) on a real database, plus the actor-entitlement loader (decision 24) and the workload
 * principal bag.
 *
 * The `GovernedActor` here is built by hand, as S3/S4 will build it from the stored grant path; S2 owns only what
 * the kernel and Cedar do with it. ABAC policies are GLOBAL state, so every policy this file creates is deleted in
 * `afterAll` (by id — never the whole table).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { abacPolicies, createDb, inArray, runMigrations, sql, type Db } from "@regulait/db";
import type { ActorLinkFacts, GovernedActor } from "@regulait/policy-kernel";
import { buildApp } from "./app.js";
import { governedEvaluate } from "./governed-evaluate.js";
import { abacPrincipalFromRequest } from "./abac-principal.js";
import { assembleAbacRequest, assembleActorAbacRequest, evaluateAbacForChain, loadActiveAbacPolicies } from "./abac.js";
import { loadActorEntitlements } from "./actor-entitlements.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `s2-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const T = { plain: `s2_plain_${RUN}`, legacy: `s2_legacy_${RUN}`, deep: `s2_deep_${RUN}`, agentOnly: `s2_agent_${RUN}` };
const SPIFFE = (s: string) => `spiffe://example.org/regulait/s2/${s}-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let serverId: string;
let agentRowId: string;
let identityA: string;
let identityB: string;
const policyIds: string[] = [];
let restoreGates: () => Promise<void> = async () => {};
let restoreAdmission: (() => Promise<void>) | undefined;

const rows = <R>(r: unknown) => (r as { rows: R[] }).rows;
const inject = (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: AUTH, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function activePolicy(name: string, source: string, schemaVersion?: string): Promise<string> {
  const created = await inject("POST", "/v1/abac/policies", { name: `${name}-${RUN}`, source, ...(schemaVersion ? { schemaVersion } : {}) });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().policy.id as string;
  policyIds.push(id);
  const act = await inject("POST", `/v1/abac/policies/${id}/activate`, { version: 1 });
  expect(act.statusCode, act.body).toBe(200);
  return id;
}

const link = (identityId: string, over: Partial<ActorLinkFacts> = {}): ActorLinkFacts => ({
  identityId,
  grantId: randomUUID(),
  live: true,
  scope: Object.values(T).map((toolName) => ({ type: "mcp_tool" as const, serverId, toolNames: [toolName], kind: "write" as const })),
  budget: null,
  entitlements: { tools: Object.values(T).map((toolName) => ({ serverId, toolName })), servers: [], agents: [], connectors: [] },
  ...over,
});
function chainOf(links: ActorLinkFacts[]): GovernedActor {
  return {
    chain: {
      sponsorUserId: userId,
      delegationGrantId: links[links.length - 1]!.grantId,
      depth: links.length,
      actors: links.map((l, i) => ({ identityId: l.identityId, kind: "agent" as const, identifier: SPIFFE(`hop${i}`) })),
    },
    entitlementMode: "own_grants",
    maxDepth: 3,
    costKnown: true,
    links,
  };
}
const decide = (toolName: string, actor: GovernedActor | null) =>
  governedEvaluate(db, userId, serverId, { serverId, name: toolName, kind: "write" }, undefined, null, null, undefined, undefined, undefined, undefined, { actor }).then(
    (r) => r.decision,
  );

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT });
  restoreGates = await relaxGovernanceGatesForTest(db, { requirePreviewBeforeActivate: false });
  const u = await inject("POST", "/v1/users", { email: `s2-sponsor-${RUN}@example.com`, displayName: `s2 sponsor ${RUN}` });
  expect(u.statusCode, u.body).toBe(201);
  userId = u.json().id;
  const s = await inject("POST", "/v1/servers", { name: `s2-server-${RUN}`, url: "http://127.0.0.1:9" });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  for (const name of Object.values(T)) {
    expect((await inject("POST", `/v1/servers/${serverId}/tools`, { name, kind: "write" })).statusCode).toBe(201);
    expect((await inject("POST", "/v1/grants/tools", { userId, serverId, toolName: name })).statusCode).toBe(201);
  }
  agentRowId = rows<{ id: string }>(
    await db.execute(sql`insert into agents (name, provider, tier) values (${`s2-agent-${RUN}`}, 'mock', 1) returning id`),
  )[0]!.id;
  identityA = rows<{ id: string }>(
    await db.execute(sql`insert into workload_identities (kind, agent_id, identifier, sponsor_user_ids, environments)
      values ('agent', ${agentRowId}, ${SPIFFE("a")}, ARRAY[${userId}]::uuid[], ARRAY['staging']) returning id`),
  )[0]!.id;
  identityB = rows<{ id: string }>(
    await db.execute(sql`insert into workload_identities (kind, identifier, sponsor_user_ids, environments)
      values ('worker_runtime', ${SPIFFE("b")}, ARRAY[${userId}]::uuid[], ARRAY['production']) returning id`),
  )[0]!.id;
}, 120_000);

afterAll(async () => {
  if (policyIds.length) await db.delete(abacPolicies).where(inArray(abacPolicies.id, policyIds));
  await restoreGates();
  await restoreAdmission?.();
  await app?.close();
});

describe("ADR-0188 S2 — per-principal Cedar through governedEvaluate", () => {
  it("with no ABAC policy, an agent's call is decided by grants alone and no Cedar runs for the actor", async () => {
    const a = chainOf([link(identityA)]);
    const d = await decide(T.plain, a);
    expect(d.effect).toBe("allow");
    expect(d.ruleChain.some((t) => t.rule === "abac-forbid")).toBe(false);
    // lazy: the chain comes back untouched (same object) when no v4 policy is active
    const base = await assembleAbacRequest(db, { userId, serverId, toolName: T.plain, toolKind: "write" });
    expect(await evaluateAbacForChain(db, a, base, [])).toBe(a);
  });

  it("new policies default to schema v4; an unscoped person-attribute policy is refused with the v4 help text", async () => {
    const r = await inject("POST", "/v1/abac/policies", {
      name: `s2-bad-${RUN}`,
      source: `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource) unless { principal.isAdmin };`,
    });
    expect(r.statusCode).toBe(422);
    expect(r.body).toContain("principal is RegulAIt::User");
    const id = await activePolicy(
      "s2-agents-not-prod",
      `forbid (principal is RegulAIt::Agent, action == RegulAIt::Action::"McpToolCall", resource)
       when { resource.toolName == "${T.agentOnly}" && !principal.environments.contains("production") };`,
    );
    const [row] = await loadActiveAbacPolicies(db).then((ps) => ps.filter((p) => p.id === id));
    expect(row!.schemaVersion).toBe("v4");
  });

  it("an Agent policy refuses the agent's call and never the person's own", async () => {
    const id = policyIds[0]!;
    expect((await decide(T.agentOnly, null)).effect).toBe("allow");
    const d = await decide(T.agentOnly, chainOf([link(identityA)]));
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe(id);
    // identity B's environments include production: the same policy lets it through
    expect((await decide(T.agentOnly, chainOf([link(identityB)]))).effect).toBe("allow");
    // in a two-hop chain the ROOT (A) is still evaluated as Agent, so the call is refused
    expect((await decide(T.agentOnly, chainOf([link(identityA), link(identityB)]))).ruleId).toBe(id);
  });

  it("a legacy v1–v3 forbid still binds the sponsor of an agent call, and is never run for the agent", async () => {
    const id = await activePolicy(
      "s2-legacy",
      `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource) when { resource.toolName == "${T.legacy}" };`,
      "v3",
    );
    const a = chainOf([link(identityA)]);
    const d = await decide(T.legacy, a);
    expect(d.ruleId).toBe(id);
    // the refusal is the SPONSOR's ABAC term (before any actor term), not an actor's
    expect(d.ruleChain.filter((t) => t.rule === "abac-forbid")).toHaveLength(1);
    expect(d.ruleChain.some((t) => t.rule === "actor-allow-list")).toBe(false);
    const base = await assembleAbacRequest(db, { userId, serverId, toolName: T.legacy, toolKind: "write" });
    const evaluated = await evaluateAbacForChain(db, a, base, await loadActiveAbacPolicies(db));
    expect(evaluated.links[0]!.abacDecision ?? null).toBeNull();
  });

  it("context.delegationDepth: one hop passes, two hops are refused — the person alone is depth 0", async () => {
    const id = await activePolicy(
      "s2-deep",
      `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource)
       when { resource.toolName == "${T.deep}" && context.delegationDepth > 1 };`,
    );
    expect((await decide(T.deep, null)).effect).toBe("allow");
    expect((await decide(T.deep, chainOf([link(identityB)]))).effect).toBe("allow");
    const d = await decide(T.deep, chainOf([link(identityB), link(identityA)]));
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe(id);
  });

  it("an actor identity that cannot be found fails THIS call closed with abac-engine-error, and only it", async () => {
    const ghost = chainOf([link(randomUUID())]);
    const d = await decide(T.plain, ghost);
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("abac-engine-error");
    expect((await decide(T.plain, chainOf([link(identityB)]))).effect).toBe("allow");
    expect((await decide(T.plain, null)).effect).toBe("allow");
  });

  it("the Agent bag holds only the agent's own attributes — nothing of the sponsor", async () => {
    const base = await assembleAbacRequest(db, {
      userId,
      serverId,
      toolName: T.plain,
      toolKind: "write",
      principal: { sessionOrigin: "password", mfaCompleted: true },
    });
    const req = await assembleActorAbacRequest(db, identityA, base);
    expect(Object.keys(req!.agent!).sort()).toEqual(["autonomyClass", "environments", "id", "identifier", "kind", "stewards"]);
    expect(req!.agent).toMatchObject({ id: identityA, kind: "agent", identifier: SPIFFE("a"), environments: ["staging"], stewards: [userId] });
    expect(req!.agent!.autonomyClass ?? null).toBeNull();
    expect(await assembleActorAbacRequest(db, randomUUID(), base)).toBeNull();
  });
});

describe("ADR-0188 S2 — the workload principal bag", () => {
  it("a workload credential reports unknown origin and no second factor, whatever session facts ride along", () => {
    expect(
      abacPrincipalFromRequest({ authCtx: { via: "workload" }, sessionAuth: { origin: "password", totpEnabled: true }, ip: "203.0.113.7" }),
    ).toEqual({ sessionOrigin: "unknown", mfaCompleted: false, clientIp: "203.0.113.7" });
  });
});

describe("ADR-0188 S2 — loadActorEntitlements (decision 24, strict per decision 27)", () => {
  it("reads direct grants and role grants; a role's NULL modes or objects give an agent nothing", async () => {
    const connectorId = rows<{ id: string }>(
      await db.execute(sql`insert into connectors (name, kind) values (${`s2-conn-${RUN}`}, 'crm') returning id`),
    )[0]!.id;
    const roleId = rows<{ id: string }>(await db.execute(sql`insert into roles (name) values (${`s2-role-${RUN}`}) returning id`))[0]!.id;
    await db.execute(sql`insert into identity_tool_grants (identity_id, server_id, tool_name) values (${identityA}, ${serverId}, ${T.plain})`);
    await db.execute(sql`insert into identity_agent_grants (identity_id, agent_id, allowed_modes) values (${identityA}, ${agentRowId}, '["plan"]'::jsonb)`);
    await db.execute(sql`insert into identity_role_assignments (identity_id, role_id) values (${identityA}, ${roleId})`);
    await db.execute(sql`insert into role_tool_grants (role_id, server_id, tool_name) values (${roleId}, ${serverId}, ${T.deep})`);
    await db.execute(sql`insert into role_server_grants (role_id, server_id, read_only_all) values (${roleId}, ${serverId}, true)`);
    await db.execute(sql`insert into role_agent_grants (role_id, agent_id, allowed_modes) values (${roleId}, ${agentRowId}, null)`);
    await db.execute(sql`insert into role_connector_grants (role_id, connector_id, mode, allowed_objects) values (${roleId}, ${connectorId}, 'readwrite', null)`);
    const ghost = randomUUID();
    const got = await loadActorEntitlements(db, [identityA, identityB, ghost]);
    const a = got.get(identityA)!;
    expect(a.tools).toEqual(expect.arrayContaining([{ serverId, toolName: T.plain }, { serverId, toolName: T.deep }]));
    expect(a.tools).toHaveLength(2);
    expect(a.servers).toEqual([{ serverId, readOnlyAll: true }]);
    // the direct grant's explicit list stands; the role's NULL ("every mode") adds nothing
    expect(a.agents).toEqual([{ agentId: agentRowId, allowedModes: ["plan"] }]);
    // the role's NULL ("every object") connector grant adds nothing
    expect(a.connectors).toEqual([]);
    expect(got.get(identityB)).toEqual({ tools: [], servers: [], agents: [], connectors: [] });
    expect(got.get(ghost)).toEqual({ tools: [], servers: [], agents: [], connectors: [] });
    // clean up the identity's grants so later files see a fresh identity (identities themselves are never deleted)
    await db.execute(sql`delete from identity_role_assignments where identity_id = ${identityA}`);
    await db.execute(sql`delete from identity_tool_grants where identity_id = ${identityA}`);
    await db.execute(sql`delete from identity_agent_grants where identity_id = ${identityA}`);
    await db.execute(sql`delete from roles where id = ${roleId}`);
  });
});
