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
