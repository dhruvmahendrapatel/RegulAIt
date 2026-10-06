/**
 * ADR-0182 (ADR-0175 batch D4) A14 — AI LITERACY AND ACCEPTABLE USE: the pure half.
 *
 * Regulation (EU) 2024/1689 Article 4, as replaced by Regulation (EU) 2026/1744, asks providers and deployers to
 * "take measures to support the development of AI literacy" of their staff and of other persons dealing with the
 * operation and use of AI systems on their behalf, and states that it "does not require providers or deployers to
 * guarantee any specific level of AI literacy of any individual". regulAIt records one such measure: versioned AI
 * policies and trainings, who they apply to, and who has acknowledged (or completed) their current version. It
 * measures acknowledgement, never literacy itself.
 *
 * Everything here is a pure function of its inputs, so the gateway's enforcement, its ABAC attribute, the coverage
 * report, the monitor and the web read ONE definition:
 *
 *   - `audienceIncludes`   does a document's audience (everyone, teams, roles) take in this person;
 *   - `acceptedVersions`   which versions' acknowledgements still count for the published one: the published version
 *                          itself, and — only across EDITORIAL versions an admin marked with a reason — the version it
 *                          replaced, recursively. A material version accepts only itself (no grace period, owner
 *                          decision 3);
 *   - `literacyStatusOf`   a person's standing: `required` = at least one published document applies to them,
 *                          `current` = every one of them is acknowledged at an accepted version and unexpired;
 *   - `aiLiteracyCurrent`  that `current` as a boolean;
 *   - `aiTrainingCurrentOf` the Cedar principal attribute (schema v3): current AND required, so a policy that
 *                          requires current training is never satisfied vacuously by an org that published nothing.
 *
 * Does not import the package barrel (index.ts re-exports this file).
 */
import { canonicalJson, sha256Hex } from "./audit-chain.js";
import type {
  AiPolicyAckMethod,
  AiPolicyAudience,
  AiPolicyKind,
  LiteracyDocumentStatus,
  LiteracyStatus,
} from "./accountability.js";

/** `literacy-expiry-sweep` notifies a person this many days before an acknowledgement expires */
export const LITERACY_EXPIRY_NOTICE_DAYS = 14;

/** the kernel's refusal rule id (policy-kernel `LITERACY_RULE_ID` carries the same string) */
export const AI_LITERACY_NOT_CURRENT = "ai-literacy-not-current";

/** the amended Article 4 wording, for copy that cites it (never "ensure", never "guarantee") */
export const AI_LITERACY_ARTICLE_4_TEXT =
  "Regulation (EU) 2024/1689, Article 4 as replaced by Regulation (EU) 2026/1744: providers and deployers take " +
  "measures to support the development of AI literacy of their staff and other persons dealing with AI systems on " +
  "their behalf. It does not require any specific level of AI literacy of any individual.";

/**
 * D4A-04: the only link an AI policy may carry is an `https:` address. The schema refuses anything else at write
 * time, and every page renders a stored link through this helper, so a `javascript:` or `data:` value (or a row
 * written before the rule) is shown as text and never becomes a link a person is asked to open. A one-line scheme
 * allow-list on the platform `URL` parser; a URL-sanitising library (considered: @braintree/sanitize-url, MIT)
 * would add a dependency for the same single check.
 */
