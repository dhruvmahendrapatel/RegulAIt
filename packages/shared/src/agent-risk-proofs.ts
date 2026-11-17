/**
 * ADR-0345 — the agent risk / control / proof registry.
 *
 * Owner (2026-11-17): for every AI-agent risk, show the control that is on, a test that continuously proves it works,
 * and the latest result as dated evidence. "A risk with no control and no test is just a heading."
 *
 * This module is the CATALOGUE, as code (the ADR-0081 `RISK_CATEGORY_EVIDENCE` pattern): each agent risk names
 *   - the OWASP items it answers to, as `controlRef`s of the ADR-0243 packs (LLM 2026 edition, MCP) plus the OWASP
 *     Agentic Top 10 name (no ASI pack exists, so the ASI id is a reference, not a pack control);
 *   - the register category of ADR-0081 it evidences (so a tenant's `ai_risks` row links to its proofs by category);
 *   - the RegulAIt control settings that mitigate it, each with its secure value (ADR-0180);
 *   - one or more executable proofs, each run by an EXISTING engine (ADR-0176: no new test runner):
 *       `redteam_suite`  the ADR-0057 in-process red-team (`runRedTeamSuite`) for the listed attack classes;
 *       `gateway_probe`  one sandboxed, tagged governed call against the tenant's own gateway whose refusal is the pass;
 *       `ledger_check`   a read-only check over a ledger that already exists (the audit chain, the register).
 * A tenant cannot edit the catalogue; it can only relax a proof's schedule (audited, `agent_risk_proof_settings`).
 */
import { OWASP_AGENTIC_NAMES } from "./owasp-framework-mappings.js";
import { OWASP_LLM_EDITIONS, OWASP_MCP_IDS } from "./owasp-packs.js";
import { RED_TEAM_ATTACK_CLASSES, type RedTeamAttackClass } from "./redteam.js";
import { AI_RISK_CATEGORIES, type AiRiskCategory } from "./risks.js";

/** bumped whenever a risk, control or proof changes meaning; every evidence row records the version it ran under */
export const AGENT_RISK_CATALOG_VERSION = 1;

/**
 * The origin tag on every proof's test traffic. It rides the same `purpose` slot the red-team tag does (ADR-0057 §2),
 * so proof traffic is metered and audited like real traffic but never counted as real usage.
 */
export const AGENT_RISK_PROOF_ORIGIN_TAG = "risk-proof";

export const AGENT_RISK_KEYS = [
  "prompt_injection",
  "data_leakage",
  "tool_misuse",
  "hallucination",
  "access_control_failure",
  "autonomous_overreach",
  "supply_chain",
  "memory_context_exploit",
  "infrastructure_baseline",
  "governance_gap",
] as const;
export type AgentRiskKey = (typeof AGENT_RISK_KEYS)[number];

export const AGENT_RISK_PROOF_ENGINES = ["redteam_suite", "gateway_probe", "ledger_check"] as const;
export type AgentRiskProofEngine = (typeof AGENT_RISK_PROOF_ENGINES)[number];

/**
 * The sandboxed gateway probes. Each is one governed call in a run-scoped sandbox (no real data, no real tool side
 * effect, tagged `AGENT_RISK_PROOF_ORIGIN_TAG`) whose expected outcome is a refusal.
 */
export const AGENT_RISK_GATEWAY_PROBES = [
  /** a document carrying a hidden instruction is fed back as tool output; pass = the instruction is blocked */
  "hidden_instruction_in_document",
  /** an approval already consumed is presented again; pass = rejected as consumed */
  "approval_replay",
  /** an approval past its expiry is presented; pass = rejected as expired */
  "approval_expired",
  /** a tool is called with an argument outside its data-scope allow-list; pass = refused */
  "tool_out_of_scope_argument",
  /** a worker is seeded to loop; pass = the turn cap stops it */
  "loop_turn_cap",
  /** a dispatch is made under `halted` execution mode; pass = refused */
  "kill_switch_halted",
  /** a tool definition changed after approval is offered; pass = blocked by the definition pin */
  "mcp_definition_drift",
  /** an untrusted source writes into shared context; pass = refused by the content trust floor */
  "untrusted_context_write",
] as const;
export type AgentRiskGatewayProbe = (typeof AGENT_RISK_GATEWAY_PROBES)[number];

