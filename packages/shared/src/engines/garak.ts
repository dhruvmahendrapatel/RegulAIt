/**
 * ADR-0187 B5-G — WHAT THIS BUILD RUNS OF GARAK, as data.
 *
 * One pure, versioned catalogue shared by the gateway (manifest set classes, the reduced set and the
 * taxonomy map) and the garak runner (planning, config and the report mapper). Every disposition is
 * from G19 (docs/research/R10-engine-admission.md §garak), probe by probe; the detector and OWASP-tag
 * columns are garak's own metadata, generated from the pinned wheel (garak-upstream.ts). Where a fact
 * could not be established the probe fails closed: it is not run and says why.
 *
 * SET IDS. A run-config set is the probe's `module.Class` name in lower case (the shared set grammar is
 * lower case): `encoding.injectbase64` runs garak's `encoding.InjectBase64`. A set that is not in this
 * catalogue never reaches garak: it is reported not run (`engine_error`, a run-time not-run, so the run
 * cannot pass) and the manifest classes it `offensive` for the approvals rule (decision 9).
 *
 * DISPOSITIONS (decisions 143-146):
 *   - `local`            the probe's payload data is admissible (a permissive licence established by G19,
 *                        or written in garak's Apache-2.0 package with no third-party source cited) and its
 *                        primary detector runs in the image with no download;
 *   - `excluded_licence` the payload data, or the detector's model or word list, is copyrighted, holds real
 *                        personal data, has no licence G19 could establish, or carries a licence outside the
 *                        ADR-0176 list (each an OWNER DECISION where a licence exists but is not on the list);
 *   - `missing_preseed`  the probe or its detector needs a Hugging Face model or dataset, or a lexicon,
 *                        downloaded at run time; nothing is pre-seeded in this build and the engines network
 *                        has no route out;
 *   - `cloud_only`       the probe drives a hosted attacker or judge model, or fetches its payload from the
 *                        internet at run time.
 *
 * CLASSES (decision 147). Only the attack classes below count toward A3 and the evaluator catalog, through
 * the taxonomy table. garak reaches the target over the chat compat route only, so — as for promptfoo
 * (decision 40) — nothing here claims an agentic class (indirect injection, tool abuse, excessive agency):
 * latent injection (an instruction hidden in a document the prompt carries) is counted as
 * `prompt_injection`, never `indirect_prompt_injection`. Content-quality and output-handling probes are
 * reported but unmapped (never counted).
 */
import type { RedTeamAttackClass, RedTeamSeverity } from "../redteam.js";
import type { EngineNotRunReason } from "./contract.js";
import { GARAK_UPSTREAM_PROBES, GARAK_UPSTREAM_VERSION } from "./garak-upstream.js";

/** the release the image is built from (engines/garak/requirements.txt pins the same) */
export const GARAK_ENGINE_VERSION = "0.17.0";

/** the vocabulary name in `sourceTaxonomy.system` for every garak item */
export const GARAK_TAXONOMY_SYSTEM = "garak";

/**
 * The usage-data and remote-fetch switches the WORKER sets on every garak process, each at the value the
 * self-test requires (R10 consequence 7). garak itself has no telemetry or update check (R10, source and
 * strace); these close the libraries in its closure:
 *   - HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE / HF_DATASETS_OFFLINE: no Hugging Face Hub request at all (a
 *     missing asset fails to load instead of retrying a download);
 *   - HF_HUB_DISABLE_TELEMETRY: no Hub telemetry;
 *   - LITELLM_LOCAL_MODEL_COST_MAP: the LLM-router library reads its bundled price map instead of fetching one;
 *   - OTEL_SDK_DISABLED / LANGSMITH_TRACING: the tracing SDKs in the closure stay off.
 * Network denial stays the real control either way (the engines network is internal).
 */
export const GARAK_USAGE_DATA_ENV: Readonly<Record<string, string>> = Object.freeze({
  HF_HUB_OFFLINE: "1",
  TRANSFORMERS_OFFLINE: "1",
  HF_DATASETS_OFFLINE: "1",
  HF_HUB_DISABLE_TELEMETRY: "1",
  LITELLM_LOCAL_MODEL_COST_MAP: "True",
  OTEL_SDK_DISABLED: "true",
  LANGSMITH_TRACING: "false",
});

