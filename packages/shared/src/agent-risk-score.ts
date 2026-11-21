/**
 * ADR-0339 — THE AGENT RISK SCORE: one deterministic, explainable figure per agent, recomputed on every change.
 *
 * The ADR-0214 posture estimate answers "how well is this asset governed" (higher is better). This answers the
 * question an attacker would ask: "how much can go wrong through THIS agent, and how far would it reach" (higher is
 * riskier). It is the same discipline:
 *
 *  1. RULES, NOT ML. `scoreAgentRisk` is a pure function of the facts the gateway gathers from its own ledgers. Same
 *     facts, same score, same order of fixes; `AGENT_RISK_METHOD_VERSION` changes whenever a weight or rule does.
 *  2. EVERY FACTOR IS SHOWN, present or not, with its points, its cap, the evidence in plain words and the OWASP ids it
 *     maps to. Absent factors score 0 and say so; nothing is hidden in a weight.
 *  3. OWASP IDS ONLY. Factors cite the edition-qualified ids the evaluator catalog already uses
 *     (`owasp:llm:2026:NN`, `owasp:agentic:asiNN`, ADR-0243/ADR-0297). No OWASP risk name or text is stored here: the
 *     lists are share-alike, so a reader resolves names through `owaspReferences()` (ADR-0243 decision 2).
 *  4. EXPOSURE x REACH + TOXIC COMBINATIONS. score = min(100, round(exposure x reach multiplier) + toxic points).
 *     Exposure is the sum of the factor points (capped at 100). The reach multiplier is a published band over how
 *     many people and dependents the agent reaches (ADR-0059's blast radius applied to one agent). Toxic combinations
 *     are added after the multiplier, so a combination is never hidden by a small reach, and each is weighted by the same
 *     reach band (ADR-0059's blast radius): an ADR-0091 SoD rule whose every side the agent itself holds, and the
 *     capability combinations of the ADR-0339 addendum (v3). Those are computed from the agent's own capabilities,
 *     one row per tool, connector, inbound channel or computer use, so every leg names the members that make it up:
 *       - LETHAL TRIFECTA: private data (a read) + untrusted content (an inbound channel, computer use, or a read from a
 *         source not classified trusted or standard, ADR-0193) + external communication (a write without Ask-first,
 *         or a read that can reach the open world, so a fetch can carry data out).
 *       - UNTRUSTED INPUT + UNCONFIRMED DESTRUCTIVE ACTION: untrusted content + a dangerous or destructive write
 *         without Ask-first.
 *     Each combination carries ranked fix options, one per leg, that break it outright: fewest members to change
 *     first; Ask-first (keeps the capability) before removal; then members held by fewer other agents (blast radius).
 *  5. RANKED FIXES BY COUNTERFACTUAL. Each present factor's fix carries the points the score would drop by if that
 *     factor alone were removed (the ADR-0214 counterfactual), largest first, ties by factor id.
 *  6. UNMEASURED IS RISK, NOT ZERO. No fresh red-team run is a factor (untested), never "no finding" (ADR-0180).
 *
 * Open-source check (ADR-0176): none fits. This is governance policy semantics over our own schema (the CLAUDE.md
 * exception for "governance decisions, policy semantics"); the arithmetic is sums and a band lookup.
 */
import type { GuardrailMode } from "./guardrails.js";
import type { AutonomyClass } from "./assurance.js";
import type { AutonomyAgenticTestClass as RedTeamAgenticAttackClass, AutonomyObservedFacts } from "./autonomy.js";

/**
 * v2 (slice 2): the ownership factor also scores an owner who has not been active within the window (`inactive`).
 * v3 (addendum): capability combinations (lethal trifecta; untrusted input + unconfirmed destructive action) replace
 * the coarse builder-only combination, apply to registry agents through their workload identity's grants, and every
 * toxic combination's points are weighted by the reach band.
 */
export const AGENT_RISK_METHOD_VERSION = "adr0339-v3" as const;

/** what is scored: a registry agent (`agents`, including vendor-imported ones) or a builder agent */
export const AGENT_RISK_SUBJECT_KINDS = ["agent", "builder_agent"] as const;
export type AgentRiskSubjectKind = (typeof AGENT_RISK_SUBJECT_KINDS)[number];

