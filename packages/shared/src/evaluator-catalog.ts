/**
 * ADR-0173 batch 2c (item 7) — THE EVALUATOR CATALOG, mapped to controls.
 *
 * One catalog over everything this product can measure with:
 *   - the 13 eval scorers (ADR-0044/0067),
 *   - the 5 guardrail detectors (ADR-0042),
 *   - the 10 red-team attack classes (ADR-0057/0068),
 *   - and every registered external scorer (ADR-0088), which inherits the
 *     references of the judge-backed metrics it claims to serve.
 *
 * Each entry cites NIST AI RMF subcategories, ISO/IEC 42001 and EU AI Act
 * controls, and OWASP ids. THE MAPPING IS OURS: it is a statement of which
 * control a measurement is EVIDENCE for, authored here against the public
 * framework catalogues, and like every pack mapping it is a well-informed
 * starting point rather than legal advice. Only the OWASP vocabulary (ids and
 * names) is third-party data, vendored from promptfoo's MIT framework tables
 * in `owasp-framework-mappings.ts`.
 *
 * EVERY REFERENCE RESOLVES. `catalogReferenceProblems()` checks each one:
 *   - a NIST id is one of the 72 subcategories of NIST AI 100-1;
 *   - an ISO/IEC 42001 or EU AI Act ref is a control of a shipped compliance
 *     pack (so the "tested by" chip has a control to sit on);
 *   - an OWASP id is a key of the vendored tables.
 * A test runs it, so a typo cannot reach a customer.
 *
 * NIST ids are kept in the bare form (`MEASURE-2.5`) and matched against pack
 * controls by `catalogRefMatchesControl`, because a `nist-ai-rmf:` ref outside
 * the pack definitions must be a control of the latest NIST pack (ADR-0175 A1),
 * while a measurement can honestly evidence a subcategory no pack lists yet.
 */
import { EVAL_SCORER_KINDS, evalScorerRegistry, isDeterministicScorer, type EvalScorerKind } from "./evals.js";
import { GUARDRAIL_DETECTOR_IDS, type GuardrailDetectorId } from "./guardrails.js";
import { RED_TEAM_ATTACK_CLASSES, redTeamAttackClassRegistry, type RedTeamAttackClass } from "./redteam.js";
import { DEFAULT_COMPLIANCE_PACKS } from "./compliance-packs.js";
import { isNistAiRmfSubcategory, normaliseNistAiRmfId } from "./nist-ai-rmf-subcategories.js";
import { OWASP_LLM_EDITIONS } from "./owasp-packs.js";
import {
  OWASP_AGENTIC_NAMES,
  OWASP_AGENTIC_TOP_10_MAPPING,
  OWASP_LLM_TOP_10_MAPPING,
  OWASP_LLM_TOP_10_NAMES,
  PROMPTFOO_FRAMEWORKS_SOURCE,
} from "./owasp-framework-mappings.js";

export const EVALUATOR_KINDS = ["scorer", "detector", "redteam_class", "external_scorer"] as const;
export type EvaluatorKind = (typeof EVALUATOR_KINDS)[number];

export interface EvaluatorRefs {
  /** bare NIST AI RMF 1.0 subcategory ids, e.g. `MEASURE-2.5` */
  nistAiRmf: readonly string[];
  /** ISO/IEC 42001 pack control refs, e.g. `iso-42001:9.1-monitoring-measurement` */
  iso42001: readonly string[];
  /** EU AI Act pack control refs, e.g. `eu-ai-act:art-15-accuracy-robustness` */
  euAiAct: readonly string[];
  /** OWASP ids: the LLM Top 10 on its 2026 numbering (`owasp:llm:2026:03`, ADR-0297) and the agentic list
   * (`owasp:agentic:asi02`). The 2025 ids (`owasp:llm:06`) still resolve, as aliases, wherever an id is read. */
  owasp: readonly string[];
}

