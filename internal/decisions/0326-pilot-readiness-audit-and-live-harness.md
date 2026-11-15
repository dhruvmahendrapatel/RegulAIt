# ADR-0326: Pilot readiness audit, a live test harness, and the small pilot-path fixes

- **Status**: Accepted (lane E11 brief, owner direction 2026-11-15)
- **Date**: 2026-11-15
- **Index**: **Pilot readiness (lane E11): a gap audit of the four pilot success criteria (`internal/product/PILOT_READINESS.md`), a live harness against test tenants (`apps/gateway/live/`, workflow `live-tests.yml`, dispatch and nightly only, `live-tests` environment), and three fixes: Entra `xms_edov` accepted as a verified email from the tenant's own issuer, audit rows for the two unaudited compat refusals, and the INSTALL.md IdP route.**
- **Built in**: lane E11, branch `builder/e11-pilot-path`
- **Migration**: none
- **Related**: ADR-0174 (enterprise sign-in, verified email), ADR-0020 (IDE interception, default deny), ADR-0202
  (live demo profile), ADR-0257 (client compat harness), ADR-0298 (on-device enforcement), lane E7 #845
  (vendor usage pull, in flight), ADR-0176, ADR-0180, ADR-0200

## Context

The owner set a pilot in about two weeks with a large engineering organization. Their stack is Entra ID, Azure
DevOps, the four coding tools (Copilot, Cursor, Claude Code and Codex/ChatGPT), and Anthropic, OpenAI, Bedrock and
Gemini/Vertex, deployed BYOC in their AWS account. Success is defined by four criteria (brief, 2026-11-15). Nobody
had traced those criteria through the code, and no test ran against a real tenant of any of those services.

## Decision

1. **The audit is a document of record**, `internal/product/PILOT_READINESS.md`. Per criterion it records what works
   on `main`, what is in flight (by PR), and what nobody owns, each gap with an ID. The master assigns the unowned
   rows; larger ones are PENDING fragments.
2. **A live harness, separate from every PR gate.** `apps/gateway/live/*.live.test.ts` runs only in
   `.github/workflows/live-tests.yml`, on `workflow_dispatch` and nightly, in a `live-tests` environment with
   required reviewers. Each group (anthropic, openai, gemini, bedrock, vertex, ado, entra) skips itself when its
   variables are unset, by name only. Values are never printed: assertion messages pass through `redact()`, and the
   workflow masks the test tenant identifiers because the repository's logs are public. Every gap a test would cover
   is an `it.todo` naming its gap ID, so a run report shows the chain's holes.
   - **Open source first:** the harness is vitest, the runner the gateway already uses, plus the product's own
     adapters. No new dependency.
3. **Fix: Entra's verified email.** The OIDC callback required `email_verified: true` (ADR-0174), which Entra never
   sends. Entra sends the optional claim `xms_edov: true` ("email domain owner verified", Microsoft identity platform
   optional claims reference), so every direct Entra login was refused.
   - `xms_edov: true` is now accepted, but only on a token whose validated `iss` is
     `https://login.microsoftonline.com/<tenant-guid>/v2.0` and whose `tid` is that same GUID.
   - Any other issuer still needs `email_verified: true`. This is the same strictness, spelled the way Entra spells
     it, so there is no admin knob (ADR-0180).
   - Pure function `oidcEmailVerifiedVia` (`apps/gateway/src/oidc-email-verified.ts`) with unit tests.
4. **Fix: audit the two silent refusals.** On the compat surfaces, `model_not_mapped` and `agent_not_resolvable`
   returned 403 with no audit row. Pilot criterion 1 needs an audit record when a model is blocked, and disabling or
   unmapping an agent is one way an admin blocks one. Each refusal now writes a deny row on object type `agent`
   (`ruleId` = the error code).
5. **Fix: the INSTALL.md IdP route** (`/v1/auth/oidc-providers`).

## Consequences

- The four criteria now have a shared, cited baseline. The unowned gaps are listed for the master.
- The owner creates the `live-tests` environment and its secrets (`docs/deployment/LIVE_TESTS.md`). Until then, the
  workflow's runs execute only the harness's self-tests and the in-process Entra SCIM shapes.
- The SCIM test that pins "a PATCH of Entra's default mapping is a 400" (G0-2) is meant to fail when that gap is
  fixed, so the fix changes it deliberately.

## As built

- The Bedrock and Vertex groups are declared but have only `todo` tests: there is no native inference route to test
  (G2-1, G2-2).
- ADO's commit in the live test is pushed by the test itself through the ADO pushes API, because the product has no
  commit primitive (G3-3).
