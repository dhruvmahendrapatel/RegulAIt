# Third-party runtime dependencies added deliberately

One line per dependency added under the owner's direction (2026-10-05) to prefer proven, permissively
licensed open source over hand-written code for standard problems. Each works offline (no runtime
network calls), so an air-gapped deployment is unaffected.

| Package | Version | Licence | Why |
|---|---|---|---|
| `standardwebhooks` | 1.1.1 | MIT | Signs outbound webhooks per the Standard Webhooks specification (`webhook-id`, `webhook-timestamp`, `webhook-signature`, `whsec_` secrets), so receivers verify with any off-the-shelf library (ADR-0173 batch 2b). Its transitive dependencies are `@stablelib/base64` 1.0.1 (MIT) and `fast-sha256` 1.3.0 (Unlicense, a public-domain dedication). |
| `diff` | 9.0.0 | BSD-3-Clause | Line diff of two prompt-registry commits' templates (ADR-0173 batch 2b). No dependencies. |
