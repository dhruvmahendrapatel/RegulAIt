<!-- fold: state-recap -->
**2026-11-15 - lane E14: endpoint AI add-on inventory built ([ADR-0332](../decisions/0332-endpoint-ai-addon-inventory.md), migration `pending/endpoint_addon_inventory.sql`, numbered at merge).**
- **What:** one admin-only view of every coding agent, MCP server, skill and plugin, per version and per endpoint.
- **How it reads:** at call time from the ADR-0195/0259 evidence, so nothing is copied and nothing needs a refresh. Skills and plugins live in RLS-guarded direct-record tables keyed to the enrolled device.
- **Scans:** each version is joined to the ADR-0242 scan of its exact content digest and decided by the gate's `engineAdmissionHold`. No digest, no scan or a disabled scanner reads "not yet scanned", never clear.
- **API:** three read-only `/v1/endpoint-addons/*` routes, including the "flagged at or above severity X" contract for the removal directive and the detections (not-yet-scanned included by default). They are API-only, with three KNOWN_UI_GAPS entries on #453.
- **Owner decisions:** I1, visibility narrows to a security-admin role once one exists. I2, the endpoint agent's device-scoped read is lane E13's narrow, audited read.
