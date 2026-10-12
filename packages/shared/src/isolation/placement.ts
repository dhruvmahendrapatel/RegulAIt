/**
 * ADR-0190 slice I2 — THE PLACEMENT DECISION (shared, pure).
 *
 * What is ours here (ADR-0176 §4): which isolation a call REQUIRES. This file
 * holds the pure halves; the gateway (`execution-placement.ts`) resolves each
 * fact from the database and calls them:
 *
 *  - `computeRequiredClass` (decision 7): the MAX of the workload kind's floor,
 *    the project's data-sensitivity floor, every compliance tag's
 *    `min_isolation_class`, the agent's autonomy-class floor, the configured
 *    profile's `minClass`, the most restrictive profile for an unknown or
 *    low-assurance agent, and the parent grant's class on a delegated call.
 *    A fact that is missing or outside its vocabulary is UNRESOLVED (amendment
 *    item 15, owner decision B): never coerced to a class, never dropped from
 *    the MAX, never defaulted. The caller refuses `policy_unresolved`.
 *  - `delegationIsolationViolation` (decision 8): a child grant is never below
 *    its parent's class (`delegation-isolation`).
 *  - `livePlacementFailure` (decision 8, amendment item 12): the live-chain
 *    check on an actor whose workload holds a placement.
 *
 * Owner decision A: `enforce` is the only mode, so nothing here has a mode.
 */
import { z } from "zod";
import type { AutonomyClass } from "../assurance.js";
import {
  EXECUTION_REFUSAL_REASONS,
  isolationClassRank,
  ISOLABLE_WORKLOAD_KINDS,
  PLACEMENT_OUTCOMES,
  REQUIRABLE_ISOLATION_CLASSES,
  REQUIRED_CLASS_SOURCES,
  type ExecutorStatus,
  type IsolableWorkloadKind,
  type RequirableIsolationClass,
  type RequiredClassSource,
} from "./contract.js";
import { MOST_RESTRICTIVE_EXECUTION_PROFILE, SHIPPED_EXECUTION_PROFILES, type ShippedExecutionProfileName } from "./profiles.js";

/** the project data sensitivities (decision 7 item 2; `AI_USE_CASE_DATA_SENSITIVITIES`) */
export const PLACEMENT_SENSITIVITIES = ["public", "internal", "confidential", "regulated"] as const;
export type PlacementSensitivity = (typeof PLACEMENT_SENSITIVITIES)[number];

/**
 * Decision 7 item 4: ADR-0180 §5 gains an isolation floor. "An agent with
 * schedules, delegation or write tools without Ask-first starts at L2 at
 * least": those are the `delegated` and `autonomous` classes (autonomy.ts's
 * rules). An assistant or a supervised agent adds no floor above L1.
 */
export const AUTONOMY_ISOLATION_FLOORS: Readonly<Record<AutonomyClass, RequirableIsolationClass>> = Object.freeze({
  assist: "hardened_container",
  supervised: "hardened_container",
  delegated: "user_space_kernel",
  autonomous: "user_space_kernel",
});

/**
 * The autonomy floor of a workload whose subject has NO ADR-0180 autonomy
 * class: a registry agent (a model endpoint the gateway dispatches to, not a
 * builder agent) or our own engine worker. It is a defined value, not a
 * default for a missing fact: such a subject cannot act on its own, so it adds
 * nothing above L1. A builder agent whose class cannot be read does NOT get it:
 * that fact is unresolved (amendment item 15).
 */
export const NO_AUTONOMY_CLASS_FLOOR: RequirableIsolationClass = "hardened_container";

/**
 * Decision 7 item 5: how much the gateway trusts the agent. `known`: it has a
 * live ADR-0188 identity and its observed autonomy class is not above its
 * declared one. Anything else is "unknown or low-assurance" and starts in the
 * most restrictive shipped profile (PF-06). `unknown`: no agent is named for
 * a workload kind that acts for one.
 */
export const AGENT_ASSURANCE_LEVELS = ["known", "unknown", "no_identity", "observed_autonomy_above_declared"] as const;
export type AgentAssurance = (typeof AGENT_ASSURANCE_LEVELS)[number];

/** the class the most restrictive shipped profile requires (L3) */
export const UNKNOWN_AGENT_FLOOR: RequirableIsolationClass = SHIPPED_EXECUTION_PROFILES[MOST_RESTRICTIVE_EXECUTION_PROFILE].minClass;

/** the shipped profile a workload kind runs under when nothing is configured (decision 2) */
export function defaultProfileFor(kind: IsolableWorkloadKind, assurance: AgentAssurance): ShippedExecutionProfileName {
  if (assurance !== "known") return MOST_RESTRICTIVE_EXECUTION_PROFILE;
  return kind === "engine_worker" ? "engine-worker" : "restricted";
}

