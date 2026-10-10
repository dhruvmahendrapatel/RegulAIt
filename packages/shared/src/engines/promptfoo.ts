/**
 * ADR-0187 B5-P — WHAT THIS BUILD RUNS OF PROMPTFOO, as data.
 *
 * One pure, versioned catalogue shared by the gateway (manifest set classes and the taxonomy
 * map) and the promptfoo runner (config generator and result mapper). Every fact below was read
 * from the pinned release's own published package (npm `promptfoo@0.124.1`, its `dist/src`
 * bundle), offline, and is recorded with how it was read in
 * docs/research/R10-engine-admission.md §promptfoo. Where a fact could not be established, the
 * entry fails closed: the plugin is not run and says why.
 *
 * DISPOSITIONS (why a plugin does or does not run here):
 *   - `local`            generates its test cases with the run's own judge model behind the
 *                        gateway when remote generation is switched off (upstream's
 *                        `createPluginFactory` path, and the PII path when
 *                        `shouldGenerateRemote()` is false);
 *   - `cloud_only`       upstream refuses to generate it with remote generation off
 *                        (`REMOTE_ONLY_PLUGIN_IDS`, the unaligned `harmful:*` set and `bias:*`,
 *                        each of which logs "remote generation disabled" and returns no tests);
 *   - `missing_preseed`  a dataset plugin that downloads its dataset at run time from a public
 *                        dataset hub or a third-party git host; no copy is pre-seeded in the
 *                        image and the engines network has no route out, so it cannot run;
 *   - `excluded_licence` content fetched at run time from an unpinned third-party repository
 *                        whose licence we treat as copyleft (ADR-0187: the `pliny` plugin).
 *
 * A plugin or strategy that is not listed here is NOT RUN (fail closed): the runner reports it
 * `not_run` and the manifest classes it `offensive` for the approvals rule.
 *
 * CLASSES. Only the attack classes below count toward A3 and the evaluator catalog, through the
 * taxonomy table (`promptfooTaxonomyEntries`). Deliberately unmapped in this build (reported, never
 * counted): the content-quality plugins (hallucination, overreliance, …), and every plugin whose
 * name is an agentic class (excessive-agency, shell-injection, sql-injection, rbac, debug-access,
 * tool-discovery). Those classes are measured at a tool or connector gateway (ADR-0068 §4); a
 * promptfoo run reaches the target over the chat compat route only, so it cannot show that a tool
 * call was or was not made, and claiming the class from it would overstate coverage.
 */
import type { RedTeamAttackClass, RedTeamSeverity } from "../redteam.js";
import type { EngineNotRunReason } from "./contract.js";
import {
  PROMPTFOO_UPSTREAM_BIAS_PLUGINS,
  PROMPTFOO_UPSTREAM_DATASET_PLUGINS,
  PROMPTFOO_UPSTREAM_REMOTE_ONLY_PLUGINS,
  PROMPTFOO_UPSTREAM_UNALIGNED_HARM_PLUGINS,
} from "./promptfoo-upstream.js";

/** the release the image is built from; equals the vendored OWASP tables' release (ADR-0187) */
export const PROMPTFOO_ENGINE_VERSION = "0.124.1";

/** the vocabulary name in `sourceTaxonomy.system` for every promptfoo item */
export const PROMPTFOO_TAXONOMY_SYSTEM = "promptfoo";

/** a run-config set naming a strategy, rather than a plugin, starts with this */
export const PROMPTFOO_STRATEGY_SET_PREFIX = "strategy:";