export interface CatalogEvaluator {
  /** `scorer:<kind>` | `detector:<id>` | `redteam:<class>` | `external:<name>` */
  id: string;
  kind: EvaluatorKind;
  name: string;
  summary: string;
  limits: string;
  deterministic: boolean;
  /** where it can be run from the catalog */
  runnableOn: ReadonlyArray<"dataset" | "trace" | "redteam" | "runtime">;
  refs: EvaluatorRefs;
}

// ---------------------------------------------------------------------------
// Shorthand for the references (all checked by catalogReferenceProblems)
// ---------------------------------------------------------------------------

const ISO_MEASURE = "iso-42001:9.1-monitoring-measurement";
const ISO_LIFECYCLE = "iso-42001:A.6-ai-system-lifecycle";
const EU_ACCURACY = "eu-ai-act:art-15-accuracy-robustness";
const EU_OVERSIGHT = "eu-ai-act:art-14-human-oversight";
const EU_BIAS = "eu-ai-act:art-10-bias-examination";
const EU_MONITORING = "eu-ai-act:art-72-post-market-monitoring";

const refs = (r: Partial<EvaluatorRefs>): EvaluatorRefs => ({
  nistAiRmf: r.nistAiRmf ?? [],
  iso42001: r.iso42001 ?? [],
  euAiAct: r.euAiAct ?? [],
  owasp: r.owasp ?? [],
});

/** quality scorers: validity and reliability, measured against a test set */
const QUALITY = refs({ nistAiRmf: ["MEASURE-2.1", "MEASURE-2.5"], iso42001: [ISO_MEASURE], euAiAct: [EU_ACCURACY] });

export const SCORER_REFS: Readonly<Record<EvalScorerKind, EvaluatorRefs>> = {
  exact: QUALITY,
  contains: QUALITY,
  regex: QUALITY,
  // a schema check is the measurable half of "the output is safe to hand on"
  json_schema: refs({ ...QUALITY, owasp: ["owasp:llm:2026:10"] }),
  numeric: QUALITY,
  rubric: QUALITY,
  llm_as_judge: refs({ nistAiRmf: ["MEASURE-2.5", "MEASURE-2.13"], iso42001: [ISO_MEASURE], euAiAct: [EU_ACCURACY] }),
  // groundedness: fabricated claims are the misinformation risk
  claim_support: refs({
    nistAiRmf: ["MEASURE-2.5", "MEASURE-2.9"],
    iso42001: [ISO_MEASURE],
    euAiAct: [EU_ACCURACY],
    owasp: ["owasp:llm:2026:07"],
  }),
  // retrieval quality is the RAG weakness OWASP files under vector/embedding
  context_precision: refs({ nistAiRmf: ["MEASURE-2.5"], iso42001: [ISO_MEASURE], owasp: ["owasp:llm:2026:09"] }),
  context_recall: refs({ nistAiRmf: ["MEASURE-2.5"], iso42001: [ISO_MEASURE], owasp: ["owasp:llm:2026:09"] }),
  answer_relevance: refs({ nistAiRmf: ["MEASURE-2.5"], iso42001: [ISO_MEASURE], euAiAct: [EU_ACCURACY] }),
  groundedness_judge: refs({
    nistAiRmf: ["MEASURE-2.5", "MEASURE-2.9"],
    iso42001: [ISO_MEASURE],
    euAiAct: [EU_ACCURACY],
    owasp: ["owasp:llm:2026:07", "owasp:agentic:asi08"],
  }),
  answer_relevance_judge: refs({ nistAiRmf: ["MEASURE-2.5"], iso42001: [ISO_MEASURE], euAiAct: [EU_ACCURACY] }),
};

