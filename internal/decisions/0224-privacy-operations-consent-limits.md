# ADR-0224: Privacy operations and consent-based limits on what customer data AI may use (P13 c)

- **Status**: Accepted (first slice; follow-ups listed below)
- **Date**: 2026-10-30

## Context

The owner said yes to P13(c) on 2026-10-30 (#453, comment 6527069781) as one of four P13 lanes, with migration numbers
0245–0246 and this ADR number reserved in comment 6527158879 (the migrations were renumbered to 0251–0252 at merge, M-108). The common backlog rules (comment 6522850568) apply:
default-off org setting, admin-only with step-up for relaxations, each write audited in its transaction, open source
first, and a UI placement note before any UI.

RegulAIt already had the pieces privacy operations sit on, but no privacy operations of its own:

- The §8.3 compliance cascade turns a classification tag into a PII handling mode (`block`, `warn`, `log`), with the
  org default (`defaultPiiMode`) as the floor under it, enforced at the governed dispatch path (`dispatchAttempt`).
- `@regulait/shared`'s PII detector (`detectPII`) reports per-category counts, never the matched text, with an
  org-chosen list of national-identifier jurisdictions (ADR-0117).
- AI use cases link to projects (`ai_use_cases.project_id`), and every governed dispatch carries a project
  attribution (ADR-0080 B6b).
- The audit log is tamper-evident (hash-chained, ADR-0067) and pruned only by its retention rule.

What was missing: a record of why personal data is processed for each AI system, a way to track and answer a person's
access, erasure or objection request, and any limit on *which* personal data a project may send to a model. The PII
mode decides whether personal data may pass at all; it does not say that one project may process email addresses and
another may not.

## Decision

1. **Records of processing.** A new table, `processing_records` (migration 0251, hand-written), holds an AI system's
   purpose, lawful basis (the six GDPR Article 6(1) bases), data categories, retention in days and recipients, linked
   to a project, a use case, or both (never neither, by a CHECK). A record is `active` or `retired`. Routes under
   `/v1/privacy/processing-records` are admin-only (the default gate). A write that widens what the gateway permits — a
   new record, an added category, a retired record brought back — needs a `settings_relax` step-up and is audited with
   `relaxation: true`; narrowing or retiring needs none. Each write is audited in its transaction. A concurrent edit is
   refused 409 rather than slipping a widening past the step-up decision.

2. **Data categories are the detector's categories.** A record lists categories the PII detector reports (email,
   phone, payment card, US SSN and the ten national identifiers of ADR-0117). The limit is then an exact set comparison
   over what the detector found. A category the detector cannot see cannot be limited, so it is not offered.

3. **The processing limit at dispatch, behind a default-off setting.** `org_settings.privacy_ops_enabled` ships false
   (owner rule for new backlog features). When on, `privacyDispatchGate` runs on the governed dispatch path directly
   after the PII-mode rung and before any provider work:
   - an input with no personal data is untouched;
   - personal data whose category no active record for the dispatch's project permits is refused 409
     `processing_not_permitted`, audited (`processing-not-permitted`) with categories, counts and record ids only;
   - the permitting records are those linked to the project, or to a use case linked to it;
   - an unattributed dispatch has no record that could permit it, so personal data in one is refused (default-deny).
   The cascade still decides first: a project whose PII mode is `block` refuses before this rung runs. The rung reuses
   the detector and the jurisdiction list the PII mode uses, rather than a second classifier. Turning the setting off
   again is a relaxation (stored-value rule, ADR-0186 decision 27), so it needs the step-up and is named in the audit
   row.

4. **Data-subject requests hold no personal data.** `data_subject_requests` (migration 0252) stores the request type
   (access, erasure, objection), how the person is identified (email or phone), the admin's own reference, the status
   and the due date. The identifier itself is never stored or logged: the row keeps an HMAC-SHA256 of the normalised
   identifier under a key derived (HKDF) from the data key. Locating the person's data and completing an erasure each
   ask for the identifier again, check it against the digest (409 `identifier_mismatch` otherwise) and drop it. The due
   date is `received + org_settings.dsr_sla_days` (default 30, the one-month Article 12(3) default; shorter is
   stricter, longer is a relaxation).

5. **Locate returns counts per store.** The RegulAIt-held stores searched are user accounts (email only),
   conversations (messages and summaries), shared project context and the audit trail. The search is a parameterised,
   case-insensitive substring test, never a pattern built from input.

6. **Erasure never edits the audit trail.** Completing an erasure replaces the identifier with `[erased]` in
   conversation messages, conversation summaries and every revision of matching shared context items, in one
   transaction with the close and its audit row. The audit trail is tamper-evident, so its matching rows are kept until
   their retention rule prunes them; a row in `data_subject_tombstones` lists them (up to 5,000 ids, with an exact
   count) and the earliest date the composed retention floor lets them go, or says that no retention period is set.
   User accounts are reported, not deleted: deactivation is the existing audited user flow.

