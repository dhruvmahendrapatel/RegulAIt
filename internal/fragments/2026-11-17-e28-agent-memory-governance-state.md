<!-- fold: state-recap -->
**2026-11-17 - lane E28, governed agent memory writes slice 1 ([ADR-0347](../decisions/0347-governed-agent-memory-writes.md)).**
Every write to shared project context and builder agent memory now passes one check before it is stored
(`memory-governance.ts`): the ADR-0042 injection, jailbreak and secret detectors at `block` plus the ADR-0140 PII
detector (flagged = refused by default, `agent_memory_scan_mode`), a mandatory expiry from the database clock (org
`agent_memory_ttl_hours` 24, shortened by `compliance_profiles.memory_ttl_hours`), and the producing run checked as the
caller's own in the same project, with the agent read from the run's event. Reads drop expired heads and supply memory
as quoted data with provenance. Migration `pending/agent_memory_governance.sql`. Next: slice 2 (quarantine and
findings, admin inspect/expire/purge, the expiry sweep, the false-instruction proof test).
