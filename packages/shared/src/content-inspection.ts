/**
 * ADR-0362 — content inspection beyond text: the shared vocabulary of the sandboxed extractor
 * (`engines/contentextract/extract.py`) that the gateway reads its results with.
 *
 * The extractor turns a request's or response's files into text so the existing detectors (ADR-0140 PII, ADR-0042
 * guardrails) run on it with their usual outcomes. Every file ends `extracted` (with text) or `refused` with one of
 * {@link CONTENT_REFUSAL_REASONS}; the gateway fails closed on a refusal unless an admin relaxed that, audited.
 *
 * `content-inspection.test.ts` keeps these constants equal to the extractor's and runs the extractor's own tests.
 */
import { z } from "zod";

/** why a file was not turned into text; the order is the extractor's `REFUSAL_REASONS` */
export const CONTENT_REFUSAL_REASONS = [
  "unknown_type",
  "type_mismatch",
  "too_large",
  "page_limit",
  "text_limit",
  "archive_limit",
  "depth_limit",
  "ratio_limit",
  "encrypted",
  "malformed",
  "timeout",
  "needs_ocr",
] as const;
export type ContentRefusalReason = (typeof CONTENT_REFUSAL_REASONS)[number];

/** what the bytes were found to be (never the declared name or media type) */
export const CONTENT_KINDS = ["pdf", "docx", "xlsx", "pptx", "zip", "text", "image", "unknown"] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

/**
 * The extractor's hard caps (ADR-0362 "Limits"). A request may only lower them; the extractor ignores a higher value.
 * `deadlineMs` is the extractor's own clock; the sandbox's wall-clock limit is set above it by the gateway.
 */
export const CONTENT_EXTRACT_HARD_LIMITS = {
  maxFileBytes: 16 * 1024 * 1024,
  maxPages: 200,
  maxTextChars: 750_000,
  maxArchiveEntries: 256,
  maxArchiveDepth: 2,
  maxArchiveTotalBytes: 64 * 1024 * 1024,
  maxEntryBytes: 16 * 1024 * 1024,
  maxCompressionRatio: 100,
  deadlineMs: 20_000,
} as const;
export type ContentExtractLimits = { -readonly [K in keyof typeof CONTENT_EXTRACT_HARD_LIMITS]: number };

export const CONTENT_EXTRACT_RESULT_VERSION = 1;

const fileId = z.string().min(1).max(64);

/** one file of the extractor's result */
export const contentExtractFileResultSchema = z.discriminatedUnion("status", [
  z.object({
    id: fileId,
    status: z.literal("extracted"),
    type: z.enum(CONTENT_KINDS),
    text: z.string(),
    pages: z.number().int().min(0).optional(),
    scannedPages: z.number().int().min(0).optional(),
  }).strict(),
  z.object({
    id: fileId,
    status: z.literal("refused"),
    type: z.enum(CONTENT_KINDS),
    reason: z.enum(CONTENT_REFUSAL_REASONS),
  }).strict(),
]);
export type ContentExtractFileResult = z.infer<typeof contentExtractFileResultSchema>;

/** the extractor's whole result; a reply that does not parse is a refusal of every file (fail closed) */
export const contentExtractResultSchema = z.object({
  version: z.literal(CONTENT_EXTRACT_RESULT_VERSION),
  files: z.array(contentExtractFileResultSchema).max(64),
}).strict();
export type ContentExtractResult = z.infer<typeof contentExtractResultSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// ADR-0362 slice 1b-ii — the request path's vocabulary, declared ONCE (owner build rule "explicit state machines"). The
// gateway (`apps/gateway/src/content-inspection.ts`) reads these; no literal is repeated there.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * One file's inspection status on a dispatch. A file starts `pending` (in memory only, never recorded) and ends in one
 * terminal status; `refused` may only become `not_scanned`, when the project's `pass_not_scanned` relaxation lets the
 * dispatch go on. Nothing is ever recorded as "clean": a file that was not read is `not_scanned`.
 */
