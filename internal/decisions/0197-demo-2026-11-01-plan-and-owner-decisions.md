# ADR-0197: Demo of 2026-11-01, real-account Shadow AI discovery, and the owner decisions of 2026-10-18

- **Status**: Accepted
- **Date**: 2026-10-18

## Context
The owner has a product demo on 2026-11-01. The governance flow and Shadow AI must look excellent.

On 2026-10-18 a read-only survey of main found:
- **Shadow AI UI.** It is complete and in the navigation: findings with sightings, remediation plans, discovery sources, cloud federation, endpoint import and the endpoint agent.
- **Demo data.** `demo:prepare` seeds only the four imported `saas_export` findings from the 2026-10-05 demo. It creates no discovery sources, scans, devices, remediation workflows or provenance records, so the new screens would be empty.
- **UI bars.**
  - The ADR-0196 ratchets are at zero except two state findings, one of them on the intake screen.
  - The design-token ratchet stands at 739 findings; lane U3 is not built.
  - The harness has only seen screens in their error state.
- **Demo script.** The 2026-10-05 script presents Shadow AI as import-only.

The repository already supports `repo_gitlab`, keyless `aws_web_identity`, `aws_assume_role` and Azure federated-credential scans. None of them had run against a real account.

The owner wants discovery to run against a real GitLab account, a real AWS account and a real Azure account.

## Decision (owner, 2026-10-18; the master session's recommendations, chosen by the owner)

### Demo setup
1. The demo runs on the hosted dev instance over public HTTPS. The laptop is only a browser.
2. **AWS target.** A new sandbox account in our AWS Organization holds only planted demo AI resources.
   - This amends ADR-0002 and ADR-0004 (two accounts become three).
   - The sandbox is non-production: it gets no `prod`/`production` tag, account or role.
3. **Authentication: keyless federation.**
   - AWS: an IAM role trusts RegulAIt's federation issuer (ADR-0195 SD2b).
   - Azure: an Entra app registration has a federated credential for that issuer.
   - No long-lived cloud secret is stored. The issuer's discovery document and JWKS must be publicly reachable from the dev instance.
4. **Spend.** At most USD 50 in total for planted AI activity through November:
   - small Bedrock usage with CloudTrail;
   - one small Azure OpenAI deployment;
   - a budget alarm at 80%;
   - teardown after the demo.
5. **GitLab.** A demo group on gitlab.com with a few repositories that use AI SDKs, read through a group access token with `read_api` and `read_repository` scopes only.
   - The token is stored encrypted in RegulAIt and never committed.
6. **Infrastructure.** Builders write it as Terraform under `infra/`, keeping modules project-agnostic.
   - The owner runs or approves every apply.
   - Runbook steps not yet run are marked "pending execution" (M-041).
7. **Fallback.** `demo:prepare` also seeds a realistic discovery dataset through the real API paths, and a screen recording of a real scan is kept. A failed live call never leaves an empty screen.
8. **Names on screen.** Sandbox resources use fictional demo-company names and hold no personal data. Pseudonymisation stays on by default.
9. **Freeze and story.** Code freeze on 2026-10-29: after that only demo-blocker fixes merge.
   - The story opens with Shadow AI: real discovery across GitLab, AWS, Azure and an endpoint device, then sightings, then a remediation plan, the approval workflow and registering the use case.
   - The governance beats follow.
10. **Merge guard until the demo.** Every check-in audits merges against the merge loop's log, and any merge the master did not release is reverted at once. After the demo, a separate agent identity without merge rights is set up.
    - Required human review was considered and is not workable today: every PR is opened by the owner's account, and GitHub does not count an author's own approval.

