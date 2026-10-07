# R7: Open Source Register

This document serves as the consolidated open-source register for RegulAIt, compiled from ADR-0177 §2, its clean-room amendment, the ADR-0183/0184 CI tools, and the `THIRD_PARTY.md` manifests.

## 1. Open Source Projects and Libraries

| Project or library | Purpose | Licence (verified, date) | Use mode (A–E per ADR-0177) | Status (in use / next / soon / later / never) | Decision record | Re-check by |
|---|---|---|---|---|---|---|
| `promptfoo` | Prompt evaluation framework | MIT (2026-10-06) | C (Vendored data / mappings) | in use | ADR-0177 | 2026-11-06 |
| `modelscan` | LLM vulnerability scanner | Apache-2.0 (2026-10-06) | B (Sidecar process) | next (Batch 5) | ADR-0183 | 2026-11-06 |
| `garak` | Generative AI Red-teaming & Assessment Kit | Apache-2.0 (2026-10-06) | B (Sidecar process) | next (Batch 5) | ADR-0183 | 2026-11-06 |
| `gitleaks` | Secret scanning in CI and credential rules | MIT (2026-10-06) | C (Vendored patterns) / A (CI) | in use | ADR-0184 | 2026-11-06 |
| `Trivy` | Container image scanning & CycloneDX SBOMs | Apache-2.0 (2026-10-06) | A (CI) | in use | ADR-0184 | 2026-11-06 |
| `cosign` (Sigstore) | Keyless signing & verification of CI image | Apache-2.0 (2026-10-06) | A (CI) | in use | ADR-0184 | 2026-11-06 |
| CNCF Distribution (Registry) | Throwaway local registry in CI | Apache-2.0 (2026-10-06) | A (CI) | in use | ADR-0184 | 2026-11-06 |
| CodeQL (CLI & Action) | SAST scanning for JS/TS | GitHub/MIT (2026-10-06) | A (CI) | in use | ADR-0184 | 2026-11-06 |
| SeaweedFS | CI dev object store | Apache-2.0 (2026-10-06) | A (CI dev) | in use | ADR-0183 | 2026-11-06 |
| `otpauth` | OTP/MFA logic | MIT (2026-10-06) | E (Library) | in use | ADR-0183 | 2026-11-06 |
| `pkijs` | Passkey cryptography | BSD-3-Clause (UNVERIFIED) | E (Library) | next | ADR-0177 amend | 2026-11-06 |
| `@simplewebauthn/server` | WebAuthn verification | MIT (UNVERIFIED) | E (Library) | next | ADR-0177 amend | 2026-11-06 |
| `@opentelemetry/sdk-metrics` | Metrics provider | Apache-2.0 (2026-10-06) | E (Library) | in use | ADR-0185 | 2026-11-06 |
| `@opentelemetry/exporter-prometheus`| Metrics exporter | Apache-2.0 (2026-10-06) | E (Library) | in use | ADR-0185 | 2026-11-06 |
| `prom-client` | Operational metrics | Apache-2.0 (2026-10-06) | E (Library) | never | ADR-0185 | n/a |
| `@opentelemetry/semantic-conventions` | GenAI/MCP OTel attributes | Apache-2.0 (2026-10-06) | E (Library) | in use | THIRD_PARTY | 2026-11-06 |
| `@arizeai/openinference-genai` | OpenInference trace mapping | Apache-2.0 (2026-10-06) | E (Library) | in use | THIRD_PARTY | 2026-11-06 |
| `@arizeai/openinference-semantic-conventions`| Vocabulary & span-kind | Apache-2.0 (2026-10-06) | E (Library) | in use | THIRD_PARTY | 2026-11-06 |
| `@modelcontextprotocol/sdk` | MCP upstream protocol SDK | MIT (2026-10-06) | E (Library) | in use | ADR-0185 | 2026-11-06 |
| `simple-statistics` | Evaluator panels math | ISC (2026-10-06) | E (Library) | in use | THIRD_PARTY | 2026-11-06 |
| `csv-stringify` | Safe CSV formatting | MIT (2026-10-06) | E (Library) | in use | THIRD_PARTY | 2026-11-06 |
| `busted` / `luassert` & test deps | Kong CI integration tests | MIT/X11 (2026-10-06) | A (CI) | in use | THIRD_PARTY | 2026-11-06 |
