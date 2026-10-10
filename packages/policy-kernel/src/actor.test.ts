/**
 * ADR-0188 S2 — the actor intersection, rule by rule. Each `it` names the term it proves, and the refusal cases
 * are built from an ALLOWED baseline by changing one fact, so every red is attributable to exactly one term
 * (the baseline test asserts the allow first).
 */
import { describe, expect, it } from "vitest";
import {
  checkActorChain,
  evaluate,
  evaluateAgent,
  evaluateConnector,
  scopeCovers,
  scopeSubset,
  type ActorEntitlements,
  type ActorLinkFacts,
  type EvaluationInput,
  type ExecutionPosture,
  type GovernedActor,
  type ToolRef,
} from "./index.js";

const EXEC: ExecutionPosture = { mode: "normal" };
const USER = "user-1";
const SERVER = "server-1";
const AGENT_ID = "agent-1";
const CONNECTOR = "conn-1";
const read: ToolRef = { serverId: SERVER, name: "search", kind: "read" };
const write: ToolRef = { serverId: SERVER, name: "delete", kind: "write" };

const ents = (over: Partial<ActorEntitlements> = {}): ActorEntitlements => ({
  tools: [
    { serverId: SERVER, toolName: "search" },
    { serverId: SERVER, toolName: "delete" },
  ],
  servers: [],
  agents: [{ agentId: AGENT_ID, allowedModes: ["plan", "execute"] }],
  connectors: [{ connectorId: CONNECTOR, mode: "readwrite", allowedObjects: ["accounts"] }],
  ...over,
});

const FULL_SCOPE = [
  { type: "mcp_tool" as const, serverId: SERVER, toolNames: ["search"], kind: "read" as const },
  { type: "mcp_tool" as const, serverId: SERVER, toolNames: ["delete"], kind: "write" as const },
  { type: "agent" as const, agentId: AGENT_ID, modes: ["plan"], kind: "read" as const },
  { type: "agent" as const, agentId: AGENT_ID, modes: ["execute"], kind: "write" as const },
  { type: "connector" as const, connectorId: CONNECTOR, kind: "read" as const },
  { type: "connector" as const, connectorId: CONNECTOR, kind: "write" as const },
];

const link = (i: number, over: Partial<ActorLinkFacts> = {}): ActorLinkFacts => ({
  identityId: `identity-${i}`,
  grantId: `grant-${i}`,
  live: true,
  scope: FULL_SCOPE,
  budget: null,
  entitlements: ents(),
  ...over,
});

/** a chain of `n` live, fully-scoped, fully-granted actors acting for USER */
function actor(n: number, over: Partial<GovernedActor> = {}, links?: ActorLinkFacts[]): GovernedActor {
  const ls = links ?? Array.from({ length: n }, (_, i) => link(i));
  return {
    chain: {
      sponsorUserId: USER,
      delegationGrantId: ls[ls.length - 1]!.grantId,
      depth: ls.length,
      actors: ls.map((l, i) => ({ identityId: l.identityId, kind: "agent" as const, identifier: `spiffe://t.local/regulait/agent/a${i}` })),
    },
    entitlementMode: "own_grants",
    maxDepth: 3,
    costKnown: true,
    links: ls,
    ...over,
  };
}

const toolInput = (a: GovernedActor | null, over: Partial<EvaluationInput> = {}): EvaluationInput => ({
  userId: USER,
  serverId: SERVER,
  execution: EXEC,
  actor: a,
  tool: read,
  toolGrants: [
    { id: "tg-search", userId: USER, serverId: SERVER, toolName: "search" },
    { id: "tg-delete", userId: USER, serverId: SERVER, toolName: "delete" },
  ],
  serverGrants: [],
  ...over,
});

