/**
 * ADR-0245 — WHAT THIS BUILD RUNS OF PyRIT (Microsoft, MIT), as data.
 *
 * PyRIT drives MULTI-TURN attacks (Crescendo, TAP, PAIR, red-teaming): an ATTACKER model writes each next turn from
 * the target's last reply, and a SCORER model judges whether the objective was met. Both are model calls. In this
 * build both are the run's JUDGE agent, reached through the gateway's compat route with the run's own virtual key
 * (ADR-0245 decision 2), exactly as garak's agent_breaker attacker is (ADR-0187 decisions 203-208): entitlement on
 * the judge, the run's one budget, `engine:pyrit` usage rows and the audit trail per dispatch. PyRIT never holds a
 * provider key and never reaches a provider.
 *
 * SET IDS: `attack:<name>` runs one PyRIT attack strategy against each of the image's local objectives. A set that is
 * not in this catalogue never reaches PyRIT (`engine_error`) and is classed `offensive`.
 *
 * DISPOSITIONS:
 *   - `local`       the attack runs with the target and the judge through the gateway, and its prompts and objectives
 *                   come from PyRIT's own MIT seed files inside the wheel;
 *   - `cloud_only`  the attack needs a hosted service (Azure ML for GCG, Azure Content Safety, a remote dataset fetched
 *                   at run time), so it cannot run here;
 *   - `missing_preseed` the attack needs local model weights the image does not carry.
 *
 * CLASSES. Every admitted attack is a jailbreak by conversation. They are classed `offensive` for the approvals rule
 * (owner decision 4 of ADR-0187): each spends attacker and scorer calls on top of the target's, and generates harmful
 * intermediate content by design, so a run waits for an approver. PyRIT reaches the target over the chat compat route
 * only, so nothing here claims an agentic class.
 */
import type { RedTeamAttackClass, RedTeamSeverity } from "../redteam.js";
import type { EngineNotRunReason } from "./contract.js";

/** the release the image is built from (engines/pyrit/requirements.txt pins the same) */
export const PYRIT_ENGINE_VERSION = "1.1.0";

export const PYRIT_TAXONOMY_SYSTEM = "pyrit";

/**
 * The switches the WORKER sets on every PyRIT process. PyRIT has no telemetry of its own; it loads `.env` files and
 * Azure defaults when configured to, so the worker passes an explicit, minimal environment and an in-memory SQLite
 * memory (never Azure SQL). These close the libraries in the closure; network denial stays the real control.
 */
export const PYRIT_USAGE_DATA_ENV: Readonly<Record<string, string>> = Object.freeze({
  HF_HUB_OFFLINE: "1",
  TRANSFORMERS_OFFLINE: "1",
  HF_DATASETS_OFFLINE: "1",
  HF_HUB_DISABLE_TELEMETRY: "1",
  OTEL_SDK_DISABLED: "true",
  AZURE_CORE_COLLECT_TELEMETRY: "false",
  DO_NOT_TRACK: "1",
});

export const PYRIT_WORKER_SELF_TEST_SWITCH = "REGULAIT_PYRIT_WORKER_SELFTEST";

export type PyritDisposition = "local" | "cloud_only" | "missing_preseed" | "excluded_licence";
export type PyritSetClass = "standard" | "agentic" | "offensive";

export interface PyritAttackEntry {
  set: string;
  /** the PyRIT class this set runs (pyrit.executor.attack) */
  attack: string;
  disposition: PyritDisposition;
  setClass: PyritSetClass;
  /** true when the attack has an attacker model (multi-turn); every attack is scored by the judge */
  multiTurn: boolean;
  attackClass: RedTeamAttackClass | null;
  severity: RedTeamSeverity;
  note: string;
}

const at = (
  name: string,
  attack: string,
  disposition: PyritDisposition,
  multiTurn: boolean,
  attackClass: RedTeamAttackClass | null,
  severity: RedTeamSeverity,
  note: string,
): PyritAttackEntry => ({
  set: `attack:${name}`,
  attack,
  disposition,
  setClass: "offensive",
  multiTurn,
  attackClass: disposition === "local" ? attackClass : null,
  severity,
  note,
});