/** why a recompute was asked for (the DB triggers write these; `backfill` is the migration's, `manual` an admin's) */
/**
 * Why an agent was marked for a recompute. `evidence_changed`: an input that is not the agent itself changed (a guardrail
 * mode, a model card or its sign-off, a red-team run, an SoD rule, the owner's account, a skill's admission, a use case,
 * an MCP tool). `scheduled`: the daily mark, so a fact that changes with time alone (a sign-off or a test going stale, an
 * owner going inactive) reaches the stored score.
 */
export const AGENT_RISK_TRIGGERS = ["created", "modified", "published", "access_changed", "evidence_changed", "imported", "backfill", "scheduled", "manual"] as const;
export type AgentRiskTrigger = (typeof AGENT_RISK_TRIGGERS)[number];

export const AGENT_RISK_BANDS = ["low", "medium", "high", "critical"] as const;
export type AgentRiskBand = (typeof AGENT_RISK_BANDS)[number];

/** the band edges: a score at or above the edge is in that band */
export const AGENT_RISK_BAND_EDGES: Readonly<Record<Exclude<AgentRiskBand, "low">, number>> = Object.freeze({
  medium: 25,
  high: 50,
  critical: 75,
});

export const AGENT_RISK_DISCLAIMER =
  "A rules-based estimate of how much could go wrong through this agent and how far it would reach. It is computed " +
  "from RegulAIt's own records with published weights; it is not a certification or an audit opinion.";

/** the reach bands: people who can use the agent plus things that depend on it */
export const AGENT_RISK_REACH_BANDS: ReadonlyArray<{ min: number; multiplier: number; label: string }> = Object.freeze([
  { min: 0, multiplier: 1, label: "reaches at most one person or dependent" },
  { min: 2, multiplier: 1.15, label: "reaches 2 to 10 people or dependents" },
  { min: 11, multiplier: 1.3, label: "reaches 11 to 50 people or dependents" },
  { min: 51, multiplier: 1.5, label: "reaches more than 50 people or dependents" },
]);

export type AgentRiskFactorId =
  | "guardrail_prompt_injection"
  | "guardrail_jailbreak"
  | "redteam_indirect_prompt_injection"
  | "redteam_tool_abuse"
  | "redteam_excessive_agency"
  | "model_card_unapproved"
  | "custom_endpoint"
  | "served_model_relaxed"
  | "ownership"
  | "no_spend_limit"
  | "autonomy_class"
  | "autonomy_declared_below_observed"
  | "write_tools_without_ask_first"
  | "computer_use"
  | "sub_agents"
  | "inbound_channels"
  | "schedules"
  | "unadmitted_skills";

/**
 * ADR-0339 slice 2: the ADR-0089 owner flag widened with `inactive`: the owner is active in the directory but has not
 * signed in, used a session or used an API key within this many days. Strict default; it is a constant until an owner
 * asks for it to be a setting (owner question on the slice 2 PR).
 */
export const AGENT_OWNER_INACTIVE_DAYS = 90;
export const AGENT_OWNERSHIP_FLAGS = ["owned", "inactive", "unowned", "orphaned"] as const;
export type AgentOwnershipFlag = (typeof AGENT_OWNERSHIP_FLAGS)[number];

/** the ownership flag from the owner id, whether the owner is deactivated, and when they were last active */
export function agentOwnershipFlag(
  ownerUserId: string | null,
  ownerDisabled: boolean,
  ownerLastActiveAt: Date | null,
  now: Date,
): AgentOwnershipFlag {
  if (!ownerUserId) return "unowned";
  if (ownerDisabled) return "orphaned";
  if (!ownerLastActiveAt || now.getTime() - ownerLastActiveAt.getTime() > AGENT_OWNER_INACTIVE_DAYS * 86_400_000) return "inactive";
  return "owned";
}

export type AgentRiskToxicId = "sod_rule_held_by_agent" | "lethal_trifecta" | "untrusted_input_unconfirmed_destructive";

/** the content-trust tiers of ADR-0193 (a source nobody classified is `untrusted`) */
export type AgentRiskSourceTier = "untrusted" | "standard" | "trusted";

/**
 * One capability the agent holds: a tool, a connector, an inbound channel, or computer use. The gateway resolves
 * builder agents from their own bindings and registry agents from their workload identity's grants (direct and role).
 */
