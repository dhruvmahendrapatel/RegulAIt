<!-- fold: state-recap -->
**2026-11-19 - lane E26, agent-risk proofs, slice 3a ([ADR-0345](../decisions/0345-agent-risk-control-proof-registry.md)).**
The register now has APIs, all admin-only:
- read the catalogue, with each proof's schedule and its latest result labelled as evidence;
- page one proof's result history;
- change a proof's settings. Turning a proof off, or slowing it past its default, needs a `settings_relax` step-up
  bound to the exact values. Every change is audited.

The view is a `KNOWN_UI_GAPS` entry for the design builder on #453. No new tables or migrations.
