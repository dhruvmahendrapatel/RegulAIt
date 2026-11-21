<!-- fold: pending -->

**Agentic-governance checklist gaps (owner request, 2026-11-20).** The owner compared the product against a 20-term
agentic AI governance checklist. Against the code on main at `05aa62930`, 16 terms are met and 4 are partial, with no
term missing. The new items are below; items already in flight are listed for completeness.
- **New: memory poisoning (OWASP ASI06).** The ADR-0193 content-trust floor gates only write tool calls. The
  shared-context and memory write route is not gated yet (`packages/shared/src/agent-risk-proofs.ts`, the
  `memory.untrusted_context_write` proof). Put memory and shared-context writes behind the floor plus an injection
  scan, then widen that proof to cover them. Secure by default (ADR-0180): blocking is on unless an admin relaxes it.
- **New: oversight levels enforced at runtime.** The autonomy classes assist, supervised, delegated and autonomous map
  onto in-the-loop, on-the-loop and out-of-the-loop, and each agent has its class (`/v1/builder/agents/:id/autonomy`).
  An unmet floor, though, becomes only a use-case condition or a monitor finding (`apps/gateway/src/autonomy.ts`). Make
  an unmet floor block dispatch for `delegated` and `autonomous` agents until the floors for their risk tier are met.
  An admin may relax this, and the change is audited.
- **In flight: goal hijack (OWASP ASI01).** A runtime check that each tool call fits the agent's declared purpose,
  steering or blocking it when it diverges. Graduated steering responses are open PR #960 (its ADR is in that PR); the
  goal-alignment check itself is not yet specified.
- **In flight: rogue agent (OWASP ASI10).** Per-install behaviour baselines with explainable findings in shadow mode
  are open PR #966 (its ADR is in that PR).
- **New: rogue-agent containment.** An automatic safe-mode trigger when an agent acts out of role. It is not yet
  specified, and #966 does not include it.
- **In flight: scoped credentials and sandboxing.** Credential revocation and the status list are open PR #1117
  (ADR-0315 slice 2). The sandboxed browser robot runner is open PR #1082 (ADR-0364 S3).
