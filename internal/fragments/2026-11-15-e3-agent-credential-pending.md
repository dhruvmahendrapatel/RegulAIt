<!-- fold: pending -->

**G7 follow-ups ([ADR-0315](../decisions/0315-portable-agent-credential.md), lane E3).**
- **1b:** the `requested_token_type=urn:regulait:params:oauth:token-type:agent-credential` branch in `POST /oauth/token`,
  with DPoP preflight and replay claims.
- **2:** the Token Status List, revocation by `jti`, kill-switch propagation to the list, the verifier guide, and
  verifier tests for the agentgateway and Kong configuration shapes.
- The audience registry screen (#453).
