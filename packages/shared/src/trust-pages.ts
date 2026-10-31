/**
 * ADR-0225 (P13 d, owner 2026-10-30) — OUTWARD TRUST PAGES: a public trust centre, per-system AI cards and a named
 * external auditor's read-only portal.
 *
 * Everything here is shared by the gateway (`apps/gateway/src/trust-pages.ts`) and the web screens:
 *  - the ONE org setting, `trustPagesEnabled`, strict default `false` (ADR-0180). It rides the audited
 *    `PUT /v1/org/settings`; turning it on is a relaxation and needs the `settings_relax` step-up;
 *  - the request bodies of the admin routes, with their bounds;
 *  - THE WORDING GUARD. A trust page states facts: what a control is, what the ledger holds, what a system is for.
 *    It never claims a certification or compliance. `claimWordingProblems` finds the words that would make such a
 *    claim, and publishing refuses text that contains any of them.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// The org setting
// ---------------------------------------------------------------------------

/** THE STRICT DEFAULT. The column default of migration 0247. */
export const TRUST_PAGES_STRICT_DEFAULTS = Object.freeze({
  trustPagesEnabled: false as boolean,
});
export type TrustPagesSettings = { -readonly [K in keyof typeof TRUST_PAGES_STRICT_DEFAULTS]: (typeof TRUST_PAGES_STRICT_DEFAULTS)[K] };
export type TrustPagesSettingKey = keyof TrustPagesSettings;
export const TRUST_PAGES_SETTING_KEYS = Object.keys(TRUST_PAGES_STRICT_DEFAULTS) as TrustPagesSettingKey[];

/** What the strict default does, and what an admin gives up by relaxing it. */
export const TRUST_PAGES_SETTING_COPY: Readonly<Record<TrustPagesSettingKey, { label: string; strict: string; relaxed: string }>> = {
  trustPagesEnabled: {
    label: "Public trust pages and auditor access",
    strict: "Off: nothing is published outside the organisation, and no external auditor can be given access.",
    relaxed:
      "On lets an admin publish chosen controls, evidence summaries and AI system cards on a public page anyone can " +
      "read, and give a named auditor time-limited, read-only access to chosen items. Each publication and each " +
      "auditor view is audited.",
  },
};

/** Is `value` a relaxation of the strict default? */
export function trustPagesSettingRelaxed<K extends TrustPagesSettingKey>(key: K, value: TrustPagesSettings[K]): boolean {
  return key === "trustPagesEnabled" && value === true;
}

/** The fields of `PUT /v1/org/settings` (spread into `updateOrgSettingsSchema`). */
export const trustPagesOrgSettingsFields = {
  /** strict false; true relaxes it (public pages and auditor access, built and shipped off) */
  trustPagesEnabled: z.boolean().optional(),
};

// ---------------------------------------------------------------------------
// Publications
// ---------------------------------------------------------------------------

export const TRUST_PUBLICATION_KINDS = ["control", "evidence_summary", "ai_card"] as const;
export type TrustPublicationKind = (typeof TRUST_PUBLICATION_KINDS)[number];
export const TRUST_PUBLICATION_STATUSES = ["draft", "published"] as const;
export type TrustPublicationStatus = (typeof TRUST_PUBLICATION_STATUSES)[number];
/** `public`: on the trust centre (and selectable for auditors); `auditors`: only through an auditor grant */
export const TRUST_AUDIENCES = ["public", "auditors"] as const;
export type TrustAudience = (typeof TRUST_AUDIENCES)[number];

/** The fields of a control or an evidence summary, in display order. */
export const CONTROL_CONTENT_FIELDS = ["statement", "evidenceSummary"] as const;
/** The fields of an AI system card, in display order. */
export const AI_CARD_CONTENT_FIELDS = ["purpose", "limits", "oversight", "dataUse", "evaluationSummary"] as const;
export type ControlContentField = (typeof CONTROL_CONTENT_FIELDS)[number];
export type AiCardContentField = (typeof AI_CARD_CONTENT_FIELDS)[number];
export type TrustContentField = ControlContentField | AiCardContentField;

