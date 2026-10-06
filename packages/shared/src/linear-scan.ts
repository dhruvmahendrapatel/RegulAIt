/**
 * Linear-time replacements for three regexes CodeQL flagged as polynomial
 * (js/polynomial-redos, ADR-0184 triage). Each function returns exactly what
 * the regex it replaces returned; `linear-scan.test.ts` checks that on
 * generated inputs and times a pathological input for each.
 *
 * Open source first (ADR-0176): these are three index scans over a string, not
 * a solved problem a library owns; a dependency would be larger than the code.
 */

/** `s.replace(/\/+$/, "")` by a backward scan. The regex rescans every run of
 * `/` that does not end the string, so it is quadratic in such a run. */
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f) end -= 1;
  return end === s.length ? s : s.slice(0, end);
}

const WHITESPACE = /\s/;

/**
 * The body of the first fenced block, as `text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]`
 * returns it (with `ignoreCase`, the `/i` form, which only affects `json`).
 *
 * The regex starts a lazy body at every whitespace position after each opening
 * fence before it finds the closing one, quadratic on a long whitespace run
 * after an unclosed fence. Here: the first fence, then an optional `json`,
 * then the whitespace, then the next fence. A later opening fence cannot
 * match when this one does not: it would need a closing fence after it, which
 * would have closed this one.
 */
export function fencedBlockBody(text: string, ignoreCase = false): string | undefined {
  const open = text.indexOf("```");
  if (open === -1) return undefined;
  let start = open + 3;
  const tag = text.slice(start, start + 4);
  if (ignoreCase ? tag.toLowerCase() === "json" : tag === "json") start += 4;
  while (start < text.length && WHITESPACE.test(text[start]!)) start += 1;
  const close = text.indexOf("```", start);
  return close === -1 ? undefined : text.slice(start, close);
}

/** `text.match(/\{[\s\S]*\}/)?.[0]`: from the first `{` to the last `}` after
 * it. The regex retries from every `{` when there is no `}` after it, which is
 * quadratic on a long run of `{`. */
export function firstBraceBlock(text: string): string | undefined {
  const open = text.indexOf("{");
  if (open === -1) return undefined;
  const close = text.lastIndexOf("}");
  return close > open ? text.slice(open, close + 1) : undefined;
}

const isWordChar = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isAlnum = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isDigit = (c: number): boolean => c >= 48 && c <= 57;
/** `[a-z0-9.-]` under the `i` flag */
const isHostChar = (c: number): boolean => isAlnum(c) || c === 46 || c === 45;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * The host of the first bare `host:port` token, as
 * `/\b([a-z0-9][a-z0-9.-]*\.[a-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)\b/i.exec(line)?.[1]`
 * returns it. That regex restarts a greedy `[a-z0-9.-]*` at every word boundary,
 * so a long run like `ab.ab.ab.…` costs the square of its length (60,000
 * characters took 2.3 s; ADR-0184 review B1-04).
 *
 * A match must end at a `:digits` followed by a non-word character, and the
 * host is the run of `[a-z0-9.-]` immediately before that colon. So: find each
 * such port, look at the run before it (runs are disjoint, so the backward
 * scans add up to one pass), and take the leftmost start in it that satisfies
 * one of the three alternatives. Ports are visited left to right, so the first
 * hit is the regex's leftmost match.
 */
export function bareHostBeforePort(line: string): string | undefined {
  const n = line.length;
  for (let colon = line.indexOf(":"); colon !== -1; colon = line.indexOf(":", colon + 1)) {
    if (colon === 0 || !isHostChar(line.charCodeAt(colon - 1))) continue;
    let end = colon + 1;
    while (end < n && isDigit(line.charCodeAt(end))) end += 1;
    if (end === colon + 1 || (end < n && isWordChar(line.charCodeAt(end)))) continue;
    let runStart = colon;
    while (runStart > 0 && isHostChar(line.charCodeAt(runStart - 1))) runStart -= 1;
    // alternative 1 needs the run's last dot followed only by 2+ letters
    // the run's last dot, searched within the run only (a whole-line lastIndexOf
    // would make each port cost the line's length again)
    let lastDot = colon - 1;
    while (lastDot >= runStart && line.charCodeAt(lastDot) !== 46) lastDot -= 1;
    let tailLetters = lastDot >= runStart && colon - lastDot - 1 >= 2;
    for (let i = lastDot + 1; tailLetters && i < colon; i++) if (!isLetter(line.charCodeAt(i))) tailLetters = false;
    for (let p = runStart; p < colon; p++) {
      if (!isAlnum(line.charCodeAt(p))) continue;
      if (p > 0 && isWordChar(line.charCodeAt(p - 1))) continue; // \b
      if (tailLetters && p <= lastDot - 1) return line.slice(p, colon);
      const len = colon - p;
      if (len === 9 && line.slice(p, colon).toLowerCase() === "localhost") return line.slice(p, colon);
      if (len <= 15 && IPV4.test(line.slice(p, colon))) return line.slice(p, colon);
    }
  }
  return undefined;
}
