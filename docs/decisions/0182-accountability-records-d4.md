# ADR-0182: Accountability records (ADR-0175 batch D4)

- **Status:** Accepted
- **Date:** 2026-10-06
- **Deciders:** owner
- **Builds on:** ADR-0175 (batch D4: A11, A12, A13, A14), ADR-0180 §1 (secure by default, a standing rule),
  ADR-0181 (one audit shape for every relaxation: `detail.transitions`), ADR-0176 (open source first), ADR-0116
  (signed exports), ADR-0173 batch 2c (KRIs, monitor), PathForward PF-03 and PF-14, ROADMAP §7.1–7.2 (I2)

## Context

ADR-0175 batch D4 adds the records an accountable deployment of AI keeps:

- **A11:** a decision can be reproduced. Each use-case decision cites the review policy, required-test policy, intake
  template, screening rule set and suggestion rules that produced it. A golden decision set guards changes to them.
- **A12:** an AI incident register with the regulatory notification clocks.
- **A13:** end-user problem reports and appeals.
- **A14:** AI literacy and acceptable-use acknowledgements, enforceable on governed calls.

Three pull-forwards ride along as slice **S5**:

- **PF-14:** an owner, an SLA and a work item for every alert episode.
- **PF-03:** a threshold breach that *suggests* halting an agent.
- **I2:** the ISACA AI-agents checklist pack, new pack versions and four evidence collectors.

The batch was built by six agents on separate branches (P0, then A11–A14 and S5 in parallel) and integrated on
`d4-int`. Every new setting follows ADR-0180: strict by default, an admin may relax it, and every relaxation is
audited with `detail.transitions`. The product is not live, so the migration writes the strict values onto existing
rows as for a first load. Nothing is grandfathered.

## Owner decisions (2026-10-06)

These override the recommendations in the D4 contract. They are recorded verbatim.

1. Art 73 clocks: ALWAYS start for a serious incident on a high-tier or unscreened use case, labelled "confirm with counsel"; role defaults to `both`. Admin-relaxable, audited.
2. Role default `both` (as recommended).
3. Literacy gate: human-originated calls; agents/automations inherit from their owning person; NO grace on a new version.
4. PF-03: SUGGEST ONLY. A threshold breach raises the alert with a one-click "propose halt" action; nothing is auto-filed. When a person files it, the normal Approvals Queue applies (proposer cannot approve). Never auto-trips.
5. Feedback SLA: 72h acknowledge / 30d resolve; breach alerts the owner; admin-changeable, audited.
6. Art 73(6) evidence hold: ON by default, admin override per change, audited (ADR-0180 — main session).
7. Public signed feedback links: built, shipped OFF (ADR-0180 — main session).

Note (Art. 4): copy uses the amended wording of Regulation (EU) 2026/1744, "take measures to support the development of
AI literacy". The amendment was verified on EUR-Lex on 2026-10-06.

## Main-session decisions (made while the slices built)

- **Settings UI.** Each slice puts the admin controls for its own settings on its own page. Each control writes through
  the audited `PUT /v1/org/settings` and shows the strict default and the "relaxed" copy. Incidents and Feedback stay
  in the Workspace navigation; their lists are scoped on the server.
- **A11:**
  - The review-policy version is the row's `version + 1` on each PUT. The first PUT writes v1.
  - An `ai-use-case-intake/*` template or variant, however it is created (from the gallery, the author card or
    `POST /v1/workflows/templates`), goes through the Preview impact step and the decision-regression gate.
  - Decision records are readable by the use case's owner and admins only.
- **A12:**
  - The Art. 73(6) evidence hold also binds the agents in the use case's approved stack (`intended_agent_ids`), not
    only the agents linked to the incident.
  - Closing needs every corrective action done or cancelled. Cancelling one needs a reason of at least 10 characters.
