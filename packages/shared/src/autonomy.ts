/**
 * ADR-0180 §5 (A8) — THE AGENT AUTONOMY CLASS: derivation rules and control
 * floors, as pure functions.
 *
 * A builder agent's autonomy class is DERIVED from what the agent is set up to
 * do and what it was seen doing. It is never stored. A steward may DECLARE a
 * class as well; a declaration lower than the observed class is allowed but
 * flagged, and it never lowers the floor (the stricter class applies). With
 * nothing declared, the observed class applies.
 *
 * The gateway (`apps/gateway/src/autonomy.ts`) gathers the facts from the
 * builder tables and the evidence for the floors from the existing ledgers;
 * everything that DECIDES lives here, so it is deterministic and table-tested.
 *
 * THE DERIVATION RULES, in plain language (each is one row of AUTONOMY_RULES;
 * the class is the highest class any rule reaches, and `assist` when none does):
 *
 *   autonomous  R1 an enabled schedule: the agent starts work on a timer.
 *               R2 an inbound chat channel (Slack or Teams, bound to a chat
 *                  connection): an incoming message starts the agent.
 *               R3 observed: in the last 30 days a run started from a schedule
 *                  or an inbound message, not from a person in the chat.
 *   delegated   R4 a sub-agent: the agent hands work to other agents.
 *               R5 a write tool without Ask-first: the agent can change data
 *                  without a person confirming (an MCP tool of kind `write`,
 *                  or any connector, since every connector can write).
 *               R6 computer use is switched on.
 *               R7 observed: in the last 30 days a write tool call ran with no
 *                  person confirming it and no approval behind it.
 *   supervised  R8 the agent has a tool (every write one asks first).
 *               R9 observed: in the last 30 days the agent called a tool.
 *   assist      none of the above: it answers when a person asks.
 *
 * Open-source check (ADR-0176): none fits, because this is governance policy
 * semantics — a classification over our own builder schema — which is exactly
 * the code the open-source rule says we write ourselves.
 */
import { z } from "zod";
import {
  ASSURANCE_DEFAULTS,
  ASSURANCE_LIMITS,
  AUTONOMY_CLASSES,
  AUTONOMY_CLASS_INFO,
  type AutonomyClass,
  type AutonomyFacts,
  type MeasuredConditionInput,
} from "./assurance.js";
import { GUARDRAIL_MODES, type GuardrailMode } from "./guardrails.js";
import { REDTEAM_CLASS_REFS } from "./evaluator-catalog.js";
import { RED_TEAM_AGENTIC_ATTACK_CLASSES, type RedTeamAttackClass } from "./redteam.js";

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/** observed behaviour is read over this many days */
export const AUTONOMY_OBSERVATION_WINDOW_DAYS = 30;

/** What the agent was SEEN doing (the observation window). Optional on the
 * input of `deriveAutonomyClass`: absent counts as nothing observed. */
export interface AutonomyObservation {
  /** tools in the toolbox that resolve to a real connector or MCP tool */
  tools: number;
  /** runs started by a schedule or an inbound message, not a person in the chat */
  unattendedRuns: number;
  /** finished write tool calls with no confirmation and no approval behind them */
  unconfirmedWrites: number;
  /** tool calls of any kind */
  toolCalls: number;
}

export type AutonomyObservedFacts = AutonomyFacts & AutonomyObservation;

export const NO_AUTONOMY_OBSERVATION: Readonly<AutonomyObservation> = Object.freeze({
  tools: 0,
  unattendedRuns: 0,
  unconfirmedWrites: 0,
  toolCalls: 0,
});