/**
 * Decision 141: the switch the RUNNER derives from the WORKER's own self-test (the worker runs garak and
 * holds no runner token; its report says its switches are set and that it reaches nothing outside). True
 * only when that report is fresh, names the pinned version and passes; else the engine cannot be enabled.
 */
export const GARAK_WORKER_SELF_TEST_SWITCH = "REGULAIT_GARAK_WORKER_SELFTEST";

export type GarakDisposition = "local" | "excluded_licence" | "missing_preseed" | "cloud_only";
export type GarakSetClass = "standard" | "agentic" | "offensive";

export interface GarakProbeEntry {
  /** garak's `module.Class` */
  probe: string;
  disposition: GarakDisposition;
  /** the approvals class of the set (meaningful only for a probe that runs) */
  setClass: GarakSetClass;
  /** the attack class it measures, or null (reported, never counted) */
  attackClass: RedTeamAttackClass | null;
  severity: RedTeamSeverity;
  /** why it does not run here (a fixed sentence), or null */
  note: string | null;
}

type Local = [probe: string, setClass: GarakSetClass, attackClass: RedTeamAttackClass | null, severity: RedTeamSeverity];

/** a module's `module.Class` names in the pinned wheel (every probe of the module) */
function moduleProbes(module: string): string[] {
  return GARAK_UPSTREAM_PROBES.filter((p) => p.probe.startsWith(`${module}.`)).map((p) => p.probe);
}

const LOCAL: readonly Local[] = [
  // --- prompt injection (garak-authored payloads; PromptInject code is MIT) ---
  ...moduleProbes("promptinject").map((p): Local => [p, "standard", "prompt_injection", "high"]),
  ...moduleProbes("latentinjection")
    .filter((p) => !p.startsWith("latentinjection.LatentJailbreak"))
    .map((p): Local => [p, "standard", "prompt_injection", "high"]),
  // --- encodings (garak-authored payloads) ---
  ...moduleProbes("encoding").map((p): Local => [p, "standard", "encoding_evasion", "medium"]),
  // --- smuggling (garak-authored) ---
  ["smuggling.HomoglyphObfuscation", "offensive", "encoding_evasion", "medium"],
  ["smuggling.HypotheticalResponse", "offensive", "jailbreak", "high"],
  ["smuggling.FunctionMasking", "offensive", "jailbreak", "high"],
  // --- jailbreaks whose prompt sets are MIT (R10) ---
  ["dan.DanInTheWild", "offensive", "jailbreak", "high"],
  ["dan.DanInTheWildFull", "offensive", "jailbreak", "high"],
  ["dan.AutoDANCached", "offensive", "jailbreak", "high"],
  ["adaptive_attacks.AdaptiveAttacks", "offensive", "jailbreak", "high"],
  ["dra.DRA", "offensive", "jailbreak", "high"],
  ["dra.DRAAdvanced", "offensive", "jailbreak", "high"],
  ["suffix.GCGCached", "offensive", "jailbreak", "high"],
  // --- training-data divergence (garak-authored; the same class as promptfoo's divergent-repetition) ---
  ["divergence.Repeat", "standard", "data_exfiltration", "medium"],
  ["divergence.RepeatExtended", "standard", "data_exfiltration", "medium"],
  // --- reported, never counted ---
  ["divergence.RepeatedToken", "standard", null, "low"],
  ...moduleProbes("web_injection").map((p): Local => [p, "standard", null, "medium"]),
  ...moduleProbes("ansiescape")
    .filter((p) => p !== "ansiescape.AnsiRawTokenizerHF")
    .map((p): Local => [p, "standard", null, "low"]),
  ["apikey.CompleteKey", "standard", null, "medium"],
  ["apikey.GetKey", "standard", null, "medium"],
  ...moduleProbes("snowball").map((p): Local => [p, "standard", null, "low"]),
  ["lmrc.Anthropomorphisation", "standard", null, "low"],
  ["lmrc.Deadnaming", "standard", null, "low"],
  ["lmrc.QuackMedicine", "standard", null, "low"],
  ...moduleProbes("donotanswer").map((p): Local => [p, "offensive", null, "medium"]),
  ...moduleProbes("exploitation").map((p): Local => [p, "offensive", null, "high"]),
  ...moduleProbes("malwaregen").map((p): Local => [p, "offensive", null, "high"]),
  ...moduleProbes("av_spam_scanning").map((p): Local => [p, "offensive", null, "medium"]),
];

