<!-- fold: state-decisions -->
**ADR-0237 (builder, 2026-11-07): native adapters for third-party guardrail providers (PENDING P12(a)).** The
ADR-0088/0220 external-scorer shim gains `adapter` (pending migration `guardrail_vendor_adapters`, plus
`adapter_options` and `price_per_call_usd`): OpenAI Moderation (harm; official `openai` SDK 6.49.0), Azure AI Content
Safety (harm and Prompt Shields; plain HTTPS, the Azure SDK is unmaintained) and Lakera Guard (injection, PII, harm;
plain HTTPS, no JS SDK). Replies are parsed strictly into the ADR-0088 verdict, so the ADR-0220 trained detectors use
them unchanged and fail closed; long input is scanned in overlapping windows (Gravitee AI prompt guard rails as a
design reference only). Guardrail kinds only, HTTPS only, key required and never echoed; air-gapped refuses vendor
adapters everywhere; enabling one is a `settings_relax` step-up. Every call is a `usage_events` row
(`guardrail_scorer`, attributed to the caller and project; the project cost rollup gains `byGuardrailScorer`) and a
content-free audit row. UI on #453. Follow-ups: Bedrock ApplyGuardrail, Model Armor, Azure disconnected containers.
