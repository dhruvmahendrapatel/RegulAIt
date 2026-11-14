<!-- fold: state-recap -->
**2026-11-14 - Lane L2, P10 follow-up: A2A role grants and per-person revocations ([ADR-0219 amendment](../decisions/0219-a2a-governance.md), migration `pending/a2a_role_grants`, numbered at merge).**
A role can be granted a remote agent, as a whole or for one skill. Everyone holding the role may then call it. A per-person
revocation removes that role-derived access without touching a direct grant, and lifting a revocation is a step-up. Six admin
routes are API-only; they are known UI gaps on #453.
