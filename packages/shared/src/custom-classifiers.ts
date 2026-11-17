/**
 * ADR-0363 slice 2 — CUSTOMER-DEFINED CLASSIFIERS, run inside the existing guardrail pipeline (ADR-0042).
 *
 * Four kinds:
 *   - `regex`       one RE2 pattern (`re2js`, linear time, the ADR-0186 engine). A pattern RE2 cannot compile is
 *                   refused when it is saved, never run on the native engine.
 *   - `keyword`     up to 200 phrases, matched case-insensitively on word boundaries (the admin-term rule of
 *                   `guardrail_configs.custom_terms`, the same function).
 *   - `dictionary`  up to 50,000 single words, matched by a token-set lookup (linear in the text, not in the list).
 *   - `exact_data_match` (EDM) a customer's column of values (employee ids, account numbers). Each value is normalised
 *                   and HMAC-SHA256'd under a deployment secret BEFORE it is stored; only the digests exist. At scan
 *                   time each token window of the text (1..`maxTokens` tokens) is normalised, hashed and looked up.
 *
 * Pure: the HMAC is injected (`hash`), so this module never sees the key and has no I/O. Results are counts only,
 * never the matched text, the same contract as every guardrail hit.
 *
 * Lifecycle (owner rule 12): one declared transition table, `CLASSIFIER_VERSION_TRANSITIONS`, enforced server side
 * by `classifierTransitionProblem`. A version is drafted, submitted for approval, then published or rejected; a newer
 * published version supersedes the older one; a published version can be retired.
 */
import { RE2JS } from "re2js";
import { z } from "zod";
import { countGuardrailTerms, type GuardrailMode, type GuardrailPhase } from "./guardrails.js";

export const CLASSIFIER_KINDS = ["regex", "keyword", "dictionary", "exact_data_match"] as const;
export type ClassifierKind = (typeof CLASSIFIER_KINDS)[number];

/** the enforcement verbs a classifier may carry: the guardrail engine's own (no `off`: retire it instead) */
export const CLASSIFIER_MODES = ["log", "warn", "block"] as const satisfies readonly GuardrailMode[];
export type ClassifierMode = (typeof CLASSIFIER_MODES)[number];

export const EDM_NORMALISATIONS = ["exact", "casefold", "alphanumeric", "digits"] as const;
export type EdmNormalisation = (typeof EDM_NORMALISATIONS)[number];

export const CLASSIFIER_LIMITS = Object.freeze({
  regexLength: 512,
  keywordCount: 200,
  termLength: 128,
  dictionaryCount: 50_000,
  edmValues: 100_000,
  edmValueLength: 256,
  edmMaxTokens: 6,
  /** the text a classifier scans is capped, so a dictionary or EDM scan stays bounded */
  scanChars: 1_000_000,
});

const term = z.string().trim().min(1).max(CLASSIFIER_LIMITS.termLength);

export const classifierDefinitionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("regex"), pattern: z.string().min(1).max(CLASSIFIER_LIMITS.regexLength), caseInsensitive: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal("keyword"), terms: z.array(term).min(1).max(CLASSIFIER_LIMITS.keywordCount) }).strict(),
  z
    .object({ kind: z.literal("dictionary"), terms: z.array(term.regex(/^\S+$/, "a dictionary word has no spaces")).min(1).max(CLASSIFIER_LIMITS.dictionaryCount) })
    .strict(),
  z
    .object({
      kind: z.literal("exact_data_match"),
      normalisation: z.enum(EDM_NORMALISATIONS),
      /** the longest value, in tokens, the scan looks for (a full name is 2–3) */
      maxTokens: z.number().int().min(1).max(CLASSIFIER_LIMITS.edmMaxTokens),
    })
    .strict(),
]);
export type ClassifierDefinition = z.infer<typeof classifierDefinitionSchema>;

export const CLASSIFIER_KEY_RE = /^[a-z][a-z0-9_]{1,47}$/;

/** the plaintext EDM values arrive once, on the write request, and are hashed there; never stored */
export const edmValuesSchema = z.array(z.string().max(CLASSIFIER_LIMITS.edmValueLength)).min(1).max(CLASSIFIER_LIMITS.edmValues);

// ---------------------------------------------------------------------------------------------------------------
// The lifecycle: one declared machine (owner rule 12)
// ---------------------------------------------------------------------------------------------------------------

export const CLASSIFIER_VERSION_STATUSES = ["draft", "pending_approval", "published", "rejected", "superseded", "retired"] as const;
export type ClassifierVersionStatus = (typeof CLASSIFIER_VERSION_STATUSES)[number];

/** every allowed move, with what causes it; anything absent is refused */
export const CLASSIFIER_VERSION_TRANSITIONS: Readonly<Record<ClassifierVersionStatus, Readonly<Partial<Record<ClassifierVersionStatus, string>>>>> =
  Object.freeze({
    draft: { pending_approval: "submitted for approval to a named reviewer" },
    pending_approval: { published: "the reviewer approved it", rejected: "the reviewer denied it" },
    published: { superseded: "a newer version was published", retired: "an admin retired the classifier (step-up)" },
    rejected: {},
    superseded: {},
    retired: {},
  });

