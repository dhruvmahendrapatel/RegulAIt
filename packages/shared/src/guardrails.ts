/**
 * ADR-0042 — the GUARDRAIL ENGINE's pure half.
 *
 * A registry of content-safety DETECTORS, each a total function over a string,
 * each returning per-category COUNTS ONLY — never the matched substrings. That
 * counts-only contract is inherited verbatim from `detectPII` (§8.4) and is
 * what makes it safe to persist a guardrail result in the audit log: a
 * violation record can never itself become the leak it was recording.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE DETECTORS ACTUALLY ARE — READ THIS BEFORE TRUSTING THEM
 * ---------------------------------------------------------------------------
 * Every detector shipped here is **heuristic**: a deterministic, local,
 * zero-cost, zero-network rule set of regular expressions and term lists. That
 * is the same tier `detectPII` already occupies, and it is the ONLY tier this
 * deployment can honestly claim, because no model provider is wired to this
 * box (ADR-0042 names a model-based tier and an optional external tier; the
 * `tier` field on each detector exists so those can be registered later behind
 * the SAME interface, and `GuardrailDetector.detect` is deliberately
 * synchronous-and-pure so a future async model-backed detector will be an
 * obviously different, separately-reviewed shape rather than a silent swap).
 *
 * Concretely, and stated so nobody over-trusts the output:
 *   - These rules catch UNOBFUSCATED, English, literal phrasings. Base64,
 *     homoglyphs, leetspeak, translation, token-splitting and novel framings
 *     all evade them.
 *   - They will fire on benign text that discusses these topics (a prompt
 *     ABOUT prompt injection reads like prompt injection). That is why the
 *     shipped posture is `log`, not `block`.
 *   - They are a defence-in-depth layer, not a proof of safety. ADR-0042 says
 *     this in prose; this file says it at the point of implementation.
 *
 * Each rule carries a stable `id` so a false positive can be reported,
 * reproduced and argued about against a specific line of this file, and so an
 * admin's tuning is a conversation about rules rather than about vibes.
 */

import { detectPII, type PiiHit } from "./pii.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The four detector classes ADR-0042 names, plus PII as classifier #1. */
export const GUARDRAIL_DETECTOR_IDS = [
  "pii",
  "prompt_injection",
  "jailbreak",
  "toxicity",
  "semantic_dlp",
] as const;
export type GuardrailDetectorId = (typeof GUARDRAIL_DETECTOR_IDS)[number];

/**
 * The enforcement verbs. `block | warn | log` are exactly `PiiMode`'s triad
 * (ADR-0042 §1: "keep the verbs"). `off` is the additional member a
 * per-detector switch needs and `piiMode` does not: piiMode's absence is
 * expressed by the cascade resolving to null, whereas a detector row always
 * exists and must be able to say "do not run me at all".
 */
export const GUARDRAIL_MODES = ["off", "log", "warn", "block"] as const;
export type GuardrailMode = (typeof GUARDRAIL_MODES)[number];

/** Strictness ordering — the ONE place the ceiling composition is defined. */
const STRICTNESS: Record<GuardrailMode, number> = { off: 0, log: 1, warn: 2, block: 3 };

/** The stricter of two modes. Composition is MAX-of-strictness everywhere:
 * a compliance framework can only ever RAISE a floor, never relax one. */
