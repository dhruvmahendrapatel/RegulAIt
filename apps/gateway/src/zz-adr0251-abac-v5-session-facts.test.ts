/**
 * ADR-0251 slice 4b — the governed core's ABAC v5 request carries the request's session facts and the delegation
 * chain (P-01c item 2):
 *
 *  - `principal.sessionOrigin`, `principal.mfaCompleted` and `context.clientIp` come from the route
 *    (`abacPrincipalFromRequest`), and each reads as its STRICT value when absent (origin "unknown", no second
 *    factor, no address), so a forbid conditioned on a missing fact fires (fail closed);
 *  - `context.actorChain` / `context.delegationDepth` come from the stored chain, and each actor is evaluated as
 *    `Agent` (ADR-0188 decision 18), so an agent-scoped forbid refuses a delegated call and not the person's own;
 *  - the real invoke route supplies the facts (an API-key call reads as `api_key`);
 *  - a delegation grant that cannot be read refuses the model gate (error is deny).
 *
 * Runs on its OWN scratch database: active ABAC policies are global, and must not reach other suites.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { abacPolicies, abacPolicyVersions, eq, sql } from "@regulait/db";
import type { ActorLinkFacts, GovernedActor } from "@regulait/policy-kernel";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { governedModelGate, loadResourceRestrictions, type GovernedRequestFacts } from "./governed-core.js";
import { assembleGovernedAbacRequest } from "./abac.js";

let k: BuilderKit;
let restoreGates: () => Promise<void> = async () => {};
let caller: Person;
let MODEL = "";
let identityA = "";
let identityB = "";
const RUN = Math.random().toString(36).slice(2, 8);
const SPIFFE = (s: string) => `spiffe://example.org/regulait/s4b/${s}-${RUN}`;

async function activePolicy(source: string): Promise<string> {
  const [policy] = await k.db.insert(abacPolicies).values({ name: `adr0251-s4b-${Math.random().toString(36).slice(2, 8)}`, enabled: true }).returning({ id: abacPolicies.id });
  const [version] = await k.db.insert(abacPolicyVersions).values({ policyId: policy!.id, version: 1, source, schemaVersion: "v5", mode: "forbid" }).returning({ id: abacPolicyVersions.id });
  await k.db.update(abacPolicies).set({ activeVersionId: version!.id }).where(eq(abacPolicies.id, policy!.id));
  return policy!.id;
}
const dropPolicy = (id: string) => k.db.update(abacPolicies).set({ enabled: false, activeVersionId: null }).where(eq(abacPolicies.id, id));
async function withPolicy(source: string, body: () => Promise<void>): Promise<void> {
  const id = await activePolicy(source);
  try {
    await body();
  } finally {
    await dropPolicy(id);
  }
}

/** the core's ABAC verdict for a model call by `caller`, with the given request facts */
const verdict = async (facts?: GovernedRequestFacts) =>
  (await loadResourceRestrictions(k.db, { userId: caller.id, resource: { type: "model", id: MODEL, name: "m", mode: "chat" }, projectId: caller.projectId, ...(facts ? { facts } : {}) }))
    .abacDecision;

