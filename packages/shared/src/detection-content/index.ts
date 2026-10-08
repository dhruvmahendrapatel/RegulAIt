/** ADR-0186 V: pinned permissive upstream content, never upstream runtimes.
 * generated.ts is reproducible from hash-checked vendor snapshots. Unsupported
 * conditions/exemptions remain explicitly listed; no native-regex fallback. */
import { RE2JS } from "re2js";
import type { VendoredInjectionRule, VendoredMcpHeuristic, VendoredPackManifest, VendoredSecretRule } from "./types.js";
import { GENERATED_INJECTION_RULES, GENERATED_MCP_HEURISTICS, GENERATED_PACK_MANIFESTS, GENERATED_SECRET_RULES, NORMALISE_CONFUSABLES, NORMALISE_INVISIBLE_RANGES, NORMALISE_WHITESPACE } from "./generated.js";
export type { VendoredInjectionRule, VendoredMcpHeuristic, VendoredPackManifest, VendoredSecretRule } from "./types.js";
export { credentialAudienceViolations } from "./egress.js";
export const VENDORED_SECRET_RULES: readonly VendoredSecretRule[] = GENERATED_SECRET_RULES;
export const VENDORED_INJECTION_RULES: readonly VendoredInjectionRule[] = GENERATED_INJECTION_RULES;
export const VENDORED_MCP_HEURISTICS: readonly VendoredMcpHeuristic[] = GENERATED_MCP_HEURISTICS;
export const VENDORED_PACK_MANIFESTS: readonly VendoredPackManifest[] = GENERATED_PACK_MANIFESTS;
const confusables = new Map<number, string>(NORMALISE_CONFUSABLES);
const whitespace = new Set<number>(NORMALISE_WHITESPACE);
const combining = RE2JS.compile("\\p{Mn}");
function characters(text: string, map: (char: string, code: number) => string): string {
  const out: string[] = [];
  for (const char of text) out.push(map(char, char.codePointAt(0)!));
  return out.join("");
}
/** Pipelock ForMatching: strip invisibles, NFKC, confusable fold, NFD/Mn
 * stripping, NFC, explicit whitespace fold. Fixed linear passes, no decoding
 * loops or arbitrary execution; preserves the original text for audit output. */
export function normaliseForInjection(text: string): string {
  const visible = characters(text, (char, code) => NORMALISE_INVISIBLE_RANGES.some(([lo, hi]) => code >= lo && code <= hi) ? "" : char);
  // Remove the marks this pipeline discards before ICU reorders them: an
  // adversarial alternating-CCC run otherwise incurs quadratic normalization.
  // Bound every Unicode mark run before ICU, including Mc/Me spacing marks.
  // This fixed Unicode property scan is linear and never executes vendor regex.
  const streamSafe=visible.replace(/\p{M}+/gu,run=>{
    let end=0;for(let n=0;n<30&&end<run.length;n++)end+=run.codePointAt(end)!>0xffff?2:1;
    return run.slice(0,end);
  });
  const withoutMarks = combining.matcher(streamSafe).replaceAll("");
  const folded = characters(withoutMarks.normalize("NFKC"), (char, code) => confusables.get(code) ?? char);
  const stripped = combining.matcher(folded.normalize("NFD")).replaceAll("").normalize("NFC");
  return characters(stripped, (char, code) => whitespace.has(code) ? " " : char);
}
