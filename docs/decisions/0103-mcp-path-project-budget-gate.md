# ADR-0103 — Gate the MCP tool-call path on the project budget, in the one shared primitive

- **Status**: Accepted
- **Date**: 2026-09-07
- **Relates to**: [ADR-0019](0019-per-user-revocation-and-full-attribution.md) (pillar-5 project attribution, and the §8.4 PII
  enforcement whose siting this copies), [ADR-0024](0024-interception-depth-metering-scope-custody.md) (O11 — the
  Unattributed bucket, the defined treatment of a null project),
  [ADR-0021](0021-org-settings-configurability-layer.md) (`budgetHardBlockPct`,
  `budgetEnforcement` warn_only vs block), [ADR-0027](0027-backend-orphans.md)
  (O2 — the framework budget CEILING and its strictest-wins enforcement floor; O10 — tool-first
  MCP pricing), [ADR-0023](0023-schema-depth-credential-json-systemprompt-mcpmode.md) (`mcpDefaultMode` read_only enforcement —
  the neighbour this gate is ordered against), [ADR-0070](0070-trace-observability.md) (the tool span a
  refusal must still close)
- **Migration**: none. Pure code — the gate reuses an existing function and adds no column.

## Context

Pillar 5's promise is that a project's spend is both *attributed* and *bounded*.
`preDispatchProjectGate` (`apps/gateway/src/projects.ts`) is the whole of the second half: it reads
the project's MEASURED spend, composes it against the effective budget, escalates the crossing into
the one approvals queue, and returns a 409 `project_budget_exceeded` once the hard-block threshold
is reached.

**It had exactly one production call site**: `apps/gateway/src/agents-connectors.ts`, the
model/connector dispatch path.

The MCP tool-call path never reached it. `executeGovernedToolCallInner`
(`apps/gateway/src/mcp-proxy.ts`) evaluated entitlement, the ADR-0023 read-only posture, approvals,
PII and guardrails — and had no project-budget dimension at all, nor did `governedEvaluate`
underneath it.

MCP calls were nonetheless **priced** and **attributed**. Price resolves tool-first with the
server's flat rate as fallback (`mcp_tools.price_per_call_usd ?? mcp_servers.price_per_call_usd`,
ADR-0027 O10), and every allowed call writes a `usage_events` row carrying `projectId`. That spend
counts toward `projectSpendUsd` — which is precisely what `preDispatchProjectGate` reads.

So the money was **metered and attributed, but never gated**. Set `x-regulait-project-id`, loop
`tools/call`, and paid spend ran unbounded against an already-exhausted project.

Two properties make this worse than a plain missing check:

1. **The symptom appeared somewhere other than the cause.** The overspend was not silent; it
   surfaced later — as a 409 on the *model* path, the moment the user's next agent dispatch hit the
   gate. An operator reading that 409 sees a model dispatch refused for a budget that a *tool* loop
   spent. The path that overspent is the one path that never complains.
2. **Nothing asserted it.** `compliance-cost.test.ts` calls `preDispatchProjectGate` directly, and
   `mcp-tool-pricing.test.ts` covers pricing and attribution but not gating. No test in the repo
   put a paid tool call and an exhausted project in the same sentence.

## Decision

**Site the gate inside `executeGovernedToolCallInner`, once, and reuse the existing function.**

### 1. In the shared primitive, not at the callers

There are exactly two production entry points into the governed tool call, and both funnel through
this one function:

- `mcp-proxy.ts` — the direct MCP proxy route (`tools/call`)
- `orchestration.ts` — pillar 7's delegated worker loop

Adding the gate at each caller was rejected. This codebase already made this decision twice, in
this same function: §8.4 PII enforcement and the ADR-0023 `mcpDefaultMode` read-only enforcement
both live *inside* the primitive precisely so neither entry point can be built without them. A
per-caller check makes the control a convention, and the property that actually matters here —
**a delegated worker cannot spend what a direct caller cannot** — stops being structural and
becomes a thing someone remembered. The third entry point, whenever it is written, inherits the
gate without its author knowing this ADR exists.

### 2. Where in the order, and why

The gate sits **after** the governed-deny return and **after** the ADR-0023 read-only enforcement,
and **before** the `require_approval` queueing block.

- **Entitlement deny and the compliance read_only posture stay ahead of it.** Both are categorical
  and cheaper: no amount of remaining budget makes a forbidden call permissible, and answering
  "you may not call this tool at all" with "your project is out of money" would be a worse
  message, not a better one.
- **Budget beats approval QUEUEING.** Piling a pending approval onto the queue for a call that
  cannot run regardless is noise for the approver — an entry that, if signed, still fails.

Everything else follows from one requirement: **a budget-blocked call must execute nothing, consume
nothing and bill nothing.** So the gate is strictly before the approval is *consumed* (an
atomically-spent approval that then does not run is a lost approval), before the PII and guardrail
work, and before `connectUpstream` — the upstream is never contacted at all. This is the same
ordering guarantee the ADR-0023 block above it already states for itself.

### 3. The gate is REUSED, not reimplemented

The new code calls `preDispatchProjectGate(db, projectId, userId)` and maps its result. It does not
fork the logic, and this is the substance of the decision rather than a stylistic note, because the
gate already carries a great deal that a second implementation would have quietly dropped:

| carried over | what it means on the MCP path now |
| --- | --- |
| null project → pass | unattributed calls are untouched (§4 below) |
| unknown project → 422 | a bogus attribution is refused, not billed |
| ADR-0027 ceiling | effective budget is `min(project budget, framework ceiling)`, and the ceiling caps an **unbudgeted** project too |
| `overageActive` | a sanctioned overage lets tool calls through, exactly as it does model dispatches |
| ADR-0021 `budgetHardBlockPct` | the hard block engages where the org configured it, not at a second hard-coded 100% |
| `warn_only` vs `block`, strictest-wins | a framework's `block` still overrides an org `warn_only` |
| `escalateProjectBudget` | the crossing lands in the ONE approvals queue with its audit row — a tool-driven crossing is not a second, parallel escalation path |

A forked check would have had to re-derive all seven, and the compliance ceiling in particular is
the kind of thing a second implementation forgets in a way nobody notices until an audit.

### 4. Unattributed calls: the defined treatment, unchanged

A call with `projectId == null` passes straight through, byte-identical to today, and meters into
the null-project bucket surfaced by `GET /v1/costs/unattributed`.

This is stated here as the **defined** treatment, not tolerated as a gap. F02 asked for the
treatment to be defined; it did not ask for it to change. A null-project usage row can never belong
to a project ledger, so there is no project budget for it to have exceeded — inventing one would
mean assigning unattributed spend to some project, which is the attribution dishonesty ADR-0024 O11
exists to refuse. The lever for an operator who wants no unattributed MCP traffic already exists
and is untouched: `requireMcpAttribution`, which rejects the call at the route for having no
project at all.

### 5. The outcome variant, and both call sites

A new `GovernedToolCallOutcome` variant — `{ kind: "budget_blocked"; status; error; detail? }` —
carries the gate's own `409` / `project_budget_exceeded` verbatim, so the MCP surface and the model
surface name one condition identically rather than inventing a second vocabulary for it. The
outcome switch is exhaustive with no `default`, so the compiler forced both call sites to handle
it; that was left deliberately unsoftened.

- **Proxy route**: an `McpError(ErrorCode.InvalidRequest, "Denied by policy: …")` in the same shape
  as the neighbouring `denied` / `pii_blocked` cases.
- **Worker loop**: an `isError` `tool_result` reading `blocked by governance: …` — the same shape
  the loop already uses for a governed denial, so the model reacts to a refusal instead of the loop
  crashing, and the run's append-only history records `status: "budget_blocked"`.
- **ADR-0070 span**: a budget block is a `denied`-status span carrying its reason, exactly as
  `pii_blocked` is — never an absent span. A refusal that leaves no trace is the failure mode
  tracing exists to prevent.

The block is also written as **one audit row** (`ruleId: "project-budget-cap"`, `effect: "deny"`,
with the tool, server and project on it), alongside the escalation row `preDispatchProjectGate`
itself files. The two are different facts: one says the project crossed its budget, the other says
this specific tool call was refused because of it.

## What this deliberately does NOT do

- **It does not reserve.** See the honest limits below — this is a measured-spend gate, and the
  first crossing is allowed by design.
- **It does not change what a call costs, or where it bills.** Pricing and attribution are
  untouched; only the allow/refuse decision is new.
- **It does not gate on the price of *this* call.** The gate keys on the project's measured spend.
  An unpriced tool on an exhausted project is therefore blocked too. That is the reused gate's
  behaviour, stated and pinned by test rather than special-cased: adding "free calls pass" would
  have been a second, divergent budget semantics on one of the three entry points, and a
  nominally-free tool is still an upstream side effect run on an exhausted project's behalf.
- **It does not touch the run/node budget.** `gateNodeStartBudget` in `orchestration.ts` enforces
  `run.budget` with its own `__budget__`/`__nodebudget__` approvals. That is a genuinely different
  ledger and it is left alone; a run under its own cap can still be refused by its project's
  budget, and vice versa.
- **It adds no knob.** The existing org and compliance dials (`budgetHardBlockPct`,
  `budgetEnforcement`, the framework ceiling) already govern this gate; a second switch that
  exempted MCP specifically would recreate the hole.

## Honest limits

- **Measured spend, first crossing allowed — this is a gate, not a reservation.** The gate reads
  spend already recorded. A call in flight, or several concurrent calls that each pass the gate
  before any of them writes its usage row, can still carry the project past the ceiling. This is
  the same semantics the model path has always had, and it is the honest one while measured cost is
  only knowable after the call. It is nonetheless a real residue: **this is finding F03, and it is
  out of scope here.** Closing it needs a reservation/hold ledger, not another call site.
- **It gates the governed path, not the upstream.** A tool that a project already paid to call can
  still have had side effects; nothing here is a refund.
- **Unattributed traffic remains unbounded by any project budget**, by the definition in §4.
- **The audit row is not transactional with the refusal.** As elsewhere in this codebase, the deny
  row and the return are separate statements.

## Non-vacuity (M-002, measured)

The gate call was neutralised in place (`preDispatchProjectGate` still called, its result never
acted on — a true no-op, with no unreachable code for the compiler to reject) and the suite re-run.

**5 of 8 tests reddened**: the block-and-contact-nothing case, the audit-row case, the
unpriced-tool-on-an-exhausted-project case, the direct MCP proxy route case (`tools/call` with the
project header), and the delegated worker-loop case.

**The 3 that correctly stayed GREEN are the point of the exercise**: the unattributed call, the
`warn_only` call, and the healthy under-budget call. All three assert that behaviour is
*unchanged*, so a no-op gate must leave them passing — a guard that reddened under a neutralised
gate would have been asserting the wrong thing. The probe was reverted exactly; `git status` clean
before this ADR was written.

The upstream-contact proof is deliberately stronger than "an error came back": the fake upstream
counts **both** its HTTP requests and its tool-handler invocations, and every blocked case asserts
a zero delta on both. An MCP error with the upstream already spoken to would have failed the test.