export const DETECTOR_REFS: Readonly<Record<GuardrailDetectorId, EvaluatorRefs>> = {
  pii: refs({ nistAiRmf: ["MEASURE-2.10"], iso42001: [ISO_MEASURE], euAiAct: [EU_MONITORING], owasp: ["owasp:llm:2026:02"] }),
  prompt_injection: refs({
    nistAiRmf: ["MEASURE-2.7"],
    iso42001: [ISO_MEASURE],
    euAiAct: [EU_ACCURACY],
    owasp: ["owasp:llm:2026:01", "owasp:agentic:asi01"],
  }),
  jailbreak: refs({ nistAiRmf: ["MEASURE-2.6", "MEASURE-2.7"], iso42001: [ISO_MEASURE], euAiAct: [EU_ACCURACY], owasp: ["owasp:llm:2026:01"] }),
  toxicity: refs({ nistAiRmf: ["MEASURE-2.6"], iso42001: [ISO_MEASURE], euAiAct: [EU_MONITORING] }),
  semantic_dlp: refs({ nistAiRmf: ["MEASURE-2.7", "MEASURE-2.10"], iso42001: [ISO_MEASURE], owasp: ["owasp:llm:2026:02"] }),
};

export const REDTEAM_CLASS_REFS: Readonly<Record<RedTeamAttackClass, EvaluatorRefs>> = {
  prompt_injection: refs({
    nistAiRmf: ["MEASURE-2.7"],
    iso42001: [ISO_LIFECYCLE],
    euAiAct: [EU_ACCURACY],
    owasp: ["owasp:llm:2026:01", "owasp:agentic:asi01"],
  }),
  jailbreak: refs({ nistAiRmf: ["MEASURE-2.6", "MEASURE-2.7"], iso42001: [ISO_LIFECYCLE], euAiAct: [EU_ACCURACY], owasp: ["owasp:llm:2026:01"] }),
  data_exfiltration: refs({
    nistAiRmf: ["MEASURE-2.7", "MEASURE-2.10"],
    iso42001: [ISO_LIFECYCLE],
    euAiAct: [EU_ACCURACY],
    owasp: ["owasp:llm:2026:02", "owasp:llm:2026:08"],
  }),
  pii_leak: refs({ nistAiRmf: ["MEASURE-2.10"], iso42001: [ISO_LIFECYCLE], owasp: ["owasp:llm:2026:02"] }),
  bias: refs({ nistAiRmf: ["MEASURE-2.11"], iso42001: [ISO_LIFECYCLE], euAiAct: [EU_BIAS] }),
  indirect_prompt_injection: refs({
    nistAiRmf: ["MEASURE-2.7"],
    iso42001: [ISO_LIFECYCLE],
    euAiAct: [EU_ACCURACY],
    owasp: ["owasp:llm:2026:01", "owasp:agentic:asi01", "owasp:agentic:asi06"],
  }),
  tool_abuse: refs({
    nistAiRmf: ["MEASURE-2.7"],
    iso42001: [ISO_LIFECYCLE],
    euAiAct: [EU_OVERSIGHT],
    owasp: ["owasp:llm:2026:03", "owasp:agentic:asi02"],
  }),
  excessive_agency: refs({
    nistAiRmf: ["MEASURE-2.7", "MANAGE-2.4"],
    iso42001: [ISO_LIFECYCLE],
    euAiAct: [EU_OVERSIGHT],
    owasp: ["owasp:llm:2026:03", "owasp:agentic:asi10"],
  }),
  system_prompt_extraction: refs({ nistAiRmf: ["MEASURE-2.7"], iso42001: [ISO_LIFECYCLE], owasp: ["owasp:llm:2026:08"] }),
  encoding_evasion: refs({ nistAiRmf: ["MEASURE-2.7"], iso42001: [ISO_LIFECYCLE], euAiAct: [EU_ACCURACY], owasp: ["owasp:llm:2026:01"] }),
};

/**
 * Which red-team classes EXERCISE a runtime detector. A detector is a runtime
 * control, not a test; it counts as tested only when a completed red-team run
 * that passed, of a class aimed at it, ran in the period. `toxicity` has no
 * class aimed at it, so it is never reported as tested — "not run" is the
 * honest answer, and it never counts as passed.
 */
export const DETECTOR_TESTED_BY: Readonly<Record<GuardrailDetectorId, readonly RedTeamAttackClass[]>> = {
  pii: ["pii_leak"],
  prompt_injection: ["prompt_injection", "indirect_prompt_injection", "encoding_evasion"],
  jailbreak: ["jailbreak"],
  toxicity: [],
  semantic_dlp: ["data_exfiltration", "system_prompt_extraction"],
};

