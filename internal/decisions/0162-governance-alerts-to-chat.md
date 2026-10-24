# ADR-0162: Governance-Monitor Alerts Delivered to Chat Through the Guarded Courier

Status: Accepted (implemented)
Date: 2026-10-02
Related: ADR-0157 (monitor), ADR-0061/0113/0121 (ChatOps, Teams, Outlook),
ADR-0034 (egress allow-list)
Migration: 0127 (`chatops_connections.notify_alert_min_severity`)

## Context

Alerts reached the audit log (and so SIEM) but not the people who act on
them. "How does an alert reach us?" is the first question after a monitoring
demo; the platform already has a ChatOps courier with every guard it needs.

## Decision

1. **Opt-in per workspace**: `notify_alert_min_severity` (`medium` | `high` |
   null = off, the default). Set at creation or with
   `PATCH /v1/chatops/connections/:id` (admin, audited
   `chatops-alert-settings-changed`).
2. **Newly RAISED alerts only**: the monitor hands the ids it raised to a
   notifier registered by the ChatOps routes; persisting alerts are refreshed,
   never re-posted. `POST /v1/governance/alerts/:id/post` posts one alert on
   demand regardless of threshold.
3. **The same courier**: `postCard` — egress allow-list on every post, bot
   token from the connector credential store, Slack and Teams. Air-gapped
   installs have no allow entry, so nothing leaves.
4. **Information, never a decision**: alert cards carry no actions, so no
   renderer can show a button; the portal link is where a person acts.
   Content is the alert title (governance metadata: names of use cases,
   agents, vendors), never prompt or response text.
5. **Best effort, fully audited**: every post is `chatops-alert-posted` or
   `chatops-alert-post-failed` with the reason; a chat outage never fails a
   monitor pass.

## Consequences

- An org that wants alerts in chat must allow-list the chat host, as for
  approval cards — deliberately no vendor exemption.
- Email delivery is not added here; the Outlook connection is send-only for
  approvals and could carry alerts in a follow-up.

## Tests

`apps/gateway/src/zz-adr0162-chat-alerts.test.ts` (3, against a real local
Slack): high posted / medium not / no re-post / no buttons; PATCH + manual
post; egress refusal audited and non-fatal.
