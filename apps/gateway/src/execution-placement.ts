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
 * Where each fact comes from (read for I2, amended by owner decisions C and D, migration 0201):
 *  - sensitivity: MAX(the strictest `data_sensitivity` of the AI use cases
 *    linked to the project, the admin-set `projects.isolation_sensitivity`),
 *    which can only raise. No project, or a project with neither, does NOT
 *    resolve (never defaulted).
 *  - a person's own stdio call (owner decision C): an `mcp_stdio` call with no
 *    agent from an interactive person (`interactivePersonCaller`) in a scope
 *    (server or project) with an active `execution_person_stdio_relaxations`
 *    row has its unknown-agent floor at L2 and is placed under its configured
 *    profile. Every other floor still counts; an API key never qualifies.
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
  executionPersonStdioRelaxations,
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
  INTERACTIVE_SESSION_ORIGINS,
  NON_ISOLABLE_EXECUTION,
  PERSON_STDIO_RELAXATION_KIND,
  PERSON_STDIO_SUBJECT_KIND,
  projectIsolationSensitivity,
  REQUIRABLE_ISOLATION_CLASSES,
  SENSITIVITY_FLOOR_KEYS,
  workloadKindFloor,
  type AgentAssurance,
  type AutonomyClass,
  type ExecutionProfileUnavailable,
  type ExecutionRefusalReason,
  type IsolableWorkloadKind,
  type PersonStdioRelaxationScope,
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
  /**
   * Owner decision C: the caller is a PERSON in an INTERACTIVE session (`interactivePersonCaller`: a password, OIDC
   * or SAML session, no delegation grant). Only then may a "person's own stdio call" relaxation lower the
   * unknown-agent floor. Absent or false = never relaxed (an API key, a workload token, a worker loop, an engine).
   */
  interactivePerson?: boolean;
}

/** owner decision C: the relaxation one requirement used (recorded on the decision and the placement audit) */
export interface PersonStdioRelaxationUse {
  kind: typeof PERSON_STDIO_RELAXATION_KIND;
  subjectKind: typeof PERSON_STDIO_SUBJECT_KIND;
  /** the `execution_person_stdio_relaxations` row relied on */
  relaxationId: string;
  scopeKind: PersonStdioRelaxationScope;
  scopeId: string;
}

/**
 * Owner decision C, the one predicate for "a person in an interactive session": a session credential whose origin
 * is a person's sign-in (password, OIDC, SAML), with no delegation grant behind the call. The origin is the one the
 * server derived (`abacPrincipalFromRequest`, from the session row); a worker loop supplies none. An API key, a
 * session exchanged from one (`api_key`), the bootstrap identity and a workload token are never interactive.
 */
export function interactivePersonCaller(principal: { sessionOrigin?: string | null } | null | undefined, delegationGrantId: string | null | undefined): boolean {
  if (delegationGrantId) return false;
  const origin = principal?.sessionOrigin;
  return typeof origin === "string" && INTERACTIVE_SESSION_ORIGINS.includes(origin);
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
      /** owner decision C: the relaxation that lowered the unknown-agent floor to L2, or null */
      relaxation: PersonStdioRelaxationUse | null;
    }
  | { kind: "unresolved"; workloadKind: WorkloadKind; fact: RequirementFact };

const isIsolable = (k: unknown): k is IsolableWorkloadKind => typeof k === "string" && (ISOLABLE_WORKLOAD_KINDS as readonly string[]).includes(k);
const isRequirableClass = (c: unknown): c is RequirableIsolationClass => typeof c === "string" && (REQUIRABLE_ISOLATION_CLASSES as readonly string[]).includes(c);

function profileView(row: ExecutionProfileRow, source: ResolvedProfile["source"]): ResolvedProfile {
  return { id: row.id, name: row.name, version: row.version, digest: row.digest, minClass: row.minClass as RequirableIsolationClass, retired: row.retiredAt !== null, source };
}