export interface AgentRiskCapability {
  kind: "mcp_tool" | "connector" | "channel" | "computer_use";
  id: string;
  name: string;
  reads: boolean;
  writes: boolean;
  /** Ask-first is on (true) or off (false); null where the agent has no Ask-first switch (registry agents) */
  askFirst: boolean | null;
  /** the ADR-0193 tier of the tool's source; null for a channel or computer use (always untrusted input) */
  sourceTier: AgentRiskSourceTier | null;
  /** the tool can reach the open world (MCP `openWorldHint`; true unless an admitted definition says false) */
  openWorld: boolean;
  /** a dangerous (ADR-0236) or destructive (MCP `destructiveHint`) write */
  destructive: boolean;
  /** how many OTHER agents hold the same capability (the blast radius of removing it) */
  sharedWith: number;
}

export type AgentRiskLegId = "private_data" | "untrusted_content" | "external_communication" | "unconfirmed_destructive";

export interface AgentRiskLeg {
  id: AgentRiskLegId;
  label: string;
  members: Array<{ kind: AgentRiskCapability["kind"]; id: string; name: string; why: string }>;
}

/** one way to break a combination outright, ranked */
export interface AgentRiskFixOption {
  rank: number;
  action: "ask_first" | "remove";
  leg: AgentRiskLegId;
  targets: Array<{ kind: AgentRiskCapability["kind"]; id: string; name: string }>;
  /** members to change */
  cost: number;
  /** other agents holding the targets, summed (lower is a smaller blast radius) */
  sharedWith: number;
  title: string;
}

/** the facts the gateway gathers; every count is a count of rows that exist now */
export interface AgentRiskInput {
  kind: AgentRiskSubjectKind;
  id: string;
  name: string;
  /** owned, no accountable human recorded, the recorded human is deactivated (ADR-0089), or has not been active
   * within AGENT_OWNER_INACTIVE_DAYS (ADR-0339 slice 2) */
  ownership: AgentOwnershipFlag;
  /** the effective guardrail modes on the agent's model and project (resolveGuardrailPolicy) */
  guardrailModes: Readonly<Record<"prompt_injection" | "jailbreak", GuardrailMode>>;
  /** the agent dispatches a model: a registry agent with a model id, or a builder agent bound to one */
  modelBound: boolean;
  /** a live, approved model-card sign-off on the model binding (evaluateMrmGate read as enforced) */
  modelCardApproved: boolean;
  /** per agentic red-team class: the newest fresh run on the model that measured it (ADR-0180 A3/A8 evidence) */
  agenticTests: Readonly<Record<RedTeamAgenticAttackClass, { runId: string | null; probes: number; defeated: number }>>;
  testFreshnessDays: number;
  /** the model runs on an admin-registered custom endpoint (ADR-0034) */
  customEndpoint: boolean;
  /** an expected served model relaxes the served-model drift check (ADR-0175) */
  servedModelRelaxed: boolean;
  /** builder agents only: their own facts. Absent for a registry agent (those factors do not apply). */
  builder?: {
    facts: AutonomyObservedFacts;
    effectiveClass: AutonomyClass;
    declaredBelowObserved: boolean;
    monthlyLimitUsd: number | null;
    /** skills bound to the agent that are not admitted (held, flagged or never scanned) */
    unadmittedSkills: number;
  };
  /** who and what the agent reaches */
  reach: { people: number; dependents: number; detail: string };
  /** an enabled ADR-0091 rule whose every side the agent's own capability set holds (first match), or null */
  sodRule: { id: string; name: string } | null;
  /** the agent's own capabilities (addendum); null where it has none of its own (a registry agent with no identity) */
  capabilities: readonly AgentRiskCapability[] | null;
}

export interface AgentRiskFix {
  title: string;
  link: { to: string; label: string };
}

export interface AgentRiskFactor {
  id: AgentRiskFactorId;
  title: string;
  owasp: readonly string[];
  present: boolean;
  points: number;
  max: number;
  /** what was found, in plain words (also when absent) */
  evidence: string;
  fix: AgentRiskFix;
}

export interface AgentRiskToxicCombination {
  id: AgentRiskToxicId;
  title: string;
  owasp: readonly string[];
  present: boolean;
  points: number;
  evidence: string;
  fix: AgentRiskFix;
  /** capability combinations: the members of each leg (always present, also when a leg is empty) */
  legs?: AgentRiskLeg[];
  /** capability combinations, when present: every way to break it, ranked (the first is `fix`) */
  fixOptions?: AgentRiskFixOption[];
}

