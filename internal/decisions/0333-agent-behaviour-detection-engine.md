# ADR-0333: Rule-based detection of risky agent behaviour over the governed action stream

- **Status**: Proposed (builder lane E15, 2026-11-15; owner direction 2026-11-15)
- **Date**: 2026-11-15
- **Index**: Agent behaviour detection: signed rule pack, windowed sequence rules, incidents, SIEM export, responses
- **Builds on**: ADR-0060 (tamper-evident audit chain), ADR-0186 (signed receipts, monitor rules), ADR-0188 (agent
  workload identity and delegation), ADR-0298 (on-device enforcement), ADR-0303 (SIEM delivery), ADR-0180 (secure by
  default), ADR-0176 (open source first), ADR-0200 (engineering guidelines)
- **Migration**: `pending/agent_detection.sql` (numbered at merge, ADR-0252)

## Context

Governance today decides each call on its own. A risky pattern is often a *combination* of calls that are each allowed:
an agent reads a secret and, a minute later, calls a tool that sends data out. The owner asked (2026-11-15) for
real-time, rule-based detection of risky agent behaviour from what agents actually do: sequences and combinations of
tool calls, never prompts.

Owner scope guard: **detections and responses are deterministic rules, never AI.** Rules are versioned data (a signed
rule pack that an admin can edit, every change audited), evaluated in a bounded window per session or endpoint. Each
detection becomes an incident with its evidence chain and is exported to the SIEM. The default response is an alert;
an admin may configure a stronger response per rule.

ADR-0186's four monitor rules (§M) are periodic posture checks over 24-hour episodes that feed the assurance monitor.
They stay as they are. This ADR adds a per-session sequence engine beside them.

## Decision

### 1. The event stream is the committed audit chain

- **Source.** The engine reads committed, chained `audit_log` rows (`seq` set) in chain order, behind its own cursor.
  It never sees prompts, arguments or tool output, because the audit row holds none of them.
- **On-device hook decisions.** The ADR-0298 hook does not report its decisions to the gateway yet (its "Audit"
  follow-up, owned by lane E13). When it does, through the audit chain, those rows enter the same stream with no change
  here. A rule can already name `objectType` values, so an endpoint rule needs no new engine code.
- **Never in the decision path.** The engine runs only on the `agent-detection-sweep` scheduler job (every 15 s),
  leased so that two replicas never evaluate the same rows. A slow or failed sweep cannot delay or change a
  governance decision. Detection is "near real time": the lag is bounded by the sweep interval plus one batch.
- **Grouping ("session").** An event belongs to the delegation tree it ran under (`grant:<root grant id>`, ADR-0188)
  when it has an actor, and otherwise to the sponsor user (`user:<user id>`). Every rule window is per group.
  `endpoint:<device id>` is a reserved prefix for the hook decisions above.
