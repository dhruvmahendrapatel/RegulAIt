<!-- fold: state-decisions -->
**ADR-0246 (builder, 2026-11-07): MCP definition pinning and clean-room vulnerable MCP fixtures (backlog P27).** The
first admitted manifest of a server is its baseline: every tool (name, title, description, input/output schema,
annotations), prompt, resource and resource template gets a SHA-256 over its RFC 8785 form in `mcp_definition_pins`
(approved and observed digest and definition; status derived, never stored). Every manifest fetch compares, audited
(`mcp-definition-changed`) in the sync's transaction. `org_settings.mcp_definition_pin_mode` defaults to `block`: a
changed or added tool is neither stored nor served, and a call to it, or `prompts/get` / `resources/read` of a changed
item, is refused (`mcp-definition-blocked`) before any connect. `warn` is a settings_relax relaxation. Re-approval
(`POST /v1/servers/:id/definition-pins/approve`) is bound by step-up to the exact reviewed digests, compare-and-set,
audited. `@regulait/mcp-vuln-fixtures` (test-only, deleted from the image build stage, gateway devDependency) serves eight attack classes
over real MCP; the two unlicensed upstream projects were not read. Addendum: our own offensive-tooling rule set marks a
server `risk_class = 'high'` (sticky); under `mcp_high_risk_mode = 'enforce'` each call is refused until the policy
template (fleet approval rule, quorum >= 2, plus a rate limit) is applied, must name targets covered by
`mcp_authorised_targets` (adding one is a step-up), and is audited with redacted arguments. Migration: pending `mcp_definition_pins` (numbered at merge, ADR-0252). Open: the UI
(#453), P23's scanners on the fixtures, and comparison per call rather than per listing.
