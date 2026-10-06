/**
 * Pure, deterministic PII detector (pillar 3, §8.4). No LLM, no I/O — a total
 * function over its input string. It returns per-category COUNTS only and
 * NEVER the matched substrings, so a caller that logs its result is §8.4-safe
 * by construction (log metadata, never matched PII content).
 *
 * The four categories are deliberately conservative: an email pattern, a
 * bounded US SSN, a Luhn-validated 13–19 digit credit-card run, and a
 * separator-bearing US phone. The credit-card Luhn check and the SSN bounds
 * exist to cut the false positives a naive digit-run regex would produce.
 */

import {
  INTERNATIONAL_DETECTORS,
  type InternationalPiiCategory,
  type PiiMatchVisitor,
} from "./pii-international.js";

/** The four original, live-verified categories. Named separately so the
 * boundary between "what this detector has always done" and "what a
 * deployment opted into" is visible in the type system, not just in prose. */
export type BasePiiCategory = "email" | "ssn" | "credit_card" | "phone";

export type PiiCategory = BasePiiCategory | InternationalPiiCategory;

/** A per-category hit: how MANY matches of `category` were found — never what
 * they were. */
export interface PiiHit {
  category: PiiCategory;
  count: number;
}

// Email: a pragmatic RFC-lite pattern. Global so we can count every match.
// Matched by `visitEmails` (linear time); this regex is its specification.
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// US SSN: AAA-GG-SSSS with the standard invalid-range exclusions — area
// 000/666/900-999, group 00, serial 0000 are never issued.
const SSN_RE = /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;

// Credit-card candidate: a 13–19 digit run, optionally grouped by single
// spaces or hyphens. Each candidate is Luhn-validated before it counts, so an
// arbitrary long number (an id, a nonce) does not read as a card.
const CC_CANDIDATE_RE = /\d(?:[ -]?\d){12,18}/g;

// US phone: 3-3-4 with MANDATORY separators (space, dot, or hyphen) between
// groups, optional +1 and optional parens on the area code. Requiring a
// separator keeps a bare 10-digit id from reading as a phone number.
const PHONE_RE = /(?:\+?1[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}\b/g;

/** Luhn checksum — true when `digits` (a pure-digit string) passes. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48; // '0' = 48
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const isEmailLocalChar = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45;
const isEmailDomainChar = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 45;
const isAsciiLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

/**
 * Every match of EMAIL_RE, left to right, in linear time (ADR-0184 review).
 * The regex restarts its greedy local part at every character of a long run
 * with no usable `@` after it (`ab.ab.ab.…`), so it cost the square of the run:
 * 40,000 characters took 1.7 s, on a path every guardrailed prompt takes.
 *
 * Same matches: a match needs an `@`; its local part is the run of local
 * characters right before that `@` (back to the previous match's end), all of
 * which reach the same `@`, so the regex's leftmost start is the run's start.
 * Its domain is the run of domain characters after the `@`; the greedy
 * `[A-Za-z0-9.-]+\.[A-Za-z]{2,}` backtracks to the LAST dot in that run that has
 * at least one domain character before it and two letters after it, then takes
 * every letter that follows. `pii.test.ts` checks this against EMAIL_RE.
 */
export function visitEmails(text: string, onMatch: PiiMatchVisitor): void {
  const n = text.length;
  let lastEnd = 0;
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    let start = at;
    while (start > lastEnd && isEmailLocalChar(text.charCodeAt(start - 1))) start -= 1;
    if (start === at) continue;
    let runEnd = at + 1;
    while (runEnd < n && isEmailDomainChar(text.charCodeAt(runEnd))) runEnd += 1;
    let dot = runEnd - 3;
    while (dot >= at + 2) {
      if (text.charCodeAt(dot) === 46 && isAsciiLetter(text.charCodeAt(dot + 1)) && isAsciiLetter(text.charCodeAt(dot + 2))) break;
      dot -= 1;
    }
    if (dot < at + 2) continue;
    let end = dot + 3;
    while (end < n && isAsciiLetter(text.charCodeAt(end))) end += 1;
    onMatch(start, end);
    lastEnd = end;
    at = end - 1;
  }
}

function visitMatches(text: string, pattern: RegExp, onMatch: PiiMatchVisitor): void {
  const re = new RegExp(pattern.source, pattern.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    onMatch(m.index, m.index + m[0].length);
  }
}

