<!-- fold: state-decisions -->
**ADR-0238 (builder, 2026-11-07, Proposed): down-scoped upstream credentials by RFC 8693 token exchange (backlog
P12(d)).** Step 1 found the `/oauth/token` exchange (ADR-0188 S5) is inbound only: the gateway is its authorization
server and only resource. Added the gateway as an RFC 8693 client of an upstream's own authorization server, per MCP
server or connector (pending migration `upstream_token_exchange`: `upstream_token_exchanges` plus the `upstream_token_exchange_scopes` join table;
replay namespace `upstream_exchanged_token`). Off by default; every write is a `settings_relax` step-up; a url move
turns it off. After the governed decision, the action's mapped scopes (unmapped = refused) are requested with a 60 s
ES256 assertion for the person, through `oauth4webapi` over the egress-guarded fetch; the answer must stay within
scope, the pinned audience and a ≤ 900 s lifetime, is claimed against replay, audited without the token, attached to
that one call only and never cached. UI needs posted on #453. Follow-ups in the ADR (connector base_url move, reverse
conflict refusals, private_key_jwt, ADR-0231 jwt-bearer profile, and MCP-spec OAuth 2.1/DCR on our own MCP
endpoint, out of scope per ADR-0097). Design reference cited (ideas only): loglux/authmcp-gateway (MIT).
