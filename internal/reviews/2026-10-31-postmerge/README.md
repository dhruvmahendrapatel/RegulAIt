# Independent post-merge reviews — 2026-10-31

Owner-directed reviews of four Claude-built merges, under ADR-0227 and the new coordination board. Each review began from its ADR and merge delta, with the builder's report and previous comments withheld. Product source tested: `dd7efe56b0599104f747a6a04509642c85378b16`. Relevant slice implementations were checked against each exact PR head. Only coordination/review documents were edited.

## Verdicts

| PR | Exact reviewed head | Verdict | Findings |
| --- | --- | --- | --- |
| [#611](https://github.com/dhruvmahendrapatel/RegulAIt/pull/611) | `90c5d9617ed3e72b2ad864633d10a7d59a181768` | REQUEST CHANGES | C611-01 MEDIUM: the model setup assistant cannot satisfy required project attribution |
| [#629](https://github.com/dhruvmahendrapatel/RegulAIt/pull/629) | `30436d4d74a66092853dad674a5174db47fbd3ac` | REQUEST CHANGES | SUP-01 MEDIUM: stale settings overwrite reverses a tightening without step-up; SUP-02 MEDIUM: upload commits after grant revocation |
| [#630](https://github.com/dhruvmahendrapatel/RegulAIt/pull/630) | `65c5fe4d03db548ec4a29f7df0911da8353a22ff` | REQUEST CHANGES | A2A-SEC-01 MEDIUM: redirect diagnostic reflects the stored upstream credential; A2A-SEC-02 MEDIUM: remote decoded JSON is unbounded before SDK parsing |
| [#634](https://github.com/dhruvmahendrapatel/RegulAIt/pull/634) | `2c0f99429331e9298d2a55e0f8cf7a54799670a8` | REQUEST CHANGES | P7R-01 HIGH: scorer mutation bypasses detector step-up; P7R-02 MEDIUM: trained PII ignores the effective PII block floor |

Detailed findings, source locations, fixes, commands and limits: [#611](pr-611.md), [#629](pr-629.md), [#630](pr-630.md), [#634](pr-634.md). Seven findings total: one HIGH and six MEDIUM. These are post-merge findings, not unmerged release approvals. Fix lanes and releases remain the master's responsibility.

## Verification

- #611: shared 10 passed; gateway baseline 7 cases plus independent attribution regression, **8 passed**, with the probe explicitly asserting the broken default behavior and absence of an API workaround.
- #629: original gateway suite **20 passed**. A copied suite plus two new security assertions: **20 passed, 2 failed**, reproducing post-revoke insertion and stale re-enable. Separate bounded PostgreSQL/handler interleaving probe also reproduced the stale re-enable and empty relaxation audit.
- #630: original SDK/real-database integration suite **22 passed**. Credential non-disclosure regression: **21 passed, 1 failed**, with a separate count-only audit check confirming persistence. A bounded 2 MiB SDK/source probe demonstrates consumption before size checks; no exhaustion test or process-crash claim.
- #634: gateway **11 passed**, shared **21 passed**, Python **10 passed, 1 skipped** (optional dependency absent). Independent real-route/scorer probe reproduced both findings and exited zero.
- Database/shared packages rebuilt successfully before source-level tests. Each review used its own scratch database; no live/demo data was used.
- Full workspace build: **passed**, including gateway and frontend TypeScript compilation and frontend asset build. Command: `NODE_OPTIONS=--max-old-space-size=4096 /workspace/.setup/tools/pnpm/node_modules/.bin/pnpm -r --workspace-concurrency=2 build`; log `/tmp/postmerge-reviews-full-build.log`.
- Migration-watermark guard: passed against origin/main; no migration changed.
- ADR index: **6 tests passed**, using `node_modules/.bin/vitest run scripts/adr-index.test.mjs --maxWorkers=1`. Claude's coordination branch contains ADR-0227; this review did not author or edit ADRs or their index.
- No browser UI, real model weights, external providers, or deployed systems were tested. Documented deferred work is distinguished from the new findings in each report.

Raw probes and command logs are retained in the current environment under `/workspace/.setup/reviews/`, with A2A logs also under `/tmp/review-630-*`. They are not product tests and were not installed into product directories. The reports contain no real credentials.

## Delivery

Branch: `codex/postmerge-security-reviews`, based on Claude's `docs/agent-coordination-codex-gemini` commit `71fb7bf2d06b43777575df13f4bd1354cd985286` (whose product parent is the reviewed main).

The initial board check-in was pushed at `f33eeba2`. These reports and the findings handoff are published on the same branch. No product fix or merge was attempted.

PR verdict comments could not be posted: the environment proxy refuses CONNECT to `api.github.com` with HTTP 403. Git HTTPS fetch/push works. The owner was asked to allow that API domain; no token value was requested or exposed, and no alternative route was used to bypass policy. The exact-head verdict text above is saved for posting after access is available.

Reviewed by Codex and independent review contexts, separate from the builders.