7. **UI.** A new Privacy group in the Compliance & infra suite, beside the compliance pages (placement note on #453,
   comment 6527284732): Records of processing and Data subject requests, one lazy-loaded chunk. The Organization
   settings page is unchanged in this slice; the switch is set through the existing audited settings route.

8. **Open source first (ADR-0176).** Searched on 2026-10-30 for an embeddable record-of-processing (RoPA) or DSR
   library for TypeScript. What exists is hosted DSAR products, a standalone MCP server that keeps its own inventory,
   and Fides (Apache-2.0), a Python privacy platform that runs as its own service with its own database and auth. None
   is a library that can run inside the gateway's transaction, audit and enforcement model, and running a second
   service would put personal-data handling outside the one audit trail. The workflow is therefore ours; detection is
   the existing detector; HMAC and HKDF are node's; validation is zod. No new dependency.

## Consequences

- An org that turns the limit on must write a record for each project that sends personal data, or those dispatches
  are refused. That is the intended default-deny posture, and the refusal sentence says where to add the record.
- Postgres row-level security is not added: RegulAIt is single-tenant per installation and no table in the schema uses
  RLS today. Object-level authorisation is admin-only on every route.
- The global request rate limit applies; locate scans the audit log without an index on its text and is admin-only.

### Honest limits and follow-ups

- The limit runs on the governed model-dispatch path only. Connector calls and MCP tool calls are not yet limited by
  records of processing; they still get the cascade's PII mode.
- There is no per-call declared purpose: purpose limitation is at project and use-case granularity.
- An upheld objection is recorded and closed, but not yet enforced per subject at dispatch (that needs a match on the
  subject's identifier in the input, which the detector deliberately does not return).
- Erasure replaces the identifier as typed; other details about the person in the same text are not found. Phone
  numbers are matched as typed, so a different formatting in stored text is missed.
- Erasure has no dedicated step-up kind; adding one is a migration of `step_up_actions` and every kind list.
- Rotating the data key changes the digest key, so open requests recorded before a rotation can no longer be matched.
- The Organization settings page has no control for `privacyOpsEnabled` or `dsrSlaDays` yet.

## Addendum, 2026-10-31: review fixes (#626)

1. **Locate and erasure match the subject at a boundary.** The first slice used a bare substring test, so erasing
   `ann@example.com` would also have rewritten `joann@example.com` and `ann@example.com.au`, and a phone number would
   have matched inside a longer digit run. One pattern (`subjectPattern` in `privacy-ops.ts`) is now used for the locate
   counts, the erasure `UPDATE ... WHERE` and the replacement. It is the escaped identifier anchored by lookarounds that
   Postgres AREs support, matched case-insensitively with `~*`:
   - an email is not preceded by a local-part character, and not followed by a domain character or a further `.label`;
   - a phone number is not preceded or followed by a digit.

   A Postgres test puts superstring neighbours in the same message and in a message of their own, and checks that they
   survive byte for byte and are not counted.
2. **The processing limit runs before the semantic-cache lookup.** It now also runs in the native invoke handler,
   directly after the hoisted PII input rung, and refuses before any cache work. The `dispatchAttempt` call stays for the
   orchestration and worker paths. At the reviewed head a cache hit was already served inside `dispatchAttempt`, after
   this rung (the cache test passes with or without the hoist). The hoist makes the order explicit and refuses before
   the lookup; the test pins the behaviour.
3. **The switch is on the Records of processing page.** Turning the limit off goes through the stepped-up settings
   write, as a relaxation.
4. **Locate says what it searched.** The response (`searchScope`) and the page both say that only the four RegulAIt-held
   stores are searched, for the identifier as typed.
5. **Erasure still has no step-up.** None of the existing kinds describes it truthfully: the dialog would tell the admin
   they were "loosening a security setting". A dedicated kind is still the follow-up.

Further honest limits:
- `conversation_messages.detail` (jsonb) is neither searched nor erased.
- Training-corpus ingest (`regulait-llm.ts`) sends scanned corpora to trainers without the processing limit, like the
  connector and MCP paths.
6. **Entry bundle (2026-10-31).** After main was merged, the entry chunk was 44 B over its 138.5 kB ceiling. The two
   privacy pages now ship in the existing Compliance & infra lazy chunk, not a chunk of their own, and Records of
   processing lives at `/admin/privacy` (the requests page stays at `/admin/privacy/requests`). Main's own entry is
   138.36 kB, so this lane fits with about 5 B to spare. The next lane that grows the entry will need the owner's
   ceiling decision.