export const TRUST_CONTENT_LABELS: Readonly<Record<TrustContentField, string>> = {
  statement: "What this control is",
  evidenceSummary: "Evidence on record",
  purpose: "Purpose",
  limits: "Known limits",
  oversight: "Human oversight",
  dataUse: "Data use",
  evaluationSummary: "Evaluation summary",
};

export function contentFieldsFor(kind: TrustPublicationKind): readonly TrustContentField[] {
  return kind === "ai_card" ? AI_CARD_CONTENT_FIELDS : CONTROL_CONTENT_FIELDS;
}

export const TRUST_TITLE_MAX = 200;
export const TRUST_FIELD_MAX = 4000;

const title = z.string().trim().min(1).max(TRUST_TITLE_MAX);
const field = z.string().max(TRUST_FIELD_MAX);
const controlContent = z.object({ statement: field, evidenceSummary: field }).strict();
const aiCardContent = z
  .object({ purpose: field, limits: field, oversight: field, dataUse: field, evaluationSummary: field })
  .strict();

/** `POST /v1/trust/publications/from-control` — a draft from one control of an active compliance pack */
export const draftFromControlSchema = z
  .object({ packId: z.string().uuid(), controlRef: z.string().min(1).max(200), kind: z.enum(["control", "evidence_summary"]) })
  .strict();
/** `POST /v1/trust/publications/from-use-case` — an AI system card drafted from the use-case register */
export const draftFromUseCaseSchema = z.object({ useCaseId: z.string().uuid() }).strict();

/** `PATCH /v1/trust/publications/:id` — edit a DRAFT; `expectedVersion` is the version the editor read */
export const updatePublicationSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    title: title.optional(),
    content: z.union([controlContent, aiCardContent]).optional(),
  })
  .strict();

/** `POST /v1/trust/publications/:id/publish` */
export const publishPublicationSchema = z
  .object({ expectedVersion: z.number().int().min(1), audience: z.enum(TRUST_AUDIENCES) })
  .strict();

/** `POST /v1/trust/publications/:id/unpublish` */
export const unpublishPublicationSchema = z.object({ expectedVersion: z.number().int().min(1) }).strict();

/** the content a publication of `kind` must carry (every field present, nothing else) */
export function contentSchemaFor(kind: TrustPublicationKind) {
  return kind === "ai_card" ? aiCardContent : controlContent;
}

/** `PUT /v1/trust/profile` */
export const trustProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    intro: z.string().max(2000).default(""),
    contactEmail: z.string().trim().email().max(254).nullable().default(null),
  })
  .strict();

// ---------------------------------------------------------------------------
// The wording guard
// ---------------------------------------------------------------------------

/**
 * Words that would make a trust page CLAIM a certification, an accreditation, compliance or a guarantee. A trust page
 * says what a control is and what evidence is on record; whether that amounts to compliance is an auditor's judgement,
 * never ours. Matching is whole-word and case-insensitive. "Certification" and "certificate" alone are not here: they
 * also name an access review ("certification campaign") and a control ("certificate rotation") and state no claim; a
 * named standard's certificate or certification, and holding or achieving one, are.
 */
const CLAIM_PATTERNS: ReadonlyArray<{ re: RegExp; word: string }> = [
  { re: /\bcertified\b/i, word: "certified" },
  { re: /\bcertificated\b/i, word: "certificated" },
  { re: /\bcompliant\b/i, word: "compliant" },
  { re: /\bnon-compliant\b/i, word: "non-compliant" },
  { re: /\baccredited\b/i, word: "accredited" },
  { re: /\bguarantee[sd]?\b/i, word: "guarantee" },
  { re: /\bcompl(?:y|ies)\s+with\b/i, word: "complies with" },
  { re: /\bcompliance\s+with\b/i, word: "compliance with" },
  { re: /\bconform(?:s|ed|ing)?\s+to\b/i, word: "conforms to" },
  { re: /\bfully\s+meets?\b/i, word: "fully meets" },
  { re: /\bmeets?\s+(?:all\s+)?(?:of\s+)?(?:the\s+)?requirements\b/i, word: "meets the requirements" },
  { re: /\bcertificate\s+of\s+(?:compliance|conformity)\b/i, word: "certificate of compliance" },
  // a named standard's certificate or certification ("ISO 27001 certification", "SOC 2 certificate")
  { re: /\b(?:iso(?:\/iec)?\s*\d{4,5}|soc\s*[123]|pci[\s-]*dss|hitrust|fedramp)\s+certific(?:ate|ation)\b/i, word: "a standard's certification" },
  // holding or winning one ("we hold the certification", "achieved ... certification")
  {
    re: /\b(?:hold|holds|held|achieved|obtained|awarded|attained|earned)\s+(?:an?\s+|the\s+|our\s+)?(?:[\w./-]+\s+){0,4}certific(?:ate|ation)\b/i,
    word: "holds a certification",
  },
];

