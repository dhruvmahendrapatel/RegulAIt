# ADR-0168: Governance flow — one registry, a lifecycle tracker, and a review task with real outcomes

- **Status**: Accepted (owner, 2026-10-03)
- **Date**: 2026-10-03

## Context

The owner judged the governance flow — intake and decision — "raw and unfinished". Three inputs
shaped what it must contain: an AI-governance whitepaper (use-case record fields, approval
criteria, tiered routing, change-triggered re-review), *The governed agent* (agents as
non-human identities with a named steward and successor, least privilege, lifecycle reviews) and
NIST AI RMF 1.0 (MAP 1-5 context, MEASURE evidence, MANAGE 1.1 go/no-go with documented residual
risk, GOVERN 1.5 periodic review). The owner also supplied a walkthrough of an established
data-governance product's AI-governance tour as the target for flow and look; it is kept out of
this public repository, and nothing here copies its branding.

What the product had: three ways to propose a use case (the intake wizard, a four-step "Propose"
form on the register, a questionnaire drawer), three places to decide (Inbox, Approvals queue,
Review workbench) each with a bare Approve/Deny and a reason box, an approval that never expires,
one reviewer whatever the tier, and the proposer as the only owner.

## Decision

**The flow, as the owner set it (2026-10-03):**

1. **One entry point.** The intake wizard is the only way to propose an AI use case. The
   register's "Propose" form and the questionnaire drawer are removed; every "new use case"
   control opens the wizard.
2. **A registry, not a list.** Use cases (and, later, agents and models) live in one registry with
   headline counts, filterable columns (name, type, status, owner, tier, created) and a split
   "Register AI use case" action.
3. **Registration is short; the work is a tracked lifecycle.** Registration captures what is needed
   to start (name, purpose, owner) and shows similar existing use cases before a duplicate is
   created. The use case then carries a **lifecycle tracker** — Ideation → Under review → Approved
   / Monitoring — whose activities (business context, EU AI Act screening, data and models, risks
   and safeguards, sign-off) show status, assignee and last update, derived from records that
   already exist rather than re-typed.
4. **The decision is a task with real outcomes.** The reviewer works from one review panel that
   shows what is being decided (tier and why, risks with residual ratings, controls, the
   questionnaire, the stack) beside the decision. Outcomes: **approve**, **approve with
   conditions**, **send back for information**, **reject**.
5. **Conditions follow model-risk practice.** Each condition has an owner and a due date and is
   tagged by the reviewer as **before go-live** (it blocks deployment: the deploy gate refuses
   while it is open) or **after go-live** (tracked and escalated when overdue, never blocking).
6. **An approval has a lifetime.** Approval records a "valid until": **12 months** for minimal and
   limited tiers, **6 months** for high; a prohibited screening is never approvable. Expiry puts
   the use case back into review.
7. **Board roles and risk acceptance are configuration, not code** — an admin setting names the
   reviewer roles a tier routes to and who may accept risk. *(After 2026-10-05.)*
8. **Agent ownership follows the governed-agent model** — each agent is an identity in the agent
   inventory with a named steward, a successor and lifecycle reviews; use cases link to agents.
   *(After 2026-10-05.)*
9. **No change of stack.** The look comes from layout and design tokens (a navy header band per
   record, white cards on a light canvas, one accent, sentence case, generous spacing) on the
   existing React + Vite UI. Nothing in the reference requires a different framework.

**Scope before the 2026-10-05 demo** (owner: "half working is better than what we have now"):
items 1-6 for the demo path (intake → use-case record → review → approval), with the live demo
journey re-verified end to end before anything is pushed. Items 7-8, scheduled re-review jobs,
change-triggered re-review, a portfolio dashboard and a home "My tasks" view follow after.

## Consequences

- The demo script's intake, use-case and approval beats change wording and clicks; the script and
  the real-database journey test move with the code, never after it.
- "Approve with conditions" and "send back" are new decision values on the approvals API; old
  clients that send only approved/denied keep working.
- A blocking condition is one more reason the deploy gate can refuse, audited like the others.
- Expiry needs a sweep to flip expired approvals back into review; until that job exists the
  "valid until" date is displayed and enforced at the deploy gate, not swept.
- Removing two intake entry points deletes code and tests that exercised them; nothing else may
  create a use case outside the wizard's path (the API stays, for integrations).
