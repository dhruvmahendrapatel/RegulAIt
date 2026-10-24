# RegulAIt Positioning Talk Track — 2026-11-01 demo (v3)

**Date:** internal run-through Sun 2026-11-01; external demo Tue 2026-11-03 · **Audience:** internal, whoever presents the demo
**Goes with:** `DEMO_SCRIPT_2026-11-01.md`. The 2026-10-05 talk track stays valid for the governance beats; this
file adds the Shadow AI opening and restates the rules.
**Rule:** every claim here is something the demo shows or an ADR documents. Say what RegulAIt does; do not
characterise how any other product works.

---

## Core positioning: find it, bring it in, govern it, on evidence

RegulAIt sits on the execution path, and now also looks outward, read-only. It finds AI nobody registered, brings it
into the governed path with a second person's sign-off, and then governs it from what the platform actually saw.

### 1. Discovery that says what it can and cannot see (ADR-0195)
- **Ten source kinds in three families, all read-only:** source-control groups (GitHub, GitLab, Bitbucket, Azure
  DevOps), cloud accounts (AWS, Azure, GCP), and endpoints (an osquery pack or MDM/EDR export with no agent, or the
  RegulAIt endpoint agent) (`DISCOVERY_SOURCE_KINDS`, `packages/shared/src/discovery/index.ts`; FS-28).
- **In this demo** (owner, 2026-10-24, FS-1): the live path shows the three network sources and an agentless MDM/EDR
  inventory import of our demo laptop. The endpoint agent appears only on the prepared copy, and its line is: "its
  signed collection-pack stage is pending, so this copy's agent reports were seeded." Platform coverage, if asked
  (FS-10): Linux built; Windows built and unit-tested, not yet enrolled on a real host, no installer; macOS needs the
  Secure Enclave build, pending.
- **Off by default.** Every source starts disabled. Enabling one, widening what it scans, storing a static secret and
  revealing a pseudonym each ask the admin to confirm it is them, and each is audited (ADR-0195, ADR-0180).
- **Detection is data.** An observation becomes a finding only when it matches an enabled row of the admin's
  signature catalogue; unmatched observations are listed per run as catalogue gaps (ADR-0083 §3).
- **Coverage is honest.** The page says how many evidence classes were analysed, names every enabled source, and
  ends: *"this inventory reduces shadow AI — it does not prove its absence."* (`coverageScorecard`,
  `packages/shared/src/shadow-ai.ts`).

### 2. What discovery keeps, and what it never keeps (ADR-0195 decisions 6 and 20; lane A6)
- **Locations and names, never contents.** A repository sighting is a path, a line and a commit. Raw scanner output is
  digested (SHA-256) and discarded. A detected key is kept only as an 8-character redacted prefix and where it was
  found; a scanner never tests a key it finds.
- **Environment variables:** the names are matched against presence signatures, and only the signature ids are
  stored. Neither the name nor the value is kept.
- **People are pseudonyms by default:** commit authors, cloud calling principals, devices and device users appear as
  `psn:` plus a per-tenant keyed hash. The real name is stored encrypted; revealing it is a step-up and is audited.
- **Endpoint evidence** is kept 90 days by default; keeping it longer is a relaxation.

### 3. Keyless where the provider allows it (ADR-0195 SD2b; ADR-0197 decision 3)
- AWS and Azure accept a five-minute token from RegulAIt's own federation issuer (RS256, one audience per token),
  `<REGULAIT_PUBLIC_URL>/federation`, which is separate from the workload-identity issuer, so a token from one never
  verifies at the other. The customer's role or app registration trusts that issuer; no long-lived cloud secret is
  stored. Say "RegulAIt stores no cloud credential", never "keeps no key": the product holds its issuer's private
  signing key (FS-50).
- Git: GitHub and Azure DevOps sources federate by default (built; not yet run against a live account). GitLab and
  Bitbucket accept no third-party token, so they use a read-only token, stored encrypted and never shown, and the
  posture page lists it as a relaxation (`docs/deployment/GIT_DISCOVERY_CREDENTIALS.md`). The demo's GitLab group is
  that case.
- A credential found to grant write access is refused and never used again, **where the provider lets us check**.
  Today only the repository scanner checks write scope; the cloud rows read **Write scope unverified**, and the
  presenter says so (FS-27).

### 4. From finding to governed state, with a second person (ADR-0055 §4, ADR-0195 A4)
- A finding's remediation plan starts a workflow through the one instantiation route, so assignment rules and the
  compliance cascade still apply.
- The shipped default is strict: plan-only first, then a remediation-plan artifact, then a sign-off by an admin
  other than the initiator. With no second admin, the workflow does not start. In the demo, Ada initiates and Morgan
  Reyes, the security lead and second admin (with MFA), signs off; Avery stays the independent governance reviewer.
