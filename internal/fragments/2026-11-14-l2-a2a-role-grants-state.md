<!-- fold: state-recap -->
**2026-11-14 - Lane L2, P10 follow-up: A2A role grants and per-person revocations ([ADR-0219 amendment](../decisions/0219-a2a-governance.md), migration `pending/a2a_role_grants`, numbered at merge).**
A role can be granted a remote agent, as a whole or for one skill. Everyone holding the role may then call it. A per-person
revocation removes that role-derived access without touching a direct grant, and lifting a revocation is a step-up. Six admin
routes are API-only; they are known UI gaps on #453. After review, the A2A grant mints (role and direct) pass the shared
SoD gate, the `grant_mint` step-up and the role-row lock. Assigning a role that holds remote-agent grants is stepped up.
Revocations take the person lock, use the shared lift step-up and carry a reason. Both lists are on the ADR-0226 contract
with Excel exports; the two exports raise the known UI gaps by two.
