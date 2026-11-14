<!-- fold: pending -->

**P19 follow-ups from Lane L3, first PR ([ADR-0230 amendment](../decisions/0230-sap-business-agents-over-mcp.md)).**
Open: the HMAC idempotency key and the A3 audit and usage detail (the lane's second PR); identity release, subject-token
retention and confirm-by-fresh-step-up (need slice A0); the screen for the three `system-class` routes (#453); a create
and edit path for `rate_limits.write_only` in the rule API (today only the SAP seeding writes it); a tool-kind
dimension for the policy-replay counter, so a simulated write-only limit counts writes only (it over-counts today).