- **Bounded look-back, never silently short (review of #865).** Each batch loads the window's earlier rows for the
  groups it touches, filtered by the fresh rows' sponsors (served by `audit_log_user_at_idx`) so the scan never walks
  the chain backwards. It keeps at most 2,000 rows per group and 20,000 per batch, so one busy group cannot push
  another group's first step out of the window. When a group's look-back is cut, the batch writes one
  `detection-degraded` audit row (effect `deny`, the groups and the seq range), which reaches the SIEM like any
  incident. A group is reported once per detection window (`detection_degraded_marks`), not on every batch while it
  stays busy. **Residual:** a sequence whose first step lies more than 2,000 rows back in its own group, inside the
  window, may go undetected; it is reported, not hidden.
- **First run replays history (D2).** On first run the live cursor starts at the chain head. The retained history,
  from the first retained row up to that head, is replayed behind a second cursor (`replay_cursor_seq` up to
  `replay_until_seq`):
  - after the live batches in each pass, so a long history never delays live detection;
  - at most ten batches of 500 rows per pass;
  - checkpointed after every batch, so a restart resumes where it stopped, and rows the audit prune already removed
    are skipped;
  - its incidents are marked `historical` and are always alert-only (a CHECK enforces it). A response never acts on
    an agent session from the past.

### 2. Rules are a closed, signed, versioned document

- **Format.** `regulait.detection-pack.v1`: a closed JSON document validated by a zod schema (unknown members are
  refused). It holds named **tool classes** (lower-case glob lists over tool names) and **rules**.
- **Rule types.** The vocabulary is taken from the Sigma correlation specification (`temporal_ordered`,
  `event_count`), plus `single` for one event:
  - `single`: one event matches the rule's selector;
  - `temporal_ordered`: the steps match in order, in one group, within `timespanSeconds`, optionally with a step
    required to name a different server from the previous one (`differentServer`);
  - `event_count`: at least `threshold` matching events in one group within `timespanSeconds`. A burst is one
    episode: while an incident for the same rule and group is not closed, no second one is raised within
    `timespanSeconds` of it, so a steady probe yields one incident per window, not one per call.
- **Selectors** are conjunctions over closed fields: `objectType`, `effect`, `ruleId` (exact list), `toolClass`,
  `phase`, `dataScoped` (the decision's rule chain carries a data-scope step), `addonSeverityAtLeast` (the MCP
  server's admission severity) and `delegated` (the call was made by an agent).
- **Evaluated on Cedar, not by hand.** Whether an event matches a selector is a Cedar policy
  (`@regulait/policy-kernel/detection-cedar`). Cedar already runs ABAC (ADR-0040), rate limits (ADR-0239) and
  approval rules. The pattern is ADR-0239's:
  - one `permit` per selector position, whose text depends only on the position;
  - the selector itself is an entity, so no stored value is spliced into a policy;
  - a tool class is one `permit` per glob using Cedar's own `like` wildcard match. The glob is the only pack value
    that enters policy text, because `like` takes a literal. The pack schema and the module both hold globs to
    `[a-z0-9_.:*-]`, so nothing in a glob can change a policy's structure;
  - any engine or policy error throws, so the sweep keeps its cursor and re-reads the same rows. An event is never
    silently treated as matching nothing.

  The gateway code only orders those per-event answers into the three rule shapes over the window.
- **Bounds.** At most 64 rules, 8 steps per rule and 64 globs per class; a window is at most one hour; a threshold at
  most 1,000.
- **Signing.** The built-in default pack ships in code. An admin's edit is stored as a new version, signed (Ed25519,
  over the canonical JSON) with the installation's receipt signing key (ADR-0186), which is registered in
  `receipt_signing_keys`. With no usable key an edit is refused (409 `detection_signing_unavailable`), the same fail
  closed rule as R25 sign-offs. At every sweep the engine verifies the active version against the gateway's
  **configured** receipt key (the operator secret or the install-generated file), never against a key read from the
  database, so a key INSERTed into `receipt_signing_keys` cannot vouch for a pack. A version that does not verify is
  not used: the engine falls back to the built-in default pack and writes one audit row
  (`detection-pack-unverified`). Database write access alone therefore cannot switch detection off; it needs the
  signing key, which lives outside the database. **Consequence:** after the receipt key is rotated the stored pack no
  longer verifies, the stricter built-in pack runs, and the fallback is audited until an admin re-saves the pack.
- **Audit and step-up.** Every change writes an audit row (`detection-pack-updated`, with the old and new digests). A
  change is a relaxation unless it only adds rules and leaves every existing rule byte-identical. A relaxation (a rule
  removed, disabled, narrowed or slowed) needs a `settings_relax` step-up and is audited as one (ADR-0180).

### 3. The default rule pack

| Rule | Type | What it catches |
|---|---|---|
| `secret-read-then-egress` | temporal_ordered, 10 min | an allowed `secret_read` tool call, then an allowed `network_egress` call |
| `sensitive-scope-then-unapproved-write` | temporal_ordered, 15 min | an allowed data-scoped call, then an allowed `write` call to a different server |
| `high-risk-addon-call` | single | an allowed call to an MCP server, or by a builder agent carrying a skill, that the admission scanner rated High or Critical (D1) |
| `delegation-escalation` | single | a call refused because an agent asked beyond its sponsor's entitlements (`delegation-scope`, `delegation-depth`, `lead-ceiling`, `actor-allow-list`, `delegation-isolation`) |
| `denied-call-burst` | event_count, 5 min, 10 | ten or more denied calls in one group (probing) |

The tool classes are glob lists (`*secret*`, `*credential*`, `read_env*`, `*fetch*`, `*http*`, `*upload*`, …). They
match tool names only, so they are heuristics, and the admin can edit them.

### 4. Incidents carry their evidence chain and reach the SIEM through the audit chain

- **Tables.** `detection_incidents` (rule, pack version, severity, group, sponsor, grant, status, response) and
  `detection_incident_evidence` (a join table: incident, audit row, step). The receipt of each evidence row is joined
  through `decision_receipts.audit_id`, not copied. The actor chain is a point-in-time copy of the trigger row's
  `actor_chain`, marked as an evidence snapshot.
- **Idempotent.** One incident per (rule, trigger audit row): a replayed batch cannot raise it twice.
- **SIEM.** Each incident writes one audit row (`objectType: "detection_incident"`, `objectId` = the incident,
  `ruleId` = `detection:<rule id>`, `effect` `allow` while the response is an alert, because nothing was restricted).
  ADR-0303 already delivers every chained row, so the incident reaches the SIEM
  without a second export path and without widening the SIEM envelope. The receiver joins it to the evidence through
  the incident API, or through the signed export.
- **Foreign keys.** The incident's sponsor, grant and identity are foreign keys, set only when the id still resolves
  (the audit trail itself is FK-free). An incident about a deleted user keeps its group key and evidence.
- **Declared lifecycles.** `status` (open → acknowledged | closed; acknowledged → acknowledged | closed; closed is
  terminal) and `response_state` (none → done | failed; both terminal) are ADR-0348 machines,
  `DETECTION_INCIDENT_MACHINE` and `DETECTION_RESPONSE_MACHINE` in `@regulait/shared`. The status route's UPDATE is
  guarded with `whereFrom`, the incident read serves each machine's `describe()`, and the ADR-0348 test holds both
  tables equal to their CHECK constraints.
- **The sweep never feeds itself.** Rows with `objectType` `detection_incident` or `detection_rule_pack` are skipped.

### 5. Responses (slice 2)

- `alert` is the default for every rule.
- An admin may set a rule's `response` to one of three values. Each reuses an existing mechanism, so no new
  enforcement path is added:
  - `suspend_grant`: revoke the group's delegation tree at its root (`revokeDelegationGrant`, which cascades). Every
    later use of a grant in the tree fails, because `loadLiveChain` re-reads the path. The revoke reason is `admin`,
    and the actor is the pack author. A group that is not a delegation tree fails with `not_delegated`.
  - `revoke_credential`: revoke the acting identity's live short-lived access tokens (`issued_tokens`). The identity
    can mint new tokens through its own credential. For a lasting stop, use `suspend_grant`. A call with no actor
    fails with `no_actor_identity`.
  - `require_approval`: a user-scoped, all-servers approval rule for the sponsor, written through the one create
    (`createApprovalRuleRow`) with the pack author as approver. The sponsor's MCP tool calls then meet the existing
    Approvals Queue. This is stricter than "the next call": the rule stays until an admin removes it. If the
    approver would be the sponsor, the response fails with `no_independent_approver`. A second detection reuses the
    rule rather than adding another.
- A pack whose rules carry any response stronger than `alert` is a relaxation of the default posture. It needs a
  `settings_relax` step-up and is audited as one. Its author is the acting admin.
- Responses run after the incident commits, in the same leased pass. A pass that ends between the commit and the
  response leaves the response pending (`response_state = none`), and the next pass runs it. The outcome is recorded
  on the incident (`done` or `failed`, with a fixed `response_error_code`) and in a `detection-response` audit row.
  That row's effect is `deny` when the response took effect and `allow` when it did not. A failure is never retried
  silently.
- **One transaction per response (review of #1060).** The action, the guarded `response_state` move and the audit row
  commit together; `revokeDelegationGrant` and the approval-rule create join it as savepoints. A crash or an error
  between them rolls the action back, so a response is never applied without being recorded and audited. An
  unexpected error is recorded as `response_error` in a fresh transaction with nothing applied. A run against an
  incident whose response is already terminal changes nothing.
- **`require_approval` reuses only an identical rule.** An existing rule counts only if it has exactly the shape the
  response creates (user scope, all servers, no tool, not write-only, every deploy mode, per-action approval, the same
  approver). A narrower rule an admin set up earlier does not satisfy it, so the full rule is still created.
- **The pack author.** The acting admin and approver is the author of the pack version that raised the incident. Their
  standing is not re-checked when a restricting response runs; for `require_approval`, a pool the author can no longer
  satisfy is refused by the approval-rule create, so the response fails closed (`approval_rule_refused`).

### 5a. Device quarantine (slice 3, GAP_ANALYSIS_DARKCONTROL gap 4)

- **Endpoint decisions group by device.** An endpoint hook decision (ADR-0310 addendum) is audited with the nil user
  and the device as its object. Its group key is now `endpoint:<deviceId>`, not `user:<nil>`; before this slice every
  device's decisions fell into one group, so a burst on one device and a single deny on another counted together. The
  look-back is narrowed to the fresh devices as well as the fresh users.
- **`quarantine_device` is a fifth response.** It applies only to an `endpoint:` group (`not_endpoint` otherwise) and
  to a live device (`device_not_found` for a revoked or unknown one). It opens one active row in
  `endpoint_device_quarantines` for the rule's `quarantineHours` (1 to 720, default 72; the database caps the row at
  30 days). A device with an active quarantine keeps it: at most one is active per device (partial unique index), and
  the response reports `existing: true`. It runs in the response transaction of section 5, so it is never applied
  unrecorded. Like every response stronger than `alert`, it exists only in a pack stored behind a `settings_relax`
  step-up.
- **The lifecycle is an ADR-0348 machine**, `ENDPOINT_DEVICE_QUARANTINE_MACHINE` (`active -> released | expired`),
  held equal to the column's CHECK by the shared machine test. Every move is one conditional UPDATE from `whereFrom`.
- **Release needs a human admin with a step-up.** `POST /v1/detection/quarantines/:id/release` takes a `settings_relax`
  step-up bound to the quarantine. The method is stored on the row, and the release is audited
  (`detection-quarantine-released`). A system or bootstrap principal without a user cannot release.
- **Expiry** is run by the sweep, at most 100 rows per pass, one `detection-quarantine-expired` audit row each.
- **The kill switch: narrowing only (ADR-0338 §7, reused, not rebuilt).** The generic guard ADR-0338 §5 specifies,
  `killSwitchNarrowingOnly({ dial, direction })`, is in `@regulait/shared` (it had not been built when this slice
  started; lane E19 imports it instead of writing it). Opening a quarantine is narrowing and runs under any execution
  dial. Release and expiry are widening: while the dial is not `normal`, a release is refused
  (`execution_dial_not_normal`) and nothing expires, so a halt keeps every quarantine in force.
- **Enforcement on the device is not delivered yet (owner question open).** The hook decides on the device (ADR-0298),
  and no gateway call is attributed to a device, so the gateway cannot refuse the device's AI tools alone. Delivering
  "deny-all for AI tools while quarantined" needs the agent to learn of its quarantine through its signed channel: a
  change to `agents/endpoint/` (lane E13). `activeQuarantineForDevice` is the read that delivery uses. Until it lands,
  every quarantine view says `deviceEnforcement: "not_delivered"` (ADR-0180: an unknown is never shown as fine).
- **Admin routes** (admin-only by the default gate, API only; the screens are known UI gaps on #453):
  `GET /v1/detection/quarantines` (keyset-paginated, by status or device), `GET /v1/detection/quarantines/:id` (with
  its `describe()` lifecycle), and the release route above. RLS is enabled and forced on the table, with the incident
  tables' admin and `system_task` policy.

### 6. Reuse and open-source search (ADR-0176)

**In the repo first:**
- **The audit chain and receipts (ADR-0060, ADR-0186).** They are the event source and the evidence. Receipts are
  joined, not copied.
- **The SIEM exporter (ADR-0303).** Incidents reach it as chained audit rows. There is no second export path and no
  change to the envelope.
- **The policy rule evaluator (Cedar in `@regulait/policy-kernel`).** It matches selectors and tool classes.
- **The receipt signing key.** It signs the rule pack, registered through `registerReceiptSigningKey`.
- **`requireStepUp`.** It gates relaxations (`settings_relax`).
- **The scheduler.** It runs the sweep.
- **Responses.** `revokeDelegationGrant` (ADR-0188), the `issued_tokens` revocation, and `createApprovalRuleRow`,
  which leads into the Approvals Queue.
- **Not reused: ADR-0186's monitor rules.** They are periodic 24-hour posture checks over the assurance monitor, with
  no per-session window, so they stay separate.
- **Not reused: `governance_alerts` (ADR-0157) and `ai_incidents` (ADR-0182 A12), checked in the review of #865.**
  - `governance_alerts` keeps ONE active row per (rule, subject) episode (`governance_alerts_active_uq`) and folds
    every repeat into `last_detected_at` and a jsonb `detail`. A detection needs one row per match:
    - its own evidence chain, a join table to the exact audit rows and their receipts (ADR-0200: never a jsonb list
      of ids);
    - the signed pack version that raised it (a foreign key);
    - its own configured response with a run-once state (§5);
    - the `historical` flag with its alert-only CHECK.

    Two separate escalation attempts in one delegation tree are two incidents with two evidence chains, not one
    episode. The burst rule's episode semantics (§2, `event_count`) are kept in the engine instead.
  - `ai_incidents` is the human-run AI incident register: notification clocks, corrective actions, root cause and
    deploy-gate release. A machine detection is an input a responder may promote into it, not an incident of that
    register, and raising every match there would flood it.
  - Follow-up, not in this slice: raise a `governance_alerts` episode per (rule, group) that points at the incidents,
    so detections inherit that table's owner and SLA sweep.

**Open source, for the windowed sequence part:**
- **json-rules-engine 7.3.1 (ISC).** Stateless facts-to-events rules with no sequence or window. Its last release
  was 2025-02, so it fails the maintenance test.
- **eep 0.3.1 (MIT).** Windowed aggregates, but its last release was 2022.
- **node-red-contrib-cep.** Needs Node-RED as a runtime.
- **RxJS 7.8.2 (Apache-2.0).** Maintained, but its windows are in-process memory. The gateway runs as several
  replicas, and the state must be shared and survive a restart.
- **Esper (GPL) and Siddhi and Flink CEP (Apache-2.0, JVM).** These would add a JVM sidecar for five rules. Esper's
  licence is also refused.
- **Sigma correlation rules (specification, no maintained JS evaluator).** The vocabulary is adopted (section 2), so
  an admin who knows Sigma reads the pack directly.

**Exception recorded.** The window logic is our own code (about 80 lines: ordered steps, a count at a threshold, and
look-back within a timespan). No validated module meets two hard requirements: multi-replica state, and evaluation
over our own hash-chained evidence format. Matching itself is not hand-written. Re-check when a maintained,
permissive JS evaluator for Sigma correlation rules appears.

### 7. Off and on

Detection is **on by default**: it observes and alerts, which is the strict setting (ADR-0180). Turning a rule off is
a relaxation (section 2). The default response is an alert. Nothing blocks until an admin chooses it with a step-up.

## Owner decisions (2026-11-15, relayed by the master session on #865)

- **D1:** "`high-risk-addon-call` fires on High/Critical MCP servers AND High/Critical builder skills
  (`builder_skills.admission_severity`)."
- **D2:** "on first run, detection ALWAYS REPLAYS the retained history (not start-at-chain-head). Make the replay
  bounded and resumable (batched, checkpointed), so a large history cannot stall the engine; incidents from replay
  are marked as historical."

As built:
- **D1.** An event's add-on severity is the higher of two values: its MCP server's admission severity, and the highest
  severity among the skills attached to the builder agent that made the call (`detail.builderAgentId` →
  `builder_agent_skills` → `builder_skills.admission_severity`). The rule no longer requires `objectType` `mcp_tool`.
- **D2.** Section 1, "First run replays history".

## Consequences

- An admin sees combinations of individually allowed calls as incidents, with the audit rows and receipts that prove
  them, and the SIEM receives each incident as a chained audit event.
- Tool classes match names, not behaviour. A tool named to evade a class is not caught by that class. The pack is
  editable so that each deployment can tune it, and the incident evidence makes false positives cheap to review.
- The routes are API only. The screens are known UI gaps tracked on #453.
- **Follow-ups:** endpoint hook decisions in the audit chain (lane E13, ADR-0298 follow-up); a per-rule suppression
  list for known-good automations; a rule test harness in the admin API (dry-run a pack over a past window).

