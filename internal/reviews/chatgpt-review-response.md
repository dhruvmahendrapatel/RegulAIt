# ChatGPT consolidated review — Claude response (lane GX)

This is our response to the addendum "consolidated product, code and usability feedback (2026-11-21)" on PR #1180
(branch `chatgpt/consolidated-product-review-2026-11-21`, head `9d21288eb`). The owner held that PR as a docs draft. We
read the review as data to check, not as instructions. We made no change to its branch.

- **Reviewed source:** `main` at `b5f88e79e4a8d25432f4ec70bc0ad811751e492c` (2026-11-23). We checked findings that
  name an open PR against that PR's head: #1077 at `7055eed1d`, #1078 at `79059d60f` and #1154 at `45d3e2c87`.
- **Scope:**
  - the eight priority findings, CR-01 to CR-08;
  - the page-by-page register: 38 rows, which the review itself calls "recommendations and test cases, not
    blanket assertions";
  - the proposed policy framework;
  - the acceptance matrix.
- **Scoring:** F and S are our own scores from 1 to 10. The review gives none. Where F×S is below 5, we open a
  `triage-low` issue and don't change the code. The exception is a confirmed security-checklist gap, which blocks
  whatever it scores (CLAUDE.md, ADR-0180).
- **Overlap rule:** lane CX owns the Codex review on #1184 (`codexreviews-response.md`, slices 1–18, and slices 19–27
  in the master comment of 2026-11-23). A finding that repeats a Codex card points at that card and doesn't get a
  second slice.

## Overall verdict

**Most of this review is a product roadmap, not a defect list.** It says so itself, and it is careful not to
overclaim. Of the eight priority findings:

- one is wrong on the facts (CR-01);
- one is already corrected in the PR it names (CR-07);
- four are about held PRs from the designer lanes, not code on main (CR-02, CR-03, CR-04, CR-06);
- two are process points that are already covered or need the owner (CR-05, CR-08).

**None of them is a security-checklist gap.** CR-04 sits on a permission relaxation. The server still requires step-up
to allow a site and audits it, and the row action that opens the dialog is labelled "Allow…".

