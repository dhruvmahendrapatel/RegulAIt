# ADR-0118 — The hardened posture preset: one governed operation, two controls it refuses to claim, and a read that is worth more than the write

- **Status**: Accepted
- **Date**: 2026-09-20
- **Relates to**: [ADR-0060](0060-tamper-evident-audit.md) (tamper-resistance is READ from the medium,
  never inferred from configuration — the precedent this ADR follows),
  [ADR-0045](0045-model-risk-management.md) (`mrmEnforced` and its own toggle route),
  [ADR-0097](0097-mcp-admission-scanning-and-auth-discovery.md) (MCP admission modes),
  [ADR-0117](0117-international-identifier-pii.md) (PII jurisdictions and their false-positive rates)
- **Migration**: **none.** The preset writes `org_settings` columns that already exist. It is an
  *operation*, not a new piece of state, and deliberately does not persist "am I hardened" —
  that is derived by reading the controls, so it cannot drift from them.

## Context

Eight controls this product sells as active ship **off**:

| control | ships as |
|---|---|
| `defaultPiiMode` | `"none"` |
| `mcpAdmissionMode` | `"off"` |
| `useCaseGateMode` | `"off"` |
| `mrmEnforced` | `false` |
| `dispatchAttributionRequired` | `false` |
| `semanticCachePolicy` | `"opt_in"` |
| audit WORM anchoring | local directory, self-graded **not** tamper-resistant |
| scheduler | off unless `REGULAIT_SCHEDULER` is set |

Every one is a deliberate, documented, upgrade-safe choice: an existing deployment must behave
byte-identically across an upgrade, and turning any of the first five on starts **refusing traffic
that previously passed**. **That decision stands and this ADR does not change a single default.**

What it fixes is the consequence. A fresh install enforced nothing, there was no way to find that
out in one call, and no way to act on it in one step. "So what is enforcing right now?" is the first
question a technically literate buyer asks after installing, and the product had no answer.

## Decision

### 1. The READ is the primary deliverable

`GET /v1/org/posture` names every control, its current value, what hardened means for it, whether it
is satisfied, whether it is settable — and **what turning it on would refuse**. That last field is
why the endpoint is worth reading even to an operator who will never apply the preset. A posture page
that lists switches without their blast radius invites an admin to harden a live deployment at 4pm on
a Friday. The `refuses` text is specific enough to act on: that `useCaseGateMode` binds only
dispatches naming a project and is trivially side-stepped by omitting the header; that `mrmEnforced`
bites on the **clock**, so a card expiring tomorrow starts refusing tomorrow; that
`defaultPiiMode: block` should be read alongside ADR-0117's false-positive rates, which differ by two
orders of magnitude between jurisdictions.

### 2. Two controls are REPORTED and never CLAIMED

The audit anchor is resolved from S3 environment variables at start-up and the scheduler from
`REGULAIT_SCHEDULER`. **An API call cannot set an environment variable.** They carry
`settable: false` and their **observed** state; `harden` neither touches them nor counts them; and
the overall `hardened` verdict stays `false` while they are unmet, even when every settable control
is satisfied.

This follows ADR-0060's precedent exactly. `tamperResistant` is read from the bucket's own Object
Lock configuration — a GOVERNANCE-mode bucket grades **false**, because an administrator holding
`s3:BypassGovernanceRetention` defeats it. Reporting a control as hardened because somebody asked for
it, rather than because it is, would be the dishonesty this product argues against everywhere else.

`notSettable` is returned on **every** call including the fully idempotent one, so "nothing to do" is
never read as "you are fully hardened".

### 3. Enforcement and optimisation are separate groups, and `harden` defaults to enforcement only

`semanticCachePolicy: "always"` refuses nothing — it **changes answers**, serving a repeat question
from a previous approved answer instead of the model. Bundling that into a switch called "hardened"
would conflate a security posture with a cost decision. An admin hardening a regulated deployment is
not thereby asking to serve more answers from cache, so they have to ask for it:
`{"groups":["enforcement","optimisation"]}`.

### 4. `mrmEnforced` emits ITS OWN audit row as well

MRM enforcement has a dedicated toggle route with its own audit vocabulary —
`mrm-enforcement-enabled`, effect `deny`. Writing the column from here without that row would mean an
operator alerting on that rule id **silently misses a preset-driven enablement**. So the preset emits
both: one row saying the preset was applied, one saying MRM enforcement came on. They are two
different facts about one write, and an audit-first product should record both.