export const CONTENT_INSPECTION_FILE_STATUSES = ["extracted", "refused", "not_scanned"] as const;
export type ContentInspectionFileStatus = (typeof CONTENT_INSPECTION_FILE_STATUSES)[number];
export const CONTENT_INSPECTION_FILE_TRANSITIONS: Readonly<Record<"pending" | ContentInspectionFileStatus, readonly ContentInspectionFileStatus[]>> = {
  pending: ["extracted", "refused", "not_scanned"],
  refused: ["not_scanned"],
  extracted: [],
  not_scanned: [],
};
/** true when `to` is an allowed next status of `from` (the one transition check the gateway uses) */
export function contentInspectionFileTransitionAllowed(from: "pending" | ContentInspectionFileStatus, to: ContentInspectionFileStatus): boolean {
  return CONTENT_INSPECTION_FILE_TRANSITIONS[from].includes(to);
}

/**
 * The dispatch-level outcome, each with what it does to the dispatch. `not_inspected`: inspection is off for the project
 * (its files are `not_scanned`); `inspected`: every file was extracted and its text went through the input checks;
 * `passed_not_scanned`: at least one file could not be read and the project's relaxation let the dispatch go on;
 * `refused`: at least one file could not be read, so the dispatch is refused 422 before any provider work.
 */
export const CONTENT_INSPECTION_DISPATCH_OUTCOMES = {
  not_inspected: { proceeds: true },
  inspected: { proceeds: true },
  passed_not_scanned: { proceeds: true },
  refused: { proceeds: false },
} as const;
export type ContentInspectionDispatchOutcome = keyof typeof CONTENT_INSPECTION_DISPATCH_OUTCOMES;

/**
 * What the engine answered, at the dispatch level. `result`: the extractor returned a result for every file;
 * `engine_off`: the engine is off (the shipped default, its image unpublished); `not_queued`: the run could not be
 * queued (no data key, an over-cap bundle); `timeout`: no answer by the request's deadline; `not_run`, `failed`,
 * `no_result`: the run ended without a stored, readable result. Every outcome but `result` refuses every file with
 * reason `timeout` (ADR-0362 decision 2: no answer is a refusal), and the audit row names the outcome.
 */
export const CONTENT_INSPECTION_ENGINE_OUTCOMES = ["result", "engine_off", "not_queued", "timeout", "not_run", "failed", "no_result"] as const;
export type ContentInspectionEngineOutcome = (typeof CONTENT_INSPECTION_ENGINE_OUTCOMES)[number];

/** what a project does with a file that could not be inspected (ADR-0362 decision 6); `refuse` is the secure default */
export const CONTENT_INSPECTION_ON_UNINSPECTABLE = ["refuse", "pass_not_scanned"] as const;
export type ContentInspectionOnUninspectable = (typeof CONTENT_INSPECTION_ON_UNINSPECTABLE)[number];

/** the shipped per-project setting when no row exists: off, and a file that cannot be read refuses (ADR-0362 decision 7) */
export const CONTENT_INSPECTION_DEFAULTS = { enabled: false, onUninspectable: "refuse" } as const satisfies {
  enabled: boolean;
  onUninspectable: ContentInspectionOnUninspectable;
};

/** PUT /v1/projects/:projectId/content-inspection: either field, nothing else */
export const contentInspectionSettingsBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    onUninspectable: z.enum(CONTENT_INSPECTION_ON_UNINSPECTABLE).optional(),
  })
  .strict()
  .refine((b) => b.enabled !== undefined || b.onUninspectable !== undefined, { message: "set enabled, onUninspectable or both" });
export type ContentInspectionSettingsBody = z.infer<typeof contentInspectionSettingsBodySchema>;

/** the plain cost note the settings routes carry, declared once (lane lead, 2026-11-17) */
export const CONTENT_INSPECTION_COST_NOTE =
  "Off by default because each dispatch that carries files pays a sandboxed extraction before the provider call: about 40–130 ms per text document and about 350 ms per scanned page for OCR, plus up to a few seconds of engine-runner pickup today (ADR-0362 §Cost).";
