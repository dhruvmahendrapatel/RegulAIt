/**
 * ADR-0190 slice I2 — THE PLACEMENT DECISION (decision 7): which isolation an
 * isolable call REQUIRES, and the refusal when nothing available meets it.
 *
 *   resolveRequirement(db, request)   every policy fact read now, from the database, then the pure MAX
 *                                     (`computeRequiredClass`, @regulait/shared): the workload kind's floor,
 *                                     the project's data-sensitivity floor, each compliance tag's
 *                                     `min_isolation_class`, the agent's autonomy-class floor, the configured
 *                                     profile's `minClass`, the most restrictive profile for an unknown or
 *                                     low-assurance agent, and the parent grant's class
 *   decidePlacement(db, request)      the requirement, then the broker (`offerPlacement`, I3). A fact that does
 *                                     not resolve refuses `policy_unresolved` before any offer (owner decision
 *                                     B); a broker refusal keeps its fixed reason. There is no fallback to a
 *                                     lower class and nothing is queued (decision 7 invariant).
 *   placementRefusal(reason)          the envelope every isolation refusal answers with:
 *                                     409 `execution_profile_unavailable`, rule id `execution-profile`
 *
 * Every refusal is audited `execution-refused` on the hash chain, naming the
 * floors and the fact that did not resolve (ids and fixed vocabularies only).
 * The governed call paths (I4 stdio, I5 engines) call `decidePlacement` before
 * any upstream contact; this slice builds the decision and its evidence.
 *
 * Where each fact comes from (read for I2):
 *  - sensitivity: a project has no sensitivity column; the strictest
 *    `data_sensitivity` of the AI use cases linked to the project. No project,
 *    or a project with no linked use case, does NOT resolve (never defaulted).
 *  - compliance floors: the project's classification tags, each resolved
 *    through its ACTIVE compliance-profile version (`complianceProfilesForTags`);
 *    an unresolvable version does not resolve.
 *  - autonomy: a builder agent's effective class (the stricter of declared and
 *    observed, ADR-0180 §5). A registry agent (or no agent, for our own
 *    workers) has no autonomy class: `NO_AUTONOMY_CLASS_FLOOR` (L1).
 *  - assurance: the agent's ADR-0188 workload identity, active; no identity
 *    (or none active) is `no_identity`; an observed autonomy class above the
 *    declared one is `observed_autonomy_above_declared`. Either starts in the
 *    most restrictive shipped profile.
 *  - profile: the stdio MCP server's assigned version, else the agent
 *    identity's, else the shipped default for the kind. Both assigned → both
 *    floors count (MAX), the server's profile is the one placed under.
 */
import { randomUUID } from "node:crypto";
import {
  aiUseCases,
  and,
  builderAgents,
  delegationGrants,
  eq,
  executionProfiles,
  isNull,
  mcpServers,
  projects,
  workloadIdentities,
  type Db,
  type ExecutionProfileRow,
} from "@regulait/db";
import {
  AUTONOMY_ISOLATION_FLOORS,
  computeRequiredClass,
  declaredBelowObserved,
  defaultProfileFor,
  deriveAutonomyClass,
  effectiveAutonomyClass,
  executionProfileBodySchema,
  executionProfileUnavailable,
  isolationClassRank,
  ISOLABLE_WORKLOAD_KINDS,
  NO_AUTONOMY_CLASS_FLOOR,
  NON_ISOLABLE_EXECUTION,
  PLACEMENT_SENSITIVITIES,
  REQUIRABLE_ISOLATION_CLASSES,
  SENSITIVITY_FLOOR_KEYS,
  workloadKindFloor,
  type AgentAssurance,
  type AutonomyClass,
  type ExecutionProfileUnavailable,
  type ExecutionRefusalReason,
  type IsolableWorkloadKind,
  type PlacementSensitivity,
  type RequirableIsolationClass,
  type RequiredClassFloor,
  type RequiredClassSource,
  type RequirementFact,
  type RequirementFacts,
  type WorkloadKind,
} from "@regulait/shared";
import { loadAutonomyFacts } from "./autonomy.js";
import { auditExecutor, offerPlacement, type OfferPlacementOutcome } from "./executor-channel.js";
import { databaseNow } from "./delegation.js";
import { loadOrgSettings } from "./org-settings.js";
import { complianceProfilesForTags } from "./projects.js";
import { ConfigVersionUnresolvableError } from "./rule-versions.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

