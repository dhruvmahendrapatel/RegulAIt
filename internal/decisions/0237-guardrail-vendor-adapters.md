# ADR-0237: Native adapters for third-party guardrail providers

- **Status**: Accepted (builder, 2026-11-07; backlog P12(a), `internal/product/PENDING.md`)
- **Date**: 2026-11-07
- **Migration**: 0292 (`when` 1785219000000)

## Context

[ADR-0088](0088-external-scorer-adapter.md) lets an admin register an external scoring endpoint that speaks our
contract (`{input, output, context, scorerKind}` in, `{score, reasons}` out) and told operators whose vendor speaks
another dialect to run a translation shim. [ADR-0220](0220-trained-runtime-detectors.md) put registered scorers on the
inline guardrail path as three opt-in trained detectors (`pii`, `prompt_injection`, `harm`), fail closed, counts only.
Backlog P12(a) asks for native adapters for third-party guardrail providers on top of that shim, so an operator who
already buys one does not have to write and host a shim.

### What the shim already supported (survey)

- Registration, connection test, enable, delete (`/v1/external-scorers`), admin-only; register → test → enable; moving
  the endpoint re-arms the gate.
- Egress: the admin-typed `baseUrl` is checked by the ADR-0034 guard at registration, at resolution, and per request
  in the DNS-pinned guarded fetch. A typed destination is adjudicated against the default-deny allow-list in every
  deploy mode.
- Secrets: the key is AES-256-GCM under `REGULAIT_DATA_KEY` (`key_ciphertext`), write-only, read back as `hasApiKey`.
- One wire dialect, one auth style (`Authorization: Bearer`).
- Guardrail kinds `guardrail_pii`, `guardrail_prompt_injection`, `guardrail_harm` (ADR-0220), with the fail-closed
  merge, step-up for every relaxation of a detector, and a per-detector timeout.
- Not there: vendor dialects, vendor auth headers, an air-gapped refusal specific to vendor SaaS (the allow-list was
  the only control), any spend record for a scorer call, or a per-call audit row.

## Decision

1. **Three adapters, chosen for reach and a public, documented API.** Each external scorer gains `adapter`
   (default `regulait`, the ADR-0088 contract):

   | adapter | API | kinds it may claim | why it was picked |
   |---|---|---|---|
   | `openai_moderation` | OpenAI Moderation, `POST /v1/moderations` | `guardrail_harm` | the most widely deployed moderation API; free to call; official Apache-2.0 SDK |
   | `azure_content_safety` | Azure AI Content Safety `text:analyze` and Prompt Shields `text:shieldPrompt`, api-version 2024-09-01 | `guardrail_harm`, `guardrail_prompt_injection` | the default guardrail of Azure OpenAI deployments; GA; covers injection as well as harm |
   | `lakera_guard` | Lakera Guard `POST /v2/guard` with `breakdown: true` | `guardrail_prompt_injection`, `guardrail_pii`, `guardrail_harm` | the most widely used dedicated prompt-injection API; one call covers all three kinds |

   Considered and not picked for this slice: AWS Bedrock `ApplyGuardrail` (SigV4 signing and a configured guardrail
   resource; a good second slice), Google Model Armor (OAuth service accounts), and self-hosted model servers (already
   served by the `regulait` contract and the ADR-0220 sidecar). The choice keeps the provider-agnostic principle: three
   unrelated vendors, none required.

2. **Translation is in the gateway, the verdict shape is unchanged.** `@regulait/shared` `guardrail-vendor-adapters.ts`
   (pure) builds each request and parses each reply into the ADR-0088 verdict, so ADR-0220's thresholds, merge and
   fail-closed rules apply as they are. Mappings: OpenAI, the highest `category_scores` value; Azure analyze (eight
   severity levels), the highest severity / 7; Prompt Shields, `userPromptAnalysis.attackDetected` as 1 or 0; Lakera,
   1 when any breakdown detector for the kind (`prompt_attack`, `pii/*`, `moderated_content/*`) has `detected: true`.
   Lakera's top-level `flagged` is never read, because a project in detect mode forces it to false.

3. **Strict parsing, overlapping windows, bare labels.** A reply missing the field the mapping reads is an error, never
   a 0. A Lakera policy that ran no detector for the requested kind is an error ("not run is not clean"). Text over a
   vendor's documented per-request limit (Azure 10,000 characters, OpenAI 100,000 by our bound, Lakera 256,000) is
   never cut: it is scanned in windows of that limit overlapping by 500 characters, so an attack split across a boundary
   is whole in one window. The windows are separate calls, in parallel under the detector's one time limit, each priced
   and audited (`detail.window`). The verdict is the highest window score, and any window failing fails the whole scan.
   More than 8 windows takes the failure path (fail closed). Reasons are vendor category names
   reduced to `^[a-z][a-z0-9_]{0,39}$`; nothing else from a reply survives, and error messages never quote the reply
   body.

4. **Guardrail kinds only, HTTPS only, key required.** A vendor adapter may claim only the guardrail kinds it serves,
   so the evaluation path (ADR-0088) never reaches a vendor. `allowPlaintextHttp` is refused. A vendor adapter cannot
   be registered or left without a key. Per-adapter options are a schema-validated document (`adapter_options`: the
   OpenAI model, the Lakera project id); any other key is refused.

5. **Guarded egress and the ADR-0062 mode floor.** Every vendor call rides the egress-guarded fetch built at
   resolution (allow-list, DNS pinning, per-request recheck). In addition, `REGULAIT_DEPLOY_MODE=air_gapped` refuses a
   vendor adapter at registration (403 `air_gapped`, audited), at enable, at the connection test and at every call,
   before any request, whatever the allow-list says. In a dispatch that refusal is a failed call, so it fails closed.