- The sign-off is the same approvals queue as every other change: no separate mechanism (`workflow-approvers.ts`).
- **Closure is a person's act.** When the next call appears in the audit log and usage ledger, a person records the
  finding's disposition on that evidence; nothing marks a finding remediated automatically (FS-51).
- **Register as use case** opens intake prefilled with only what the evidence established: the name and the
  observed use. Every screening answer is the proposer's.

### 5-12. The governance beats
Unchanged from the 10-05 talk track, sections 1-8: trust metrics as evidence coverage; intake screening from
structured answers; separation of duties by construction; the dependency graph; continuous monitoring and strict
defaults; respond with a human in the loop; the deploy gate; regulatory intelligence joined to our own state.

### Enforcement, shown (beat E, added 2026-10-24; FS-8)
- No grant, no call: the kernel denies by default and the refusal names its rule; a write can wait for a named
  approver instead, and the approval is bound to the exact arguments approved. On screen this is the Simulation page:
  the live kernel's decision for a call it does not execute. Say that; never say a call was made or queued there.
- The cost line for G5: the off-stack alert exists because cost routing served approved traffic from an agent the
  approval never covered; cost and governance read the same ledger (ADR-0164).
- The audit line for G8: a **tamper-evident chain with external anchors**, graded from the medium. Never "immutable"
  (FS-34): rows are protected by the hash chain and the anchor, not by the database.

### 13. Content trust (optional beat; ADR-0193)
- Every MCP server and connector starts **untrusted**. A write is refused when the run already holds content from a
  source below the write floor, so text from a low-trust tool cannot make an agent change something.
- Each governed result is recorded by its source, tier and digests, never its content. The page makes no claim about
  any legal content-marking duty; nor should the presenter.

---

## Lines to use in the demo

1. "Every source starts off. Turning one on is a deliberate, audited act." (Discovery sources)
2. "Detection is a signal, not proof — each row says what each scanner saw, and where." (the sightings under **Evidence**)
3. "This inventory reduces shadow AI; it does not prove its absence." (Coverage sentence, read verbatim)
4. "We keep where it was and what it was called, never what it said." (Data minimisation)
5. "RegulAIt stores no cloud credential: your role trusts our issuer's five-minute token, bound to one source and one
   audience." (Federation; FS-50)
6. "The plan is not the change. The change needs someone else's signature." (Remediation workflow)
7. "The finding filled in only what the evidence established." (Register as use case)
8. "No grant, no call; the refusal names the rule and lands in the ledger." (E. Enforce it)
9. "Cost and governance read the same ledger." (G5)
10. "A tamper-evident chain with external anchors, graded from the medium." (G8)
11. **At the Close, unprompted** (Q13, owner 2026-10-24): "The model provider behind the governed traffic is a mock,
    the AI usage in our accounts was planted by us, and anything on the prepared copy was a recorded replay. The
    scans, the workflow, the sign-offs and the gate were the real product." (`DEMO_PRESENTER_NOTES_2026-11-01.md`)
12. The 10-05 lines 1-7 for the governance beats.

## Things never to say

- **Never claim automatic remediation.** Discovery, mapping and monitoring are automated; remediation and approval
  are human-gated, and the approver is never the initiator.
- **Never claim the inventory is complete**, or that RegulAIt "sees all AI in the company". It sees the sources an
  admin enabled and the evidence supplied, and says which.
- **Never say the planted usage is a customer's.** It is ours, planted for the demo under fictional names.
- **Never present the fallback's recorded runs as live scans.** On the prepared copy, the GitLab, AWS and Azure runs
  are recorded replays through the real worker. The screen does not say so (**Reads** shows *all read*; only the
  *(demo dataset)* suffix on each source name marks them), so say it aloud.
- **Never call the demo's git scanning keyless.** GitLab uses a read-only token. GitHub and Azure DevOps federation
  is built but has not run against a live account: say "built", not "proven".
- **Never call the endpoint agent signed and shipped.** Its packages are built unsigned today; keyless release
  signing is decided (owner decision Q2) and not built.
- **Never say the endpoint agent scanned a real laptop.** No real agent reports yet: the gateway serves no signed
  collection pack. On the live path the laptop is an imported inventory export (FS-1).
- **Never call the audit trail "immutable".** Say "tamper-evident chain with external anchors" (FS-34).
- **Never say "keeps no key"** about federation. Say "stores no cloud credential" (FS-50).
- **Never present anything as production.** The AWS account is a non-production sandbox (ADR-0197 decision 2), and
  the remediation workflow's environment is `staging`, and so is the deploy gate's. The field's placeholder reads
  *"for example staging"*; type `staging` before pointing at it.
- **Never name or describe another governance product.**
