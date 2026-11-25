# Third-party components — the agentaudit engine image (`engines/agentaudit`)

Open-source components the agentaudit image ships (ADR-0176 admission rules: MIT, Apache-2.0, BSD or ISC, or a
public-domain dedication; maintained; pinned; works air-gapped). The Go closure is pinned by
`engines/agentaudit/driver/go.sum` and checked with `go mod verify` at build; facts were read from the v0.1.2 tag and
the module cache on 2026-11-17 (ADR-0355).

**Admission status: NOT ADMISSIBLE YET.** The image builds and passes its offline smoke scan (measured locally,
2026-11-17), but it is not published: no digest is recorded in `engines/images.lock.json`, and the image-level scan has
not run in CI (phase 2, ADR-0355 §6). The engine is not in the manifest yet, so it cannot be enabled.

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `github.com/manifold-security/agentaudit` | v0.1.2 (go.sum `h1:LbY3OEpv…XSoqE=`; tag commit `921d2198`, 2026-11-12) | Apache-2.0 (LICENSE and NOTICE shipped in `/opt/agentaudit/licences`) | The engine, linked into our driver as a library: reads a repository's Claude Code, Cursor and Codex configuration and reports capabilities (ADR-0355 §1). Single vendor, weeks old: the maintenance risk is recorded in ADR-0355. |
| `github.com/pelletier/go-toml/v2` | v2.4.3 | MIT | agentaudit's TOML parser (Codex config). |
| `gopkg.in/yaml.v3` | v3.0.1 | MIT and Apache-2.0 (its LICENSE carries both) | agentaudit's YAML parser (skill and command frontmatter). |
| Go toolchain from `golang:1.27-trixie` (build stage only) | digest `sha256:af1bfc26…c6ea80` (Go 1.27.3) | BSD-3-Clause | Builds the static driver; it does not ship. |
| Node.js base `node:22-trixie-slim` | digest `sha256:be1e2a3d…fb768c6` | MIT; Debian packages: various | The runtime base, for the phase-2 runner shim (as mcpscanner). npm, npx and corepack are removed. |

`gopkg.in/check.v1` appears in go.sum only as yaml.v3's test dependency; it is not linked (`go version -m` lists the
linked modules).

**Test fixtures.** `engines/agentaudit/fixtures/bad/agent-config.json` bundles four of agentaudit's own v0.1.2 test
fixtures (`testdata/malicious/claude-guardrail`, `claude-capability-surface`, `codex-unattended`,
`cursor-capability-surface`; Apache-2.0, Copyright 2026 Manifold Security, Inc.) with our additions for the
complementary rules. They are inert configuration text: nothing in them is run.
