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

## Implementation (2026-10-05)

Built on four branches (A feed, B intake, C simulation and budget, D claims and UX), integrated on `cdx-int`. A security
review of the integrated branch found two medium-severity issues and eight low or informational ones; one fix round
closed them.

- **Simulation (C, plus review fixes 1, 4, 8).**
  - `governedEvaluate` takes `simulate.replay = { asOf, lookbackHorizon, countAllowed }`. A rate-limit rule is
    replayed against the calls recorded strictly before each sampled call. Where audit retention has pruned part of the
    window, the call is `indeterminate`, never counted as allowed.
  - Each count has one computation path: the batched database query.
  - The run is limited per caller and globally (`REGULAIT_POLICY_SIMULATION_MAX_PER_CALLER`, `_MAX_GLOBAL`; a refused
    run gets 429 `simulation_busy`).
  - The deadline (`REGULAIT_POLICY_SIMULATION_DEADLINE_MS`) is armed when the request arrives and also bounds database
    work. A run's reads share one transaction under `SET LOCAL statement_timeout`, set to the time left, and the
    deadline is checked between count chunks.
  - When the deadline hits, the run returns 200 `{status:"incomplete"}`, and the incomplete result is not stored.
  - Migration **0154** adds a partial index on the retention prune's marker rows, so finding the lookback horizon
    never scans the audit trail.
  - The audit prune deletes rows and writes its marker in one transaction.
  - ADR-0120's "exactly which recorded calls" now holds for rate-limit rules inside the retained audit window. Outside
    it, the result says indeterminate.
- **Budget cap (C).** A concurrent boundary test proves the documented bound: per cap, the overshoot is less than one
  call's cost for each call in flight when the cap is crossed. The bound is documented above `preDispatchProjectGate`.
- **Kong and SSO origin (D, plus review fixes 5, 7, 9).**
  - Kong plugin 0.4.0 tags every deny with `decidedWithout: ["args"]`, because the edge never forwards call
    arguments. The tag says the decision ran without them, not that their absence caused it; the rule id identifies a
    data-scope refusal.
  - jwt and key-auth credentials are detected correctly. A `jwt` credential accepts an asserted `oidc`, `saml` or
    `password` origin without checking the token issuer; the README and `GATEWAY_TOPOLOGY.md` say so.
  - The Lua spec runs under busted 2.3.0 on LuaJIT. The apt and rock versions are pinned, and the rockspec acts as
    the lockfile. luarocks cannot pin by hash, so the pins fix the versions but not the content.
  - Mixed-auth origin tests pin the existing behaviour.
- **Outlook ChatOps (D).** Registration returns 422 `outbound_provider_unavailable`. The channel list reports
  `outboundSupported`.
- **Feed (A).**
  - New `withdrawn` and `published` statuses, and the `law | guidance | voluntary_standard` instrument kinds.
  - Effective and enforcement dates are separate, and the feed takes a `?kind=` filter.
  - Corrected entries: CFPB withdrawn on 2025-05-12; NYC LL144 effective 2023-01-01 and enforced 2023-07-05; NIST and
    ISO marked voluntary.
- **Intake (B, plus review fixes 2, 3, 6).**
  - Creating an intake waits for a durable draft save.
  - A Back guard is added, and drafts are flushed with keepalive on unmount and on pagehide.
  - The risk and workflow-artifact posts take idempotency keys (`request_idempotency_keys`, migration 0153).
  - The artifact transition and the artifact commit in one transaction.
  - A replayed artifact request re-runs the use-case and vendor mirror. The mirror is compare-and-swap, so two racing
    syncs move and audit once. A replay does not re-run git executions; `/advance` retries a stuck stage.
  - New idempotency claims store only `{replayOf}`, and a replay is rebuilt under the record's read rule. Older claims
    that hold full bodies still replay exactly as stored.
  - The hourly `idempotency-key-sweep` job deletes claims older than 30 days from both idempotency tables.
  - Draft writes carry `x-regulait-draft-owner`. The gateway refuses a write naming a different user with 409
    `draft_owner_changed`, so an exit save queued before a sign-out never lands in the next user's account.
- **Migration numbering.** **0152 was never used and is retired**, like 0147 (ADR-0173). The journal skips it. Never add
  a migration numbered 0152, or one whose `when` is at or below 1785089000000 (0154's). The next migration is **0155**.
