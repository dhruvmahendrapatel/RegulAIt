# Tighten-Only Delegation — the Conformance Contract

Status: Active (ADR-0078). Owner: pillar 7. Last verified: 2026-08-15.

This document names pillar 7's load-bearing sentence as a **checkable contract** and pins every
cell of it to a runnable test:

> Every worker/lead agent inherits — and never exceeds — the entitlements and per-run budget of
> the initiating user. Delegation composes downward as **intersection** (for sets) and **MIN**
> (for budgets). No level of the delegation chain can widen what any level above it — or the
> user's own grants — allows. There is no request surface that raises a cap.

"Conformance" here means: the suite below is the contract. A build on which
`apps/gateway/src/delegation-conformance.test.ts` passes (together with the cited companion
files) is conformant; a change that makes any cell fail is a semantics change and needs an ADR,
not a test edit. Test names are cited verbatim — renaming one is a spec change.

## The lattice under test

```
effective(worker) = user grants  ∩  ceiling(lead₁)  ∩  ceiling(lead₂)  ∩ …   (agents, tools)
effectiveCap(node) = MIN(node.budgetCapUsd, lead₁.budgetCapUsd, lead₂.budgetCapUsd, …)
runCap             = initiating user's policy runBudgetUsd  (no graph/payload override exists)
```

`null` at any hop = "no constraint at this hop" (the intersection identity / no cap), so flat
runs are byte-identical to pre-delegation behaviour. An empty set stays empty: nothing rescues
it. The kernel primitives are `computeNodeCeiling` / `computeNodeBudgetCeiling`
(`packages/orchestration-kernel/src/index.ts`); enforcement points are run planning, dispatch,
reassignment, the auto loop, and every governed tool call inside a worker turn.

The conformance suite probes one deliberately asymmetric lattice per dimension so that **each
denial isolates exactly one composition level** — each excluded member is vetoed by only one
level, so the probe fails if that one level is skipped:

```
user granted {A,B,C,E}          (D exists, never granted)
grandparent ceiling {A,B,D,E}   — only gp excludes C
direct-lead ceiling {B,C,D,E}   — only mid excludes A
effective = {B,E}               (E = the allowed control, M-002)
```

## The conformance table

Dimensions × composition levels. Unqualified test names live in
`apps/gateway/src/delegation-conformance.test.ts`; companion files are named explicitly.
"n/a — structural" marks cells where the level does not constrain that dimension by
construction (budget levels carry no agent/tool identity); they are listed so the enumeration
is visibly complete rather than silently partial.

| Level ↓ / Dimension → | Agent allow-list | Tool refs | Budget cap |
|---|---|---|---|
| **User grant** | `[agent × user grant] both ceilings admit D…` (reassign); `[agent × plan time]…` (owner D at creation); execution-time revocation: `pillar7-inheritance.test.ts` ("a grant revoked AFTER planning…", "…AUTO loop honours the same revocation…", "an ADMIN driving someone else's run…") | `[tool × all levels + control]…` — the `dconf_delta` probe (in **both** ceilings, never granted → `default-deny`); `orchestration-tools.test.ts` (b) | `[budget × user grant] there is NO request surface that widens the cap…` (smuggled payload budget stripped; policy figure stands) |
| **Lead ceiling** | `[agent × lead ceiling] the DIRECT lead's exclusion vetoes a granted agent at reassign` (`agent-lead-ceiling`); plan-time: `orchestration-tools.test.ts` (g); reassign under single lead: `pillar7-inheritance.test.ts` ("a lead's ceiling excludes an agent the initiator personally holds") | `[tool × all levels + control]…` — the `dconf_alpha` probe (`lead-ceiling`); `orchestration-tools.test.ts` (f) | `[budget × lead ceiling] the DIRECT lead's lower cap binds…` (MIN{—,5,2}=2 blocks a $3 node); `node-budget.test.ts` ("transitive MIN…") |
| **Nested-lead ceiling** | `[agent × nested-lead ceiling] the GRANDPARENT's exclusion vetoes through an admitting direct lead (three-level chain)`; `[agent × plan time]…` (owner C); `orchestration-tools.test.ts` (h) | `[tool × all levels + control]…` — the `dconf_gamma` probe (direct lead admits it; only the grandparent vetoes — three-level chain) | `[budget × nested-lead ceiling] the GRANDPARENT's lower cap binds through a looser direct lead…` (MIN{—,2,5}=2 — three-level MIN) |
| **Run budget** | n/a — structural | n/a — structural | `[budget × run budget] the run-level cap comes from the initiating user's policy…` (plan-time `__budget__` escalation; start blocked); measured mid-loop: `orchestration-tools.test.ts` (e) |
| **Node budget** | n/a — structural | n/a — structural | `[budget × node budget] the node's OWN cap binds under loose leads…` (MIN{1,50,50}=1); estimate gate: `node-budget.test.ts`; measured variant: `measured-node-budget.test.ts` |
| **Controls (M-002)** | `[agent control] E — granted AND inside both ceilings — reassigns fine…` | the `dconf_beta` probe allows | `[budget control] caps above the estimate everywhere… start cleanly` |

