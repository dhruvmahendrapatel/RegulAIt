/**
 * ADR-0059 — the GATEWAY half of POLICY SIMULATION / BLAST-RADIUS PREVIEW.
 *
 * This is the consumer ADR-0040 promised. ADR-0040 shipped the *hook* — one
 * `POST /v1/abac/simulate` that answers "what would this decide for this one
 * (user, server, tool) right now" — and said in as many words that the full
 * policy-simulation surface is ADR-0059's. This file is that surface: given a
 * PROPOSED policy version, dry-run it against RECORDED HISTORY and report what
 * it *would have* newly denied or newly sent to approval, before activation.
 *
 * Division of labour:
 *
 *   `packages/shared/src/policy-simulation.ts`  the replay classifier, the
 *                                               fidelity analysis, the
 *                                               entitlement-scope decision and
 *                                               the blast-radius summary. Pure.
 *   `apps/gateway/src/abac.ts`                  attribute assembly — reused
 *                                               VERBATIM, never re-implemented.
 *   THIS FILE                                   selects the recorded rows,
 *                                               drives the candidate through
 *                                               the same Cedar engine
 *                                               enforcement uses, persists the
 *                                               preview, and owns the surface.
 *
 * ZERO SIDE EFFECTS, STRUCTURALLY
 *
 *   Look at the imports. There is no `executeGovernedDispatch`, no
 *   `governedEvaluate`, no provider, no approvals write, no rate-counter write,
 *   no `usage_events` write, and no update to `abac_policies`. A dry run cannot
 *   dispatch because the dispatch core is not reachable from this module —
 *   which is a property of the dependency graph, not a promise in a comment,
 *   and the test proves it with a provider spy whose invocation count must be
 *   exactly zero.
 *
 *   The ONE side effect that does exist is deliberate and disclosed: a single
 *   `audit_log` row saying a simulation ran, under which entitlement scope, over
 *   which window. A preview reads other people's traffic; who previewed whose
 *   history has to be a record (this is also why refusals audit — ADR-0047's
 *   discipline, where "who was told no" is as much the record as what was
 *   produced).
 *
 * WHY THE CANDIDATE IS EVALUATED ALONE
 *
 *   The question is "what would THIS change do", so the replay evaluates the
 *   candidate version by itself rather than the active set plus the candidate.
 *   ABAC is subtractive (ADR-0040: a Cedar `permit` is not a grant), so a call
 *   the already-active set would have blocked anyway is *recorded as blocked in
 *   the history* and therefore never counted as a new denial — the recorded
 *   effect carries that information for free, without having to reconstruct the
 *   whole historical policy set.
 *
 * WHAT REPLAY CANNOT REACH, SAID ON THE ROW
 *
 *   `audit_log` records the DECISION, not the whole decision INPUT: no call
 *   arguments, no decision-time rate counters, no session facts, and no project
 *   attribution (the project rides the pillar-5 usage ledger instead). So
 *   project attribution here is RECONSTRUCTED from `usage_events` by
 *   (user, server, tool) inside the same window — good enough to name the
 *   projects in a blast radius, and honestly flagged as best-effort whenever the
 *   candidate policy actually reads a project-derived attribute.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  configVersions,
  abacPolicies,
  abacPolicyVersions,
  and,
  auditLog,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  mcpTools,
  policySimulationFlips,
  policySimulationSettings,
  policySimulations,
  projects,
  sql,
  teamMembers,
  usageEvents,
  users,
  type Db,
  type PolicySimulationRow,
  type PolicySimulationSettingsRow,
} from "@regulait/db";
import { abacEngine, type AbacPolicy, type AbacRequest } from "@regulait/policy-kernel/abac";
import {
  ABAC_CANNOT_GRANT_NOTE,
  POLICY_SIMULATION_DEFAULT_ROW_CAP,
  POLICY_SIMULATION_DEFAULT_WINDOW_DAYS,
  REPLAY_FIDELITY_DISCLOSURE,
  UNREPLAYABLE_ATTRIBUTES,
  analyzeReplayFidelity,
  classifyReplay,
  isFlip,
  policySimulationSettingsSchema,
  resolvePolicySimulationScope,
  startPolicySimulationSchema,
  summarizeBlastRadius,
  type CandidateEffect,
  type PolicySimulationScopeDecision,
  type RecordedEffect,
  type ReplayedDecision,
} from "@regulait/shared";
import { assembleAbacRequest } from "./abac.js";
import { loadComplianceProfileCanaryDivergence } from "./config-versions.js";
import { governedEvaluate } from "./governed-evaluate.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const SINGLETON = "singleton";

/** how many flipped calls are persisted as the drill-down sample */
const SAMPLE_LIMIT = 50;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function loadPolicySimulationSettings(db: Db): Promise<PolicySimulationSettingsRow> {
  const [row] = await db
    .select()
    .from(policySimulationSettings)
    .where(eq(policySimulationSettings.id, SINGLETON));
  if (row) return row;
  const [created] = await db
    .insert(policySimulationSettings)
    .values({ id: SINGLETON })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [again] = await db
    .select()
    .from(policySimulationSettings)
    .where(eq(policySimulationSettings.id, SINGLETON));
  return again!;
}