The preset's own row uses `org-posture-hardened`, **not** `org-settings-updated`: reading the trail,
"an admin edited one dial" and "an admin applied the hardened preset" must be distinguishable, and a
shared rule id would erase that.

### 5. Idempotent, and partial application is never reported as success

A second call changes nothing, reports `alreadySatisfied`, and mints **no** second audit row — a row
implying a change where none happened is its own small lie. An unknown group is a 400 and **nothing
in the same request is applied**.

## Verification

**The only evidence that matters here is behavioural.** Asserting a column moved from `"none"` to
`"block"` proves a column moved. The claim is that the product *enforces*, so the load-bearing tests
send the **same request twice** — once before hardening, once after — and require it to be allowed
the first time and refused the second, by a reason hardening introduced.

### Writing that test surfaced something worth recording: the gates are ORDERED

With everything hardened, an unattributed dispatch of ordinary prose is refused with
**`mrm_approval_required`**, not `attribution_required` — MRM answers first. An assertion naming
attribution after a full harden therefore **fails while the attribution gate is perfectly healthy**.
The first draft of the test file made exactly that mistake and the strengthened assertion caught it
(M-026: verify the reason, never merely the status).

So the file proves each gate **twice**: once through the preset, where the refusal must be *one of*
the reasons the preset introduces, and once **in isolation**, moving that single dial so the refusal
can be named exactly. The isolation cases go through the settings PUT rather than the preset, which
also makes them independent evidence — they stay green under a probe that neutralises the preset.

### Non-vacuity, predicted before running

Neutralising only the write (leaving the audit row) was predicted to redden **6 of 13**: both
behavioural cases, the optimisation-group case, the never-claims-the-environment case, idempotency,
and the audit test's no-op check — leaving **7** green including the isolation case. **Result:
exactly 6 and 7.**

### A defect this work exposed elsewhere

The full suite then failed in `export-bundle.test.ts` (ADR-0116): *"one altered exported audit row"*
reported that a tampered bundle verified clean. It was a **test** defect, not a product one. The
mutation was `allow -> deny` on the first row of the exported segment; in a shared database that row
is whatever another file happened to write, and when it was already a `deny` the replace was a
**no-op** — the bundle went to the verifier pristine and passed. ADR-0118's own MRM `deny` row is
what shifted the segment and exposed it. It now flips whichever effect the row carries and asserts
the bytes actually changed. **M-033 in a new place: the vacuity was in the setup, not the assertion.**

**Suite: 183 files / 2807 passed / 9 MinIO skips, exit 0** on a freshly created database; repo-wide
build and `tsc --noEmit` clean; instrument asserted (`ECONNREFUSED: 0`, `destroySoon: 0`).

## Honest limits

- **Two of the eight controls cannot be hardened from the API at all**, so "one switch" is true of
  six. The other two need a deployment change, and the report says so rather than quietly scoring
  six out of six.
- **The preset does not verify that hardening is SAFE for a given deployment.** It refuses nothing on
  the operator's behalf: applying it to a live install with unregistered use cases or unapproved
  model cards will start refusing real traffic immediately. The `refuses` text is the warning; there
  is no dry-run mode, and that is a real gap rather than a deliberate omission.
- **There is no un-harden operation.** Reverting is done through the ordinary settings surface, which
  is deliberate — a one-click "turn all the controls off" is not a button this product should own.
- **`hardened: true` is unreachable on a default install** because the anchor and scheduler are
  environment-backed. That is honest rather than convenient, and an operator who wants the flag
  green has to change the deployment.
- The preset writes `org_settings` directly rather than routing each control through its own
  endpoint. Only `mrmEnforced` currently has divergent audit semantics, and that one case is handled;
  **a control gaining its own toggle semantics later would need the same treatment**, and nothing in
  the type system enforces that.

## What the deck may now say

> **"Ships behaviour-preserving, hardens in one step. `GET /v1/org/posture` answers 'what is
> enforcing right now?' — every control, its current value, and what turning it on would refuse.
> One governed, audited call turns the enforcing set on together. Two controls are set by your
> deployment rather than by us, and the report says so instead of scoring itself green."**
