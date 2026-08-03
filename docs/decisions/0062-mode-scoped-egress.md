# ADR-0062: Mode-scoped egress — make `air_gapped` a code-enforced property, not a network assumption

- **Status**: Accepted
- **Date**: 2026-08-03
- **Relates to**: [ADR-0034](0034-custom-llm-providers-egress-guard.md) and
  [ADR-0043](0043-mcp-oidc-egress-guard.md) (the egress guard and its "one egress policy, one
  place" rule), [ADR-0015](0015-byoc-deploy-modes-data-boundary.md) and
  [ADR-0041](0041-byoc-primary-motion.md) (the three deployment modes and the data boundary),
  [ADR-0029](0029-zero-cost-tls-caddy-sslip-letsencrypt.md) HSTS amendment (the governing
  precedent for "deployment-shape facts live in the environment, not in `org_settings`"),
  [ADR-0021](0021-org-settings-configurability-layer.md) (the ceiling model),
  [`docs/deployment/DATA_BOUNDARY.md`](../deployment/DATA_BOUNDARY.md) §4 (where this finding was
  recorded)

## Context

### The finding

The ADR-0034/0043 egress guard adjudicates **URLs a human typed**. Two call sites say so outright,
in the same words:

> **NO OVERRIDE MEANS NO CHECK**: with `baseUrl` null the adapter uses its compiled vendor default,
> which no human can type, so there is nothing to decide and the behaviour of every non-overriding
> deployment is byte-identical.
> — `apps/gateway/src/agents-connectors.ts` (model credentials, and again at the connector-invoke
> site), and the same paragraph in `apps/gateway/src/connection-egress.ts` (connectors / git / PM)

That reasoning is **correct as an SSRF argument**. You cannot smuggle `169.254.169.254` into a
constant, so a compiled endpoint carries none of the risk that made the guard necessary. It is
**not an egress policy**, and ADR-0041's verification exercise found the difference matters:

> On an air-gapped deployment, if an operator configures a built-in provider (`anthropic`,
> `openai`, `google`, `xai`) — by storing a platform credential, a per-user credential, or simply
> by setting `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `GEMINI_API_KEY` /
> `XAI_API_KEY` in the environment — then invoking an agent on that provider will attempt an
> outbound HTTPS connection to that vendor's public API, **carrying the prompt**. Nothing in the
> application refuses it. The connection fails only because the network has nowhere to send it.
> — `DATA_BOUNDARY.md` §4

The same held for a connector, git or PM row created with no `baseUrl` override: a Slack connector
posting `body.payload` to `https://slack.com/api/chat.postMessage`, a git stage pushing a branch to
`https://api.github.com`, a PM sync writing work-item content to `https://api.linear.app`.

So the honest air-gapped claim was *"the network is the enforcement boundary"*. For a mode whose
entire value proposition is **"nothing leaves"**, an enforcement boundary that lives outside the
product is a marketing word, not a property.

### Why this could not be fixed with the existing machinery

`deployMode` (`hosted | byoc | air_gapped`) exists in the schema **only on deploy-target rows** —
a property of a thing a user creates and can edit. There is **no deployment-wide mode**. And "is
this installation air-gapped" is not a row: it is a fact about the box, known by the operator who
installed it and not by an admin looking at a portal.

### Two things this must not break

1. **Every existing deployment must be byte-identical after the upgrade.** `hosted` is the default
   and the overwhelming majority of installs.
2. **BYOC has internet on purpose.** `DATA_BOUNDARY.md` §5 says so in as many words:
   *"Configured connectors/models/MCP/PM reach their real endpoints. That is the point of the
   mode."* Making `byoc` strict by default would break every BYOC install's built-in providers on
   upgrade, to enforce a claim that mode never made.

## Decision

**The deployment-wide egress posture is derived from the environment, `org_settings` may only
tighten it, and under a strict posture a dispatch whose adapter would run on its *compiled vendor
default* is refused unless that host is in the existing `egress_allow_hosts` table.**

### 1. The posture matrix

| `REGULAIT_DEPLOY_MODE` | mode posture | with `org_settings.egressCompiledDefaultPolicy = 'strict'` |
| --- | --- | --- |
| unset (**default**) → `hosted` | permissive — today's behaviour, byte-identical | strict |
| `byoc` | permissive — the mode's whole point is reaching real endpoints | strict |
| `air_gapped` | **strict** | strict |

`effective = STRICTEST(env mode, org tightening)`, over the lattice `permissive < strict`. The
`org_settings` enum is `('inherit', 'strict')` and has **no member that loosens**: the ceiling
holds by construction, not by a validation rule someone could later relax.

- *permissive* = the compiled default is **not adjudicated at all** — not "checked and allowed".
  No allow-list query is issued, no transport changes, nothing new can fail.
- *strict* = the compiled destination is resolved to a host and must appear in
  `egress_allow_hosts`. Otherwise the call is refused with a real 403 (or, on the git path which
  has no per-call HTTP boundary, a thrown `execution_failed` with the reason) and an audit row
  under the stable ruleId `compiled-default-egress-blocked`.

A malformed `REGULAIT_DEPLOY_MODE` **throws at boot**. The quiet failure mode of a typo is an
operator who believes the box is air-gapped and is running the permissive posture — precisely the
confusion this ADR exists to end. (`resolveHsts` throws for the same reason.)

### 2. Why the deployment-wide fact is env-derived and NOT an admin toggle

This was weighed against the ADR-0021 "admins get options wherever a choice is feasible" mandate
and deliberately not put behind a portal switch, following the
[ADR-0029 HSTS amendment](0029-zero-cost-tls-caddy-sslip-letsencrypt.md#configurable--but-as-a-deployment-variable-not-an-org-setting)
**exactly**. Its three reasons transfer without modification, and one is stronger here:

1. **It is a deployment-shape fact, not an org policy.** HSTS's safety depends on whether the
   hostname is stable and who terminates TLS; this depends on whether the box has a default route,
   sits in a disconnected enclave, or runs in the customer's VPC. *"An admin clicking a toggle in
   the portal cannot know whether the box's address is elastic"* becomes: an admin cannot know
   whether this installation has egress. `REGULAIT_HSTS` and `REGULAIT_TRUSTED_PROXIES` are the
   precedent — same category, same home, same boot-log line.
2. **An admin must not be able to UNDO it.** This is where the analogy goes further than HSTS. An
   air-gapped posture that a compromised — or merely mistaken — admin account can switch off from
   a web form is not an air-gapped posture. ADR-0034's own reasoning ("*'only an admin can set it'
   is NOT a mitigation: an admin account is exactly what an attacker escalates to*") applies
   directly to the switch that would disable the guard.
3. **It must not depend on the database being right.** The env is read on every consultation and
   printed at boot next to the proxy and HSTS postures, so an operator can see what this box
   refuses without querying anything.

The org dial exists so a **hosted or BYOC** operator can opt in — that is a genuine org policy
choice, and it is the direction the ceiling allows.

### 3. Resolving a compiled default to an actual host

You cannot adjudicate a destination you cannot name. Each provider package now exposes what its
adapter reaches with no override, as a deliberate **tri-state**:

| value | meaning |
| --- | --- |
| a URL string | the destination; adjudicated against the allow-list |
| `null` | nothing to adjudicate — the adapter makes no outbound call of its own (`mock`, in-process) or cannot be constructed without an explicit, already-guarded `baseUrl` (`custom`, `jira`, `webhook`, `azure_devops`, `generic_webhook`, …) |
| `undefined` | **not statically knowable** — refused under a strict posture |

- `packages/model-provider`: `defaultBaseUrlFor(kind, env)` → `api.anthropic.com`,
  `api.openai.com/v1`, `generativelanguage.googleapis.com/v1beta`, `api.x.ai/v1`.
- `packages/connector-provider`: `connectorDefaultBaseUrl(kind)` → `slack.com/api`,
  `api.github.com`.
- `packages/git-provider`: `gitDefaultBaseUrl(provider)` → `api.github.com`,
  `gitlab.com/api/v4`, `api.bitbucket.org/2.0`.
- `packages/pm-provider`: `pmDefaultBaseUrl(provider)` → `api.linear.app`,
  `app.asana.com/api/1.0`, `api.monday.com`.

Two consequences of doing this properly rather than by guesswork:

- **Two of these destinations were previously invisible.** `api.anthropic.com` and
  `api.openai.com` lived only inside the vendor SDKs' own defaults, so `DATA_BOUNDARY.md` §1's
  "every absolute URL compiled into the server" grep did not list them. They were real
  destinations and unlisted at the same time. They are now written down, and §1's expected output
  is updated to match. A **drift test** constructs each SDK client and asserts its `.baseURL`
  equals our constant, so an SDK upgrade that moved the default would fail the build rather than
  make the guard adjudicate a host the adapter never contacts.
- **The SDK `*_BASE_URL` environment variables are part of the answer.** `@anthropic-ai/sdk` and
  `openai` both read `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` when no `baseURL` is passed, so on a
  box that sets one, the SDK's real destination is that value. `defaultBaseUrlFor` reads the same
  variables, so what it returns is what the adapter will actually reach. (The gateway's env-key
  fallback already threaded those into the *guarded* `baseUrl` path; this covers the remaining
  case — a stored credential with no override on a box that also exports the variable.)

**`undefined` refuses.** Today the only case is a `snowflake` connector, whose default is derived
from the decrypted credential (`https://<account>.snowflakecomputing.com`) and is therefore
knowable at call time but not statically. Under strict posture it is refused with
`compiled_default_unknown` rather than assumed safe. "We could not work out where this goes" is
not a reason to let it go there, and an air-gapped operator who needs that connector types an
explicit `baseUrl` — which is the guarded path anyway. The same applies to any provider kind added
after this was written: an unrecognised kind is `undefined`, so a **new adapter fails closed on an
air-gapped box** instead of silently inheriting an exemption.

### 4. One allow-list, and what is deliberately *not* re-implemented

ADR-0043 fought for *"one egress policy, one place to reason about it"*. There is no second
allow-list: the decision reads the same `egress_allow_hosts` rows, with the same normalization, as
every other surface.

What the compiled-default check deliberately does **not** do, and why:

- **No DNS resolution and no address-range check.** Those exist because a *typed* string can point
  anywhere and can be re-pointed after approval. A compiled constant has no rebind window and no
  attacker-chosen host, and resolving it would add a round-trip to every dispatch — on the very box
  this feature is for, that is the lookup that hangs.
- **No transport change.** Under permissive, behaviour is byte-identical including the fetch
  implementation. Under strict *with the host allow-listed*, it is **also** byte-identical: the
  deployment said yes, and re-validating a constant per request would re-derive the same answer.
  The surfaces that carry an admin-typed destination (model-credential overrides, custom providers,
  connection `baseUrl`s, MCP servers) keep their guarded, DNS-pinned fetch exactly as ADR-0034/0043
  built it.

So this is honestly scoped: a **per-deployment permission on a vendor**, layered on top of an SSRF
guard, not a second copy of one.

### 5. What an air-gapped deployment must now allow-list

Nothing, if it is genuinely air-gapped — an empty allow-list is the correct configuration and every
compiled vendor endpoint is refused.

To run a **self-hosted model** air-gapped, nothing changes from ADR-0034's design, and this is the
path the mode was always meant to take:

- Register the endpoint as a **custom model provider** (Ollama / vLLM / LM Studio / an internal
  gateway), or set an explicit `baseUrl` on a model credential; and
- add its host to **Egress Allow Hosts** with `allowPrivateRanges` (and `allowPlaintextHttp` if it
  speaks plain http, which an internal service with no public CA generally does).

That path never consults the compiled default, so the strict posture does not touch it. A test in
this change proves it end to end: an on-prem OpenAI-compatible endpoint on `127.0.0.1` serves a
dispatch under `air_gapped` while **zero** requests reach the public-internet spy.

An operator who deliberately wants a specific vendor reachable from an otherwise-sealed box adds
that one host (e.g. `api.anthropic.com`) as an ordinary allow entry. That is a decision with a
name, a row and an audit trail, which is the whole difference from today.

## Consequences

**Easier**

- `air_gapped` is now a **property of the code**, verifiable by running the suite, rather than a
  claim about someone's firewall. `DATA_BOUNDARY.md` §4 stops being an open finding.
- The full set of compiled vendor destinations is now enumerable in source, including the two that
  were hidden inside SDK defaults — which makes §1's five-minute `grep` complete rather than
  nearly complete.
- A **new provider adapter fails closed** on an air-gapped box by default, because an unknown kind
  resolves to "cannot name it".
- One stable ruleId (`compiled-default-egress-blocked`) answers "what did this box refuse to reach"
  across all four surfaces from a single audit query.
- A hosted or BYOC org that wants the stricter posture gets it from one setting, without an
  operator touching the box.

**Harder / given up**

- **An air-gapped operator who genuinely needs a vendor must now add an allow entry.** That is the
  intended friction, but it is friction: an install that previously "worked" by accident (because
  the network happened to permit it) will now refuse until somebody decides.
- **One more environment variable** that must be set correctly at deploy time, and a mis-set one is
  a real failure mode (see the residual below).
- The `undefined` refusal means a **Snowflake connector with no explicit `baseUrl` stops working**
  the moment a deployment goes strict. That is deliberate and disclosed, not a bug.

**The honest residual, stated plainly**

1. **An operator who sets the environment wrong gets the wrong posture.** If `REGULAIT_DEPLOY_MODE`
   is left unset on a box that is physically air-gapped, this change enforces nothing there. The
   mitigations are that a *malformed* value throws at boot rather than degrading, that the
   effective posture is printed in the boot log next to the proxy and HSTS lines, and that an
   admin can raise the floor from `org_settings` without an operator. None of that helps an
   operator who never looks. This is the same residual `REGULAIT_HSTS` and
   `REGULAIT_TRUSTED_PROXIES` carry, and it is the price of putting the fact where an admin cannot
   undo it.
2. **An adapter whose default is not statically knowable is refused, not adjudicated.** That fails
   closed, which is the right direction, but it means the strict posture is *coarser* than the
   typed-URL guard: it can say "no" without being able to say where the call would have gone.
3. **This narrows the threat model; it does not eliminate it.** Specifically:
   - It governs **destinations this gateway's adapters reach on a governed call**. It is not a
     process-wide egress filter: an npm postinstall script, a `docker pull`, Caddy's ACME client,
     the AWS/Azure/GCP SDKs used by the infra and deploy providers, and anything else in the image
     are all outside it.
   - Once a host is allow-listed, this says nothing about **what that host does with the data** —
     the same limit `DATA_BOUNDARY.md` §7 already records.
   - It is an **application-layer control**. The network remains the stronger boundary and
     `DATA_BOUNDARY.md`'s recommendation to run an air-gapped deployment with no default route
     stands unchanged. This makes the application stop *trying*; it does not make the box unable to
     reach the internet.
4. **`hosted` and `byoc` are unchanged by default**, so the finding remains live for exactly those
   deployments until an org opts in. That is a deliberate compatibility choice, not an oversight.

**Where it lives**

- `apps/gateway/src/deploy-posture.ts` — `resolveDeployMode` / `modeEgressPosture` /
  `resolveEgressPosture` / `describeEgressPosture` (pure; env injectable).
- `apps/gateway/src/compiled-egress.ts` — `decideCompiledDefault` (pure), the audit writer, and
  `loadCompiledEgressContext` (env + org row + allow-list snapshot).
- Call sites: both `agents-connectors.ts` sites (model dispatch ~line 520, connector invoke
  ~line 3060), `workflows.ts` (git stage), `pm.ts` (`providerFor`, the single chokepoint all seven
  PM call sites use).
- Registries: `defaultBaseUrlFor`, `connectorDefaultBaseUrl`, `gitDefaultBaseUrl`,
  `pmDefaultBaseUrl` in the four provider packages.
- Migration **0074** (`egress_compiled_default_policy`, default `'inherit'`), the zod field, and
  the admin-portal dial.
- Wiring: `docker-compose.yml` passes `REGULAIT_DEPLOY_MODE` into the gateway container, and
  `scripts/install.sh --mode` already writes it into the rendered `.env` — so an installed
  air-gapped deployment gets the strict posture without anybody editing a file. That file's comment
  used to read *"No gateway code reads it"*; it does now, and the comment says so.
- Tests: `apps/gateway/src/deploy-posture.test.ts` (23, pure — including the exhaustive
  mode × policy matrix) and `apps/gateway/src/mode-scoped-egress.test.ts` (16, end-to-end against
  a real Postgres with `globalThis.fetch` replaced by a **willing** recording spy, so every
  refusal is asserted as *zero provider invocations* rather than as a status code), plus the SDK
  drift test in `packages/model-provider/src/index.test.ts`.

**Still not production.** Nothing here changes the deployment's status, and the standing guardrail
in `CLAUDE.md` is untouched.
