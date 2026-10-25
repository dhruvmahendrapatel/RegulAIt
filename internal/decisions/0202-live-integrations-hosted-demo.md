# ADR-0202: Live integrations and a public HTTPS endpoint for the 2026-11-03 demo

- **Status**: Accepted
- **Date**: 2026-10-25

## Context

The owner wants the 2026-11-03 demo to be as authentic as possible: deployed as a hosted service and linked to real
third-party apps (owner, 2026-10-25, #453 comments 6393636981 and 6393671561). Until now the demo seed pointed every git,
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
3. **Hosting: the existing AWS dev host, behind a domain and HTTPS.**
   - The domain is a subdomain of a domain the owner already owns.
   - Mail sends from its own mail subdomain.
   - The domain lives in environment config (`REGULAIT_PUBLIC_URL` and related settings), never in code.
   - TLS is terminated by an open-source reverse proxy with automatic certificates, and port 3000 stops being public.
   - This lifts the earlier "no `terraform apply` to the dev host before 11-03" hold for this change only. Each apply
     still runs on the owner's go-ahead in that session.
   - **It remains a demo environment and gets no production designation** (standing guardrail).
4. **A simulated fallback is kept.** Every beat is live by default. An admin switch per beat returns it to today's
   simulated version, so a third-party outage cannot sink the demo. The switch is off by default and audited when used
   (ADR-0180). The simulated path must still be labelled "simulated decision" on screen.
5. **Credentials never pass through chat or files in the repo.** The owner creates the accounts and enters each token,
   signing secret or API key through the product's admin UI or API, or on the host. Only variable names appear in
   docs.
6. **The freeze stands.** Work under this ADR must be merged by 2026-10-29 through the normal review and release
   process. A beat that is not green by then runs on its simulated fallback on 11-01 and 11-03.

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
