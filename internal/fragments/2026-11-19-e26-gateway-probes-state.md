<!-- fold: state-recap -->
**2026-11-19 - lane E26, agent-risk proofs, slice 2c part 1 ([ADR-0345](../decisions/0345-agent-risk-control-proof-registry.md)).**
Five of the eight gateway probes now run, each through the enforcing code the live path calls:
- a hidden instruction in a returned document, against the org guardrail policy;
- an out-of-scope tool argument and a halted dispatch, against the policy kernel;
- a drifted MCP definition, against the pin gate, using a sandbox server created in a transaction that always rolls back;
- an untrusted-context write, against the content-trust floor.

Relaxing a tenant control (guardrail mode, pin mode) makes its probe fail. Catalogue v2 rewords the memory proof's
assertion to what the floor enforces. No new tables, migrations or routes.