/**
 * ADR-0040's honest-risks note made operable: has this EXACT version ever been
 * previewed? Called by the ABAC activate route, which records the answer on the
 * activation audit row either way and refuses only when the deployment has
 * switched the friction on.
 */
export async function versionHasBlastRadiusPreview(
  db: Db,
  policyVersionId: string,
): Promise<{ previewed: boolean; latest: PolicySimulationRow | null }> {
  const [row] = await db
    .select()
    .from(policySimulations)
    .where(eq(policySimulations.policyVersionId, policyVersionId))
    .orderBy(desc(policySimulations.createdAt))
    .limit(1);
  return { previewed: Boolean(row), latest: row ?? null };
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** every user the caller can see: their teammates, plus themselves. The SAME
 * membership relation enforcement's `loadScopeMemberships` reads, so a preview
 * can never see further than the caller's own team boundary. */
export async function visibleSubjectsFor(db: Db, callerUserId: string): Promise<string[]> {
  const teams = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, callerUserId));
  if (teams.length === 0) return [callerUserId];
  const peers = await db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(
      inArray(
        teamMembers.teamId,
        teams.map((t) => t.teamId),
      ),
    );
  return [...new Set([callerUserId, ...peers.map((p) => p.userId)])];
}

// ---------------------------------------------------------------------------
// The dry run
// ---------------------------------------------------------------------------

export interface PolicySimulationOptions {
  policyVersionId: string;
  windowDays: number;
  rowCap: number;
  scope: PolicySimulationScopeDecision;
  requestedByUserId: string | null;
  note?: string | null | undefined;
  /** pins the window end; tests and a future async runner supply it */
  now?: Date;
}

export type PolicySimulationOutcome =
  | { ok: true; simulation: PolicySimulationRow; flips: number }
  | { ok: false; status: number; error: string; detail?: string };

function candidateEffectOf(decision: { effect: string }): CandidateEffect {
  if (decision.effect === "forbid") return "forbid";
  if (decision.effect === "require_approval") return "require_approval";
  return "permit";
}

/**
 * RUN THE DRY RUN. Reads recorded decisions, re-decides each under the
 * candidate version alone, folds them into a named blast radius, and writes the
 * preview plus one audit row. It executes NOTHING.
 */
/**
 * THE RECORDED TRANSCRIPT — every governed MCP tool decision in the window that
 * names a server and a tool. Shared by both candidate kinds (ADR-0120) so the
 * two previews are always reading the SAME evidence; a candidate that appeared
 * to flip fewer calls because it replayed a different transcript would be worse
 * than no preview at all.
 */
export async function loadReplayTranscript(
  db: Db,
  args: { windowStart: Date; now: Date; rowCap: number; scoped: string[] | null },
): Promise<{
  capped: boolean;
  considered: Array<{
    id: string;
    at: Date;
    userId: string;
    serverId: string | null;
    toolName: string | null;
    effect: string;
  }>;
}> {
  const rows = await db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      userId: auditLog.userId,
      serverId: auditLog.serverId,
      toolName: auditLog.toolName,
      effect: auditLog.effect,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.objectType, "mcp_tool"),
        isNotNull(auditLog.serverId),
        isNotNull(auditLog.toolName),
        gte(auditLog.at, args.windowStart),
        lte(auditLog.at, args.now),
        args.scoped ? inArray(auditLog.userId, args.scoped) : undefined,
      ),
    )
    .orderBy(desc(auditLog.at))
    .limit(args.rowCap + 1);
  const capped = rows.length > args.rowCap;
  return { capped, considered: capped ? rows.slice(0, args.rowCap) : rows };
}

export interface RuleSimulationOptions {
  /** a `config_versions` row id — the proposed approval rule or rate limit */
  ruleVersionId: string;
  windowDays: number;
  rowCap: number;
  scope: PolicySimulationScopeDecision;
  requestedByUserId: string | null;
  note?: string | null | undefined;
  now?: Date;
}

/** Decision.effect (the kernel's vocabulary) -> the replay vocabulary. */
function candidateEffectOfDecision(effect: string): CandidateEffect {
  if (effect === "deny") return "forbid";
  if (effect === "require_approval") return "require_approval";
  return "permit";
}

/**
 * ADR-0120 — THE DRY RUN FOR A PROPOSED APPROVAL RULE OR RATE LIMIT.
 *
 * Same transcript, same blast-radius vocabulary and same storage as the ABAC
 * preview; the only difference is WHAT is re-decided. Each recorded decision is
 * replayed through `governedEvaluate` in `simulate` mode, which forces the named
 * version as the candidate and returns what it would have decided — so the
 * preview is computed by the gate itself rather than by a copy of it.
 *
 * `data_scope_rule` is REFUSED rather than approximated: evaluating one needs
 * the call's arguments, and the MCP decision transcript records counts only by
 * design (§8.4). A number produced without the inputs is a guess, and a guess on
 * a compliance surface is worse than an honest refusal.
 */