describe("ADR-0188 S2 — the tool path intersection", () => {
  it("baseline: a valid three-hop chain allows, carries the SPONSOR's grant as ruleId, and traces every term", () => {
    const d = evaluate(toolInput(actor(3)));
    expect(d.effect).toBe("allow");
    expect(d.ruleId).toBe("tg-search");
    expect(d.ruleChain.map((t) => t.rule)).toEqual([
      "actor-chain-invalid",
      "delegation-depth",
      "delegation-scope",
      "delegation-budget",
      "tool-allow-list",
      "data-scope",
      "rate-limit",
      "approval-required",
      "actor-allow-list",
      "actor-allow-list",
      "actor-allow-list",
    ]);
    expect(d.ruleChain.filter((t) => t.rule === "actor-allow-list").map((t) => t.grantId)).toEqual([
      "identity-0",
      "identity-1",
      "identity-2",
    ]);
  });

  it("actor: null is the plain per-user evaluation (no actor term is traced)", () => {
    const d = evaluate(toolInput(null));
    expect(d.effect).toBe("allow");
    expect(d.ruleChain.some((t) => t.rule.startsWith("delegation-") || t.rule.startsWith("actor-"))).toBe(false);
  });

  it("the execution gate runs FIRST: a halted deployment refuses before the chain is even read", () => {
    const forged = actor(2, { chain: { ...actor(2).chain, sponsorUserId: "someone-else" } });
    const d = evaluate(toolInput(forged, { execution: { mode: "halted" } }));
    expect(d.ruleId).toBe("execution-halted");
    expect(d).toEqual(evaluate(toolInput(null, { execution: { mode: "halted" } })));
  });

  describe("actor-chain-invalid", () => {
    const cases: Array<[string, GovernedActor]> = [
      ["another user's chain", actor(2, { chain: { ...actor(2).chain, sponsorUserId: "user-2" } })],
      ["depth that is not the hop count", actor(2, { chain: { ...actor(2).chain, depth: 1 } })],
      ["actors reordered against their facts (a forged order)", actor(2, { chain: { ...actor(2).chain, actors: [...actor(2).chain.actors].reverse() } })],
      ["a leaf grant that is not the chain's", actor(2, { chain: { ...actor(2).chain, delegationGrantId: "grant-0" } })],
      ["a fact row missing", actor(2, { links: [link(0)] })],
      ["the MIDDLE actor not live (suspended, halted or a revoked credential)", actor(3, {}, [link(0), link(1, { live: false, liveFailure: "credential_revoked" }), link(2)])],
      ["a child scope wider than its parent", actor(2, {}, [link(0, { scope: [FULL_SCOPE[0]!] }), link(1)])],
      ["an identity twice", actor(2, {}, [link(0), { ...link(1), identityId: "identity-0" }])],
      ["a max depth outside 0..8", actor(1, { maxDepth: 9 })],
    ];
    for (const [name, a] of cases) {
      it(`refuses ${name}`, () => {
        const d = evaluate(toolInput(a));
        expect(d.effect).toBe("deny");
        expect(d.ruleId).toBe("actor-chain-invalid");
        expect(checkActorChain(a, USER).ok).toBe(false);
      });
    }
    it("names the failing actor and code", () => {
      const d = evaluate(toolInput(actor(3, {}, [link(0), link(1, { live: false, liveFailure: "agent_halted" }), link(2)])));
      expect(d.reason).toContain("spiffe://t.local/regulait/agent/a1");
      expect(d.reason).toContain("agent_halted");
    });
  });

  it("delegation-depth: four hops under the default max depth 3 is allowed; under 2 it is refused", () => {
    expect(evaluate(toolInput(actor(4))).effect).toBe("allow");
    const d = evaluate(toolInput(actor(4, { maxDepth: 2 })));
    expect(d.ruleId).toBe("delegation-depth");
    expect(evaluate(toolInput(actor(1, { maxDepth: 0 }))).effect).toBe("allow");
    expect(evaluate(toolInput(actor(2, { maxDepth: 0 }))).ruleId).toBe("delegation-depth");
  });

  describe("delegation-scope", () => {
    it("every link is checked, root first, and the refusal names the first link that does not cover the call", () => {
      // (a leaf wider than its root is already actor-chain-invalid, so both are narrowed here)
      const narrow = [FULL_SCOPE[1]!];
      const d = evaluate(toolInput(actor(2, {}, [link(0, { scope: narrow }), link(1, { scope: narrow })])));
      expect(d.ruleId).toBe("delegation-scope");
      expect(d.ruleChain.at(-1)).toEqual({ rule: "delegation-scope", outcome: "deny", grantId: "grant-0" });
    });
    it("strict kinds: a `write` entry for the tool does not cover a `read` call", () => {
      const s = [{ type: "mcp_tool" as const, serverId: SERVER, toolNames: ["search"], kind: "write" as const }];
      expect(evaluate(toolInput(actor(1, {}, [link(0, { scope: s })]))).ruleId).toBe("delegation-scope");
    });
    it("an mcp_tool entry with no toolNames covers no tool", () => {
      const s = [{ type: "mcp_tool" as const, serverId: SERVER, kind: "read" as const }];
      expect(evaluate(toolInput(actor(1, {}, [link(0, { scope: s })]))).ruleId).toBe("delegation-scope");
    });
  });

  describe("delegation-budget", () => {
    it("a spent leaf (remaining 0) is refused", () => {
      const d = evaluate(toolInput(actor(2, {}, [link(0), link(1, { budget: { remainingMicros: 0 } })])));
      expect(d.ruleId).toBe("delegation-budget");
    });
    it("an ancestor fully allocated (remaining 0) is normal; one gone NEGATIVE (a first crossing below it) refuses", () => {
      expect(evaluate(toolInput(actor(2, {}, [link(0, { budget: { remainingMicros: 0 } }), link(1, { budget: { remainingMicros: 5 } })]))).effect).toBe("allow");
      expect(evaluate(toolInput(actor(2, {}, [link(0, { budget: { remainingMicros: -1 } }), link(1, { budget: { remainingMicros: 5 } })]))).ruleId).toBe("delegation-budget");
    });
    it("an unpriced call under any capped grant is refused; with no cap anywhere it is not a budget question", () => {
      expect(evaluate(toolInput(actor(2, { costKnown: false }, [link(0, { budget: { remainingMicros: 100 } }), link(1)]))).ruleId).toBe("delegation-budget");
      expect(evaluate(toolInput(actor(2, { costKnown: false }))).effect).toBe("allow");
    });
  });

  it("the sponsor still decides: an agent cannot lend its rights to a person (sponsor lacks, agent has)", () => {
    const d = evaluate(toolInput(actor(1), { toolGrants: [] }));
    expect(d.ruleId).toBe("default-deny");
    expect(d.ruleChain.slice(0, 4).every((t) => t.outcome === "allow")).toBe(true);
  });

  describe("actor-allow-list (I7: never the union)", () => {
    it("the MIDDLE actor lacking the tool refuses, naming that identity", () => {
      const d = evaluate(toolInput(actor(3, {}, [link(0), link(1, { entitlements: ents({ tools: [] }) }), link(2)])));
      expect(d.ruleId).toBe("actor-allow-list");
      expect(d.ruleChain.at(-1)).toEqual({ rule: "actor-allow-list", outcome: "deny", grantId: "identity-1" });
    });
    it("an identity with no grants of its own can do nothing (OWNER DECISION 1)", () => {
      const none: ActorEntitlements = { tools: [], servers: [], agents: [], connectors: [] };
      expect(evaluate(toolInput(actor(1, {}, [link(0, { entitlements: none })]))).ruleId).toBe("actor-allow-list");
    });
    it("a read-only-all server grant covers a read tool, never a write and never a protocol method", () => {
      const ro = ents({ tools: [], servers: [{ serverId: SERVER, readOnlyAll: true }] });
      expect(evaluate(toolInput(actor(1, {}, [link(0, { entitlements: ro })]))).effect).toBe("allow");
      expect(evaluate(toolInput(actor(1, {}, [link(0, { entitlements: ro })]), { tool: write })).ruleId).toBe("actor-allow-list");
      const proto: ToolRef = { serverId: SERVER, name: "mcp:resources", kind: "read", surface: "protocol" };
      const protoScope = [{ type: "mcp_tool" as const, serverId: SERVER, toolNames: ["mcp:resources"], kind: "read" as const }];
      const d = evaluate(
        toolInput(actor(1, {}, [link(0, { entitlements: ro, scope: protoScope })]), {
          tool: proto,
          toolGrants: [{ id: "tg-proto", userId: USER, serverId: SERVER, toolName: "mcp:resources" }],
        }),
      );
      expect(d.ruleId).toBe("actor-allow-list");
    });
    it("sponsor_only (I7 relaxed) skips the agent's own grants and decides exactly as the sponsor alone", () => {
      const a = actor(2, { entitlementMode: "sponsor_only" }, [link(0, { entitlements: ents({ tools: [] }) }), link(1, { entitlements: ents({ tools: [] }) })]);
      const d = evaluate(toolInput(a));
      expect(d.effect).toBe("allow");
      expect(d.ruleId).toBe(evaluate(toolInput(null)).ruleId);
    });
  });

  describe("per-actor Cedar (abac-forbid, as Agent)", () => {
    it("an actor's forbid refuses with the policy id", () => {
      const d = evaluate(toolInput(actor(2, {}, [link(0), link(1, { abacDecision: { effect: "forbid", policyId: "pol-agent", policyName: "no agents at night" } })])));
      expect(d.effect).toBe("deny");
      expect(d.ruleId).toBe("pol-agent");
      expect(d.ruleChain.at(-1)).toEqual({ rule: "abac-forbid", outcome: "deny", grantId: "pol-agent" });
    });
    it("abac-engine-error (a failed v4 evaluation for this actor) refuses this call", () => {
      const d = evaluate(toolInput(actor(1, {}, [link(0, { abacDecision: { effect: "forbid", policyId: "abac-engine-error", reason: "boom" } })])));
      expect(d.ruleId).toBe("abac-engine-error");
    });
    it("an actor's approval hold queues; a held consent satisfies it; no approver fails closed", () => {
      const held = link(0, { abacDecision: { effect: "require_approval", policyId: "pol-hold", approverUserId: "approver-1" } });
      const queued = evaluate(toolInput(actor(1, {}, [held])));
      expect(queued.effect).toBe("require_approval");
      expect(queued.approverUserId).toBe("approver-1");
      expect(evaluate(toolInput(actor(1, {}, [held]), { approvedApprovalId: "appr-1" })).effect).toBe("allow");
      const noApprover = link(0, { abacDecision: { effect: "require_approval", policyId: "pol-hold" } });
      expect(evaluate(toolInput(actor(1, {}, [noApprover]))).effect).toBe("deny");
    });
    it("the sponsor's approval comes first, and any later deny still wins over it", () => {
      const rule = { id: "rule-1", userId: USER, serverId: SERVER, toolName: null, writeOnly: false, approverUserId: "boss" };
      const held = link(0, { abacDecision: { effect: "require_approval", policyId: "pol-hold", approverUserId: "approver-1" } });
      const d = evaluate(toolInput(actor(1, {}, [held]), { approvalRules: [rule] }));
      expect(d.effect).toBe("require_approval");
      expect(d.ruleId).toBe("rule-1");
      const denied = evaluate(toolInput(actor(1, {}, [link(0, { entitlements: ents({ tools: [] }) })]), { approvalRules: [rule] }));
      expect(denied.ruleId).toBe("actor-allow-list");
    });
  });
});

