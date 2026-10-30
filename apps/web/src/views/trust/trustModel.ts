/**
 * ADR-0225 (P13 d) — the trust pages' types and pure helpers, shared by the admin page (Trust publishing) and the
 * two public pages (the trust centre and the auditor portal). Mirrors `packages/shared/src/trust-pages.ts`; the web
 * bundle does not import @regulait/shared, so the field lists and labels are repeated here and pinned by
 * trustModel.test.ts.
 */

export type TrustKind = "control" | "evidence_summary" | "ai_card";
export type TrustStatus = "draft" | "published";
export type TrustAudience = "public" | "auditors";

export interface TrustPublication {
  id: string;
  kind: TrustKind;
  slug: string;
  sourceRef: string;
  title: string;
  content: Record<string, string>;
  status: TrustStatus;
  audience: TrustAudience;
  version: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicItem {
  slug: string;
  kind: TrustKind;
  title: string;
  content: Record<string, string>;
  publishedAt: string;
}

export interface PublicTrustCenter {
  displayName: string;
  intro: string;
  contactEmail: string | null;
  items: PublicItem[];
  disclaimer: string;
}

export interface AuditorGrant {
  id: string;
  auditorName: string;
  auditorEmail: string;
  auditorOrganisation: string | null;
  startsAt: string;
  expiresAt: string;
  revokedAt: string | null;
  state: "scheduled" | "active" | "expired" | "revoked";
  items: number;
  views: number;
  lastViewedAt: string | null;
}

export const CONTROL_FIELDS = ["statement", "evidenceSummary"] as const;
export const AI_CARD_FIELDS = ["purpose", "limits", "oversight", "dataUse", "evaluationSummary"] as const;
export type ContentField = (typeof CONTROL_FIELDS)[number] | (typeof AI_CARD_FIELDS)[number];

export const FIELD_LABELS: Readonly<Record<ContentField, string>> = {
  statement: "What this control is",
  evidenceSummary: "Evidence on record",
  purpose: "Purpose",
  limits: "Known limits",
  oversight: "Human oversight",
  dataUse: "Data use",
  evaluationSummary: "Evaluation summary",
};

export const KIND_LABELS: Readonly<Record<TrustKind, string>> = {
  control: "Control",
  evidence_summary: "Evidence summary",
  ai_card: "AI system card",
};

export const fieldsFor = (kind: TrustKind): readonly ContentField[] => (kind === "ai_card" ? AI_CARD_FIELDS : CONTROL_FIELDS);

export const FIELD_MAX = 4000;
export const AUDITOR_MAX_DAYS = 90;
export const LINK_TTL = { min: 1, max: 72, default: 24 } as const;

/**
 * The same claim words the gateway refuses at publish (`claimWordingProblems` in @regulait/shared). Shown while
 * editing, so the requirement is visible at the point of decision rather than only as a refusal.
 */
const CLAIM_PATTERNS: ReadonlyArray<{ re: RegExp; word: string }> = [
  { re: /\bcertified\b/i, word: "certified" },
  { re: /\bcompliant\b/i, word: "compliant" },
  { re: /\bnon-compliant\b/i, word: "non-compliant" },
  { re: /\baccredited\b/i, word: "accredited" },
  { re: /\bguarantee[sd]?\b/i, word: "guarantee" },
  { re: /\bcompl(?:y|ies)\s+with\b/i, word: "complies with" },
  { re: /\bin\s+compliance\s+with\b/i, word: "in compliance with" },
  { re: /\bfully\s+meets?\b/i, word: "fully meets" },
];

export function claimWords(text: string): string[] {
  const found: string[] = [];
  for (const p of CLAIM_PATTERNS) if (p.re.test(text) && !found.includes(p.word)) found.push(p.word);
  return found;
}

/** what stops a draft from being published, in words; empty when it can be published */
export function publishBlockers(p: Pick<TrustPublication, "kind" | "title" | "content">): string[] {
  const out: string[] = [];
  const empty = fieldsFor(p.kind).filter((f) => !(p.content[f] ?? "").trim());
  if (empty.length) out.push(`Fill in: ${empty.map((f) => FIELD_LABELS[f]).join(", ")}.`);
  const words = claimWords([p.title, ...Object.values(p.content)].join("\n"));
  if (words.length) out.push(`Reword the claim words: ${words.join(", ")}. Trust pages state facts, never a certification or compliance.`);
  return out;
}

/** the sign-in token carried in the URL fragment of an auditor link (`/ui/audit#rgal_…`), or null */
export function tokenFromHash(hash: string): string | null {
  const t = hash.replace(/^#/, "").trim();
  return /^rgal_[0-9a-f]{64}$/.test(t) ? t : null;
}

/** the absolute link an admin copies for the auditor (built from the page's own origin, never a request header) */
export const absoluteLink = (origin: string, path: string) => `${origin.replace(/\/+$/, "")}${path}`;

export const GRANT_STATE_TONE: Readonly<Record<AuditorGrant["state"], "ok" | "info" | "neutral" | "danger">> = {
  active: "ok",
  scheduled: "info",
  expired: "neutral",
  revoked: "danger",
};
