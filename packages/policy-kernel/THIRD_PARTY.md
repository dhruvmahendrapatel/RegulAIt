# Third-party components — `@regulait/policy-kernel`

Open-source components this package ships or uses in its tests (ADR-0176 admission rules: MIT, Apache-2.0, BSD or
ISC; maintained; pinned; works air-gapped). npm dependencies are pinned exactly through `pnpm-lock.yaml`.

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `@cedar-policy/cedar-wasm` (npm, github.com/cedar-policy/cedar, © Cedar Contributors) | `4.12.0` (exact) | Apache-2.0 | ADR-0040 — the Cedar engine behind `src/abac.ts` (`abacEngine`), loaded only through the `./abac` export so importing the kernel itself never loads WebAssembly. Evaluates in process; no sidecar, no runtime downloads, works air-gapped. Listed here when ADR-0188 S2 gave this package its first `THIRD_PARTY.md`. |
| `fast-check` (npm, github.com/dubzzz/fast-check, © Nicolas Dubien) | `4.10.2` (exact devDependency; released 2026-09-19) | MIT | ADR-0188 S2 — property tests P1–P7 of the actor intersection (`src/actor-properties.test.ts`): generated grant sets, delegation scopes and chains, each run under a fixed seed so a failure reproduces exactly. Test-only: never in a shipped bundle. Checked 2026-10-10: MIT, releases through September 2026 (4.8.0 → 4.10.2), no npm advisory for this version, one runtime dependency (`pure-rand`). No network at runtime. |
| `pure-rand` (npm, github.com/dubzzz/pure-rand, © Nicolas Dubien) | `8.4.2` (exact, via `fast-check`; released 2026-07-10) | MIT | The seeded pseudo-random generators `fast-check` draws from. No dependencies, no install script, no advisory. Test-only. |
