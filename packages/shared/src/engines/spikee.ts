/**
 * ADR-0245 — WHAT THIS BUILD RUNS OF SPIKEE (WithSecure, Apache-2.0), as data.
 *
 * Spikee tests INDIRECT prompt injection: it builds a dataset of payloads hidden inside documents (an email, a web
 * page, a tool's output) from a seed folder, sends each document to the target and judges the reply with a local
 * judge (a canary string or a regex the payload asks the model to emit). One pure, versioned catalogue shared by the
 * gateway (manifest set classes, the reduced set, the taxonomy map) and the spikee runner (planning, the mapper).
 *
 * SET IDS (the shared set grammar is lower case):
 *   - `dataset:<seed>`  build and run spikee's own seed folder `datasets/seeds-<seed>` (the payload in a document);
 *   - `plugin:<name>`   additionally run spikee's transformation plugin `<name>` over the dataset (an obfuscation of
 *                       the payload: base64, hex, leetspeak...); a plugin alone runs nothing.
 * A set that is not in this catalogue never reaches spikee: it is reported not run (`engine_error`) and the manifest
 * classes it `offensive` for the approvals rule (ADR-0187 decision 9).
 *
 * DISPOSITIONS (ADR-0245 decisions 4-6), as garak's:
 *   - `local`            the seed data is written by WithSecure inside spikee's Apache-2.0 wheel and cites no
 *                        third-party source, and its judges are spikee's local `canary`/`regex` judges;
 *   - `cloud_only`       the seed folder holds no data, only a script that downloads a third-party dataset from the
 *                        Hugging Face Hub at run time (the engines network has no route out), or the plugin calls a
 *                        hosted service (translation, speech, image) or a hosted LLM;
 *   - `excluded_licence` the data cites a third-party source whose licence is not on the ADR-0176 list;
 *   - `missing_preseed`  the plugin needs a model that is not pre-seeded in the image.
 *
 * CLASSES. Spikee reaches the target over the chat compat route only, so — as garak's latent injection (ADR-0187
 * decision 147) — nothing here claims an agentic class: a payload hidden in a document the prompt carries counts as
 * `prompt_injection`, never `indirect_prompt_injection` (that class is measured only at a tool/connector gateway,
 * ADR-0068 §4). System-prompt extraction counts as `data_exfiltration`.
 */
import type { RedTeamAttackClass, RedTeamSeverity } from "../redteam.js";
import type { EngineNotRunReason } from "./contract.js";

/** the release the image is built from (engines/spikee/requirements.txt pins the same) */
export const SPIKEE_ENGINE_VERSION = "0.9.4";

/** the vocabulary name in `sourceTaxonomy.system` for every spikee item */
export const SPIKEE_TAXONOMY_SYSTEM = "spikee";

/**
 * The usage-data and remote-fetch switches the WORKER sets on every spikee process, each at the value the self-test
 * requires. Spikee itself has no telemetry or update check (source review of 0.9.4); these close the libraries in its
 * closure (the Hugging Face `datasets` library it imports, and the tracing SDKs a provider library may load). Network
 * denial stays the real control (the task sandbox has no network but the gateway channel).
 */
export const SPIKEE_USAGE_DATA_ENV: Readonly<Record<string, string>> = Object.freeze({
  HF_HUB_OFFLINE: "1",
  HF_DATASETS_OFFLINE: "1",
  HF_HUB_DISABLE_TELEMETRY: "1",
  OTEL_SDK_DISABLED: "true",
  DO_NOT_TRACK: "1",
});

/** as garak's (ADR-0187 decision 141): the switch the runner derives from the worker's own fresh self-test */
export const SPIKEE_WORKER_SELF_TEST_SWITCH = "REGULAIT_SPIKEE_WORKER_SELFTEST";

export type SpikeeDisposition = "local" | "excluded_licence" | "missing_preseed" | "cloud_only";
export type SpikeeSetClass = "standard" | "agentic" | "offensive";

