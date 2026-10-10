/**
 * ADR-0186 V — how vendored detection content is APPLIED (foundation).
 *
 * The three consumers call only the functions below, with fixed signatures:
 *   - `audit-scrub.ts`   → `vendoredSecretSpans` (redact on match, ADR-0099 marker);
 *   - `guardrails.ts`    → `injectionText` (pipelock-normalise before the
 *                          injection rules) and `vendoredInjectionHits`, and
 *                          `vendoredSecretCount` for the DLP detector;
 *   - gateway `mcp-admission.ts` → `vendoredMcpFindings` (in `./mcp.ts`, so the
 *                          guardrail and audit paths never load the MCP scanner).
 *
 * Every pattern runs on `re2js` (RE2, linear time). A pattern RE2 cannot
 * compile is SKIPPED here (and reported by `vendoredCompileProblems`, which the
 * slice-V test asserts is empty); it never falls back to the native engine.
 * Results are counts and spans only, never the matched text.
 *
 * `packs` is the org's `vendored_detection_packs` setting; absent = all four
 * (the strict default). The audit path has no settings to read (it runs inside
 * the ledger write) and always applies the secrets pack: redacting a credential
 * out of an immutable record is never the relaxation an admin asked for.
 */
import { RE2JS, RE2Set } from "re2js";
import { GENERATED_SECRET_RULES, GENERATED_SECRET_SCAN_PLANS } from "./generated.js";
import { VENDORED_DETECTION_PACKS, type VendoredDetectionPack } from "../batch4.js";
import {
  normaliseForInjection,
  VENDORED_INJECTION_RULES,
  VENDORED_MCP_HEURISTICS,
  VENDORED_SECRET_RULES,
  type VendoredInjectionRule,
  type VendoredMcpHeuristic,
  type VendoredSecretRule,
} from "./index.js";

export type VendoredPackSelection = readonly VendoredDetectionPack[] | undefined;

const ALL_PACKS: readonly VendoredDetectionPack[] = VENDORED_DETECTION_PACKS;
export const vendoredPackEnabled = (packs: VendoredPackSelection, pack: VendoredDetectionPack) => (packs ?? ALL_PACKS).includes(pack);

const compiled = new Map<string, RE2JS | null>();

/** compile once per (pattern, flags); null = RE2 refused it (skipped) */
export function compileVendored(_id: string, pattern: string, caseInsensitive: boolean | undefined): RE2JS | null {
  const key = `${caseInsensitive ? "i" : "-"}:${pattern}`;
  if (compiled.has(key)) return compiled.get(key)!;
  let out: RE2JS | null = null;
  try {
    out = RE2JS.compile(pattern, caseInsensitive ? RE2JS.CASE_INSENSITIVE : 0);
  } catch {
    out = null; // skipped; `vendoredCompileProblems` names it
  }
  compiled.set(key, out);
  return out;
}

/** each [start, end) of a non-empty match (UTF-16 indices) */
export function* spansOf(re: RE2JS, text: string): Generator<[number, number]> {
  const m = re.matcher(text);
  while (m.find()) {
    const s = m.start();
    const e = m.end();
    if (e > s) yield [s, e];
  }
}

/** the vendored rules RE2 cannot compile, with the reason (slice V's test asserts
 * this is empty for the shipped data; such a rule is listed `notImported`) */
