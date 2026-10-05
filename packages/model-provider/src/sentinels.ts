/**
 * Linear-time scans for the mock provider's `<<…>>` prompt triggers.
 *
 * These used to be regexes (`/<<[^>]*>>/g`, `/<<serve-as:([^>\s]+)>>/`,
 * `/<<upstream-error:([^>]+)>>/`, `/[.?!,;:\s]+$/`). Each one backtracks
 * quadratically on a prompt that repeats its opening (`<<<<…`, `<<serve-as:` …)
 * without ever closing it, and the prompt is caller-controlled: CodeQL
 * js/polynomial-redos on PR #117. The scans below match exactly what those
 * regexes matched (`sentinels.test.ts` checks them against the old regexes as
 * an oracle) and touch each character a bounded number of times.
 */

const WHITESPACE = /\s/;

interface SentinelSpan {
  start: number;
  /** one past the closing `>>` */
  end: number;
  value: string;
}

/**
 * The first `PREFIX value >>` at or after `from`: the value is the run of
 * characters for which `isValueChar` holds, and the character that ends the
 * run must open the closing `>>`.
 *
 * Precondition: every character of `prefix` is itself a value character (true
 * for `<<`, `<<serve-as:`, `<<upstream-error:` with a "not `>`" value). That is
 * what makes skipping to the end of a failed run safe: any later prefix that
 * starts inside the run has its own run end at the same character, so it fails
 * the same way. Without the skip, `<<<<<<…` costs O(n²) again.
 */
function scanSentinel(
  text: string,
  prefix: string,
  isValueChar: (c: string) => boolean,
  allowEmpty: boolean,
  from: number,
): SentinelSpan | null {
  let at = from;
  for (;;) {
    const start = text.indexOf(prefix, at);
    if (start < 0) return null;
    const valueStart = start + prefix.length;
    let k = valueStart;
    while (k < text.length && isValueChar(text[k]!)) k += 1;
    if (text.startsWith(">>", k) && (allowEmpty || k > valueStart)) {
      return { start, end: k + 2, value: text.slice(valueStart, k) };
    }
    at = Math.max(k, start + 1);
  }
}

/** The value of the first `PREFIX value >>` in `text` (value non-empty), or null. */
export function findSentinel(text: string, prefix: string, isValueChar: (c: string) => boolean): string | null {
  return scanSentinel(text, prefix, isValueChar, false, 0)?.value ?? null;
}

/** `text.replace(/<<[^>]*>>/g, " ")`, in linear time. */
export function stripSentinels(text: string): string {
  const notGt = (c: string) => c !== ">";
  let out = "";
  let copied = 0;
  for (;;) {
    const span = scanSentinel(text, "<<", notGt, true, copied);
    if (!span) return out + text.slice(copied);
    out += text.slice(copied, span.start) + " ";
    copied = span.end;
  }
}

/** `text.replace(/[.?!,;:\s]+$/, "")`, in linear time. */
export function trimTrailingPunctuation(text: string): string {
  let end = text.length;
  while (end > 0) {
    const c = text[end - 1]!;
    if (!".?!,;:".includes(c) && !WHITESPACE.test(c)) break;
    end -= 1;
  }
  return text.slice(0, end);
}
