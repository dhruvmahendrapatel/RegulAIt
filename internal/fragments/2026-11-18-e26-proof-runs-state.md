<!-- fold: state-recap -->
**2026-11-18 - lane E26, agent-risk proofs, slice 2a ([ADR-0345](../decisions/0345-agent-risk-control-proof-registry.md)).**
The proofs now run. An hourly scheduler job (`agent-risk-proof-sweep`) runs each enabled proof once its interval has
elapsed. It reuses the existing engines:
- the ADR-0180 assurance metrics;
- ADR-0060 audit-chain verification;
- an ADR-0081 register-hygiene read.

Each result is append-only evidence. It is written in the same transaction as its hash-chained audit row, which
carries the same hash, and it is Ed25519-signed when the ADR-0116 export key is set. Anything but a pass raises one
governance alert and one acknowledgement item per proof, and a pass resolves the alert. The gateway probes record
`not_run` until slice 2b builds their harness. No new tables or routes.
