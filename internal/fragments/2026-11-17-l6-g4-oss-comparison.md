<!-- fold: state -->
**ADR-0317 G4: open-source comparison (rule 9, 2026-11-17).** Searched GitHub and npm for a receiver to start work
from a Jira or Azure Boards assignment. Checked 2026-11-17:

| Option | Licence | Maintained | Fit |
| --- | --- | --- | --- |
| `atlassian-connect-express` (Atlassian Connect app framework) | Apache-2.0 | last release 2025-05, Connect is being retired for Forge | No: it is an app framework (installs, JWT lifecycle, its own store) and the brief excludes building an Atlassian app |
| `jira.js` (Jira REST client) | MIT | release 2026-10 | Partial: a typed client, but it brings a second HTTP path beside the governed fetch and egress guard (ADR-0289 rejected it for the same reason); it has no inbound webhook handling |
| `azure-devops-node-api` (Microsoft) | MIT | release 2026-09 | Partial: the REST client only; service-hook delivery is a plain signed POST it does not verify |
| `@octokit/webhooks` | MIT | release 2026-07 | No: the right shape (verify and dispatch), but GitHub-only |
| Reuse our own PM adapters plus the existing generic webhook route (chosen) | ours | n/a | Yes: one signed, replay-guarded inbound route (ADR-0207 rotation, `pm_webhook_deliveries`), the same egress guard and audit trail |

**Chosen approach:** the existing adapters. Nothing in the ecosystem verifies Jira or ADO service-hook deliveries
without also adding a second network path or an app framework. Re-check this if Atlassian or Microsoft publish a
verification library.
- **Rule 12:** `pm_assignment_starts` has no status column. A row is the start claim and is written once; outcomes
  are audited rather than stored as state, so there is no lifecycle to declare.
