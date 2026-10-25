# ADR-0202: Live integrations and a public HTTPS endpoint for the 2026-11-03 demo

- **Status**: Accepted
- **Date**: 2026-10-25

## Context

The owner wants the 2026-11-03 demo to be as authentic as possible: deployed as a hosted service and linked to real
third-party apps (owner, 2026-10-25, #453 comments 6393636981, 6393671561, 6393712592 and 6394196962). Until now the demo seed pointed every git,
PM, deploy and model connection at `provider: "mock"`. The "Enforce it" beat (ADR-0197 addendum, FS-8) was a simulated
decision on the Simulation page (#453 c6387779914). The dev host (ADR-0013) serves plain HTTP on port 3000 with no domain.

An inventory of origin/main (2026-10-25) found the following:
- The GitHub, Jira, Azure DevOps and Slack providers are already live-capable, and every outbound call goes through the
  egress guard.
- Slack inbound is HMAC-signed with a 300 s replay window.
- Jira inbound is a URL token compared in constant time, and Azure DevOps inbound uses basic auth.
- GitHub has no inbound webhooks, so PR and check state is polled.
- Credentials are entered through the API and stored encrypted under `REGULAIT_DATA_KEY`.
- The product has no SMTP or Resend code. Only the sign-in service (Keycloak) has an SMTP setting.

## Decision

1. **Scope: real integrations before the demo.** The demo connects for real to GitHub, Jira Cloud, Azure DevOps (both PM
   tools) and Slack, and sends real email through Resend. This supersedes the FS-8 answer of c6387779914: the "Enforce it"
   beat becomes a live governed call (a real deny, a real approval request posted to Slack and email, approval, then the
   real downstream PR and work-item updates).
2. **Email, two ways.**
   - Sign-in email (verification, invite, password reset): Keycloak's SMTP setting points at Resend. This is
     configuration only.
   - A new product email channel for approvals and alerts, built on Resend's official SDK. ADR-0176 applies: the
     licence and maintenance are checked, the version is pinned, there is a `THIRD_PARTY.md` row, and
     `api.resend.com` is on the egress allow-list.
3. **Hosting: the existing AWS dev host, behind a domain and HTTPS** (c6393636981).
   - The app runs on a subdomain of a domain the owner already owns (c6394196962).
   - TLS is terminated by an open-source reverse proxy with automatic certificates, and port 3000 stops being public.
     This is the lane plan the owner approved with the go-ahead (c6393712592).
   - Implementation choices, not separate owner decisions:
     - mail sends from its own mail subdomain, following Resend's guidance;
     - the domain lives in environment config (`REGULAIT_PUBLIC_URL` and related settings), never in code.
   - This lifts the earlier "no `terraform apply` to the dev host before 11-03" hold for this change only. Under the
     standing guardrail, each apply still runs on the owner's go-ahead in that session.
   - **It remains a demo environment and gets no production designation** (standing guardrail).
4. **A simulated fallback is kept.** Every beat is live by default. An admin switch per beat returns it to today's
   simulated version, so a third-party outage cannot sink the demo. The switch is off by default and audited when used
   (ADR-0180). As ADR-0197 already requires, the simulated path is labelled "simulated decision" on screen.
5. **Credentials never pass through chat or files in the repo.** This follows from existing policy (the CLAUDE.md
   security checklist and the standing constraints), not a new owner decision. The owner creates the accounts and enters each token,
   signing secret or API key through the product's admin UI or API, or on the host. Only variable names appear in
   docs.
6. **Everything by 10-29 (owner, c6394196962).** The lane code, account setup, DNS, the Terraform apply and the live
   checks are all done by the 2026-10-29 freeze, through the normal review and release process. A beat that is not
   working live by then runs on its simulated fallback on 11-01 and 11-03.

## Consequences

- The demo rehearsal gains real external dependencies: rate limits, outages and account setup. The fallback switch and
  the 11-01 internal run-through cover that risk.
- New code in four days: the Resend channel, a live-demo seed profile with the fallback switch, the reverse proxy and
  Terraform change, and the re-scripted "Enforce it" beat. Any new admin UI counts against the `all JS` ceiling, which
  has no headroom (1,040 kB), so UI for the new channel stays in lazy chunks or reuses existing channel screens.
- Inbound callbacks from Slack, Jira and Azure DevOps reach the gateway's public HTTPS URL. Their verification is
  already in place. GitHub stays polled.
- Owner actions: register DNS records for the app and mail subdomains, verify the sending domain in Resend, and create
  the GitHub, Jira, Azure DevOps and Slack demo accounts and credentials. `internal/product/DEMO_REAL_ACCOUNTS.md` gains a
  section for each.
- After the demo, a hosted service beyond demo use (managed Postgres, autoscaling, a production designation) is a
  separate decision under ADR-0013's own limits.

## Addendum: 2026-10-25, the "Enforce it" scope and the Resend client

- **The live "Enforce it" beat ends at the approved write (owner, #453 c6397414910).** This narrows decision 1. The beat shows:
  - a real deny, audited, with the revocation named;
  - a real approval request posted to Slack and email;
  - approval;
  - the approved write executing through the governed route.

  It does not open a PR or update Jira/Azure DevOps work items. Those are shown in the demo's own git-PR and PM-sync beats (lane L's beat ids `git-pr` and `pm-sync`).
- **Resend is called through its REST API, not its SDK (#568, as built).** Decision 2 named Resend's official SDK. The SDK cannot route requests through an injected fetch, reads `RESEND_*` environment variables and logs error bodies. It therefore fails the requirement that the egress guard decides every outbound request. Under ADR-0176 rule 4, the channel calls `POST /emails` through the guarded fetch instead. The check is recorded in `packages/connector-provider/THIRD_PARTY.md`.
