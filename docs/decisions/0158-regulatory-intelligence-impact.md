# ADR-0158: Regulatory Intelligence as a Curated Feed Joined to Our State

Status: Accepted (implemented)
Date: 2026-10-02
Related: ADR-0058/0087 (packs, versioning), ADR-0089 (EU AI Act tier),
ADR-0148 (posture window); demo tasks C9 (API), G4 (feed data), X9 (UI)
Migration: none

## Context

Competitor platforms present a "regulatory & policy intelligence" view. The
honest version of that for us is not a crawler or a legal interpreter: it is a
short, curated list of obligations, each with a primary source, and — the part
only we can compute — what each one means for THIS organisation's controls
and use cases.

## Decision

1. **The feed is data**, authored and source-checked (G4,
   `packages/shared/src/demo-intake/regulatory-updates.ts`, exported as
   `REGULATORY_UPDATES: RegulatoryUpdate[]`). Every entry carries `sourceUrl`
   and `verifiedOn`. The type lives in `regulatory-intel.ts` (Claude).
2. **`GET /v1/regulatory/updates[?status=&framework=]`** (admin-only) joins
   each entry to: active pack versions per named framework; each mapped
   control's LIVE evaluation status (org scope, posture window — the same
   evaluator the trust dashboard uses); and live use cases in scope
   (proposed/under review/approved; optionally narrowed by computed EU AI Act
   tier — an unscreened use case is never assumed in scope of a tier filter).
3. **Gaps are reported, never dropped**: a control in no active pack is
   `not_in_active_pack`; a named framework without an active pack is a
   `frameworkGap`. Evidenced = satisfied or attested; everything else is a gap.
4. Read by name from `@regulait/shared`: before the dataset exists the route
   returns an empty list and says so ("not 'nothing applies'").

## Consequences

- The platform makes no legal determination; notes on every response say so.
- Keeping the feed current is an editorial process (source + verified date);
  an admin-authored feed (DB-backed) is a follow-up if customers want their
  own entries.

## Tests

`packages/shared/src/regulatory-intel.test.ts` (4) and
`apps/gateway/src/zz-adr0158-regulatory-intel.test.ts` (3).