const DETECTOR_TEXT: Readonly<Record<GuardrailDetectorId, { summary: string; limits: string }>> = {
  pii: {
    summary: "The §8.4 PII classifier, run on both phases of every governed call (ADR-0042 classifier #1).",
    limits: "Pattern detection of structured identifiers. Free-text disclosure of an identity is not pattern-detectable.",
  },
  prompt_injection: {
    summary: "Instruction-override phrasing in the input phase (ADR-0042).",
    limits: "Lexical. A novel phrasing or an encoding the patterns do not know passes it.",
  },
  jailbreak: {
    summary: "Safety-bypass framing in the input phase: role-play escapes, hypothetical framing (ADR-0042).",
    limits: "Lexical. It matches the surface form of known framings, not intent.",
  },
  toxicity: {
    summary: "Abusive or harmful language in the output phase (ADR-0042).",
    limits: "A term list, not a classifier. No red-team class is aimed at it, so it is never reported as tested.",
  },
  semantic_dlp: {
    summary: "Credential material and admin-listed sensitive terms in either phase (ADR-0042).",
    limits: "Catches what its rules and terms describe. A paraphrased secret is invisible to it.",
  },
};

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export function scorerEvaluatorId(kind: string): string {
  return `scorer:${kind}`;
}
export function detectorEvaluatorId(id: string): string {
  return `detector:${id}`;
}
export function redteamEvaluatorId(cls: string): string {
  return `redteam:${cls}`;
}
export function externalEvaluatorId(name: string): string {
  return `external:${name}`;
}

/** the static catalog: 13 scorers, 5 detectors, 10 red-team classes */
export function evaluatorCatalog(): CatalogEvaluator[] {
  const scorers: CatalogEvaluator[] = evalScorerRegistry().map((s) => ({
    id: scorerEvaluatorId(s.id),
    kind: "scorer",
    name: s.id,
    summary: s.summary,
    limits: s.limits,
    deterministic: s.deterministic,
    // deterministic scorers also run over trace previews; a judge never does
    runnableOn: isDeterministicScorer(s.id) ? ["dataset", "trace"] : ["dataset"],
    refs: SCORER_REFS[s.id],
  }));
  const detectors: CatalogEvaluator[] = GUARDRAIL_DETECTOR_IDS.map((d) => ({
    id: detectorEvaluatorId(d),
    kind: "detector",
    name: d,
    summary: DETECTOR_TEXT[d].summary,
    limits: DETECTOR_TEXT[d].limits,
    deterministic: true,
    runnableOn: ["runtime", "trace"],
    refs: DETECTOR_REFS[d],
  }));
  const classes: CatalogEvaluator[] = redTeamAttackClassRegistry().map((c) => ({
    id: redteamEvaluatorId(c.id),
    kind: "redteam_class",
    name: c.id,
    summary: c.summary,
    limits: c.limits,
    deterministic: false,
    runnableOn: ["redteam"],
    refs: REDTEAM_CLASS_REFS[c.id],
  }));
  return [...scorers, ...detectors, ...classes];
}

/** an external scorer cites the references of the judge-backed metrics it claims */
export function externalScorerCatalogEntry(scorer: { name: string; scorerKinds: readonly string[] }): CatalogEvaluator {
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  const claimed = scorer.scorerKinds.filter((k): k is EvalScorerKind =>
    (EVAL_SCORER_KINDS as readonly string[]).includes(k),
  );
  const pick = (f: keyof EvaluatorRefs) => uniq(claimed.flatMap((k) => [...SCORER_REFS[k][f]]));
  return {
    id: externalEvaluatorId(scorer.name),
    kind: "external_scorer",
    name: scorer.name,
    summary: `Registered external instrument (ADR-0088) serving ${claimed.join(", ") || "no metric"}.`,
    limits:
      "The vendor's opinion, governed and recorded but not validated by this platform. It inherits the references of the metrics it claims to serve.",
    deterministic: false,
    runnableOn: ["dataset"],
    refs: { nistAiRmf: pick("nistAiRmf"), iso42001: pick("iso42001"), euAiAct: pick("euAiAct"), owasp: pick("owasp") },
  };
}