export interface SpikeeSetEntry {
  /** the run-config set id */
  set: string;
  kind: "dataset" | "plugin";
  /** the spikee name: the seed folder (without `seeds-`) or the plugin module */
  name: string;
  disposition: SpikeeDisposition;
  setClass: SpikeeSetClass;
  /** the class it counts toward (datasets only; a plugin inherits its dataset's), or null = reported, never counted */
  attackClass: RedTeamAttackClass | null;
  severity: RedTeamSeverity;
  /** why, in one line (shown on the Engines page with the reduced set) */
  note: string;
}

const ds = (name: string, disposition: SpikeeDisposition, attackClass: RedTeamAttackClass | null, severity: RedTeamSeverity, note: string): SpikeeSetEntry => ({
  set: `dataset:${name}`,
  kind: "dataset",
  name,
  disposition,
  setClass: "standard",
  attackClass: disposition === "local" ? attackClass : null,
  severity,
  note,
});
const pl = (name: string, disposition: SpikeeDisposition, note: string): SpikeeSetEntry => ({
  set: `plugin:${name}`,
  kind: "plugin",
  name,
  disposition,
  setClass: "standard",
  attackClass: null,
  severity: "medium",
  note,
});

/** THE CATALOGUE (spikee 0.9.4). Every row was read from the pinned wheel; see ADR-0245 decision 5. */
export const SPIKEE_SETS: readonly SpikeeSetEntry[] = Object.freeze(
  [
    ds("cybersec-2026-01", "local", "prompt_injection", "high", "WithSecure's cybersecurity payloads (exfiltration by markdown image, XSS, ...) in documents; canary judges"),
    ds("llm-mailbox", "local", "prompt_injection", "high", "payloads hidden in e-mails for a mailbox assistant; canary judges"),
    ds("sysmsg-extraction-2025-04", "local", "data_exfiltration", "high", "system-prompt extraction payloads in documents; canary and regex judges"),
    ds("mini-test", "local", "prompt_injection", "low", "spikee's small smoke-test seed set; canary judges"),
    ds("in-the-wild-jailbreak-prompts", "cloud_only", null, "medium", "no data in the wheel: a script downloads TrustAIRLab/in-the-wild-jailbreak-prompts from the Hub"),
    ds("simsonsun-high-quality-jailbreaks", "cloud_only", null, "medium", "no data in the wheel: a script downloads Simsonsun/JailbreakPrompts from the Hub"),
    ds("toxic-chat", "cloud_only", null, "medium", "no data in the wheel: a script downloads lmsys/toxic-chat (CC-BY-NC-4.0) from the Hub"),
    ds("wildguardmix-harmful", "cloud_only", null, "medium", "no data in the wheel: a gated Hub dataset fetched with a Hugging Face token"),
    ds("wildguardmix-harmful-fp", "cloud_only", null, "medium", "no data in the wheel: a gated Hub dataset fetched with a Hugging Face token"),
    ds("harmful-instructions-only", "cloud_only", null, "medium", "judged by spikee's LLM judge, which calls a hosted model (re-pointing it at the gateway judge is ADR-0245 open question 2)"),
    ds("investment-advice", "cloud_only", null, "medium", "judged by spikee's LLM judge, which calls a hosted model (ADR-0245 open question 2)"),
    ds("investment-advice-fp", "cloud_only", null, "medium", "judged by spikee's LLM judge, which calls a hosted model (ADR-0245 open question 2)"),
    pl("base64", "local", "encodes the payload in base64"),
    pl("hex", "local", "encodes the payload in hex"),
    pl("1337", "local", "leetspeak"),
    pl("atbash", "local", "Atbash cipher"),
    pl("caesar", "local", "Caesar cipher"),
    pl("binary", "local", "binary encoding"),
    pl("octal", "local", "octal encoding"),
    pl("decimal", "local", "decimal encoding"),
    pl("morse", "local", "Morse code"),
    pl("flip", "local", "reversed text"),
    pl("homoglyph", "local", "homoglyph substitution"),
    pl("ascii_smuggler", "local", "Unicode tag-character smuggling"),
    pl("mask", "local", "masked keywords"),
    pl("splat", "local", "character splatting"),
    pl("best_of_n", "local", "random augmentation (Best-of-N)"),
    pl("anti_spotlighting", "local", "breaks spotlighting delimiters"),
    pl("google_translate", "cloud_only", "calls Google Translate"),
    pl("opus_translate", "missing_preseed", "needs a Hugging Face translation model that is not pre-seeded"),
    pl("text2image", "cloud_only", "renders through a hosted service"),
    pl("tts", "cloud_only", "calls a hosted speech service"),
    pl("shortener", "cloud_only", "calls a URL shortener"),
    pl("llm_jailbreaker", "cloud_only", "rewrites the payload with a hosted LLM (multi-turn LLM attacks are PyRIT's, ADR-0245 decision 3)"),
    pl("llm_multi_language_jailbreaker", "cloud_only", "rewrites the payload with a hosted LLM"),
    pl("llm_poetry_jailbreaker", "cloud_only", "rewrites the payload with a hosted LLM"),
    pl("prompt_decomposition", "cloud_only", "rewrites the payload with a hosted LLM"),
    pl("rag_poisoner", "cloud_only", "rewrites the payload with a hosted LLM"),
    pl("digraphic_translate", "cloud_only", "translates through a hosted LLM"),
  ].map((e) => Object.freeze(e)),
);