export async function runRuleSimulation(
  db: Db,
  opts: RuleSimulationOptions,
): Promise<PolicySimulationOutcome> {
  const [version] = await db
    .select()
    .from(configVersions)
    .where(eq(configVersions.id, opts.ruleVersionId));
  if (!version) return { ok: false, status: 404, error: "unknown_rule_version" };
  if (version.artifactType !== "approval_rule" && version.artifactType !== "rate_limit") {
    return {
      ok: false,
      status: 422,
      error: "artifact_not_simulable",
      detail:
        `'${version.artifactType}' cannot be replayed against the recorded transcript. A data-scope ` +
        `rule is evaluated against the call's ARGUMENTS, and governed tool decisions record counts ` +
        `only — never the arguments themselves — so any answer here would be a guess rather than a ` +
        `preview. Nothing was simulated and nothing was stored.`,
    };
  }

  const scoped = opts.scope.userIds;
  if (scoped && scoped.length === 0) {
    return { ok: false, status: 403, error: "empty_simulation_scope" };
  }

  const now = opts.now ?? new Date();
  const windowStart = new Date(now.getTime() - opts.windowDays * 24 * 60 * 60 * 1000);
  const { capped, considered } = await loadReplayTranscript(db, {
    windowStart,
    now,
    rowCap: opts.rowCap,
    scoped,
  });

  const subjectIds = [...new Set(considered.map((r) => r.userId))];
  const userRows = subjectIds.length
    ? await db
        .select({ id: users.id, email: users.email, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, subjectIds))
    : [];
  const userLabel = new Map(userRows.map((u) => [u.id, u.displayName || u.email]));

  const serverIds = [...new Set(considered.map((r) => r.serverId!).filter(Boolean))];
  const toolRows = serverIds.length
    ? await db
        .select({ serverId: mcpTools.serverId, name: mcpTools.name, kind: mcpTools.kind })
        .from(mcpTools)
        .where(inArray(mcpTools.serverId, serverIds))
    : [];
  const toolKind = new Map(toolRows.map((t) => [`${t.serverId}|${t.name}`, t.kind]));

  const replayed: ReplayedDecision[] = [];
  for (const row of considered) {
    const serverId = row.serverId!;
    const toolName = row.toolName!;
    const kind = toolKind.get(`${serverId}|${toolName}`);
    let candidate: CandidateEffect = null;
    let ruleId: string | null = null;
    if (kind) {
      // A tool that has left the inventory cannot have its call rebuilt, so
      // that row stays INDETERMINATE rather than being guessed at.
      const evaluation = await governedEvaluate(
        db,
        row.userId,
        serverId,
        { serverId, name: toolName, kind },
        undefined,
        null,
        null,
        undefined,
        { versionId: version.id },
      );
      if (evaluation.candidateDecision) {
        candidate = candidateEffectOfDecision(evaluation.candidateDecision.effect);
        ruleId = evaluation.candidateDecision.ruleId ?? null;
      }
    }
    replayed.push({
      auditLogId: row.id,
      userId: row.userId,
      userLabel: userLabel.get(row.userId) ?? null,
      projectId: null,
      projectName: null,
      serverId,
      toolName,
      recorded: row.effect as RecordedEffect,
      candidate,
      bucket: classifyReplay({ recorded: row.effect as RecordedEffect, candidate }),
      // policy_id is an abac_policies reference and NOTHING else. A rule
      // candidate has no policy, and the kernel's rule id is not a uuid in
      // general — writing it here is what made this path 500 on any transcript
      // containing a decision the kernel reached without a stored row.
      policyId: null,
      decisionRuleId: ruleId,
      occurredAt: row.at.toISOString(),
    });
  }

  const radius = summarizeBlastRadius(replayed, {
    sampleLimit: SAMPLE_LIMIT,
    windowDays: opts.windowDays,
  });

  const [simulation] = await db
    .insert(policySimulations)
    .values({
      policyId: null,
      policyVersionId: null,
      candidateArtifactType: version.artifactType,
      candidateVersionId: version.id,
      policyName: `${version.artifactType} ${version.artifactId}`,
      policyVersion: version.version,
      requestedByUserId: opts.requestedByUserId,
      scopeUserIds: opts.scope.userIds,
      scopeRuleId: opts.scope.ruleId,
      windowDays: opts.windowDays,
      windowStart,
      windowEnd: now,
      rowCap: opts.rowCap,
      capped,
      considered: radius.considered,
      newlyDenied: radius.buckets.newly_denied,
      newlyApprovalRequired: radius.buckets.newly_approval_required,
      newlyAllowed: radius.buckets.newly_allowed,
      unchanged: radius.buckets.unchanged,
      indeterminate: radius.buckets.indeterminate,
      affectedUsers: radius.affectedUsers.length,
      affectedProjects: radius.affectedProjects.length,
      affectedTools: radius.affectedTools.length,
      blastRadius: {
        buckets: radius.buckets,
        affectedUsers: radius.affectedUsers,
        affectedProjects: radius.affectedProjects,
        affectedTools: radius.affectedTools,
        samples: radius.samples,
      },
      headline: radius.headline,
      note: opts.note ?? null,
    })
    .returning();

  // The sampled flips — "which calls, exactly" must be answerable for a rule
  // candidate for the same reason it is for an ABAC one.
  const samples = replayed.filter((r) => isFlip(r.bucket)).slice(0, SAMPLE_LIMIT);
  if (samples.length > 0) {
    await db.insert(policySimulationFlips).values(
      samples.map((sm) => ({
        simulationId: simulation!.id,
        auditLogId: sm.auditLogId,
        userId: sm.userId,
        userLabel: sm.userLabel ?? null,
        projectId: null,
        projectName: null,
        serverId: sm.serverId,
        toolName: sm.toolName,
        recordedEffect: sm.recorded,
        simulatedEffect: sm.candidate ?? "indeterminate",
        bucket: sm.bucket,
        policyId: sm.policyId ?? null,
        decisionRuleId: sm.decisionRuleId ?? null,
        occurredAt: new Date(sm.occurredAt),
      })),
    );
  }

  await db.insert(auditLog).values({
    userId: opts.requestedByUserId ?? "00000000-0000-0000-0000-000000000000",
    // ADR-0027's existing vocabulary: an approval rule and a rate limit are
    // both pillar-1 RESTRICTION RULES, so no new objectType is minted for a
    // preview of one. The ABAC preview audits as `abac_policy` for the same
    // reason — the candidate's own kind, not the simulation machinery's.
    objectType: "restriction_rule",
    objectId: simulation!.id,
    detail: {
      candidateArtifactType: version.artifactType,
      candidateVersionId: version.id,
      considered: radius.considered,
      buckets: radius.buckets,
      windowDays: opts.windowDays,
      capped,
    },
    effect: "allow",
    ruleId: "policy-simulation-run",
    ruleChain: [],
    reason:
      `dry run of ${version.artifactType} version ${version.version}: ` +
      `${radius.considered} recorded decisions replayed, ` +
      `${radius.buckets.newly_denied} newly denied, ` +
      `${radius.buckets.newly_approval_required} newly requiring approval, ` +
      `${radius.buckets.newly_allowed} newly allowed. Nothing was executed.`,
  });

  const flips =
    radius.buckets.newly_denied +
    radius.buckets.newly_approval_required +
    radius.buckets.newly_allowed;
  return { ok: true, simulation: simulation!, flips };
}

