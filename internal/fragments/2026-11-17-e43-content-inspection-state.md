<!-- fold: state-decisions -->
**ADR-0362 (lane E43, 2026-11-17, Proposed; Forcepoint gap 2): content inspection beyond text.**
- **What:** files and attachments in gateway requests and responses (PDF, DOCX, XLSX, PPTX, CSV, zip, images) are
  turned into text by `engines/contentextract/extract.py`, which runs only in the engine sandbox (ADR-0190 I5); the
  existing PII, processing-limit and guardrail checks then run on that text with their usual outcomes.
- **Chosen:** pypdfium2 5.15.2 (Apache-2.0 OR BSD-3-Clause) for PDF, the Python standard library for OOXML, CSV and
  zip; Tesseract for OCR in slice 2. Tika, unstructured, docling, markitdown and kreuzberg compared and rejected
  (reasons in the ADR); openpyxl, python-pptx and defusedxml fail ADR-0176.
- **Defaults:** hard caps baked in the extractor (16 MiB a file, 200 pages, 256 entries, depth 2, ratio 100:1, 20 s);
  an unknown type or a cap fails closed; off by default per project (owner brief, cost), forced on when the project's
  cascade PII mode is `block`.
- **Built so far:** slice 1a (extractor, image, shared vocabulary). Slices 1b (engine registration and gateway wiring),
  2 (OCR) and 3 (cost) follow.