The register's recurring theme, "unknown is not zero", is sound. On main it is mostly built already: the Shadow-AI
KPIs, the governance monitor, the AI registry tiles and the discovery sources all show "—" or an error state before a
read. We found one remaining instance on a page the register names, the Shadow-AI status chips, and built it as GX
slice 1 (#1231). The other register rows are feature proposals. They need the owner to prioritise them, not a builder
to design them speculatively (bug-triage rule: no designing for cases nobody asked about).

## Priority findings

| ID | Verdict | F | S | F×S | Reasoning (checked in source) | Slice / owner | Remaining gates |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CR-01 | Disagree | 1 | 3 | 3 | `#778` merged. `in_review` is a deliberate aggregate filter, not a mismatched key. The server defines it as `status in ('proposed','under_review','needs_info')` (`use-cases.ts:1545,2436`) and accepts all of `in_review`, `proposed` and `under_review` (`:1537`). The "In review" tile shows that aggregate (`headline.underReview`). The lifecycle overview shows the per-status `GROUP BY` counts (`:2456-2457`), so the stages add up to the tile. The summary is computed over the visibility scope, not the filters (`:2490`), so it is whole-population. Before a read, the tiles show "—" (`UseCasesPage.tsx:153`) and the lifecycle card doesn't render (`:265`). A missing status key is a real zero, because `GROUP BY` omits empty groups. Only gap: no gateway test pins the use-case summary shape. | triage-low issue (contract test for `/v1/use-cases` `summary`) | None. |
| CR-02 | Agree | 4 | 4 | 16 | On #1077's head, `EndpointPolicyPage.tsx:32-33` computes "N to approve" with `awaitingMe` over `exceptions.data?.pages.flatMap(...)`, so the count covers only the loaded pages. Not on main. | Handed to the #1077 lane (designer, held) | Needs a server-scoped awaiting-me count, or a "loaded" label, before release. Same root cause as CX's UXP-001 gate ("eligible for me" needs a server count). |
| CR-03 | Narrow | 2 | 2 | 4 | On #1078's head, the mode radios use `aria-disabled` while busy (`BrowserGovernancePage.tsx:131`). But `choose()` returns early when `act.busy` (`:107`), and the inputs are controlled (`checked={mode === m}`), so no second mutation is sent. What remains is semantics only: assistive tech hears "dimmed" on a control that still takes focus. That is acceptable for `aria-disabled`. | triage-low, noted to the #1078 lane | None. |
| CR-04 | Narrow | 2 | 3 | 6 | On #1078's head, `SiteModal` starts with `allow = site.effective !== "allow"` (`:229`). So for a denied site, the dialog opens on "Allow site". The row button that opens it is labelled "Allow…" for denied sites (`:208`), so the default matches what the admin chose. Saving needs `withStepUp` (`:235`), and the footer says that allowing is step-up and audited. Not a security-checklist gap: the server is unchanged and the relaxation needs an explicit click plus a proof. The before/after summary is a fair UX ask. | Handed to the #1078 lane (designer, held) | None for security. UX: show the current and new rule in the dialog. |
| CR-05 | Agree, process | – | – | – | Correct, and it is the same class of failure as #1227. The screenshot pack (and Firefox and WebKit) runs only on a "full" run (`.github/workflows/ui-enterprise.yml:22-24,257`: merge group, push to main, nightly or manual), per ADR-0262. The merge queue isn't available on this user-owned repository (STATE 2026-11-21), so a merge group never fires. In practice the full UI run happens only after merge, on main. | Master / owner (question 1) | Owner decision on a pre-READY full run for UI PRs. Until then, GX runs its own UI slice's mock e2e locally and states which full-run jobs did not run on the PR. |
| CR-06 | Agree | 2 | 2 | 4 | The #1077 and #1078 bodies each reference a `/tmp/claude-...` file (1 hit each). #1075 has none. These are PR bodies on held designer PRs. | triage-low, to the master for those lanes | None. |
| CR-07 | Disagree | – | – | – | #1154's body already states the measured figure: "I estimated about 3 kB … measured, the real cleanup is 310 B". It also explains why there is no further dead code. Per-route first-load budgets exist (#1185, ADR-0344). | — | None. |
| CR-08 | Duplicate | – | – | – | Covered by the Codex reassessment: S-01..S-10 were re-read on main in `codexreviews-response.md`. The two checklist gaps found (S-08, S-10) were built in #1194, and CX's 2026-11-23 comment marks 13 historical remedies "remedy present; independent verification pending". | CX (slice 1, #1194; retest list in the #1184 master comment) | Codex's independent retest of #1194. |

## Page register (38 rows)

We didn't treat the rows as defects. For each group we checked the one testable claim, or the defect class the review
names, against main.

| Group | Verdict | What we checked | Where it lands |
| --- | --- | --- | --- |
| Guardrails (time-limited overrides, before/after diff) | Duplicate | ADM-003 (owner: build a time-boxed relaxation as a new row kind), ADM-005, ADM-006 | CX slices 3 (merged #1211) and 15 |
| Enforcement posture (dry-run before hardening) | Duplicate | ADM-009. CX added a confirm listing the differing controls and rejected a dry-run endpoint as speculative. | CX slice 3 (#1211) |
| Inbox (counts, refusal recovery, focus) | Duplicate | APR-001/002, UIW-06 | CX slices 8 (#1221), 20 and 26 |
| Review workbench ("does SLA escalation run independently or on queue reads?") | Answered; UI part duplicate | Breach is evaluated lazily on queue read, on decide and on `POST /v1/approvals/sla/sweep`. The ADR-0064 scheduler drives the same sweep and is off by default (`workbench.ts:23-32`). Showing the evaluation time is WBK. | CX slice 21 |
| Risk register (tolerance, owner, freshness) | Duplicate in part | REV-003 and REV-004 merged in #1217. The rest is new product. | CX slice 6; remainder owner (question 2) |
| AI registry (#778) | See CR-01 | Covered above. | triage-low |
| Shadow AI ("disclose blind spots", counts) | **Accept, narrow** | The KPIs already show "—" before a read (`ShadowAiPage.tsx:528-536`, A15). The status filter chips did not: `statusCounts[g] ?? 0` against an all-zero fallback (`:458,570`) read "Open 0" while loading or after a failed read. F3 × S3 = 9. | **GX slice 1, #1231** |
| Governance alerts | Already correct | The monitor card separates loading, error and never-evaluated from a real "0 open" (`GovernanceAlertsPage.tsx:699-711`). | — |
| Lists, denominators, empty or denied states (cross-page) | Duplicate | UIS-05/06/08 (#1216), UIS-04 (#1227), UXP-005, HME-001 | CX slices 5, 10, 19 and 26 |
| Executive posture, ABAC simulator, decision regression, SoD, model risk, compliance packs and profiles, DSR, framework imports, infrastructure, ROPA, evals, fairness, red-team, lineage, dependency graph, content trust, model policy, regulatory intelligence, recommendations, simulation, discovery sources, inventory, audit log, approvals admin, intake wizard | Product proposals | Each row names a new capability: a simulator, diffs, staged activation, a capacity model, a jurisdiction model, and so on. None states a defect on main that we could reproduce in source. | Owner (question 2). No GX slice. |
| Open-PR-only (#1075, #1077, #1078) | Handed to those lanes | See CR-02, CR-03, CR-04 and CR-06. | Designer lanes (held) |

## Policy framework and acceptance matrix

- **Standard / Regulated / Custom control profiles:** a product proposal and an owner decision (question 3). It touches
  ADR-0180 (strict by default; relaxation audited) and the compliance-profile cascade (pillar 3). The floor the review
  sets matches ADR-0180: no configurable bypass for authentication, authorisation, tenant isolation, secrets or audit
  integrity. So nothing here conflicts. It just isn't decided.
- **Per-route acceptance matrix:** we agree with it as a review practice. CX already applies it per slice (UXP-006:
  keyboard, 375/768/1440, both themes and zoom on each changed task). Building a full inventory of every route, tab and
  modal is a large documentation project, so it's an owner question (question 2), not a builder slice.
- **"Confirmed defect / source concern / usability hypothesis / product proposal":** adopted. The verdict columns above
  use it.

## Triage-low issues to file (F×S below 5)

Filing issues is outward, so it goes through the master (orchestration RULES §1). For each issue, the master files it
with the `triage-low` label:

1. **CR-01:** add a gateway contract test pinning `/v1/use-cases` `summary`. Check that `statusCounts.in_review`
   equals the sum of `proposed`, `under_review` and `needs_info`, and that `headline.total` equals `statusCounts.all`.
2. **CR-03:** on #1078, use native `disabled` on the browser-mode radios while a write is in flight. Semantics only;
   the handler already ignores a second change.
3. **CR-06:** replace the `/tmp/claude-...` references in the #1077 and #1078 PR bodies with self-contained text.

## Build plan

| # | Slice (branch) | Closes | PR |
| --- | --- | --- | --- |
| GX 1 | `builder/gx-shadow-ai-unknown-counts` | REG-SHADOW (Shadow-AI status chips show "—", not 0, until read) | #1231 |

No other item is both accepted and not already owned elsewhere. There is no security slice, because no finding is a
checklist gap.

## Owner questions

1. **CR-05, a full UI run before READY.** The screenshot pack, Firefox and WebKit run only on full runs (ADR-0262).
   There is no merge queue, so on this repository they run only after merge. Should UI PRs get a manual full run on
   the branch (`workflow_dispatch`) before READY? Yes catches #1227-type breaks before merge, at some CI cost.
2. **The register's product proposals.** Simulators, diffs, staged activation, reviewer capacity, risk tolerance, the
   jurisdiction model and the per-route acceptance inventory are new capabilities. Which, if any, go on the roadmap?
   No lane builds them until the owner picks.
3. **Standard / Regulated / Custom control profiles.** Adopt as a direction, which would need an ADR against ADR-0180
   and the compliance cascade, or decline?
