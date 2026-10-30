/**
 * ADR-0221 (PENDING P4) — the supplier portal's shared contract: limits, the cookie and token shapes, and the request
 * schemas of both the admin routes and the supplier routes. The gateway enforces every limit here; the database
 * CHECKs in migrations 0241-0242 repeat the ones a row written around the API must not break.
 */
import { z } from "zod";

export const SUPPLIER_PORTAL_LIMITS = Object.freeze({
  /** a sign-in link lives at most this long (database CHECK: 72 hours) */
  inviteHoursMax: 72,
  inviteHoursDefault: 24,
  /** a grant lives at most this long (database CHECK: 30 days) */
  accessDaysMax: 30,
  accessDaysDefault: 14,
  /** a supplier session ends after this long without a request */
  sessionIdleMinutes: 30,
  /** and after this long whatever happens (database CHECK: 8 hours) */
  sessionAbsoluteHours: 8,
  /** one evidence file, raw bytes */
  fileMaxBytes: 2 * 1024 * 1024,
  statementMax: 4000,
  /** per address, per 15 minutes, across every supplier route */
  perAddress: { max: 60, windowMs: 15 * 60_000 },
  /** per grant, per 15 minutes, for submissions */
  perAccessSubmissions: { max: 30, windowMs: 15 * 60_000 },
});

/** the cookie a spent sign-in link becomes; HttpOnly, Secure, SameSite=Strict, scoped to the supplier API path */
export const SUPPLIER_SESSION_COOKIE = "regulait_supplier";
export const SUPPLIER_API_PREFIX = "/supplier/v1";
/** the plaintext prefixes of the two supplier tokens; only their sha256 is stored */
export const SUPPLIER_INVITE_TOKEN_PREFIX = "rglsi_";
export const SUPPLIER_SESSION_TOKEN_PREFIX = "rglss_";
/** prefix + 43 base64url characters (32 random bytes); linear, no nested quantifiers */
export const SUPPLIER_INVITE_TOKEN_RE = /^rglsi_[A-Za-z0-9_-]{43}$/;
export const SUPPLIER_SESSION_TOKEN_RE = /^rglss_[A-Za-z0-9_-]{43}$/;

/** the file types a supplier may upload, detected from the bytes, never from the declared name */
export const SUPPLIER_FILE_TYPES = ["application/pdf", "image/png", "image/jpeg", "text/plain", "text/csv"] as const;
export type SupplierFileType = (typeof SUPPLIER_FILE_TYPES)[number];

export const SUPPLIER_SUBMISSION_STATUSES = ["submitted", "accepted", "rejected"] as const;
export type SupplierSubmissionStatus = (typeof SUPPLIER_SUBMISSION_STATUSES)[number];

/** the one answer every refused supplier sign-in gets, whatever the reason (no enumeration) */
export const SUPPLIER_LINK_REFUSAL = Object.freeze({
  error: "link_not_valid",
  detail: "This link cannot be used. It may have expired or already been used. Ask your contact for a new link.",
});
/** the one answer a supplier request without a live session gets */
export const SUPPLIER_SESSION_REFUSAL = Object.freeze({
  error: "session_not_valid",
  detail: "Your session has ended. Open the most recent link you were sent, or ask your contact for a new one.",
});

const QUESTION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** one @, no whitespace; length-bounded before the regex runs */
const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

export const supplierQuestionSchema = z
  .object({
    id: z.string().regex(QUESTION_ID_RE),
    prompt: z.string().trim().min(1).max(1000),
    help: z.string().trim().max(2000).default(""),
    required: z.boolean().default(true),
    allowFile: z.boolean().default(false),
    controlRef: z.string().trim().min(1).max(200).nullable().default(null),
  })
  .strict();
export type SupplierQuestionInput = z.infer<typeof supplierQuestionSchema>;

const questionsSchema = z
  .array(supplierQuestionSchema)
  .min(1)
  .max(100)
  .refine((qs) => new Set(qs.map((q) => q.id)).size === qs.length, { message: "question ids must be unique" });

export const createSupplierQuestionnaireSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).default(""),
    questions: questionsSchema,
  })
  .strict();
export type CreateSupplierQuestionnaireInput = z.infer<typeof createSupplierQuestionnaireSchema>;

/** a new version of an existing questionnaire (the name is kept) */
export const publishSupplierQuestionnaireVersionSchema = z
  .object({
    description: z.string().trim().max(2000).default(""),
    questions: questionsSchema,
  })
  .strict();

export const supplierPortalSettingsSchema = z.object({ enabled: z.boolean() }).strict();

export const createSupplierAccessSchema = z
  .object({
    email: z
      .string()
      .trim()
      .min(3)
      .max(254)
      .regex(EMAIL_RE)
      .transform((e) => e.toLowerCase()),
    framework: z.string().min(1).max(64),
    questionnaireId: z.string().uuid().nullable().default(null),
    accessDays: z.number().int().min(1).max(SUPPLIER_PORTAL_LIMITS.accessDaysMax).default(SUPPLIER_PORTAL_LIMITS.accessDaysDefault),
    inviteHours: z.number().int().min(1).max(SUPPLIER_PORTAL_LIMITS.inviteHoursMax).default(SUPPLIER_PORTAL_LIMITS.inviteHoursDefault),
  })
  .strict();
export type CreateSupplierAccessInput = z.infer<typeof createSupplierAccessSchema>;

export const reissueSupplierInvitationSchema = z
  .object({
    inviteHours: z.number().int().min(1).max(SUPPLIER_PORTAL_LIMITS.inviteHoursMax).default(SUPPLIER_PORTAL_LIMITS.inviteHoursDefault),
  })
  .strict();

export const revokeSupplierAccessSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

export const supplierSessionStartSchema = z.object({ token: z.string().min(1).max(100) }).strict();

export const supplierSubmissionSchema = z
  .object({
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("control"), controlRef: z.string().min(1).max(200) }).strict(),
      z.object({ kind: z.literal("question"), questionId: z.string().regex(QUESTION_ID_RE) }).strict(),
    ]),
    statement: z.string().trim().min(1).max(SUPPLIER_PORTAL_LIMITS.statementMax),
    file: z
      .object({
        name: z.string().trim().min(1).max(200),
        /** standard base64 of the raw bytes; the size limit is checked again on the decoded bytes */
        base64: z.string().min(4).max(Math.ceil(SUPPLIER_PORTAL_LIMITS.fileMaxBytes / 3) * 4 + 4),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SupplierSubmissionInput = z.infer<typeof supplierSubmissionSchema>;

export const decideSupplierSubmissionSchema = z
  .object({
    decision: z.enum(["accept", "reject"]),
    reason: z.string().trim().min(1).max(2000).optional(),
    evidenceRef: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((b) => b.decision === "accept" || b.reason !== undefined, {
    message: "a rejection needs a reason the supplier's contact can act on",
    path: ["reason"],
  });
export type DecideSupplierSubmissionInput = z.infer<typeof decideSupplierSubmissionSchema>;
