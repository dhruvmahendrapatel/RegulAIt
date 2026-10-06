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
