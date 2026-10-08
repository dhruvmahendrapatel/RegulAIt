# The RegulAIt data boundary — what crosses it, per deployment mode

- **Applies to**: RegulAIt 0.1.0 (verified against the tree at the time of writing)
- **Decisions**: [ADR-0041](../decisions/0041-byoc-primary-motion.md) (BYOC/air-gapped as the
  primary motion), [ADR-0015](../decisions/0015-byoc-deploy-modes-data-boundary.md) (the three
  modes and the code-enforced boundary), [ADR-0034](../decisions/0034-custom-llm-providers-egress-guard.md)
  and [ADR-0043](../decisions/0043-mcp-oidc-egress-guard.md) (the egress guard),
  [ADR-0062](../decisions/0062-mode-scoped-egress.md) (mode-scoped egress — §4/§4.1),
  GOVERNANCE_LAYER_SPEC §8.4/§8.5
- **Status of this document**: every claim below was checked against source, and the file names
  and line-level behaviours are cited so you can check them yourself. Where the code does **not**
  support a claim we would like to make, this document says so instead of making it.

---

## 0. Read this part first

There are two very different kinds of statement in a document like this, and vendors routinely
blur them:

1. **"The software does not do X."** Falsifiable by reading the code. Strong.
2. **"The software will not do X if you configure it a certain way."** Falsifiable only by also
   auditing the configuration. Weaker, and it is a statement about *you*, not about us.

RegulAIt's honest position is that **(1) covers the control plane's own behaviour, and (2) covers
everything a customer deliberately connects it to.** RegulAIt is an AI gateway. Its job is to call
models, connectors, MCP tool servers and PM tools on your behalf. Any of those *can* be an internet
SaaS, and if you point it at one, data goes there — that is the feature. What we can tell you
precisely is: **nothing goes anywhere you did not point it**, there is no channel back to us at
all, and in air-gapped mode there is nothing to point it at.

---

## 1. The single strongest claim, and it is verifiable in about five minutes

**RegulAIt makes no outbound call to RegulAIt.** There is no telemetry, no analytics, no usage
beacon, no crash reporter, no update check, no license phone-home, and no vendor-controlled
endpoint of any kind compiled into the product.

How to confirm it yourself, without trusting this document:

```sh
# 1. Every absolute URL compiled into the server and the SPA.
grep -rnoE 'https?://[a-zA-Z0-9._-]+' apps/*/src packages/*/src --include='*.ts' --include='*.tsx' \
  | grep -v '\.test\.' | awk -F: '{print $3":"$4}' | sort -u
```

At the time of writing that list is exactly: `api.github.com`, `gitlab.com`,
`api.bitbucket.org`, `dev.azure.com`, `portal.azure.com`, `console.cloud.google.com`,
`api.linear.app`, `api.monday.com`, `app.asana.com`, `slack.com`,
`generativelanguage.googleapis.com`, `api.x.ai`, `api.anthropic.com`, `api.openai.com`,
`169.254.169.254` (the AWS instance-metadata
address, which appears **only** in the egress guard that blocks it and in the comments explaining
why), plus `localhost`/`127.0.0.1`/`*.internal` and `example.com`-style documentation strings.

> **Updated 2026-08-03 ([ADR-0062](../decisions/0062-mode-scoped-egress.md)).** `api.anthropic.com`
> and `api.openai.com` are **new to this list and not new to the product**. They were always the
> destinations those two adapters reached with no `baseUrl` override — they simply lived inside
> `@anthropic-ai/sdk`'s and `openai`'s own compiled defaults rather than in our source, so this
> grep did not surface them. ADR-0062 needed to *name* every compiled destination in order to
> adjudicate it, so they are now written down in `packages/model-provider/src/index.ts` and pinned
> against the SDKs' actual defaults by a drift test. The set of places this software can reach did
> not change; the set you can see from here did.

Every one of those is a **default endpoint for a connector, git provider, PM tool or model
provider that you have to create a row for before it is ever contacted.** None of them is
RegulAIt's.

