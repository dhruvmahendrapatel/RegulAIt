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
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

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

function countMatches(text: string, re: RegExp): number {
  let n = 0;
  // each RegExp is a module constant with the /g flag; reset lastIndex so the
  // function stays total and re-entrant regardless of prior use
  re.lastIndex = 0;
  while (re.exec(text) !== null) n++;
  return n;
}

function countCreditCards(text: string): number {
  let n = 0;
  CC_CANDIDATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CC_CANDIDATE_RE.exec(text)) !== null) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) n++;
  }
  return n;
}

/**
 * Detect PII in `text`, returning one {category, count} per category that
 * matched at least once, in a stable category order. Empty input (or no
 * matches) returns []. The result carries COUNTS ONLY — never the matched
 * text — so it is safe to persist in an audit/usage detail.
 *
 * `international` names the national-identifier jurisdictions this deployment
 * has SWITCHED ON. It is a required argument rather than an optional one on
 * purpose: `detectPII` is the single point every governed dispatch path
 * reaches PII through, and a new call site that forgets the list would
 * silently enforce less than the deployment asked for — the one failure mode
 * this work exists to close. An empty array is the shipped value and is
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
  const counts: Partial<Record<PiiCategory, number>> = {
    email: countMatches(text, EMAIL_RE),
    ssn: countMatches(text, SSN_RE),
    credit_card: countCreditCards(text),
    phone: countMatches(text, PHONE_RE),
  };
  const order: PiiCategory[] = ["email", "ssn", "credit_card", "phone"];
  if (international.length > 0) {
    const on = new Set<string>(international);
    // Registry order, not caller order, so the audit reason string for a given
    // text is the same whatever order an admin happened to list jurisdictions.
    for (const detector of INTERNATIONAL_DETECTORS) {
      if (!on.has(detector.category)) continue;
      const n = detector.count(text);
      if (n > 0) {
        counts[detector.category] = n;
        order.push(detector.category);
      }
    }
  }
  return order
    .filter((c) => (counts[c] ?? 0) > 0)
    .map((c) => ({ category: c, count: counts[c] ?? 0 }));
}
