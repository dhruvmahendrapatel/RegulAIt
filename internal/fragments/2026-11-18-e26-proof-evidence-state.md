<!-- fold: state-recap -->
**2026-11-18 - lane E26, agent-risk proofs, slice 2b ([ADR-0345](../decisions/0345-agent-risk-control-proof-registry.md)).**
Proof results are now read as evidence.
- Each result is labelled `verified`, `unsigned` or `unverifiable`, checked against its hash, its chained audit row
  and its Ed25519 signature. Only a passing result that is not `unverifiable` counts.
- A new compliance-pack collector, `agent_risk_proofs`, counts those results for the OWASP controls a proof's risk
  cites. No pack names it yet; that is an owner question.
- The posture document shows the proofs as inputs to the adversarial objective, without changing the score.

No new tables, migrations or routes.
