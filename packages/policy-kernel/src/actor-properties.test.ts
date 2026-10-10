/**
 * ADR-0188 S2 — PROPERTY TESTS P1–P7 of the actor intersection (fast-check, fixed seeds).
 *
 * A small universe (two servers, three tools, two connectors, two agents with two modes) keeps collisions
 * frequent, so generated grant sets, scopes and chains actually overlap with the call being decided — a property
 * over a universe where nothing ever matched would pass vacuously (M-033). Each property also counts how many
 * runs reached its interesting case and asserts a floor, so a generator change that starves it fails loudly.
 *
 *   P1  soundness: an allowed agent call is inside EVERY link's own rights (sponsor, scope, own grants, live,
 *       depth, budget, Cedar) — on all three paths
 *   P2  narrowing: an actor never widens the sponsor's own decision (deny stays deny; approval never becomes allow)
 *   P3  `sponsor_only` with a clean chain decides exactly as the sponsor alone
 *   P4  scope algebra: subset is reflexive and transitive, covering is preserved upward, and nothing implies
 *       anything (write ⊉ read, an absent list covers nothing)
 *   P5  anti-monotone in rights: removing any one grant or scope entry from any link never turns deny into allow
 *   P6  a forged or inconsistent chain is refused `actor-chain-invalid`
 *   P7  depth and budget: past `maxDepth` is `delegation-depth`; a spent leaf is `delegation-budget`
 *
 * The NEGATIVE CONTROLS at the end run P1 and P4 against deliberately widened deciders and require fast-check to
 * find a counterexample: proof that the properties can fail.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  evaluate,
  evaluateAgent,
  evaluateConnector,
  scopeCovers,
  scopeSubset,
  type ActorEntitlements,
  type ActorLinkFacts,
  type Decision,
  type DelegationScope,
  type DelegationScopeItem,
  type EvaluateAgentInput,
  type EvaluateConnectorInput,
  type EvaluationInput,
  type GovernedActor,
  type ScopeCall,
  type ToolRef,
} from "./index.js";

const SEED = 0x0188_5200;
const RUNS = 1500;
const USER = "user-p";
const SERVERS = ["s1", "s2"] as const;
const TOOLS: ReadonlyArray<{ name: string; kind: "read" | "write" }> = [
  { name: "t-read", kind: "read" },
  { name: "t-write", kind: "write" },
  { name: "t-both", kind: "read" },
];
const CONNECTORS = ["c1", "c2"] as const;
const AGENTS = ["g1", "g2"] as const;
const MODES = ["plan", "execute"] as const;
const OBJECTS = ["o1", "o2"] as const;

// ---------------------------------------------------------------------------
// generators
// ---------------------------------------------------------------------------

const atomArb: fc.Arbitrary<ScopeCall> = fc.oneof(
  fc.record({
    type: fc.constant("mcp_tool" as const),
    serverId: fc.constantFrom(...SERVERS),
    toolName: fc.constantFrom(...TOOLS.map((t) => t.name)),
    kind: fc.constantFrom("read" as const, "write" as const),
  }),
  fc.record({
    type: fc.constant("connector" as const),
    connectorId: fc.constantFrom(...CONNECTORS),
    kind: fc.constantFrom("read" as const, "write" as const),
  }),
  fc.record({
    type: fc.constant("agent" as const),
    agentId: fc.constantFrom(...AGENTS),
    mode: fc.constantFrom(...MODES),
    kind: fc.constantFrom("read" as const, "write" as const),
  }),
);

/** a scope entry; lists may be empty or absent (both cover nothing) */
const itemArb: fc.Arbitrary<DelegationScopeItem> = fc.oneof(
  fc.record(
    {
      type: fc.constant("mcp_tool" as const),
      serverId: fc.constantFrom(...SERVERS),
      toolNames: fc.subarray(TOOLS.map((t) => t.name)),
      kind: fc.constantFrom("read" as const, "write" as const),
    },
    { requiredKeys: ["type", "serverId", "kind"] },
  ),
  fc.record({ type: fc.constant("connector" as const), connectorId: fc.constantFrom(...CONNECTORS), kind: fc.constantFrom("read" as const, "write" as const) }),
  fc.record(
    {
      type: fc.constant("agent" as const),
      agentId: fc.constantFrom(...AGENTS),
      modes: fc.subarray([...MODES]),
      kind: fc.constantFrom("read" as const, "write" as const),
    },
    { requiredKeys: ["type", "agentId", "kind"] },
  ),
);
const scopeArb: fc.Arbitrary<DelegationScope> = fc.array(itemArb, { maxLength: 8 });

