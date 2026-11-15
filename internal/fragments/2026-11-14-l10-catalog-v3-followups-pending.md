<!-- fold: pending -->
**P35 follow-up: shadow-AI catalogue v3 (lane L10, review of #802, 2026-11-14).**
- **Google Opal host re-check.** Opal leaves Google Labs on 2026-11-17. Re-check that `opal.google` and
  `opal.google.com` still serve it (developers.google.com/opal). Catalogue v3 is frozen, so a changed host means a v4,
  not an edit. This is tracked here and not in the entry's note.
- **Catalogue version on repo-scan evidence (ADR-0083 §2).** `analyseRepo` and the SD1 repo scanner now default to
  catalogue v3. Their `repo_scan` observations do not record which catalogue matched, so after the switch "matched X"
  from a repo scan cannot be told apart as v2 or v3. The fix is to stamp `SHADOW_AI_CATALOG_V3_VERSION` on each
  observation. That adds a field which the discovery worker validates and stores, so it changes the evidence format
  and needs its own slice, with the worker and storage owners involved. The gap predates #802.