export interface AgentRiskRankedFix {
  rank: number;
  source: AgentRiskFactorId | AgentRiskToxicId;
  title: string;
  /** how many points the score drops by if this alone is fixed */
  points: number;
  owasp: readonly string[];
  link: { to: string; label: string };
}

export interface AgentRiskAssessment {
  estimate: true;
  methodVersion: typeof AGENT_RISK_METHOD_VERSION;
  subject: { kind: AgentRiskSubjectKind; id: string; name: string };
  score: number;
  band: AgentRiskBand;
  scale: { min: 0; max: 100 };
  exposure: number;
  reach: { people: number; dependents: number; multiplier: number; label: string; detail: string };
  factors: AgentRiskFactor[];
  toxicCombinations: AgentRiskToxicCombination[];
  fixes: AgentRiskRankedFix[];
  /** every OWASP id a present factor or combination maps to, sorted */
  owaspExposure: string[];
  method: string;
  disclaimer: string;
}

// ---------------------------------------------------------------------------
// The published weights
// ---------------------------------------------------------------------------

const LLM = (n: number) => `owasp:llm:2026:${String(n).padStart(2, "0")}`;
const ASI = (n: number) => `owasp:agentic:asi${String(n).padStart(2, "0")}`;

/** points for a guardrail detector by its effective mode: blocking removes the factor */
const GUARDRAIL_POINTS: Readonly<Record<GuardrailMode, number>> = Object.freeze({ off: 8, log: 6, warn: 3, block: 0 });

/** per agentic class: untested (no fresh run) and attacked successfully (any defeated probe) */
const REDTEAM_UNTESTED_POINTS = 4;
const REDTEAM_DEFEATED_POINTS = 8;
const REDTEAM_CLASS_OWASP: Readonly<Record<RedTeamAgenticAttackClass, readonly string[]>> = Object.freeze({
  // the evaluator catalog's own refs for each class (REDTEAM_CLASS_REFS), pinned by a test
  indirect_prompt_injection: [LLM(1), ASI(1), ASI(6)],
  tool_abuse: [LLM(3), ASI(2)],
  excessive_agency: [LLM(3), ASI(10)],
});

const AUTONOMY_POINTS: Readonly<Record<AutonomyClass, number>> = Object.freeze({
  assist: 0,
  supervised: 4,
  delegated: 8,
  autonomous: 12,
});

/** an owner gone (deactivated) is worse than none recorded, which is worse than one who has gone quiet */
const OWNERSHIP_POINTS: Readonly<Record<AgentOwnershipFlag, number>> = Object.freeze({
  owned: 0,
  inactive: 8,
  unowned: 10,
  orphaned: 15,
});

const per = (n: number, each: number, max: number) => Math.min(max, Math.max(0, n) * each);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** where each fix is made in the app */
function links(input: AgentRiskInput) {
  const agentPage = input.kind === "builder_agent" ? `/builder/agents/${input.id}` : "/admin/agents";
  return {
    guardrails: { to: "/admin/guardrails", label: "Open guardrail policy" },
    redteam: { to: "/admin/redteam", label: "Open red-team runs" },
    modelCards: { to: "/admin/model-risk", label: "Open model risk" },
    agent: { to: agentPage, label: input.kind === "builder_agent" ? "Open the agent" : "Open agents" },
    sod: { to: "/admin/sod", label: "Open segregation-of-duties rules" },
  };
}