/** keep each element with probability 0.8 — dense enough that generated rights usually overlap the call */
function keepMost<T>(list: readonly T[]): fc.Arbitrary<T[]> {
  return fc
    .array(fc.integer({ min: 0, max: 9 }), { minLength: list.length, maxLength: list.length })
    .map((rolls) => list.filter((_, i) => rolls[i]! < 8));
}

/** every atomic call of the universe as a one-name scope entry */
const ATOM_ITEMS: DelegationScopeItem[] = [
  ...SERVERS.flatMap((serverId) =>
    TOOLS.flatMap((t) => (["read", "write"] as const).map((kind) => ({ type: "mcp_tool" as const, serverId, toolNames: [t.name], kind }))),
  ),
  ...CONNECTORS.flatMap((connectorId) => (["read", "write"] as const).map((kind) => ({ type: "connector" as const, connectorId, kind }))),
  ...AGENTS.flatMap((agentId) =>
    MODES.flatMap((m) => (["read", "write"] as const).map((kind) => ({ type: "agent" as const, agentId, modes: [m], kind }))),
  ),
];
/** a ROOT scope: most single atoms, plus a few arbitrary (multi-name, empty or absent-list) entries */
const rootScopeArb: fc.Arbitrary<DelegationScope> = fc
  .tuple(keepMost(ATOM_ITEMS), fc.array(itemArb, { maxLength: 3 }))
  .map(([atoms, extra]) => [...atoms, ...extra]);

const entitlementsArb: fc.Arbitrary<ActorEntitlements> = fc.record({
  tools: keepMost(SERVERS.flatMap((serverId) => TOOLS.map((t) => ({ serverId, toolName: t.name })))),
  servers: fc.subarray(SERVERS.map((serverId) => ({ serverId, readOnlyAll: true }))),
  agents: keepMost([...AGENTS]).chain((ids) =>
    fc.tuple(...ids.map((agentId) => keepMost([...MODES]).map((allowedModes) => ({ agentId, allowedModes })))),
  ),
  connectors: keepMost([...CONNECTORS]).chain((ids) =>
    fc.tuple(
      ...ids.map((connectorId) =>
        fc.record({
          connectorId: fc.constant(connectorId),
          mode: fc.constantFrom("read" as const, "readwrite" as const),
          allowedObjects: keepMost([...OBJECTS]),
        }),
      ),
    ),
  ),
});

const abacArb = fc.oneof(
  { weight: 12, arbitrary: fc.constant(null) },
  { weight: 1, arbitrary: fc.constant({ effect: "permit" as const }) },
  { weight: 1, arbitrary: fc.constant({ effect: "forbid" as const, policyId: "pol-forbid" }) },
  { weight: 1, arbitrary: fc.constant({ effect: "require_approval" as const, policyId: "pol-hold", approverUserId: "approver" }) },
);

/**
 * A chain whose scopes NEST (each link's scope is drawn as a subset of its parent's atoms), so most generated
 * chains are structurally valid and the interesting terms (scope, grants, budget, Cedar) get exercised; P6
 * perturbs valid chains to reach `actor-chain-invalid`.
 */
