<!-- fold: state-recap -->
**2026-11-14 - Lane L2, P20 slice B3: agent gateway connections, the ARD import and pending cards ([ADR-0231 amendment](../decisions/0231-sap-joule-agents-over-a2a.md), migration `pending/a2a_gateway_connections`, numbered at merge).**
An admin connects an SAP Agent Gateway. The connection is off by default under `sapAgentGatewayEnabled`, and setting it up is a
step-up. The admin imports its ARD catalogue: the import lists candidates and registers nothing on its own. The admin registers
the agents they pick, and grants still decide who may call. A refresh holds a changed card for review: calls keep the stored
card, narrowed at once to what both cards allow, and accepting a widening card is a step-up. Nine routes are API-only (UI is
slice B5, on #453).
