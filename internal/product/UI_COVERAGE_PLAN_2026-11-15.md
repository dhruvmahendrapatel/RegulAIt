# UI coverage plan, 2026-11-15 (lane UI-D)

Owner direction (2026-11-15): pilot in about two weeks, with a screen for every feature and the pilot screens first.
This file lists what has no screen yet, which of those the pilot demo touches, and who builds each one. Lane UI-D
writes and owns this file. Lanes UI-B (designer refresh and HOLD slices) and UI-C (KNOWN_UI_GAPS cards) own their
own PRs. This file does not change their scope.

Baseline: `main` at `26d16126` (#836). The route census (`scripts/preflight-ui-route-census.mjs`) holds every gateway
route to "called by the SPA, or on a reasoned list". So the routes with no screen are exactly `KNOWN_UI_GAPS`: 48
entries, `KNOWN_UI_GAPS_MAX = 48`. Three more are arriving with #848 (lane E2). The other "no screen" items below are
pilot capabilities whose screen exists only in part, or whose API is still being built.

## 1. KNOWN_UI_GAPS on main (48), by group

| Group | Routes | Pilot beat | Claimed by | PR / branch |
|---|---|---|---|---|
| Usage-count mapping (ADR-0241, P21) | 7 (`/v1/usage-extractors*`, `/v1/agents/:agentId/usage-extractor/*`) | Cost (attribution accuracy), indirect | UI-B | #744 `designer/p21-usage-extractor` (HOLD) |
| MCP definition pins, high-risk tooling, authorised targets (ADR-0246, P27) | 9 | Coding-tool policy (MCP servers), indirect | UI-C | #823 `builder/ui-gaps-mcp-pinning` |
| MCP bundles (ADR-0236, P11) | 11 | Coding-tool policy: per-user MCP allow-lists | UI-C | #815 `builder/ui-gaps-mcp-bundles` |
| Third-party evidence ingest, DefenseClaw (ADR-0261, P37) | 6 | Discovery / audit, indirect | UI-C | #829 `builder/ui-gaps-defenseclaw-ingest` |
| SIEM destinations (ADR-0303, P18 C6) | 5 (`/v1/siem/destinations*`) | Audit trail: "the audit chain reaches your SIEM" | **UI-D (unclaimed)** | `builder/ui-d-siem-destinations` (after the pilot screens) |
| Connector catalogue (ADR-0255, P31) | 2 | None | UI-C (decided on #753) | not opened yet |
| Per-asset posture scores (ADR-0214 amendment, P3) | 2 | None | UI-C | #831 `builder/ui-gaps-posture-assets` |
| Upstream token exchange (ADR-0238, P12(d)) | 6 | None | UI-C | #837 `builder/ui-gaps-token-exchange` |

Total: 7 + 9 + 11 + 6 + 5 + 2 + 2 + 6 = 48. The only group nobody had claimed is SIEM destinations.

## 2. Routes in flight in other lanes

| Lane | PR | Routes | Pilot beat | Screen by |
|---|---|---|---|---|
| E2, cost per outcome (ADR-0312) | #848 | `GET /v1/cost-outcomes`, `GET /v1/cost-outcomes/summary`, `POST /v1/cost-outcomes/refresh` (added to KNOWN_UI_GAPS, cap 48 → 51) | Cost per outcome | **UI-D**, built against #848's contract, lands after #848 |
| E7, vendor usage connectors (ADR-0322) | #845 | none yet (ADR only, slice 1) | Cost across tools (seat tools and vendor APIs) | **UI-D**, once a routes slice opens |
| E1, managed settings | no branch yet | none yet | Coding-tool policy: managed settings export, drift | **UI-D**, built against E1's contract once its PR is open |

## 3. Pilot beats: what exists, and what is missing

| Beat | Existing screens | Missing for the pilot | UI-D slice |
|---|---|---|---|
| Coding-tool policy | `/admin/client-access` (interception posture, scope rules, per-client config generator, coverage matrix); `EndpointMcpServersCard` on discovery sources; `/admin/mcp-servers`, `/admin/admission` | A per-user, per-tool allow-list (assistants such as the IDE copilots, AI editors and CLI coding agents, plus MCP servers); export or push of a managed-settings file; drift between intended and reported settings. No API yet: today's scope rules override three compat fields only. MCP allow-lists come from bundles (UI-C #815). | **D1** `builder/ui-d-coding-tool-policy`: a policy view that reads the existing interception and endpoint routes now, with export and drift panels wired to E1's contract when it opens |
| Cost dashboard | `/spend`, `/admin/cost`, `/admin/cost-consolidation/*`, `/admin/spend-monitor`, `/admin/billing`, `/admin/optimization` | Cost per outcome (no screen; API in #848). Budgets and alerts in one place: budgets are fields on projects and virtual keys, and alerts are spend anomalies, each on a different page. | **D2** `builder/ui-d-cost-outcomes` (after #848); **D3** `builder/ui-d-budgets-alerts` (existing routes: projects, virtual keys, `/v1/spend/anomalies`, `/v1/spend/monitor-policies`) |
| Governed Azure DevOps workflow | `/runs`, `/runs/:runId`, `/workflows`, `/workflows/:instanceId`, `PmLinksCard`, `DecisionLedgerCard`, setup pages for PM and git connections, templates and approvals | One view of the whole chain: the Boards item, plan sign-off, agent build, the Repos PR, checks, and merge approval. Today these are spread across the run and workflow detail pages. | **D4** `builder/ui-d-change-timeline`: a stage timeline for one workflow instance, made from existing workflow, run, PM-link and decision reads. New files only; it links from the detail pages. |
| Shadow-AI discovery | `/admin/shadow-ai`, remediation panel, `/admin/shadow-ai/discovery-sources/*` | Mostly done. Missing: a coding-tool filter or preset on findings, and checking the demo seed for coding-tool signatures. | **D5** `builder/ui-d-discovery-coding-tools` (small, filter only) |
| Audit trail | `/admin/audit`, `/audit` (auditor portal), `/admin/lineage`, `/admin/traces` | Saved filters for the pilot's events (policy change, managed-settings drift, budget breach); SIEM delivery has no screen. | SIEM in **D6**; the filters ship with D1 and D3, where the events come from |

## 4. UI-D claims and order

One open PR at a time, each a draft from `origin/main`:

1. **D0**: this plan (docs only).
2. **D4**: governed change timeline (existing APIs; the pilot's core story).
3. **D3**: budgets and alerts (existing APIs).
4. **D1**: coding-tool policy view (existing APIs first; E1 panels when E1's contract is published).
5. **D2**: cost per outcome (after #848 merges; closes its 3 gaps and lowers the cap).
6. **D5**: discovery coding-tool filter.
7. **D6**: SIEM destinations (closes 5 KNOWN_UI_GAPS, lowers the cap by 5).
8. Then the E7 vendor-usage screens, once E7 publishes routes. Then whatever this file still lists as unclaimed.

Files UI-D will not edit: anything changed by #744, #815, #823, #829, #831, #837, or the HOLD `designer/*` PRs (#642,
#654, #680, #691). Where a slice needs a nav entry or a route line in `apps/web/src/App.tsx` or
`apps/web/src/shell/suites.tsx`, which are shared, the change is one line, and the PR body says so.

## 5. Rules every UI-D slice follows

- DESIGN_GUIDELINES.md in full: the kit first (`QueryGate`, `Table`/`DataList`, `RowActions`, `RefusalNotice`,
  `DetailDrawer`), tokens only, en-GB dates, sentence case, no vendor or model names in copy.
- States: a skeleton while loading, an error with Retry on failure, never a zero while loading.
- Lazy section chunks; the bundle ceilings are checked on the combined tree (M-104, M-112).
- Paginated lists, debounced filters, axe clean in light and dark.
- Secure by default: no raw HTML, CSRF header through the API client, nothing in local storage but per-viewer
  conveniences, and no permissive pre-selection.
