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
 *                        that is not pre-seeded in the image, and the engines network has no route out. The
 *                        licence-clear Hub assets R10 names ARE pre-seeded at pinned revisions (owner,
 *                        open question 22; decisions 198-200): `GARAK_PRESEEDED_HF_ASSETS`;
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
import { GARAK_UPSTREAM_PROBES } from "./garak-upstream.js";

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
  /**
   * ADR-0187 decision 203 (owner decision on open question 24): the probe calls a model as a judge (its
   * primary detector is a `judge.*` or `agent_breaker.*` detector) or as its attacker (an `agent_breaker`
   * probe). Such a probe runs only with a judge agent behind the gateway, reached with the run's own key:
   * a run selecting it names a judge the requester is entitled to, or it is refused (default-deny).
   */
  requiresJudge: boolean;
}

/**
 * Decision 203: the garak modules whose detectors (and, for `agent_breaker`, whose probe's attacker and
 * parser) call a model. In garak 0.17.0 those default to a hosted endpoint (R10); this build re-points
 * every one of them at the run's judge agent through the gateway's compat route (engine-garak config.ts).
 */
export const GARAK_JUDGE_MODULES: readonly string[] = Object.freeze(["judge", "agent_breaker"]);

const moduleOf = (name: string): string => name.split(".")[0]!;

/** does this probe call a model as judge or attacker (decision 203)? derived from garak's own metadata */
function probeNeedsJudge(probe: string): boolean {
  const detector = GARAK_UPSTREAM_PROBES.find((p) => p.probe === probe)?.detector ?? null;
  return GARAK_JUDGE_MODULES.includes(moduleOf(probe)) || (detector !== null && GARAK_JUDGE_MODULES.includes(moduleOf(detector)));
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
  // --- admitted by the owner 2026-10-10 (open question 20; decision 195): inline payloads reproduced from
  //     named third-party posts (doctor, grandma, goodside, glitch) and the Unicode-licensed confusables
  //     data (badchars). Each one's primary detector is a string, trigger or regex detector.
  ...moduleProbes("doctor").map((p): Local => [p, "offensive", "jailbreak", "high"]),
  ["grandma.Substances", "offensive", "jailbreak", "high"],
  ["grandma.Win10", "offensive", "jailbreak", "medium"],
  ["grandma.Win11", "offensive", "jailbreak", "medium"],
  ["goodside.Tag", "standard", "prompt_injection", "high"],
  ["goodside.WhoIsRiley", "standard", null, "low"],
  ["goodside.ThreatenJSON", "standard", null, "low"],
  ["goodside.Davidjl", "standard", null, "low"],
  ...moduleProbes("glitch").map((p): Local => [p, "standard", null, "low"]),
  ["badchars.BadCharacters", "offensive", "encoding_evasion", "medium"],
  // --- runnable since the owner's pre-seed decision (open question 22; decision 199): the Apache-2.0
  //     system-prompt dataset and package-list datasets are in the image at pinned revisions ---
  ["sysprompt_extraction.SystemPromptExtraction", "standard", "system_prompt_extraction", "high"],
  ...moduleProbes("packagehallucination")
    .filter((p) => p !== "packagehallucination.Rust")
    .map((p): Local => [p, "standard", null, "medium"]),
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
  // --- decision 204 (owner decision on open question 24): attacks an agent's tool use, with its attacker,
  // parser and judge all re-pointed at the run's judge agent behind the gateway. Agentic for approvals. It
  // reaches the agent over the chat route only, where no tool call is governed or visible, so — as for
  // promptfoo's agentic-named plugins (decision 40) — it is reported, never counted toward an agentic class.
  ["agent_breaker.AgentBreaker", "agentic", null, "high"],
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
  [["tap.TAPCached"], "excluded_licence", "cached TAP prompt file whose own origin is not stated (G19: unverified)"],
  // admitted by the owner 2026-10-10 (open question 20) but still not runnable here (decision 196): the
  // toxicity detector's model is not pre-seeded, and its module reads the two word lists kept deleted
  [
    [...moduleProbes("latentinjection").filter((p) => p.startsWith("latentinjection.LatentJailbreak")), "atkgen.Tox", "lmrc.Bullying", ...moduleProbes("realtoxicityprompts")],
    "missing_preseed",
    "licence admitted; its toxicity-model detector is not pre-seeded and its detector module reads word lists kept deleted",
  ],
  [
    ["lmrc.Profanity", "lmrc.SexualContent", "lmrc.Sexualisation", "lmrc.SlurUsage"],
    "excluded_licence",
    "its detector reads the profanity word list, which has no licence G19 could establish and stays deleted (owner)",
  ],
  [["grandma.Slurs"], "excluded_licence", "its detector reads the slang-dictionary slur list, which has no licence stated (G19: unverified)"],
  [["packagehallucination.Rust"], "excluded_licence", "its Hub dataset declares no licence"],
  [["audio.AudioAchillesHeel"], "excluded_licence", "its Hub dataset declares no licence (and it needs audio input)"],
  [["ansiescape.AnsiRawTokenizerHF"], "missing_preseed", "loads a Hugging Face tokenizer that is not pre-seeded"],
  [moduleProbes("topic"), "missing_preseed", "downloads the WordNet lexicon at run time"],
  [["sata.MLM"], "missing_preseed", "downloads an NLTK tagger at run time"],
  [["tap.TAP", "tap.PAIR", "dan.AutoDAN"], "cloud_only", "drives a hosted or downloaded attacker or judge model"],
  // decision 205: their primary detector is a `judge.*` detector, which this build can re-point at the
  // gateway judge, but their payload data has no licence G19 could find and is deleted from the image
  // (decision 145), so they still never run
  [["fitd.FITD", "goat.GOATAttack"], "excluded_licence", "its payload data has no licence found and is deleted from the image (its judge could run through the gateway)"],
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
  for (const [probe, setClass, attackClass, severity] of LOCAL) add({ probe, disposition: "local", setClass, attackClass, severity, note: null, requiresJudge: probeNeedsJudge(probe) });
  for (const [probes, disposition, note] of NOT_RUN) {
    for (const probe of probes) add({ probe, disposition, setClass: "offensive", attackClass: null, severity: "medium", note, requiresJudge: probeNeedsJudge(probe) });
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

/**
 * garak's own OWASP tags for a probe (2023 numbering): upstream provenance only, never used to map a
 * probe to an OWASP risk. The 2025 mapping is our own table (garak-owasp-2025.ts, decision 213).
 */
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

/**
 * Decision 203: the set ids that run here only with a judge agent behind the gateway. The manifest
 * publishes them (`judgeSets`), and run validation and the lease refuse a run selecting one with no
 * judge (`judge_required`).
 */
export function garakJudgeSets(): string[] {
  return GARAK_PROBES.filter((p) => p.disposition === "local" && p.requiresJudge).map((p) => garakSetId(p.probe));
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
// OWASP LLM Top 10 (2025): our own per-probe table, garak-owasp-2025.ts (decisions 213-218). garak's
// 2023 tags are never read to map anything.
// ---------------------------------------------------------------------------

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