function visitPII(
  text: string,
  international: readonly InternationalPiiCategory[],
  onMatch: (category: PiiCategory, start: number, end: number) => void,
): void {
  visitEmails(text, (start, end) => onMatch("email", start, end));
  visitMatches(text, SSN_RE, (start, end) => onMatch("ssn", start, end));
  visitMatches(text, CC_CANDIDATE_RE, (start, end) => {
    const digits = text.slice(start, end).replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      onMatch("credit_card", start, end);
    }
  });
  visitMatches(text, PHONE_RE, (start, end) => onMatch("phone", start, end));
  const enabled = new Set(international);
  for (const detector of INTERNATIONAL_DETECTORS) {
    if (enabled.has(detector.category)) {
      detector.count(text, (start, end) => onMatch(detector.category, start, end));
    }
  }
}

const CATEGORY_ORDER: readonly PiiCategory[] = [
  "email", "ssn", "credit_card", "phone", ...INTERNATIONAL_DETECTORS.map((d) => d.category),
];

function countHits(counts: Partial<Record<PiiCategory, number>>): PiiHit[] {
  return CATEGORY_ORDER.filter((category) => (counts[category] ?? 0) > 0)
    .map((category) => ({ category, count: counts[category] ?? 0 }));
}

/**
 * Detect PII in `text`, returning one {category, count} per category that
 * matched at least once, in a stable category order. Empty input (or no
 * matches) returns []. The result carries COUNTS ONLY — never the matched
 * text — so it is safe to persist in an audit/usage detail.
 *
 * `international` names the national-identifier jurisdictions this deployment
 * has SWITCHED ON. Governed callers must pass their effective policy's list;
 * omission selects the shipped default of no international categories.
 * An empty array is the shipped value and is
 * byte-identical to the pre-ADR-0117 behaviour: the four base detectors run,
 * nothing else does, and `pii-international.ts` is never entered.
 *
 * The four base categories ALWAYS run and are never configurable here. They
 * are live-verified (LIVE_VERIFICATION_2026-08 V3) and nothing in this
 * argument can turn one of them off.
 */
export function detectPII(
  text: string,
  international: readonly InternationalPiiCategory[] = [],
): PiiHit[] {
  if (!text) return [];
  const counts: Partial<Record<PiiCategory, number>> = {};
  visitPII(text, international, (category) => {
    counts[category] = (counts[category] ?? 0) + 1;
  });
  return countHits(counts);
}

/** Bind this version, effective categories and transformed bytes into consent. */
export const PII_REDACTION_VERSION = "validated-spans-v1";

const PLACEHOLDERS: Readonly<Record<PiiCategory, string>> = {
  email: "[EMAIL]", ssn: "[SSN]", credit_card: "[CARD]", phone: "[PHONE]",
  aadhaar: "[AADHAAR]", cpf: "[CPF]", bsn: "[BSN]", sin: "[SIN]", tfn: "[TFN]",
  steuer_id: "[STEUER_ID]", nir: "[NIR]", dni_nie: "[DNI_NIE]",
  codice_fiscale: "[CODICE_FISCALE]", nino: "[NINO]",
};

// More specific identifiers win over generic numeric shapes. National-ID ties
// follow registry order; selection is independent of caller category order.
const REDACTION_PRIORITY: readonly PiiCategory[] = [
  "email", "ssn", ...INTERNATIONAL_DETECTORS.map((d) => d.category), "credit_card", "phone",
];

interface PiiSpan {
  category: PiiCategory;
  start: number;
  end: number;
}

/**
 * Redact a complete, decoded text value using the same validators as detectPII.
 * This is NOT a stream filter or a serialized JSON transformer: callers must
 * buffer full text and traverse parsed payloads before final approval binding.
 * Only hits are safe audit metadata; text may still contain undetected PII.
 * Offsets and original values never leave this function.
 */
export function redactPII(
  text: string,
  international: readonly InternationalPiiCategory[] = [],
): { text: string; hits: PiiHit[] } {
  const spans: PiiSpan[] = [];
  const counts: Partial<Record<PiiCategory, number>> = {};
  visitPII(text, international, (category, start, end) => {
    spans.push({ category, start, end });
    counts[category] = (counts[category] ?? 0) + 1;
  });
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const regions: PiiSpan[] = [];
  for (const span of spans) {
    const previous = regions[regions.length - 1];
    if (previous && span.start < previous.end) {
      // Cover the UNION, including transitive overlaps, not just the winning
      // category's span. Otherwise a losing match can leak its remaining tail.
      previous.end = Math.max(previous.end, span.end);
      if (REDACTION_PRIORITY.indexOf(span.category) < REDACTION_PRIORITY.indexOf(previous.category)) {
        previous.category = span.category;
      }
    } else {
      regions.push({ ...span });
    }
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const region of regions) {
    parts.push(text.slice(cursor, region.start), PLACEHOLDERS[region.category]);
    cursor = region.end;
  }
  parts.push(text.slice(cursor));
  return { text: parts.join(""), hits: countHits(counts) };
}