describe("ADR-0188 S2 — the agent (model dispatch) path", () => {
  const agentRef = { id: AGENT_ID, name: "Planner", tier: 1, enabled: true, modes: ["plan", "execute"] };
  const input = (a: GovernedActor | null, mode = "plan") => ({
    userId: USER,
    execution: EXEC,
    actor: a,
    agent: agentRef,
    mode,
    agentGrants: [{ id: "ag-1", userId: USER, agentId: AGENT_ID, allowedModes: null }],
  });
  it("allows a covered mode and refuses an uncovered one (strict modes)", () => {
    expect(evaluateAgent(input(actor(2))).effect).toBe("allow");
    const planOnly = ents({ agents: [{ agentId: AGENT_ID, allowedModes: ["plan"] }] });
    expect(evaluateAgent(input(actor(1, {}, [link(0, { entitlements: planOnly })]), "execute")).ruleId).toBe("actor-allow-list");
  });
  it("a plan-safe mode is a `read`: a `write` scope entry for `plan` does not cover it", () => {
    const s = [{ type: "agent" as const, agentId: AGENT_ID, modes: ["plan"], kind: "write" as const }];
    expect(evaluateAgent(input(actor(1, {}, [link(0, { scope: s })]))).ruleId).toBe("delegation-scope");
  });
  it("an agent entry with no modes allows no mode", () => {
    const s = [{ type: "agent" as const, agentId: AGENT_ID, kind: "read" as const }];
    expect(evaluateAgent(input(actor(1, {}, [link(0, { scope: s })]))).ruleId).toBe("delegation-scope");
  });
  it("an actor approval hold refuses (dispatch has no per-call queue)", () => {
    const held = link(0, { abacDecision: { effect: "require_approval", policyId: "pol", approverUserId: "a" } });
    expect(evaluateAgent(input(actor(1, {}, [held]))).effect).toBe("deny");
  });
});