/** the facts of several agents, as one: counts add up, computer use is any */
export function mergeAutonomyFacts(list: ReadonlyArray<AutonomyFacts & Partial<AutonomyObservation>>): AutonomyObservedFacts {
  const out: AutonomyObservedFacts = {
    schedules: 0,
    subAgents: 0,
    writeToolsWithoutAskFirst: 0,
    inboundChannels: 0,
    computerUse: false,
    ...NO_AUTONOMY_OBSERVATION,
  };
  for (const f of list) {
    out.schedules += f.schedules;
    out.subAgents += f.subAgents;
    out.writeToolsWithoutAskFirst += f.writeToolsWithoutAskFirst;
    out.inboundChannels += f.inboundChannels;
    out.computerUse ||= f.computerUse;
    out.tools += f.tools ?? 0;
    out.unattendedRuns += f.unattendedRuns ?? 0;
    out.unconfirmedWrites += f.unconfirmedWrites ?? 0;
    out.toolCalls += f.toolCalls ?? 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The derivation
// ---------------------------------------------------------------------------

export const AUTONOMY_RULE_IDS = [
  "enabled_schedule",
  "inbound_channel",
  "observed_unattended_run",
  "sub_agent",
  "write_tool_without_ask_first",
  "computer_use",
  "observed_unconfirmed_write",
  "has_tool",
  "observed_tool_call",
] as const;
export type AutonomyRuleId = (typeof AUTONOMY_RULE_IDS)[number];

export interface AutonomyRule {
  id: AutonomyRuleId;
  /** the class this rule lifts the agent to */
  class: Exclude<AutonomyClass, "assist">;
  /** set up (configuration) or seen (behaviour in the observation window) */
  basis: "setup" | "observed";
  /** does it apply? */
  applies: (f: AutonomyFacts & Partial<AutonomyObservation>) => boolean;
  /** the plain-language reason, with the count */
  reason: (f: AutonomyFacts & Partial<AutonomyObservation>) => string;
}

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/** THE RULES (see the file header). Order = highest class first. */
export const AUTONOMY_RULES: readonly AutonomyRule[] = [
  {
    id: "enabled_schedule",
    class: "autonomous",
    basis: "setup",
    applies: (f) => f.schedules > 0,
    reason: (f) => `It has ${n(f.schedules, "enabled schedule", "enabled schedules")}, so it starts work on its own timer.`,
  },
  {
    id: "inbound_channel",
    class: "autonomous",
    basis: "setup",
    applies: (f) => f.inboundChannels > 0,
    reason: (f) =>
      `It has ${n(f.inboundChannels, "inbound chat channel", "inbound chat channels")}, so a message in Slack or Teams starts it.`,
  },
  {
    id: "observed_unattended_run",
    class: "autonomous",
    basis: "observed",
    applies: (f) => (f.unattendedRuns ?? 0) > 0,
    reason: (f) =>
      `In the last ${AUTONOMY_OBSERVATION_WINDOW_DAYS} days it ran ${n(f.unattendedRuns ?? 0, "time", "times")} from a schedule or an incoming message, not from a person in the chat.`,
  },
  {
    id: "sub_agent",
    class: "delegated",
    basis: "setup",
    applies: (f) => f.subAgents > 0,
    reason: (f) => `It has ${n(f.subAgents, "sub-agent", "sub-agents")}, so it hands work to other agents.`,
  },
  {
    id: "write_tool_without_ask_first",
    class: "delegated",
    basis: "setup",
    applies: (f) => f.writeToolsWithoutAskFirst > 0,
    reason: (f) =>
      `${n(f.writeToolsWithoutAskFirst, "tool that can change data does", "tools that can change data do")} not ask a person first.`,
  },
  {
    id: "computer_use",
    class: "delegated",
    basis: "setup",
    applies: (f) => f.computerUse,
    reason: () => "Computer use is switched on.",
  },
  {
    id: "observed_unconfirmed_write",
    class: "delegated",
    basis: "observed",
    applies: (f) => (f.unconfirmedWrites ?? 0) > 0,
    reason: (f) =>
      `In the last ${AUTONOMY_OBSERVATION_WINDOW_DAYS} days ${n(f.unconfirmedWrites ?? 0, "change was", "changes were")} made through a tool with nobody confirming.`,
  },
  {
    id: "has_tool",
    class: "supervised",
    basis: "setup",
    applies: (f) => (f.tools ?? 0) > 0,
    reason: (f) => `It has ${n(f.tools ?? 0, "tool", "tools")}, and every tool that changes data asks a person first.`,
  },
  {
    id: "observed_tool_call",
    class: "supervised",
    basis: "observed",
    applies: (f) => (f.toolCalls ?? 0) > 0,
    reason: (f) => `In the last ${AUTONOMY_OBSERVATION_WINDOW_DAYS} days it called tools ${n(f.toolCalls ?? 0, "time", "times")}.`,
  },
];

export const autonomyLevel = (c: AutonomyClass): number => AUTONOMY_CLASS_INFO[c].level;

/** the more autonomous of two classes (null = none) */
export function maxAutonomyClass(a: AutonomyClass | null, b: AutonomyClass | null): AutonomyClass | null {
  if (!a) return b;
  if (!b) return a;
  return autonomyLevel(a) >= autonomyLevel(b) ? a : b;
}

export interface AutonomyReason {
  ruleId: AutonomyRuleId;
  class: AutonomyClass;
  basis: "setup" | "observed";
  text: string;
}

/** every rule that applies, highest class first */
export function autonomyReasons(facts: AutonomyFacts & Partial<AutonomyObservation>): AutonomyReason[] {
  return AUTONOMY_RULES.filter((r) => r.applies(facts)).map((r) => ({
    ruleId: r.id,
    class: r.class,
    basis: r.basis,
    text: r.reason(facts),
  }));
}

/** THE DERIVATION: the highest class any rule reaches; `assist` when none does */
export function deriveAutonomyClass(facts: AutonomyFacts & Partial<AutonomyObservation>): AutonomyClass {
  let out: AutonomyClass = "assist";
  for (const r of AUTONOMY_RULES) if (r.applies(facts)) out = maxAutonomyClass(out, r.class)!;
  return out;
}

/** a declaration below the observed class is allowed, and flagged */
export function declaredBelowObserved(declared: AutonomyClass | null, observed: AutonomyClass | null): boolean {
  return !!declared && !!observed && autonomyLevel(declared) < autonomyLevel(observed);
}

/** the class whose floor applies: the stricter of declared and observed (a
 * lower declaration never lowers the floor; undeclared = observed) */
export function effectiveAutonomyClass(observed: AutonomyClass, declared: AutonomyClass | null): AutonomyClass {
  return maxAutonomyClass(observed, declared)!;
}

// ---------------------------------------------------------------------------
// The control floors
// ---------------------------------------------------------------------------

/** the red-team classes an agent's autonomy must be tested against (ADR-0068 §4) */
export const AUTONOMY_AGENTIC_TEST_CLASSES = RED_TEAM_AGENTIC_ATTACK_CLASSES;
export type AutonomyAgenticTestClass = (typeof AUTONOMY_AGENTIC_TEST_CLASSES)[number];

/** an attack class's OWASP agentic id, read from the vendored mapping (never invented) */
export function agenticOwaspId(attackClass: RedTeamAttackClass): string | null {
  return REDTEAM_CLASS_REFS[attackClass].owasp.find((id) => id.startsWith("owasp:agentic:")) ?? null;
}

/** the detectors the guardrail floors read: the injection layers an agent with tools is exposed to */
export const AUTONOMY_GUARDRAIL_DETECTORS = ["prompt_injection", "jailbreak"] as const;
export type AutonomyGuardrailDetector = (typeof AUTONOMY_GUARDRAIL_DETECTORS)[number];

/** a guardrail mode's level, for the `guardrail_mode` metric: off 0, log 1, warn 2, block 3 */
export const guardrailModeLevel = (m: GuardrailMode): number => GUARDRAIL_MODES.indexOf(m);

export const AUTONOMY_FLOOR_IDS = [
  "guardrails_warn",
  "guardrails_block",
  "model_card_approved",
  "agentic_redteam_measured",
  "monthly_limit_set",
  "agentic_redteam_passing",
  "writes_ask_first_when_unattended",
] as const;
export type AutonomyFloorId = (typeof AUTONOMY_FLOOR_IDS)[number];

/** what the floors are checked against, gathered by the gateway per agent */
export interface AutonomyFloorEvidence {
  /** the effective guardrail modes for the agent's model and project */
  guardrailModes: Record<AutonomyGuardrailDetector, GuardrailMode>;
  /** the agent's model binding carries a live, approved model-card sign-off */
  modelCardApproved: boolean;
  /** per agentic class: the newest fresh run on the agent's model that measured it */
  agenticTests: Record<
    AutonomyAgenticTestClass,
    { runId: string | null; finishedAt: string | null; probes: number; defeated: number }
  >;
  /** red-team runs older than this many days do not count */
  testFreshnessDays: number;
  monthlyLimitUsd: number | null;
  writeToolsWithoutAskFirst: number;
}

export interface AutonomyFloorSpec {
  id: AutonomyFloorId;
  /** the least autonomous class this floor applies to (it applies to every class above as well) */
  minClass: AutonomyClass;
  label: string;
  /** how to put it in place, in plain language */
  fix: string;
}

/** THE FLOORS. Each is cumulative: a class carries its own and every lower class's. */
export const AUTONOMY_FLOORS: readonly AutonomyFloorSpec[] = [
  {
    id: "guardrails_warn",
    minClass: "supervised",
    label: "Prompt-injection and jailbreak guardrails at least warn",
    fix: "Ask an admin to set the prompt-injection and jailbreak guardrails to warn or block for this agent's model (Guardrails).",
  },
  {
    id: "guardrails_block",
    minClass: "delegated",
    label: "Prompt-injection and jailbreak guardrails block",
    fix: "Ask an admin to set the prompt-injection and jailbreak guardrails to block for this agent's model (Guardrails).",
  },
  {
    id: "model_card_approved",
    minClass: "delegated",
    label: "The model has an approved model card",
    fix: "Get the model card for this agent's model signed off (Model risk), or choose a model whose card is approved.",
  },
  {
    id: "agentic_redteam_measured",
    minClass: "delegated",
    label: "Agentic red-team classes measured",
    fix: "Run a red-team test on this agent's model that covers indirect prompt injection, tool abuse and excessive agency (Red team).",
  },
  {
    id: "monthly_limit_set",
    minClass: "autonomous",
    label: "A monthly spend limit is set",
    fix: "Set a monthly spend limit under Advanced.",
  },
  {
    id: "agentic_redteam_passing",
    minClass: "autonomous",
    label: "Agentic red-team classes passing",
    fix: "Fix what the red-team run found and run it again until no agentic attack succeeds (Red team).",
  },
  {
    id: "writes_ask_first_when_unattended",
    minClass: "autonomous",
    label: "Every tool that changes data asks first",
    fix: "Turn on Ask first for every tool that changes data under Connections. Nobody watches an unattended run, so a change waits in the approvals queue.",
  },
];

export function floorsForClass(c: AutonomyClass): AutonomyFloorSpec[] {
  return AUTONOMY_FLOORS.filter((f) => autonomyLevel(f.minClass) <= autonomyLevel(c));
}

export interface AutonomyFloorCheck {
  id: AutonomyFloorId;
  minClass: AutonomyClass;
  label: string;
  met: boolean;
  /** what was found, in plain language */
  detail: string;
  fix: string;
  /** for the red-team floors: the classes that fall short */
  failingTestClasses?: AutonomyAgenticTestClass[];
}

const CLASS_WORDS: Record<AutonomyAgenticTestClass, string> = {
  indirect_prompt_injection: "indirect prompt injection",
  tool_abuse: "tool abuse",
  excessive_agency: "excessive agency",
};

function checkOne(spec: AutonomyFloorSpec, ev: AutonomyFloorEvidence): Omit<AutonomyFloorCheck, "id" | "minClass" | "label" | "fix"> {
  const modes = AUTONOMY_GUARDRAIL_DETECTORS.map((d) => `${d.replace("_", "-")} ${ev.guardrailModes[d]}`).join(", ");
  const atLeast = (m: GuardrailMode) =>
    AUTONOMY_GUARDRAIL_DETECTORS.every((d) => guardrailModeLevel(ev.guardrailModes[d]) >= guardrailModeLevel(m));
  switch (spec.id) {
    case "guardrails_warn":
      return { met: atLeast("warn"), detail: `Guardrails: ${modes}.` };
    case "guardrails_block":
      return { met: atLeast("block"), detail: `Guardrails: ${modes}.` };
    case "model_card_approved":
      return {
        met: ev.modelCardApproved,
        detail: ev.modelCardApproved ? "The model card has a live sign-off." : "No live, approved model card for this agent's model.",
      };
    case "agentic_redteam_measured": {
      const missing = AUTONOMY_AGENTIC_TEST_CLASSES.filter((c) => !(ev.agenticTests[c].probes > 0));
      return {
        met: missing.length === 0,
        detail: missing.length
          ? `Not measured in the last ${ev.testFreshnessDays} days: ${missing.map((c) => CLASS_WORDS[c]).join(", ")}.`
          : `All three agentic classes measured in the last ${ev.testFreshnessDays} days.`,
        failingTestClasses: missing,
      };
    }
    case "agentic_redteam_passing": {
      const failing = AUTONOMY_AGENTIC_TEST_CLASSES.filter((c) => !(ev.agenticTests[c].probes > 0 && ev.agenticTests[c].defeated === 0));
      return {
        met: failing.length === 0,
        detail: failing.length
          ? `Not passing (unmeasured, or an attack succeeded): ${failing.map((c) => CLASS_WORDS[c]).join(", ")}.`
          : "No agentic attack succeeded in the newest runs.",
        failingTestClasses: failing,
      };
    }
    case "monthly_limit_set":
      return {
        met: ev.monthlyLimitUsd != null,
        detail: ev.monthlyLimitUsd != null ? `Monthly limit: $${ev.monthlyLimitUsd}.` : "No monthly spend limit.",
      };
    case "writes_ask_first_when_unattended":
      return {
        met: ev.writeToolsWithoutAskFirst === 0,
        detail:
          ev.writeToolsWithoutAskFirst === 0
            ? "Every tool that changes data asks first."
            : `${n(ev.writeToolsWithoutAskFirst, "tool that changes data does", "tools that change data do")} not ask first.`,
      };
  }
}

/** every floor of the class, checked */
export function checkAutonomyFloors(c: AutonomyClass, ev: AutonomyFloorEvidence): AutonomyFloorCheck[] {
  return floorsForClass(c).map((spec) => ({ id: spec.id, minClass: spec.minClass, label: spec.label, fix: spec.fix, ...checkOne(spec, ev) }));
}

/**
 * An unmet floor, as a measured condition of kind `autonomy_floor` (one per
 * red-team class that falls short). `params.floor` names the floor; the metric
 * is the nearest existing ledger metric, so a measurement of it can never pass
 * a floor the check did not (a yes/no floor uses `pack_control_evidenced`,
 * which nothing evidences under these params). The authority is
 * `autonomyFloorFor`, re-run live at the gate.
 */
export function floorConditions(
  check: AutonomyFloorCheck,
  agent: { id: string; name: string },
  cls: AutonomyClass,
): MeasuredConditionInput[] {
  const base = {
    kind: "autonomy_floor" as const,
    blocking: true,
    cadence: "daily" as const,
    onBreach: "alert" as const,
    minSamples: 1,
  };
  const text = (what: string) =>
    `Autonomy floor (${AUTONOMY_CLASS_INFO[cls].label.toLowerCase()}) for builder agent '${agent.name}': ${what}`.slice(
      0,
      ASSURANCE_LIMITS.maxConditionTextChars,
    );
  const params = { floor: check.id, builderAgentId: agent.id, autonomyClass: cls };
  switch (check.id) {
    case "guardrails_warn":
    case "guardrails_block": {
      const mode: GuardrailMode = check.id === "guardrails_warn" ? "warn" : "block";
      return [
        {
          ...base,
          text: text(check.label.toLowerCase()),
          metric: "guardrail_mode",
          params: { ...params, detectors: [...AUTONOMY_GUARDRAIL_DETECTORS], mode },
          operator: "gte",
          threshold: guardrailModeLevel(mode),
          windowDays: 1,
        },
      ];
    }
    case "agentic_redteam_measured":
    case "agentic_redteam_passing":
      return (check.failingTestClasses ?? []).map((attackClass) => ({
        ...base,
        text: text(`${CLASS_WORDS[attackClass]} red-team class ${check.id === "agentic_redteam_measured" ? "measured" : "passing"}`),
        metric: "redteam_asr" as const,
        params: { ...params, testClass: agenticOwaspId(attackClass), attackClass },
        operator: "lte" as const,
        threshold: check.id === "agentic_redteam_measured" ? 100 : 0,
        windowDays: ASSURANCE_DEFAULTS.requiredTestFreshnessDays,
      }));
    default:
      return [
        {
          ...base,
          text: text(check.label.toLowerCase()),
          metric: "pack_control_evidenced",
          params,
          operator: "eq",
          threshold: 1,
          windowDays: 1,
        },
      ];
  }
}

// ---------------------------------------------------------------------------
// The declaration (PUT /v1/builder/agents/:id/autonomy)
// ---------------------------------------------------------------------------

/** `class: null` withdraws the declaration (the observed class applies again);
 * declaring a class needs a note saying why */
export const declareAutonomySchema = z
  .object({
    class: z.enum(AUTONOMY_CLASSES).nullable(),
    note: z.string().trim().max(ASSURANCE_LIMITS.maxAutonomyNoteChars).optional(),
  })
  .strict()
  .refine((b) => b.class === null || (b.note ?? "").length > 0, {
    message: "say why you declare this class (note)",
    path: ["note"],
  });
export type DeclareAutonomyInput = z.infer<typeof declareAutonomySchema>;

/** the limit every autonomy view states */
export const AUTONOMY_SCOPE_NOTE =
  "Agents linked by project: a builder agent counts toward a use case when it bills to the use case's project.";

/** GET/PUT /v1/builder/agents/:id/autonomy */
export interface BuilderAgentAutonomyView {
  agentId: string;
  observed: { class: AutonomyClass; reasons: AutonomyReason[]; facts: AutonomyObservedFacts; windowDays: number };
  declared: {
    class: AutonomyClass;
    note: string | null;
    declaredBy: { id: string; name: string | null } | null;
    declaredAt: string;
  } | null;
  /** the class whose floor applies: the stricter of declared and observed */
  effective: AutonomyClass;
  declaredBelowObserved: boolean;
  floors: AutonomyFloorCheck[];
  /** use cases this agent counts toward (same project) */
  useCases: Array<{ id: string; name: string; status: string }>;
  scope: string;
}