```sh
# 2. No telemetry SDK is even a dependency.
grep -rniE 'posthog|sentry|mixpanel|amplitude|segment|datadog|telemetry|analytics' \
  package.json apps/*/package.json packages/*/package.json
# → no matches

# 3. The SPA loads no third-party asset (no CDN, no web font, no beacon).
grep -rn 'cdn\.|fonts\.googleapis|unpkg|jsdelivr' apps/web/index.html apps/web/src
# → no matches
```

**Boot makes no network call.** `apps/gateway/src/main.ts` connects to Postgres, runs migrations,
and listens. That is the whole startup path.

---

## 2. The control plane / agent-execution plane split, concretely

ADR-0015 defines a **control plane** (governance state: users, roles, policies, audit, cost,
projects, workflow instances) and an **agent-execution plane** (where the model actually runs and
where a deploy actually lands). Pillar 3's promise is about what the control plane retains from
the execution plane.

In **hosted**, **byoc** and **air_gapped** as this product ships them, both planes are **the same
compose stack on the customer's own host**. There is no external control plane. ADR-0041 ratifies
exactly this: one deployment, one customer, one org (`ORG_SETTINGS_ID = "singleton"`).

Where the split is *code-enforced* rather than merely architectural is the deploy/rollback
executor: in `air_gapped` mode the control plane retains **metadata only** for a deploy — id,
target, environment, mode — and never the deploy URL or the provider's detail string, either of
which could carry execution-plane specifics. This is asserted by the air-gapped end-to-end test
(`apps/gateway/src/deploy-byoc.test.ts`), so it is a falsifiable property rather than a promise.

---

## 3. Every outbound surface in the product, enumerated

This is the complete set. Each row says what triggers it, what data it carries, and whether the
ADR-0034/0043 egress guard adjudicates it.

