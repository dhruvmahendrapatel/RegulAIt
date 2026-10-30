# Presenter notes — demo of Saturday 2026-10-31

> **New date (owner, 2026-10-29, #453 comment 6508111468):** the demo runs once, on Sat 2026-10-31. The 11-01
> run-through and the 11-03 demo are gone; the file keeps its name.

**Goes with:** `DEMO_SCRIPT_2026-11-01.md`. Owner decision of 2026-10-24 (#453, comment 6385378784, item 4): the S3
plan text and the two G3 acknowledgement notes are written here in advance, so nothing is composed on stage
(full-scan findings FS-7, FS-47, FS-49). Copy each block from this file into the box the script names.

**These texts are audited.** Every note below is stored with the decision and appears in the audit trail and the
signed bundle under the presenter's name. Keep them true for the run they are used in: if a fact in a note does not
hold on the day (another alert, another repository), change the note before the run, never on stage. Name no model
identifier and no real host, account, tenant or person.

---

## S3 — the remediation plan (Submit shadow-AI remediation plan card)

The card's box takes the plan as text. The panel renders the plan's steps as list items and has no copy button, so
paste from here (FS-47). The plan names the repository it is about.

### FALLBACK rehearsal, second finding (FS-7)

On the FALLBACK rehearsal before 10-31 the seeded workflow for `gitlab:acme-bank-demo/credit-memo-assistant` was already submitted by `demo:prepare`
(its plan is the seed's own text, `DEMO_SHADOW_DISCOVERY.remediation.plan`). Ada's live half is walked on the second
repository finding, which has no workflow yet:

```text
# Remediation plan: support-ticket-triage

1. Register the support-ticket triage use case and route its classification calls through a governed agent.
2. Replace the direct SDK client in triage/classify.py with the gateway endpoint; remove the provider key from the
   service's environment.
3. Confirm the next call appears in the audit log and the usage ledger, then record the finding's disposition.
```

### 10-31, LIVE, the finding chosen at T-24h

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

## E — Enforce it, live (ADR-0202 lane F)

**The command.** On 10-31, in the laptop terminal in the LIVE checkout, as for G3 (`DEMO_RUNBOOK.md` §7.6; the dev-host
Session Manager recipe is superseded by ADR-0203). One line, run from the checkout, pending execution on the laptop:

```sh
printf '#!/bin/sh\ncd %s && docker compose exec -T gateway node apps/gateway/dist/demo-enforce.js\n' "'$PWD'" > ~/enforce.sh && chmod +x ~/enforce.sh
```

It runs inside the gateway container with the gateway's own bootstrap token and calls the gateway on its own loopback
port. At the FALLBACK rehearsal, on the laptop's FALLBACK stack: `pnpm --filter @regulait/gateway demo:enforce` with the same
environment as the other demo commands. Exit 0: the beat ran as scripted (or printed the simulated decision). Exit 1:
something answered differently, read the `***` line. Exit 2: a setup error, or a `REFUSED` line. The command refuses to
call anything unless the gateway shows it is a demo one (lane L's `GET /v1/demo/beats` answers and the seed's four
personas exist), and when that switch cannot be read; so until lane L's PR #572 is deployed on the stack it refuses.
After a timeout, approving and re-running prints `APPROVED (earlier) and EXECUTED` with exit 0: the re-run's first call
spent Avery's approval, which is the beat working, not a bypass.

**Avery's approval note** (Profile B, **Inbox**, the `write_file` request from Dana, **Approve**; paste, do not type):

```text
Approved for the Enforce it beat: one write of docs/enforce-it.md to the demo/enforce-it branch on the demo
repo-tools server, with exactly these arguments. Any other arguments need a new request.
```

The note is true for the beat's fixed arguments (`demo-enforce-lib.ts`, `ENFORCE_WRITE_ARGS`). If they change, change
the note before the run. If the approval asks for a passkey or a step-up, that is the stack's signing posture working;
the prompt on Avery's device is **to confirm at rehearsal**.

**Flip to the simulated fallback** only between runs (lane L's `enforce-it` switch, audited), never on stage. On stage,
if the shell shows no `DENIED` line within 15 seconds, press Ctrl-C and run the simulated beat on
`/ui/admin/simulation` (DEMO_SCRIPT E). Say "simulated decision" there, every time.

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

At rehearsal these notes are entered on the FALLBACK stack only (`DEMO_RUNBOOK.md` §7.3). On 10-31 they are entered
on LIVE, once. Never acknowledge these alerts on LIVE before the demo.

---

## Close — the mock-vs-live sentence (Q13)

Say it unprompted at the Close, in about ten seconds (owner, item 4):

> "To be exact about what you saw: the model provider behind the governed traffic is a mock, the AI usage in our
> accounts was planted by us, and on the prepared copy the three network scans were recorded replays and the endpoint
> agent's reports were seeded. The scans on the live accounts, the workflow, the sign-offs and the gate were the real
> product."

On the LIVE path, drop the last clause about the prepared copy if no beat used it.
