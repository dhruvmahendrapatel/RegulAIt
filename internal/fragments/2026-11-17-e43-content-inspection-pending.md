<!-- fold: pending -->

**E43 — content inspection beyond text (owner, 2026-11-17; Forcepoint review gap 2).** In progress
([ADR-0362](../decisions/0362-content-inspection-beyond-text.md)). Slice 1a built: the sandbox-only extractor and its
image. Next: 1b (engine registration, the gateway's sandboxed call, the per-project setting, detector wiring), 2 (local
Tesseract OCR), 3 (latency and throughput measured). Owner questions open: the permissive non-ADR-0176 licences bundled
in `libpdfium.so` (FreeType, ICU, libpng, libtiff, zlib, AGG, Boost, IJG), and whether a guardrail at `block` should
also force inspection on.