export function strictestMode(a: GuardrailMode, b: GuardrailMode): GuardrailMode {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

export function modeAtLeast(mode: GuardrailMode, floor: GuardrailMode): boolean {
  return STRICTNESS[mode] >= STRICTNESS[floor];
}

/** Which direction a detector is evaluated in. */
export type GuardrailPhase = "input" | "output";

/** A per-category hit: how MANY matches — never what they were. Same shape
 * and same contract as `PiiHit`, so both flow through one audit path. */
export interface GuardrailHit {
  detector: GuardrailDetectorId;
  /** the rule family that matched, e.g. 'instruction_override' */
  category: string;
  count: number;
}

/** Admin-supplied additional terms, per detector. Matched case-insensitively
 * on word boundaries. This is the org's own vocabulary ("Project Aurora",
 * a competitor's codename, a slur the shipped lexicon omits) and is the
 * intended way to make `semantic_dlp` useful for a specific business. */
export type GuardrailTerms = Partial<Record<GuardrailDetectorId, string[]>>;

/**
 * The pluggable detector interface. A model-backed or third-party classifier
 * registers here; nothing at the enforcement point knows which tier it got.
 */
export interface GuardrailDetector {
  id: GuardrailDetectorId;
  /** heuristic = local/deterministic/zero-cost (everything shipped today).
   * model / external are declared in the type so a later registration is a
   * registration, not a refactor — neither is wired in this deployment. */
  tier: "heuristic" | "model" | "external";
  phases: readonly GuardrailPhase[];
  /** one line an admin screen can show */
  summary: string;
  /** the honest limitation, rendered in the admin UI next to the switch */
  limits: string;
  /** stable rule ids, so a false positive names a rule */
  ruleIds: readonly string[];
  detect(text: string, terms?: readonly string[]): GuardrailHit[];
}

// ---------------------------------------------------------------------------
// Shared matching helpers
// ---------------------------------------------------------------------------

interface Rule {
  id: string;
  category: string;
  re: RegExp;
}

/** Count matches of every rule, grouped by category. Each RegExp is a module
 * constant with /g, so lastIndex is reset to keep the function total. */
function runRules(text: string, rules: readonly Rule[], detector: GuardrailDetectorId): GuardrailHit[] {
  const counts = new Map<string, number>();
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let n = 0;
    while (rule.re.exec(text) !== null) n++;
    if (n > 0) counts.set(rule.category, (counts.get(rule.category) ?? 0) + n);
  }
  return [...counts.entries()].map(([category, count]) => ({ detector, category, count }));
}