/** not run here, with the reason and the fixed sentence the Engines page shows */
const NOT_RUN: ReadonlyArray<[probes: readonly string[], disposition: Exclude<GarakDisposition, "local">, note: string]> = [
  [moduleProbes("leakreplay"), "excluded_licence", "copyrighted newspaper and book excerpts (ADR-0177)"],
  [moduleProbes("propile"), "excluded_licence", "real personal data with no redistribution licence"],
  [
    moduleProbes("dan").filter((p) => !["dan.DanInTheWild", "dan.DanInTheWildFull", "dan.AutoDANCached", "dan.AutoDAN"].includes(p)),
    "excluded_licence",
    "community jailbreak prompt files with no licence stated (G19: unverified)",
  ],
  [moduleProbes("continuation"), "excluded_licence", "slang-dictionary examples with no licence stated (G19: unverified)"],
  [["misleading.FalseAssertion"], "excluded_licence", "false-claim files with no source or licence (G19: unverified)"],
  [moduleProbes("phrasing"), "excluded_licence", "tense-rephrasing prompts whose source has no licence (G19: unverified)"],
  [["badchars.BadCharacters"], "excluded_licence", "Unicode confusables data under the Unicode licence, outside the ADR-0176 list (OWNER DECISION)"],
  [["tap.TAPCached"], "excluded_licence", "cached TAP prompt file whose own origin is not stated (G19: unverified)"],
  [
    [...moduleProbes("latentinjection").filter((p) => p.startsWith("latentinjection.LatentJailbreak")), "atkgen.Tox", "lmrc.Bullying", ...moduleProbes("realtoxicityprompts")],
    "excluded_licence",
    "the primary detector is a toxicity model under a use-restricted (OpenRAIL) licence (OWNER DECISION)",
  ],
  [
    ["lmrc.Profanity", "lmrc.SexualContent", "lmrc.Sexualisation", "lmrc.SlurUsage", "grandma.Slurs"],
    "excluded_licence",
    "the detector reads word lists with no licence (G19: unverified) or under CC-BY-4.0 (OWNER DECISION)",
  ],
  [
    [...moduleProbes("doctor"), ...moduleProbes("grandma").filter((p) => p !== "grandma.Slurs"), ...moduleProbes("goodside"), ...moduleProbes("glitch")],
    "excluded_licence",
    "payloads reproduced from named third-party posts; provenance not reviewed by G19 (OWNER DECISION)",
  ],
  [["sysprompt_extraction.SystemPromptExtraction"], "excluded_licence", "needs a CC-BY-4.0 Hub dataset (OWNER DECISION) and a second one not pre-seeded"],
  [["packagehallucination.Rust"], "excluded_licence", "its Hub dataset declares no licence"],
  [["audio.AudioAchillesHeel"], "excluded_licence", "its Hub dataset declares no licence (and it needs audio input)"],
  [
    moduleProbes("packagehallucination").filter((p) => p !== "packagehallucination.Rust"),
    "missing_preseed",
    "its package-list Hub dataset is not pre-seeded in this build",
  ],
  [["ansiescape.AnsiRawTokenizerHF"], "missing_preseed", "loads a Hugging Face tokenizer that is not pre-seeded"],
  [moduleProbes("topic"), "missing_preseed", "downloads the WordNet lexicon at run time"],
  [["sata.MLM"], "missing_preseed", "downloads an NLTK tagger at run time"],
  [
    ["agent_breaker.AgentBreaker", "tap.TAP", "tap.PAIR", "goat.GOATAttack", "fitd.FITD", "dan.AutoDAN"],
    "cloud_only",
    "drives a hosted or downloaded attacker or judge model",
  ],
  [["suffix.GCG", "suffix.BEAST"], "cloud_only", "fetches its attack corpus from a git host at run time"],
  [moduleProbes("visual_jailbreak"), "cloud_only", "fetches its images from a git host at run time"],
  [["fileformats.HF_Files"], "cloud_only", "downloads the target's Hub repository"],
];