/** the catalogue row of a set id, or null when this build does not know it */
export function spikeeEntryForSet(set: string): SpikeeSetEntry | null {
  return SPIKEE_SETS.find((e) => e.set === set) ?? null;
}

export function spikeeNotRunReason(d: SpikeeDisposition): EngineNotRunReason | null {
  return d === "local" ? null : d;
}

/** the manifest's set classes: every set that RUNS, by its class (a set not listed is offensive) */
export function spikeeManifestSets(): Record<string, SpikeeSetClass> {
  const out: Record<string, SpikeeSetClass> = {};
  for (const e of SPIKEE_SETS) if (e.disposition === "local") out[e.set] = e.setClass;
  return out;
}

/** no admitted spikee set calls a model other than the target (its local judges need none) */
export function spikeeJudgeSets(): string[] {
  return [];
}

/** what this build never runs (the declared reduced set) */
export function spikeeReducedSet(): Array<{ key: string; reason: EngineNotRunReason }> {
  const out: Array<{ key: string; reason: EngineNotRunReason }> = [];
  for (const e of SPIKEE_SETS) {
    const r = spikeeNotRunReason(e.disposition);
    if (r) out.push({ key: e.set, reason: r });
  }
  return out;
}

/** the taxonomy rows (system `spikee`, id = the dataset's set id) */
export function spikeeTaxonomyEntries(): Array<{ system: string; id: string; attackClass: RedTeamAttackClass; scorerKind: null }> {
  return SPIKEE_SETS.filter((e) => e.disposition === "local" && e.attackClass !== null).map((e) => ({
    system: SPIKEE_TAXONOMY_SYSTEM,
    id: e.set,
    attackClass: e.attackClass!,
    scorerKind: null,
  }));
}

/** the run params spikee accepts; anything else is refused at creation (422 `engine_config_invalid`) */
export const SPIKEE_RUN_PARAMS: readonly string[] = Object.freeze([]);

/** what is wrong with a run's config for spikee, or null */
export function spikeeConfigProblem(config: { sets: readonly string[]; params?: Readonly<Record<string, unknown>> }): string | null {
  const extra = Object.keys(config.params ?? {}).filter((k) => !SPIKEE_RUN_PARAMS.includes(k));
  if (extra.length > 0) return `spikee takes no run params in this build (got: ${extra.sort().join(", ")})`;
  const known = config.sets.map(spikeeEntryForSet);
  // a plugin transforms a dataset's payloads: a plan of plugins alone would run nothing (as promptfoo's strategies)
  if (!known.some((e) => e?.kind === "dataset")) return "a spikee run needs at least one dataset:<seed> set (a plugin only transforms a dataset)";
  return null;
}