function factorsFor(input: AgentRiskInput): AgentRiskFactor[] {
  const L = links(input);
  const out: AgentRiskFactor[] = [];
  const add = (f: Omit<AgentRiskFactor, "present">) => out.push({ ...f, present: f.points > 0 });

  for (const det of ["prompt_injection", "jailbreak"] as const) {
    const mode = input.guardrailModes[det];
    const label = det === "prompt_injection" ? "prompt-injection" : "jailbreak";
    add({
      id: det === "prompt_injection" ? "guardrail_prompt_injection" : "guardrail_jailbreak",
      title: `The ${label} guardrail does not block`,
      owasp: det === "prompt_injection" ? [LLM(1), ASI(1)] : [LLM(1)],
      points: GUARDRAIL_POINTS[mode],
      max: GUARDRAIL_POINTS.off,
      evidence: `the effective ${label} guardrail mode on this agent's model and project is '${mode}'`,
      fix: { title: `Set the ${label} guardrail to block for this agent's model or project`, link: L.guardrails },
    });
  }

  for (const cls of Object.keys(REDTEAM_CLASS_OWASP) as RedTeamAgenticAttackClass[]) {
    const t = input.agenticTests[cls];
    const tested = !!t.runId && t.probes > 0;
    const defeated = tested && t.defeated > 0;
    const name = cls; // our own attack-class id (ADR-0068), never an OWASP name
    add({
      id: `redteam_${cls}` as AgentRiskFactorId,
      title: `Agentic red-team class '${name}' is untested or was defeated`,
      owasp: REDTEAM_CLASS_OWASP[cls],
      points: !input.modelBound ? REDTEAM_UNTESTED_POINTS : defeated ? REDTEAM_DEFEATED_POINTS : tested ? 0 : REDTEAM_UNTESTED_POINTS,
      max: REDTEAM_DEFEATED_POINTS,
      evidence: !input.modelBound
        ? "the agent has no model binding, so no red-team run can measure it"
        : defeated
          ? `the newest fresh run defeated ${t.defeated} of ${t.probes} probes`
          : tested
            ? `the newest fresh run held all ${t.probes} probes`
            : `no finished run in the last ${input.testFreshnessDays} days measured this class`,
      fix: { title: `Run a red-team campaign covering '${name}' and fix what it defeats`, link: L.redteam },
    });
  }

  add({
    id: "model_card_unapproved",
    title: "No approved model-card sign-off on the model",
    owasp: [LLM(4), ASI(4)],
    points: input.modelCardApproved ? 0 : 10,
    max: 10,
    evidence: input.modelCardApproved
      ? "the model binding carries a live, approved sign-off"
      : input.modelBound
        ? "the model binding has no live, approved model-card sign-off"
        : "the agent has no model binding, so nothing about its model has been signed off",
    fix: { title: "Complete and approve the model card for this agent's model", link: L.modelCards },
  });

  add({
    id: "custom_endpoint",
    title: "The model runs on a custom endpoint",
    owasp: [LLM(4), ASI(4)],
    points: input.customEndpoint ? 4 : 0,
    max: 4,
    evidence: input.customEndpoint ? "the model is served by an admin-registered custom endpoint" : "the model is served by a built-in provider",
    fix: { title: "Pin the endpoint's served model and record its supplier in the vendor register", link: L.agent },
  });

  add({
    id: "served_model_relaxed",
    title: "The served-model drift check is relaxed",
    owasp: [LLM(4)],
    points: input.servedModelRelaxed ? 4 : 0,
    max: 4,
    evidence: input.servedModelRelaxed ? "an expected served model differs from the configured model" : "drift is measured against the configured model",
    fix: { title: "Remove the expected served model, or confirm it matches the configured model", link: L.agent },
  });

  add({
    id: "ownership",
    title: "No active accountable owner",
    owasp: [ASI(3), ASI(10)],
    points: OWNERSHIP_POINTS[input.ownership],
    max: OWNERSHIP_POINTS.orphaned,
    evidence:
      input.ownership === "orphaned"
        ? "the recorded owner is deactivated, so nobody is accountable for this agent"
        : input.ownership === "unowned"
          ? "no accountable owner is recorded"
          : input.ownership === "inactive"
            ? `the recorded owner has not been active in the last ${AGENT_OWNER_INACTIVE_DAYS} days`
            : "an active owner is recorded",
    fix: { title: "Assign an active owner (and a successor) to this agent", link: L.agent },
  });

  const b = input.builder;
  if (b) {
    add({
      id: "no_spend_limit",
      title: "No monthly spend limit",
      owasp: [LLM(6)],
      points: b.monthlyLimitUsd === null ? 6 : 0,
      max: 6,
      evidence: b.monthlyLimitUsd === null ? "the agent has no monthly spend limit" : `the agent is limited to ${b.monthlyLimitUsd} USD a month`,
      fix: { title: "Set a monthly spend limit on the agent", link: L.agent },
    });
    add({
      id: "autonomy_class",
      title: "The agent acts with autonomy",
      owasp: [LLM(3), ASI(10)],
      points: AUTONOMY_POINTS[b.effectiveClass],
      max: AUTONOMY_POINTS.autonomous,
      evidence: `the effective autonomy class (ADR-0180 A8) is '${b.effectiveClass}'`,
      fix: { title: "Reduce what runs without a person: Ask-first on write tools, fewer schedules and channels", link: L.agent },
    });
    add({
      id: "autonomy_declared_below_observed",
      title: "The declared autonomy is lower than observed",
      owasp: [ASI(9)],
      points: b.declaredBelowObserved ? 8 : 0,
      max: 8,
      evidence: b.declaredBelowObserved ? "the steward's declaration is below the class its setup shows" : "no declaration below the observed class",
      fix: { title: "Correct the autonomy declaration to the observed class", link: L.agent },
    });
    add({
      id: "write_tools_without_ask_first",
      title: "Write tools run without Ask-first",
      owasp: [LLM(3), ASI(2)],
      points: per(b.facts.writeToolsWithoutAskFirst, 4, 16),
      max: 16,
      evidence: `${plural(b.facts.writeToolsWithoutAskFirst, "write tool")} without Ask-first`,
      fix: { title: "Turn Ask-first back on for every write tool", link: L.agent },
    });
    add({
      id: "computer_use",
      title: "Computer use is on",
      owasp: [ASI(5)],
      points: b.facts.computerUse ? 10 : 0,
      max: 10,
      evidence: b.facts.computerUse ? "the agent can operate a computer" : "computer use is off",
      fix: { title: "Turn computer use off unless the use case needs it", link: L.agent },
    });
    add({
      id: "sub_agents",
      title: "The agent delegates to sub-agents",
      owasp: [ASI(7), ASI(8)],
      points: per(b.facts.subAgents, 3, 9),
      max: 9,
      evidence: `${plural(b.facts.subAgents, "live sub-agent")}`,
      fix: { title: "Remove sub-agents the agent does not need", link: L.agent },
    });
    add({
      id: "inbound_channels",
      title: "Messages from chat channels start the agent",
      owasp: [LLM(1), ASI(1)],
      points: per(b.facts.inboundChannels, 5, 10),
      max: 10,
      evidence: `${plural(b.facts.inboundChannels, "inbound channel")}`,
      fix: { title: "Unbind inbound channels, or keep Ask-first on everything the agent can write", link: L.agent },
    });
    add({
      id: "schedules",
      title: "Schedules run the agent unattended",
      owasp: [ASI(8)],
      points: per(b.facts.schedules, 2, 6),
      max: 6,
      evidence: `${plural(b.facts.schedules, "enabled schedule")}`,
      fix: { title: "Disable schedules nobody reviews", link: L.agent },
    });
    add({
      id: "unadmitted_skills",
      title: "Skills that are not admitted",
      owasp: [LLM(4), ASI(4)],
      points: per(b.unadmittedSkills, 4, 8),
      max: 8,
      evidence: `${plural(b.unadmittedSkills, "bound skill")} not admitted by the skill scan`,
      fix: { title: "Remove the skills, or have an admin admit them after review", link: L.agent },
    });
  }
  return out;
}