- **A13:**
  - The retention sweep purges unresolved items' bodies too (data minimisation; the 365-day default is far past the
    30-day resolve SLA).
  - An unowned breached item is escalated to the admins by S5's alert-SLA sweep. Verified at integration with a test.
- **A14:**
  - Every governed path fills the kernel's literacy slot: model dispatch with its routing and fallback hops,
    connector calls, orchestration, the compatible API surface, the in-product assistants and MCP tools.
  - Evaluation and red-team dispatches are exempt by origin.
  - Break-glass exempts only a break-glass *session* (server-recorded origin), never a standing list membership. The
    exemption is audited as `ai-literacy-break-glass-exempt`.
- **S5:**
  - One halt proposal per alert episode, whatever its status.
  - `auto_high` tickets file only on a PM connection an admin named (`alert_ticket_connection_id`). There is no
    fallback. If that connection is deleted, filing stops and the sweep records it.
  - The relaxed copy says the alert's title goes into the work item and people appear as "a user (id …)".
  - A migration test seeds an agent-scoped high KRI before 0162 and checks it becomes `propose_halt`, with its audit
    row.
- **Integration:**
  - The feedback "Open incident" route calls the incident register's `createIncident` directly, as the caller, instead
    of making an internal HTTP request that forwarded the caller's credentials.

## Decision

### A11 — decision records and the decision-regression gate

**Decision records.**
- The sign-off path writes one `use_case_decision_records` row per terminal decision (approved, rejected, needs
  information), in the decision's own transaction. If the row cannot be written, the decision rolls back.
- Each row cites the review-policy version, the required-tests digest, the intake template (id, name and definition
  digest), `EU_AI_ACT_RULESET_VERSION`, `INTAKE_ASSIST_RULES_VERSION` and the answers digest.
- The table is append-only: a trigger refuses UPDATE and DELETE.

**Versioned review policy.** Every PUT of the review policy or the required tests bumps
`governance_review_policy.version` and appends a version row (body and digest) to the append-only
`governance_review_policy_versions`.

**Golden set.**
- `packages/shared/src/decision-regression/` holds the shipped cases and their expected outcomes, and runs them
  through a pure runner. The CI golden test fails when screening or suggestion code changes an outcome, until the
  expected file changes in the same commit.
- A reviewer override becomes a case that snapshots the use case's answers.

**Activation gate** (`decision_regression_gate`).
- These writes need a `regressionRunId` for a preview of the same body (matching digest, no older than
  `decision_regression_max_age_minutes`):
  - `PUT /v1/governance/review-policy`;
  - `PUT /v1/governance/review-policy/required-tests`;
  - creating an intake template or variant.
- If the preview changed outcomes, the write also needs `acceptChangedOutcomes: true` and a reason.
- Refusals are `409 decision_regression_not_previewed` and `409 decision_regression_changes_unaccepted`, both audited.
  `warn` records and allows the write; `off` skips the check and the response says so.

**Web.** DecisionRegressionPage (runs, side-by-side diff, cases, settings); a Preview impact step on the review
policy, the required tests and the template gallery; a Decision records tab on the use case.

### A12 — the AI incident register

**Clocks.**
- `packages/shared/src/incident-clocks.ts` is a catalogue of clocks. Each entry carries its regime, paragraph, the
  verbatim quoted text, source URL and retrieval date, its start field and its period:

  | Clock | Period |
  |---|---|
  | EU `art26-5-inform-provider` | immediately |
  | EU `art73-2-general` | 15 days |
  | EU `art73-3-critical-or-widespread` | 2 days |
  | EU `art73-4-death` | 10 days |
  | HIPAA `164.404-individuals` | 60 days |
  | HIPAA `164.406-media` | 60 days |
  | HIPAA `164.408-secretary` | contemporaneous, or 60 days after the calendar year for fewer than 500 |
  | HIPAA `164.410-ba-to-ce` | 60 days |