| # | Surface | Fires when | Carries | Guarded? |
| --- | --- | --- | --- | --- |
| 1 | **Built-in model providers** (Anthropic, OpenAI, Google, xAI) at their compiled vendor endpoints | an agent using that provider is invoked **and** a platform/user credential or provider env var exists | prompts, system prompts, attached document text, tool definitions and results | **Mode-scoped** — refused unless allow-listed under a strict posture (`air_gapped`, or an org that opted in); unadjudicated under `hosted`/`byoc`. See §4 |
| 2 | **Model credential `baseUrl` override** (`model_credentials`, `user_model_credentials`) | same, when a row sets `baseUrl` | same as #1 | **Yes** — write-time and every dispatch (`credential-egress.ts`) |
| 3 | **Custom model providers** (`custom_model_providers`, ADR-0034) — Ollama, vLLM, LM Studio, an internal gateway | an agent bound to a custom provider is invoked | same as #1 | **Yes** — write-time, enable-time and every dispatch (`custom-providers.ts`) |
| 4 | **Connectors** (Slack, Snowflake, webhook, …) at compiled vendor endpoints | a governed connector tool call | whatever the caller passes to the tool | **Mode-scoped**, same as #1 — and the same now applies to a git (#6) or PM (#7) row with no override. See §4 |
| 5 | **Connector / git / PM `baseUrl` overrides** | as #4/#6/#7, when a row sets `baseUrl` | same | **Yes** — write-time and every call (`connection-egress.ts`) |
| 6 | **Git providers** (GitHub, GitLab, Bitbucket, Azure DevOps) | a workflow reaches a PR/branch stage | branch names, diffs, PR bodies | override-only (see #5) |
| 7 | **PM tools** (Azure DevOps, Jira, Linear, Asana, monday.com, webhook) | pillar-8 sync, approval mirroring | work-item fields, decisions, approvals | override-only (see #5) |
| 8 | **MCP servers** (`mcp_servers.url`) | an MCP tool call, or the MCP proxy connecting upstream | tool arguments and results | **Yes**, with an inverted default: private ranges permitted by default, public hosts require an allow-list entry, `169.254.0.0/16` never permitted (ADR-0043, `mcp-egress.ts`) |
| 9 | **OIDC issuer** (`oidc_providers.issuerUrl`) | a user logs in via OIDC; discovery, token and JWKS fetches | the OAuth exchange — no prompt or document content | **Yes** — write-time and discovery-time (`auth.ts`, ADR-0043) |
| 10 | **SAML IdP** | a user logs in via SAML | nothing server-to-server: SAML here is redirect/POST-binding through the **browser**; the gateway makes no outbound call (`saml.ts` contains no `fetch`) | n/a |
| 11 | **Caddy → Let's Encrypt (ACME)** | only when `REGULAIT_TLS_ISSUER` is empty, i.e. `--tls letsencrypt` | your hostname, and an inbound HTTP-01 challenge on :80 | not applicable (it is not the gateway) |
| 12 | **Docker image pulls / `pnpm install`** | `docker compose up --build` | nothing of yours; it is a build | install-time only |
| 13 | **`infra/scripts/pg-backup.sh` → S3** (ADR-0035) | only if you install the backup timer against an S3 bucket | your entire database, as a `pg_dump` | you choose the bucket; it is your account |
| 14 | **OTLP trace export** (`org_settings.tracingOtlpEndpoint`, ADR-0070) | an admin calls `POST /v1/tracing/export`; nothing is configured by default | span trees, timings, costs, deny reasons; prompt and output content only when trace content capture is on | **Yes** — every export (`tracing.ts`). Wire format: §3.1 |

### 3.1 Trace export wire format (ADR-0186 T, 2026-10-07)

- **Format:** OTLP/HTTP **JSON** only (`content-type: application/json`). Every `ResourceSpans` and `ScopeSpans` carries
  `schemaUrl: https://opentelemetry.io/schemas/1.43.0`, the semantic-conventions version our keys are pinned to
  (`OTEL_SCHEMA_URL` in `packages/shared/src/tracing.ts`, derived from the pin).
- **Open tracing UIs** (ADR-0177 rows 18–19 — export destinations only, never bundled or hosted): the export is
  checked against hand-written fixtures of each one's documented ingest shape
  (`packages/shared/src/__fixtures__/otlp-ingest/`). **Langfuse** takes the JSON body directly at
  `/api/public/otel/v1/traces`; use the `openinference` profile there, because Langfuse's documented mapping reads
  `input.value`/`output.value` and `user.id`, not the `otel_genai` profile's `gen_ai.input.messages` and `enduser.id`.
  **Phoenix** accepts only protobuf on OTLP/HTTP, so put an OpenTelemetry Collector between us and it (an `otlp`
  receiver on HTTP, an `otlphttp` exporter to `http://<phoenix>:6006/v1/traces`). The `openinference` profile is
  Phoenix's native vocabulary; the `otel_genai` profile needs Phoenix 15.10.0 or later, which converts `gen_ai.*` on
  ingest.
- **`gen_ai.system` ends on 2027-01-01.** The deprecated key is still sent beside `gen_ai.provider.name`; the first
  release on or after `GEN_AI_SYSTEM_DUAL_EMIT_UNTIL` (2027-01-01) stops sending it, and a test fails on that date until
  it does. Move a dashboard grouping on `gen_ai.system` to `gen_ai.provider.name` before then.

Inbound surfaces (someone calls **you**) are out of scope for a data-boundary claim but are worth
naming so the list is complete: the HTTPS API itself, SCIM provisioning (`scim.ts`), PM inbound
webhooks (`packages/pm-provider/src/inbound.ts`), and the IDE-compat endpoints (ADR-0020).

---

## 4. The finding: rows 1 and 4 were **not** behind the egress guard — and now are, per mode

> **Status of this section, 2026-08-03.** Everything below the horizontal rule is the finding
> **exactly as it was originally written**, kept verbatim. It is what this document said while it
> was true, and a trust artifact that quietly rewrites its own weakest point is worth less than one
> that shows the repair. [ADR-0062](../decisions/0062-mode-scoped-egress.md) closed it; **§4.1 at
> the end of this section describes what the code enforces now and what remains true.**

This is the part a trust document is tempted to omit. We are not omitting it.

The egress guard adjudicates **URLs a human typed**. It deliberately does **not** adjudicate a
provider adapter's *compiled* vendor endpoint. The reasoning is written into the source in two
places, in the same words:

> **NO OVERRIDE MEANS NO CHECK**: with `baseUrl` null the adapter uses its compiled vendor default,
> which no human can type, so there is nothing to decide and the behaviour of every non-overriding
> deployment is byte-identical.
> — `apps/gateway/src/agents-connectors.ts` (model credentials), and the same paragraph in
> `apps/gateway/src/connection-egress.ts` (connectors / git / PM)

That reasoning is sound **as an SSRF argument** — you cannot smuggle `169.254.169.254` into a
constant. It is not the same thing as an egress *policy*. The consequence, stated plainly:

> **On an air-gapped deployment, if an operator configures a built-in provider (`anthropic`,
> `openai`, `google`, `xai`) — by storing a platform credential, a per-user credential, or (only
> once an admin has turned the env-key fallback on; it ships off since ADR-0181) by setting
> `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `GEMINI_API_KEY` /
> `XAI_API_KEY` in the environment — then invoking an agent on that provider will attempt an
> outbound HTTPS connection to that vendor's public API, carrying the prompt. Nothing in the
> application refuses it. The connection fails only because the network has nowhere to send it.**

The same is true of a connector, git or PM row created with no `baseUrl` override.

So the accurate air-gapped claim is **not** "the application cannot egress". It is:

- the application **initiates no outbound connection you did not configure**, and
- **nothing is configured out of the box** — no credential row, no connector, no MCP server, no
  OIDC provider, and `SEED_DEMO=0` on every non-hosted install, and
- the **network** is the enforcement boundary for the compiled-endpoint case.

Two things follow, and both are recommendations rather than claims:

1. **Enforce it at the network, not on our word.** An air-gapped deployment should have no default
   route and no egress-permitting security-group rule. That single control covers rows 1, 4, 6, 7,
   11 and 12 unconditionally, without depending on anything in this codebase.
2. **Prefer custom providers (row 3) over built-in providers with a `baseUrl` override (row 2), and
   prefer either over a built-in provider with no override (row 1).** Rows 2 and 3 are guarded;
   row 1 is not. A self-hosted vLLM or Ollama endpoint registered as a custom provider is the
   air-gapped-native path and is the one ADR-0034 built the guard for.

**Closing this properly is a real follow-up**, not a documentation problem: a mode-scoped egress
posture (e.g. `org_settings` refusing any non-allow-listed *compiled* endpoint when the deployment
is air-gapped) would make row 1 code-enforced. It is not built. ADR-0015's A4 note already
identifies per-mode policy as belonging in pillar 1's rule-scoping model, with its own slice and
its own ADR. Until that exists, §4 is the truth.

### 4.1 What changed — ADR-0062, 2026-08-03

The follow-up named in the paragraph above was built, with one deliberate difference from the
sketch: the deployment-wide posture is **derived from the environment**, not from `org_settings`.
"Is this installation air-gapped" is a fact about the box, not a row an admin can judge from a
portal — and an air-gapped posture a compromised admin account could switch off from a web form
would not be one. This follows the [ADR-0029](../decisions/0029-zero-cost-tls-caddy-sslip-letsencrypt.md)
HSTS precedent exactly, and it is the same category as `REGULAIT_HSTS` and
`REGULAIT_TRUSTED_PROXIES`.

**The posture, per mode:**

| `REGULAIT_DEPLOY_MODE` | compiled vendor endpoints | why |
| --- | --- | --- |
| unset (**default**) → `hosted` | not adjudicated | byte-identical to every deployment before this change |
| `byoc` | not adjudicated | §5 already says this mode reaches real endpoints on purpose |
| `air_gapped` | **refused unless the host is in `egress_allow_hosts`** | the mode's whole claim |

`org_settings.egressCompiledDefaultPolicy` (`inherit` | `strict`) composes as
`STRICTEST(env mode, org tightening)`. A hosted or BYOC admin **can** opt in to the strict posture.
No value of that column loosens an air-gapped deployment — the enum has no such member.

**What is enforced, concretely.** Under a strict posture, a governed call whose adapter would run
on its compiled vendor endpoint — a model dispatch (row 1), a connector invoke (row 4), a git stage
(row 6) or a PM sync (row 7) with no `baseUrl` override — is **refused before the adapter is
constructed**, with a real 403 (or a failed workflow stage on the git path, which has no per-call
HTTP boundary), a reason naming the host, and an audit row under the stable ruleId
`compiled-default-egress-blocked`. The proof is not "a 4xx came back":
`apps/gateway/src/mode-scoped-egress.test.ts` replaces `globalThis.fetch` with a **willing**
recording spy that would answer 200, and asserts **zero** recorded requests plus the absence of the
prompt's canary string from everything the spy saw.

**To run a self-hosted model air-gapped**, nothing changes from the recommendation in §4 above —
it is now the enforced path rather than the advised one. Register the endpoint as a **custom model
provider** (Ollama / vLLM / LM Studio / an internal gateway) or set an explicit `baseUrl`, and add
its host to **Egress Allow Hosts** with `allowPrivateRanges` (plus `allowPlaintextHttp` for an
internal service with no public CA). The same suite proves a `127.0.0.1` endpoint serves a dispatch
under `air_gapped` with zero public-internet traffic. An operator who deliberately wants one vendor
reachable from an otherwise-sealed box adds that single host — a decision with a name, a row and an
audit trail.

**What remains true, and this is the part that matters:**

1. **Recommendation 1 above is unchanged and is still the stronger control.** An air-gapped
   deployment should have no default route and no egress-permitting security-group rule. ADR-0062
   makes the *application* stop trying; it does not make the box unable to reach the internet.
2. **It governs this gateway's governed calls, not the process.** Image pulls, `pnpm install`,
   Caddy's ACME client, and the cloud SDKs used by the infra/deploy providers are all outside it —
   rows 11, 12 and 13 are unaffected.
3. **An operator who sets `REGULAIT_DEPLOY_MODE` wrong gets the wrong posture.** A *malformed*
   value throws at boot rather than degrading to `hosted`, and the effective posture is printed in
   the boot log next to the proxy and HSTS lines — but neither helps an operator who never sets it.
4. **An adapter whose default is not statically knowable is refused, not adjudicated** (today: a
   Snowflake connector, whose endpoint derives from the decrypted credential). It fails closed,
   which is the right direction, but the strict posture is coarser than the typed-URL guard: it can
   say "no" without saying where the call would have gone. The same applies to any provider adapter
   added after ADR-0062 — it fails closed by default.
5. **`hosted` and `byoc` are unchanged by default**, so for those deployments the finding above is
   still a live description until an org opts in.
6. Allow-listing a host says nothing about **what that host does with the data** — see §7.

---

## 5. Per-mode summary

### `air_gapped`

| Question | Answer |
| --- | --- |
| Does anything reach RegulAIt (the vendor)? | **No.** No endpoint of ours exists in the product. §1 is checkable in five minutes. |
| Does anything reach the public internet? | **Only what you configure — and since [ADR-0062](../decisions/0062-mode-scoped-egress.md), only what you also allow-list.** In this mode a built-in model provider, connector, git or PM adapter running on its compiled vendor endpoint is refused by the application (403 + audit, adapter never constructed) unless that host is in `egress_allow_hosts`. The network is still the stronger backstop and §4.1 says so; it is no longer the only one. With nothing configured, nothing is attempted. |
| Is TLS issuance an outbound call? | Not in this mode. `install.sh --mode air_gapped` **refuses** `--tls letsencrypt` and uses Caddy's internal CA (`tls internal`), which issues locally. |
| Does the install pull images? | **No.** The air-gapped path runs `docker compose up --no-build` against pre-seeded images loaded from a file (`scripts/build-image-bundle.sh` on a connected host). |
| Does an update phone home? | **No.** Update bundles are files. `scripts/verify-update-bundle.sh` verifies offline against a pinned public key and makes no network call — deliberately, since there is no revocation endpoint or timestamp authority to reach. |
| Does licensing phone home? | Not applicable yet — offline licensing is [ADR-0052](../decisions/0052-licensing-seats.md) and is **not built**. There is no license check in the product today, so there is nothing to phone home. |
| What does the control plane retain about a deploy? | Metadata only — id, target, environment, mode. Never the deploy URL or the provider detail string. Code-enforced, and asserted in `deploy-byoc.test.ts`. |
| Does an operator ever have to trust us at runtime? | No. The only trust decision is at update time, and it is a signature check you can perform yourself. |

### `byoc`

Everything in `air_gapped` holds **except** that the deployment has internet, so:

- `--tls letsencrypt` is available; Caddy then talks to Let's Encrypt (your hostname, an ACME
  account key, an inbound HTTP-01 challenge on :80). Choose `--tls internal` or `--tls none` if
  even that is unacceptable.
- Images are pulled and the gateway image is built on the box (Docker Hub, npm registry).
- Configured connectors/models/MCP/PM reach their real endpoints. That is the point of the mode,
  and it is why ADR-0062 leaves `byoc` on the permissive posture by default. A BYOC operator who
  wants the air-gapped posture sets `org_settings.egressCompiledDefaultPolicy = 'strict'` (or the
  env var) — one line, and it can only tighten.
- **Still nothing reaches RegulAIt.** The control plane is in your account, under your IAM, holding
  your `REGULAIT_DATA_KEY`. There is no upstream.

### `hosted`

ADR-0041 §3 is explicit that hosted is **"a single-tenant instance we happen to operate for
you"**, not a shared multi-tenant SaaS. Same artifact, different location. So:

- The software boundary is identical to `byoc` — the same binary, the same absence of telemetry.
- The **operational** boundary is not: we hold the host, therefore the disk, therefore
  `REGULAIT_DATA_KEY` and the database. Anyone with host access can read everything, and this
  document will not pretend a code property compensates for that.
- If who-holds-the-disk matters to you, hosted is an evaluation on-ramp, not a destination. The
  upgrade path to BYOC is real precisely because it is the same artifact (§8.5).

---

## 6. What a customer can independently confirm, and how

| Claim | How to check it yourself | Cost |
| --- | --- | --- |
| No vendor endpoint is compiled in | the `grep` in §1 | 5 minutes |
| No telemetry dependency | the `grep` in §1 | 1 minute |
| Boot makes no network call | read `apps/gateway/src/main.ts` — 38 lines | 2 minutes |
| Nothing leaves during normal operation | run the stack with **no default route**, or with `tcpdump`/VPC flow logs on, and exercise it | one afternoon |
| The egress guard refuses what it claims to | `apps/gateway/src/egress-guard.test.ts` — it asserts IMDS, IPv4-mapped IPv6, userinfo-in-URL and DNS-rebind refusals | run `pnpm -r test` |
| An air-gapped install refuses vendor endpoints, and the provider is never called | `apps/gateway/src/mode-scoped-egress.test.ts` — asserts **zero** requests reach a deliberately-willing fetch spy, not merely that a 403 came back | run `pnpm -r test` |
| Air-gapped deploys retain metadata only | `apps/gateway/src/deploy-byoc.test.ts` | run `pnpm -r test` |
| An update bundle is what it claims to be | `scripts/verify-update-bundle.sh <bundle>` — offline, against `infra/release-keys/` | seconds |
| The installer refuses a weak data key | `scripts/install.sh --check --data-key $(printf 'a%.0s' $(seq 64))` | seconds |

The strongest of these is the second-to-last row in a different sense: **you do not have to trust
this document, because you can run the product with the network taken away and watch it work.**
That is the test we would ask for in your position.

---

## 7. Known limits of this document

- It describes RegulAIt 0.1.0. Re-run §1's greps after any upgrade; that is why they are written
  out rather than summarised.
- It covers **network egress**. It does not cover what a *model you configured* does with the
  prompt after it receives it, nor what a connector's far end retains. Those are your vendor
  agreements, not ours.
- It makes no claim about reproducible builds or build provenance. The update bundle proves *who
  signed it*, not *that it was built from a particular commit*. See
  `infra/release-keys/README.md` §"What signing does and does not prove".
- §4 **was** a real gap between "air-gapped" as a marketing word and air-gapped as an enforced code
  property. It is written here rather than in an internal ticket because a trust artifact that
  omits its own weakest point is not a trust artifact. [ADR-0062](../decisions/0062-mode-scoped-egress.md)
  closed it for `air_gapped`; §4.1 records what is enforced and the four things that remain true —
  above all that the network is still the stronger control, and that an operator who never sets
  `REGULAIT_DEPLOY_MODE` gets the permissive posture.