/**
 * The usage-data and remote-fetch switches the runner sets, each at the value the self-test
 * requires (env name -> value). Read from the 0.123.1 source (R10), re-checked in the 0.124.1 bundle (ADR-0187 decision 176):
 *   - DISABLE_TELEMETRY: no PostHog client; still sends one "telemetry disabled" event unless
 *     the image's patch is applied (patches/telemetry-disabled-sends-nothing.mjs);
 *   - DISABLE_UPDATE: no version check;
 *   - DISABLE_SHARING: forces `sharing` false whatever the config says;
 *   - DISABLE_REMOTE_GENERATION and DISABLE_REDTEAM_REMOTE_GENERATION: `neverGenerateRemote()`
 *     is true, so no plugin, strategy, health check or grader goes to the vendor's API;
 *   - DISABLE_TEMPLATE_ENV_VARS: prompt templates cannot read the process environment (the run's
 *     key is in it);
 *   - DISABLE_REDTEAM_MODERATION: no moderation assertion against a vendor moderation API;
 *   - CACHE_ENABLED=false: nothing is read from or written to a response cache.
 */
export const PROMPTFOO_USAGE_DATA_ENV: Readonly<Record<string, string>> = Object.freeze({
  PROMPTFOO_DISABLE_TELEMETRY: "1",
  PROMPTFOO_DISABLE_UPDATE: "1",
  PROMPTFOO_DISABLE_SHARING: "1",
  PROMPTFOO_DISABLE_REMOTE_GENERATION: "1",
  PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION: "1",
  PROMPTFOO_DISABLE_TEMPLATE_ENV_VARS: "1",
  PROMPTFOO_DISABLE_REDTEAM_MODERATION: "1",
  PROMPTFOO_CACHE_ENABLED: "false",
});

export type PromptfooDisposition = "local" | "cloud_only" | "missing_preseed" | "excluded_licence";
export type PromptfooSetClass = "standard" | "agentic" | "offensive";

export interface PromptfooPluginEntry {
  id: string;
  disposition: PromptfooDisposition;
  /** the approvals class of the set (only meaningful for a plugin that runs) */
  setClass: PromptfooSetClass;
  /** the attack class it measures, or null (reported, never counted) */
  attackClass: RedTeamAttackClass | null;
  severity: RedTeamSeverity;
}

export interface PromptfooStrategyEntry {
  /** upstream's strategy id (the run-config set is `strategy:<id>`) */
  id: string;
  disposition: "local" | "cloud_only";
  setClass: PromptfooSetClass;
  attackClass: RedTeamAttackClass | null;
}

const local = (
  id: string,
  setClass: PromptfooSetClass,
  attackClass: RedTeamAttackClass | null,
  severity: RedTeamSeverity,
): PromptfooPluginEntry => ({ id, disposition: "local", setClass, attackClass, severity });
const notRunnable = (id: string, disposition: Exclude<PromptfooDisposition, "local">): PromptfooPluginEntry => ({
  id,
  disposition,
  setClass: "offensive",
  attackClass: null,
  severity: "medium",
});

/**
 * PR #205 review [59]: the cloud-only list is GENERATED from the pinned package's own lists
 * (promptfoo-upstream.ts, by engines/promptfoo/extract-plugin-lists.mjs), never typed by hand:
 * upstream `REMOTE_ONLY_PLUGIN_IDS` (including the coding-agent collections and plugins and the
 * medical, financial, pharmacy, insurance, ecommerce, telecom and realestate lists), the
 * unaligned-provider `harmful:*` set (generated only by the vendor's remote endpoint), and
 * `bias:*` (returns nothing with remote generation off).
 */
const CLOUD_ONLY_PLUGINS: readonly string[] = [
  ...new Set([...PROMPTFOO_UPSTREAM_REMOTE_ONLY_PLUGINS, ...PROMPTFOO_UPSTREAM_UNALIGNED_HARM_PLUGINS, ...PROMPTFOO_UPSTREAM_BIAS_PLUGINS]),
].sort();

/**
 * PR #205 review round 9 [80]: plugins that download a dataset at run time but that upstream's
 * `DATASET_PLUGINS` list (0.123.1) omits. `vlsu` fetches its dataset from a public hub at run time
 * (R10, read from the pinned tarball), so it is `missing_preseed` like the listed ones, decided at
 * planning time, never an engine error. A LOCAL supplement to the generated list: the test
 * `the dataset supplement is still needed` fails once upstream lists it, so it can be dropped.
 */
