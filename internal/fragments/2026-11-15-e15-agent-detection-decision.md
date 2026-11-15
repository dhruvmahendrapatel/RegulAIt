<!-- fold: state-decisions -->
**ADR-0333 (builder lane E15, 2026-11-15, Proposed; owner direction 2026-11-15): rule-based detection of risky agent behaviour.**
- **What:** a deterministic engine (`apps/gateway/src/detection/`) reads committed audit-chain rows behind one leased
  cursor (`agent-detection-sweep`, every 15 s), groups them per delegation tree or sponsor, and evaluates a signed,
  versioned rule pack (`regulait.detection-pack.v1`, Sigma correlation vocabulary: `single`, `temporal_ordered`,
  `event_count`). Five default rules: secret read then egress, data-scoped call then a write elsewhere, a call to a
  High/Critical add-on, delegation escalation, a burst of denied calls.
- **Evidence and SIEM:** each incident has its evidence rows (join table) and one chained audit row, so ADR-0303 delivers
  it to the SIEM. Never AI, never in the decision path. A stored pack that does not verify falls back to the built-in
  pack (audited once). A relaxing pack change needs a `settings_relax` step-up.
- **Responses (slice 2):** `suspend_grant` (revoke the delegation tree), `revoke_credential` (the identity's live
  tokens) and `require_approval` (an approval rule for the sponsor), each behind a `settings_relax` step-up. Migration `pending/agent_detection.sql`. API only:
  five routes are known UI gaps on #453.