- Art. 73(5) allows an initial report before the complete one.
- `dueAt = clockStart + N × 24 h` (UTC). Every page says the clock is a reminder computed from the recorded awareness
  time, not legal advice.

**Starting and moving clocks.**
- Marking an incident serious (or `phi_breach`) on a high-tier or unscreened use case starts the applicable clocks
  automatically. EU clocks carry "confirm with counsel" (owner decision 1).
- A clock is never deleted. Only an admin, with a reason, may set it aside (`not_required`) or toll it. The route class
  is admin-only and the handler checks again.
- Each use case has an `eu_ai_act_role` (`provider|deployer|both`, default `both`). Only an admin, with a reason, may
  narrow it.

**Containment, evidence hold and the gate.**
- Containment halts a linked agent through `haltAgentInTx`.
- The **Art. 73(6) evidence hold** (`incident_evidence_hold`): while a serious incident's authority clocks have no
  report, a change to the configuration of a linked agent or an agent in the use case's stack is refused with
  `409 incident_evidence_hold`. An admin may override one change with a reason, sent as the
  `x-regulait-evidence-hold-override` header. The override is audited.
- The deploy gate (`incident_gate_mode`) holds a use case that has an open serious, high or critical incident:
  `open_serious_incident`, `open_high_incident`.

**Closing and exporting.**
- Closing needs a root cause, lessons learned, every clock in a terminal state and every action done or cancelled.
- The signed export (ADR-0116, subject kind `ai-incident`) and a CSV timeline are admin-only.
- An incident can be opened from an alert, a red-team run or a feedback item, and arrives pre-linked to it.
- Monitor rules: `incident_notification_due` (high) and `incident_action_overdue` (medium). The `incident-clock-sweep`
  job runs them.

### A13 — end-user feedback and appeal

**Submitting and storing.**
- Any signed-in user may report a problem or appeal a decision on a use case. A cited trace or span must belong to the
  use case (`422 trace_not_in_use_case`).
- The body and contact details are encrypted with the data key. Every read, and every refused read, is audited.
- `feedback-retention-sweep` deletes bodies and contact details after `feedback_retention_days` and keeps the
  resolution record.

**Routing and answering.**
- Items route to the use-case owner, with acknowledge and resolve due times. An appeal against the owner's own
  decision, or filed by the owner, routes to the admins.
- Separation of duties: neither the contested decision-maker nor the person who filed an appeal may resolve it.
- A resolution needs a note, and a resolved item is final.

**SLA, metrics and incidents.**
- `feedback-sla-sweep` raises `feedback_sla_breached` (medium).
- Two A2 metrics: `user_report_rate` (problem reports per 1,000 finished traces) and `appeal_overturn_rate`.
- "Open incident" opens a pre-linked `user_report` incident through A12's `createIncident`. It does not copy the body.

**Public signed links** (owner decision 7). They are built and shipped off (`feedback_signed_links_enabled = false`):
- a `rglf_` token of 256 random bits, shown once and stored as sha256;
- valid for at most 30 days, with a use limit, and revocable;
- rate-limited per address and per link with `@fastify/rate-limit`;
- while links are off, the public routes answer 404.

### A14 — AI literacy and acceptable-use acknowledgements

**Documents.**
- Admins publish versioned acceptable-use or training documents (a link or an attachment) with an audience (everyone,
  teams or roles) and a validity period.
- A new published version needs re-acknowledgement, with no grace period (owner decision 3). The exception is a version
  the admin marks *editorial*, with a reason (audited, transition recorded).

**Acknowledging.**
- A person acknowledges only for themselves, and only the exact published version and digest. Acknowledging for
  someone else is refused with 403 and audited.
- An admin may record a completion from an external training system, with an evidence reference.
- `GET /v1/ai-policies/coverage` is an audited admin read.

**The gate** (`literacy_gate_mode`).
- With `enforce`, a human-originated governed call by someone who is not current is denied as
  `ai-literacy-not-current`. The refusal names the documents and is audited.