/** THE CATALOGUE (PyRIT 1.1.0, read from the pinned wheel; ADR-0245 decision 7) */
export const PYRIT_ATTACKS: readonly PyritAttackEntry[] = Object.freeze(
  [
    at("crescendo", "CrescendoAttack", "local", true, "jailbreak", "high", "escalates over turns from benign questions; attacker and scorer are the run's judge through the gateway"),
    at("tap", "TreeOfAttacksWithPruningAttack", "local", true, "jailbreak", "high", "Tree of Attacks with Pruning; attacker, evaluator and scorer are the run's judge through the gateway"),
    at("pair", "PAIRAttack", "local", true, "jailbreak", "high", "Prompt Automatic Iterative Refinement; attacker and scorer are the run's judge through the gateway"),
    at("red_teaming", "RedTeamingAttack", "local", true, "jailbreak", "high", "PyRIT's generic multi-turn red-teaming bot; attacker and scorer are the run's judge"),
    at("prompt_sending", "PromptSendingAttack", "local", false, "jailbreak", "medium", "single-turn objectives from PyRIT's own seed files, scored by the run's judge"),
    at("skeleton_key", "SkeletonKeyAttack", "local", false, "jailbreak", "high", "the published skeleton-key priming turn, scored by the run's judge"),
    at("many_shot_jailbreak", "ManyShotJailbreakAttack", "cloud_only", false, null, "high", "fetches its many-shot examples from a remote repository at run time"),
    at("gcg", "GCG", "cloud_only", false, null, "high", "optimises suffixes on Azure ML with local model weights"),
  ].map((e) => Object.freeze(e)),
);

export function pyritEntryForSet(set: string): PyritAttackEntry | null {
  return PYRIT_ATTACKS.find((e) => e.set === set) ?? null;
}

export function pyritNotRunReason(d: PyritDisposition): EngineNotRunReason | null {
  return d === "local" ? null : d;
}

export function pyritManifestSets(): Record<string, PyritSetClass> {
  const out: Record<string, PyritSetClass> = {};
  for (const e of PYRIT_ATTACKS) if (e.disposition === "local") out[e.set] = e.setClass;
  return out;
}

export function pyritReducedSet(): Array<{ key: string; reason: EngineNotRunReason }> {
  const out: Array<{ key: string; reason: EngineNotRunReason }> = [];
  for (const e of PYRIT_ATTACKS) {
    const r = pyritNotRunReason(e.disposition);
    if (r) out.push({ key: e.set, reason: r });
  }
  return out;
}

export function pyritTaxonomyEntries(): Array<{ system: string; id: string; attackClass: RedTeamAttackClass; scorerKind: null }> {
  return PYRIT_ATTACKS.filter((e) => e.disposition === "local" && e.attackClass !== null).map((e) => ({
    system: PYRIT_TAXONOMY_SYSTEM,
    id: e.set,
    attackClass: e.attackClass!,
    scorerKind: null,
  }));
}

/**
 * The run params PyRIT accepts. `max_turns` bounds a multi-turn attack's conversation (1-10; default 5): the run's
 * budget is the hard stop either way, this keeps one objective from spending all of it.
 */
export const PYRIT_RUN_PARAMS: readonly string[] = Object.freeze(["max_turns"]);
export const PYRIT_DEFAULT_MAX_TURNS = 5;
export const PYRIT_MAX_TURNS_CEILING = 10;

export function pyritConfigProblem(config: { sets: readonly string[]; params?: Readonly<Record<string, unknown>> }): string | null {
  const params = config.params ?? {};
  const extra = Object.keys(params).filter((k) => !PYRIT_RUN_PARAMS.includes(k));
  if (extra.length > 0) return `pyrit takes only ${PYRIT_RUN_PARAMS.join(", ")} (got: ${extra.sort().join(", ")})`;
  if ("max_turns" in params) {
    const v = params.max_turns;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > PYRIT_MAX_TURNS_CEILING) return `max_turns must be an integer from 1 to ${PYRIT_MAX_TURNS_CEILING}`;
  }
  return null;
}
