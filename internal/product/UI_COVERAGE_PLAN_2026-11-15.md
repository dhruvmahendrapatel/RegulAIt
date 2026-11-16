# UI coverage plan, 2026-11-15 (lane UI-D)

Owner direction (2026-11-15): the pilot is in about two weeks. Every feature gets a screen, and the pilot screens come
first. This file lists what has no screen yet, which of those the pilot demo touches, and who builds each one. Lane UI-D
writes and owns this file. Lanes UI-B (designer refresh and HOLD slices) and UI-C (KNOWN_UI_GAPS cards) own their own PRs;
nothing here changes their scope.

**Baseline:** `main` at `8d1735ed` (#725). The route census (`scripts/preflight-ui-route-census.mjs`) holds every gateway
route to one rule: the SPA calls it, or it is on a reasoned list. So the routes with no screen are exactly
`KNOWN_UI_GAPS`: 52 entries, with `KNOWN_UI_GAPS_MAX = 52` (§1). Pilot-beat lanes have 15 more in flight (§2). The other
items below are pilot capabilities whose screen exists only in part (§3).

## 1. KNOWN_UI_GAPS on main (52), by group

| Group | Routes | Pilot beat | Claimed by | PR / branch |
|---|---|---|---|---|
| Usage-count mapping (ADR-0241, P21) | 7 (`/v1/usage-extractors*`, `/v1/agents/:agentId/usage-extractor/*`) | Cost (attribution accuracy), indirect | UI-B | #744 `designer/p21-usage-extractor` (HOLD) |
| MCP definition pins, high-risk tooling, authorised targets (ADR-0246, P27) | 9 | Coding-tool policy (MCP servers), indirect | UI-C | #823 `builder/ui-gaps-mcp-pinning` |
| MCP bundles (ADR-0236, P11) | 11 (10 bundle routes plus `PUT /v1/mcp-tools/:toolId/dangerous`) | Coding-tool policy: per-user MCP allow-lists | UI-C | #815 `builder/ui-gaps-mcp-bundles` |
| MCP catalogue (ADR-0256, P32) | 4 (`GET /v1/mcp-catalogue`, `POST /v1/mcp-catalogue/presets/:preset`, `POST /v1/mcp-catalogue/bundles`, `GET /v1/mcp-catalogue/bundle`) | Coding-tool policy: which MCP servers can be admitted | **UI-D (unclaimed until now)** | D7 `builder/ui-d-mcp-catalogue` |
| Third-party evidence ingest, DefenseClaw (ADR-0261, P37) | 6 | Discovery and audit, indirect | UI-C | #829 `builder/ui-gaps-defenseclaw-ingest` |
| SIEM destinations (ADR-0303, P18 C6) | 5 (`/v1/siem/destinations*`) | Audit trail: "the audit chain reaches your SIEM" | **UI-D (unclaimed until now)** | D6 `builder/ui-d-siem-destinations` |
| Connector catalogue (ADR-0255, P31) | 2 | None | UI-C (decided on #753) | not opened yet |
| Per-asset posture scores (ADR-0214 amendment, P3) | 2 | None | UI-C | #831 `builder/ui-gaps-posture-assets` |
| Upstream token exchange (ADR-0238, P12(d)) | 6 | None | UI-C | #837 `builder/ui-gaps-token-exchange` |

Total: 7 + 9 + 11 + 4 + 6 + 5 + 2 + 2 + 6 = 52. Before this plan, nobody had claimed the MCP catalogue or SIEM groups.

## 2. Gaps in flight in pilot-beat lanes (15)

Each count is read from the PR's own `KNOWN_UI_GAPS` diff.

| Lane | PR | Routes it adds to `KNOWN_UI_GAPS` | Pilot beat | Screen by |
|---|---|---|---|---|
| E2, cost per outcome (decision record in #848) | #848 | 7: `GET /v1/cost-outcomes`, `GET /v1/cost-outcomes/summary`, `POST /v1/cost-outcomes/refresh`; and per-user budgets `GET /v1/user-spend-budgets`, `GET`/`PUT`/`DELETE /v1/users/:userId/spend-budget` | Cost per outcome; cost per user and budget alerts | **UI-D**: D2 takes the 3 outcome routes, D3 the 4 user-budget routes. Both build against #848 and land after it. |
| E1, managed settings (decision record in #850) | #850 | 3: `POST /v1/managed-settings/bundles`, `GET /v1/managed-settings/bundles`, `GET /v1/managed-settings/bundles/:id/archive` | Coding-tool policy: managed-settings export | **UI-D**: D1 builds against #850 and lands after it |
| E3, agent registry import (decision record in #855) | #855 | 3: `GET /v1/agent-registry/records`, `GET /v1/agent-registry/records/:recordId`, `POST /v1/agent-registry/records/:recordId/import` | Discovery: agents found in a registry, imported into the inventory | **UI-D**: D5 builds against #855 and lands after it |
| L6, PM importer (decision record in #828) | #828 | 2: `POST /v1/onboarding/imports/pm`, `GET /v1/onboarding/imports/pm/items` | Onboarding for the Azure DevOps workflow (bringing existing Boards items in); not a demo beat | **UI-D**: D8, after the pilot slices, against #828 |
| E7, vendor usage connectors (ADR-0322) | #845 | none yet (ADR only, slice 1) | Cost across tools (seat tools and vendor APIs) | **UI-D**, once E7 opens a routes slice |

**Not built anywhere yet:** managed-settings *drift*, meaning intended settings compared with what an endpoint reports.
#850 exports bundles but has no drift read and no drift audit event. D1 shows the export, and it will show drift only
when an E1 slice adds the API.

### Projected count

Each in-flight PR sets `KNOWN_UI_GAPS_MAX` from its own base, so whichever merges second must re-derive the cap. Read
this table as a sum, not as any one PR's number.

| Step | Gaps |
|---|---|
| `main` today | 52 |
| + #848 (7), #850 (3), #855 (3), #828 (2) | 67 |
| − UI-C open PRs: #815 (11), #823 (9), #829 (6), #831 (2), #837 (6) | 33 |
| − UI-B #744 (7, HOLD) | 26 |
| − UI-C connector catalogue (2) | 24 |
| − UI-D: D2 (3), D3 (4), D1 (3), D5 (3), D6 (5), D7 (4), D8 (2) | 0 |

Each UI-D PR body states its exact decrement against the base it merges onto.

## 3. Pilot beats: what exists, and what is missing

| Beat | Existing screens | Missing for the pilot | UI-D slice |
|---|---|---|---|
| Coding-tool policy | `/admin/client-access` (interception posture, scope rules, per-client config generator, coverage matrix); `EndpointMcpServersCard` on discovery sources; `/admin/mcp-servers`, `/admin/admission` | (1) A per-user, per-tool allow-list (IDE copilots, AI editors, CLI coding agents, plus MCP servers). Today's scope rules override three compatibility fields only, and MCP allow-lists come from bundles (UI-C #815). (2) Managed-settings export: API in #850. (3) Drift: no API. (4) Which MCP servers can be admitted: the MCP catalogue gaps. | **D1** `builder/ui-d-coding-tool-policy`: a policy view over the interception and endpoint reads on main, plus a managed-settings bundles panel (list, create, download the archive) on #850. Lands after #850. **D7** `builder/ui-d-mcp-catalogue`: the catalogue, presets and bundle-from-catalogue actions. |
| Cost dashboard | `/spend` (one person's own spend), `/admin/cost`, `/admin/cost-consolidation/*`, `/admin/spend-monitor`, `/admin/billing`, `/admin/optimization` | (1) Cost per outcome: API in #848. (2) Cost per user with a budget: API in #848. Today budgets are fields on projects and virtual keys only. (3) Budget alerts in one place: today they are spend anomalies on `/admin/spend-monitor`. | **D2** `builder/ui-d-cost-outcomes`: a cost-per-outcome card on `/admin/cost` (by project and by cost centre). **D3** `builder/ui-d-user-budgets`: a new "Spend by person" page under the cost area at `/admin/cost/people`. Each person's spend and budget, set or clear a budget, and the budget's alerts. Read from #848's user-budget routes, with the monitor policies and anomalies already on main. `/spend` stays the person's own view. Both land after #848. |
| Governed Azure DevOps workflow | `/runs`, `/runs/:runId`, `/workflows`, `/workflows/:instanceId`, `PmLinksCard`, `DecisionLedgerCard`, setup pages for PM and git connections, templates and approvals | One view of the whole chain: Boards item, plan sign-off, agent build, Repos PR, checks, merge approval. Today it is spread across the run and workflow detail pages. | **D4** `builder/ui-d-change-timeline`: the chain and the workflow's recorded history on `/workflows/:instanceId`, from existing reads, as new files plus a mount in `WorkflowDetailPage.tsx`. No `App.tsx` or `suites.tsx` change. **D8** (after the pilot): the PM importer on #828. |
| Shadow-AI discovery | `/admin/shadow-ai`, remediation panel, `/admin/shadow-ai/discovery-sources/*` | (1) Agent registry records, and importing them into the inventory: API in #855. (2) A coding-tool filter or preset on findings. (3) A check that the demo seed has coding-tool signatures. | **D5** `builder/ui-d-discovery-coding-tools`: the coding-tool filter on main, plus an agent-registry records card with import, on #855. Lands after #855. |
| Audit trail | `/admin/audit`, `/audit` (auditor portal), `/admin/lineage`, `/admin/traces` | (1) Saved filters for the pilot's events. (2) SIEM delivery has no screen. | **D6** for SIEM. The saved filters ship with their slices: policy change (`/v1/interception/*` audit actions, on main) with D1; budget set and cleared (#848's audit actions) with D3. A managed-settings drift filter waits for E1's drift slice, because nothing emits that event yet. |

## 4. UI-D claims and order

One PR open for review at a time, each a draft from `origin/main`. A slice whose API is still in flight is built against
that PR's contract, and its PR opens only after the API PR merges.

1. **D0**: this plan (docs only).
2. **D4**: governed change timeline (existing APIs; built at `builder/ui-d-change-timeline`).
3. **D3**: spend by person and budget alerts (#848's user-budget routes; closes 4).
4. **D2**: cost per outcome (#848's outcome routes; closes 3).
5. **D1**: coding-tool policy view and managed-settings export (#850; closes 3).
6. **D5**: discovery coding-tool filter and agent-registry import (#855; closes 3).
7. **D7**: MCP catalogue (on main; closes 4).
8. **D6**: SIEM destinations (on main; closes 5).
9. **D8**: PM importer (#828; closes 2). Then the E7 vendor-usage screens once E7 publishes routes, then anything this
   file still lists as unclaimed.

The order follows the API merges: a slice whose API PR has not merged gives way to the next one that can land.

**Files UI-D will not edit:** anything changed by #744, #815, #823, #829, #831 or #837, or by the HOLD `designer/*` PRs
(#642, #654, #680, #691). Where a slice needs a route or nav line in `apps/web/src/App.tsx` or
`apps/web/src/shell/suites.tsx`, both shared, the change is one line and the PR body says so. #642 reworks route nesting
in the admin areas and is on HOLD, so D3's new route goes in the cost area module rather than `App.tsx` where it can.
The PR body names #642 whenever a slice touches `App.tsx`.

## 5. Rules every UI-D slice follows

- **Design guidelines:** follow DESIGN_GUIDELINES.md in full. Use the kit first (`QueryGate`, `Table`/`DataList`,
  `RowActions`, `RefusalNotice`, `DetailDrawer`), tokens only, en-GB dates and sentence case, with no vendor or model
  names in copy.
- **States:** a skeleton while loading and an error with Retry on failure, never a zero while loading.
- **Performance:** lazy section chunks, with the bundle ceilings checked on the combined tree (M-104, M-112). Lists are
  paginated, filters are debounced, and every screen is axe clean in light and dark.
- **Secure by default:** no raw HTML, and the CSRF header goes through the API client. Local storage holds per-viewer
  conveniences only, and nothing is pre-selected to the permissive choice.