- Agents and automations inherit their owning person's status.
- Exempt: platform sweeps, evaluation and red-team dispatches, the bootstrap identity, and a break-glass session.
- When nothing published applies to a person, nothing changes for them, so a fresh install still works.

**ABAC.** Cedar schema **v3** adds the principal attribute `aiTrainingCurrent`. Schemas v1 and v2 are unchanged, and
simulation builds the attribute exactly as enforcement does.

**Monitor and sweep.** `literacy_coverage_gap` (low, observe-only); `literacy-expiry-sweep` sends notices 14 days before
an acknowledgement expires.

**Web.** LiteracyPage, the acknowledgement interstitial and a section on the Account page.

### S5 — alert owner and SLA (PF-14), suggested halt (PF-03), packs (I2)

**PF-14: owner, SLA and work item.**
- Each alert episode gets an owner when it is raised. The owner is derived from the use-case owner, the agent's steward
  (or their successor), the risk owner or the vendor owner. It can also be assigned (admin or the current owner;
  audited).
- `due_at` comes from `alert_sla_hours`. `alert-sla-sweep` marks a breach once, never resolves or acknowledges an
  episode, and escalates breached or unowned episodes to the admins once each. It posts to ChatOps with no personal
  data.
- `POST /v1/governance/alerts/:id/ticket` files exactly one PM work item per episode.

**PF-03: suggested halt** (owner decision 4).
- A KRI with `on_breach = propose_halt` (agent-scoped only) raises its alert with a suggested `halt_agent`. Nothing is
  filed and nothing trips.
- "Propose halt" files one pending proposal per episode, with the clicking person as proposer. The normal approvals
  queue applies: the proposer cannot approve, and the agent halts only after a different admin approves.

**Packs.**
- `isaca-ai-agents@1`: 15 controls, one per checklist item, with paraphrased titles. Items 3 and 5 are unaddressed and
  need an attestation.
- `nist-ai-rmf@4` and `eu-ai-act@3`. The latter has `art-4-ai-literacy` in the amended wording and
  `art-73-serious-incident-reporting`.
- Collectors: `incident_register`, `user_feedback_channel`, `literacy_acknowledgements`, `decision_regression_runs`.
- Older pack versions stay pinned by content hash.

### Settings: every new setting, its strict default and its relaxation

Every setting is written through `PUT /v1/org/settings` (admin), audited with `detail.transitions` and `detail.relaxed`
when a relaxation.

| Setting | Strict default | An admin may relax to |
|---|---|---|
| `decision_regression_gate` | `enforce` | `warn`, `off` |
| `decision_regression_max_age_minutes` | 60 | up to 1440 |
| `incident_gate_mode` | `enforce` | `warn`, `off` |
| `incident_evidence_hold` | `true` | `false` (or an audited per-change override) |
| `incident_clock_regimes` | `["eu-ai-act", "hipaa"]` | remove a regime |
| `feedback_signed_links_enabled` | `false` | `true` |
| `feedback_ack_sla_hours` / `feedback_resolve_sla_days` | 72 / 30 | up to 168 / 90 |
| `feedback_retention_days` | 365 | up to 2555 |
| `literacy_gate_mode` | `enforce` | `warn`, `off` |
| `literacy_default_validity_days` | 365 | up to 730 |
| `alert_sla_hours` | `{high: 24, medium: 72, low: 168}` | longer, each up to 720 |
| `alert_ticket_mode` | `manual` | `auto_high` (needs `alert_ticket_connection_id`) |
| `alert_ticket_connection_id` | null (none named) | a named PM connection |
| per use case `eu_ai_act_role` | `both` | `provider` or `deployer` (admin, with a reason) |
| per KRI `on_breach` | `alert`; migration 0162 sets `propose_halt` on existing agent-scoped high KRIs | — (suggests only) |

### Regulation citations (verified 2026-10-06)

