# ADR-0124 — The kill switch and safe modes: one dial, three scopes, and the paths it deliberately does not stop

- **Status**: Accepted
- **Date**: 2026-09-25
- **Relates to**: [ADR-0009](0009-typescript-fastify-stack.md) (the hand-rolled pure policy kernel
  these three entry points live in), [ADR-0079](0079-plan-only-stage-enforcement.md) (plan-safe modes, whose vocabulary
  moves into the kernel here), [ADR-0104](0104-approval-payload-binding.md) /
  [ADR-0105](0105-consent-context-binding-and-expiry.md) (the approvals queue `require_approval` mode hands
  work to), [ADR-0118](0118-hardened-posture-preset.md) (the posture read this reports beside — and
  the preset it is deliberately **not** part of)
- **Migration**: [`0114_execution_kill_switch.sql`](../../packages/db/migrations/0114_execution_kill_switch.sql)

## Context

An honest audit of this product against ISACA's *Cybersecurity Recommendations for Securing AI
Agents* (2026) scored 4 full, 9 partial, 2 absent — and **both absences were in the same practice
category**: *Reliability, Resilience, Kill Switches and Safe Degradation*. There was no global stop,
no per-tool emergency disable, and no read-only or recommendation-only mode at any scope.

That is a conspicuous gap for a governance product, and it is the first thing a CISO asks about. It
was also an odd one, because every *primitive* already existed: `agents.enabled` is enforced in the
kernel, plan-only stages already refuse mutating modes, connector grants already have a `read` mode.
What was missing was anything that reads as an **emergency control** — one thing an operator can
reach for at 3am, that stops what is running, that can be lifted, and that leaves a record.

## Decision

### 1. One dial, four positions, checked first

`org_settings.execution_mode`, consulted ahead of every grant, rule, limit and scope:

| mode | what it does |
|---|---|
| `normal` | the default; adds nothing to any decision |
| `read_only` | reads pass, writes are refused |
| `require_approval` | nothing runs unattended — queued where a queue exists, refused where none does |
| `halted` | the kill switch: every governed call refused |

### 2. It is a REQUIRED kernel input, and that is the whole design

There are three governed entry points — `evaluate` (MCP tools), `evaluateAgent` (model dispatch),
`evaluateConnector` — and every effectful path in the product reaches one of them. The gate lives
inside those three, so a new caller inherits it without knowing it exists.

`execution` is **required** on all three input types. It could have been optional with a safe
default, and that is precisely the shape that rots: a future call site omits it, the deployment
believes it is halted, and one path keeps running. Required means the **compiler** enumerates the
call sites — now, and for every one added later. That is why this change touched 148 of them.

The gate can only ever restrict. It returns either "nothing to say" or a restriction; there is no
input for which it returns an `allow`, which is what makes it safe to consult before everything
else. A unit test asserts that exhaustively across the mode × isWrite × canQueue space.

### 3. Three scopes, because "stop everything" is usually the wrong tool

ISACA asks for "global **and per-capability** kill switches", and the reason is operational: an
incident confined to one tool should not cost you the business.

- **Deployment** — the dial above.
- **Agent** — `agents.halted_at` / `halted_reason` / `halted_by_user_id`.
- **Tool** — the same three columns on `mcp_tools`.

A subject halt **outranks the dial**: a halted tool is refused even while the deployment is
`normal`, because an operator who stopped one thing during an incident meant it.

**The halt columns are deliberately separate from `agents.enabled`.** Those are different facts:
`enabled = false` means "not in service" — a registry decision, possibly months old — while a halt
means "stopped during an incident". Collapsing them would mean that lifting a halt silently returns
an agent to service that somebody had deliberately retired, which is exactly the quiet widening this
product refuses everywhere else. The unhalt route says which of the two you are in.

### 4. A reason is required to restrict AND to lift

Enforced by DB CHECK, not just by the route: "halted with no reason" is unrepresentable. An
emergency stop with no stated reason is an outage of unknown cause, and whoever lifts it is usually
not whoever threw it.

Lifting requires one too, and that is the less obvious half: *"why was it safe to resume?"* is the
question an auditor asks afterwards, and it is the harder of the two. Both directions are audited
under **distinct rule ids** — "who stopped the platform" and "who restarted it, on what authority"
are different questions and one shared id would answer neither well.

### 5. What it deliberately does NOT stop

This section is the one to read before changing anything here.

- **Reading.** The audit trail, the approvals queue, the posture page and `GET /v1/execution` are
  never gated. A kill switch that locked the door behind you would be a worse outage than the one it
  was thrown for. `GET /v1/execution` is not even admin-only: it is what somebody opens when their
  work starts being refused, and *"the deployment is halted"* is a far better answer than a silent
  denial that reads as lost access.
