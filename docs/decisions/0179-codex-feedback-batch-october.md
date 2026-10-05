# ADR-0179: The October Codex feedback batch, with what we fix and what we state honestly

- **Status**: Accepted (owner, 2026-10-05; choices recorded below)
- **Date**: 2026-10-05
- **Builds on**: ADR-0120 (policy simulation), ADR-0158 (regulatory intelligence), ADR-0171 (intake recovery), the Kong
  adapter ADRs, ADR-0121 (Outlook send-only), the project budget gate

## Context

We triaged the open items in `codexInputs.md` against the current `main`. Still open and real:
- **G14-FEED:** wrong statuses and dates in the regulatory feed.
- **AER-050 (part):** intake recovery gaps.
- **AER-014:** the policy simulation replays rate limits against "now".
- **AER-016:** an unbounded simulation run.
- **AER-028 / AER-036 (part):** Kong and SSO claim boundaries.
- **AER-015 (residual):** Outlook ChatOps cards that can never be sent.
- **F03:** no concurrent test at the budget boundary.
- **UX-AG-1 / UX-AG-5:** two agent-page usability items.

AER-056 and the G10–G15 portability fixes are already merged and only need Codex to confirm.

## Decision

1. **Policy simulation (AER-014, AER-016): fix the replay and add limits** (owner).
   - Thread an optional `asOf` clock through `governedEvaluate`. A replayed rate limit then counts only the calls strictly
     before the recorded call. If the lookback window is truncated, the result is `indeterminate`.
   - A run is bounded by a per-caller and global concurrency limit and a deadline. When the deadline hits, the run
     returns an honest `incomplete` result instead of continuing.
   - Lookups are batched instead of one query per row.
   - Moving simulation to a background job is deferred.
   - Until the replay test lands, ADR-0120's "exactly which recorded calls" is qualified for rate limits.
2. **Kong edge and SSO session origin (AER-028, AER-036): narrow the claims** (owner).
   - Data-scope rules are not supported at the Kong edge; the plugin sends no arguments, so they always deny. The docs
     and harness say so.
   - For OIDC and SAML the session origin is asserted by the operator. Only key-auth and basic-auth derive it. A
     contradiction is still refused.
   - Add mixed-auth tests.
   - Forwarding a projection of arguments from Kong is future work.
3. **Outlook ChatOps (AER-015): refuse until it works** (owner). Registering Outlook for ChatOps approval cards is refused
   with a clear message until an outbound sender exists. Inbound email stays refused (ADR-0121).
4. **Project budget cap (F03): keep the documented threshold** (owner).
   - The call that first crosses the cap is the last one allowed.
   - Document the maximum overshoot per cap.
   - Add a concurrent test at the boundary that proves the bound.
   - A spend-hold ledger is future work.
5. **Settled under standing rules:**
   - **G14-FEED.** Ship the factual corrections:
     - a `withdrawn` status (the CFPB circular was withdrawn on 2025-05-12);
     - separate effective and enforcement dates (NYC LL144);
     - a `voluntary_standard` instrument kind, so NIST and ISO are not counted as "in force".

     A legal review of applicability is still pending, and no new legal conclusions are added.
   - **AER-050.** Close the intake recovery gaps:
     - creation waits for a durable draft save;
     - a browser Back guard (a popstate guard and a keepalive flush, not a router migration);
     - idempotency keys on the risk and artifact posts;
     - tests for session expiry and for user A / user B isolation.
   - **UX-AG-1 / UX-AG-5.** Saving the agent fallback chain becomes an explicit step, and the role-grant tooltip links to
     the role page.

## Consequences

- Each decision either fixes the code or narrows the claim to what the code does. No claim stays stronger than its test.
- F06/F07 (real-provider journeys, the restore drill, the signing keyring) and the carried-over AER-006 and AER-011 still
  depend on the owner: a credential, a key custodian, and a UI-versus-API decision. Production stays gated by the
  standing guardrail.