export async function runPolicySimulation(
  db: Db,
  opts: PolicySimulationOptions,
): Promise<PolicySimulationOutcome> {
  const [version] = await db
    .select()
    .from(abacPolicyVersions)
    .where(eq(abacPolicyVersions.id, opts.policyVersionId));
  if (!version) return { ok: false, status: 404, error: "unknown_policy_version" };
  const [policy] = await db
    .select()
    .from(abacPolicies)
    .where(eq(abacPolicies.id, version.policyId));

  // THE CANDIDATE. Assembled in memory from the immutable version row and never
  // written anywhere — `abac_policies.active_version_id` is not touched by any
  // code path in this file.
  const candidate: AbacPolicy = {
    id: version.policyId,
    name: policy?.name ?? "candidate",
    source: version.source,
    mode: version.mode,
    timezone: version.timezone,
    schemaVersion: version.schemaVersion,
    version: version.version,
    approverUserId: version.approverUserId,
    description: policy?.description ?? null,
  };
  const fidelity = analyzeReplayFidelity(version.source);

  const now = opts.now ?? new Date();
  const windowStart = new Date(now.getTime() - opts.windowDays * 24 * 60 * 60 * 1000);

  // The recorded transcript: every governed MCP tool DECISION in the window
  // that names a server and a tool. `audit_log` is append-only and FK-free by
  // design, which is exactly what makes it replayable — and what makes this
  // tool work unchanged in an air-gapped install (§8.5): it reads only local
  // rows, with no dependency on a hosted control plane.
  const scoped = opts.scope.userIds;
  if (scoped && scoped.length === 0) {
    return { ok: false, status: 403, error: "empty_simulation_scope" };
  }
  const { capped, considered } = await loadReplayTranscript(db, {
    windowStart,
    now,
    rowCap: opts.rowCap,
    scoped,
  });

  // Names for the blast radius. A preview that reports opaque uuids is not a
  // preview anyone can act on.
  const subjectIds = [...new Set(considered.map((r) => r.userId))];
  const userRows = subjectIds.length
    ? await db
        .select({ id: users.id, email: users.email, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, subjectIds))
    : [];
  const userLabel = new Map(userRows.map((u) => [u.id, u.displayName || u.email]));

  // PROJECT ATTRIBUTION IS RECONSTRUCTED, NOT RECORDED. `audit_log` carries no
  // project column (its FK-free, deletion-surviving shape is deliberate — see
  // schema.ts), so the pillar-5 usage ledger is what knows which project paid
  // for a call. Keyed by (user, server, tool) inside the same window, which is
  // exact whenever a user drives one tool from one project and best-effort
  // otherwise — flagged by `analyzeReplayFidelity` if the candidate actually
  // reads a project-derived attribute.
  const usage = await db
    .select({
      userId: usageEvents.userId,
      projectId: usageEvents.projectId,
      operation: usageEvents.operation,
      serverId: sql<string | null>`${usageEvents.detail} ->> 'serverId'`,
      n: sql<number>`count(*)::int`,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.objectType, "mcp_tool"),
        gte(usageEvents.at, windowStart),
        lte(usageEvents.at, now),
        isNotNull(usageEvents.projectId),
        scoped ? inArray(usageEvents.userId, scoped) : undefined,
      ),
    )
    .groupBy(usageEvents.userId, usageEvents.projectId, usageEvents.operation, sql`${usageEvents.detail} ->> 'serverId'`);
  const projectByCall = new Map<string, { projectId: string; n: number }>();
  for (const u of usage) {
    if (!u.projectId || !u.serverId || !u.operation) continue;
    const key = `${u.userId}|${u.serverId}|${u.operation}`;
    const prev = projectByCall.get(key);
    if (!prev || u.n > prev.n) projectByCall.set(key, { projectId: u.projectId, n: u.n });
  }
  const projectIds = [...new Set([...projectByCall.values()].map((v) => v.projectId))];
  const projectRows = projectIds.length
    ? await db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(inArray(projects.id, projectIds))
    : [];
  const projectName = new Map(projectRows.map((p) => [p.id, p.name]));

  // tool kinds, loaded once — a tool that has left the inventory cannot have
  // its resource bag rebuilt, and that row is INDETERMINATE rather than guessed
  const serverIds = [...new Set(considered.map((r) => r.serverId!).filter(Boolean))];
  const toolRows = serverIds.length
    ? await db
        .select({ serverId: mcpTools.serverId, name: mcpTools.name, kind: mcpTools.kind })
        .from(mcpTools)
        .where(inArray(mcpTools.serverId, serverIds))
    : [];
  const toolKind = new Map(toolRows.map((t) => [`${t.serverId}|${t.name}`, t.kind]));

  // ATTRIBUTE ASSEMBLY IS REUSED, NOT RE-IMPLEMENTED. `assembleAbacRequest` is
  // the very function enforcement calls — ADR-0024's discipline, so a preview
  // can never drift from what the gate actually does. Memoized per distinct
  // (user, server, tool, project) because replay repeats heavily and the
  // assembly is several queries.
  const requestCache = new Map<string, AbacRequest | null>();
  async function requestFor(
    userId: string,
    serverId: string,
    toolName: string,
    projectId: string | null,
  ): Promise<AbacRequest | null> {
    const key = `${userId}|${serverId}|${toolName}|${projectId ?? ""}`;
    if (requestCache.has(key)) return requestCache.get(key)!;
    const kind = toolKind.get(`${serverId}|${toolName}`);
    if (!kind) {
      requestCache.set(key, null);
      return null;
    }
    const req = await assembleAbacRequest(db, {
      userId,
      serverId,
      toolName,
      toolKind: kind,
      projectId,
    });
    requestCache.set(key, req);
    return req;
  }

  const replayed: ReplayedDecision[] = [];
  for (const row of considered) {
    const serverId = row.serverId!;
    const toolName = row.toolName!;
    const attributed = projectByCall.get(`${row.userId}|${serverId}|${toolName}`) ?? null;
    const projectId = attributed?.projectId ?? null;
    const base = await requestFor(row.userId, serverId, toolName, projectId);
    let candidateEffect: CandidateEffect = null;
    let policyId: string | null = null;
    if (base) {
      // EVALUATED AT THE INSTANT IT HAPPENED, so a time-of-day policy is
      // replayed against the clock the call actually ran under rather than
      // against today's.
      const decision = abacEngine.evaluate([candidate], { ...base, at: row.at });
      candidateEffect = candidateEffectOf(decision);
      policyId = decision.policyId ?? null;
    }
    const bucket = classifyReplay({
      recorded: row.effect as RecordedEffect,
      candidate: candidateEffect,
    });
    replayed.push({
      auditLogId: row.id,
      userId: row.userId,
      userLabel: userLabel.get(row.userId) ?? null,
      projectId,
      projectName: projectId ? (projectName.get(projectId) ?? null) : null,
      serverId,
      toolName,
      recorded: row.effect as RecordedEffect,
      candidate: candidateEffect,
      bucket,
      policyId,
      occurredAt: row.at.toISOString(),
    });
  }

  const radius = summarizeBlastRadius(replayed, {
    sampleLimit: SAMPLE_LIMIT,
    windowDays: opts.windowDays,
  });

  const [simulation] = await db
    .insert(policySimulations)
    .values({
      policyId: policy?.id ?? null,
      policyVersionId: version.id,
      policyName: candidate.name,
      policyVersion: version.version,
      requestedByUserId: opts.requestedByUserId,
      scopeUserIds: opts.scope.userIds,
      scopeRuleId: opts.scope.ruleId,
      windowDays: opts.windowDays,
      windowStart,
      windowEnd: now,
      rowCap: opts.rowCap,
      capped,
      considered: radius.considered,
      newlyDenied: radius.buckets.newly_denied,
      newlyApprovalRequired: radius.buckets.newly_approval_required,
      newlyAllowed: radius.buckets.newly_allowed,
      unchanged: radius.buckets.unchanged,
      indeterminate: radius.buckets.indeterminate,
      affectedUsers: radius.affectedUsers.length,
      affectedProjects: radius.affectedProjects.length,
      affectedTools: radius.affectedTools.length,
      blastRadius: {
        users: radius.affectedUsers,
        projects: radius.affectedProjects,
        tools: radius.affectedTools,
      },
      fidelityExact: fidelity.exact,
      fidelityCaveats: fidelity.caveats,
      headline: radius.headline,
      note: opts.note ?? null,
    })
    .returning();

  const samples = replayed.filter((r) => isFlip(r.bucket)).slice(0, SAMPLE_LIMIT);
  if (samples.length > 0) {
    await db.insert(policySimulationFlips).values(
      samples.map((s) => ({
        simulationId: simulation!.id,
        auditLogId: s.auditLogId,
        userId: s.userId,
        userLabel: s.userLabel ?? null,
        projectId: s.projectId ?? null,
        projectName: s.projectName ?? null,
        serverId: s.serverId,
        toolName: s.toolName,
        recordedEffect: s.recorded,
        simulatedEffect: s.candidate ?? "indeterminate",
        bucket: s.bucket,
        policyId: s.policyId ?? null,
        occurredAt: new Date(s.occurredAt),
      })),
    );
  }

  // THE ONE SIDE EFFECT. A preview reads other people's traffic, so who
  // previewed whose history under which scope is a record.
  await db.insert(auditLog).values({
    userId: opts.requestedByUserId ?? NIL_UUID,
    objectType: "abac_policy",
    objectId: policy?.id ?? null,
    detail: {
      phase: "blast-radius",
      simulationId: simulation!.id,
      policyName: candidate.name,
      policyVersion: version.version,
      policyVersionId: version.id,
      scopeRuleId: opts.scope.ruleId,
      scopeSubjects: opts.scope.userIds ? opts.scope.userIds.length : "org-wide",
      windowDays: opts.windowDays,
      considered: radius.considered,
      capped,
      newlyDenied: radius.buckets.newly_denied,
      newlyApprovalRequired: radius.buckets.newly_approval_required,
      indeterminate: radius.buckets.indeterminate,
      affectedUsers: radius.affectedUsers.length,
      fidelityExact: fidelity.exact,
      dryRun: true,
    },
    effect: "allow",
    ruleId: "policy-simulation-run",
    ruleChain: [],
    reason:
      `DRY RUN (nothing executed, nothing activated): blast radius previewed for '${candidate.name}' ` +
      `version ${version.version} — ${radius.headline}`,
  });

  return { ok: true, simulation: simulation!, flips: samples.length };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const idParam = z.object({ id: z.string().uuid() });