/** one isolable (or not) call the gateway is about to make */
export interface PlacementRequest {
  workloadKind: WorkloadKind;
  /** the project the call is attributed to (its sensitivity and compliance tags) */
  projectId: string | null;
  /**
   * The agent the workload acts for. `null` = no agent: allowed for an `engine_worker` or `byoc_worker` (our own
   * worker image), and for any other kind it is an unknown agent (decision 7 item 5).
   */
  agent: { kind: "agent" | "builder_agent"; id: string } | null;
  /** the stdio MCP server whose sandbox this is (`mcp_stdio`) */
  mcpServerId?: string | null;
  /** the grant the call is made under, on a delegated call (decision 7 item 6) */
  parentGrantId?: string | null;
}

/** a resolved profile version */
export interface ResolvedProfile {
  id: string;
  name: string;
  version: number;
  digest: string;
  minClass: RequirableIsolationClass;
  retired: boolean;
  /** why this one: assigned to the MCP server or the agent, or the shipped default */
  source: "mcp_server" | "agent" | "shipped_default" | "most_restrictive";
}

export type Requirement =
  | { kind: "not_isolable"; execution: "in_gateway" | "external" }
  | {
      kind: "required";
      workloadKind: IsolableWorkloadKind;
      requiredClass: RequirableIsolationClass;
      requiredBy: RequiredClassSource;
      floors: RequiredClassFloor[];
      profile: ResolvedProfile;
      sensitivity: PlacementSensitivity;
      agentAssurance: AgentAssurance;
    }
  | { kind: "unresolved"; workloadKind: WorkloadKind; fact: RequirementFact };

const isIsolable = (k: unknown): k is IsolableWorkloadKind => typeof k === "string" && (ISOLABLE_WORKLOAD_KINDS as readonly string[]).includes(k);
const isRequirableClass = (c: unknown): c is RequirableIsolationClass => typeof c === "string" && (REQUIRABLE_ISOLATION_CLASSES as readonly string[]).includes(c);
const SENSITIVITY_RANK: Record<PlacementSensitivity, number> = { public: 0, internal: 1, confidential: 2, regulated: 3 };

function profileView(row: ExecutionProfileRow, source: ResolvedProfile["source"]): ResolvedProfile {
  return { id: row.id, name: row.name, version: row.version, digest: row.digest, minClass: row.minClass as RequirableIsolationClass, retired: row.retiredAt !== null, source };
}

/** the latest version of a shipped profile (the default a kind runs under when nothing is assigned) */
async function shippedProfile(db: Db, name: string): Promise<ExecutionProfileRow | null> {
  const rows = await db.select().from(executionProfiles).where(eq(executionProfiles.name, name));
  return rows.sort((a, b) => b.version - a.version)[0] ?? null;
}

/** the strictest sensitivity of the project's linked AI use cases; undefined = does not resolve */
async function projectSensitivity(db: Db, projectId: string | null): Promise<PlacementSensitivity | undefined> {
  if (!projectId) return undefined;
  const rows = await db.select({ s: aiUseCases.dataSensitivity }).from(aiUseCases).where(eq(aiUseCases.projectId, projectId));
  let out: PlacementSensitivity | undefined;
  for (const r of rows) {
    if (!(PLACEMENT_SENSITIVITIES as readonly string[]).includes(r.s)) return undefined;
    const s = r.s as PlacementSensitivity;
    if (out === undefined || SENSITIVITY_RANK[s] > SENSITIVITY_RANK[out]) out = s;
  }
  return out;
}

