<!-- fold: state-recap -->

**2026-11-15 - G6 built on `builder/e3-agent-registry-import` ([ADR-0314](../decisions/0314-vendor-agent-registry-import.md), lane E3; migration `agent_registry_records`, numbered at merge).**
Vendor agent registries (Entra Agent ID and Agent 365, Gemini Enterprise, Bedrock AgentCore) are a new discovery
family, off by default. Their scanners stage agents with provenance in `agent_registry_records`. An admin imports one
at a time, with a step-up, into `agents`: disabled, `proposed`, with no grant (default-deny). The tests use fake
vendor endpoints; live tenants are owner-gated. API only, with three routes as known UI gaps on #453.