/** the latest version of a shipped profile (the default a kind runs under when nothing is assigned) */
async function shippedProfile(db: Db, name: string): Promise<ExecutionProfileRow | null> {
  const rows = await db.select().from(executionProfiles).where(eq(executionProfiles.name, name));
  return rows.sort((a, b) => b.version - a.version)[0] ?? null;
}

/**
 * Owner decision D: MAX(the strictest sensitivity of the project's linked AI use cases, the admin-set project field).
 * The field can only raise. No project, a project that does not exist, or one with neither does not resolve
 * (undefined; never defaulted). A value outside the vocabulary does not resolve either.
 */
export async function projectSensitivity(db: Db, projectId: string | null): Promise<PlacementSensitivity | undefined> {
  if (!projectId) return undefined;
  const [p] = await db.select({ field: projects.isolationSensitivity }).from(projects).where(eq(projects.id, projectId));
  if (!p) return undefined;
  const rows = await db.select({ s: aiUseCases.dataSensitivity }).from(aiUseCases).where(eq(aiUseCases.projectId, projectId));
  return projectIsolationSensitivity(rows.map((r) => r.s), p.field);
}

/**
 * Owner decision C: the active relaxation in scope for this call (the server's first, then the project's), or null.
 * Only for an `mcp_stdio` call with no agent, no grant and an interactive person; nothing else ever reads one.
 */
async function personStdioRelaxation(db: Db, req: PlacementRequest): Promise<PersonStdioRelaxationUse | null> {
  if (req.workloadKind !== "mcp_stdio" || req.agent !== null || req.interactivePerson !== true || req.parentGrantId) return null;
  const scopes: Array<{ kind: PersonStdioRelaxationScope; id: string }> = [];
  if (req.mcpServerId) scopes.push({ kind: "mcp_server", id: req.mcpServerId });
  if (req.projectId) scopes.push({ kind: "project", id: req.projectId });
  for (const s of scopes) {
    const [row] = await db
      .select({ id: executionPersonStdioRelaxations.id })
      .from(executionPersonStdioRelaxations)
      .where(and(eq(executionPersonStdioRelaxations.scopeKind, s.kind), eq(executionPersonStdioRelaxations.scopeId, s.id), isNull(executionPersonStdioRelaxations.clearedAt)));
    if (row) return { kind: PERSON_STDIO_RELAXATION_KIND, subjectKind: PERSON_STDIO_SUBJECT_KIND, relaxationId: row.id, scopeKind: s.kind, scopeId: s.id };
  }
  return null;
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
  // ADR-0190 I5 (review LOW-1): an agent-null engine run's configured profile is the SHIPPED engine-worker default; its
  // class as a configured floor is capped at the org's engine-worker floor, so relaxing that setting (a `settings_relax`
  // step-up, audited, never below L1: the floors are requirable classes) is honoured here. The shipped profile's own
  // minClass still bounds where it can be PLACED (the broker raises the requirement to it), and there is no L1 (runc)
  // backend yet: an L1 engine-worker placement needs both a relaxed profile and that backend (ADR-0190 I5 as built).
  const engineWorkerFloor = org.isolationFloorEngineWorker as unknown;
  const relaxable = kind === "engine_worker" && req.agent === null && !serverRow && !agentRow && isRequirableClass(engineWorkerFloor);
  raise(relaxable && isolationClassRank(engineWorkerFloor) < isolationClassRank(configured.minClass) ? engineWorkerFloor : configured.minClass);
  if (agentRow && agentRow.id !== configured.id) raise(agentRow.minClass as RequirableIsolationClass);
  // owner decision C: an interactive person's own stdio call (no agent) in a relaxed scope is placed under the
  // CONFIGURED profile with the unknown-agent floor at L2 (`unknownAgentFloor`); every other floor still counts
  const relaxation = assurance === "unknown" ? await personStdioRelaxation(db, req) : null;
  if (assurance !== "known" && !relaxation) {
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
    personStdioRelaxed: relaxation !== null,
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
    relaxation,
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
        // owner decision C: the subject kind and the relaxation relied on (null = none)
        relaxation: requirement.relaxation,
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
