# ADR-0215: Framework content imports and a wider regulatory feed

- **Status**: Accepted (implemented)
- **Date**: 2026-10-30
- **Related**: ADR-0058/0087 (packs as rows, versioning, the version diff), ADR-0158 (the regulatory feed),
  ADR-0176 (open source first, licences, air-gapped), ADR-0180 (secure by default), PENDING.md row P5
- **Migrations**: 0233 (`framework_import_proposals`, `org_settings.framework_imports_enabled`),
  0234 (`regulatory_feed_imports`)

## Context

The owner started the competitor-gap backlog on 2026-10-30 (#453, comment 6522850568); P5 is wave 1. Control text in a
compliance pack is typed by hand, and the ADR-0158 regulatory feed is curated by hand. PENDING.md P5 asks for versioned
imports from public-domain and permissively licensed sources (MITRE ATLAS, the NIST AI RMF data and OSCAL catalogs), a
feed that is not curated by hand, and share-alike or non-commercial content cited by ID only.

## Decision

1. **The content is vendored data, refreshed by a script.** Normalised snapshots live in
   `packages/shared/src/framework-imports-data/` with a licence note. `scripts/refresh-framework-imports.mjs`
   downloads pinned upstream revisions (or reads files already on disk, `--from <dir>`) and rewrites them. The
   product reads the files from disk and never downloads, so imports work air-gapped. First sources:
   - MITRE ATLAS 2026.10 (Apache-2.0): 44 mitigations as framework `mitre-atlas`;
   - NIST AI RMF 1.0 OSCAL catalog (public domain): 72 subcategories into `nist-ai-rmf`, whose refs the existing
     seed already uses;
   - NIST CSF 2.0 OSCAL catalog (public domain): 106 subcategories in force as `nist-csf-2`;
   - the Federal Register API (public domain): rules, proposed rules and presidential documents about AI, as feed
     entries.
2. **Licences decide what is stored.** Public-domain and permissive licences store the text. Share-alike and
   non-commercial content is cited by identifier only (no text). Any other licence is refused by the normaliser and the
   snapshot schema. Each source is recorded in `packages/shared/THIRD_PARTY.md`.
3. **An import is a three-way merge that only brings text.** It compares the last accepted import of the source (the
   baseline), the latest pack version and the new snapshot. Only the title and description come from the source. The
   mapping (coverage, collector, parameters, threshold, attestation, owner note) is never changed. A control whose
   current text differs from the baseline, or that was never imported, counts as edited by an admin and is **kept**,
   unless the admin names it in `takeIncoming`. New controls start unmapped (`unaddressed`, collector `none`). Controls
   that are not in the source stay. The merge is pure and deterministic: controls sorted by ref, the content hash is the
   canonical-JSON sha256.
4. **Propose, review and accept, and the accept is audited.** `POST /v1/compliance/framework-imports/:sourceId/proposals`
   stores the plan (the diff). `.../proposals/:id/accept` plans again against the same base pack version. If the base
   moved it refuses with 409, and nothing is written. Otherwise it inserts a **new draft pack version**, marks the
   proposal accepted and supersedes the previous baseline, with the audit row in the same transaction. Reject is
   audited the same way. No pack row is ever updated, and activation stays the ADR-0058/0087 step with its own diff.
5. **The feed widens the same way.** `POST /v1/regulatory/feed-imports/:sourceId/proposals` stores the entries and
   their diff (added, changed, removed keys) against the accepted row, and accept or reject is audited. The ADR-0158
   route serves the curated entries plus the accepted row of each source. A curated entry wins a key collision.
   Imported entries map to no control, and the feed says so.
6. **Off by default.** `org_settings.framework_imports_enabled` defaults to false. While it is off, every write
   refuses (403, audited) and the feed is the curated list only. Turning it on is a relaxation: `settings_relax` step-up
   through the strictness registry. All routes are admin-only through the default gate.
7. **Placement** (#453 placement note): "Framework imports" sits under *Compliance & infra* beside Compliance packs, and
   "Regulatory feed sources" sits under *AI Governance* beside Regulatory intelligence. Both are lazy-loaded.

## Consequences

- Pack control text can now follow the published framework, without an import ever overwriting an admin's wording
  silently or changing what evidences a control.
- The first NIST AI RMF import onto the seeded pack keeps the seed's own titles as edits, because they were never
  imported. The admin can choose to take the source text for each one.
- Refreshing content is a developer step (run the script, review the diff, commit), followed by an admin step in the
  product. Not done: a scheduled refresh, packs for US state laws (no permissively licensed machine-readable source was
  found, so the curated feed covers them), the NIST SP 800-53 catalog (over the 500-control pack limit), and the AI RMF
  Playbook's suggested actions.

## Tests

`packages/shared/src/framework-imports.test.ts` (17): the normalisers are deterministic and order-independent, licences
are enforced, an edited control is never overwritten unless named, and the feed diff and merge.
`apps/gateway/src/zz-adr0215-framework-imports.test.ts` (5): the routes refuse and audit while off, a proposal is
deterministic, accept writes a new draft version that keeps edits, a bad resolution or a moved base writes nothing,
every decision is audited, and accepted feed entries join the regulatory feed only while imports are on.
`apps/web/e2e/framework-imports.mock.spec.ts` (2): a description-only change is visible on both sides of the import
drawer, and the feed-update drawer lists the entries before Accept.

## As built (review of 2026-10-31)

- The framework-import drawer shows each control's description on both sides, with the changed parts named in words
  ("Changes: description"), so an edit the import would keep or overwrite is visible when it touches only the
  description.
- `GET /v1/regulatory/feed-imports/:id` returns the entries a feed update adds, changes (with the entry in the feed
  now) and removes: key, title, instrument, effective date, status and link. The Regulatory feed sources page lists
  them in a drawer with the Accept and Reject actions pinned; the counts-only confirmation is gone.
- Import source, licence and entry links must be https; the snapshot schema refuses any other scheme.
