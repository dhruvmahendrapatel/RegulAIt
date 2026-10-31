/**
 * ADR-0224 (P13 c) — PRIVACY OPERATIONS: the shared contract.
 *
 * Three things live here, all pure:
 *  1. the record of processing for an AI system (purpose, lawful basis, data categories, retention, recipients),
 *  2. the data-subject request (access, erasure, objection) and its due date,
 *  3. the processing limit the gateway applies at dispatch: personal data the PII detector finds in an input must be
 *     a category a record of processing permits for the dispatch's project, or the dispatch is refused.
 *
 * DATA CATEGORIES ARE THE DETECTOR'S CATEGORIES. A record names the categories the PII detector reports (email, phone,
 * national identifiers and so on), so the limit is an exact set comparison over what `detectPII` found, with the same
 * jurisdiction list the PII mode uses. A category the detector cannot see cannot be limited, and is not offered.
 *
 * PERSONAL DATA IS NEVER STORED OR LOGGED. A request holds only a keyed digest of the subject's identifier
 * (`subjectDigest`, computed in the gateway) and an optional reference the admin chooses, such as a ticket number.
 * The identifier itself is typed again whenever the subject's data is located, compared with the digest, and dropped.
 */
import { z } from "zod";
import type { BasePiiCategory, PiiCategory } from "./pii.js";
import { INTERNATIONAL_PII_CATEGORIES } from "./pii-international.js";

/** the categories a record of processing can permit: every category the PII detector can report */
const BASE_CATEGORIES = ["email", "ssn", "credit_card", "phone"] as const satisfies readonly BasePiiCategory[];
export const PRIVACY_DATA_CATEGORIES = [...BASE_CATEGORIES, ...INTERNATIONAL_PII_CATEGORIES] as const satisfies readonly PiiCategory[];
export type PrivacyDataCategory = (typeof PRIVACY_DATA_CATEGORIES)[number];

/** GDPR Article 6(1) bases, in the regulation's order */
export const LAWFUL_BASES = [
  "consent",
  "contract",
  "legal_obligation",
  "vital_interests",
  "public_task",
  "legitimate_interests",
] as const;
export type LawfulBasis = (typeof LAWFUL_BASES)[number];

export const LAWFUL_BASIS_LABELS: Readonly<Record<LawfulBasis, string>> = {
  consent: "Consent",
  contract: "Contract",
  legal_obligation: "Legal obligation",
  vital_interests: "Vital interests",
  public_task: "Public task",
  legitimate_interests: "Legitimate interests",
};

export const PROCESSING_RECORD_STATUSES = ["active", "retired"] as const;
export type ProcessingRecordStatus = (typeof PROCESSING_RECORD_STATUSES)[number];

const shortText = (max: number) => z.string().trim().min(1).max(max);
const categoryList = z.array(z.enum(PRIVACY_DATA_CATEGORIES)).max(PRIVACY_DATA_CATEGORIES.length);
const recipientList = z.array(shortText(200)).max(20);

