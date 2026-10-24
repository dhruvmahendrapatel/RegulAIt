# Presenter notes — 2026-11-01 run-through and 2026-11-03 demo

**Goes with:** `DEMO_SCRIPT_2026-11-01.md`. Owner decision of 2026-10-24 (#453, comment 6385378784, item 4): the S3
plan text and the two G3 acknowledgement notes are written here in advance, so nothing is composed on stage
(full-scan findings FS-7, FS-47, FS-49). Copy each block from this file into the box the script names.

**These texts are audited.** Every note below is stored with the decision and appears in the audit trail and the
signed bundle under the presenter's name. Keep them true for the run they are used in: if a fact in a note does not
hold on the day (another alert, another repository), change the note before the run, never on stage. Name no model
identifier and no real host, account, tenant or person.

---

## S3 — the remediation plan (Submit shadow AI remediation plan card)

The card's box takes the plan as text. The panel renders the plan's steps as list items and has no copy button, so
paste from here (FS-47). The plan names the repository it is about.

### 11-01, FALLBACK, second finding (FS-7)

On 11-01 the seeded workflow for `gitlab:acme-bank-demo/credit-memo-assistant` was already submitted by `demo:prepare`
(its plan is the seed's own text, `DEMO_SHADOW_DISCOVERY.remediation.plan`). Ada's live half is walked on the second
repository finding, which has no workflow yet:

```text
# Remediation plan: support-ticket-triage

1. Register the support-ticket triage use case and route its classification calls through a governed agent.
2. Replace the direct SDK client in triage/classify.py with the gateway endpoint; remove the provider key from the
   service's environment.
3. Confirm the next call appears in the audit log and the usage ledger, then record the finding's disposition.
```

### 11-03, LIVE, the finding chosen at T-24h

Fill in `<repository>` and the step 2 path from the finding's sighting line (`path:line @commit`) at the T-24h check,
then keep the three steps as written:

```text
# Remediation plan: <repository>

1. Register the use case this repository serves and route its AI calls through a governed agent.
2. Replace the direct SDK client in <path from the sighting line> with the gateway endpoint; remove the provider key
   from the service.
3. Confirm the next call appears in the audit log and the usage ledger, then record the finding's disposition.
```

Step 3 says "record the finding's disposition" on purpose: closing a finding is a person's disposition on ledger
evidence, never automatic (FS-51; Q&A 29).

---

## G3 — the two acknowledgement notes (Alerts, Active tab, pinned foot)

Each alert's panel asks for an **Acknowledgement note — required and audited** before **Acknowledge**. G3 takes
2.0 minutes (owner, item 4: 0.5 minutes moved from G4) so both notes are pasted, not typed. Paste the note that
matches the alert's title.

**Alert 1** — *"Real-Time Fraud Detection Engine inherits a HIGH rating from Acme Internal AI Platform"*:

```text
Acknowledged for the staging release only. The HIGH rating is inherited from Acme Internal AI Platform, and the risk
stays open on that record with its owner. The gate keeps listing this alert as a warning until the risk is treated.
```

**Alert 2** — *"n call(s) for Real-Time Fraud Detection Engine (to …) was / were served by …, which is outside its
approved stack"*:

```text
Acknowledged for the staging release only. These calls were served outside the approved stack; routing for this use
case must return to its approved stack before go-live. The alert resolves only when the monitor no longer sees
off-stack serving.
```

Neither note claims a fix that has not happened: an acknowledgement records that a person saw the alert and accepted
it for this release, and the gate still prints both as **WARN acknowledged_high_alert**.

On 11-01 these notes are entered on the FALLBACK stack only (`DEMO_RUNBOOK.md` §7.3, "11-01 run-through"). Never
acknowledge these alerts on LIVE before 11-03.

---

## Close — the mock-vs-live sentence (Q13)

Say it unprompted at the Close, in about ten seconds (owner, item 4):

> "To be exact about what you saw: the model provider behind the governed traffic is a mock, the AI usage in our
> accounts was planted by us, and on the prepared copy the three network scans were recorded replays and the endpoint
> agent's reports were seeded. The scans on the live accounts, the workflow, the sign-offs and the gate were the real
> product."

On the LIVE path, drop the last clause about the prepared copy if no beat used it.