### Owner questions 1-15
- **Q1, #414's merge:** unconfirmed (the owner does not remember). Recorded as unconfirmed.
- **Q2, engine image signing:** keyless, using cosign with the CI identity token and the public transparency log. Air-gapped installs verify with a bundled trust root.
- **Q3:** stdio relaxations for a person (ADR-0190 A1) expire by default, renewable through an audited step-up.
- **Q4:** the GitHub `release` environment is protected, with the owner as required reviewer, before any signing secret exists. This is an owner action.
- **Q5:** emergency retirement of the receipt key in use stays refused. Rotate first.
- **Q6:** recording a data-key custody attestation requires the `key_management` step-up.
- **Q7:** the A4 remediation plan keeps the second-approver default.
- **Q8:** the A4 pending link stays initiator-only.
- **Q9:** the text of our own trigger `RAISE` messages stays withheld from logs.
- **Q10:** replace the hand-written error-to-log helper with the logging library's standard `{ err }` serializer now, before the freeze.
- **Q11:** a design review of the separate RS256 federation issuer (#420) happens before the demo, and any change it calls for lands before the demo. If the separate issuer is needed, it stays.
- **Q12:** the AWS trust mode stays per discovery source, defaulting to keyless OIDC.
- **Q13:** an enrolment token may be extended beyond 30 days only as an audited step-up relaxation. The default stays 30 days.
- **Q14:** revoking an enrolment token stops new enrolments. The revoke dialog also offers "revoke the devices it enrolled" as a separate choice.
- **Q15:** see decision 10.

## Consequences
- **Work plan** (parallel sessions, non-overlapping files, each reviewed before release):
  - **P0:**
    - a seeded discovery dataset and `demo:check`;
    - real-account infrastructure (Terraform and runbooks for the sandbox account, Azure, GitLab, and a publicly reachable issuer);
    - visual consistency (U3) on the demo screens first, plus the intake error state;
    - a populated-state screenshot pack and visual QA, after the dataset merges;
    - demo script v3, talk track, Q&A and leave-behind;
    - the Q11 design review.
  - **P1:** the Firefox `/account` load flake; the low-severity findings on demoed screens.
  - **P2:**
    - A5 federated git credentials, after the Q11 review;
    - N10 lock-update bot;
    - SPIFFE bundle fetch and JWT-SVID;
    - the review-tail lows sweep;
    - the Q10 serializer;
    - the Q3/Q6/Q13/Q14 implementations;
    - Q2 keyless signing, after the owner protects the `release` environment.
- **First real-account round trips.** These happen in the first week, so bugs surface while there is time to fix them.
- **Owner actions:**
  - approve the Terraform applies;
  - create or approve the gitlab.com demo group and its token;
  - grant the Azure tenant access the apply needs;
  - protect the `release` environment;
  - raise the AWS budget from USD 5/month for the sandbox.
- **Teardown** of the sandbox resources after the demo is a tracked follow-up.

## Addendum: owner decisions, 2026-10-18 (afternoon)
The demo script lane (#434) raised five questions. The owner answered them:
1. **Remediation sign-off persona.** The Q7 default (`admin_not_initiator`) stays. The demo seed adds a second admin persona with MFA, a security lead, who gives the remediation sign-off. Avery stays the independent reviewer for the governance beats.
2. **Deploy gate.** The `demo:gate` beat runs live from a terminal on the dev instance host (SSH or Session Manager). The T-24h captured output is the fallback.
3. **Live database.** The live demo database holds only what the real GitLab, AWS and Azure scans find. The seeded discovery dataset exists only in the fallback database.
4. **Fallback host.** The fallback runs as the local docker compose stack on the presenting laptop, prepared with `demo:prepare` the night before.
5. **GitLab wording.** The script keeps its open statement. GitLab is read through a scoped, read-only group token because GitLab has no keyless federation for API reads, and RegulAIt lists that token as a relaxation on the posture page.

## Addendum: owner decision, 2026-10-19 (how the live database is prepared)

The runbook (`DEMO_RUNBOOK.md` §7.1) left open how the live database gets the governance seed without the seeded
discovery dataset, since `demo:prepare` always runs both `demo:shadow` phases and `demo:check` requires that dataset.
The master session put four options to the owner: a live mode for `demo:prepare`; manual steps; full preparation then
deletion; or no governance data on the live instance (Act 2 on the fallback database). The owner chose:

1. **Live mode.** `demo:prepare --live` runs the same pipeline without either `demo:shadow` phase, then
   `demo:check --live`. Without the flag the pipeline is unchanged and still prepares the fallback database.
2. **Live check.** `demo:check --live` keeps every governance check and fails closed if any record of the fictional
   discovery dataset is present. It reports the real discovery sources and passes once at least one is enabled, so
   it can run before the first real scan.
3. Manual preparation and post-hoc deletion are not used: the first has no check, and the second leaves the
   fictional records in the append-only audit trail.

## As built: the live database, owner decision of 2026-10-19 (addendum decision 3, option A)
Addendum decision 3 reads: "The live demo database holds only what the real GitLab, AWS and Azure scans find. The
seeded discovery dataset exists only in the fallback database." On 2026-10-19 the owner chose option A for it: the
live database holds the governance seed but only real Shadow-AI findings. Built as two flags:
- **`demo:prepare --live`** runs `seed → demo:setup → demo:intake --live → demo:traffic → demo:check --live`. Both
  `demo:shadow` phases are skipped, so `seed` is the first step and its first-admin-setup acts (the personas' one-time
  passwords, Morgan Reyes's creation and both admins' TOTP enrolment, the B4S-06 assurance window) run inside that
  window as before. `demo:intake --live` loads the shipped signature catalogues but not the synthetic SaaS export,
  which is also fictional. Without the flag, `demo:prepare` is unchanged (the fallback database).
- **`demo:check --live`** keeps every governance beat and replaces the seeded-dataset beats with: "1 Fictional
  dataset", a FAIL (never a warning, ADR-0180) on any discovery source, run, finding, import, enrolled device,
  connector or provenance record carrying the dataset's company, source names, " (demo dataset)" suffix or recorded
  identifiers, when one of those lists (each endpoint agent's device list included) cannot be read, or when the runs,
  imports or provenance records come back as a full page of 200 (those routes do not page, so absence past the cap is
  not proven); "1 Signature catalogue" (empty means a real scan matches
  nothing); "1 Real discovery sources", which lists every real source with its kind, enabled state and last run, notes
  the ones never run, and FAILs only when none is enabled; and "1 Remediation routing", which checks that the default
  sign-off resolves to Morgan alone (the only active admin other than Ada, with TOTP) and that the shipped default is
  not retired or changed, since no remediation workflow exists before the live S3 beat; an unreadable users or
  templates list is a FAIL of its own.
- On a fresh live database `demo:prepare --live` therefore ends with one FAIL, "1 Real discovery sources", until the
  sources of DEMO_RUNBOOK §7.2 are added. CI (`demo.yml`, `demo-live`) pins that, and a 0-fail run with one real source
  enabled, on empty databases. On the dev instance host it is pending execution.

## As built: the audit object index and `objectType` validation, owner decisions of 2026-10-21 (#453 rows 1 and 2)
- **Index (migration 0210).** `audit_log_object_at_idx ON audit_log (object_type, object_id, at DESC)` serves
  `GET /v1/audit?objectType=&objectId=`, the same filters on `GET /v1/audit.csv`, and the use-case overview's trail and
  count. It is built with `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, so audit writes are never blocked. The drizzle
  migrator applies every pending file in one transaction, and CONCURRENTLY cannot run inside one, so the statement is
  not in the migration file. It is an entry of `CONCURRENT_INDEXES` (`packages/db/src/migrate.ts`), and `runMigrations`
  runs it after `migrate`, outside any transaction, once `0210_audit_log_object_at_idx` is in the folder's journal.
  The 0210 file is that journalled marker and runs `SELECT 1`. A valid index costs one catalogue read on later runs; an
  INVALID index left by an interrupted build is dropped concurrently and rebuilt; the run fails rather than return
  without a valid index, and there is no fallback to a plain CREATE INDEX. `drizzle-kit migrate` applies the marker but
  not the index, so migrations go through `runMigrations` (the gateway, the seed and the demo scripts already do).
  **One builder at a time (#476 M1).** A build in progress is registered INVALID from its first step, so it reads
  exactly like a failed one. The state check, any DROP and the CREATE therefore run on one pinned connection in
  autocommit, under a session-level advisory lock (`CONCURRENT_INDEX_LOCK_NAMESPACE` and
  `CONCURRENT_INDEX_LOCK_KEY`), released in `finally`. A second process booting during a build waits for the lock, then reads VALID and
  issues no DDL; it never drops an index another process is building. The lock is taken by polling
  `pg_try_advisory_lock`, not a blocking `pg_advisory_lock`, because a waiter parked inside one statement holds a
  snapshot that the holder's build would then wait for (reasoned from how CONCURRENTLY waits; not reproduced).
  **Bounded waits (#476 L1).** CONCURRENTLY waits for every transaction in the database that holds an older snapshot,
  not only writers to `audit_log`. The build session sets `statement_timeout = 0` (a large build is allowed to take
  its time) and `lock_timeout = 60 s` (`CONCURRENT_INDEX_LOCK_TIMEOUT_MS`), which bounds each of those waits. Past it,
  boot fails with `ConcurrentIndexBlockedError`, whose message names the oldest open transactions in the database
  (pid, state, start time, application name; never query text). The INVALID index it leaves is rebuilt on the next
  run. Waiting for another process's build lock is not bounded; that process's own waits are.
  Limits: the first build on a large trail takes as long as a concurrent build takes, during boot.
- **`objectType` (public API contract change).** `GET /v1/audit` and `GET /v1/audit.csv` refuse an `objectType` that
  `audit_log.object_type` cannot hold with 400 `unknown_object_type` and a `detail` that names the parameter, where they
  answered 200 with no rows. The column is plain `text`; the allowed list is the Drizzle enum every audit insert is
  typed against (`auditLog.objectType.enumValues`), not a second list. The refusal comes before the signed-bundle path,
  so no export is recorded for it. Both routes are `public-stable`; this narrows a parameter (docs/api/VERSIONING.md
  §3) by the owner's decision, inside `/v1`, and the published spec says so (`docs/api/openapi.json` is the changelog
  source, §6). The console's audit page sends `objectType` only for the types a console link opens
  (`auditObjectLinks.ts`, today `ai_use_case`), checked against the schema by a gateway test, and says when a link's
  object filter was not applied.

## As built: fallback rehearsal record and post-demo teardown runbook (2026-10-21)
- **Fallback rehearsal (decision 7).** `demo.yml` gained a `demo-rehearsal` job that runs only on a manual dispatch:
  `demo:prepare` twice on the same database, a separate `demo:check`, and `demo:gate` after each prepare. Dispatch run
  `39622055370` (main `2722e439` plus that job only) passed: 0 FAIL in every check, and both gate runs DENY with
  exactly two `BLOCK open_high_alert` lines; `demo-journey` and `demo-live` passed in the same run. The ALLOW half of
  G3, the laptop compose stack and the dev-host gate stay pending execution. Record, observations and owner steps:
  [DEMO_RUNBOOK §7.5](../product/DEMO_RUNBOOK.md#75-fallback-rehearsal-record-adr-0197-decision-7).
- **Teardown (consequences, "tracked follow-up").** [DEMO_TEARDOWN.md](../product/DEMO_TEARDOWN.md) mirrors every
  setup step of DEMO_REAL_ACCOUNTS.md in reverse, with verification checks and a coverage table naming where each item
  was created. Every step is pending execution, post-demo, by the owner. It adds one step the setup runbook's teardown
  did not have (removing the AWS discovery role and its OIDC provider before the account closure), which needs the
  owner's agreement, and lists the owner actions above that have no runbook step.

## Addendum: owner decisions, 2026-10-23 and 2026-10-24 (dates, the live endpoint, the "Enforce it" beat)

Recorded from the owner's decisions on #453 (2026-10-23 for the dates; comment 6385378784 of 2026-10-24 for the rest),
after the full feedback scan of #547 (comment 6385243736, findings FS-1, FS-8 and FS-59). The decisions above are not
edited; where these supersede them, it is said here.

1. **Dates (owner, 2026-10-23).** The script is used twice: an internal run-through on Sun 2026-11-01 and the
   **external demo on Tue 2026-11-03**. The code freeze stays 2026-10-29. The plan's files keep their 2026-11-01
   names. On 11-01 every state-changing beat runs on the fallback stack, so the live instance stays as prepared for
   11-03 (`DEMO_RUNBOOK.md` §7.3).
2. **The live endpoint is agentless (owner, 2026-10-24, FS-1, "Re-script LIVE").** The gateway serves no signed
   collection pack yet (`GET /v1/endpoint-agent/config` answers 503 `collection_pack_unavailable`; the agent's compiled
   keyring is empty until ADR-0195 SD4g), so a real endpoint agent cannot reach the report stage. Live Act 1 therefore
   shows the three network sources (GitLab, AWS, Azure) plus an agentless MDM/EDR inventory import of a demo laptop
   through an `endpoint_inventory` source. The endpoint agent stays on the fallback, and the script says: "its signed
   collection-pack stage is pending, so this copy's agent reports were seeded." This narrows addendum decision 3's
   "the real endpoint device" wording in the runbook: the live database holds what the real GitLab, AWS and Azure
   scans and the real device's inventory import find. Docs only; no code changed.
3. **An "Enforce it" beat (owner, 2026-10-24, FS-8, "Add it").** Two minutes on the fallback between G2 and G3: one
   governed call denied with its rule named, one that needs a named approver, and the audit row. It is second in the
   cutting order. Superseded for 11-03 by decision 4.
4. **"Enforce it" is a simulated decision, on both dates (owner, 2026-10-24, #453 comment 6387779914).** The beat
   runs on the Simulation page on 11-01 and 11-03, on LIVE and FALLBACK alike. On screen and in the talk track it is
   a *simulated decision*: the real policy engine evaluating a proposed call; never say the call "was blocked" or
   "was queued". The 11-03 Execution control read-only fallback and the MCP-server check are dropped.

### As built (2026-10-24)

- **Script, runbook, Q&A, talk track, leave-behind, real-accounts runbook and presenter notes** updated in one docs
  batch (PR "HOLD docs(demo): full-scan fixes …"). The time budget still sums to 25.0 minutes: E takes 2.0 and G3
  grows to 2.0 (0.5 from G4, owner); G6 moved to the optional beats, and S1, S2 and G1 each gave 0.5.
- **What E shows, as verified on main.** No console page makes a governed tool call as another person and no demo
  command does it; a real call needs an MCP client holding Dana's key and the project header (`DEMO_RUNBOOK.md` §3(b)).
  E therefore uses the **Simulation / access preview** page (`/ui/admin/simulation`, `POST /v1/evaluate`), which runs
  the live kernel for Dana's `search_code` (deny, her per-user revocation named) and `write_file` (require approval,
  the approver named), executes and queues nothing, and records each question as an advisory audit row. The script
  says so on stage. A packaged real call for the beat is proposed in that PR as a demo-prep addition and is not built.
- **11-03:** `POST /v1/evaluate` reads the policy registry and never contacts the MCP server, so the Simulation beat
  works on LIVE as prepared whether or not the demo MCP server runs there (decision 4).