const TOXIC_POINTS = 15;
const LEG_ORDER: readonly AgentRiskLegId[] = ["private_data", "untrusted_content", "external_communication", "unconfirmed_destructive"];
const LEG_LABEL: Readonly<Record<AgentRiskLegId, string>> = Object.freeze({
  private_data: "Private data",
  untrusted_content: "Untrusted content",
  external_communication: "External communication",
  unconfirmed_destructive: "Unconfirmed destructive action",
});

const isTool = (c: AgentRiskCapability) => c.kind === "mcp_tool" || c.kind === "connector";
const unconfirmed = (c: AgentRiskCapability) => c.askFirst !== true;
const untrustedTier = (c: AgentRiskCapability) => c.sourceTier !== "trusted" && c.sourceTier !== "standard";

/** the members of each leg, with the reason each one is there */
export function capabilityLegs(caps: readonly AgentRiskCapability[]): Record<AgentRiskLegId, AgentRiskLeg> {
  const legs = Object.fromEntries(LEG_ORDER.map((id) => [id, { id, label: LEG_LABEL[id], members: [] as AgentRiskLeg["members"] }])) as Record<AgentRiskLegId, AgentRiskLeg>;
  const add = (leg: AgentRiskLegId, c: AgentRiskCapability, why: string) => legs[leg].members.push({ kind: c.kind, id: c.id, name: c.name, why });
  const sorted = [...caps].sort((a, b) => (a.kind + a.name + a.id < b.kind + b.name + b.id ? -1 : 1));
  for (const c of sorted) {
    if (c.kind === "channel") add("untrusted_content", c, "an inbound channel: anyone who can message it writes into the agent's context");
    if (c.kind === "computer_use") add("untrusted_content", c, "computer use: every page and screen it reads is untrusted");
    if (!isTool(c)) continue;
    if (c.reads) add("private_data", c, "can read data");
    if (c.reads && untrustedTier(c)) add("untrusted_content", c, `reads from a source classified ${c.sourceTier ?? "by nobody"} (ADR-0193: not trusted or standard)`);
    if (c.writes && unconfirmed(c)) add("external_communication", c, c.askFirst === false ? "writes without Ask-first" : "writes, and no person confirms each call");
    else if (c.reads && c.openWorld) add("external_communication", c, "can reach the open world, so a read can carry data out");
    if (c.writes && c.destructive && unconfirmed(c)) add("unconfirmed_destructive", c, "a dangerous or destructive write with no person confirming it");
  }
  return legs;
}