export const AGENT_RISK_LEDGER_CHECKS = [
  /** ADR-0060: the audit chain verifies end to end and is anchored */
  "audit_chain_verifies",
  /** ADR-0081: every live register row has an owner, a scope and a review inside the window */
  "register_hygiene",
  /** ADR-0067: the latest groundedness run is inside the window and at or above its floor */
  "groundedness_floor",
] as const;
export type AgentRiskLedgerCheck = (typeof AGENT_RISK_LEDGER_CHECKS)[number];

/** the control settings a risk names; each is read at run time and compared with its secure value */
export const AGENT_RISK_CONTROL_SETTINGS = [
  "guardrail_configs.prompt_injection_mode",
  "guardrail_configs.semantic_dlp_mode",
  "compliance_profiles.pii_mode",
  "data_scope_rules",
  "abac_policies",
  "org_settings.approval_ttl_hours",
  "approvals.single_use",
  "org_settings.execution_mode",
  "org_settings.max_worker_turns",
  "org_settings.budget_enforcement",
  "org_settings.mcp_definition_pin_mode",
  "mcp_admission.mode",
  "content_trust_settings.write_floor",
  "audit_anchor.sink",
  "export_signing_key",
  "eval_runs.groundedness",
] as const;
export type AgentRiskControlSetting = (typeof AGENT_RISK_CONTROL_SETTINGS)[number];

export interface AgentRiskControl {
  setting: AgentRiskControlSetting;
  /** the strict value a secure deployment has (ADR-0180); a relaxed value is shown, never hidden */
  secureValue: string;
  adr: string;
}

export interface AgentRiskProof {
  /** stable across catalogue versions; the evidence key */
  key: string;
  engine: AgentRiskProofEngine;
  /** `redteam_suite`: the attack classes the run must cover */
  redteamClasses?: readonly RedTeamAttackClass[];
  /** `gateway_probe` */
  probe?: AgentRiskGatewayProbe;
  /** `ledger_check` */
  check?: AgentRiskLedgerCheck;
  /** what passing means, in words, shown verbatim next to the result */
  assertion: string;
  /** default schedule; an admin may lengthen it (audited), never past the maximum */
  defaultIntervalHours: number;
}

export interface AgentRisk {
  key: AgentRiskKey;
  title: string;
  /** ADR-0081 register categories this risk evidences */
  registerCategories: readonly AiRiskCategory[];
  /** `controlRef`s of the ADR-0243 packs */
  owaspRefs: readonly string[];
  /** OWASP Agentic Top 10 names (reference only; no pack) */
  owaspAgentic: readonly string[];
  controls: readonly AgentRiskControl[];
  proofs: readonly AgentRiskProof[];
}

export const AGENT_RISK_PROOF_MIN_INTERVAL_HOURS = 1;
export const AGENT_RISK_PROOF_MAX_INTERVAL_HOURS = 168;

const llm = (slug: string) => `owasp-llm-top-10:${slug}`;
const mcp = (slug: string) => `owasp-mcp-top-10:${slug}`;
const asi = (id: string) => {
  const name = OWASP_AGENTIC_NAMES.find((n) => n.startsWith(`${id}:`));
  if (!name) throw new Error(`unknown OWASP agentic id ${id}`);
  return name;
};
const DAY = 24;