function buildCatalogue(): GarakProbeEntry[] {
  const out = new Map<string, GarakProbeEntry>();
  const add = (e: GarakProbeEntry) => {
    if (out.has(e.probe)) throw new Error(`garak catalogue: ${e.probe} listed twice`);
    out.set(e.probe, e);
  };
  for (const [probe, setClass, attackClass, severity] of LOCAL) add({ probe, disposition: "local", setClass, attackClass, severity, note: null });
  for (const [probes, disposition, note] of NOT_RUN) {
    for (const probe of probes) add({ probe, disposition, setClass: "offensive", attackClass: null, severity: "medium", note });
  }
  return [...out.values()].sort((a, b) => (a.probe < b.probe ? -1 : a.probe > b.probe ? 1 : 0));
}

/**
 * THE CATALOGUE. A probe in the pinned wheel that is not listed (the `test.*` probes, whose detectors
 * always pass; `grandma.GrandmaIntent`, which names no detector) never runs: asking for it is an unknown
 * set (decision 143).
 */
export const GARAK_PROBES: readonly GarakProbeEntry[] = Object.freeze(buildCatalogue().map((e) => Object.freeze(e)));

const BY_SET = new Map(GARAK_PROBES.map((p) => [p.probe.toLowerCase(), p]));
const UPSTREAM_BY_PROBE = new Map(GARAK_UPSTREAM_PROBES.map((p) => [p.probe, p]));

/** the run-config set id of a probe (lower case) */
export function garakSetId(probe: string): string {
  return probe.toLowerCase();
}

/** the catalogue entry a set id names, or null (not in this build: never run) */
export function garakProbeForSet(set: string): GarakProbeEntry | null {
  return BY_SET.get(set) ?? null;
}

/** the probe's primary detector in the pinned release (the only detector the runner lets garak run) */
export function garakPrimaryDetector(probe: string): string | null {
  return UPSTREAM_BY_PROBE.get(probe)?.detector ?? null;
}

/** garak's own OWASP tags for a probe (2023 numbering) */
export function garakOwaspTags2023(probe: string): readonly string[] {
  return UPSTREAM_BY_PROBE.get(probe)?.owasp ?? [];
}

/** the not-run reason for a disposition, or null when it runs */
export function garakNotRunReason(d: GarakDisposition): EngineNotRunReason | null {
  return d === "local" ? null : d;
}

/** the manifest's set classes: every set that RUNS, by its class (a set not listed is offensive) */
export function garakManifestSets(): Record<string, GarakSetClass> {
  const out: Record<string, GarakSetClass> = {};
  for (const p of GARAK_PROBES) if (p.disposition === "local") out[garakSetId(p.probe)] = p.setClass;
  return out;
}

/** what this build never runs, keyed by the probe name the runner reports (the declared reduced set) */
export function garakReducedSet(): Array<{ key: string; reason: EngineNotRunReason }> {
  const out: Array<{ key: string; reason: EngineNotRunReason }> = [];
  for (const p of GARAK_PROBES) {
    const r = garakNotRunReason(p.disposition);
    if (r) out.push({ key: p.probe, reason: r });
  }
  return out;
}

/** the taxonomy rows (system `garak`, id = the probe's `module.Class`) */
export function garakTaxonomyEntries(): Array<{ system: string; id: string; attackClass: RedTeamAttackClass; scorerKind: null }> {
  return GARAK_PROBES.filter((p) => p.disposition === "local" && p.attackClass !== null).map((p) => ({
    system: GARAK_TAXONOMY_SYSTEM,
    id: p.probe,
    attackClass: p.attackClass!,
    scorerKind: null,
  }));
}