/** the claim words found in `text` (empty when it states facts only) */
export function claimWordingProblems(text: string): string[] {
  const found: string[] = [];
  for (const p of CLAIM_PATTERNS) if (p.re.test(text) && !found.includes(p.word)) found.push(p.word);
  return found;
}

// ---------------------------------------------------------------------------
// Auditor access
// ---------------------------------------------------------------------------

export const AUDITOR_GRANT_MAX_DAYS = 90;
export const AUDITOR_LINK_TTL_HOURS = { min: 1, max: 72, default: 24 } as const;
/** an auditor session lasts this long from the link's redemption, and never past the grant's end */
export const AUDITOR_SESSION_MINUTES = 60;
export const AUDITOR_GRANT_MAX_ITEMS = 200;
/** the sign-in link's token prefix (256 random bits follow, hex) */
export const AUDITOR_LINK_TOKEN_PREFIX = "rgal_";
/** the session cookie (HttpOnly, SameSite=Strict, Path=/v1/auditor) */
export const AUDITOR_SESSION_COOKIE = "regulait_auditor";
/** public rate limits (per address, and per grant for the portal) */
export const TRUST_PUBLIC_RATE_LIMITS = {
  perAddress: { max: 60, windowMs: 60_000 },
  perGrant: { max: 300, windowMs: 60_000 },
} as const;

const linkTtl = z.number().int().min(AUDITOR_LINK_TTL_HOURS.min).max(AUDITOR_LINK_TTL_HOURS.max);

/** `POST /v1/trust/auditor-grants` */
export const createAuditorGrantSchema = z
  .object({
    auditorName: z.string().trim().min(1).max(120),
    auditorEmail: z.string().trim().email().max(254),
    auditorOrganisation: z.string().trim().max(120).nullable().default(null),
    /** the window starts now unless a later start is given */
    startsAt: z.string().datetime({ offset: true }).optional(),
    days: z.number().int().min(1).max(AUDITOR_GRANT_MAX_DAYS),
    publicationIds: z
      .array(z.string().uuid())
      .min(1)
      .max(AUDITOR_GRANT_MAX_ITEMS)
      .refine((a) => new Set(a).size === a.length, "each item at most once"),
    linkTtlHours: linkTtl.default(AUDITOR_LINK_TTL_HOURS.default),
  })
  .strict();

/** `POST /v1/trust/auditor-grants/:grantId/links` — a new sign-in link (earlier unused links are revoked) */
export const newAuditorLinkSchema = z.object({ linkTtlHours: linkTtl.default(AUDITOR_LINK_TTL_HOURS.default) }).strict();

/** `POST /v1/auditor/session` — the token from the link's fragment, never from a URL path or query */
export const redeemAuditorLinkSchema = z.object({ token: z.string().min(1).max(200) }).strict();

// ---------------------------------------------------------------------------
// What the public pages receive (no internal id, no tenant data beyond what was published)
// ---------------------------------------------------------------------------

export interface PublicTrustItem {
  slug: string;
  kind: TrustPublicationKind;
  title: string;
  content: Record<string, string>;
  publishedAt: string;
}

export interface PublicTrustCenter {
  displayName: string;
  intro: string;
  contactEmail: string | null;
  items: PublicTrustItem[];
  /** the factual footnote every page carries */
  disclaimer: string;
}

export const TRUST_PAGE_DISCLAIMER =
  "These pages are published by the organisation. They describe controls, the evidence on record and how its AI " +
  "systems are used. They are not a certification and do not state compliance with any standard or law.";