/** each tag's `min_isolation_class` through its active version; undefined = a version did not resolve */
async function complianceFloors(db: Db, projectId: string | null): Promise<Array<string | null> | undefined> {
  if (!projectId) return [];
  const [p] = await db.select({ classifications: projects.classifications }).from(projects).where(eq(projects.id, projectId));
  if (!p) return undefined;
  // null = the project carries no tags; anything else that is not a list of tag strings does not resolve (never [])
  const raw: unknown = p.classifications;
  if (raw !== null && (!Array.isArray(raw) || !raw.every((t) => typeof t === "string" && t.length > 0 && t.length <= 64))) return undefined;
  const tags = (raw ?? []) as string[];
  try {
    const profiles = await complianceProfilesForTags(db, tags);
    return profiles.map((x) => (x.minIsolationClass ?? null) as string | null);
  } catch (err) {
    if (err instanceof ConfigVersionUnresolvableError) return undefined;
    throw err;
  }
}

/**
 * Decision 7: read every fact for one call and compute its requirement. Never
 * writes. A fact that does not resolve is returned as such (the caller
 * refuses); nothing is defaulted except decision 7 item 5's unknown agent.
 */
export async function resolveRequirement(db: Db, req: PlacementRequest): Promise<Requirement> {
  if (!isIsolable(req.workloadKind)) {
    const execution = (NON_ISOLABLE_EXECUTION as Record<string, "in_gateway" | "external">)[req.workloadKind];
    if (execution) return { kind: "not_isolable", execution };
    return { kind: "unresolved", workloadKind: req.workloadKind, fact: "workloadKind" };
  }
  const kind = req.workloadKind;
  const org = await loadOrgSettings(db);
  const sensitivity = await projectSensitivity(db, req.projectId);
  const sensitivityFloor = sensitivity === undefined ? undefined : org[SENSITIVITY_FLOOR_KEYS[sensitivity]];
  const tagFloors = await complianceFloors(db, req.projectId);

  // the agent: identity (assurance), autonomy, its assigned profile
  let assurance: AgentAssurance = "known";
  // a subject with no autonomy class (a registry agent, our own worker) adds nothing above L1; a builder agent
  // whose class cannot be read leaves the fact unresolved
  let autonomyFloor: RequirableIsolationClass | undefined = NO_AUTONOMY_CLASS_FLOOR;
  let agentProfileId: string | null = null;
  if (req.agent === null) {
    if (kind !== "engine_worker" && kind !== "byoc_worker") assurance = "unknown";
  } else {
    const col = req.agent.kind === "agent" ? workloadIdentities.agentId : workloadIdentities.builderAgentId;
    const [ident] = await db.select().from(workloadIdentities).where(eq(col, req.agent.id));
    if (!ident || ident.status !== "active") assurance = "no_identity";
    else agentProfileId = ident.executionProfileId;
    if (req.agent.kind === "builder_agent") {
      const [ba] = await db.select().from(builderAgents).where(and(eq(builderAgents.id, req.agent.id), isNull(builderAgents.archivedAt)));
      if (!ba) {
        autonomyFloor = undefined;
      } else {
        const now = await databaseNow(db);
        const facts = (await loadAutonomyFacts(db, [ba], now)).get(ba.id)!;
        const derived = deriveAutonomyClass(facts);
        const declared = (ba.declaredAutonomyClass ?? null) as AutonomyClass | null;
        autonomyFloor = AUTONOMY_ISOLATION_FLOORS[effectiveAutonomyClass(derived, declared)];
        if (assurance === "known" && declaredBelowObserved(declared, derived)) assurance = "observed_autonomy_above_declared";
      }
    }
  }

  // the profile: the MCP server's, else the agent's, else the shipped default; an unknown agent gets the most
  // restrictive whatever is assigned (PF-06)
  // an mcp_stdio call names its stdio server: without one (or with a server that is not stdio) the server's own
  // profile, a floor of the call, cannot be looked up, so the fact does not resolve (never the agent's or the default)
  let serverProfileId: string | null = null;
  if (kind === "mcp_stdio" && !req.mcpServerId) return { kind: "unresolved", workloadKind: kind, fact: "configuredProfileFloor" };
  if (req.mcpServerId) {
    const [srv] = await db.select({ executionProfileId: mcpServers.executionProfileId, transport: mcpServers.transport }).from(mcpServers).where(eq(mcpServers.id, req.mcpServerId));
    if (!srv || srv.transport !== "stdio") return { kind: "unresolved", workloadKind: kind, fact: "configuredProfileFloor" };
    serverProfileId = srv.executionProfileId;
  }
  const byId = async (id: string) => (await db.select().from(executionProfiles).where(eq(executionProfiles.id, id)))[0] ?? null;
  let profile: ResolvedProfile | null = null;
  let configuredFloor: RequirableIsolationClass | undefined;
  const raise = (c: RequirableIsolationClass) => {
    configuredFloor = configuredFloor === undefined || isolationClassRank(c) > isolationClassRank(configuredFloor) ? c : configuredFloor;
  };
  // the CONFIGURED profile (the server's, else the agent's, else the shipped default for the kind) is the
  // configured_profile floor whatever the assurance. An unknown or low-assurance agent is then PLACED under the most
  // restrictive profile; that profile's class is the unknown_agent floor, not a configured one (so the floor that set
  // the requirement is named for what it is)
  const serverRow = serverProfileId ? await byId(serverProfileId) : null;
  const agentRow = agentProfileId ? await byId(agentProfileId) : null;
  if ((serverProfileId && !serverRow) || (agentProfileId && !agentRow)) return { kind: "unresolved", workloadKind: kind, fact: "configuredProfileFloor" };
  let configured: ResolvedProfile | null = null;
  if (serverRow) configured = profileView(serverRow, "mcp_server");
  else if (agentRow) configured = profileView(agentRow, "agent");
  else {
    const row = await shippedProfile(db, defaultProfileFor(kind, "known"));
    if (row) configured = profileView(row, "shipped_default");
  }
  if (!configured) return { kind: "unresolved", workloadKind: kind, fact: "configuredProfileFloor" };
  // ADR-0190 I5 (review LOW-1): an agent-null engine run's configured profile is the engine-worker default (its LATEST
  // version: the profile is versioned, I5 follow-up); its class as a configured floor is capped at the org's
  // engine-worker floor, so relaxing that setting (a `settings_relax` step-up, audited, never below L1: the floors are
  // requirable classes) is honoured here. The profile's own minClass still bounds where it can be PLACED (the broker
  // raises the requirement to it; the shipped version 1 is L2). An L1 engine placement therefore needs the org floor,
  // the sensitivity floor AND an engine-worker version at L1 (each a step-up), and an executor attesting L1: the runc
  // backend attests L1 only, and an L1 attestation never meets an L2 or L3 requirement (the broker's rank check).
  const engineWorkerFloor = org.isolationFloorEngineWorker as unknown;
  const relaxable = kind === "engine_worker" && req.agent === null && !serverRow && !agentRow && isRequirableClass(engineWorkerFloor);
  raise(relaxable && isolationClassRank(engineWorkerFloor) < isolationClassRank(configured.minClass) ? engineWorkerFloor : configured.minClass);
  if (agentRow && agentRow.id !== configured.id) raise(agentRow.minClass as RequirableIsolationClass);
  if (assurance !== "known") {
    const row = await shippedProfile(db, defaultProfileFor(kind, assurance));
    if (row) profile = profileView(row, "most_restrictive");
  } else profile = configured;
  if (!profile) return { kind: "unresolved", workloadKind: kind, fact: "configuredProfileFloor" };
  // the profile must allow this workload kind: a profile that cannot run it is a configuration fault
  const body = executionProfileBodySchema.safeParse(JSON.parse((await byId(profile.id))?.body ?? "null"));
  if (!body.success || !(body.data.workloadKinds as readonly string[]).includes(kind)) {
    return { kind: "unresolved", workloadKind: kind, fact: "configuredProfileFloor" };
  }

  // the parent grant (decision 7 item 6)
  let parentRequiredClass: string | null | undefined = null;
  if (req.parentGrantId) {
    const [g] = await db.select({ c: delegationGrants.requiredIsolationClass }).from(delegationGrants).where(eq(delegationGrants.id, req.parentGrantId));
    parentRequiredClass = g ? g.c : undefined;
  }

  const facts: RequirementFacts = {
    workloadKind: kind,
    sensitivity,
    sensitivityFloor,
    workloadKindFloor: workloadKindFloor(kind, sensitivity, org),
    complianceFloors: tagFloors,
    autonomyFloor,
    agentAssurance: assurance,
    configuredProfileFloor: configuredFloor,
    parentRequiredClass,
  };
  const r = computeRequiredClass(facts);
  if (!r.ok) return { kind: "unresolved", workloadKind: kind, fact: r.unresolved };
  return {
    kind: "required",
    workloadKind: kind,
    requiredClass: r.requiredClass,
    requiredBy: r.requiredBy,
    floors: r.floors,
    profile,
    sensitivity: sensitivity!,
    agentAssurance: assurance,
  };
}