export const PROMPTFOO_DATASET_PLUGINS_SUPPLEMENT: readonly string[] = Object.freeze(["vlsu"]);

/** upstream `DATASET_PLUGINS` plus the supplement: datasets downloaded at run time (no pre-seeded copy here); `pliny` is excluded on licence */
const DATASET_PLUGINS: readonly string[] = [...new Set([...PROMPTFOO_UPSTREAM_DATASET_PLUGINS, ...PROMPTFOO_DATASET_PLUGINS_SUPPLEMENT])].filter((id) => id !== "pliny").sort();

export const PROMPTFOO_PLUGINS: readonly PromptfooPluginEntry[] = Object.freeze([
  // --- runs locally, mapped to a class that counts ---
  local("prompt-extraction", "standard", "system_prompt_extraction", "high"),
  local("pii:direct", "standard", "pii_leak", "high"),
  local("pii:session", "standard", "pii_leak", "high"),
  local("pii:social", "standard", "pii_leak", "high"),
  local("pii:api-db", "standard", "pii_leak", "high"),
  local("harmful:privacy", "offensive", "pii_leak", "high"),
  local("cross-session-leak", "standard", "data_exfiltration", "high"),
  local("divergent-repetition", "standard", "data_exfiltration", "medium"),
  // --- runs locally, reported but unmapped (see the header) ---
  local("excessive-agency", "agentic", null, "medium"),
  local("shell-injection", "agentic", null, "high"),
  local("sql-injection", "agentic", null, "high"),
  local("rbac", "agentic", null, "high"),
  local("debug-access", "agentic", null, "high"),
  local("tool-discovery", "agentic", null, "low"),
  local("hallucination", "standard", null, "medium"),
  local("overreliance", "standard", null, "low"),
  local("contracts", "standard", null, "medium"),
  local("politics", "standard", null, "low"),
  local("imitation", "standard", null, "low"),
  local("unverifiable-claims", "standard", null, "low"),
  local("harmful:intellectual-property", "offensive", null, "medium"),
  local("teen-safety:age-restricted-goods-and-services", "offensive", null, "high"),
  local("teen-safety:dangerous-content", "offensive", null, "high"),
  local("teen-safety:dangerous-roleplay", "offensive", null, "high"),
  local("teen-safety:harmful-body-ideals", "offensive", null, "high"),
  // --- does not run here ---
  ...CLOUD_ONLY_PLUGINS.map((id) => notRunnable(id, "cloud_only")),
  ...DATASET_PLUGINS.map((id) => notRunnable(id, "missing_preseed")),
  notRunnable("pliny", "excluded_licence"),
]);

export const PROMPTFOO_STRATEGIES: readonly PromptfooStrategyEntry[] = Object.freeze([
  // the plugin's own test case: its class is the plugin's
  { id: "basic", disposition: "local", setClass: "standard", attackClass: null },
  // static encodings applied to each test case
  ...["base64", "hex", "rot13", "leetspeak", "homoglyph", "morse", "piglatin", "camelcase", "emoji"].map(
    (id): PromptfooStrategyEntry => ({ id, disposition: "local", setClass: "standard", attackClass: "encoding_evasion" }),
  ),
  // static jailbreak templates, and the attacker-model loops (the judge model drives them)
  { id: "jailbreak-templates", disposition: "local", setClass: "offensive", attackClass: "jailbreak" },
  { id: "jailbreak:tree", disposition: "local", setClass: "offensive", attackClass: "jailbreak" },
  { id: "crescendo", disposition: "local", setClass: "offensive", attackClass: "jailbreak" },
  // upstream throws with remote generation off (read at 0.123.1); never passed to the engine,
  // since a throwing strategy can abort the whole generation step
  // (`jailbreak` is upstream's deprecated alias of `jailbreak:meta`, the remote meta-agent)
  ...["jailbreak", "jailbreak:meta", "jailbreak:composite", "jailbreak:likert", "citation", "gcg", "goat", "best-of-n", "audio", "authoritative-markup-injection"].map(
    (id): PromptfooStrategyEntry => ({ id, disposition: "cloud_only", setClass: "offensive", attackClass: null }),
  ),
]);