const link = (identityId: string): ActorLinkFacts => ({
  identityId,
  grantId: randomUUID(),
  live: true,
  scope: [{ type: "agent", agentId: MODEL, modes: ["chat"], kind: "read" }],
  budget: null,
  entitlements: { tools: [], servers: [], agents: [], connectors: [] },
});
function chainOf(...identityIds: string[]): GovernedActor {
  const links = identityIds.map(link);
  return {
    chain: {
      sponsorUserId: caller.id,
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

beforeAll(async () => {
  k = await builderKit("adr0251-s4b", { scratch: true });
  restoreGates = await relaxGovernanceGatesForTest(k.db, { mrmEnforced: false });
  caller = await k.person("caller");
  MODEL = await k.model("s4b", { price: 1 });
  await k.grantModel(caller.id, MODEL);
  const rows = (r: unknown) => (r as { rows: { id: string }[] }).rows;
  // one workload identity per agent row (workload_identities_agent_uq)
  const identity = async (label: string, env: string) => {
    const agentId = rows(await k.db.execute(sql`insert into agents (name, provider, tier) values (${`s4b-${label}-${RUN}`}, 'mock', 1) returning id`))[0]!.id;
    return rows(
      await k.db.execute(sql`insert into workload_identities (kind, agent_id, identifier, sponsor_user_ids, environments)
        values ('agent', ${agentId}, ${SPIFFE(label)}, ARRAY[${caller.id}]::uuid[], ARRAY[${env}]) returning id`),
    )[0]!.id;
  };
  identityA = await identity("a", "staging");
  identityB = await identity("b", "production");
}, 120_000);

afterAll(async () => {
  await restoreGates();
  await k.close();
});

describe("ADR-0251 slice 4b: session facts reach the governed core's ABAC v5 request", () => {
  it("assembles the route's facts, and the strict values when none are given", async () => {
    const target = { type: "model" as const, id: MODEL, mode: "chat" };
    const supplied = await assembleGovernedAbacRequest(k.db, {
      userId: caller.id,
      target,
      projectId: caller.projectId,
      principal: { sessionOrigin: "oidc", mfaCompleted: true, clientIp: "10.1.2.3" },
      actor: chainOf(identityA, identityB),
    });
    expect(supplied.principal).toMatchObject({ sessionOrigin: "oidc", mfaCompleted: true });
    expect(supplied.context.clientIp).toBe("10.1.2.3");
    expect(supplied.delegation).toEqual({ actorChain: [identityA, identityB], delegationDepth: 2 });
    const bare = await assembleGovernedAbacRequest(k.db, { userId: caller.id, target, projectId: caller.projectId });
    expect(bare.principal).toMatchObject({ sessionOrigin: "unknown", mfaCompleted: false });
    expect(bare.context.clientIp).toBeNull();
    expect(bare.delegation).toEqual({ actorChain: [], delegationDepth: 0 });
  });

  it("sessionOrigin: a forbid on an origin refuses that origin only, and an absent origin reads as unknown", async () => {
    await withPolicy('forbid (principal is RegulAIt::User, action == RegulAIt::Action::"ModelInvoke", resource) unless { principal.sessionOrigin == "oidc" };', async () => {
      expect(await verdict({ principal: { sessionOrigin: "oidc" } })).toEqual({ effect: "permit" });
      expect(await verdict({ principal: { sessionOrigin: "api_key" } })).toMatchObject({ effect: "forbid" });
      // fail closed: no request behind the call
      expect(await verdict()).toMatchObject({ effect: "forbid" });
    });
  });

  it("mfaCompleted: a forbid without a second factor refuses unless the request completed MFA (absent = false)", async () => {
    await withPolicy('forbid (principal is RegulAIt::User, action == RegulAIt::Action::"ModelInvoke", resource) unless { principal.mfaCompleted };', async () => {
      expect(await verdict({ principal: { sessionOrigin: "password", mfaCompleted: true } })).toEqual({ effect: "permit" });
      expect(await verdict({ principal: { sessionOrigin: "password", mfaCompleted: false } })).toMatchObject({ effect: "forbid" });
      expect(await verdict({ principal: { sessionOrigin: "password" } })).toMatchObject({ effect: "forbid" });
      expect(await verdict()).toMatchObject({ effect: "forbid" });
    });
  });

  it("clientIp: a network forbid refuses an address outside the range, and an absent address (fail closed)", async () => {
    await withPolicy(
      'forbid (principal, action == RegulAIt::Action::"ModelInvoke", resource) unless { context has clientIp && context.clientIp.isInRange(ip("10.0.0.0/8")) };',
      async () => {
        expect(await verdict({ principal: { clientIp: "10.20.30.40" } })).toEqual({ effect: "permit" });
        expect(await verdict({ principal: { clientIp: "203.0.113.7" } })).toMatchObject({ effect: "forbid" });
        expect(await verdict({ principal: { clientIp: null } })).toMatchObject({ effect: "forbid" });
        expect(await verdict()).toMatchObject({ effect: "forbid" });
      },
    );
  });

  it("the real invoke route supplies the facts: an API-key call reads as api_key", async () => {
    const invoke = () => k.req("POST", `/v1/agents/${MODEL}/invoke`, caller.auth, { mode: "chat", input: "s4b probe", dispatch: true, projectId: caller.projectId });
    expect((await invoke()).statusCode).toBe(200);
    await withPolicy(`forbid (principal == RegulAIt::User::"${caller.id}", action == RegulAIt::Action::"ModelInvoke", resource) when { principal.sessionOrigin == "api_key" };`, async () => {
      const r = await invoke();
      expect(r.statusCode, r.body).toBe(403);
      expect(JSON.parse(r.body).error).toBe("forbidden");
    });
  });
});

describe("ADR-0251 slice 4b: the delegation chain reaches the governed core's ABAC v5 request", () => {
  it("delegationDepth and actorChain decide a delegated call and leave the person's own call alone", async () => {
    await withPolicy('forbid (principal, action == RegulAIt::Action::"ModelInvoke", resource) when { context.delegationDepth > 1 };', async () => {
      expect(await verdict()).toEqual({ effect: "permit" });
      expect(await verdict({ actor: chainOf(identityA) })).toEqual({ effect: "permit" });
      expect(await verdict({ actor: chainOf(identityA, identityB) })).toMatchObject({ effect: "forbid" });
    });
    await withPolicy(`forbid (principal, action == RegulAIt::Action::"ModelInvoke", resource) when { context.actorChain.contains("${identityB}") };`, async () => {
      expect(await verdict({ actor: chainOf(identityA) })).toEqual({ effect: "permit" });
      expect(await verdict({ actor: chainOf(identityA, identityB) })).toMatchObject({ effect: "forbid" });
    });
  });

  it("each actor is evaluated as Agent: a forbid on one actor's attributes refuses a chain that contains it", async () => {
    const id = await activePolicy('forbid (principal is RegulAIt::Agent, action == RegulAIt::Action::"ModelInvoke", resource) when { principal.environments.contains("production") };');
    try {
      // the person acting directly is a User, so an Agent-scoped forbid never reaches them
      expect(await verdict()).toEqual({ effect: "permit" });
      expect(await verdict({ actor: chainOf(identityA) })).toEqual({ effect: "permit" });
      expect(await verdict({ actor: chainOf(identityA, identityB) })).toMatchObject({ effect: "forbid", policyId: id });
    } finally {
      await dropPolicy(id);
    }
  });

  it("an actor whose identity cannot be read refuses the call (abac-engine-error)", async () => {
    await withPolicy('forbid (principal is RegulAIt::Agent, action == RegulAIt::Action::"ModelInvoke", resource) when { principal.kind == "nothing" };', async () => {
      expect(await verdict({ actor: chainOf(randomUUID()) })).toMatchObject({ effect: "forbid", policyId: "abac-engine-error" });
    });
  });

  it("the model gate refuses a call whose delegation grant cannot be read (error is deny)", async () => {
    const refusal = await governedModelGate(k.db, { userId: caller.id, agentId: MODEL, agentName: "m", mode: "chat", projectId: caller.projectId, delegationGrantId: randomUUID() });
    expect(refusal).toMatchObject({ ok: false });
  });
});