Composition-order facts the table relies on, pinned by ruleIds in the suite: a ceiling is
consulted only **after** a grant matches, so it can narrow but never rescue (`lead-ceiling` /
`agent-lead-ceiling` denials vs `default-deny` for the ungranted probes); the run cap has no
widening surface because `createRunSchema` strips unknown payload keys and `capUsd` is read
solely from the initiating user's agent policy at plan time.

## Bypass-proof evidence (M-002)

Each dimension's probe was shown to FAIL when one composition point was temporarily bypassed
(then reverted; recorded 2026-08-15, details in ADR-0078):

1. **Kernel lead-chain walk truncated to one hop** (`computeNodeCeiling`): exactly the three
   nested-level probes failed (agent reassign chain, agent plan-time chain, tool `dconf_gamma`);
   9/12 still passed — the failures isolate the nested level.
2. **Tool-ceiling pass-through nulled at dispatch** (`ceiling.toolRefs → null` at both the
   context-narrowing and the per-call enforcement site): the tool lattice test failed
   (`dconf_alpha` executed); 11/12 passed.
3. **Budget lead fold dropped** (`computeNodeBudgetCeiling` ignoring ancestor caps): exactly
   the two lead-level budget probes failed; own-cap, run-cap and control cells still passed.

## Interop note — how this maps (and does not map) onto MCP and A2A

Claims below were verified on **2026-08-15** against the canonical spec sources on GitHub.
**Unreachable sources, named honestly**: `modelcontextprotocol.io` and `a2a-protocol.org` are
both blocked by this project's network egress proxy; the same spec content was fetched from the
`modelcontextprotocol/modelcontextprotocol` and `a2aproject/A2A` GitHub repositories instead.
Secondary sources (blog posts, arXiv commentary) were not relied on for any claim.

### MCP tool scoping (spec revision 2025-06-18)

**What maps.** A task-graph node's `toolServers` declaration corresponds to MCP servers; tool
names correspond to `tools/list` entries. RegulAIt's gateway is the MCP *client*, so any
third-party MCP server's tools inherit the full lattice with **zero cooperation from the
server**: every worker tool call funnels through the one governed call path, which applies
user grants first and the lead-chain ceiling second (`lead-ceiling`). This is the interop
claim that matters: third-party tools inherit the same ceiling *through the gateway*.

**What does not map.** The MCP authorization spec is OAuth 2.1 between client and server at
**resource** granularity — RFC 8707 resource indicators and token-audience binding ("MCP
servers MUST validate that access tokens were issued specifically for them"). It deliberately
defines **no per-tool or per-user access control, no allow-lists, and no delegation
semantics**; the tools spec leaves authorization to implementations ("implementations are free
to expose tools through any interface pattern that suits their needs") and asks only that
"there SHOULD always be a human in the loop with the ability to deny tool invocations".
Consequently the tighten-only invariant has **no wire-level representation in MCP**: a ceiling
cannot be exported to or enforced by the server; it exists only at our gateway choke point.
MCP's dynamic manifests (`listChanged`) also mean an upstream server can widen its tool list
at any time — conformance stance: a newly appeared tool is still `default-deny` until granted,
and ceiling-checked per call (the `dconf_delta` probe pins the default-deny half).

### Google's A2A delegation vocabulary (spec version 1.0.0)

**What maps.** A2A's delegation unit — a client agent sending a *task* to a remote agent
discovered via its **AgentCard** (`/.well-known/agent-card.json`, `securitySchemes`, `skills`,
`capabilities`) — corresponds to our lead→worker dispatch. Its `TASK_STATE_AUTH_REQUIRED`
pause corresponds to our Approvals Queue halt. Its authorization posture ("Authorization is
implementation-specific and MAY consider: specific skills requested, actions attempted within
tasks, data access policies, OAuth scopes") names exactly the layer RegulAIt's gateway
occupies — A2A assumes someone builds what pillar 7 builds.

**What does not map.** A2A 1.0.0 has **no ceiling or composition vocabulary**: nothing
expresses "the delegatee's effective rights are the intersection of the delegator's and its
own", no budget or rate-limit mechanism exists, and credentials obtained during
`TASK_STATE_AUTH_REQUIRED` "MUST NOT be assumed to authorize subsequent messages" — i.e. even
its narrow authorization moments do not compose forward, let alone tighten transitively.
A remote A2A agent therefore inherits our ceiling **only when invoked through the gateway**;
the protocol cannot carry the constraint to sub-delegations the remote agent makes on its own
authority.

**Honest limits.** RegulAIt has no native A2A adapter today; the verified claim is our
internal lattice plus the gateway choke point (any third-party agent surfaced as a registry
agent or MCP server inherits it). A future A2A bridge would have to re-derive the ceiling at
its own boundary and accept that A2A gives it no downstream enforcement — that boundary, when
built, must join this conformance table as new rows, not weaken existing ones.
