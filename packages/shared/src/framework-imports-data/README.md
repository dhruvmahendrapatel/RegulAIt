# Framework import data — licence note (ADR-0215)

These files are **vendored data**. The product reads them from disk and never downloads anything at run time, so imports
work air-gapped. `scripts/refresh-framework-imports.mjs` rewrites them from pinned upstream revisions (or, with
`--from <dir>`, from files already on disk). Each JSON file records its own upstream URL, revision, sha256 of the
upstream bytes and retrieval date in `source`; the product hashes the canonical content again when it plans an import.

Only control and entry **text** is stored: identifiers, titles, statements and (for ATLAS) mitigation descriptions. No
upstream code is vendored or run.

| File | Source | Revision | Licence | What is stored |
|---|---|---|---|---|
| `mitre-atlas.json` | MITRE ATLAS data release `dist/v6/ATLAS-2026.10.yaml`, github.com/mitre-atlas/atlas-data, © 2021-2026 MITRE | commit `f56c1468731d6428e5bf875263b4643b46d67437`, release 2026.10 | Apache-2.0 (`LICENSE-mitre-atlas`, kept verbatim per §4) | 44 mitigations: id, name, description (markdown links reduced to their text), and the ids of the techniques each mitigates. Changes made: whitespace collapsed, long text clipped with "…". |
| `nist-ai-rmf-oscal.json` | NIST AI RMF 1.0 (AI 100-1) OSCAL catalog, github.com/usnistgov/oscal-content | commit `f0de6d8d8c059d374f15e0ae07508d82e370fc1d`, catalog version 1.0.0 | US government work, public domain; CC0-1.0 worldwide (`LICENSE-nist-oscal-content.md`) | 72 subcategories: id and statement. |
| `nist-csf-2-oscal.json` | NIST Cybersecurity Framework 2.0 OSCAL catalog, same repository | same commit, catalog version 1.2.1 | as above | 106 subcategories in force (withdrawn ones left out): id and statement. |
| `us-federal-register-ai.json` | Federal Register API search (`federalregister.gov/api/v1`), Office of the Federal Register | search of 2026-10-30, documents published since 2025-10-30 | US government work, public domain (17 U.S.C. 105) | Rules, proposed rules and presidential documents about AI: number, title, abstract, dates, agencies, link. |

## Licence rules applied

- Public-domain and permissive (Apache-2.0, MIT, BSD, ISC, CC0, US government) sources may store text.
- Share-alike or non-commercial sources (CC BY-SA, CC BY-NC and similar) are **cited by ID only**: the importer
  replaces each title with its identifier and stores no description (`importTextPolicy` in `../framework-imports.ts`).
- Any other licence is refused by the importer and by the snapshot schema.

## Considered and not vendored

- **NIST AI RMF Playbook JSON** (public domain): the suggested actions are long guidance text, not control statements;
  the OSCAL catalog above is NIST's own machine-readable form of the same subcategories.
- **NIST SP 800-53 Rev. 5 OSCAL catalog** (public domain): over 1,000 controls, above the 500-control pack limit; it can
  be added later as a profile-resolved baseline.
- **US state AI laws**: no permissively licensed machine-readable source was found; state statutes are cited by the
  hand-curated feed instead.