/**
 * B8b — ADR-0073 disclosure 8's consumer, finally wired. ADR-0059's shipped
 * preview has no artifact-level candidate slot (its amendment: "the candidate
 * is an ABAC policy version only"), so the honest close is a NAMED FIELD on
 * the preview response rather than a parallel preview surface: when a
 * compliance-profile candidate has RECORDED divergence observations, the
 * preview read-outs carry them — count, the diverged projects, both sides'
 * effects — read from the STORED observations only, never recomputed here.
 *
 * Three boundaries, each pinned by test:
 *  - no profile candidate, or none with recorded divergence → the field is
 *    ABSENT and the response is byte-identical to pre-B8b;
 *  - ADMIN-ONLY: profile divergence names projects org-wide, while the preview
 *    itself is entitlement-scoped — a non-admin's response never gains the
 *    field, however much divergence is stored;
 *  - read-only REPORTING: the preview gains information, never enforcement —
 *    nothing here feeds the stored simulation row, the buckets, or any gate.
 */
const PROFILE_CANARY_PREVIEW_NOTE =
  "Concurrent pending compliance-profile change(s) with RECORDED divergence (ADR-0073 shadow " +
  "canary, stored history): the named projects' §8.3 cascade would change if the candidate were " +
  "promoted. Read from stored config_canary_observations — never recomputed in this path — and " +
  "reporting only: nothing here enforces, and this field is absent entirely when no " +
  "compliance-profile candidate has recorded divergence.";