export function vendoredCompileProblems(rules?: {
  secrets?: readonly VendoredSecretRule[];
  injection?: readonly VendoredInjectionRule[];
  mcp?: readonly VendoredMcpHeuristic[];
}): Array<{ id: string; problem: string }> {
  const out: Array<{ id: string; problem: string }> = [];
  const check = (id: string, pattern: string, ci: boolean | undefined) => {
    try {
      RE2JS.compile(pattern, ci ? RE2JS.CASE_INSENSITIVE : 0);
    } catch (err) {
      out.push({ id, problem: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    }
  };
  for (const r of rules?.secrets ?? VENDORED_SECRET_RULES) check(r.id, r.pattern, r.caseInsensitive);
  for (const r of rules?.injection ?? VENDORED_INJECTION_RULES) for (const p of r.patterns) check(r.id, p, r.caseInsensitive);
  for (const r of rules?.mcp ?? VENDORED_MCP_HEURISTICS) check(r.id, r.pattern, r.caseInsensitive);
  return out;
}

// ---------------------------------------------------------------------------
// pipelock-secrets
// ---------------------------------------------------------------------------

export interface VendoredSpan {
  start: number;
  end: number;
  /** the vendored rule id */
  rule: string;
}

const secretSets = new WeakMap<readonly VendoredSecretRule[], RE2Set | null>();
function secretSet(rules: readonly VendoredSecretRule[]): RE2Set | null {
  try {
    const set = new RE2Set();
    for (const rule of rules) set.add(`${rule.caseInsensitive ? "(?i:" : "(?:"}${rule.pattern})`);
    set.compile();
    // Precompile default scanning at import/boot, not the first ledger write.
    // This tiny non-secret corpus also initializes DFA transitions.
    set.match(" abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789 ----- ");
    return set;
  } catch { return null; }
}
// ADR-0186 decision 31 (B4I-02): the shipped rules are scanned through plans the converter derives from RE2's
// own compiled program (see scripts/vendor/convert-detection-content.mjs). Each plan's prefilter is a fixed-length
// sequence of code-point classes that every match of the rule begins with; a native scan for it is linear and
// needs no backtracking. A rule whose prefilter never occurs cannot match and costs no RE2 work. A bounded rule
// (maxLength known) is matched only in a window at each prefilter hit; an unbounded one is scanned by RE2 from
// its first hit. Both reproduce the full-text RE2 result exactly (the differential test in scan-plans.test.ts
// holds them to it). A plan that is missing or does not compile leaves that rule on the full RE2 scan.
interface ScanPlan { prefilter: RegExp; maxLength: number | null }
const scanPlans = new Map<VendoredSecretRule, ScanPlan>();
{
  const plans: Readonly<Record<string, { prefilter: string; maxLength: number | null }>> = GENERATED_SECRET_SCAN_PLANS;
  for (const rule of GENERATED_SECRET_RULES) {
    const plan = plans[rule.id];
    if (!plan) continue;
    try { scanPlans.set(rule, { prefilter: new RegExp(plan.prefilter, "gu"), maxLength: plan.maxLength }); } catch { /* full scan */ }
  }
}
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
/** the first prefilter hit at or after `from` on a code-point boundary (where RE2 can start a match), or -1 */
function nextHit(prefilter: RegExp, text: string, from: number): number {
  for (let at = from; at <= text.length;) {
    prefilter.lastIndex = at;
    const hit = prefilter.exec(text)?.index;
    if (hit === undefined) return -1;
    if (hit < at || (hit > 0 && isLowSurrogate(text.charCodeAt(hit)) && isHighSurrogate(text.charCodeAt(hit - 1)))) { at = Math.max(at, hit) + 1; continue; }
    return hit;
  }
  return -1;
}
/** The end of the leftmost-first match that starts exactly at `hit`, or -1. The window holds one unit of left
 * context (for \b) and maxLength + 1 units from the hit (every match from there, and the unit after it), so
 * RE2 sees exactly what it sees in the full text. Results are memoised per call by window content. */
function windowMatchEnd(re: RE2JS, maxLength: number, text: string, hit: number, cache: Map<string, number>): number {
  const from = hit > 0 ? hit - 1 : 0, offset = hit - from;
  const window = text.slice(from, Math.min(text.length, hit + maxLength + 1));
  const key = `${offset}${window}`;
  let length = cache.get(key);
  if (length === undefined) {
    const m = re.matcher(window);
    length = m.find(offset) && m.start() === offset ? m.end() - offset : -1;
    if (cache.size < 256) cache.set(key, length);
  }
  return length > 0 ? hit + length : -1;
}
function* plannedSpans(re: RE2JS, plan: ScanPlan, text: string): Generator<[number, number]> {
  const first = nextHit(plan.prefilter, text, 0);
  if (first < 0) return;
  if (plan.maxLength === null) {
    // Every match starts at or after the first hit; RE2 continues from each match's end, as spansOf does.
    const m = re.matcher(text);
    for (let found = m.find(first); found; found = m.find()) if (m.end() > m.start()) yield [m.start(), m.end()];
    return;
  }
  const cache = new Map<string, number>();
  for (let hit = first; hit >= 0;) {
    const end = windowMatchEnd(re, plan.maxLength, text, hit, cache);
    if (end > hit) yield [hit, end];
    hit = nextHit(plan.prefilter, text, end > hit ? end : hit + 1);
  }
}
/** One combined RE2 scan selects candidates, then individual RE2 matchers
 * locate exact spans. If the optimization cannot compile, retain every rule;
 * a failed optimization must never suppress redaction. */
export function secretCandidateRules(text: string, rules: readonly VendoredSecretRule[] = VENDORED_SECRET_RULES): readonly VendoredSecretRule[] {
  if (!rules.length) return [];
  if (rules === GENERATED_SECRET_RULES) {
    try {
      return rules.filter((rule) => {
        const re = compileVendored(rule.id, rule.pattern, rule.caseInsensitive);
        if (!re) return true;
        const plan = scanPlans.get(rule);
        if (!plan) return re.test(text);
        for (const _ of plannedSpans(re, plan, text)) return true;
        return false;
      });
    } catch { return rules; }
  }
  let set = secretSets.get(rules);
  if (set === undefined) {
    set = secretSet(rules);
    secretSets.set(rules, set);
  }
  if (!set) return rules;
  try { return set.match(text).map((index) => rules[index]!); } catch { return rules; }
}
const identifierCode = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95 || code === 45;
export function* secretRuleSpans(rule: VendoredSecretRule, text: string): Generator<[number, number]> {
  const re = compileVendored(rule.id, rule.pattern, rule.caseInsensitive);
  if (!re) return;
  for (const [start, end] of spansOf(re, text)) {
    if (rule.leftBoundary === "ascii_identifier" && start > 0 && identifierCode(text.charCodeAt(start - 1))) continue;
    yield [start, end];
  }
}

/** every credential span the secrets pack finds (the audit scrub redacts them) */
export function vendoredSecretSpans(
  text: string,
  opts: { packs?: VendoredPackSelection; rules?: readonly VendoredSecretRule[] } = {},
): VendoredSpan[] {
  if (!text || !vendoredPackEnabled(opts.packs, "pipelock-secrets")) return [];
  const out: VendoredSpan[] = [];
  const rules = opts.rules ?? VENDORED_SECRET_RULES;
  if (rules === GENERATED_SECRET_RULES) {
    // The planned scan yields the same spans, in the same rule order, as candidate selection followed by
    // secretRuleSpans; it only skips RE2 work the plan proves cannot match.
    for (const rule of rules) {
      const re = compileVendored(rule.id, rule.pattern, rule.caseInsensitive);
      if (!re) continue;
      const plan = scanPlans.get(rule);
      for (const [start, end] of plan ? plannedSpans(re, plan, text) : spansOf(re, text)) {
        if (rule.leftBoundary === "ascii_identifier" && start > 0 && identifierCode(text.charCodeAt(start - 1))) continue;
        out.push({ start, end, rule: rule.id });
      }
    }
    return out;
  }
  for (const rule of secretCandidateRules(text, rules)) {
    for (const [start, end] of secretRuleSpans(rule, text)) out.push({ start, end, rule: rule.id });
  }
  return out;
}

/** how many credential matches, per rule id (the DLP detector counts them) */
export function vendoredSecretCount(
  text: string,
  opts: { packs?: VendoredPackSelection; rules?: readonly VendoredSecretRule[] } = {},
): number {
  return vendoredSecretSpans(text, opts).length;
}

// ---------------------------------------------------------------------------
// pipelock-normalise + nemo-yara-injection
// ---------------------------------------------------------------------------

/** the text the injection rules read: normalised when the pack is on */
export function injectionText(
  text: string,
  opts: { packs?: VendoredPackSelection; normalise?: (t: string) => string } = {},
): string {
  if (!text || !vendoredPackEnabled(opts.packs, "pipelock-normalise")) return text;
  return (opts.normalise ?? normaliseForInjection)(text);
}

export interface VendoredInjectionHit {
  category: string;
  /** rules fired in this category */
  count: number;
  rules: string[];
}

/**
 * YARA `N of them`: a rule fires when at least `minMatches` of its DISTINCT
 * patterns match. Counted once per firing rule, grouped by category.
 * `text` should already be `injectionText(...)`.
 */
export function vendoredInjectionHits(
  text: string,
  opts: { packs?: VendoredPackSelection; rules?: readonly VendoredInjectionRule[] } = {},
): VendoredInjectionHit[] {
  if (!text || !vendoredPackEnabled(opts.packs, "nemo-yara-injection")) return [];
  const byCategory = new Map<string, VendoredInjectionHit>();
  for (const rule of opts.rules ?? VENDORED_INJECTION_RULES) {
    const need = Math.max(1, Math.floor(rule.minMatches));
    let matched = 0;
    for (const p of rule.patterns) {
      const re = compileVendored(rule.id, p, rule.caseInsensitive);
      if (re && re.test(text)) matched += 1;
      if (matched >= need) break;
    }
    if (matched < need) continue;
    const hit = byCategory.get(rule.category) ?? { category: rule.category, count: 0, rules: [] };
    hit.count += 1;
    hit.rules.push(rule.id);
    byCategory.set(rule.category, hit);
  }
  return [...byCategory.values()];
}
