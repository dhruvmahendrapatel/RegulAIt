# ADR-0293: Vendor MITRE ATLAS tactics and techniques and map red-team classes onto them

- **Status**: Accepted (P18 lane A1, master brief 2026-11-14; built by builder lane L8)
- **Date**: 2026-11-14
- **Index**: MITRE ATLAS tactics and techniques as an import source, mapped to red-team classes (P18 A1)
- **Backlog**: [PENDING, P18](../product/PENDING.md); audit [2026-11-07 P18 coverage](../reviews/2026-11-07-p18-framework-coverage.md) lane A1
- **Migration**: none

## Context

The P18 audit rated MITRE ATLAS "partial": ADR-0215 vendored the ATLAS release's 44 mitigations as an import source,
but not its tactics and techniques, so no pack control names a technique and nothing says which technique a red-team
run exercised. ATLAS is Apache-2.0, so its text may be stored (ADR-0176, ADR-0215 decision 2). Open source first: the
ATLAS data release is the authoritative machine-readable source; promptfoo's MIT `MITRE_ATLAS_MAPPING` maps its own
plugins to ATLAS tactics only, not techniques, so it does not cover our red-team classes.

## Decision

1. **A second ATLAS import source, `mitre-atlas-techniques`**, read from the same pinned release
   (`dist/v6/ATLAS-2026.10.yaml`, commit `f56c1468…`, sha256 `ac41ee9f…`, unchanged from ADR-0215). The new pure
   normaliser `normaliseAtlasTechniques` turns the 16 tactics and 221 techniques (sub-techniques included) into 237
   entries: id and name as the title (tactics marked "(tactic)"), the description with markdown links reduced to their
   text and ATLAS's `[[reference]]` citation markers dropped, followed by the tactics a technique achieves and, for a
   sub-technique, its parent. The snapshot is `framework-imports-data/mitre-atlas-techniques.json`, written by
   `scripts/refresh-framework-imports.mjs`. The gateway lists every vendored snapshot, so it becomes an import source
   with no gateway change; an admin imports it through the ADR-0215 three-way merge, and every entry lands unmapped.
2. **The mitigations stay a separate source.** Mitigations are controls; techniques are threats. One pack holding
   both would make "coverage" mean two things. The technique pack is a threat register an admin maps to evidence.
3. **Our mapping of red-team attack classes to ATLAS techniques** (`atlas-redteam-map.ts`). Each of the ten classes
   names the techniques a passing run is evidence against. `bias` maps to nothing: ATLAS has no fairness technique, and
   AML.T0130 (steering an assistant toward chosen sources) is prompt injection, not bias. A test holds every id to the
   vendored release and refuses a tactic id, so an upstream renumbering fails CI.
4. **The evaluator catalog cites them.** `EvaluatorRefs` gains `mitreAtlas` (red-team classes only), checked by
   `catalogReferenceProblems` and included in `evaluatorRefList`, so an imported technique control's "tested by" finds
   the red-team classes that exercise it.

## Consequences

- MITRE ATLAS moves from partial to built for tactics and techniques; mitigations were already importable.
- The mapping is RegulAIt's judgement with no domain review; it is a starting point, like every pack mapping.
- A new ATLAS release means bumping the pinned revision, re-running the refresh script, and fixing any id the map test
  reports. The admin reviews the text diff in the product as for every import.
- `EvaluatorRefs` is a wider shape: the console's evaluator table does not show the new column yet (UI, #453).
- Not done: scorers and guardrail detectors cite no ATLAS technique (only red-team runs exercise attacks); ATLAS case
  studies and software entries are not vendored.