- **Regulation (EU) 2024/1689** (AI Act), OJ L 2024/1689:
  https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=OJ:L_202401689 (retrieved 2026-10-06).
  - Art. 3(49): the definition of a serious incident.
  - Art. 26(5): the deployer informs the provider first; if the provider cannot be reached, Art. 73 applies.
  - Art. 73(2): 15 days. Art. 73(3): two days for critical infrastructure or a widespread infringement. Art. 73(4):
    10 days for a death. Art. 73(5): an incomplete initial report is allowed. Art. 73(6): no alteration before
    informing the authority.
- **Regulation (EU) 2026/1744** ("Digital Omnibus on AI"), OJ 24.7.2026:
  https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=OJ:L_202601744 (retrieved 2026-10-06).
  - It replaces **Art. 4**: "take measures to support the development of AI literacy … This obligation does not
    require providers or deployers to guarantee any specific level of AI literacy of any individual."
  - It does not amend Art. 3(49), Art. 26 or Art. 73.
  - It defers Chapter III Sections 1–3 to 2 Dec 2027 (Annex III) and 2 Aug 2028 (Annex I). Article 73 is in Chapter
    IX and is not deferred.
- **HIPAA**, 45 CFR Part 164 Subpart D, §§164.404, 164.406, 164.408, 164.410 and 164.412 (the law-enforcement delay,
  encoded as tolling). eCFR point-in-time 2026-09-01:
  https://www.ecfr.gov/api/versioner/v1/full/2026-09-01/title-45.xml?part=164&section=164.404 (and `section=164.406`,
  `164.408`, `164.410`), retrieved 2026-10-06.
- Not encoded: incident clocks for the other shipped packs (ISO/IEC 27001, ISO/IEC 42001, SOC 2, PCI DSS, FINRA). None
  was verified from primary text in this pass. GPAI Art. 55(1)(c) is out of scope.

### Open source considered (ADR-0176)

Reused, all already in the tree:
- `zod`;
- `diff` (BSD-3), for the text diff of reasons;
- `@fastify/rate-limit` (MIT), for the public link routes;
- node `crypto`, `token-hash.ts` and `secrets.ts` (AES-256-GCM);
- Cedar (Apache-2.0), for the v3 attribute;
- the ADR-0116 export signing;
- native `Date` in UTC, for whole-day periods.

Considered and not used:

| Considered | Reason |
|---|---|
| `jsondiffpatch` and `microdiff` (MIT) | Outcomes are flat records compared field by field. |
| OASIS STIX 2.1 `incident` and CSAF 2.0 | Neither models AI-harm criteria or regulatory clocks. A STIX export is a follow-up. |
| `jose` JWS feedback links (MIT) | A stored opaque hash can be revoked per link and leaks no claims. |
| xAPI and SCORM | regulAIt records acknowledgements; it does not deliver training. An xAPI import is a later adapter. |

Everything hand-written is governance semantics: routing, separation of duties, clocks and gates.

### Migrations

- **0162** `0162_accountability_records` (P0): every D4 table and column, the append-only and never-deleted triggers,
  and the strict values on the existing `org_settings` row.
- **0167** `0167_alert_ownership` (S5): `org_settings.alert_ticket_connection_id` (FK `ON DELETE SET NULL`) and
  `audit_log_alert_escalated_idx`.
- **Retired, never to be reused:** 0163 (A11), 0164 (A12), 0165 (A13) and 0166 (A14) were reserved and not needed.
  The journal skips from 162 to 167; it already had such gaps.
- The next migration is **0168**.

### Demo

`demo:intake` tells the D4 story through the real routes.

**Feedback that becomes a closed incident.**
1. Avery reports a problem on the Customer Sentiment Analyzer (high tier).
2. Dana acknowledges it and opens an incident from it.
3. Marking the incident serious (fundamental rights) starts the art26-5 and art73-2 clocks.
4. Both clocks reach `sent_complete`: art73-2 through an initial and then a complete report. The recipients are labelled
   synthetic.
