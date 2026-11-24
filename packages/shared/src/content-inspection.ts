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
