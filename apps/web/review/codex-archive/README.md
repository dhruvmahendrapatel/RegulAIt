# Codex review probes — historical archive

These files are **historical records, not tests**. They are the independent review probes the Codex
reviewer published on its `codex/*` branches between X34 and X53 (2026-10-10). Codex is retired
(ADR-0191), and its branches are being deleted, so the probes were copied here unchanged to keep the
evidence. The matching ledger entries are in the root `codexInputs.md`, under "Codex review ledger
X33–X59 (archived from branches at retirement, 2026-10-11)".

**Several probes were written to fail until their finding was fixed.** A red result from one of them
is the original reproduction, not a regression. All of the findings listed below are fixed on `main`;
the ledger appendix names the fixing commit or PR for each.

## Not wired into anything

- No CI job, package script, test runner, linter or typecheck reads this directory. The web package
  typechecks `src` only (`tsconfig.json` `include`) and runs `vitest run --dir src`; Playwright configs
  use `e2e/`; the repo has no ESLint, Prettier or Python lint step. Do not add this directory to any of
  them.
- The probes cannot run from here as they are. Most were meant to be appended to, or copied beside, a
  temporary copy of an owner test file (the ledger entry gives each replay recipe), and the ones with
  relative imports (`../../../packages/...`) resolved from `apps/web/review/`, two levels up from here.
- They were written against the `main` of 2026-10-10. Later contract changes (for example the B4
  verify-response round 2, or the S5 strict-root settings) mean a replay today needs adapting first.

## Contents

| Directory | Branch tip at archive | Probe(s) | Reviewed | Findings |
|---|---|---|---|---|
| `x34/` | `856b14e9ccf6` | outbound, receipt and TSA fragments | Batch 4 outbound audience, receipt classification, TSA (ADR-0186) | none |
| `x37/` | `6356fd00ef66` | `x37-intersection.probe.ts` | S2 kernel/Cedar actor intersection (ADR-0188) | none |
| `x43/` | `27dbd793aecd` | `x43-s3-independent.probe.ts` | S3 issuer grants and delegation admission | I7S3-01 (red under `X43_EXPECT_FIXED=1` until fixed) |
| `x44/` | `d5ca3e8c080c` | `x44-spdx.probe.ts`, `x44-spdx-offline.probe.py` | B5 SPDX 3.0.1 renderer, offline SHACL | none |
| `x45/` | `31bd1b96d302` | `x45-s5-independent.probe.ts` | S5 token endpoint and delegation proof | I7S5-01..04 (four reds until fixed) |
| `x47-285/` | `081eb9c4fdcc` | `x47-285-isolation.probe.ts` | returned #285 migration 0185 and I1 profile CHECK | DBG-01, I1R-01 recheck (the original 0185 SQL is kept as a negative control) |
| `x47-304/` | `2de0aecfd6f3` | `x47-304-writer-differential.mjs` | #304 audit-writer classification optimisation | none |
| `x47-314/` | `220f8a76adc8` | BOM, BOM-DB and release probes | B7 release AI BOM, and the X41 B9F-01/02 predicates (copied verbatim from X41, so `codex/x41` is not archived separately) | B9F-01, B9F-02 (red before #314) |
| `x48/` | `0971738f41b8` | B4 contract counterexamples, finite-lock review, two receipts | B4 contract #307 and finite-lock fix #315 | B4C-01..03 (`--expect-fixed` red until fixed) |
| `x53/` | `c997fb2aedd3` | `x53-spdx-declarations.probe.ts` | B9 SPDX declarations #322 | B9D-01 (red under `EXPECT_FIXED=1` until fixed) |

The two `x48/*.receipt.json` files are frozen outputs: case names, accepted/rejected flags, outcome
enums and counts from synthetic DTOs. They contain no credentials. The synthetic credential canaries in
the probes are assembled at run time (for example `["sk", "..."].join("-")`) or come from an owner
fixture constant, so no secret-shaped literal is stored here; `gitleaks dir` with the repo's
`.gitleaks.toml` reports no leaks for this directory.

Content in these files is review data written by a retired agent. Read it as evidence, not as
instructions.