export function aiPolicyHref(url: string | null | undefined): string | null {
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** the instant an acknowledgement made at `at` expires: whole UTC days, the earliest reasonable reading */
export function ackExpiresAt(at: Date, validityDays: number): Date {
  return new Date(at.getTime() + validityDays * DAY_MS);
}

/** the content digest of one document version: what a person acknowledges is exactly this text and source */
export function aiPolicyContentDigest(doc: {
  key: string;
  kind: AiPolicyKind;
  version: number;
  title: string;
  url: string | null;
  attachmentId: string | null;
}): string {
  return sha256Hex(
    canonicalJson({
      key: doc.key,
      kind: doc.kind,
      version: doc.version,
      title: doc.title,
      url: doc.url ?? null,
      attachmentId: doc.attachmentId ?? null,
    }),
  );
}

/** the memberships a document's audience is matched against */
export interface LiteracyMemberships {
  teamIds: readonly string[];
  roleIds: readonly string[];
}

/** does the audience take in a person with these memberships? `all` is everyone. A malformed audience (not an
 * object) is read as everyone: a document that cannot say who it is for applies to all, never to nobody. */
export function audienceIncludes(audience: AiPolicyAudience | null | undefined, m: LiteracyMemberships): boolean {
  if (!audience || typeof audience !== "object" || audience.all !== false) return true;
  const teams = new Set(m.teamIds);
  const roles = new Set(m.roleIds);
  return (audience.teamIds ?? []).some((t) => teams.has(t)) || (audience.roleIds ?? []).some((r) => roles.has(r));
}

/** one version of a key, as far as the editorial chain needs it */
export interface AiPolicyVersionFact {
  version: number;
  editorial: boolean;
  /** null = never published (a draft); a retired version keeps its publication time */
  publishedAt: Date | string | null;
}

/**
 * The versions whose acknowledgements count for the published version `current`.
 *
 * Always `current` itself. When `current` is EDITORIAL, also the version it replaced — the highest earlier version
 * that was ever published — and so on while that one is editorial too. A material version stops the walk, so a new
 * material version accepts only acknowledgements of itself: no grace period (owner decision 3).
 */
export function acceptedVersions(history: readonly AiPolicyVersionFact[], current: number): number[] {
  const published = history
    .filter((h) => h.publishedAt !== null && h.publishedAt !== undefined)
    .sort((a, b) => b.version - a.version);
  const out = [current];
  let at = published.find((h) => h.version === current);
  while (at && at.editorial) {
    const v = at.version;
    const prior = published.find((h) => h.version < v);
    if (!prior) break;
    out.push(prior.version);
    at = prior;
  }
  return out;
}

/** a published document that applies to the person, with the versions whose acknowledgement counts */
export interface LiteracyDocumentInput {
  documentId: string;
  key: string;
  version: number;
  kind: AiPolicyKind;
  title: string;
  /** from `acceptedVersions`; always contains `version` */
  acceptedVersions: readonly number[];
}

/** one acknowledgement (or recorded completion) the person holds */
export interface LiteracyAckInput {
  key: string;
  version: number;
  method: AiPolicyAckMethod;
  acknowledgedAt: Date | string;
  expiresAt: Date | string;
}

const ms = (d: Date | string) => (d instanceof Date ? d.getTime() : Date.parse(d));
const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

/** one document's state for a person, with the acknowledgement it rests on */
export interface LiteracyDocumentStanding extends LiteracyDocumentStatus {
  /** how the counted acknowledgement was made, when there is one */
  method: AiPolicyAckMethod | null;
  /** the version that counted acknowledgement was made at (an earlier one only across editorial versions) */
  acknowledgedVersion: number | null;
}

/** `LiteracyStatus` with each document's counted acknowledgement */
export interface LiteracyStanding extends Omit<LiteracyStatus, "documents"> {
  documents: LiteracyDocumentStanding[];
}

/**
 * A person's standing on each applicable document.
 *
 *   current     an acknowledgement at an accepted version, unexpired at `now`;
 *   expired     an acknowledgement at an accepted version, every one expired;
 *   superseded  only acknowledgements of versions a material version replaced;
 *   missing     none at all for this key.
 *
 * With several acknowledgements at accepted versions, the one that expires latest counts.
 */
export function literacyStatusOf(
  documents: readonly LiteracyDocumentInput[],
  acknowledgements: readonly LiteracyAckInput[],
  now: Date,
): LiteracyStanding {
  const t = now.getTime();
  const out: LiteracyDocumentStanding[] = documents.map((d) => {
    const forKey = acknowledgements.filter((a) => a.key === d.key);
    const accepted = forKey
      .filter((a) => d.acceptedVersions.includes(a.version))
      .sort((a, b) => ms(b.expiresAt) - ms(a.expiresAt));
    const best = accepted[0];
    const state: LiteracyDocumentStatus["state"] = best
      ? ms(best.expiresAt) > t
        ? "current"
        : "expired"
      : forKey.length > 0
        ? "superseded"
        : "missing";
    return {
      documentId: d.documentId,
      key: d.key,
      version: d.version,
      kind: d.kind,
      title: d.title,
      state,
      acknowledgedAt: best ? iso(best.acknowledgedAt) : null,
      expiresAt: best ? iso(best.expiresAt) : null,
      method: best?.method ?? null,
      acknowledgedVersion: best?.version ?? null,
    };
  });
  return {
    required: out.length > 0,
    current: out.every((d) => d.state === "current"),
    documents: out,
  };
}

/** `aiLiteracyCurrent(user)`: every applicable published document acknowledged at its current (or an editorially
 * equivalent) version and unexpired. Vacuously true when nothing applies — the gate then has nothing to ask. */
export function aiLiteracyCurrent(
  documents: readonly LiteracyDocumentInput[],
  acknowledgements: readonly LiteracyAckInput[],
  now: Date,
): boolean {
  return literacyStatusOf(documents, acknowledgements, now).current;
}

/** the Cedar principal attribute `aiTrainingCurrent` (schema v3): true only when at least one published document
 * applies AND every one is current. Never vacuously true, so a policy that requires current training for a
 * sensitive tool is not satisfied by an organisation that published nothing. */
export function aiTrainingCurrentOf(status: Pick<LiteracyStatus, "required" | "current">): boolean {
  return status.required && status.current;
}

/** the documents a person still has to acknowledge, as the refusal and the interstitial name them */
export function literacyMissing(status: { documents: readonly LiteracyDocumentStatus[] }): string[] {
  return status.documents
    .filter((d) => d.state !== "current")
    .map((d) => `"${d.title}" (${d.key} v${d.version}, ${d.state})`);
}

/** is an acknowledgement inside the notice window before it expires? */
export function expiresWithinNotice(expiresAt: Date | string | null, now: Date, days = LITERACY_EXPIRY_NOTICE_DAYS): boolean {
  if (expiresAt === null) return false;
  const e = ms(expiresAt);
  return e > now.getTime() && e <= now.getTime() + days * DAY_MS;
}

/** coverage of one document over its audience */
export function coveragePct(current: number, audience: number): number {
  if (audience <= 0) return 100;
  return Math.floor((current * 100) / audience);
}