const linksArb: fc.Arbitrary<ActorLinkFacts[]> = fc
  .tuple(rootScopeArb, fc.integer({ min: 1, max: 4 }))
  .chain(([rootScope, n]) => {
    const narrow = (s: DelegationScope): fc.Arbitrary<DelegationScope> => keepMost(s);
    let scopes: fc.Arbitrary<DelegationScope[]> = fc.constant([rootScope]);
    for (let i = 1; i < n; i++) scopes = scopes.chain((acc) => narrow(acc[acc.length - 1]!).map((s) => [...acc, s]));
    return scopes.chain((ss) =>
      fc.tuple(
        ...ss.map((scope, i) =>
          fc.record({
            identityId: fc.constant(`id-${i}`),
            grantId: fc.constant(`grant-${i}`),
            live: fc.oneof({ weight: 12, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
            scope: fc.constant(scope),
            budget: fc.oneof(
              { weight: 3, arbitrary: fc.constant(null) },
              { weight: 2, arbitrary: fc.integer({ min: -2, max: 3 }).map((remainingMicros) => ({ remainingMicros })) },
            ),
            entitlements: entitlementsArb,
            abacDecision: abacArb,
          }),
        ),
      ),
    );
  });

const actorArb: fc.Arbitrary<GovernedActor> = fc
  .record({
    links: linksArb,
    entitlementMode: fc.constantFrom("own_grants" as const, "own_grants" as const, "sponsor_only" as const),
    maxDepth: fc.integer({ min: 0, max: 8 }),
    costKnown: fc.oneof({ weight: 5, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
  })
  .map(({ links, ...rest }) => ({
    ...rest,
    links,
    chain: {
      sponsorUserId: USER,
      delegationGrantId: links[links.length - 1]!.grantId,
      depth: links.length,
      actors: links.map((l) => ({ identityId: l.identityId, kind: "agent" as const, identifier: `spiffe://p.local/regulait/agent/${l.identityId}` })),
    },
  }));

/** the sponsor's own grants on the tool path */
const sponsorToolArb = fc.record({
  toolGrants: keepMost(
    SERVERS.flatMap((serverId) => TOOLS.map((t) => ({ id: `tg-${serverId}-${t.name}`, userId: USER, serverId, toolName: t.name }))),
  ),
  serverGrants: fc.subarray(SERVERS.map((serverId) => ({ id: `sg-${serverId}`, userId: USER, serverId, readOnlyAll: true }))),
  approvalHold: fc.boolean(),
});

const toolCaseArb = fc.record({
  actor: actorArb,
  sponsor: sponsorToolArb,
  serverId: fc.constantFrom(...SERVERS),
  tool: fc.constantFrom(...TOOLS),
  approved: fc.oneof({ weight: 5, arbitrary: fc.constant(null) }, { weight: 1, arbitrary: fc.constant("appr-1") }),
});
type ToolCase = typeof toolCaseArb extends fc.Arbitrary<infer T> ? T : never;

function toolInput(c: ToolCase, actor: GovernedActor | null): EvaluationInput {
  const tool: ToolRef = { serverId: c.serverId, name: c.tool.name, kind: c.tool.kind };
  return {
    userId: USER,
    serverId: c.serverId,
    execution: { mode: "normal" },
    actor,
    tool,
    toolGrants: c.sponsor.toolGrants,
    serverGrants: c.sponsor.serverGrants,
    approvalRules: c.sponsor.approvalHold
      ? [{ id: "rule-hold", userId: USER, serverId: c.serverId, toolName: null, writeOnly: false, approverUserId: "boss" }]
      : [],
    approvedApprovalId: c.approved,
  };
}

const agentCaseArb = fc.record({
  actor: actorArb,
  agentId: fc.constantFrom(...AGENTS),
  mode: fc.constantFrom(...MODES),
  sponsorModes: fc.oneof(fc.constant(null), fc.subarray([...MODES])),
  sponsorGranted: fc.oneof({ weight: 4, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
});
type AgentCase = typeof agentCaseArb extends fc.Arbitrary<infer T> ? T : never;
const agentInput = (c: AgentCase, actor: GovernedActor | null): EvaluateAgentInput => ({
  userId: USER,
  execution: { mode: "normal" },
  actor,
  agent: { id: c.agentId, tier: 1, enabled: true, modes: [...MODES] },
  mode: c.mode,
  agentGrants: c.sponsorGranted ? [{ id: "ag", userId: USER, agentId: c.agentId, allowedModes: c.sponsorModes }] : [],
});

const connectorCaseArb = fc.record({
  actor: actorArb,
  connectorId: fc.constantFrom(...CONNECTORS),
  operation: fc.constantFrom("read" as const, "write" as const),
  object: fc.oneof(fc.constant(null), fc.constantFrom(...OBJECTS)),
  sponsorMode: fc.constantFrom("read" as const, "readwrite" as const),
  sponsorGranted: fc.oneof({ weight: 4, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
});
type ConnectorCase = typeof connectorCaseArb extends fc.Arbitrary<infer T> ? T : never;
const connectorInput = (c: ConnectorCase, actor: GovernedActor | null): EvaluateConnectorInput => ({
  userId: USER,
  execution: { mode: "normal" },
  actor,
  connectorId: c.connectorId,
  operation: c.operation,
  object: c.object,
  connectorGrants: c.sponsorGranted
    ? [{ id: "cg", userId: USER, connectorId: c.connectorId, mode: c.sponsorMode, allowedObjects: null }]
    : [],
});

// ---------------------------------------------------------------------------
// the oracle: what "inside every link's own rights" means, written independently of the kernel
// ---------------------------------------------------------------------------

function chainValid(a: GovernedActor): boolean {
  return (
    a.links.every((l) => l.live) &&
    a.links.every((l, i) => i === 0 || scopeSubset(l.scope, a.links[i - 1]!.scope)) &&
    a.chain.depth - 1 <= a.maxDepth
  );
}
function budgetOk(a: GovernedActor): boolean {
  return a.links.every((l, i) => {
    if (l.budget === null) return true;
    if (!a.costKnown) return false;
    return i === a.links.length - 1 ? l.budget.remainingMicros > 0 : l.budget.remainingMicros >= 0;
  });
}
const noForbid = (a: GovernedActor) => a.links.every((l) => l.abacDecision?.effect !== "forbid");
function ownToolOk(e: ActorEntitlements, serverId: string, tool: { name: string; kind: string }): boolean {
  return (
    e.tools.some((g) => g.serverId === serverId && g.toolName === tool.name) ||
    (tool.kind === "read" && e.servers.some((g) => g.serverId === serverId && g.readOnlyAll))
  );
}

type Decider = (input: EvaluationInput) => Decision;

/** P1 on the tool path, against any decider (the negative control passes a widened one) */
function p1Tool(decide: Decider) {
  return fc.property(toolCaseArb, (c) => {
    const d = decide(toolInput(c, c.actor));
    if (d.effect !== "allow") return true;
    const call: ScopeCall = { type: "mcp_tool", serverId: c.serverId, toolName: c.tool.name, kind: c.tool.kind };
    return (
      evaluate(toolInput(c, null)).effect === "allow" &&
      chainValid(c.actor) &&
      budgetOk(c.actor) &&
      noForbid(c.actor) &&
      c.actor.links.every((l) => scopeCovers(l.scope, call)) &&
      (c.actor.entitlementMode === "sponsor_only" || c.actor.links.every((l) => ownToolOk(l.entitlements, c.serverId, c.tool)))
    );
  });
}

type Covers = (s: DelegationScope, x: ScopeCall) => boolean;

/** P4, against any covering function (the negative control passes a widened one) */
function p4(covers: Covers) {
  return fc.property(scopeArb, scopeArb, scopeArb, atomArb, (a, b, c, x) => {
    if (!scopeSubset(a, a)) return false;
    if (scopeSubset(a, b) && scopeSubset(b, c) && !scopeSubset(a, c)) return false;
    if (scopeSubset(a, b) && covers(a, x) && !covers(b, x)) return false;
    // strict (decision 27): an entry covers only its own kind; an absent or empty list covers nothing
    for (const item of a) {
      const opposite = item.kind === "read" ? "write" : "read";
      if (item.type === "mcp_tool") {
        const names = item.toolNames ?? [];
        if (names.some((t) => covers([item], { type: "mcp_tool", serverId: item.serverId!, toolName: t, kind: opposite }))) return false;
        if (names.length === 0 && TOOLS.some((t) => covers([item], { type: "mcp_tool", serverId: item.serverId!, toolName: t.name, kind: item.kind }))) return false;
      }
      if (item.type === "agent") {
        const modes = item.modes ?? [];
        if (modes.some((m) => covers([item], { type: "agent", agentId: item.agentId!, mode: m, kind: opposite }))) return false;
        if (modes.length === 0 && MODES.some((m) => covers([item], { type: "agent", agentId: item.agentId!, mode: m, kind: item.kind }))) return false;
      }
      if (item.type === "connector" && covers([item], { type: "connector", connectorId: item.connectorId!, kind: opposite })) return false;
    }
    return true;
  });
}

const RANK = { allow: 0, require_approval: 1, deny: 2 } as const;
const opts = (seed: number) => ({ seed, numRuns: RUNS, endOnFailure: true });

describe("ADR-0188 S2 — properties of the actor intersection (fast-check, fixed seeds)", () => {
  it("P1 soundness (tool path): an allowed call is inside every link's own rights — and allows do occur", () => {
    let allows = 0;
    fc.assert(
      p1Tool((input) => {
        const d = evaluate(input);
        if (d.effect === "allow") allows++;
        return d;
      }),
      opts(SEED + 1),
    );
    expect(allows).toBeGreaterThan(RUNS / 20);
  });

  it("P1 soundness (agent and connector paths)", () => {
    let agentAllows = 0;
    fc.assert(
      fc.property(agentCaseArb, (c) => {
        const d = evaluateAgent(agentInput(c, c.actor));
        if (d.effect !== "allow") return true;
        agentAllows++;
        const call: ScopeCall = { type: "agent", agentId: c.agentId, mode: c.mode, kind: c.mode === "plan" ? "read" : "write" };
        return (
          evaluateAgent(agentInput(c, null)).effect === "allow" &&
          chainValid(c.actor) &&
          budgetOk(c.actor) &&
          noForbid(c.actor) &&
          c.actor.links.every((l) => l.abacDecision?.effect !== "require_approval") &&
          c.actor.links.every((l) => scopeCovers(l.scope, call)) &&
          (c.actor.entitlementMode === "sponsor_only" ||
            c.actor.links.every((l) => l.entitlements.agents.some((g) => g.agentId === c.agentId && g.allowedModes.includes(c.mode))))
        );
      }),
      opts(SEED + 2),
    );
    let connectorAllows = 0;
    fc.assert(
      fc.property(connectorCaseArb, (c) => {
        const d = evaluateConnector(connectorInput(c, c.actor));
        if (d.effect !== "allow") return true;
        connectorAllows++;
        const call: ScopeCall = { type: "connector", connectorId: c.connectorId, kind: c.operation };
        return (
          evaluateConnector(connectorInput(c, null)).effect === "allow" &&
          chainValid(c.actor) &&
          budgetOk(c.actor) &&
          noForbid(c.actor) &&
          c.actor.links.every((l) => scopeCovers(l.scope, call)) &&
          (c.actor.entitlementMode === "sponsor_only" ||
            c.actor.links.every((l) =>
              l.entitlements.connectors.some(
                (g) =>
                  g.connectorId === c.connectorId &&
                  (c.operation === "read" || g.mode === "readwrite") &&
                  c.object !== null &&
                  g.allowedObjects.includes(c.object),
              ),
            ))
        );
      }),
      opts(SEED + 3),
    );
    expect(agentAllows).toBeGreaterThan(RUNS / 20);
    expect(connectorAllows).toBeGreaterThan(RUNS / 20);
  });

  it("P2 narrowing: an actor never widens the sponsor's own decision, on all three paths", () => {
    fc.assert(
      fc.property(toolCaseArb, (c) => RANK[evaluate(toolInput(c, c.actor)).effect] >= RANK[evaluate(toolInput(c, null)).effect]),
      opts(SEED + 4),
    );
    fc.assert(
      fc.property(agentCaseArb, (c) => RANK[evaluateAgent(agentInput(c, c.actor)).effect] >= RANK[evaluateAgent(agentInput(c, null)).effect]),
      opts(SEED + 5),
    );
    fc.assert(
      fc.property(
        connectorCaseArb,
        (c) => RANK[evaluateConnector(connectorInput(c, c.actor)).effect] >= RANK[evaluateConnector(connectorInput(c, null)).effect],
      ),
      opts(SEED + 6),
    );
  });

  it("P3 sponsor_only with a clean, covering chain decides exactly as the sponsor alone (effect, ruleId, reason)", () => {
    let reached = 0;
    fc.assert(
      fc.property(toolCaseArb, (c) => {
        const a: GovernedActor = {
          ...c.actor,
          entitlementMode: "sponsor_only",
          costKnown: true,
          links: c.actor.links.map((l) => ({ ...l, live: true, budget: null, abacDecision: null })),
        };
        const call: ScopeCall = { type: "mcp_tool", serverId: c.serverId, toolName: c.tool.name, kind: c.tool.kind };
        if (!chainValid(a) || !a.links.every((l) => scopeCovers(l.scope, call))) return true;
        reached++;
        const withActor = evaluate(toolInput(c, a));
        const alone = evaluate(toolInput(c, null));
        return withActor.effect === alone.effect && withActor.ruleId === alone.ruleId && withActor.reason === alone.reason;
      }),
      opts(SEED + 7),
    );
    expect(reached).toBeGreaterThan(RUNS / 4);
  });

  it("P4 scope algebra: reflexive, transitive, covering preserved upward, and strict", () => {
    fc.assert(p4(scopeCovers), opts(SEED + 8));
  });

  it("P5 anti-monotone in rights: removing one grant or scope entry from any link never turns a deny into an allow", () => {
    fc.assert(
      fc.property(toolCaseArb, fc.nat(), fc.nat(), fc.constantFrom("tools", "servers", "scope") , (c, li, ei, what) => {
        const links = c.actor.links;
        const i = li % links.length;
        const l = links[i]!;
        let reduced: ActorLinkFacts;
        if (what === "scope") {
          if (l.scope.length === 0) return true;
          reduced = { ...l, scope: l.scope.filter((_, k) => k !== ei % l.scope.length) };
        } else {
          const list = l.entitlements[what];
          if (list.length === 0) return true;
          reduced = { ...l, entitlements: { ...l.entitlements, [what]: list.filter((_, k) => k !== ei % list.length) } };
        }
        const smaller: GovernedActor = { ...c.actor, links: links.map((x, k) => (k === i ? reduced : x)) };
        const before = evaluate(toolInput(c, c.actor)).effect;
        const after = evaluate(toolInput(c, smaller)).effect;
        return RANK[after] >= RANK[before];
      }),
      opts(SEED + 9),
    );
  });

  it("P6 a forged or inconsistent chain is refused actor-chain-invalid, whatever else holds", () => {
    const perturb = fc.constantFrom("sponsor", "swap", "drop", "leaf-grant", "not-live", "depth", "dup-identity");
    fc.assert(
      fc.property(toolCaseArb, perturb, fc.nat(), (c, how, k) => {
        const a = c.actor;
        const n = a.links.length;
        let forged: GovernedActor;
        switch (how) {
          case "sponsor":
            forged = { ...a, chain: { ...a.chain, sponsorUserId: "user-other" } };
            break;
          case "swap":
            if (n < 2) return true;
            forged = { ...a, chain: { ...a.chain, actors: [a.chain.actors[1]!, a.chain.actors[0]!, ...a.chain.actors.slice(2)] } };
            break;
          case "drop":
            forged = { ...a, links: a.links.slice(0, n - 1) };
            break;
          case "leaf-grant":
            forged = { ...a, chain: { ...a.chain, delegationGrantId: "grant-forged" } };
            break;
          case "not-live":
            forged = { ...a, links: a.links.map((l, i) => (i === k % n ? { ...l, live: false } : l)) };
            break;
          case "depth":
            forged = { ...a, chain: { ...a.chain, depth: n + 1 + (k % 3) } };
            break;
          case "dup-identity":
            if (n < 2) return true;
            forged = { ...a, links: a.links.map((l, i) => (i === 1 ? { ...l, identityId: a.links[0]!.identityId } : l)) };
            break;
        }
        const d = evaluate(toolInput(c, forged));
        return d.effect === "deny" && d.ruleId === "actor-chain-invalid";
      }),
      opts(SEED + 10),
    );
  });

  it("P7 depth and budget: beyond maxDepth is delegation-depth; a spent leaf is delegation-budget", () => {
    let deep = 0;
    let spent = 0;
    fc.assert(
      fc.property(toolCaseArb, fc.integer({ min: -3, max: 0 }), (c, leftover) => {
        const a: GovernedActor = { ...c.actor, links: c.actor.links.map((l) => ({ ...l, live: true })) };
        if (!a.links.every((l, i) => i === 0 || scopeSubset(l.scope, a.links[i - 1]!.scope))) return true;
        if (a.chain.depth - 1 > a.maxDepth) {
          deep++;
          return evaluate(toolInput(c, a)).ruleId === "delegation-depth";
        }
        const call: ScopeCall = { type: "mcp_tool", serverId: c.serverId, toolName: c.tool.name, kind: c.tool.kind };
        if (!a.links.every((l) => scopeCovers(l.scope, call))) return true;
        spent++;
        const exhausted: GovernedActor = {
          ...a,
          costKnown: true,
          links: a.links.map((l, i) => (i === a.links.length - 1 ? { ...l, budget: { remainingMicros: leftover } } : { ...l, budget: null })),
        };
        return evaluate(toolInput(c, exhausted)).ruleId === "delegation-budget";
      }),
      opts(SEED + 11),
    );
    expect(deep).toBeGreaterThan(100);
    expect(spent).toBeGreaterThan(100);
  });
});

describe("ADR-0188 S2 — negative controls: the properties can fail", () => {
  it("P1 finds a counterexample against a decider that checks only the LEAF actor's own grants", () => {
    // the widening: every ancestor is given the leaf's grants before the real kernel decides, which is what a
    // kernel that consulted only the caller's own grants would compute
    const leafOnly: Decider = (input) => {
      const a = input.actor;
      if (!a) return evaluate(input);
      const leaf = a.links[a.links.length - 1]!.entitlements;
      return evaluate({ ...input, actor: { ...a, links: a.links.map((l) => ({ ...l, entitlements: leaf })) } });
    };
    const r = fc.check(p1Tool(leafOnly), { seed: SEED + 1, numRuns: RUNS });
    expect(r.failed).toBe(true);
  });

  it("P4 finds a counterexample against a scope check where `write` implies `read`", () => {
    const widened: Covers = (s, x) => scopeCovers(s, x) || (x.kind === "read" && scopeCovers(s, { ...x, kind: "write" } as ScopeCall));
    const r = fc.check(p4(widened), { seed: SEED + 8, numRuns: RUNS });
    expect(r.failed).toBe(true);
  });
});
