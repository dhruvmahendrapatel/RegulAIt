<!-- fold: state-recap -->

**2026-11-15 - G7 slice 1a on `builder/e3-agent-credential` ([ADR-0315](../decisions/0315-portable-agent-credential.md), lane E3; migration `agent_credential_audiences`, numbered at merge).**
The portable agent credential has:
- an issuer at `<public URL>/agent-credentials`, with a discovery document and a JWKS;
- a default-deny audience registry, where registering an audience is a step-up and the scope map uses foreign keys;
- `mintAgentCredential`, which issues a signed projection of one live delegation grant onto one registered audience:
  RFC 9068 `at+jwt`, an RFC 8693 `act` chain of SPIFFE IDs, the mapped scope only, the run budget and DPoP `cnf`;
- the offline reference verifier `verifyAgentCredential`.

Every refusal is audited, and the token is never stored. Still to come: the token-endpoint branch (1b), and the
status list and revocation (2).
