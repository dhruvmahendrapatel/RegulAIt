# RegulAIt vs the LLM-gateway tier
*LiteLLM · Portkey (Palo Alto Prisma AIRS) · Cloudflare AI Gateway · Kong AI · TrueFoundry ·
Helicone/Langfuse-class observability — profiles and consolidation events (2026) in
[MARKET_ANALYSIS_2026-08.md](MARKET_ANALYSIS_2026-08.md). RegulAIt cells cite ADRs; theirs are
vendor-doc sourced, dated 2026-08-15.*

**The one-line difference:** a gateway moves calls and meters them; RegulAIt is a gateway with
a **compliance spine** — the parts a proxy cannot retrofit, because they have to be designed
into the same object model as enforcement.

| Capability | Gateway tier (typical best) | RegulAIt |
|---|---|---|
| Call proxying, keys, rate limits, fallbacks | Mature everywhere | Parity: virtual keys + ceilings (ADR-0066), fallback chains with entitlement re-check per rung, rate limits |
| Per-user, per-tool governance | API-key/team scoping; content guardrails via partners | Default-deny **per user × per tool × per mode × per object**, roles, revocations, delegation windows with self-review guards (pillar 1; ADR-0022 amendments) |
| Compliance vocabulary | None — no packs, no cascade, no evidence model | Packs with query-backed evidence; one tag cascades into stages/PII/retention (ADR-0058, §8.3) |
| Audit | Request logs, observability traces | Governance audit: hash-chained, WORM-anchored, deny-with-reason as a first-class span with honest OTel status (ADR-0060/0070) |
| Orchestration governance | Absent (they see single calls) | Task-graph runs where every worker inherits and **never exceeds** the initiator — tighten-only proven as a conformance table (pillar 7; ADR-0078) |
| SDLC / PM integration | Absent | Plan-gated PR-shaped workflows; ADO/Jira/Linear as source of truth (pillars 2/8) |
| Cost | Per-key/team metering; unified billing (Cloudflare) | Per-project attribution + budgets→approvals + metered/imported kept apart + roster attribution of vendor spend (ADR-0069/0076) — the join none of them ship |
| Where THEY are ahead — honestly | Provider breadth at scale, hosted-edge latency, ecosystem plugins, and **live-traffic mileage we do not have** — our provider paths are mechanism-proven, instrument-unverified until a real credential is connected | Stated in every analysis; the market queue's #1 item |
