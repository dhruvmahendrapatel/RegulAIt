# ADR-0217: Automatic re-test after a model change

- **Status**: Accepted
- **Date**: 2026-10-30

## Context

The owner started backlog item P16 on 2026-10-30 (#453, comment 6522850568, wave 1: branch `builder/p16-auto-retest`,
migration 0237, this ADR).

Today a model or configuration change on a certified card's subject counts as certification drift. By default
(`mrmEnforced`, `mrmStalenessRecertEnabled`, ADR-0181) that drift refuses dispatch until a person signs off again, on
the same 409 path as ADR-0045 expiry (ADR-0086 §3 follow-up). Nothing re-measured the changed model, though. The
eval-drift sweep (ADR-0044 §5, with ADR-0173's re-run on a configuration change) and the red-team sweep (ADR-0057)
repeat pairs on their own schedule, and neither tied its results to the re-certification. So the person signing off
saw the drift, but no fresh evidence about the model as it now is.

## Decision

1. **A new org setting, `mrmAutoRetestEnabled`, off by default.** Re-testing spends model tokens for the org, so the
   strict value is off (ADR-0180). Turning it on counts as a relaxation (`notEqual(false)` in the strictness registry).
   It goes through `PUT /v1/org/settings`, which asks for the `settings_relax` step-up and names the key in the audit
   row's `detail.relaxed`. Turning it off needs nothing.
2. **What triggers it.** A pass checks each certified agent card. It acts when the card's drift since certification
   includes a configuration change (`driftSinceCertification.configChanges > 0`). That covers a model, prompt or
   endpoint change, which is how a new or fine-tuned version reaches dispatch. The drift key is the certification time
   plus the change count, so a later change is a new drift and gets re-tested again.
3. **What it runs.** Only suites a person already chose for that agent:
   - each pinned eval baseline (one per dataset, current scoring semantics only, as the drift sweep does);
   - each published red-team library the agent has been probed with.

   At most 10 suites run per drift; any beyond that are recorded as skipped. No new pairing is ever invented.
4. **How it runs.** Each (card, drift, suite) is claimed once by a unique row in `mrm_retest_runs` (migration 0237),
   in the same transaction as its audit row. The suite then goes through the ordinary `runEvalSuite` /
   `runRedTeamSuite`:
   - **Whose authority.** The suite runs as the person who ran it before, under their entitlements. A suite whose
     person is gone is skipped and never run as somebody else.
   - **Attribution and budget (pillar 5).** It is billed to that run's project. A project already over its budget is
     refused before any call. The dispatch core still applies the project gate, usage attribution, the per-run caps
     (judgement budget, trial cap) and the sensitive-set approval hold on every call.
   - **Staleness exemption.** The calls are evaluation dispatches, so they pass the staleness gate under ADR-0181's
     exemption. The base MRM gate still applies.
   - **Outcome.** The result row is updated and audited with one of:
     - `passed`: the runner's own gate passed on at least one case;
     - `failed_gate`;
     - `reported`: the run produced no verdict, for example a library that exercised no gating class;
     - `refused`, with the reason;
     - `skipped`.
5. **Where results attach.** A re-test is linked to the card's re-certification request:
   - to the pending request, if there is one when the re-test finishes;
   - otherwise to the next request created through `POST /v1/mrm/cards/:id/sign-off`, in the same transaction, which
     records `retestsAttached`.

   The card read shows each request's re-tests, plus those still waiting for a request. On the Model risk page, the
   results appear under the request in the sign-off history.
6. **It never replaces the human sign-off.** A re-test does not clear drift and does not decide anything. The card
   stays stale, and dispatch stays refused, until a person decides the request in the Approvals Queue. A re-test that
   regresses or fails its gate is itself drift, the same as any server-started run.
7. **What drives it.** The `mrm-auto-retest-sweep` scheduler job runs hourly. It is a no-op while the setting is off,
   and it spends tokens only on a change that has not yet been re-tested.

## Consequences

- The human who signs off a re-certification sees the measured effect of the change next to the decision.
- An org that turns this on and also runs the ADR-0173 configuration-change re-run will re-run a pinned eval baseline
  twice for one change: once on the baseline's own schedule and once here. Both are attributed and budgeted; the
  duplication is accepted, so that this feature does not depend on that sweep's schedule.
- Not covered:
  - custom-provider cards, since their subject has no single agent to re-test;
  - recording merges and quantisations as lineage events (the second half of P16 in PENDING.md), which needs a
    lineage model first;
  - per-risk-tier required test classes. Re-tests repeat what a person already chose; they do not decide what
    should have been chosen.
- Open-source check (ADR-0176): this is governance logic over our own runners and ledgers. The scheduler, runners and
  budget gates already exist, so no external module applies.