/** Escape a user-supplied term for literal use inside a RegExp. */
function escapeTerm(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Count admin-supplied custom terms. Word-boundary anchored where the term
 * starts/ends with a word character, so "roadmap" does not match "roadmaps"'
 * neighbours accidentally but a multi-word phrase still works.
 */
function countTerms(text: string, terms: readonly string[] | undefined): number {
  if (!terms || terms.length === 0 || !text) return 0;
  let n = 0;
  for (const raw of terms) {
    const term = raw.trim();
    if (!term) continue;
    const lead = /^\w/.test(term) ? "\\b" : "";
    const tail = /\w$/.test(term) ? "\\b" : "";
    const re = new RegExp(`${lead}${escapeTerm(term)}${tail}`, "gi");
    while (re.exec(text) !== null) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// 1. PROMPT INJECTION (input, and tool output — ADR-0042 §2)
// ---------------------------------------------------------------------------
// Instruction-override and tool-hijack phrasings. The categories are the rule
// FAMILIES an admin tunes against, not individual regexes.

const INJECTION_RULES: readonly Rule[] = [
  // "ignore all previous instructions", "disregard the above rules", …
  {
    id: "inj.override.ignore_previous",
    category: "instruction_override",
    re: /\b(?:ignore|disregard|forget|discard|override)\b[^.\n]{0,40}?\b(?:all\s+|any\s+)?(?:previous|prior|earlier|above|preceding|foregoing|original|initial)\b[^.\n]{0,20}?\b(?:instruction|instructions|prompt|prompts|rule|rules|direction|directions|guideline|guidelines|context)\b/gi,
  },
  // "ignore your system prompt", "disregard your guidelines"
  {
    id: "inj.override.ignore_your_rules",
    category: "instruction_override",
    re: /\b(?:ignore|disregard|forget|bypass|override|violate)\b[^.\n]{0,30}?\byour\b[^.\n]{0,30}?\b(?:system\s+prompt|instructions|guidelines|rules|policies|restrictions|constraints|training)\b/gi,
  },
  // an injected replacement instruction block
  {
    id: "inj.override.new_instructions",
    category: "instruction_override",
    re: /\b(?:new|updated|revised|real|actual|true)\s+(?:instruction|instructions|system\s+prompt|directive|directives)\s*[:\-—]/gi,
  },
  // a forged system/role turn pasted into user content
  {
    id: "inj.spoof.role_header",
    category: "role_spoof",
    re: /(?:^|\n)\s*(?:\[|<|#{1,3}\s*)?(?:system|assistant|developer)\s*(?:\]|>)?\s*:/gi,
  },
  {
    id: "inj.spoof.chatml",
    category: "role_spoof",
    re: /<\|(?:im_start|im_end|system|endoftext)\|>/gi,
  },
  {
    id: "inj.spoof.you_are_now",
    category: "role_spoof",
    re: /\byou\s+are\s+(?:now|no\s+longer)\b[^.\n]{0,60}?\b(?:an?\s+|the\s+)?(?:assistant|ai|model|bot|system|agent|unrestricted|unfiltered|different)\b/gi,
  },
  // system-prompt exfiltration
  {
    id: "inj.exfil.reveal_prompt",
    category: "prompt_exfiltration",
    re: /\b(?:reveal|repeat|print|output|show|display|echo|dump|disclose|reproduce|recite)\b[^.\n]{0,40}?\b(?:system\s+prompt|initial\s+prompt|original\s+instructions|your\s+instructions|these\s+instructions|the\s+prompt\s+above|your\s+rules|hidden\s+prompt)\b/gi,
  },
  {
    id: "inj.exfil.verbatim",
    category: "prompt_exfiltration",
    re: /\b(?:repeat|output|print)\b[^.\n]{0,30}?\b(?:everything\s+above|the\s+text\s+above|verbatim|word\s+for\s+word)\b/gi,
  },
  // tool hijack: content telling the agent which governed tool to call
  {
    id: "inj.tool.invoke_directive",
    category: "tool_hijack",
    re: /\b(?:call|invoke|execute|run|use)\b[^.\n]{0,30}?\bthe\s+(?:\w[\w-]*\s+)?tool\b[^.\n]{0,40}?\bwith\b/gi,
  },
  {
    id: "inj.tool.exfil_directive",
    category: "tool_hijack",
    re: /\b(?:send|post|upload|forward|exfiltrate|transmit|email)\b[^.\n]{0,50}?\b(?:to\s+(?:https?:\/\/|the\s+(?:attacker|external|following)\b)|to\s+[\w.+-]+@[\w.-]+)/gi,
  },
  // instructions hidden where a human reviewer will not see them
  {
    id: "inj.hidden.html_comment",
    category: "hidden_instruction",
    re: /<!--[\s\S]{0,400}?\b(?:ignore|instruction|instructions|system\s+prompt|you\s+must|do\s+not\s+tell)\b[\s\S]{0,400}?-->/gi,
  },
  {
    id: "inj.hidden.do_not_tell",
    category: "hidden_instruction",
    re: /\b(?:do\s+not|don'?t|never)\b[^.\n]{0,30}?\b(?:tell|mention|inform|reveal\s+(?:this|it)\s+to|show\s+this\s+to)\b[^.\n]{0,30}?\b(?:the\s+)?(?:user|human|operator|anyone)\b/gi,
  },
];

export const promptInjectionDetector: GuardrailDetector = {
  id: "prompt_injection",
  tier: "heuristic",
  phases: ["input", "output"],
  summary:
    "Instruction-override, forged role turns, system-prompt exfiltration and tool-hijack phrasings in user-supplied or tool-returned content.",
  limits:
    "Literal English phrasings only. Encoded (base64), translated, homoglyph, leetspeak or novel framings evade it, and text ABOUT prompt injection matches it. Heuristic, not a classifier.",
  ruleIds: INJECTION_RULES.map((r) => r.id),
  detect(text, terms) {
    if (!text) return [];
    const hits = runRules(text, INJECTION_RULES, "prompt_injection");
    const custom = countTerms(text, terms);
    if (custom > 0) hits.push({ detector: "prompt_injection", category: "custom_term", count: custom });
    return hits;
  },
};

// ---------------------------------------------------------------------------
// 2. JAILBREAK (input)
// ---------------------------------------------------------------------------
// Known policy-evasion FRAMINGS. Distinct from injection: injection attacks the
// instruction hierarchy, a jailbreak attacks the safety posture inside it.

const JAILBREAK_RULES: readonly Rule[] = [
  {
    id: "jb.persona.dan",
    category: "known_persona",
    re: /\b(?:DAN|D\.A\.N\.|AIM|STAN|DUDE)\b(?=[^\w]{0,10}(?:mode|prompt|jailbreak|persona|you)|\s*$)|\bdo\s+anything\s+now\b/g,
  },
  {
    id: "jb.persona.developer_mode",
    category: "known_persona",
    re: /\b(?:developer|debug|god|root|sudo|admin|unrestricted|uncensored|unfiltered)\s+mode\b/gi,
  },
  {
    id: "jb.persona.jailbreak_word",
    category: "known_persona",
    re: /\bjail\s?break(?:ing|en|ed)?\b(?![\s-]*(?:detection|detector|guardrail|prevention|attempt\s+was\s+blocked))/gi,
  },
  {
    id: "jb.evasion.no_restrictions",
    category: "policy_evasion",
    re: /\b(?:without|with\s+no|free\s+(?:from|of)|ignoring|bypassing|disabling|removing|turning\s+off)\b[^.\n]{0,30}?\b(?:restrictions?|limitations?|filters?|guardrails?|safety|censorship|content\s+polic(?:y|ies)|ethical\s+guidelines?|moral\s+(?:constraints?|guidelines?))\b/gi,
  },
  {
    id: "jb.evasion.pretend",
    category: "policy_evasion",
    re: /\b(?:pretend|imagine|act\s+as\s+(?:if|though)|roleplay\s+as|simulate\s+being|behave\s+as\s+if)\b[^.\n]{0,60}?\b(?:no\s+(?:rules|restrictions|filters|limits|guidelines)|not\s+bound|unrestricted|uncensored|unfiltered|can\s+say\s+anything|without\s+(?:restrictions|filters|limits))\b/gi,
  },
  {
    id: "jb.evasion.hypothetical_shield",
    category: "policy_evasion",
    re: /\b(?:hypothetically|in\s+a\s+fictional\s+(?:world|scenario|story)|for\s+(?:a\s+)?(?:novel|story|movie|research)\s+purposes?|purely\s+(?:academic|educational|theoretical))\b[^.\n]{0,80}?\b(?:how\s+(?:to|would\s+(?:one|i|you))|steps?\s+to|instructions?\s+for|recipe\s+for)\b/gi,
  },
  {
    id: "jb.evasion.opposite_day",
    category: "policy_evasion",
    re: /\b(?:opposite\s+day|reverse\s+psychology|answer\s+as\s+your\s+evil|evil\s+(?:twin|version|counterpart))\b/gi,
  },
  {
    id: "jb.pressure.override_claim",
    category: "authority_claim",
    re: /\b(?:i\s+am|this\s+is|as)\s+(?:your\s+)?(?:the\s+)?(?:developer|creator|owner|administrator|openai|anthropic|engineer)\b[^.\n]{0,50}?\b(?:override|disable|turn\s+off|grant|unlock|authoriz)/gi,
  },
];

export const jailbreakDetector: GuardrailDetector = {
  id: "jailbreak",
  tier: "heuristic",
  phases: ["input"],
  summary:
    "Known jailbreak personas (DAN, 'developer mode') and policy-evasion structures — hypothetical shields, 'no restrictions' framings, forged authority claims.",
  limits:
    "A fixed list of PUBLISHED framings. Novel or paraphrased jailbreaks are invisible to it, and legitimate fiction/security-research prompts can match. Heuristic, not a classifier.",
  ruleIds: JAILBREAK_RULES.map((r) => r.id),
  detect(text, terms) {
    if (!text) return [];
    const hits = runRules(text, JAILBREAK_RULES, "jailbreak");
    const custom = countTerms(text, terms);
    if (custom > 0) hits.push({ detector: "jailbreak", category: "custom_term", count: custom });
    return hits;
  },
};

// ---------------------------------------------------------------------------
// 3. TOXICITY (input + output)
// ---------------------------------------------------------------------------
// A deliberately SMALL, non-slur lexicon plus threat/self-harm/harassment
// phrasings. The shipped list is intentionally minimal — a real moderation
// lexicon is a maintained, locale-aware artifact and pretending to ship one
// here would be the dishonest option. `customTerms.toxicity` is the supported
// way an org adds the vocabulary it actually cares about.

const TOXICITY_RULES: readonly Rule[] = [
  {
    id: "tox.threat.violence",
    category: "threat",
    re: /\b(?:i(?:'m|\s+am)?\s+(?:going\s+to|gonna|will)\s+(?:kill|murder|shoot|stab|beat|hurt|destroy)\s+(?:you|him|her|them|your)|i\s+will\s+find\s+you\s+and)\b/gi,
  },
  {
    id: "tox.threat.imperative",
    category: "threat",
    re: /\b(?:kill|hurt|attack|assault|shoot)\s+(?:yourself|him|her|them|that\s+guy)\b|\bkys\b/gi,
  },
  {
    id: "tox.selfharm.encouragement",
    category: "self_harm",
    re: /\b(?:you\s+should|why\s+don'?t\s+you|go(?:\s+and)?)\s+(?:kill\s+yourself|end\s+(?:it|your\s+life)|hang\s+yourself)\b/gi,
  },
  {
    id: "tox.harassment.dehumanize",
    category: "harassment",
    re: /\byou(?:'re|\s+are)\s+(?:such\s+)?(?:a\s+|an\s+)?(?:worthless|pathetic|disgusting|subhuman|vermin|trash|garbage|scum)\b/gi,
  },
  {
    id: "tox.harassment.directed_insult",
    category: "harassment",
    re: /\b(?:shut\s+the\s+f\w*\s+up|go\s+to\s+hell|piss\s+off)\b/gi,
  },
  {
    id: "tox.profanity.strong",
    category: "profanity",
    re: /\b(?:f+u+c+k+(?:ing|er|ed|s)?|sh+i+t+(?:ty|s)?|bastard|asshole|bitch(?:es)?|cunt|dickhead|motherfucker)\b/gi,
  },
];

export const toxicityDetector: GuardrailDetector = {
  id: "toxicity",
  tier: "heuristic",
  phases: ["input", "output"],
  summary:
    "Directed threats, self-harm encouragement, dehumanizing harassment and strong profanity, by word-boundary lexicon and phrase pattern.",
  limits:
    "A SMALL shipped lexicon with no slurs, no locale coverage beyond English, no context awareness (a quoted slur and a used one are identical to it) and no severity scoring. Extend it with customTerms.toxicity; it is not a moderation API.",
  ruleIds: TOXICITY_RULES.map((r) => r.id),
  detect(text, terms) {
    if (!text) return [];
    const hits = runRules(text, TOXICITY_RULES, "toxicity");
    const custom = countTerms(text, terms);
    if (custom > 0) hits.push({ detector: "toxicity", category: "custom_term", count: custom });
    return hits;
  },
};

// ---------------------------------------------------------------------------
// 4. SEMANTIC DLP (input + output)
// ---------------------------------------------------------------------------
// ADR-0042 calls this "classifier-scored sensitivity rather than pattern
// match". THAT IS NOT WHAT THIS IS, and the name would over-claim if left
// unqualified. What ships is the deterministic subset that is genuinely
// implementable with no model: declared confidentiality MARKERS, credential/
// secret SHAPES, and the org's own configured terms. The scored-classifier path
// is the `tier: "model"` registration that this deployment cannot make.

const DLP_RULES: readonly Rule[] = [
  {
    id: "dlp.marker.classification",
    category: "confidentiality_marker",
    re: /\b(?:strictly\s+)?(?:confidential|proprietary\s+and\s+confidential|company\s+confidential|internal\s+use\s+only|internal\s+only|restricted\s+distribution|do\s+not\s+distribute|not\s+for\s+distribution|trade\s+secret|attorney[-\s]client\s+privileged|privileged\s+and\s+confidential|under\s+nda|nda[-\s]protected)\b/gi,
  },
  {
    id: "dlp.marker.unreleased",
    category: "confidentiality_marker",
    re: /\b(?:unreleased|unannounced|pre[-\s]?release|embargoed)\b[^.\n]{0,30}?\b(?:roadmap|product|feature|launch|pricing|earnings|results|acquisition)\b/gi,
  },
  {
    id: "dlp.secret.aws_key",
    category: "credential_material",
    re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  },
  {
    id: "dlp.secret.private_key",
    category: "credential_material",
    re: /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+|PGP\s+)?PRIVATE\s+KEY(?:\s+BLOCK)?-----/g,
  },
  {
    id: "dlp.secret.jwt",
    category: "credential_material",
    // ADR-0176: the start is anchored to the START of a base64url run
    // (`(?<![A-Za-z0-9_-])`, not `\b`). With `\b`, "eyJ-eyJ-eyJ-…" offered a
    // start every four characters, each scanning to the end of the run: 1.5 s
    // on 50k characters, on the audit write path. One start per run is linear.
    re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    id: "dlp.secret.assignment",
    category: "credential_material",
    re: /\b(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd|bearer)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}["']?/gi,
  },
  {
    id: "dlp.secret.provider_token",
    category: "credential_material",
    // Legacy OpenAI `sk-…` (gitleaks `openai-api-key`, second alternative),
    // GitHub classic tokens `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` (gitleaks
    // `github-pat`, `github-oauth`, `github-app-token`, `github-refresh-token`:
    // `{36}`; matched here from 20 so a truncated paste is still caught), and
    // Slack `xox?-`.
    re: /\b(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  },
  // ADR-0176 security fix 2 — current provider token formats. Each rule is
  // based on the gitleaks default ruleset (github.com/gitleaks/gitleaks,
  // config/gitleaks.toml, MIT; rule ids cited per rule, read 2026-10-05) so
  // vendoring that ruleset later is a mechanical swap. Where a rule here
  // differs from gitleaks the difference is stated, and is always one of:
  //   - gitleaks' trailing context `(?:[\x60'"\s;]|\\[nr]|$)` is dropped: it
  //     exists to cut false positives in source code, and this text is prose
  //     (an audit reason ends a key with "," or ")" as often as with a space);
  //   - a body length is widened to a bounded range where the provider has
  //     shipped more than one length.
  // Every quantifier is bounded, no two adjacent quantified terms overlap in
  // a way that can backtrack, and a start is only tried at a fixed literal
  // prefix, so each rule is linear in the input (pinned by a timing test).
  {
    // gitleaks `anthropic-api-key` (`sk-ant-api03-[a-zA-Z0-9_\-]{93}AA`) and
    // `anthropic-admin-api-key` (`sk-ant-admin01-…{93}AA`), generalised to any
    // `sk-ant-<kind><nn>-` credential with a 32..200 character body.
    id: "dlp.secret.anthropic_key",
    category: "credential_material",
    re: /\bsk-ant-[a-z]{3,8}\d{2}-[A-Za-z0-9_-]{32,200}/g,
  },
  {
    // gitleaks `openai-api-key`, first alternative
    // (`sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|{58})T3BlbkFJ(?:{74}|{58})`),
    // generalised to the prefix with a 40..250 character body, so a key
    // without the `T3BlbkFJ` marker is caught too.
    id: "dlp.secret.openai_key",
    category: "credential_material",
    re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,250}/g,
  },
  {
    // gitleaks `github-fine-grained-pat`, verbatim body
    id: "dlp.secret.github_fine_grained_pat",
    category: "credential_material",
    re: /\bgithub_pat_\w{82}/g,
  },
  {
    // gitleaks `stripe-access-token`, verbatim body (secret and restricted
    // keys; live, test and prod). Publishable `pk_` keys are not secrets.
    id: "dlp.secret.stripe_key",
    category: "credential_material",
    re: /\b(?:sk|rk)_(?:test|live|prod)_[A-Za-z0-9]{10,99}/g,
  },
  {
    // gitleaks `gcp-api-key`, verbatim body; the trailing context becomes
    // "not followed by another key character", since the key is exactly 39
    id: "dlp.secret.google_api_key",
    category: "credential_material",
    re: /\bAIza[\w-]{35}(?![\w-])/g,
  },
  {
    // gitleaks `gitlab-pat` (`glpat-[\w-]{20}`) and `gitlab-pat-routable`
    // (`glpat-[0-9a-zA-Z_-]{27,300}\.[0-9a-z]{2}[0-9a-z]{7}`), as one rule
    id: "dlp.secret.gitlab_pat",
    category: "credential_material",
    re: /\bglpat-[\w-]{20,300}(?:\.[0-9a-z]{9})?/g,
  },
  // The credential shapes THIS PRODUCT mints. Every one is `rgl` + an optional
  // kind letter/word + `_` + a long hex run: `rgl_` (ADR-0025 user API key),
  // `rglv_` (ADR-0066 virtual key), `rgls_` (session cookie token) and
  // `rglscim_` (SCIM bearer). They live HERE rather than in the audit scrubber
  // that consumes them, because a codebase with two lists of "what one of our
  // own credentials looks like" will eventually have two DIFFERENT lists.
  {
    id: "dlp.secret.regulait_token",
    category: "credential_material",
    re: /\brgl(?:v|s|scim)?_[A-Fa-f0-9]{24,}\b/g,
  },
  {
    id: "dlp.financial.material_nonpublic",
    category: "material_nonpublic",
    re: /\b(?:material\s+non[-\s]?public\s+information|mnpi|insider\s+information|pre[-\s]?earnings\s+(?:figures|numbers|results)|quiet\s+period)\b/gi,
  },
];

export const semanticDlpDetector: GuardrailDetector = {
  id: "semantic_dlp",
  tier: "heuristic",
  phases: ["input", "output"],
  summary:
    "Exfiltration signals regex PII misses: declared confidentiality markers, credential/secret material shapes, material-non-public phrasing, and the org's own configured terms.",
  limits:
    "NOT a semantic/embedding classifier and does not score sensitivity. It sees DECLARED markers, secret SHAPES and CONFIGURED terms — an unmarked confidential document with no configured term is invisible to it. The scored model-backed tier is unwired in this deployment.",
  ruleIds: DLP_RULES.map((r) => r.id),
  detect(text, terms) {
    if (!text) return [];
    const hits = runRules(text, DLP_RULES, "semantic_dlp");
    const custom = countTerms(text, terms);
    if (custom > 0) hits.push({ detector: "semantic_dlp", category: "custom_term", count: custom });
    return hits;
  },
};

/**
 * The credential-material rules ALONE, exported so a consumer that must do
 * something other than COUNT them (the ADR-0099 audit-log scrubber, which has
 * to locate and replace the matched run) reuses these exact RegExp objects
 * rather than keeping a copy that drifts.
 *
 * It is a FILTER of `DLP_RULES`, not a second list: adding a credential shape
 * above automatically extends both the detector and the scrubber, and there is
 * no way to add one to only one of them.
 *
 * Consumers MUST treat the RegExp objects as shared mutable state — every one
 * carries `/g`, so reset `lastIndex` before use, exactly as `runRules` does.
 */
export const CREDENTIAL_MATERIAL_RULES: readonly { readonly id: string; readonly re: RegExp }[] =
  DLP_RULES.filter((r) => r.category === "credential_material");

// ---------------------------------------------------------------------------
// 5. PII — classifier #1 in the registry (ADR-0042 §Decision)
// ---------------------------------------------------------------------------
// The SAME `detectPII` §8.4 already enforces, wrapped in the detector
// interface so PII stops being a special case beside the engine and becomes a
// member of it. See the deviation note in the ADR amendment: the DISPATCH path
// still calls the dedicated `enforcePII` for the PII decision so ADR-0019's
// exact response/audit semantics are preserved byte-for-byte; this
// registration is what the engine's `evaluate`, the admin registry and the
// tuning sandbox use.

export const piiDetector: GuardrailDetector = {
  id: "pii",
  tier: "heuristic",
  phases: ["input", "output"],
  summary:
    "Formatted personal identifiers: email, bounded US SSN, Luhn-validated card runs, separator-bearing US phone (§8.4's detectPII, unchanged).",
  limits:
    "Pattern-matched US-centric identifiers only. No names, no addresses, no free-text personal data. ADR-0117's international national-identifier detectors are NOT reachable from this registration: `GuardrailDetector.detect` takes no deployment configuration, and the jurisdiction set is deployment configuration. The DISPATCH path (which calls `enforcePII` directly, as the note below says) DOES apply them. So this registration — the admin registry view and the tuning sandbox — is narrower than what actually enforces, and says so rather than implying parity.",
  ruleIds: ["pii.email", "pii.ssn", "pii.credit_card", "pii.phone"],
  detect(text) {
    // Deliberately NOT passing a jurisdiction set: there is none to pass here.
    // See `limits` — this is the narrower of the two PII surfaces, on purpose.
    return detectPII(text).map((h: PiiHit) => ({
      detector: "pii" as const,
      category: h.category,
      count: h.count,
    }));
  },
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const GUARDRAIL_DETECTORS: Readonly<Record<GuardrailDetectorId, GuardrailDetector>> = {
  pii: piiDetector,
  prompt_injection: promptInjectionDetector,
  jailbreak: jailbreakDetector,
  toxicity: toxicityDetector,
  semantic_dlp: semanticDlpDetector,
};

/** The detector list an admin surface renders, in a stable order. */
export function guardrailRegistry(): GuardrailDetector[] {
  return GUARDRAIL_DETECTOR_IDS.map((id) => GUARDRAIL_DETECTORS[id]);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** The per-detector modes in force for one call, after scope resolution. */
export type GuardrailModes = Record<GuardrailDetectorId, GuardrailMode>;

/** One detector's verdict on one phase. */
export interface GuardrailFinding {
  detector: GuardrailDetectorId;
  mode: GuardrailMode;
  /** what the mode makes of the hits: 'block' refuses, 'warn' proceeds with a
   * warning, 'log' proceeds silently-but-recorded. Absent when no hits. */
  action: "block" | "warn" | "log";
  hits: GuardrailHit[];
}

export interface GuardrailEvaluation {
  phase: GuardrailPhase;
  /** every detector that produced at least one hit, in registry order */
  findings: GuardrailFinding[];
  /** the strongest action any finding demands — the caller's decision input */
  action: "allow" | "log" | "warn" | "block";
  /** the findings whose action is 'block' (empty unless action==='block') */
  blocking: GuardrailFinding[];
}

const ACTION_RANK = { allow: 0, log: 1, warn: 2, block: 3 } as const;

/**
 * Run every detector whose mode is not `off` and which declares this phase.
 * Pure over its arguments — no I/O, no clock, no database. `exclude` exists
 * for the one caller that enforces a detector through a dedicated path (PII in
 * `executeGovernedDispatch`) and must not double-count it.
 */
export function evaluateGuardrails(args: {
  phase: GuardrailPhase;
  text: string;
  modes: GuardrailModes;
  terms?: GuardrailTerms | undefined;
  exclude?: readonly GuardrailDetectorId[] | undefined;
}): GuardrailEvaluation {
  const findings: GuardrailFinding[] = [];
  let action: GuardrailEvaluation["action"] = "allow";
  for (const id of GUARDRAIL_DETECTOR_IDS) {
    if (args.exclude?.includes(id)) continue;
    const mode = args.modes[id] ?? "off";
    if (mode === "off") continue;
    const detector = GUARDRAIL_DETECTORS[id];
    if (!detector.phases.includes(args.phase)) continue;
    const hits = detector.detect(args.text, args.terms?.[id]);
    if (hits.length === 0) continue;
    // mode -> action is exactly enforcePII's mapping: block blocks, warn
    // warns, log allows-but-records.
    const findingAction = mode === "block" ? "block" : mode === "warn" ? "warn" : "log";
    findings.push({ detector: id, mode, action: findingAction, hits });
    if (ACTION_RANK[findingAction] > ACTION_RANK[action]) action = findingAction;
  }
  return {
    phase: args.phase,
    findings,
    action,
    blocking: findings.filter((f) => f.action === "block"),
  };
}

/** COUNTS-ONLY summary for a refusal message / audit reason: which detector
 * and which category, never the matched text. */
export function guardrailCategoryList(findings: readonly GuardrailFinding[]): string {
  return findings
    .flatMap((f) => f.hits.map((h) => `${f.detector}:${h.category}`))
    .join(", ");
}

/** The marker a bill-and-withhold OUTPUT block substitutes for the model text.
 * Legible, and counts-only safe — same contract as `piiWithheldMarker`. */
export function guardrailWithheldMarker(findings: readonly GuardrailFinding[]): string {
  return `[output withheld — guardrail violation: ${guardrailCategoryList(findings)}]`;
}

/** The shipped org default posture (ADR-0042 §3): heuristic-only, and every
 * added layer at `log` so switching the engine on cannot silently start
 * refusing traffic. PII is NOT defaulted here — it stays governed by the §8.3
 * cascade's `piiMode` exactly as before, which is what "PII at the cascade
 * ceiling" means. */
export const GUARDRAIL_DEFAULT_MODES: GuardrailModes = {
  pii: "off",
  prompt_injection: "log",
  jailbreak: "log",
  toxicity: "log",
  semantic_dlp: "log",
};

/** MAX-of-strictness composition across any number of partial mode maps. Later
 * arguments never relax an earlier one — this is the single definition of
 * "the compliance cascade is the ceiling". */
export function composeGuardrailModes(
  ...maps: Array<Partial<GuardrailModes> | null | undefined>
): GuardrailModes {
  const out = Object.fromEntries(
    GUARDRAIL_DETECTOR_IDS.map((id) => [id, "off" as GuardrailMode]),
  ) as GuardrailModes;
  for (const map of maps) {
    if (!map) continue;
    for (const id of GUARDRAIL_DETECTOR_IDS) {
      const m = map[id];
      if (m) out[id] = strictestMode(out[id], m);
    }
  }
  return out;
}

/** Merge admin term lists additively across scopes (org + override). */
export function composeGuardrailTerms(
  ...maps: Array<GuardrailTerms | null | undefined>
): GuardrailTerms {
  const out: GuardrailTerms = {};
  for (const map of maps) {
    if (!map) continue;
    for (const id of GUARDRAIL_DETECTOR_IDS) {
      const list = map[id];
      if (!list?.length) continue;
      out[id] = [...new Set([...(out[id] ?? []), ...list.map((t) => t.trim()).filter(Boolean)])];
    }
  }
  return out;
}