function names(members: AgentRiskLeg["members"]): string {
  if (!members.length) return "none";
  const shown = members.slice(0, 5).map((m) => m.name);
  return members.length > 5 ? `${shown.join(", ")} and ${members.length - 5} more` : shown.join(", ");
}

/** every way to break a combination by changing one leg, ranked */
export function rankFixOptions(legs: AgentRiskLeg[], caps: readonly AgentRiskCapability[]): AgentRiskFixOption[] {
  const byKey = new Map(caps.map((c) => [`${c.kind}:${c.id}`, c]));
  const opts: Omit<AgentRiskFixOption, "rank">[] = [];
  for (const leg of legs) {
    const members = leg.members.map((m) => byKey.get(`${m.kind}:${m.id}`)!).filter(Boolean);
    if (!members.length) continue;
    const targets = members.map((c) => ({ kind: c.kind, id: c.id, name: c.name }));
    const shared = members.reduce((s, c) => s + c.sharedWith, 0);
    // Ask-first breaks a leg only when every member is a write the agent can ask about (builder agents)
    if ((leg.id === "external_communication" || leg.id === "unconfirmed_destructive") && members.every((c) => c.writes && c.askFirst === false)) {
      opts.push({ action: "ask_first", leg: leg.id, targets, cost: members.length, sharedWith: shared, title: `Turn Ask-first on for ${targets.length === 1 ? "" : `${targets.length} tools: `}${names(leg.members)}` });
    }
    opts.push({ action: "remove", leg: leg.id, targets, cost: members.length, sharedWith: shared, title: `Remove the ${LEG_LABEL[leg.id].toLowerCase()} leg: ${names(leg.members)}` });
  }
  opts.sort(
    (a, b) =>
      a.cost - b.cost ||
      (a.action === b.action ? 0 : a.action === "ask_first" ? -1 : 1) ||
      a.sharedWith - b.sharedWith ||
      LEG_ORDER.indexOf(a.leg) - LEG_ORDER.indexOf(b.leg),
  );
  return opts.map((o, i) => ({ ...o, rank: i + 1 }));
}

function toxicFor(input: AgentRiskInput, multiplier: number): AgentRiskToxicCombination[] {
  const L = links(input);
  const points = Math.round(TOXIC_POINTS * multiplier);
  const caps = input.capabilities;
  const legs = caps ? capabilityLegs(caps) : null;
  const combo = (id: AgentRiskToxicId, title: string, owasp: string[], legIds: AgentRiskLegId[]): AgentRiskToxicCombination => {
    if (!caps || !legs) {
      return {
        id, title, owasp, present: false, points: 0,
        evidence: "not applicable: the agent holds no tools of its own (a registry agent without a workload identity acts only with its caller's)",
        fix: { title: "Nothing to fix", link: L.agent },
        legs: [],
      };
    }
    const these = legIds.map((l) => legs[l]);
    const present = these.every((l) => l.members.length > 0);
    const options = present ? rankFixOptions(these, caps) : [];
    return {
      id, title, owasp, present,
      points: present ? points : 0,
      evidence: these.map((l) => `${l.label.toLowerCase()}: ${names(l.members)}`).join("; ") + (present ? "" : " (a leg is empty, so the combination is broken)"),
      fix: { title: options[0]?.title ?? "Nothing to fix", link: L.agent },
      legs: these,
      ...(present ? { fixOptions: options } : {}),
    };
  };
  return [
    {
      id: "sod_rule_held_by_agent",
      title: "The agent alone holds every side of a segregation-of-duties rule",
      owasp: [ASI(3)],
      present: !!input.sodRule,
      points: input.sodRule ? points : 0,
      evidence: input.sodRule
        ? `the agent's own tools and model hold every side of the rule '${input.sodRule.name}'`
        : "no enabled rule has every side held by this agent",
      fix: { title: "Split the agent so no one agent holds every side of the rule", link: L.sod },
    },
    combo("lethal_trifecta", "Private data, untrusted content and external communication together (the lethal trifecta)", [LLM(1), LLM(2), ASI(1), ASI(2)], ["private_data", "untrusted_content", "external_communication"]),
    combo("untrusted_input_unconfirmed_destructive", "Untrusted content and an unconfirmed destructive action together", [LLM(1), LLM(3), ASI(1), ASI(2)], ["untrusted_content", "unconfirmed_destructive"]),
  ];
}