/** `POST /v1/privacy/processing-records`. A record links to a project, a use case, or both, never neither. */
export const createProcessingRecordSchema = z
  .object({
    name: shortText(160),
    purpose: shortText(2000),
    lawfulBasis: z.enum(LAWFUL_BASES),
    dataCategories: categoryList.min(1),
    retentionDays: z.number().int().min(1).max(36_500),
    recipients: recipientList.default([]),
    projectId: z.string().uuid().nullable().optional(),
    useCaseId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((b) => Boolean(b.projectId) || Boolean(b.useCaseId), {
    message: "link the record to a project or a use case",
    path: ["projectId"],
  });
export type CreateProcessingRecord = z.infer<typeof createProcessingRecordSchema>;

/** `PATCH /v1/privacy/processing-records/:id`. `status: 'retired'` takes the record out of the processing limit. */
export const updateProcessingRecordSchema = z
  .object({
    name: shortText(160).optional(),
    purpose: shortText(2000).optional(),
    lawfulBasis: z.enum(LAWFUL_BASES).optional(),
    dataCategories: categoryList.min(1).optional(),
    retentionDays: z.number().int().min(1).max(36_500).optional(),
    recipients: recipientList.optional(),
    status: z.enum(PROCESSING_RECORD_STATUSES).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "change at least one field" });
export type UpdateProcessingRecord = z.infer<typeof updateProcessingRecordSchema>;

/** a record of processing as every read returns it */
export interface ProcessingRecordView {
  id: string;
  name: string;
  purpose: string;
  lawfulBasis: LawfulBasis;
  dataCategories: PrivacyDataCategory[];
  retentionDays: number;
  recipients: string[];
  projectId: string | null;
  projectName: string | null;
  useCaseId: string | null;
  useCaseName: string | null;
  status: ProcessingRecordStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Does this change widen what the gateway permits? Creating a record, adding a category, or bringing a retired record
 * back each let personal data through that was refused before, so each is a relaxation with a step-up (ADR-0180).
 * Narrowing a record or retiring it only tightens and needs none.
 */
export function processingRecordWidens(
  before: { dataCategories: readonly string[]; status: ProcessingRecordStatus } | null,
  after: { dataCategories: readonly string[]; status: ProcessingRecordStatus },
): boolean {
  if (after.status !== "active") return false;
  if (!before || before.status !== "active") return true;
  const had = new Set(before.dataCategories);
  return after.dataCategories.some((c) => !had.has(c));
}

// ---------------------------------------------------------------------------
// Data-subject requests
// ---------------------------------------------------------------------------

export const DSR_KINDS = ["access", "erasure", "objection"] as const;
export type DsrKind = (typeof DSR_KINDS)[number];
export const DSR_KIND_LABELS: Readonly<Record<DsrKind, string>> = {
  access: "Access",
  erasure: "Erasure",
  objection: "Objection",
};

export const DSR_STATUSES = ["received", "in_progress", "completed", "rejected"] as const;
export type DsrStatus = (typeof DSR_STATUSES)[number];
export const DSR_STATUS_LABELS: Readonly<Record<DsrStatus, string>> = {
  received: "Received",
  in_progress: "In progress",
  completed: "Completed",
  rejected: "Rejected",
};

/** one calendar month is the GDPR Article 12(3) default; 30 days is the strict default an org may shorten */
export const DSR_DEFAULT_SLA_DAYS = 30;
export const DSR_MAX_SLA_DAYS = 90;

/** the identifier a subject is located by: an email address or a phone number, as the detector reads them */
export const DSR_IDENTIFIER_KINDS = ["email", "phone"] as const;
export type DsrIdentifierKind = (typeof DSR_IDENTIFIER_KINDS)[number];

const identifierField = z.string().trim().min(3).max(320);

/** `POST /v1/privacy/requests`. The identifier is digested by the gateway and never stored. */
export const createDsrSchema = z
  .object({
    kind: z.enum(DSR_KINDS),
    identifierKind: z.enum(DSR_IDENTIFIER_KINDS),
    identifier: identifierField,
    reference: shortText(120).nullable().optional(),
    processingRecordId: z.string().uuid().nullable().optional(),
    receivedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type CreateDsr = z.infer<typeof createDsrSchema>;

/** `POST /v1/privacy/requests/:id/locate`: the identifier again, compared with the stored digest */
export const locateDsrSchema = z.object({ identifier: identifierField }).strict();

/** `POST /v1/privacy/requests/:id/close` */
export const closeDsrSchema = z
  .object({
    outcome: z.enum(["completed", "rejected"]),
    note: shortText(2000),
  })
  .strict();

/** the RegulAIt-held stores a subject is located in, and what erasure does to each */
export const DSR_STORES = ["accounts", "conversations", "project_context", "audit_trail"] as const;
export type DsrStore = (typeof DSR_STORES)[number];
export const DSR_STORE_LABELS: Readonly<Record<DsrStore, string>> = {
  accounts: "User accounts",
  conversations: "Conversations",
  project_context: "Shared project context",
  audit_trail: "Audit trail",
};

/**
 * What an erasure does to a store. The audit trail is tamper-evident and is never edited or deleted to erase a subject:
 * the rows stay until their retention rule prunes them, and a tombstone records which rows the erasure covered.
 */
export type DsrErasureAction = "erased" | "tombstoned" | "retained";

/** one store's part of a locate result: counts and ids only, never content */
export interface DsrStoreFinding {
  store: DsrStore;
  matches: number;
  /** what erasure does, or did, to this store */
  erasure: DsrErasureAction;
  /** why this store is handled this way, in plain words */
  note: string;
}

export interface DsrView {
  id: string;
  kind: DsrKind;
  identifierKind: DsrIdentifierKind;
  reference: string | null;
  processingRecordId: string | null;
  status: DsrStatus;
  receivedAt: string;
  dueAt: string;
  overdue: boolean;
  located: DsrStoreFinding[] | null;
  locatedAt: string | null;
  closedAt: string | null;
  closeNote: string | null;
  createdAt: string;
}

/** the due date of a request received at `receivedAt` under an SLA of `slaDays` */
export function dsrDueAt(receivedAt: Date, slaDays: number): Date {
  return new Date(receivedAt.getTime() + slaDays * 86_400_000);
}

export function dsrOverdue(view: { status: DsrStatus; dueAt: Date }, now: Date = new Date()): boolean {
  return (view.status === "received" || view.status === "in_progress") && view.dueAt.getTime() < now.getTime();
}

/** normalise an identifier before it is digested, so one subject always digests to one value */
export function normaliseDsrIdentifier(kind: DsrIdentifierKind, identifier: string): string {
  const t = identifier.trim();
  if (kind === "email") return t.toLowerCase();
  return t.replace(/[^\d+]/g, "");
}

/** the shape check the gateway runs before anything is digested; returns a sentence, never the identifier */
export function dsrIdentifierProblem(kind: DsrIdentifierKind, identifier: string): string | null {
  const n = normaliseDsrIdentifier(kind, identifier);
  if (kind === "email") {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(n) ? null : "enter a full email address";
  }
  return /^\+?\d{7,15}$/.test(n) ? null : "enter a phone number of 7 to 15 digits";
}

// ---------------------------------------------------------------------------
// The processing limit at dispatch
// ---------------------------------------------------------------------------

export const PROCESSING_NOT_PERMITTED = "processing_not_permitted" as const;

/** the categories found that no active record of processing for this dispatch permits */
export function categoriesNotPermitted(
  found: readonly string[],
  permitted: readonly string[],
): string[] {
  const ok = new Set(permitted);
  return [...new Set(found)].filter((c) => !ok.has(c)).sort();
}

/** the refusal sentence: categories and counts only, never the matched text */
export function processingRefusalDetail(args: {
  refused: readonly string[];
  projectAttributed: boolean;
  recordCount: number;
}): string {
  const list = args.refused.join(", ");
  if (!args.projectAttributed) {
    return (
      `this input contains personal data (${list}), and a dispatch that names no project has no record of ` +
      `processing to permit it. Nothing was sent to a provider and nothing was billed. Send it under a project ` +
      `whose record of processing lists these categories.`
    );
  }
  if (args.recordCount === 0) {
    return (
      `this input contains personal data (${list}), and the project has no active record of processing. ` +
      `Nothing was sent to a provider and nothing was billed. An admin records the purpose, lawful basis and ` +
      `data categories under Privacy, Records of processing.`
    );
  }
  return (
    `this input contains personal data (${list}) that no active record of processing for this project permits. ` +
    `Nothing was sent to a provider and nothing was billed. An admin can add the categories to the project's ` +
    `record of processing under Privacy, Records of processing.`
  );
}