describe("ADR-0188 S2 — the connector path", () => {
  const input = (a: GovernedActor | null, over: Record<string, unknown> = {}) => ({
    userId: USER,
    execution: EXEC,
    actor: a,
    connectorId: CONNECTOR,
    operation: "read" as const,
    object: "accounts",
    connectorGrants: [{ id: "cg-1", userId: USER, connectorId: CONNECTOR, mode: "readwrite" as const, allowedObjects: null }],
    ...over,
  });
  it("allows a named, granted object", () => {
    expect(evaluateConnector(input(actor(1))).effect).toBe("allow");
  });
  it("a call naming no object is not covered by an agent's grant (its objects are always a list)", () => {
    expect(evaluateConnector(input(actor(1), { object: null })).ruleId).toBe("actor-allow-list");
    // the human alone may (their NULL allowedObjects means every object)
    expect(evaluateConnector(input(null, { object: null })).effect).toBe("allow");
  });
  it("a write needs a `readwrite` grant of the agent's own", () => {
    const ro = ents({ connectors: [{ connectorId: CONNECTOR, mode: "read", allowedObjects: ["accounts"] }] });
    expect(evaluateConnector(input(actor(1, {}, [link(0, { entitlements: ro })]), { operation: "write" })).ruleId).toBe("actor-allow-list");
  });
});

describe("ADR-0188 S2 — scope algebra", () => {
  it("subset is per atom, across a parent's entries", () => {
    const parent = [
      { type: "mcp_tool" as const, serverId: SERVER, toolNames: ["a"], kind: "read" as const },
      { type: "mcp_tool" as const, serverId: SERVER, toolNames: ["b"], kind: "read" as const },
    ];
    expect(scopeSubset([{ type: "mcp_tool", serverId: SERVER, toolNames: ["a", "b"], kind: "read" }], parent)).toBe(true);
    expect(scopeSubset([{ type: "mcp_tool", serverId: SERVER, toolNames: ["a", "c"], kind: "read" }], parent)).toBe(false);
    expect(scopeSubset([{ type: "mcp_tool", serverId: SERVER, toolNames: ["a"], kind: "write" }], parent)).toBe(false);
    expect(scopeCovers([], { type: "connector", connectorId: CONNECTOR, kind: "read" })).toBe(false);
  });
});
