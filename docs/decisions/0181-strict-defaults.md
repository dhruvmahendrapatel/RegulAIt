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

## Implementation (2026-10-06)

Built by four agents on `strict-sa`, `strict-sb1`, `strict-sb2` and `strict-sc`, and integrated on `strict-int` with
`main` @ 1e13128 (D3). Each flip changes the column default, the zod and code fallbacks and the docs, and its
migration moves existing rows to the strict value, as for a first load. A test reads every flipped setting strict on a
freshly migrated database (red when the default is reverted), and a test relaxes each one through its admin route and
reads the audit row.

### Migrations

- **0156** (identity and auth): `mfa_required` admins, three password classes, 30-minute idle sign-out, API keys
  90 / 365 days, approval delegation off, SAML `want_authn_response_signed` on. An OIDC provider with JIT on and no
  allowed email domains has JIT switched off, and a check constraint now requires domains whenever JIT is on.
- **0157** (guardrails, data and runtime): guardrails block prompt injection and jailbreak and warn on toxicity and
  semantic DLP. The PII floor is `block`, and compliance profiles default to `block` / `read_only`. Trace content
  capture, the env-key fallback, custom providers and LLM training are off. Compaction fails closed, and the semantic
  cache is off. Strict field rejection is on, and `streamingOnBlockMode` is `reject`.
- **0158** (governance gates): use-case gate enforce; dispatch, project and MCP attribution required; MRM enforced, with
  staleness recertification; key custody enforced; enforcement posture `managed`; preview before activate; builder
  tools ask first; project alert threshold 80%.
- **0159** (admission and infrastructure): MCP admission enforce, a 7-day release cooldown, no private ranges by
  default, compiled egress `strict`, backup verification and stale-credential alerts on, and spend monitors on.
  `REGULAIT_SCHEDULER` defaults to on, and `REGULAIT_DATABASE_SSL` to `require`.

The next migration is 0160.

### What each agent shipped, condensed

- **Identity (SA).**
  - The demo's first admin enrols TOTP at first sign-in, and the Playwright sign-ins compute the code from the shown
    secret.
  - `REGULAIT_HSTS` now defaults to one year. A host whose name may change hands (the sslip.io dev box) sets
    `max-age=86400` explicitly.
  - OIDC JIT requires allowed email domains.
- **Guardrails, data and runtime (SB1).**
  - The guardrail no-row fallback is `warn`, never `off` (`GUARDRAIL_FALLBACK_MODE`).
  - `demo:prepare` imports `GOOGLE_API_KEY` once into the encrypted key store. The key is never printed, logged or
    written to audit text. Platform model-credential writes are now audited, with no key material in the row.
  - Two of the platform's own texts tripped the strict detectors, so their wording changed; no detector exclusion was
    added. The compaction transcript labels turns `[role]` (a line reading `assistant:` is the forged-role shape), and
    a risk-catalogue title no longer contains the word "jailbreak".
- **Governance gates (SB2).**
  - The model portal's Run names the project it bills to.
  - **MRM staleness exemption for evaluation dispatches.** With staleness recertification on, a stale card no longer
    refuses dispatches tagged with the server-side `evals` model feature: eval cases, judges and red-team probes. They
    gather the evidence a recertification needs. Each exemption is audited as `mrm-staleness-evaluation-allowed`. The
    base MRM gate (no approved card, expiry) still applies, and every other dispatch of a stale card is refused.
- **Admission, infrastructure and monitors (SC).**
  - A new builder skill waits out the 7-day cooldown unless an admin overrides it.
  - When `REGULAIT_DATABASE_SSL=disable`, the gateway logs a loud boot warning, and the posture page shows database
    TLS as relaxed. The demo, compose and CI set `disable` explicitly.
  - CI sets `REGULAIT_SCHEDULER=off`.

### Demo relaxations and client opt-ins (each visible, audited and bounded)

- **The guardrail window for red-team probes.** `demo:intake` runs the required-test red-team suite. The strict
  guardrail would hold the injection and jailbreak probes before they reach the agent, so the run would measure
  nothing about the agent. For that run only, `demo:intake` sets an agent-scope override with those two layers at
  `warn`, on each agent under test that has no admin override of its own. It goes through
  `PUT /v1/guardrails/config/agent/:id` (audited old → new). In a `finally`, it deletes exactly the overrides it
  created (audited), so the strict org default applies again. An override an admin already set is never touched. The
  window is printed as a relaxation.
- **Trace content capture.** The demo seed turns capture on through `PUT /v1/org/settings` (audited, printed), because
  continuous trace evaluation needs stored previews. Credentials are still scrubbed at write time.
- **`x-regulait-accept-buffered: 1`.** `streamingOnBlockMode: 'reject'` exists for clients that require a stream. A
  client that sends this header on the invoke or run routes has said it does not require one. It gets ADR-0019's
  buffered, disclosed reply instead of a 400. The header never turns streaming back on and never lifts a block: the
  stream stays suppressed, and the buffered reply passes the same output controls. The SPA sends the header;
  third-party and IDE clients do not, so they still get the 400.
- **Script keys.**
  - The demo prep scripts (`seed`'s admin key, `demo:intake`, `demo:traffic`, the recertify step and `demo:check`)
    revoke their own keys at the end of their runs.
  - `demo:check` holds no admin-owned key. Its admin reads use the bootstrap token, and the intake-assistant beat runs
    as Dana, the proposer.
  - Before this change, the stale-credential monitor rightly flagged four admin-owned keys as over-scoped. The
    Monitor's 15-alert threshold is unchanged, and `demo:check` passes 18/18.

### One audit shape for every relaxation

Every relaxable-settings write records old → new as `detail.transitions: { [key]: { from, to } }`. The one helper
(`setting-transitions.ts`) builds it from the same redacted view as `after`. This covers org settings, interception,
project PATCH, the spend-monitor policy, policy-simulation settings, guardrail org and override writes, unversioned
rule-row writes (compliance profiles), the builder toolbox (keyed `kind:refId`, with null meaning absent) and the
SAML/OIDC PATCH. The agents' interim fields (`previous`, `before`, `previousModes`, `previousTools`,
`beforeRow`/`afterRow` and `requirePreviewBeforeActivateFrom`/`To`) were removed. No UI, export or evidence reader
consumed them.