6. **SDKs where they are maintained (ADR-0176).** OpenAI goes through the official `openai` SDK at 6.49.0 (Apache-2.0,
   already pinned for `@regulait/model-provider`, released 2026-07-23), with `maxRetries: 0`, an explicit key and base
   URL, and the guarded fetch passed as its `fetch`. Azure and Lakera use plain HTTPS: `@azure-rest/ai-content-safety`
   (MIT) has had no stable release since 2025-02-12 (outside the maintenance window) and does not expose Prompt
   Shields; Lakera publishes no JavaScript SDK. Recorded in `apps/gateway/THIRD_PARTY.md`.

7. **Credentials stay in the secret store.** The key is stored as today (`key_ciphertext` under the data key) and sent
   as the vendor expects (`Authorization: Bearer` for OpenAI and Lakera, `Ocp-Apim-Subscription-Key` for Azure). It is
   never returned, logged or audited. Replacing the key of a vendor adapter re-arms the test gate (a different account),
   as does changing the adapter or its options.

8. **Off by default; enabling is a step-up.** A scorer is registered disabled. Enabling a vendor-adapter scorer is a
   relaxation under ADR-0180 (scanned text leaves for a third party), so it needs a `settings_relax` step-up bound to
   `externalScorers.<id>.enabled` and `.adapter`, and the audit row records it. Turning a detector on to use it is the
   unchanged ADR-0220 flow. The deployment is single-tenant (ADR-0220), so "per organisation" is this deployment's
   setting.

9. **Cost attribution on every call.** Each vendor call (guardrail input, guardrail output, connection test) writes a
   `usage_events` row: `object_type` `guardrail_scorer`, `provider` (openai, azure, lakera), `operation` (the kind),
   `cost_usd` from the scorer's new `price_per_call_usd` on success (null = unpriced, never invented; a failed call is
   recorded unpriced because whether the vendor billed it is unknown), and the calling user and project. Guardrail
   policy resolution now takes the caller's `userId` at the agent, connector, MCP proxy, MCP protocol and copilot
   enforcement sites. The project cost rollup already sums every object type; it gains a `byGuardrailScorer` breakdown.

10. **Audited, content-free.** Each call writes an `audit_log` row (`external_scorer`, `guardrail-vendor-call` or
    `guardrail-vendor-call-failed`) with the adapter, kind, source, score, error class and latency, never the text,
    the reply body or the key. A failure to write the spend or audit row fails the call (and so fails closed): a vendor
    call that cannot be recorded is not counted as a verdict.

11. **API and backend only.** The External scorers and project cost pages need the adapter selector, options, price
    field and the new breakdown; that UI need is posted on issue #453 for the Governed Designer.

## Design reference: Gravitee AI prompt guard rails (owner-approved scope, 2026-11-07)

`gravitee-io/gravitee-policy-ai-prompt-guard-rails` (Apache-2.0, a Java APIM plugin) was used as a **design reference
only**. No code is copied, and it is not a dependency (it cannot be one: it is a Java gateway plugin).

| Gravitee idea | Here |
|---|---|
| Detect, then act, with a configurable threshold | ADR-0220 detectors: a vendor verdict at or above the detector's threshold (default 0.5) is a finding, enforced at the detector's mode |
| Long input scanned in overlapping windows (500 characters, 50 overlap) | Decision 3: windows of the vendor's own limit, 500 characters of overlap, at most 8, fail closed beyond |
| Separate checks per label (toxicity, jailbreak), each with its own threshold | One detector per kind (`harm`, `prompt_injection`, `pii`), each with its own mode, threshold, scorer and timeout (ADR-0220) |

The differences the owner requires, and how they hold:

- **The default action is block, not Gravitee's `LOG_REQUEST`.** A newly enabled detector starts at mode `block`
  and fails closed (ADR-0220 defaults, ADR-0180). Moving it to `log` or `warn`, or to `heuristic` on failure, is a
  relaxation behind a `settings_relax` step-up, audited in the same transaction (ADR-0220 decision 6). Nothing in this
  ADR changes that.
- **No local classifier is added in this slice.** Every adapter here is a vendor API. A future local classifier must
  be a permissively licensed ONNX model on a Node ONNX runtime that works air-gapped (ADR-0176). Llama Prompt Guard is
  excluded (the Llama Community License is not on the ADR-0176 list). Gravitee's `detoxify-onnx` conversion was not
  used; anyone who proposes it must first verify the licence of the underlying unitaryai Detoxify weights and record
  it in `THIRD_PARTY.md`.

## Consequences

- An operator with an OpenAI, Azure or Lakera account can put that vendor on the ADR-0220 detectors without hosting a
  shim. The heuristic still runs; a vendor verdict only adds findings.
- Each enforced phase with a vendor detector adds a round trip to a third party and two inserts. Fail closed means a
  vendor outage refuses calls until an admin relaxes the detector.
- The scanned text goes to the vendor under the vendor's terms; the step-up and the air-gapped refusal are the
  controls, and the disclosure sentence (`VENDOR_ADAPTER_DISCLOSURE`) says so wherever the option is offered.

## Follow-ups

- AWS Bedrock `ApplyGuardrail` (SigV4) and Google Model Armor adapters.
- Azure Content Safety in disconnected containers for air-gapped sites (today refused with the other vendor adapters).
- Lakera `payload` spans for PII masking (today counts only).
- A local ONNX classifier, under the constraints in the Gravitee section above.
- The UI on #453.
