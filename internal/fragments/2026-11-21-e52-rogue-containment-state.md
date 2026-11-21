<!-- fold: state-recap -->
**2026-11-21 - lane E52, rogue-agent containment (OWASP ASI10), slice 1 ([ADR-0366](../decisions/0366-rogue-agent-containment.md)).**
- **Chosen:** build on ADR-0124's halt and the one Approvals Queue, adopting the trigger model of Falco Talon
  (Apache-2.0) and Wazuh active response (GPL-2.0, pattern only): a severity threshold selects the automatic response,
  everything below it is a notification plus a proposal. Wazuh's automatic timeout revert is not adopted: only an
  admin releases a containment.
- **Built:** a `ContainmentSignal` interface (monitor findings now; lane E40's baselines later); automatic halt at or
  above `org_settings.containment_auto_severity` ('critical' by default; 'off' is a step-up); proposals routed to an
  admin-named approver; an admin-only release with a step-up, refused while the dial is not normal, that lifts only a
  containment's own halt; builder agents gain their own halt, enforced on every turn. Migration
  `pending/rogue_agent_containment.sql` (numbered at merge), `agent_containments` under forced RLS. Three API-only
  routes are known UI gaps.
