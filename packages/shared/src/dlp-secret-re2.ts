/**
 * ADR-0334: the shared `dlp.secret.*` credential rules in RE2 form, for any TypeScript consumer that must match them in
 * linear time on untrusted input (first: the managed browser extension, which checks a prompt before it leaves the
 * browser; it bundles this file through the `@regulait/shared/dlp-secret-re2` subpath).
 *
 * One list of "what a key looks like": the shared `dlp.secret.*` rules (packages/shared guardrails.ts,
 * CREDENTIAL_MATERIAL_RULES), in their RE2 form, exactly as the endpoint agent compiles them
 * (agents/endpoint/internal/secrets/secrets.go). RE2 matches in linear time, so a hostile page or prompt cannot make
 * the check hang. The JavaScript lookarounds RE2 lacks are rewritten the same way the Go table rewrites them: an RE2
 * match plus a check in code. dlp-secret-re2.test.ts holds this table equal to the shared rules (ids and source digests,
 * via the endpoint agent's recorded digests) and runs the endpoint agent's vectors through it.
 *
 * A match yields rule ids only. The matched text is never returned, stored, logged or sent.
 */
import { RE2JS } from "re2js";
import { BROWSER_DLP_MAX_CHARS, BROWSER_DLP_RULE_IDS, type BrowserDlpRuleId } from "./browser-governance/constants.js";

interface Rule {
  id: BrowserDlpRuleId;
  re: RE2JS;
  /** re-checks a match's groups for what the JavaScript lookaround expressed */
  accept?: (groups: (string | null)[]) => boolean;
}

/** the two published documentation example test-key bodies the shared rule excludes, assembled from halves */
const STRIPE_DOC_EXAMPLE_BODIES = ["4eC39HqLyjWD" + "arjtT1zdp7dc", "BQokikJOvBiI" + "2HlWgH4olfQ2"];

const allOneChar = (s: string) => [...s].every((c) => c === s[0]);

const RULES: readonly Rule[] = [
  { id: "dlp.secret.aws_key", re: RE2JS.compile(String.raw`\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b`) },
  { id: "dlp.secret.private_key", re: RE2JS.compile(String.raw`-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+|PGP\s+)?PRIVATE\s+KEY(?:\s+BLOCK)?-----`) },
  // JS: (?<![A-Za-z0-9_-])eyJ… — the lookbehind becomes "start of text or a non-run character before it"
  { id: "dlp.secret.jwt", re: RE2JS.compile(String.raw`(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`) },
  {
    id: "dlp.secret.assignment",
    re: RE2JS.compile(String.raw`(?i)\b(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd|bearer)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}["']?`),
  },
  { id: "dlp.secret.provider_token", re: RE2JS.compile(String.raw`\b(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b`) },
  { id: "dlp.secret.anthropic_key", re: RE2JS.compile(String.raw`\bsk-ant-[a-z]{3,8}\d{2}-[A-Za-z0-9_-]{32,200}`) },
  { id: "dlp.secret.openai_key", re: RE2JS.compile(String.raw`\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,250}`) },
  { id: "dlp.secret.github_fine_grained_pat", re: RE2JS.compile(String.raw`\bgithub_pat_\w{82}`) },
  // JS: two negative lookaheads (a documentation example body; a body of one repeated character)
  {
    id: "dlp.secret.stripe_key",
    re: RE2JS.compile(String.raw`\b(?:sk|rk)_(test|live|prod)_([A-Za-z0-9]{10,})`),
    accept: (g) => {
      const body = g[2] ?? "";
      if (allOneChar(body)) return false;
      return !(g[1] === "test" && STRIPE_DOC_EXAMPLE_BODIES.includes(body));
    },
  },
  // JS: (?![\w-]) after the 39-character key — RE2 consumes the following character or the end instead
  { id: "dlp.secret.google_api_key", re: RE2JS.compile(String.raw`\bAIza[\w-]{35}(?:[^\w-]|$)`) },
  { id: "dlp.secret.gitlab_pat", re: RE2JS.compile(String.raw`\bglpat-[\w-]{20,300}(?:\.[0-9a-z]{9})?`) },
  // JS: (?![A-Za-z0-9_]) after the 34-letter body — as for google_api_key
  { id: "dlp.secret.huggingface_token", re: RE2JS.compile(String.raw`\b(?:hf|api_org)_[A-Za-z]{34}(?:[^A-Za-z0-9_]|$)`) },
  { id: "dlp.secret.regulait_token", re: RE2JS.compile(String.raw`\brgl(?:v|s|scim)?_[A-Fa-f0-9]{24,}\b`) },
];

if (RULES.map((r) => r.id).join() !== BROWSER_DLP_RULE_IDS.join()) {
  throw new Error("the extension's DLP table is out of step with BROWSER_DLP_RULE_IDS");
}

/** the compiled rule ids, in the shared order */
export function dlpRuleIds(): BrowserDlpRuleId[] {
  return RULES.map((r) => r.id);
}

/**
 * Every enabled rule id that matches `text`, in rule order. A longer text is checked on its first
 * BROWSER_DLP_MAX_CHARS characters (the endpoint agent's bound). `enabled` null means every rule (fail closed).
 */
export function matchDlp(text: string, enabled: readonly string[] | null = null): BrowserDlpRuleId[] {
  const value = text.length > BROWSER_DLP_MAX_CHARS ? text.slice(0, BROWSER_DLP_MAX_CHARS) : text;
  if (value.trim() === "") return [];
  const out: BrowserDlpRuleId[] = [];
  for (const r of RULES) {
    if (enabled && !enabled.includes(r.id)) continue;
    const m = r.re.matcher(value);
    if (!r.accept) {
      if (m.find()) out.push(r.id);
      continue;
    }
    while (m.find()) {
      const groups: (string | null)[] = [];
      for (let i = 0; i <= m.groupCount(); i++) groups.push(m.group(i));
      if (r.accept(groups)) {
        out.push(r.id);
        break;
      }
    }
  }
  return out;
}