export const AGENT_RISKS: readonly AgentRisk[] = [
  {
    key: "prompt_injection",
    title: "Prompt injection, direct and hidden in documents or tool output",
    registerCategories: ["prompt_injection"],
    owaspRefs: [llm("prompt-manipulation"), mcp("instructions-in-tool-content")],
    owaspAgentic: [asi("ASI01")],
    controls: [{ setting: "guardrail_configs.prompt_injection_mode", secureValue: "block", adr: "ADR-0042" }],
    proofs: [
      {
        key: "prompt_injection.hidden_instruction",
        engine: "gateway_probe",
        probe: "hidden_instruction_in_document",
        assertion: "An instruction hidden in a returned document is blocked and the agent does not act on it.",
        defaultIntervalHours: DAY,
      },
      {
        key: "prompt_injection.redteam",
        engine: "redteam_suite",
        redteamClasses: ["prompt_injection", "indirect_prompt_injection", "encoding_evasion"],
        assertion: "The red-team suite's attack success rate stays at or below its gating floor.",
        defaultIntervalHours: DAY,
      },
    ],
  },
  {
    key: "data_leakage",
    title: "Data leakage: PII, secrets or the system prompt leave through the agent",
    registerCategories: ["data_leakage_pii"],
    owaspRefs: [llm("sensitive-data-disclosure"), llm("hidden-context-leak"), mcp("context-oversharing")],
    owaspAgentic: [asi("ASI03")],
    controls: [
      { setting: "guardrail_configs.semantic_dlp_mode", secureValue: "block", adr: "ADR-0042" },
      { setting: "compliance_profiles.pii_mode", secureValue: "block", adr: "ADR-0019" },
    ],
    proofs: [
      {
        key: "data_leakage.redteam",
        engine: "redteam_suite",
        redteamClasses: ["data_exfiltration", "pii_leak", "system_prompt_extraction"],
        assertion: "Exfiltration, PII-leak and system-prompt-extraction probes do not succeed above the floor.",
        defaultIntervalHours: DAY,
      },
    ],
  },
  {
    key: "tool_misuse",
    title: "Tool misuse: a tool driven with arguments outside its allowed scope",
    registerCategories: ["tool_misuse"],
    owaspRefs: [llm("agent-overreach"), mcp("command-execution")],
    owaspAgentic: [asi("ASI02")],
    controls: [
      { setting: "data_scope_rules", secureValue: "allow-list, fail closed", adr: "ADR-0040" },
      { setting: "abac_policies", secureValue: "default deny", adr: "ADR-0040" },
    ],
    proofs: [
      {
        key: "tool_misuse.out_of_scope_argument",
        engine: "gateway_probe",
        probe: "tool_out_of_scope_argument",
        assertion: "A tool call whose argument is outside the data-scope allow-list is refused before the tool runs.",
        defaultIntervalHours: DAY,
      },
      {
        key: "tool_misuse.redteam",
        engine: "redteam_suite",
        redteamClasses: ["tool_abuse"],
        assertion: "Tool-abuse probes do not induce a governed tool call above the floor.",
        defaultIntervalHours: DAY,
      },
    ],
  },
  {
    key: "hallucination",
    title: "Hallucination: answers its sources do not support",
    registerCategories: ["hallucination"],
    owaspRefs: [llm("false-output")],
    owaspAgentic: [asi("ASI09")],
    controls: [{ setting: "eval_runs.groundedness", secureValue: "scheduled, floor enforced", adr: "ADR-0067" }],
    proofs: [
      {
        key: "hallucination.groundedness",
        engine: "ledger_check",
        check: "groundedness_floor",
        assertion: "The latest groundedness run is inside the window and its pass rate is at or above the floor.",
        defaultIntervalHours: DAY,
      },
    ],
  },
  {
    key: "access_control_failure",
    title: "Access-control failure: an expired or reused approval is accepted",
    registerCategories: ["over_permissioning"],
    owaspRefs: [mcp("caller-authentication"), mcp("permission-creep")],
    owaspAgentic: [asi("ASI03")],
    controls: [
      { setting: "org_settings.approval_ttl_hours", secureValue: "72 or less", adr: "ADR-0105" },
      { setting: "approvals.single_use", secureValue: "consumed on use", adr: "ADR-0104" },
    ],
    proofs: [
      {
        key: "access_control.approval_replay",
        engine: "gateway_probe",
        probe: "approval_replay",
        assertion: "Presenting an already consumed approval again is rejected.",
        defaultIntervalHours: DAY,
      },
      {
        key: "access_control.approval_expired",
        engine: "gateway_probe",
        probe: "approval_expired",
        assertion: "Presenting an expired approval is rejected.",
        defaultIntervalHours: DAY,
      },
    ],
  },
  {
    key: "autonomous_overreach",
    title: "Autonomous overreach: runaway loops, spend past its cap, no working kill switch",
    registerCategories: ["budget_overrun", "scope_drift"],
    owaspRefs: [llm("agent-overreach"), llm("resource-exhaustion")],
    owaspAgentic: [asi("ASI08"), asi("ASI10")],
    controls: [
      { setting: "org_settings.max_worker_turns", secureValue: "bounded", adr: "ADR-0021" },
      { setting: "org_settings.budget_enforcement", secureValue: "block", adr: "ADR-0021" },
      { setting: "org_settings.execution_mode", secureValue: "halt available", adr: "ADR-0124" },
    ],
    proofs: [
      {
        key: "overreach.loop_turn_cap",
        engine: "gateway_probe",
        probe: "loop_turn_cap",
        assertion: "A worker seeded to loop is stopped by the turn cap.",
        defaultIntervalHours: DAY,
      },
      {
        key: "overreach.kill_switch",
        engine: "gateway_probe",
        probe: "kill_switch_halted",
        assertion: "A dispatch under the halted execution mode is refused.",
        defaultIntervalHours: DAY,
      },
      {
        key: "overreach.redteam",
        engine: "redteam_suite",
        redteamClasses: ["excessive_agency"],
        assertion: "Excessive-agency probes do not succeed above the floor.",
        defaultIntervalHours: DAY,
      },
    ],
  },
  {
    key: "supply_chain",
    title: "Supply chain: an unvetted or silently changed plug-in or MCP server",
    registerCategories: ["supply_chain", "third_party_ai"],
    owaspRefs: [llm("model-supply-chain"), mcp("server-supply-chain"), mcp("tampered-tool-metadata"), mcp("unregistered-servers")],
    owaspAgentic: [asi("ASI04")],
    controls: [
      { setting: "org_settings.mcp_definition_pin_mode", secureValue: "block", adr: "ADR-0246" },
      { setting: "mcp_admission.mode", secureValue: "enforce", adr: "ADR-0097" },
    ],
    proofs: [
      {
        key: "supply_chain.definition_drift",
        engine: "gateway_probe",
        probe: "mcp_definition_drift",
        assertion: "A tool whose definition changed after approval is blocked until an admin re-approves it.",
        defaultIntervalHours: DAY,
      },
    ],
  },
  {
    key: "memory_context_exploit",
    title: "Memory and context exploits: untrusted content poisons shared context",
    registerCategories: ["prompt_injection"],
    owaspRefs: [llm("training-data-poisoning"), llm("retrieval-store-weakness")],
    owaspAgentic: [asi("ASI06")],
    controls: [{ setting: "content_trust_settings.write_floor", secureValue: "standard or stricter", adr: "ADR-0193" }],
    proofs: [
      {
        key: "memory.untrusted_context_write",
        engine: "gateway_probe",
        probe: "untrusted_context_write",
        assertion: "An untrusted source's write into shared context is refused by the trust floor.",
        defaultIntervalHours: DAY,
      },
    ],
  },
  {
    key: "infrastructure_baseline",
    title: "Infrastructure baseline: the evidence trail itself can be trusted",
    registerCategories: [],
    owaspRefs: [mcp("audit-trail"), mcp("secrets-and-tokens")],
    owaspAgentic: [],
    controls: [
      { setting: "audit_anchor.sink", secureValue: "tamper-resistant", adr: "ADR-0060" },
      { setting: "export_signing_key", secureValue: "configured", adr: "ADR-0116" },
    ],
    proofs: [
      {
        key: "infrastructure.audit_chain",
        engine: "ledger_check",
        check: "audit_chain_verifies",
        assertion: "The audit hash chain verifies end to end and its head is anchored.",
        defaultIntervalHours: DAY,
      },
    ],
  },
  {
    key: "governance_gap",
    title: "Governance gaps: a risk with no owner, no scope or no recent review",
    registerCategories: ["scope_drift"],
    owaspRefs: [],
    owaspAgentic: [],
    controls: [],
    proofs: [
      {
        key: "governance.register_hygiene",
        engine: "ledger_check",
        check: "register_hygiene",
        assertion: "Every live register risk has an active owner, a scope and a review inside the window.",
        defaultIntervalHours: DAY,
      },
    ],
  },
];