async function complianceProfileCanaryField(
  db: Db,
  isAdmin: boolean,
): Promise<Record<string, unknown>> {
  if (!isAdmin) return {};
  const canaries = await loadComplianceProfileCanaryDivergence(db);
  if (canaries.length === 0) return {};
  return { complianceProfileCanaryDivergence: { canaries, note: PROFILE_CANARY_PREVIEW_NOTE } };
}

export function registerPolicySimulationRoutes(app: FastifyInstance, db: Db): void {
  const refuse = (
    actorUserId: string | null,
    ruleId: string,
    reason: string,
    detail: Record<string, unknown>,
  ) =>
    db.insert(auditLog).values({
      userId: actorUserId ?? NIL_UUID,
      objectType: "abac_policy",
      objectId: null,
      detail: { phase: "blast-radius", refused: true, ...detail },
      effect: "deny",
      ruleId,
      ruleChain: [],
      reason,
    });

  /**
   * RUN A BLAST-RADIUS PREVIEW. Reachable by a non-admin (it is in
   * NON_ADMIN_ROUTES) and ENTITLEMENT-SCOPED inside, exactly as ADR-0047 made
   * report generation reachable-but-scoped: a team lead should be able to ask
   * "would this rule break my team", and must not be able to use the same
   * question to read another team's traffic.
   */
  app.post("/v1/policy-simulations", async (req, reply) => {
    const body = startPolicySimulationSchema.parse(req.body);
    const callerId = req.authCtx.userId ?? null;
    const visible = callerId ? await visibleSubjectsFor(db, callerId) : [];
    const scope = resolvePolicySimulationScope({
      isAdmin: req.authCtx.isAdmin,
      callerUserId: callerId,
      visibleUserIds: visible,
      requestedUserIds: body.userIds ?? null,
    });
    if (!scope.allowed) {
      // THE REFUSAL IS A RECORD. Repeated attempts to preview outside one's own
      // visibility are exactly the signal an operator needs.
      await refuse(callerId, scope.ruleId, scope.reason, {
        policyVersionId: body.policyVersionId ?? null,
        ruleVersionId: body.ruleVersionId ?? null,
        requestedUserIds: body.userIds?.length ?? 0,
      });
      return reply.status(403).send({ error: "simulation_scope_denied", detail: scope.reason });
    }
    // ADR-0120: the same surface, the same scope check and the same stored
    // shape for both candidate kinds — only the re-decision differs.
    const outcome = body.ruleVersionId
      ? await runRuleSimulation(db, {
          ruleVersionId: body.ruleVersionId,
          windowDays: body.windowDays,
          rowCap: body.rowCap,
          scope,
          requestedByUserId: callerId,
          note: body.note ?? null,
        })
      : await runPolicySimulation(db, {
          policyVersionId: body.policyVersionId!,
          windowDays: body.windowDays,
          rowCap: body.rowCap,
          scope,
          requestedByUserId: callerId,
          note: body.note ?? null,
        });
    if (!outcome.ok) {
      return reply
        .status(outcome.status)
        .send({ error: outcome.error, ...(outcome.detail ? { detail: outcome.detail } : {}) });
    }
    const flips = await db
      .select()
      .from(policySimulationFlips)
      .where(eq(policySimulationFlips.simulationId, outcome.simulation.id))
      .orderBy(desc(policySimulationFlips.occurredAt));
    return reply.status(201).send({
      simulation: outcome.simulation,
      /** the SPECIFIC calls that would flip — a preview names them */
      samples: flips,
      scope: { ruleId: scope.ruleId, reason: scope.reason, orgWide: scope.userIds === null },
      fidelity: REPLAY_FIDELITY_DISCLOSURE,
      abacCannotGrant: ABAC_CANNOT_GRANT_NOTE,
      dryRun: true,
      ...(await complianceProfileCanaryField(db, req.authCtx.isAdmin)),
    });
  });

  /**
   * ADR-0167 (AUTHZ-02): the LIST is scoped exactly as the detail route below
   * is. It used to return every stored row to any authenticated caller — the
   * named blast radius of an admin's org-wide preview included — so a plain
   * non-admin could read out of the archive, via the list, the very thing the
   * detail route refused them. Two rules now: a non-admin sees a run only when
   * they REQUESTED it or its stored scope lies entirely inside their own team
   * visibility; and the list is a SUMMARY (counts, headline, fidelity) — the
   * named users/projects/tools and the scope itself stay on the detail route,
   * where the scope check guards them.
   */
  app.get("/v1/policy-simulations", async (req, reply) => {
    const q = z
      .object({
        policyVersionId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    const callerId = req.authCtx.userId ?? null;
    if (!req.authCtx.isAdmin && !callerId) {
      return reply.status(403).send({ error: "simulation_scope_denied" });
    }
    // a non-admin's visible rows are filtered AFTER the read (the scope is
    // jsonb), so the window is widened and cut back to `limit` afterwards —
    // a narrow caller must not get a short page merely because wider runs
    // happen to be newer
    const window = req.authCtx.isAdmin ? q.limit : Math.min(q.limit * 4, 800);
    const rows = await db
      .select()
      .from(policySimulations)
      .where(q.policyVersionId ? eq(policySimulations.policyVersionId, q.policyVersionId) : undefined)
      .orderBy(desc(policySimulations.createdAt))
      .limit(window);
    let visibleRows = rows;
    if (!req.authCtx.isAdmin) {
      const visible = new Set(await visibleSubjectsFor(db, callerId!));
      visibleRows = rows
        .filter(
          (row) =>
            row.requestedByUserId === callerId ||
            (row.scopeUserIds !== null && (row.scopeUserIds ?? []).every((u) => visible.has(u))),
        )
        .slice(0, q.limit);
    }
    const summaries = visibleRows.map(({ blastRadius: _radius, scopeUserIds: _scope, ...summary }) => summary);
    return { simulations: summaries, fidelity: REPLAY_FIDELITY_DISCLOSURE };
  });

  app.get("/v1/policy-simulations/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db.select().from(policySimulations).where(eq(policySimulations.id, id));
    if (!row) return reply.status(404).send({ error: "unknown_simulation" });
    // A stored preview is readable only by someone whose visibility covers the
    // scope it was run under — a narrower caller must not read a wider run's
    // named users back out of the archive.
    if (!req.authCtx.isAdmin) {
      const callerId = req.authCtx.userId ?? null;
      if (!callerId) return reply.status(403).send({ error: "simulation_scope_denied" });
      const visible = new Set(await visibleSubjectsFor(db, callerId));
      const outside =
        row.scopeUserIds === null || (row.scopeUserIds ?? []).some((u) => !visible.has(u));
      if (outside) {
        await refuse(
          callerId,
          "policy-simulation-read-denied",
          "a caller without the preview's entitlement scope tried to read a stored blast radius",
          { simulationId: row.id },
        );
        return reply.status(403).send({ error: "simulation_scope_denied" });
      }
    }
    const flips = await db
      .select()
      .from(policySimulationFlips)
      .where(eq(policySimulationFlips.simulationId, row.id))
      .orderBy(desc(policySimulationFlips.occurredAt));
    return {
      simulation: row,
      samples: flips,
      fidelity: REPLAY_FIDELITY_DISCLOSURE,
      abacCannotGrant: ABAC_CANNOT_GRANT_NOTE,
      unreplayableAttributes: UNREPLAYABLE_ATTRIBUTES,
      ...(await complianceProfileCanaryField(db, req.authCtx.isAdmin)),
    };
  });

  /** the friction dial, and what it does when it is off (admin-only) */
  app.get("/v1/policy-simulations/settings", async () => {
    const row = await loadPolicySimulationSettings(db);
    return {
      settings: row,
      note:
        "When OFF (the default), activating a policy version that no blast-radius preview has ever examined " +
        "still succeeds — but the activation audit row permanently records that no preview existed. When ON, " +
        "that activation is refused. Either way the omission is legible; the dial decides whether it is also " +
        "blocking.",
      defaults: {
        windowDays: POLICY_SIMULATION_DEFAULT_WINDOW_DAYS,
        rowCap: POLICY_SIMULATION_DEFAULT_ROW_CAP,
      },
    };
  });

  app.put("/v1/policy-simulations/settings", async (req) => {
    const body = policySimulationSettingsSchema.parse(req.body ?? {});
    await loadPolicySimulationSettings(db);
    const [row] = await db
      .update(policySimulationSettings)
      .set({
        ...(body.requirePreviewBeforeActivate !== undefined
          ? { requirePreviewBeforeActivate: body.requirePreviewBeforeActivate }
          : {}),
        ...(body.defaultWindowDays !== undefined ? { defaultWindowDays: body.defaultWindowDays } : {}),
        ...(body.defaultRowCap !== undefined ? { defaultRowCap: body.defaultRowCap } : {}),
        updatedByUserId: req.authCtx.userId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(policySimulationSettings.id, SINGLETON))
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NIL_UUID,
      objectType: "abac_policy",
      objectId: null,
      detail: { phase: "blast-radius-settings", ...body },
      effect: "allow",
      ruleId: "policy-simulation-settings-changed",
      ruleChain: [],
      reason: row!.requirePreviewBeforeActivate
        ? "activating an ABAC policy version now REQUIRES a completed blast-radius preview of that exact version"
        : "activating an ABAC policy version no longer requires a blast-radius preview — the omission is still recorded on every activation",
    });
    return { settings: row };
  });
}
