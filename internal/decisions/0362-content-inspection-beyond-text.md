# ADR-0362: Content inspection beyond text: sandboxed extraction of files and attachments, then the existing detectors

- **Status**: Proposed (lane E43 brief, 2026-11-17: the confirmed direction; slice 1a built; owner questions are listed at the end)
- **Date**: 2026-11-17
- **Index**: **Content inspection beyond text (pillars 1 and 3): the files and attachments in gateway requests and responses (PDF, DOCX, XLSX, PPTX, CSV, zip archives and images) are turned into text by an extractor that runs only in the engine sandbox (ADR-0190 I5), never in the gateway; the existing PII detection and guardrails (ADR-0140, ADR-0042) then run on that text with their usual outcomes; a file of an unknown type or over a limit fails closed (an admin may relax that, audited); OCR is local Tesseract (slice 2); the feature is off by default per project because of its measured cost (slice 3), except where the project's compliance cascade blocks PII.**
- **Backlog item**: `internal/product/GAP_ANALYSIS_FORCEPOINT_2026-11.md` §3 rank 2 ("File, attachment and image inspection", F7 × S8 = 56), lane E43
- **Built in**: lane E43, four PRs: 1a (this ADR, the extractor and its image), 1b (the engine registration, the gateway's sandboxed call, the per-project setting and the detector wiring), 2 (OCR), 3 (the cost measurement)
- **Migration**: slice 1b, `pending/content_inspection.sql` (numbered at merge, ADR-0252)
- **Related**: [ADR-0042](0042-guardrail-engine.md), [ADR-0137](0137-in-flight-pii-redaction-boundary.md), [ADR-0140](0140-validated-pii-redaction-foundation.md),
  [ADR-0143](0143-mcp-redacted-action-enforcement.md), [ADR-0176](0176-open-source-first.md), [ADR-0180](0180-continuous-assurance-strict-by-default.md),
  [ADR-0187](0187-batch5-sidecar-engines.md), [ADR-0190](0190-batch6-isolation-execution-profiles.md), [ADR-0242](0242-mcp-and-skill-scanner-engines.md),
  ADR-0200 (engineering guidelines), [ADR-0252](0252-merge-queue-and-merge-time-numbering.md)

## Context

The gateway's guardrails (ADR-0042) and PII detection (ADR-0140, ADR-0117) read text only. A chat dispatch can carry
up to eight base64 images and PDFs (`attachments`, `packages/shared/src/index.ts`), which go to a vision-capable provider
unread; the compat endpoints pass `image_url` parts on; ADR-0143 withholds opaque MCP content rather than reading it.
So a card number typed into a prompt is blocked, and the same card number in a PDF is sent. The Forcepoint review
ranked this gap second (F7 × S8 = 56).

The owner's brief for lane E43 (2026-11-17):
1. extract text from the files and attachments in gateway requests and responses (PDF, Office, CSV, archives with size
   and depth limits, images), run the existing guardrails and PII detection on it with the same outcomes, run the
   parsers in the engine sandbox (ADR-0242), never in the gateway process, set strict size, page and time limits,
   refuse zip bombs, and fail closed on an unknown type or a limit, an admin may relax that, audited;
2. OCR for images and scanned PDFs with a local engine only, working air-gapped;
3. measure the latency and throughput cost; content inspection is off by default per project, with a clear note of
   its cost.

## Open-source comparison (ADR-0176; owner build rule "compare at least two")

Searched 2026-11-17 (PyPI and npm metadata, release dates and licences read from the registries).

| Candidate | Licence | Last release | Fit | Verdict |
|---|---|---|---|---|
| **Apache Tika** (tika-server) | Apache-2.0 | 3.2.x, 2025 | Every format, OCR through Tesseract | **Rejected.** A JVM (~400 MB image, seconds of start per sandboxed task, ~200 MB resident), a thousand parsers of attack surface (its XXE and parser-DoS advisories are a long list), and its natural shape is a long-lived server, which the per-task sandbox is not. |
| **unstructured** | Apache-2.0 | 0.27.37, 2026-11-06 | Broad | **Rejected.** A very large dependency tree, optional extras under other licences, and model downloads at run time by default (not air-gapped without work). |
| **docling** (IBM) | MIT | 2.150.1, 2026-11-14 | Layout-aware | **Rejected.** Needs ML layout models (download, size, GPU-friendly); far beyond "text for a detector". |
| **markitdown** (Microsoft) | MIT | 0.1.9, 2026-10-21 | Thin wrappers | **Rejected.** It inherits openpyxl and python-pptx (below) and adds `magika` (an ML type detector). |
| **kreuzberg** | MIT | 4.10.4, 2026-09-21 | Rust core, PDF/Office/OCR | **Runner-up.** One dependency that does it all, but its Rust closure is large to licence-audit, it bundles its own PDFium, and it gives less control over per-format limits; v4 is new. Re-check when slice 2 lands. |
| openpyxl / python-pptx | MIT | 2024-06-28 / 2024-08-07 | XLSX / PPTX | **Fail ADR-0176**: no release in the last 12 months. |
| python-docx | MIT | 2025-06-16 | DOCX | Not needed once the standard library reads OOXML (below). |
| defusedxml | PSF | 2021-03-08 | Hardened XML | **Fails ADR-0176**: PSF licence, unmaintained. |
| pypdf | BSD-3-Clause | 7.1.0, 2026-11-13 | Pure-Python PDF text | Considered: maintained and on-licence, but pure-Python PDF parsing is slow on large files and it cannot render a scanned page for OCR. |
| pdfminer.six | MIT | 20260107 | PDF text | Same as pypdf, no rendering. |
| **pypdfium2** | Apache-2.0 OR BSD-3-Clause | 5.15.2, 2026-11-09 | PDF text and page rendering | **Chosen for PDF.** PDFium is Chrome's PDF engine, fuzzed continuously; one wheel, no Python dependencies; the same library renders scanned pages for slice 2's OCR. Built without V8 or XFA, so no JavaScript engine ships. |
| Python standard library (`zipfile`, `xml.etree`) | PSF-2.0 (accepted for the runtime, ADR-0187 decision 193) | CPython 3.12.16 | OOXML, CSV, zip | **Chosen for Office, CSV and archives.** OOXML is a zip of XML parts; reading the text elements directly is a few dozen lines and needs no stale dependency. |
| JavaScript in the gateway (unpdf, mammoth, exceljs, tesseract.js) | MIT / BSD-2 / MIT / Apache-2.0 | maintained | — | **Rejected by the brief**: parsers never run in the gateway process. tesseract.js also fetches its language data from a CDN by default. |
| **Tesseract** (OCR, slice 2) | Apache-2.0 | 5.5.x | Local OCR, Debian package, language data baked in | **Chosen for OCR** (slice 2), with `tessdata_fast` `eng` baked into the image. |

Repository search (owner rule 8): the sandbox, task input and output frames, attestation and fail-closed placement
are reused from ADR-0187/0190/0242 (`packages/engine-runner`, `packages/sandbox-executor`,
`apps/gateway/src/engine-tasks.ts`, `admission-scan-runs.ts` as the gateway-initiated subject-run template); the
licence gate is mcpscanner's `licence-gate.mjs`, reused rather than copied; the detectors are the dispatch's existing
`enforcePII`, `privacyDispatchGate` and `runGuardrailsAsync` calls in `agents-connectors.ts`; the attachment bounds are
the existing `maxAttachmentsPerDispatch` and `maxAttachmentBytes` org settings.

## Decision

1. **One extractor, sandbox only.** `engines/contentextract/extract.py` takes one bundle (the files' base64 and
   optional limits) and returns, for each file, `extracted` with its text or `refused` with one reason from a closed
   list (`unknown_type`, `type_mismatch`, `too_large`, `page_limit`, `text_limit`, `archive_limit`, `depth_limit`,
   `ratio_limit`, `encrypted`, `malformed`, `timeout`, `needs_ocr`). It decides nothing about policy. The vocabulary
   is mirrored in `packages/shared/src/content-inspection.ts`, kept equal by a test.
2. **Never in the gateway.** The extractor runs as an `engine_worker` workload under ADR-0190 I5: gVisor, no network,
   read-only input holding only the gateway-written bundle, no secret, results as frames. The engine is registered as
   `contentextract` (slice 1b) and is off until its first signed image publish, like every engine (ADR-0187 decision 3).
   The gateway awaits the run on the request path with a deadline; no answer by the deadline is a refusal of every
   file (`timeout`).
3. **Type from bytes.** The type comes from magic numbers, not the name or declared media type. A declared type of a
   different family is `type_mismatch`. An OOXML part that declares a DOCTYPE or ENTITY is `malformed`, which closes
   entity-expansion and external-entity attacks whatever the expat version.
4. **Limits.** The hard caps below are baked into the extractor; a request may only lower them. Every zip read stops
   one byte past its limit, whatever the header claims. The text cap (750,000 characters, lowered from 2,000,000 by the
   lane lead on 2026-11-17) keeps the result, as escaped JSON, under the engine contract's 3 MiB raw-report cap for
   ordinary text (at most 4 UTF-8 bytes a character); text that escapes to more (control characters) makes the report
   over the cap, which fails closed (`report_too_large`, every file refused).

   | Limit | Hard cap |
   |---|---|
   | one input file | 16 MiB |
   | PDF pages | 200 |
   | text returned per request | 750,000 characters |
   | archive entries (OOXML parts count) | 256 |
   | archive nesting | 2 (an archive in an archive in an archive is refused) |
   | uncompressed bytes per archive tree | 64 MiB |
   | one uncompressed entry | 16 MiB |
   | compression ratio per entry | 100:1 |
   | extractor deadline | 20 s (the sandbox wall clock sits above it) |

5. **Same detectors, same outcomes.** The extracted text of a dispatch's attachments is inspected by the same three
   input checks, in the same order, as the prompt (the cascade PII mode, the ADR-0224 processing limit, the ADR-0042
   guardrails), with the same `pii_blocked`/`guardrail_blocked` refusals, warn and log annotations and audit rows. The
   audit rows say which attachment the hit came from by its index and kind, never its text. Response-side files (MCP
   results, compat responses) use the output phase the same way. Where a policy would redact (ADR-0137, once exposed)
   bytes cannot be redacted in place: the file is withheld and the redacted text is sent in its place.
6. **Fail closed.** With inspection on, a `refused` file refuses the dispatch `422 content_not_inspectable`, naming the
   file's index and reason. An admin may relax this per project to "pass the file marked not scanned"; that is a
   `settings_relax` step-up (ADR-0180), audited, and the dispatch's audit row then records `contentInspection:
   not_scanned` for that file, never "clean".
7. **Off by default per project, with a floor.** Inspection costs a sandbox run per dispatch that carries files
   (slice 3 measures it), so the owner's brief sets it off per project. It is forced on, whatever the project's
   setting, when the project's effective compliance cascade PII mode is `block`: a framework that blocks PII in text
   must not let the same PII through in a PDF. With inspection off, every attachment's audit row says
   `not_scanned`. This is a recorded exception to ADR-0180's strict default, made by the owner's brief; the open
   question below asks whether to widen the floor.
8. **OCR (slice 2)**: Tesseract with baked language data, inside the same image; scanned PDF pages rendered by PDFium to
   PPM (no Pillow); per-image pixel and per-request OCR-page caps. Until slice 2, an image or a PDF with no text layer
   is refused `needs_ocr`, so it fails closed with inspection on.

## Consequences

- A file in a prompt meets the same rules as the prompt, where inspection is on. Where it is off, the audit says the
  file was not scanned rather than implying it was clean.
- Each inspected dispatch pays a sandbox start and an extraction (slice 3 publishes the numbers). The sandbox's
  multi-replica caveat (a task lives in the gateway process that started it, ADR-0190) applies here too.
- The engine cannot be enabled until its image is built, signed and its digest recorded, so slice 1b's wiring is
  inert in every deployment until then; with inspection forced on by the floor and the engine unavailable, a
  dispatch with files fails closed.
- PDFium bundles components whose licences are permissive but outside the ADR-0176 list (below).

## Owner questions (open; the builder built the secure default)

1. **Licences inside `libpdfium.so`**: FreeType (FTL), ICU (Unicode-3.0), libpng (libpng-2.0), libtiff, zlib (Zlib),
   Anti-Grain Geometry 2.3, dragonbox (Boost-1.0) and IJG are permissive, no copyleft, and outside the ADR-0176 list.
   The precedent is numpy's Zlib (accepted 2026-10-09, ADR-0187 decision 106). Pending; the image is not admissible
   until decided (`engines/contentextract/THIRD_PARTY.md`).
2. **Widen the floor?** Should inspection also be forced on when any guardrail detector is at `block` for the project,
   not only the cascade PII mode? The builder kept the narrower floor so as not to change existing projects' attachment
   behaviour without a decision.

## As built

- **Slice 1a (2026-11-17)**: `engines/contentextract/` (the extractor, its tests, the pinned closure, the reused
  licence gate, the image), `packages/shared/src/content-inspection.ts` and its parity test. No gateway change and no
  migration yet.
- **Slice 1b-i (2026-11-17)**: the engine is registered, inert. `contentextract` (kind `content_extract`) joins
  ENGINE_IDS and the manifest (null digest, so it cannot be enabled),
  compose (runner and build-only image services), the build script and the image build-and-compare workflow. The
  image is HELD UNPUBLISHED, like mcpscanner and skillscanner, until the owner decides owner question 1 (lane lead,
  2026-11-17): it has no images-lock entry, the publish gate lists it as unpublished, the build script refuses to push
  it, and the manifest hardcodes a null digest and task image. Pending migration
  `content_extract_engine`: the engine row (off), trigger `inspection`, a third `engine_runs_target_check` branch (a
  `subject` run of `contentextract` only, which may name the request's person and project), and
  `content_inspection_results` (the result, encrypted under the data key, deleted when read; in the data-key
  re-encryption registry). The runner and task are the admission-scan shim's (`packages/engine-admission-scan`), made a
  three-engine subject shim: the extractor differs only in its input argument (the bundle file, not the input root).
  The image gains that shim stage; the licence gate is now this engine's own copy of mcpscanner's, because the
  publish gate refuses an engine whose image inputs name another engine's directory. Gateway:
  `apps/gateway/src/content-inspection-runs.ts` (`enqueueContentExtractRun`, `awaitContentExtractResult` and the
  input, end and placement hooks). The raw report of a `contentextract` run is never kept on the run. No request-path
  wiring yet (slice 1b-ii).