const PLUGIN_BY_ID = new Map(PROMPTFOO_PLUGINS.map((p) => [p.id, p]));
const STRATEGY_BY_ID = new Map(PROMPTFOO_STRATEGIES.map((s) => [s.id, s]));

export function promptfooPlugin(id: string): PromptfooPluginEntry | null {
  return PLUGIN_BY_ID.get(id) ?? null;
}
export function promptfooStrategy(id: string): PromptfooStrategyEntry | null {
  return STRATEGY_BY_ID.get(id) ?? null;
}

/**
 * PR #205 review round 4 [66]: what is wrong with a run's set list for promptfoo, or null. A
 * strategy only rewrites a plugin's test cases, so a list of strategies alone runs nothing.
 */
export function promptfooConfigProblem(sets: readonly string[]): string | null {
  if (sets.length > 0 && sets.every((s) => s.startsWith(PROMPTFOO_STRATEGY_SET_PREFIX))) {
    return "a promptfoo strategy rewrites a plugin's test cases: name at least one plugin set (strategies alone run nothing)";
  }
  return null;
}

/** the not-run reason for a catalogue disposition, or null when it runs */
export function promptfooNotRunReason(d: PromptfooDisposition): EngineNotRunReason | null {
  return d === "local" ? null : d;
}

/**
 * The manifest's set classes: every set that RUNS, by its class. A set that does not run here is
 * deliberately not listed (so asking for it is classed offensive and needs approval, like any
 * unknown set) — it then reports `not_run` with its reason.
 */
export function promptfooManifestSets(): Record<string, PromptfooSetClass> {
  const out: Record<string, PromptfooSetClass> = {};
  for (const p of PROMPTFOO_PLUGINS) if (p.disposition === "local") out[p.id] = p.setClass;
  for (const s of PROMPTFOO_STRATEGIES) if (s.disposition === "local") out[`${PROMPTFOO_STRATEGY_SET_PREFIX}${s.id}`] = s.setClass;
  return out;
}

/** what this build cannot run, with the reason (published as the air-gapped reduced set) */
export function promptfooReducedSet(): Array<{ key: string; reason: EngineNotRunReason }> {
  const out: Array<{ key: string; reason: EngineNotRunReason }> = [];
  for (const p of PROMPTFOO_PLUGINS) {
    const r = promptfooNotRunReason(p.disposition);
    if (r) out.push({ key: p.id, reason: r });
  }
  for (const s of PROMPTFOO_STRATEGIES) if (s.disposition !== "local") out.push({ key: `${PROMPTFOO_STRATEGY_SET_PREFIX}${s.id}`, reason: "cloud_only" });
  return out;
}

/**
 * The taxonomy rows (system `promptfoo`): a plugin row is keyed by the plugin id and applies to
 * its `basic` test cases; a strategy row is keyed `strategy:<id>` and applies to every test case
 * that strategy rewrote (what the item then measures is the evasion technique).
 */
export function promptfooTaxonomyEntries(): Array<{ system: string; id: string; attackClass: RedTeamAttackClass; scorerKind: null }> {
  const out: Array<{ system: string; id: string; attackClass: RedTeamAttackClass; scorerKind: null }> = [];
  for (const p of PROMPTFOO_PLUGINS) {
    if (p.disposition === "local" && p.attackClass) out.push({ system: PROMPTFOO_TAXONOMY_SYSTEM, id: p.id, attackClass: p.attackClass, scorerKind: null });
  }
  for (const s of PROMPTFOO_STRATEGIES) {
    if (s.disposition === "local" && s.attackClass) {
      out.push({ system: PROMPTFOO_TAXONOMY_SYSTEM, id: `${PROMPTFOO_STRATEGY_SET_PREFIX}${s.id}`, attackClass: s.attackClass, scorerKind: null });
    }
  }
  return out;
}
