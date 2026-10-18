# RegulAIt Positioning Talk Track — 2026-11-01 demo (v3)

**Date:** 2026-11-01 · **Audience:** internal, whoever presents the demo
**Goes with:** `DEMO_SCRIPT_2026-11-01.md`. The 2026-10-05 talk track stays valid for the governance beats; this
file adds the Shadow AI opening and restates the rules.
**Rule:** every claim here is something the demo shows or an ADR documents. Say what RegulAIt does; do not
characterise how any other product works.

---

## Core positioning: find it, bring it in, govern it, on evidence

RegulAIt sits on the execution path, and now also looks outward, read-only. It finds AI nobody registered, brings it
into the governed path with a second person's sign-off, and then governs it from what the platform actually saw.

### 1. Discovery that says what it can and cannot see (ADR-0195)
- **Four families of source, all read-only:** source-control groups (GitHub, GitLab, Bitbucket, Azure DevOps), cloud
  accounts (AWS, Azure, GCP), and endpoints (an osquery pack or MDM/EDR export with no agent, or the RegulAIt endpoint
  agent).
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
- AWS and Azure accept a five-minute token from RegulAIt's own federation issuer (RS256, one audience per token).
  The customer's role or app registration trusts that issuer; no long-lived cloud secret is stored.
- Git providers are the stated exception today: repository scans use a read-only token, stored encrypted and never
  shown, and the posture page lists it as a relaxation. Federated git credentials are planned (ADR-0197 work plan,
  A5).
- A credential found to grant write access is refused and never used again.

### 4. From finding to governed state, with a second person (ADR-0055 §4, ADR-0195 A4)
- A finding's remediation plan starts a workflow through the one instantiation route, so assignment rules and the
  compliance cascade still apply.
- The shipped default is strict: plan-only first, then a remediation-plan artifact, then a sign-off by an admin
  other than the initiator. With no second admin, the workflow does not start.
- **Register as use case** opens intake prefilled with only what the evidence established: the name and the
  observed use. Every screening answer is the proposer's.

### 5-12. The governance beats
Unchanged from the 10-05 talk track, sections 1-8: trust metrics as evidence coverage; intake screening from
structured answers; separation of duties by construction; the dependency graph; continuous monitoring and strict
defaults; respond with a human in the loop; the deploy gate; regulatory intelligence joined to our own state.

### 13. Content trust (optional beat; ADR-0193)
- Every MCP server and connector starts **untrusted**. A write is refused when the run already holds content from a
  source below the write floor, so text from a low-trust tool cannot make an agent change something.
- Each governed result is recorded by its source, tier and digests, never its content. The page makes no claim about
  any legal content-marking duty; nor should the presenter.

---

## Lines to use in the demo

1. "Every source starts off. Turning one on is a deliberate, audited act." (Discovery sources)
2. "Detection is a signal, not proof — each row says what each scanner saw, and where." (Sightings)
3. "This inventory reduces shadow AI; it does not prove its absence." (Coverage sentence, read verbatim)
4. "We keep where it was and what it was called, never what it said." (Data minimisation)
5. "No stored cloud key: the account trusts our issuer for five minutes at a time." (Federation)
6. "The plan is not the change. The change needs someone else's signature." (Remediation workflow)
7. "The finding filled in only what the evidence established." (Register as use case)
8. The 10-05 lines 1-7 for the governance beats.

## Things never to say

- **Never claim automatic remediation.** Discovery, mapping and monitoring are automated; remediation and approval
  are human-gated, and the approver is never the initiator.
- **Never claim the inventory is complete**, or that RegulAIt "sees all AI in the company". It sees the sources an
  admin enabled and the evidence supplied, and says which.
- **Never say the planted usage is a customer's.** It is ours, planted for the demo under fictional names.
- **Never call git scanning keyless.** It uses a read-only token today.
- **Never call the endpoint agent signed and shipped.** Its packages are built unsigned today; keyless release
  signing is decided (owner decision Q2) and not built.
- **Never present anything as production.** The AWS account is a non-production sandbox (ADR-0197 decision 2), and
  the remediation workflow's environment is `sandbox`.
- **Never name or describe another governance product.**