// ---------------------------------------------------------------------------
// The OWASP vocabulary (vendored), and reference resolution
// ---------------------------------------------------------------------------

export interface OwaspRef {
  id: string;
  list: "owasp-llm-top-10" | "owasp-agentic-top-10";
  name: string;
  /** ADR-0297: an LLM id's edition (2026) and the 2025 id of the same risk, which still resolves */
  edition?: 2026;
  legacyId?: string;
}

/**
 * ADR-0297 (P24): THE LLM TOP 10 ON ITS 2026 NUMBERING. The 2026 edition renumbers the list (Excessive Agency moves
 * from LLM06 to LLM03; LLM03 was Supply Chain), so an id that only says `owasp:llm:03` would mean different risks in
 * the two editions. The catalog therefore cites edition-qualified ids, `owasp:llm:2026:NN`, and the 2025 ids the
 * vendored promptfoo table uses (`owasp:llm:NN`) are kept as aliases of the same risk: a required-test policy or a
 * golden case stored with a 2025 id keeps its meaning. The crosswalk is `OWASP_LLM_EDITIONS` (ADR-0243).
 */
export const OWASP_LLM_2026_PREFIX = "owasp:llm:2026:";
const LLM_2025_TO_2026: ReadonlyMap<string, string> = new Map(
  Object.values(OWASP_LLM_EDITIONS).map((e) => [`owasp:llm:${e[2025].slice(3)}`, `${OWASP_LLM_2026_PREFIX}${e[2026].slice(3)}`]),
);
const LLM_2026_TO_2025: ReadonlyMap<string, string> = new Map([...LLM_2025_TO_2026].map(([a, b]) => [b, a]));

/** the canonical (2026, edition-qualified) form of an OWASP id: a 2025 LLM id maps to its 2026 id; others unchanged */
export function canonicalOwaspId(id: string): string {
  return LLM_2025_TO_2026.get(id) ?? id;
}

/** every OWASP id the catalog may cite, with its name: the LLM Top 10 by its 2026 number, then the agentic list */
export function owaspReferences(): OwaspRef[] {
  // names come from the vendored (2025-ordered) promptfoo table, found through the 2025 id of the same risk
  const names2025 = new Map(Object.keys(OWASP_LLM_TOP_10_MAPPING).map((id, i) => [id, OWASP_LLM_TOP_10_NAMES[i] ?? id]));
  const llm = [...LLM_2026_TO_2025.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, legacyId]) => ({
      id,
      list: "owasp-llm-top-10" as const,
      name: names2025.get(legacyId) ?? id,
      edition: 2026 as const,
      legacyId,
    }));
  const agentic = Object.keys(OWASP_AGENTIC_TOP_10_MAPPING).map((id, i) => ({
    id,
    list: "owasp-agentic-top-10" as const,
    name: OWASP_AGENTIC_NAMES[i] ?? id,
  }));
  return [...llm, ...agentic];
}

export const OWASP_REFERENCE_SOURCE = PROMPTFOO_FRAMEWORKS_SOURCE;

/** every control ref declared by any shipped pack version */
function shippedPackControlRefs(): Set<string> {
  return new Set(DEFAULT_COMPLIANCE_PACKS.flatMap((p) => p.controls.map((c) => c.controlRef)));
}

/**
 * Every reference that does NOT resolve, as `<evaluator id>: <reason>`. Empty
 * means the catalog is clean. Pure; the test calls it on the static catalog
 * and on a synthetic external-scorer entry.
 */
