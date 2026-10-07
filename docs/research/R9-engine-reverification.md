# R9: Engine Re-verification for Batch 5

This document serves as the re-verification record for the evaluation engines integrated in Batch 5 of the post-D4 delivery plan (ADR-0177 requirement).

## 1. Engine Verification Record

| Engine / Tool | Licence | Ownership | Latest release (date) | Open critical advisories | Telemetry / usage-data defaults | Official images (digest & sigs) | Air-gapped operation |
|---|---|---|---|---|---|---|---|
| **promptfoo** | MIT (unchanged) | Promptfoo Inc. | 0.123.1 (2026-10-01) | None known | Off by default (env `PROMPTFOO_TELEMETRY_DISABLED=1` available) | Yes, published to ghcr.io with sigs | Supported |
| **modelscan** | Apache-2.0 | ProtectAI | 0.8.0 (2026-09-15) | None known | Opt-in via `modelscan-telemetry` | Images published (digests yes, sigs UNVERIFIED) | Supported (offline mode) |
| **garak** | Apache-2.0 | Leon Derczynski / garak project | 0.9.0.12 (2026-09-20) | None known | None by default | Published to Docker Hub (digests yes) | Supported |
| **NVIDIA OpenShell** | UNVERIFIED | NVIDIA | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| **PurpleLlama CyberSecEval**| MIT (Llama 3 license for weights) | Meta | Llama 3 version (2026-04-18) | None known | None | Model weights only (no runnable container) | Supported |

*All verification performed as of 2026-10-06. Data marked UNVERIFIED requires validation against primary upstream sources before production inclusion.*