- **Discovery.** `visibleTools`, the `/v1/models` listing and the copilot's connector list all
  ignore the dial. Visibility answers *what is this user entitled to*; the dial answers *may it run
  right now*. Emptying those lists during a halt looks exactly like revoked entitlements — the worst
  thing to show an operator mid-incident — and leaves a client with nothing to name in the call that
  should come back saying the deployment is halted.
- **The platform's own governance sweeps.** Model-card expiry, MCP admission re-scan, red-team runs
  and SLA timers keep running while halted. They are the product governing *itself*, they dispatch
  nothing on a user's behalf, and going blind during an incident is the opposite of what a halt is
  for.
- **Evaluation that executes nothing.** ADR-0120's policy simulation and ADR-0057's red-team
  adjudicator ask the kernel what it *would* decide. Gating them would make every preview and every
  probe report "refused, deployment halted" — saying nothing about the policy or the platform's
  resistance, and destroying the evidence a halted deployment most needs. The constant they use is
  named `EVALUATION_ONLY_EXECUTION` so that reaching for it reads as a claim, checkable in review.
- **Queued work.** A halt makes pending approvals unspendable; it does not supersede, cancel or
  delete them. When it lifts, the queue is where you left it. A kill switch that also tidied up is
  one an operator hesitates to use, and hesitation is the failure mode.

### 6. `require_approval` is asymmetric, and says so

Only the MCP tool path can genuinely queue. `AgentDecision` and `ConnectorDecision` cannot even
*express* `require_approval` — their effect unions are `allow | deny` — and those routes have no
per-call approval queue to hand work to.

So the gate takes `canQueue` explicitly: it queues on the tool path and **refuses** on the other
two, with a reason that says why and points at `read_only` instead. A mode that silently denied
where it claimed to queue would be worse than not offering the mode. The asymmetry is surfaced on
the dial's own description, and a test asserts it in both directions so it cannot quietly become
"refuses everywhere".

Building it surfaced two real defects, both now fixed:

- `approvals.rule_id` is a **uuid** referring to an `approval_rules` row. An ordinary
  `require_approval` carries one; the dial's does not, because no rule row demanded it — the
  deployment's posture did. Writing the symbolic id raised `22P02` and failed the queue outright.
  That is **M-039** again: a column's type is a claim about every producer.
- `approvals.approver_user_id` is **NOT NULL**, so *"nothing runs unattended"* has to say who is
  attending. The mode now requires an `approverUserId`, enforced by the route and by a DB CHECK, and
  cleared on any mode change away from it so a stale approver cannot be resurrected by a later flip.

### 7. It is reported on the posture page, and is NOT part of the hardened preset

`GET /v1/org/posture` grows an `execution` field, and the page shows it first when it is restricted.

It is deliberately **not** one of ADR-0118's settable controls. If it were, then "harden this
deployment" would mean "halt this deployment" — which is not a hardened posture, it is an outage.
`normal` is the correct steady state of a fully hardened install. The code says so where a future
reviewer will be tempted.

## Consequences

**Easier.** There is now one thing to reach for, at the scope the incident actually has. ISACA
checklist item 14 moves from *absent* to substantially covered, and the answer to "what happens if
an agent goes wrong at 3am?" is a demo rather than a roadmap item.

**What this costs.** Every kernel evaluation now resolves a posture, which is one org-settings read
(already on nearly every governed path) plus a subject lookup on the paths that name one. The halt
columns carry partial indexes covering only the halted rows, because the answer is almost always
"no".

**What it is not.** It stops calls that pass through this gateway. Traffic that never reaches us is
*discovered* (ADR-0055/0122), not stopped — a halt does not reach a developer's direct API key to a
provider, and the read endpoint does not pretend otherwise.

**Follow-up this creates.**

- ~~**No UI for throwing it.**~~ **Closed.** `/admin/execution` is the operator's screen: the
  current state first, all four positions with their blast radius in prose, per-agent and
  per-tool halts below the dial (the narrower control should be the easier one to reach), one
  reason box that refuses a terse reason before the round trip, and a statement of what survives
  a halt — because an operator who does not know whether the audit trail keeps working will
  hesitate, and hesitation is the failure mode. Four Playwright tests drive it, one of which
  reloads the page **while the deployment is halted**: a control surface that dies with the thing
  it controls is not a control surface.
- **No scheduled or automatic halt.** Nothing trips this on its own — no "halt if the red-team ASR
  crosses a threshold", no dead-man's switch. Every position is an operator's deliberate act, which
  is the right default and a real limitation.
- **`require_approval` has one approver for the whole deployment.** Quorum and per-scope approvers
  are what ADR-0104's rule machinery already does per rule; the dial does not reach that yet.
- **Per-connector halt** does not exist — the dial governs connectors, but there is no way to stop
  one connector the way you can stop one tool.