export function reachBand(people: number, dependents: number) {
  const total = Math.max(0, people) + Math.max(0, dependents);
  let band = AGENT_RISK_REACH_BANDS[0]!;
  for (const b of AGENT_RISK_REACH_BANDS) if (total >= b.min) band = b;
  return band;
}

export function bandFor(score: number): AgentRiskBand {
  if (score >= AGENT_RISK_BAND_EDGES.critical) return "critical";
  if (score >= AGENT_RISK_BAND_EDGES.high) return "high";
  if (score >= AGENT_RISK_BAND_EDGES.medium) return "medium";
  return "low";
}

/** the combiner, on its own so the counterfactual uses exactly the same arithmetic */
function combine(factorPoints: number, multiplier: number, toxicPoints: number) {
  const exposure = Math.min(100, factorPoints);
  return { exposure, score: Math.min(100, Math.round(exposure * multiplier) + toxicPoints) };
}

export const AGENT_RISK_METHOD =
  "score = min(100, round(exposure x reach multiplier) + toxic-combination points). Exposure is the sum of the factor " +
  "points, capped at 100. The reach multiplier is 1, 1.15, 1.3 or 1.5 for 0-1, 2-10, 11-50 or more than 50 people " +
  "and dependents. Each toxic combination adds 15 x the reach multiplier, rounded. The capability combinations are the " +
  "lethal trifecta (private data + untrusted content + external communication) and untrusted content + an unconfirmed " +
  "destructive action; each names the tools in every leg and ranks the ways to break it. Bands: low below 25, medium from 25, high from 50, critical from " +
  "75. Each fix shows how far the score would drop if that one thing were fixed.";

export function scoreAgentRisk(input: AgentRiskInput): AgentRiskAssessment {
  const factors = factorsFor(input);
  const reach = reachBand(input.reach.people, input.reach.dependents);
  const toxicCombinations = toxicFor(input, reach.multiplier);
  const sumFactors = factors.reduce((s, f) => s + f.points, 0);
  const sumToxic = toxicCombinations.reduce((s, t) => s + t.points, 0);
  const { exposure, score } = combine(sumFactors, reach.multiplier, sumToxic);

  const candidates: AgentRiskRankedFix[] = [
    ...factors
      .filter((f) => f.present)
      .map((f) => ({ source: f.id, title: f.fix.title, owasp: f.owasp, link: f.fix.link, points: score - combine(sumFactors - f.points, reach.multiplier, sumToxic).score })),
    ...toxicCombinations
      .filter((t) => t.present)
      .map((t) => ({ source: t.id, title: t.fix.title, owasp: t.owasp, link: t.fix.link, points: score - combine(sumFactors, reach.multiplier, sumToxic - t.points).score })),
  ].map((c) => ({ ...c, rank: 0 }));
  candidates.sort((a, b) => b.points - a.points || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  const fixes = candidates.map((c, i) => ({ ...c, rank: i + 1 }));

  const owaspExposure = [...new Set([...factors, ...toxicCombinations].filter((f) => f.present).flatMap((f) => f.owasp))].sort();
  return {
    estimate: true,
    methodVersion: AGENT_RISK_METHOD_VERSION,
    subject: { kind: input.kind, id: input.id, name: input.name },
    score,
    band: bandFor(score),
    scale: { min: 0, max: 100 },
    exposure,
    reach: { people: input.reach.people, dependents: input.reach.dependents, multiplier: reach.multiplier, label: reach.label, detail: input.reach.detail },
    factors,
    toxicCombinations,
    fixes,
    owaspExposure,
    method: AGENT_RISK_METHOD,
    disclaimer: AGENT_RISK_DISCLAIMER,
  };
}