/** every proof, flattened, with its risk */
export function agentRiskProofs(): { risk: AgentRisk; proof: AgentRiskProof }[] {
  return AGENT_RISKS.flatMap((risk) => risk.proofs.map((proof) => ({ risk, proof })));
}

export function agentRiskProofByKey(key: string): { risk: AgentRisk; proof: AgentRiskProof } | undefined {
  return agentRiskProofs().find((p) => p.proof.key === key);
}

/**
 * The catalogue's own invariants, returned as problems (empty = sound). The test suite pins an empty list, so a
 * catalogue edit that leaves a heading without a test, cites a non-existent pack control or attack class, or names a
 * proof without its engine's input fails the build.
 */
export function agentRiskCatalogProblems(risks: readonly AgentRisk[] = AGENT_RISKS): string[] {
  const problems: string[] = [];
  const packRefs = new Set([...Object.keys(OWASP_LLM_EDITIONS), ...Object.keys(OWASP_MCP_IDS)]);
  const seenRisk = new Set<string>();
  const seenProof = new Set<string>();
  for (const r of risks) {
    if (seenRisk.has(r.key)) problems.push(`${r.key}: duplicate risk`);
    seenRisk.add(r.key);
    if (r.proofs.length === 0) problems.push(`${r.key}: no proof (a risk with no test is just a heading)`);
    if (r.controls.length === 0 && r.key !== "governance_gap") problems.push(`${r.key}: no control`);
    for (const ref of r.owaspRefs) if (!packRefs.has(ref)) problems.push(`${r.key}: unknown pack control ${ref}`);
    for (const n of r.owaspAgentic) if (!OWASP_AGENTIC_NAMES.includes(n)) problems.push(`${r.key}: unknown agentic item ${n}`);
    for (const c of r.registerCategories) {
      if (!(AI_RISK_CATEGORIES as readonly string[]).includes(c)) problems.push(`${r.key}: unknown category ${c}`);
    }
    for (const p of r.proofs) {
      if (seenProof.has(p.key)) problems.push(`${p.key}: duplicate proof`);
      seenProof.add(p.key);
      if (!/^[a-z_]+\.[a-z_]+$/.test(p.key)) {
        problems.push(`${p.key}: proof key must be <group>.<name> in lower snake case`);
      }
      const needs =
        p.engine === "redteam_suite"
          ? (p.redteamClasses?.length ?? 0) > 0 &&
            p.redteamClasses!.every((c) => (RED_TEAM_ATTACK_CLASSES as readonly string[]).includes(c))
          : p.engine === "gateway_probe"
            ? p.probe !== undefined && (AGENT_RISK_GATEWAY_PROBES as readonly string[]).includes(p.probe)
            : p.check !== undefined && (AGENT_RISK_LEDGER_CHECKS as readonly string[]).includes(p.check);
      if (!needs) problems.push(`${p.key}: ${p.engine} proof is missing or names an unknown input`);
      if (
        !Number.isInteger(p.defaultIntervalHours) ||
        p.defaultIntervalHours < AGENT_RISK_PROOF_MIN_INTERVAL_HOURS ||
        p.defaultIntervalHours > AGENT_RISK_PROOF_MAX_INTERVAL_HOURS
      ) {
        problems.push(`${p.key}: interval out of range`);
      }
      if (p.assertion.trim().length === 0) problems.push(`${p.key}: empty assertion`);
    }
  }
  for (const k of AGENT_RISK_KEYS) if (!seenRisk.has(k)) problems.push(`${k}: risk key has no catalogue entry`);
  return problems;
}

/** the outcome of one proof run; `error` (the proof could not run) is never read as a pass */
export const AGENT_RISK_PROOF_OUTCOMES = ["pass", "fail", "error"] as const;
export type AgentRiskProofOutcome = (typeof AGENT_RISK_PROOF_OUTCOMES)[number];

export const AGENT_RISK_PROOF_TRIGGERS = ["scheduled", "manual"] as const;
export type AgentRiskProofTrigger = (typeof AGENT_RISK_PROOF_TRIGGERS)[number];
