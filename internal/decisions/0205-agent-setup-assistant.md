# ADR-0205: A governed, suggestion-only agent setup assistant

- **Status**: Proposed (HOLD PR, awaiting owner review)
- **Date**: 2026-10-30
- **Related**: ADR-0149 (the intake assistant this copies), ADR-0173 §3 (the model allow-list feature gate), ADR-0180
  and ADR-0181 (strict defaults, audited relaxation), ADR-0186 A (settings_relax step-up)
- **Migration**: 0215

## Context

The owner asked on 2026-10-30 (#453): "Users add agents and the Claude connected to the system automatically and helps
configure the agents." Since #601 an org can connect the `anthropic` provider through `POST /v1/model-credentials`. Today
an admin registers an agent by typing every field into the Register an agent card, and then sets grants, the per-user
policy, stewardship and the model card by hand on separate cards. Nothing guides the risk tier, least privilege or
approvals.

## Decision

1. **An org switch, off by default.** `org_settings.agent_setup_assist_enabled` (migration 0215), default `false`.
   Turning it on goes through `PUT /v1/org/settings`. The strictness registry records the change as a relaxation, so it
   needs a `settings_relax` step-up and is audited old -> new.
2. **`GET /v1/agents/setup-assist`** (admin) returns `{ enabled, connectedProviders }`. The card uses it to decide what to
   offer.
3. **`POST /v1/agents/setup-assist`** (admin) refuses with 409 `agent_setup_assist_disabled` while the switch is off. It
   writes nothing except one audit row (`agent-setup-assisted`). The row holds the suggested risk tier and the model
   outcome, never the admin's description.
   - **Rules half (always).** `suggestAgentSetup` in `@regulait/shared` drafts:
     - name and tier;
     - base system prompt and purpose;
     - risk tier, with the reason;
     - least-privilege grant advice (no one holds a new agent until someone is granted it);
     - an approval rule and a starting monthly budget per risk tier;
     - model-card intended use and limitations.
   - **Model half (optional).** This is the ADR-0149 path: `agentDecision` + `executeGovernedDispatch`, with the model
     allow-list feature `builder`. The call is therefore entitlement-checked, PII- and guardrail-screened, budgeted,
     metered and audited.
     - Outcomes are reported as they are: a refused, failed or unparseable reply says so, and the rules draft stands.
     - The model may rewrite the text fields. It may raise the risk tier but never lower it.
     - Every field says whether it came from `rules`, `mock` or `model`.
4. **Nothing applies itself.** In the console, "Use this draft in the form" fills the name, tier and system prompt of the
   Register form. The agent exists only when the admin presses Register (`POST /v1/agents`, unchanged). The admin applies
   grants, approvals, budget and the model card on their existing cards; the draft shows these as recommendations.
5. **Lazy-loaded UI.** The assistant panel is its own chunk, so the entry bundle does not grow.

## Open source first (ADR-0176)

No library makes this governance decision. The draft rules are policy semantics, the part ADR-0176 §4 keeps for us. The
model call reuses our existing governed dispatch and provider packages, so no new dependency is added.

## Verification

- `packages/shared/src/agent-setup-assist.test.ts` (6 tests):
  - sensitive work is rated high, a quiet summariser minimal (the negative control) and an agent that acts limited;
  - a smuggled `apply` key is refused;
  - fenced JSON is parsed and prose is refused;
  - a model can raise the tier but cannot lower it.
- `apps/gateway/src/zz-adr0205-agent-setup-assist.test.ts` (7 tests, mock provider, no key, no network):
  - the assistant is off by default (409) and turning it on is an audited relaxation;
  - the draft creates no agent, and the audit row omits the description;
  - an ungranted agent is refused with no dispatch;
  - an entitled agent's dispatch is metered and canned prose is not passed off as a draft;
  - it is admin-only, and an identity-less caller is refused.
- `apps/web/src/views/admin/integrations/agentSetupAssistant.test.tsx` (3 tests): a refusal shows inline, each field's
  source is labelled, and rendering a draft never applies it.

## Not done

- Applying grants, stewardship, the per-user budget and the model card from the draft in one confirmed step. They stay
  recommendations.
- No setting for which provider must be connected. Any stored model credential enables the model option, and the
  dispatch itself fails closed without one.
- Draft quality against a live model is unmeasured, because the keyless mock cannot exercise it.