/**
 * Decision 3: the workload kind's own floor. `mcp_stdio` and `engine_worker`
 * read their (relaxable, audited) org settings; `code_exec` is L2, and L3 for
 * a confidential or regulated project; `byoc_worker` has none of its own ("the
 * class the placement requires"). A sensitivity that does not resolve gives
 * `code_exec` no floor here: the sensitivity fact itself refuses the call.
 */
export function workloadKindFloor(
  kind: IsolableWorkloadKind,
  sensitivity: unknown,
  settings: { isolationFloorMcpStdio: unknown; isolationFloorEngineWorker: unknown },
): unknown {
  switch (kind) {
    case "mcp_stdio":
      return settings.isolationFloorMcpStdio;
    case "engine_worker":
      return settings.isolationFloorEngineWorker;
    case "code_exec":
      return sensitivity === "confidential" || sensitivity === "regulated" ? "microvm" : "user_space_kernel";
    case "byoc_worker":
      return null;
  }
}

/**
 * The resolved facts behind one requirement. Each is typed `unknown` on
 * purpose: the gateway hands over what it read, and this function decides
 * whether it resolves. `undefined` (a key that was never filled in) is always
 * unresolved; `null` means "explicitly none" only where the fact allows it.
 */
export interface RequirementFacts {
  workloadKind: unknown;
  /** the project's data sensitivity */
  sensitivity: unknown;
  /** the org's floor for that sensitivity (decision 11 settings) */
  sensitivityFloor: unknown;
  /** decision 3's floor; null only for `byoc_worker` */
  workloadKindFloor: unknown;
  /** each tag's `min_isolation_class`: a class, or null for a tag with no isolation opinion */
  complianceFloors: unknown;
  /** the autonomy-class floor (`NO_AUTONOMY_CLASS_FLOOR` where the subject has no autonomy class); null does not resolve */
  autonomyFloor: unknown;
  agentAssurance: unknown;
  /** the configured profile's `minClass` (the strictest, where an agent and an MCP server each name one) */
  configuredProfileFloor: unknown;
  /** the parent grant's class on a delegated call, or null for none */
  parentRequiredClass: unknown;
}
export type RequirementFact = keyof RequirementFacts;

/** the order unresolved facts are reported in (the first one names the refusal) */
export const REQUIREMENT_FACTS: readonly RequirementFact[] = [
  "workloadKind",
  "sensitivity",
  "sensitivityFloor",
  "workloadKindFloor",
  "complianceFloors",
  "autonomyFloor",
  "agentAssurance",
  "configuredProfileFloor",
  "parentRequiredClass",
];

export interface RequiredClassFloor {
  source: RequiredClassSource;
  class: RequirableIsolationClass;
}

export type RequiredClassResult =
  | {
      ok: true;
      requiredClass: RequirableIsolationClass;
      /** the floor that set it; on a tie, the first in decision 7's order */
      requiredBy: RequiredClassSource;
      /** every floor that took part, in decision 7's order (the evidence of "which floor won") */
      floors: RequiredClassFloor[];
    }
  | { ok: false; unresolved: RequirementFact };

const isClass = (v: unknown): v is RequirableIsolationClass =>
  typeof v === "string" && (REQUIRABLE_ISOLATION_CLASSES as readonly string[]).includes(v);
const isIn = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/** the first fact that does not resolve, or null (amendment item 15) */
export function unresolvedRequirementFact(f: RequirementFacts): RequirementFact | null {
  if (!isIn(ISOLABLE_WORKLOAD_KINDS, f.workloadKind)) return "workloadKind";
  if (!isIn(PLACEMENT_SENSITIVITIES, f.sensitivity)) return "sensitivity";
  if (!isClass(f.sensitivityFloor)) return "sensitivityFloor";
  // only `byoc_worker` has no floor of its own; any other kind without one is a lookup that did not resolve
  if (f.workloadKind === "byoc_worker" ? f.workloadKindFloor !== null : !isClass(f.workloadKindFloor)) return "workloadKindFloor";
  if (!Array.isArray(f.complianceFloors) || f.complianceFloors.some((c) => c !== null && !isClass(c))) return "complianceFloors";
  if (!isClass(f.autonomyFloor)) return "autonomyFloor";
  if (!isIn(AGENT_ASSURANCE_LEVELS, f.agentAssurance)) return "agentAssurance";
  if (!isClass(f.configuredProfileFloor)) return "configuredProfileFloor";
  if (f.parentRequiredClass !== null && !isClass(f.parentRequiredClass)) return "parentRequiredClass";
  return null;
}

/**
 * Decision 7: the required class for one isolable call, or the first fact
 * that does not resolve. A class is a floor: the result is the MAX, so a tag,
 * an autonomy class or a parent can only raise it.
 */