5. The corrective action is done with evidence, the incident closes with a root cause and lessons learned, and the
   feedback item is resolved with a note.

**Acceptable use.**
- As its last step, the seeder publishes one acceptable-use document. It uses a synthetic `example.com` link and applies
  to everyone.
- Ada, Dana and Avery acknowledge it for themselves.
- `literacy_gate_mode` stays `enforce`, and `demo:traffic` is served unchanged.

**Check.** `demo:check` has a new beat, **3 Accountability**. It FAILs unless:
- the demo incident is closed and every clock is terminal;
- the document is current for the three personas;
- the showcase use case has an approval decision record.

`demo:prepare` on a fresh database: 19 pass, 0 warn, 0 fail. The test suites that run the seeder delete the document
afterwards (M-068).

### Red proofs (summary)

Every rule has a test that fails with the rule reverted. Each slice recorded its own failing runs in its commits:
- **A11:** a decision without its record rolls back; a stale or mismatched preview gets 409; changed outcomes without
  acceptance get 409; a gallery bypass shows no preview step.
- **A12:** no clocks on create; close without lessons; a set-aside without a reason; the evidence hold disabled; the
  hold ignoring the stack; close with an open action or clock; the owner releasing the gate.
- **A13:** links on while the setting is off; expired, revoked or over-used tokens; a trace from another project;
  body reads; the SLA and retention sweeps.
- **A14:** the literacy slot removed from the invoke and connector postures; break-glass through a list membership; the
  kernel trace dropped.
- **S5:** the `auto_high` connection check removed; the oldest-connection fallback restored; owner derivation; the
  sweep's once-only behaviour.

The integrator added three:

| Rule | Reverted by | Failure |
|---|---|---|
| A non-admin gets the admin gate's `403 admin_only` on clock not-required and toll (the route class, not only the handler) | adding both routes to the non-admin set | "expected 'forbidden' to be 'admin_only'" |
| An unowned breached feedback item is escalated once by the alert-SLA sweep | skipping feedback episodes in the sweep | "expected [] to have a length of 1 but got +0" |
| demo:check's Accountability beat checks acknowledgement state | checking audience membership instead | "expected 'PASS' to be 'FAIL'" |

M-068 two-run proof: zz-c6 and then the A14 suite on one database pass 28/28 with the cleanup; without it, 16 fail.

Integration also fixed one test that depended on file order. The `demo:set-passwords` suite
(`adr0174-enterprise-sign-in.test.ts`) put the demo personas' passwords back after running, but not the admin's
authenticator, which set-passwords clears (ADR-0181 FX2). A later seeder run then refused the admin persona. Proof:
running zz-c6, then adr0174, then zz-c6 on one database passes with the restore; without it, the second zz-c6 fails
with "already has a password but no TOTP".

## Consequences

- A use-case decision can be traced to the exact configuration that produced it. Changing that configuration needs a
  preview, and acceptance when outcomes change.
- Incidents, their regulatory clocks, feedback and literacy are first-class records, with audited reads of other
  people's free text, and they feed the compliance packs.
- Strict defaults make some operations refuse by default: an unpreviewed policy change, an agent change under the
  evidence hold, a governed call by a person whose acknowledgement is not current. Each refusal names the reason and
  the relief valve, and each relaxation is an audited admin act.
- The incident clocks are reminders computed from the recorded awareness time, not legal advice. Applicability depends
  on the organisation's role and the system's classification date, and the UI says "confirm with counsel".

## Follow-ups

- A STIX 2.1 incident export (PF-14).
- An xAPI completion import (PathForward).
- Incident clocks for further regimes once verified from primary text.
- `demo:check` could also prove the feedback item's link to the incident.
- The web app shows generic errors for some new refusals (`ai-literacy-not-current` on a governed call outside the
  interstitial).