export function catalogReferenceProblems(entries: readonly CatalogEvaluator[] = evaluatorCatalog()): string[] {
  const packRefs = shippedPackControlRefs();
  const owasp = new Set(owaspReferences().map((o) => o.id));
  const out: string[] = [];
  for (const e of entries) {
    for (const n of e.refs.nistAiRmf) {
      if (n.startsWith("nist-ai-rmf:")) out.push(`${e.id}: NIST ref '${n}' must be a bare subcategory id`);
      else if (!isNistAiRmfSubcategory(n)) out.push(`${e.id}: '${n}' is not a NIST AI RMF 1.0 subcategory`);
    }
    for (const r of e.refs.iso42001) {
      if (!r.startsWith("iso-42001:") || !packRefs.has(r)) out.push(`${e.id}: '${r}' is not an ISO/IEC 42001 pack control`);
    }
    for (const r of e.refs.euAiAct) {
      if (!r.startsWith("eu-ai-act:") || !packRefs.has(r)) out.push(`${e.id}: '${r}' is not an EU AI Act pack control`);
    }
    for (const r of e.refs.owasp) {
      if (!owasp.has(r)) out.push(`${e.id}: '${r}' is not a vendored OWASP id`);
    }
  }
  return out;
}

/** all of an evaluator's references as one list of control-shaped strings */
export function evaluatorRefList(e: Pick<CatalogEvaluator, "refs">): string[] {
  return [...e.refs.nistAiRmf, ...e.refs.iso42001, ...e.refs.euAiAct, ...e.refs.owasp];
}

/**
 * Does a catalog reference cite this pack control? NIST is matched on the
 * normalised subcategory (`MEASURE-2.5` ↔ `nist-ai-rmf:MEASURE-2.5`); an OWASP
 * LLM id on either edition's numbering (ADR-0297); every other framework on
 * the exact control ref.
 */
export function catalogRefMatchesControl(ref: string, controlRef: string): boolean {
  if (controlRef.startsWith("nist-ai-rmf:")) {
    return isNistAiRmfSubcategory(ref) && normaliseNistAiRmfId(ref) === normaliseNistAiRmfId(controlRef);
  }
  // ADR-0297: a control named by a 2025 OWASP LLM id is the same risk as the catalog's 2026 id
  if (controlRef.startsWith("owasp:llm:")) return canonicalOwaspId(ref) === canonicalOwaspId(controlRef);
  return ref === controlRef;
}

/** the evaluators that cite a control */
export function evaluatorsForControl(controlRef: string, entries: readonly CatalogEvaluator[]): CatalogEvaluator[] {
  return entries.filter((e) => evaluatorRefList(e).some((r) => catalogRefMatchesControl(r, controlRef)));
}

// ---------------------------------------------------------------------------
// "Tested by" — the status of an evaluator in a period
// ---------------------------------------------------------------------------

/**
 * `passed`  a completed run that used this evaluator passed in the period;
 * `failed`  completed runs used it in the period and none passed;
 * `not_run` nothing measured it in the period.
 * Only `passed` counts as tested. "Not run" is never a pass.
 */
export const EVALUATOR_TEST_STATUSES = ["passed", "failed", "not_run"] as const;
export type EvaluatorTestStatus = (typeof EVALUATOR_TEST_STATUSES)[number];

export interface EvaluatorTestEvidence {
  status: EvaluatorTestStatus;
  /** completed runs in the period that used the evaluator */
  runs: number;
  /** of which passed */
  passedRuns: number;
  lastRunId: string | null;
}

export function evaluatorTestStatus(runs: number, passedRuns: number): EvaluatorTestStatus {
  if (passedRuns > 0) return "passed";
  if (runs > 0) return "failed";
  return "not_run";
}

export const EVALUATOR_CATALOG_NOTE =
  "Every evaluator cites the controls it is evidence for: NIST AI RMF subcategories, ISO/IEC 42001 and EU AI Act " +
  "pack controls, and OWASP ids (the LLM Top 10 on its 2026 numbering, `owasp:llm:2026:NN`, with 2025 ids still " +
  "accepted; names from promptfoo's MIT framework tables, release " +
  `${PROMPTFOO_FRAMEWORKS_SOURCE.release}). The mapping is RegulAIt's, authored against the public catalogues — a ` +
  "starting point, not legal advice. A control counts as TESTED only from a completed run that passed in the " +
  "period; an evaluator that did not run is 'not run', never passed.";