/** null when `from` → `to` is allowed, else the reason it is not */
export function classifierTransitionProblem(from: ClassifierVersionStatus, to: ClassifierVersionStatus): string | null {
  return CLASSIFIER_VERSION_TRANSITIONS[from][to] ? null : `a ${from} classifier version cannot become ${to}`;
}

/** the statuses that take effect at the gateway */
export const CLASSIFIER_LIVE_STATUSES: readonly ClassifierVersionStatus[] = ["published"];

// ---------------------------------------------------------------------------------------------------------------
// Normalisation and tokenising (shared by the EDM upload and the scan, so they can never disagree)
// ---------------------------------------------------------------------------------------------------------------

/** one value normalised for EDM; "" means the value has nothing to match and is skipped */
export function edmNormalise(value: string, mode: EdmNormalisation): string {
  const collapsed = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  switch (mode) {
    case "exact":
      return collapsed;
    case "casefold":
      return collapsed.toLowerCase();
    case "alphanumeric":
      return collapsed.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").replace(/ +/g, " ").trim();
    case "digits":
      return collapsed.replace(/\D+/g, "");
  }
}

/** the text's tokens: runs of letters, digits and the joiners an identifier keeps (`-`, `.`, `_`, `@`, `/`) */
export function classifierTokens(text: string): string[] {
  return text.slice(0, CLASSIFIER_LIMITS.scanChars).match(/[\p{L}\p{N}][\p{L}\p{N}\-._@/]*/gu) ?? [];
}

/** the dictionary's lookup form of a word */
const dictForm = (w: string) => w.normalize("NFKC").toLowerCase();

// ---------------------------------------------------------------------------------------------------------------
// Compiling and running
// ---------------------------------------------------------------------------------------------------------------

export interface ClassifierSpec {
  /** stable slug; the finding category is `classifier.<key>` */
  key: string;
  version: number;
  mode: ClassifierMode;
  phases: readonly GuardrailPhase[];
  definition: ClassifierDefinition;
  /** EDM only: the stored digests (lower-case hex) */
  digests?: readonly string[];
}

export interface CompiledClassifier {
  key: string;
  version: number;
  mode: ClassifierMode;
  phases: readonly GuardrailPhase[];
  /** how many matches, never what; `unavailable` = it could not run (an EDM classifier with no key): fail closed */
  count(text: string): number | "unavailable";
}

/** a reason the definition cannot be saved, or null (RE2 must compile the pattern) */
export function classifierDefinitionProblem(def: ClassifierDefinition): string | null {
  if (def.kind !== "regex") return null;
  try {
    RE2JS.compile(def.pattern, def.caseInsensitive ? RE2JS.CASE_INSENSITIVE : 0);
    return null;
  } catch (err) {
    return `the pattern is not valid RE2 (linear-time) syntax: ${String((err as Error).message ?? err).slice(0, 160)}`;
  }
}

/**
 * Compile one published version. `hash` is the deployment's EDM HMAC (hex out); null when the key is unavailable,
 * in which case an EDM classifier reports `unavailable` on every scan rather than "no match".
 */
export function compileClassifier(spec: ClassifierSpec, hash: ((normalised: string) => string) | null): CompiledClassifier {
  const base = { key: spec.key, version: spec.version, mode: spec.mode, phases: spec.phases };
  const def = spec.definition;
  switch (def.kind) {
    case "regex": {
      let re: RE2JS | null = null;
      try {
        re = RE2JS.compile(def.pattern, def.caseInsensitive ? RE2JS.CASE_INSENSITIVE : 0);
      } catch {
        re = null;
      }
      return {
        ...base,
        count(text) {
          if (!re) return "unavailable";
          const m = re.matcher(text.slice(0, CLASSIFIER_LIMITS.scanChars));
          let n = 0;
          while (m.find()) {
            if (m.end() === m.start()) continue;
            n++;
          }
          return n;
        },
      };
    }
    case "keyword":
      return { ...base, count: (text) => countGuardrailTerms(text.slice(0, CLASSIFIER_LIMITS.scanChars), def.terms) };
    case "dictionary": {
      const words = new Set(def.terms.map(dictForm));
      return {
        ...base,
        count(text) {
          let n = 0;
          for (const t of classifierTokens(text)) if (words.has(dictForm(t))) n++;
          return n;
        },
      };
    }
    case "exact_data_match": {
      const digests = new Set((spec.digests ?? []).map((d) => d.toLowerCase()));
      return {
        ...base,
        count(text) {
          if (!hash) return "unavailable";
          if (digests.size === 0) return 0;
          const tokens = classifierTokens(text);
          let n = 0;
          for (let i = 0; i < tokens.length; i++) {
            // the longest window first, so "Jane Doe" counts once, not also as "Jane"
            for (let w = Math.min(def.maxTokens, tokens.length - i); w >= 1; w--) {
              const norm = edmNormalise(tokens.slice(i, i + w).join(" "), def.normalisation);
              if (norm && digests.has(hash(norm))) {
                n++;
                i += w - 1;
                break;
              }
            }
          }
          return n;
        },
      };
    }
  }
}

/** the finding category a classifier's hits carry */
export const classifierCategory = (key: string) => `classifier.${key}`;
