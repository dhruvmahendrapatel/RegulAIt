<!-- fold: pending -->

**E11-1 — Native Bedrock and Vertex inference (PILOT_READINESS G2-1, G2-2; ADR-0326).** The pilot uses AWS Bedrock and Google Vertex, but `packages/model-provider` routes only to Anthropic, OpenAI and Gemini (API key). Add a Bedrock provider signed with SigV4 from the deployment's IAM role (no access keys; the AWS SDK credential chain) and a Vertex provider using a service account or workload identity, each with cost attribution, egress posture and a live test in `apps/gateway/live/` (groups already declared).

**E11-2 — Budget alerts delivered, not only recorded (G2-4).** `budget-threshold-alert` and the Approvals Queue escalation are written but sent nowhere. Route both through `notifyGovernanceAlerts` (Slack, Teams, email, webhook) with a test that proves delivery, plus a per-user grouping in `/v1/usage-events/summary` (G2-5).

**E11-3 — ADO work item drives the workflow (G3-1, G3-2, G3-4 to G3-7).** If L6 assignability does not cover them: a Boards service hook that starts or binds a governed instance; ADO PR statuses as a check gate and a RegulAIt status posted back through the Status API; ADO reviewer votes and branch policy in the merge gate; an `AB#<id>` link in the PR body; Entra service-principal or workload-identity auth instead of a PAT.

**E11-4 — A commit primitive for the build stage (G3-3).** `GitProvider` has no commit or push, so an agent build cannot land code on the branch. Needed with (or by) E5 #847.

**E11-5 — Coding-tool coverage beyond Claude Code (G1-3 to G1-7).** Codex runbook and client-compat test (`config.toml` `base_url`, `wire_api = "responses"`); a key-pinned default project so Cursor's header-less calls are attributed; audit reporting and a signer key for the ADR-0298 on-device hook; an owner decision on Copilot model calls (MCP-only governance, or ingesting GitHub audit and usage data).

**E11-6 — Entra SCIM default mapping and groups overage (G0-2, G0-3).** Accept (store or ignore) the core User attributes Entra's default mapping PATCHes (`name.*`, `title`, ...), and follow the groups overage claim. The live SCIM test pins today's 400 and flips with the fix.

**E11-7 — AWS BYOC runbook (G4-1, G4-3, G4-4, G4-6).** An AWS-specific install guide (VPC, EC2 or EKS sizing, RDS, IAM, DNS/TLS) and customer Terraform, a published operator image, a decision on GHCR package visibility, and scripted IdP, egress and backup setup after install.
