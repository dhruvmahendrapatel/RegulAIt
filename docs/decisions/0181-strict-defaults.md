# ADR-0181: Strict defaults everywhere (applying the ADR-0180 standing rule)

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** owner
- **Builds on:** ADR-0180 §1 (secure by default), ADR-0118 (controls sold as active but shipped off), ADR-0021 (the
  rule that a fresh install must behave exactly as before, which this ADR reverses for security settings)

## Context

An audit of `main` @ c8bfc6d found about 34 settings whose default is the less secure option. Most come from the
ADR-0021 rule that a fresh install must behave exactly as before. ADR-0180 made "every setting defaults to strict; an
admin may relax it, audited" a standing rule, and the product is not live. So these defaults change now, as for a first
load.

## Decision

### Flipped to strict (an admin may relax each one, and the change is audited)

Each item below shows the old default and the new one.

**Admission and supply chain**
- `mcpAdmissionMode`: off → **enforce**.
- `minReleaseAgeDays`: 0 → **7** (release-age cooldown).
- `mcpPrivateRangesDefault`: true → **false**.
- `egressCompiledDefaultPolicy`: inherit → **strict**.

**Identity and sessions**
- `mfaRequired`: off → **admins**.
- `passwordRequireClasses`: 2 → **3**.
- `sessionIdleMinutes`: 120 → **30**.
- `apiKeyDefaultTtlDays` / `apiKeyMaxTtlDays`: never → **90 / 365**.
- SAML `wantAuthnResponseSigned`: false → **true**.
- OIDC `allowedEmailDomains`: any domain → **required** whenever JIT provisioning is on.
- `REGULAIT_HSTS` default: 1 day → **1 year**.

**Guardrails and data**
- Guardrail modes:
  - the no-row fallback is **warn**, not off;
  - configured detectors default to **block** for prompt injection and jailbreak, and to **warn** for the others.
- `defaultPiiMode`: none → **block**.
- Compliance profile `piiMode`: log → **block**.
- Compliance profile `mcpDefaultMode`: read_write → **read_only**.
- `tracingCaptureContent`: true → **false**.

**Governance gates**
- `useCaseGateMode`: off → **enforce**.
- `dispatchAttributionRequired`: false → **true**.
- `requireProjectAttribution`: false → **true**.
- `requireMcpAttribution`: false → **true**.
- `mrmEnforced`: false → **true**.
- `mrmStalenessRecertEnabled`: false → **true**.
- `keyCustodyEnforced`: false → **true**.
- `requirePreviewBeforeActivate`: false → **true**.
- `approvalDelegationEnabled`: true → **false**.
- Builder tool `requiresApproval`: false → **true**.

**Runtime**
- `REGULAIT_SCHEDULER`: off → **on**. Tests and CI set it off explicitly.
- `backupVerifyEnabled`, the spend monitor and `staleCredentialAlerts`: off → **on**.
- `compactionFailureMode`: fail_open → **fail_closed**.
- `semanticCachePolicy`: opt_in → **off**.
- `customModelProvidersEnabled` and `llmTrainingEnabled`: true → **false**.
- `strictFieldRejection`: false → **true**.
- `streamingOnBlockMode`: suppress → **reject**.
- `enforcementPosture`: voluntary → **managed**.
- Project `alertThresholdPct`: 100 → **80**.

### Owner decisions on the three that affect the local demo

- **Database TLS.** `REGULAIT_DATABASE_SSL` defaults to **require**. The local demo and docker-compose opt out
  explicitly with `REGULAIT_DATABASE_SSL=disable`. When TLS is off, the gateway logs a loud boot warning and the
  security posture shows it as relaxed.
- **MFA.** Required for **admins**: an admin enrols TOTP before reaching the app, and other users are not forced. The
  demo's first admin sign-in enrols once.
- **Provider keys from the environment.** `envKeyFallbackEnabled` defaults to **false**. `demo:prepare` reads
  `GOOGLE_API_KEY` from the environment once and stores it in the encrypted key store. It never writes the key to
  files, logs or audit text. The owner keeps supplying it only as an environment variable.

### Must stay off, because a fresh install cannot work without it

- `ssoOnly` and `localSignIn = break_glass_only`: there is no identity provider yet.
- The session and API-key IP policies: the allow-list starts empty.
- Review-policy roles and tiers: these need named reviewers.
- The S3 audit anchor: it needs a bucket.
- `executionMode = normal`: the stricter positions are emergency stops.
- `mcpInterceptionEnabled = true`: this is the core governed proxy.
- `REGULAIT_OFFLINE_CHECKS`: only the demo seed sets it.

### How

- One migration changes the column defaults and, as for a first load, updates existing settings rows to the strict
  values.
- Code fallbacks change to match.
- Every setting already has an admin write path. Each relaxation is audited, and its audit row records old → new.
- Tests that pin unrelated behaviour set the lax posture they need explicitly. Never weaken a default to make a test
  pass.
- The demo seed configures what the story needs truthfully. Examples: admitted MCP servers, an allow-list entry for
  the demo's local MCP hosts, approved model cards, a backdated release-seen time, a project on every demo call, and
  pack controls.
- `demo:prepare` must pass 18/18, and the real journey must pass.

## Consequences

- A fresh install is locked down. A first-run admin must enrol MFA and configure allow-lists, admission and attribution
  before traffic flows. The setup docs say this plainly.
- Several earlier ADRs that described "ships off" defaults (ADR-0021, ADR-0097, ADR-0118, ADR-0119 and others) are
  superseded on that point by this ADR.