export type PlacementDecision =
  | { kind: "not_isolable"; execution: "in_gateway" | "external" }
  | (OfferPlacementOutcome & { kind: "offered"; requirement: Extract<Requirement, { kind: "required" }> })
  | {
      kind: "refused";
      code: ExecutionRefusalReason;
      placementId: string | null;
      /** the HTTP envelope (decision 7; owner decision B) */
      envelope: ExecutionProfileUnavailable;
      requirement: Requirement;
    };

/** the refusal envelope of decision 7, as a response body */
export function placementRefusal(reason: ExecutionRefusalReason): ExecutionProfileUnavailable {
  return executionProfileUnavailable(reason);
}

/**
 * Decision 7 end to end for one call: the requirement, then an executor at or
 * above it, or a refusal before any upstream contact. `actorUserId` is the
 * person the call runs for (the audit row's user).
 */
export async function decidePlacement(
  db: Db,
  req: PlacementRequest & { imageDigest: string; actorUserId?: string | null; onlyExecutorIds?: readonly string[]; ttlSeconds?: number },
): Promise<PlacementDecision> {
  const requirement = await resolveRequirement(db, req);
  if (requirement.kind === "not_isolable") return requirement;
  const userId = req.actorUserId ?? NO_IDENTITY;
  if (requirement.kind === "unresolved") {
    // owner decision B: refused before any offer, audited; no placement row (its columns would hold the fact)
    await auditExecutor(db, {
      userId,
      objectType: "execution_placement",
      objectId: null,
      ruleId: "execution-refused",
      effect: "deny",
      detail: {
        code: "policy_unresolved",
        unresolvedFact: requirement.fact,
        workloadKind: isIsolable(requirement.workloadKind) ? requirement.workloadKind : null,
        projectId: req.projectId,
        agent: req.agent,
        mcpServerId: req.mcpServerId ?? null,
        parentGrantId: req.parentGrantId ?? null,
        refusalRuleId: "execution-profile",
        requestId: randomUUID(),
      },
      reason: `placement refused (policy_unresolved): the policy fact ${requirement.fact} did not resolve; nothing was offered and nothing reached the upstream (ADR-0190 decision 7, owner decision B; never defaulted)`,
    });
    return { kind: "refused", code: "policy_unresolved", placementId: null, envelope: placementRefusal("policy_unresolved"), requirement };
  }
  const outcome = await offerPlacement(db, {
    workloadKind: requirement.workloadKind,
    requiredClass: requirement.requiredClass,
    requiredBy: requirement.requiredBy,
    profileDigest: requirement.profile.digest,
    imageDigest: req.imageDigest,
    ...(req.onlyExecutorIds ? { onlyExecutorIds: req.onlyExecutorIds } : {}),
    ...(req.ttlSeconds !== undefined ? { ttlSeconds: req.ttlSeconds } : {}),
    audit: {
      userId,
      detail: {
        floors: requirement.floors,
        profileName: requirement.profile.name,
        profileVersion: requirement.profile.version,
        profileSource: requirement.profile.source,
        sensitivity: requirement.sensitivity,
        agentAssurance: requirement.agentAssurance,
        projectId: req.projectId,
        agent: req.agent,
        mcpServerId: req.mcpServerId ?? null,
        parentGrantId: req.parentGrantId ?? null,
        refusalRuleId: "execution-profile",
      },
    },
  });
  if (outcome.kind === "refused") {
    return { kind: "refused", code: outcome.code, placementId: outcome.placementId, envelope: placementRefusal(outcome.code), requirement };
  }
  return { ...outcome, requirement };
}