// ---------------------------------------------------------------------------
// OWASP LLM Top 10: garak's 2023 tags -> the 2025 ids our catalog cites (decision 148)
// ---------------------------------------------------------------------------

export interface GarakOwaspCrosswalkRow {
  /** garak's tag, 2023 (v1.1) numbering */
  garak: string;
  /** the 2023 risk it names */
  name2023: string;
  /** the 2025 id (`owasp:llm:NN`, a key of OWASP_LLM_TOP_10_MAPPING), or null */
  owasp2025: string | null;
  /** `mapped`: the risk carries over (R10 consequence 6); `owner_decision`: no clean 2025 target, unmapped until decided */
  status: "mapped" | "owner_decision";
}

/**
 * THE CROSSWALK, versioned by the garak release whose tags it reads. Only the rows R10 supports are
 * mapped. The two 2023 risks with no clean 2025 target (Insecure Plugin Design; Model Theft) map to
 * nothing until the owner decides (OWNER DECISION, ADR-0187 open question B5-G 1). This is reported
 * provenance only: what COUNTS toward A3 is the per-probe attack class above, never an OWASP tag.
 */
export const GARAK_OWASP_CROSSWALK: { garakVersion: string; rows: readonly GarakOwaspCrosswalkRow[] } = Object.freeze({
  garakVersion: GARAK_UPSTREAM_VERSION,
  rows: Object.freeze([
    { garak: "owasp:llm01", name2023: "Prompt Injection", owasp2025: "owasp:llm:01", status: "mapped" },
    { garak: "owasp:llm02", name2023: "Insecure Output Handling", owasp2025: "owasp:llm:05", status: "mapped" },
    { garak: "owasp:llm03", name2023: "Training Data Poisoning", owasp2025: "owasp:llm:04", status: "mapped" },
    { garak: "owasp:llm04", name2023: "Model Denial of Service", owasp2025: "owasp:llm:10", status: "mapped" },
    { garak: "owasp:llm05", name2023: "Supply Chain Vulnerabilities", owasp2025: "owasp:llm:03", status: "mapped" },
    { garak: "owasp:llm06", name2023: "Sensitive Information Disclosure", owasp2025: "owasp:llm:02", status: "mapped" },
    { garak: "owasp:llm07", name2023: "Insecure Plugin Design", owasp2025: null, status: "owner_decision" },
    { garak: "owasp:llm08", name2023: "Excessive Agency", owasp2025: "owasp:llm:06", status: "mapped" },
    { garak: "owasp:llm09", name2023: "Overreliance", owasp2025: "owasp:llm:09", status: "mapped" },
    { garak: "owasp:llm10", name2023: "Model Theft", owasp2025: null, status: "owner_decision" },
  ] satisfies GarakOwaspCrosswalkRow[]),
});

/** the 2025 OWASP ids a probe's garak tags map to (unmapped and owner-decision rows contribute nothing) */
export function garakOwasp2025(probe: string): string[] {
  const ids = new Set<string>();
  for (const tag of garakOwaspTags2023(probe)) {
    const row = GARAK_OWASP_CROSSWALK.rows.find((r) => r.garak === tag);
    if (row && row.status === "mapped" && row.owasp2025) ids.add(row.owasp2025);
  }
  return [...ids].sort();
}

// ---------------------------------------------------------------------------
// Run configuration (decision 149)
// ---------------------------------------------------------------------------

/**
 * The run params garak accepts. Anything else is refused at run creation (422 `engine_config_invalid`),
 * so no param can reach garak's config unseen. None today: the runner derives every garak setting itself
 * (one generation per prompt, the prompt cap from the run's trials).
 */
export const GARAK_RUN_PARAMS: readonly string[] = Object.freeze([]);

/** what is wrong with a run's config for garak, or null */
export function garakConfigProblem(config: { sets: readonly string[]; params?: Readonly<Record<string, unknown>> }): string | null {
  const extra = Object.keys(config.params ?? {}).filter((k) => !GARAK_RUN_PARAMS.includes(k));
  if (extra.length > 0) return `garak takes no run params in this build (got: ${extra.sort().join(", ")})`;
  return null;
}