export function computeRequiredClass(f: RequirementFacts): RequiredClassResult {
  const unresolved = unresolvedRequirementFact(f);
  if (unresolved) return { ok: false, unresolved };
  const floors: RequiredClassFloor[] = [];
  const add = (source: RequiredClassSource, c: unknown) => {
    if (isClass(c)) floors.push({ source, class: c });
  };
  add("workload_kind", f.workloadKindFloor);
  add("data_sensitivity", f.sensitivityFloor);
  for (const c of f.complianceFloors as unknown[]) add("compliance_tag", c);
  add("autonomy_class", f.autonomyFloor);
  add("configured_profile", f.configuredProfileFloor);
  if (f.agentAssurance !== "known") add("unknown_agent", UNKNOWN_AGENT_FLOOR);
  add("parent_grant", f.parentRequiredClass);
  // the sensitivity floor and the configured profile always resolve to a class, so `floors` is never empty
  let winner = floors[0]!;
  for (const fl of floors) if (isolationClassRank(fl.class) > isolationClassRank(winner.class)) winner = fl;
  return { ok: true, requiredClass: winner.class, requiredBy: winner.source, floors };
}

// ---------------------------------------------------------------------------
// Decision 8: delegation
// ---------------------------------------------------------------------------

/**
 * Is a child grant asking for a class below its parent's? A parent with no
 * class constrains nothing; a child that names none inherits its parent's
 * (it never runs looser). Not relaxable (decision 11 invariant).
 */
export function delegationIsolationViolation(parent: RequirableIsolationClass | null, child: RequirableIsolationClass | null): boolean {
  if (parent === null || child === null) return false;
  return isolationClassRank(child) < isolationClassRank(parent);
}

/** the class a child grant is stored with: what it asks for, or its parent's */
export function childIsolationClass(parent: RequirableIsolationClass | null, requested: RequirableIsolationClass | null | undefined): RequirableIsolationClass | null {
  return requested ?? parent;
}

/**
 * Decision 8 third bullet with amendment item 12: why an actor whose workload
 * holds a placement is not live. Each is refused `actor-chain-invalid`, with
 * the same envelope as every other live-chain failure.
 */
export const LIVE_PLACEMENT_FAILURES = ["executor_not_active", "executor_quarantined", "executor_attestation_stale"] as const;
export type LivePlacementFailure = (typeof LIVE_PLACEMENT_FAILURES)[number];

export function livePlacementFailure(f: {
  /** the executor's status now, or null when the placement names none */
  executorStatus: ExecutorStatus | null;
  /** a counting, passing attestation for the placement's profile, fresh on the database clock */
  attestationFresh: boolean;
  /** that attestation (through the customer mapping) at or above the grant's required class */
  attestedClassSatisfies: boolean;
}): LivePlacementFailure | null {
  if (f.executorStatus === "quarantined") return "executor_quarantined";
  if (f.executorStatus !== "active") return "executor_not_active";
  if (!f.attestationFresh || !f.attestedClassSatisfies) return "executor_attestation_stale";
  return null;
}

// ---------------------------------------------------------------------------
// The admin routes I2 builds
// ---------------------------------------------------------------------------

/** POST /v1/execution-profiles/:name/retire (no body fields; a reason is not free prose) */
export const retireExecutionProfileSchema = z.object({}).strict();

/** GET /v1/execution-placements: newest first, `before` is the `createdAt` of the last row seen */
export const executionPlacementsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    outcome: z.enum(PLACEMENT_OUTCOMES).optional(),
    workloadKind: z.enum(ISOLABLE_WORKLOAD_KINDS).optional(),
    reason: z.enum([...EXECUTION_REFUSAL_REASONS, "execution_profile_mismatch"]).optional(),
    before: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

/**
 * Decision 7 item 5 and decision 8: what an execution profile is assigned to.
 * `agent` and `builder_agent` store it on the agent's ADR-0188 workload
 * identity (`workload_identities.execution_profile_id`); `mcp_server` on the
 * server (`mcp_servers.execution_profile_id`, stdio servers only).
 */
export const EXECUTION_PROFILE_TARGET_KINDS = ["agent", "builder_agent", "mcp_server"] as const;
export type ExecutionProfileTargetKind = (typeof EXECUTION_PROFILE_TARGET_KINDS)[number];

/** PUT /v1/execution-profile-assignments/:targetKind/:targetId — a version id, or null for the shipped default */
export const setExecutionProfileAssignmentSchema = z.object({ profileId: z.string().uuid().nullable() }).strict();

/** what the profile list and the assignment views carry for one profile version */
export interface ExecutionProfileVersionView {
  id: string;
  name: string;
  version: number;
  digest: string;
  minClass: RequirableIsolationClass;
  shipped: boolean;
  retiredAt: string | null;
  createdAt: string;
  /** fields looser than the shipped `restricted` profile (each was a step-up and an audited relaxation) */
  relaxations: string[];
}
