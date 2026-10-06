/**
 * ADR-0040 — the GATEWAY half of ABAC / policy-as-code.
 *
 * Division of labour, and why it is drawn here:
 *
 *   `packages/policy-kernel/src/index.ts`  the pure evaluator. Receives an
 *                                          already-computed `AbacDecision` and
 *                                          composes it into the fixed rule
 *                                          order. Zero I/O, zero Cedar.
 *   `packages/policy-kernel/src/abac.ts`   the thin Cedar engine wrapper. Pure
 *                                          over its arguments; knows Cedar,
 *                                          knows nothing about the database.
 *   THIS FILE                              assembles the attribute bags from
 *                                          data the gateway already holds, and
 *                                          owns the admin surface.
 *
 * THE ATTRIBUTES ARE ASSEMBLED HERE ON PURPOSE. If the kernel looked an
 * attribute up it would stop being a pure function of its inputs, and the
 * "what would this decide?" simulation surface would stop being able to
 * reproduce a decision exactly. So the gateway resolves everything and hands
 * the kernel a value.
 *
 * SERVER-DERIVED MEANS SERVER-DERIVED. `environments` and `deployModes` come
 * from the attributed project's in-flight workflow instances → their deploy
 * targets (the same A4 derivation ADR-0027 already trusts). No request header,
 * query parameter or body field can reach the context bag — there is
 * deliberately no code path from `req` to these values. Time comes from the
 * server clock evaluated in the POLICY'S declared zone; a client clock is never
 * read at all.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  abacPolicies,
  abacPolicyVersions,
  and,
  asc,
  auditLog,
  deployTargets,
  desc,
  eq,
  inArray,
  mcpServers,
  mcpTools,
  projects,
  roleAssignments,
  roles,
  sql,
  teamMembers,
  teams,
  users,
  workflowInstances,
  type AbacPolicyTestCase,
  type Db,
} from "@regulait/db";
import {
  ABAC_CURRENT_SCHEMA_VERSION,
  ABAC_POLICY_MODES,
  ABAC_SCHEMA_VERSIONS,
  abacEngine,
  abacSchemaText,
  evaluateAbac,
  isValidTimezone,
  type AbacPolicy,
  type AbacRequest,
  type AbacResourceAttrs,
} from "@regulait/policy-kernel/abac";
import type { AbacDecision } from "@regulait/policy-kernel";
import { projectClassifications } from "./projects.js";
import type { AbacPrincipalContext } from "./abac-principal.js";
import { aiTrainingCurrentFor } from "./ai-literacy.js";
import {
  loadPolicySimulationSettings,
  versionHasBlastRadiusPreview,
} from "./policy-simulation.js";

export type { AbacPrincipalContext };

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** the workflow statuses under which attributed work still binds a deploy
 * target — mirrors governed-evaluate.ts's TERMINAL_INSTANCE_STATUSES exactly,
 * because the two derivations must never disagree about "in flight". */
const TERMINAL_INSTANCE_STATUSES = ["completed", "denied", "aborted", "rolled_back"];

// ---------------------------------------------------------------------------
// Loading the active policy set
// ---------------------------------------------------------------------------

/**
 * The active set: enabled policies whose pointer names a real version row.
 *
 * A policy that is disabled, or enabled but never activated, is simply absent —
 * there is no "inactive but still evaluated" state. An install with no ABAC
 * policies returns [], which is what makes the kernel input ABSENT and every
 * decision byte-identical to the pre-ADR-0040 behaviour.
 */
export async function loadActiveAbacPolicies(db: Db): Promise<AbacPolicy[]> {
  const rows = await db
    .select({
      id: abacPolicies.id,
      name: abacPolicies.name,
      description: abacPolicies.description,
      source: abacPolicyVersions.source,
      schemaVersion: abacPolicyVersions.schemaVersion,
      mode: abacPolicyVersions.mode,
      timezone: abacPolicyVersions.timezone,
      version: abacPolicyVersions.version,
      approverUserId: abacPolicyVersions.approverUserId,
    })
    .from(abacPolicies)
    .innerJoin(abacPolicyVersions, eq(abacPolicyVersions.id, abacPolicies.activeVersionId))
    .where(eq(abacPolicies.enabled, true))
    .orderBy(asc(abacPolicies.name));
  if (rows.length === 0) return [];

  // approver display names ride along for the kernel's reason prose only
  const approverIds = [...new Set(rows.map((r) => r.approverUserId).filter((x): x is string => !!x))];
  const approverRows = approverIds.length
    ? await db
        .select({ id: users.id, displayName: users.displayName, email: users.email })
        .from(users)
        .where(inArray(users.id, approverIds))
    : [];
  const approverName = new Map(approverRows.map((u) => [u.id, u.displayName || u.email]));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    source: r.source,
    mode: r.mode,
    timezone: r.timezone,
    schemaVersion: r.schemaVersion,
    version: r.version,
    approverUserId: r.approverUserId,
    approverName: r.approverUserId ? (approverName.get(r.approverUserId) ?? null) : null,
    description: r.description,
  }));
}

// ---------------------------------------------------------------------------
// Assembling the three attribute bags
// ---------------------------------------------------------------------------

export interface AbacToolContext {
  userId: string;
  serverId: string;
  toolName: string;
  toolKind: string;
  /** pillar-5 attribution; null = an unattributed call */
  projectId?: string | null;
  /** highest per-window rate-limit consumption at this call site, 0–100 */
  rateLimitUsagePct?: number;
  principal?: AbacPrincipalContext;
  /** schema v2 — carried inside `principal` by the route that knows the request;
   *  see the note in `abac-principal.ts` on why it lands in Cedar's CONTEXT bag */
  /** the instant to evaluate at; defaults to now. Tests and the simulation
   * surface pin it — the ENFORCEMENT path never accepts one from a client. */
  at?: Date;
}

/**
 * A4 (ADR-0027), widened: the SERVER-DERIVED deploy modes AND environments an
 * attributed call executes under. Both come from the same place — the deploy
 * targets the project's in-flight workflow instances name — so a policy about
 * `production` and a rule about `air_gapped` can never disagree about what this
 * call is. No project, or no in-flight work, derives empty sets, and a policy
 * that requires a known context then simply does not match.
 */
export async function deriveAbacDeployContext(
  db: Db,
  projectId: string | null | undefined,
): Promise<{ deployModes: string[]; environments: string[] }> {
  if (!projectId) return { deployModes: [], environments: [] };
  const instances = await db
    .select({ definition: workflowInstances.definition, status: workflowInstances.status })
    .from(workflowInstances)
    .where(eq(workflowInstances.projectId, projectId));
  const connections = new Set<string>();
  for (const inst of instances) {
    if (TERMINAL_INSTANCE_STATUSES.includes(inst.status)) continue;
    const stages = (inst.definition as { stages?: Array<{ type?: string; connection?: string }> })
      ?.stages;
    for (const stage of stages ?? []) {
      if ((stage.type === "deployment" || stage.type === "rollback") && stage.connection) {
        connections.add(stage.connection);
      }
    }
  }
  if (connections.size === 0) return { deployModes: [], environments: [] };
  const targets = await db
    .select({ mode: deployTargets.mode, environment: deployTargets.environment })
    .from(deployTargets)
    .where(inArray(deployTargets.name, [...connections]));
  return {
    deployModes: [...new Set(targets.map((t) => t.mode))],
    environments: [...new Set(targets.map((t) => t.environment).filter((e): e is string => !!e))],
  };
}

/** the coarse price tier the resource bag exposes — enough for "no expensive
 * tools out of hours" without leaking a figure into policy source */
function priceTierOf(pricePerCallUsd: number | null | undefined): string {
  if (pricePerCallUsd == null) return "unpriced";
  return pricePerCallUsd > 0 ? "metered" : "free";
}

/** Assemble the full request the Cedar engine evaluates. Exported for tests
 * and for the simulation surface, which must build it EXACTLY as enforcement
 * does or a preview would be a different question than the real one. */
export async function assembleAbacRequest(db: Db, ctx: AbacToolContext): Promise<AbacRequest> {
  const [userRow, assignments, memberships, serverRow, toolRow, projectRow, derived, aiTrainingCurrent] =
    await Promise.all([
      db
        .select({ id: users.id, isAdmin: users.isAdmin })
        .from(users)
        .where(eq(users.id, ctx.userId)),
      db
        .select({ roleId: roleAssignments.roleId, roleName: roles.name })
        .from(roleAssignments)
        .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
        .where(eq(roleAssignments.userId, ctx.userId)),
      db
        .select({ teamName: teams.name })
        .from(teamMembers)
        .innerJoin(teams, eq(teams.id, teamMembers.teamId))
        .where(eq(teamMembers.userId, ctx.userId)),
      db
        .select({ name: mcpServers.name, price: mcpServers.pricePerCallUsd })
        .from(mcpServers)
        .where(eq(mcpServers.id, ctx.serverId)),
      db
        .select({ price: mcpTools.pricePerCallUsd })
        .from(mcpTools)
        .where(and(eq(mcpTools.serverId, ctx.serverId), eq(mcpTools.name, ctx.toolName))),
      ctx.projectId
        ? db
            .select({ id: projects.id, name: projects.name })
            .from(projects)
            .where(eq(projects.id, ctx.projectId))
        : Promise.resolve([]),
      deriveAbacDeployContext(db, ctx.projectId),
      // schema v3 (ADR-0182 A14): from the stored AI policies and acknowledgements, here and only here, so the
      // simulation surface (which calls this same function) builds it exactly as enforcement does
      aiTrainingCurrentFor(db, ctx.userId),
    ]);

  const classifications = ctx.projectId ? await projectClassifications(db, ctx.projectId) : [];
  const resource: AbacResourceAttrs = {
    id: `${ctx.serverId}/${ctx.toolName}`,
    serverId: ctx.serverId,
    serverName: serverRow[0]?.name ?? "",
    toolName: ctx.toolName,
    kind: ctx.toolKind,
    priceTier: priceTierOf(toolRow[0]?.price ?? serverRow[0]?.price ?? null),
    projectId: projectRow[0]?.id ?? null,
    projectName: projectRow[0]?.name ?? null,
    classifications,
    // The §8.3 cascade's data-sensitivity signal is the project's compliance
    // classification set (ADR-0018 addendum names exactly this as the
    // server-authoritative source). Exposed as a single scalar too, because
    // most policies want "is this sensitive at all" rather than a set walk.
    dataSensitivity: classifications.length > 0 ? [...classifications].sort()[0]! : null,
  };

  return {
    principal: {
      id: ctx.userId,
      roles: [...new Set(assignments.map((a) => a.roleName))],
      roleIds: [...new Set(assignments.map((a) => a.roleId))],
      teams: [...new Set(memberships.map((m) => m.teamName))],
      isAdmin: userRow[0]?.isAdmin ?? false,
      sessionOrigin: ctx.principal?.sessionOrigin ?? "unknown",
      mfaCompleted: ctx.principal?.mfaCompleted ?? false,
      aiTrainingCurrent,
    },
    resource,
    context: {
      deployModes: derived.deployModes,
      environments: derived.environments,
      rateLimitUsagePct: ctx.rateLimitUsagePct ?? 0,
      // Schema v2. The engine drops it for a v1 policy group and for anything
      // that does not parse as a literal address, so passing it unconditionally
      // here is safe and keeps ONE place that decides.
      clientIp: ctx.principal?.clientIp ?? null,
    },
    ...(ctx.at ? { at: ctx.at } : {}),
  };
}

/**
 * The one function the enforcement path calls. Returns `null` when the
 * deployment has no active ABAC policies — the kernel then receives an ABSENT
 * input and behaves exactly as it did before ADR-0040, with no extra queries
 * beyond the single indexed policy-set load.
 */
export async function evaluateAbacForToolCall(
  db: Db,
  ctx: AbacToolContext,
  /** pre-loaded policy set, when the caller already has it */
  preloaded?: readonly AbacPolicy[],
): Promise<AbacDecision | null> {
  const policies = preloaded ?? (await loadActiveAbacPolicies(db));
  if (policies.length === 0) return null;
  const request = await assembleAbacRequest(db, ctx);
  return evaluateAbac(policies, request);
}

// ---------------------------------------------------------------------------
// Policy unit tests (ADR-0040 "Testable")
// ---------------------------------------------------------------------------

export interface AbacTestCaseResult {
  name: string;
  expected: "match" | "no_match";
  actual: "match" | "no_match";
  passed: boolean;
  /** the engine verdict, for a failing case's explanation */
  effect: string;
}

/**
 * Run a version's stored test cases against ITS OWN source, in isolation from
 * every other policy. Isolation is the point: a test says "this policy fires
 * for this request", and it must keep saying that regardless of what else the
 * org happens to have activated.
 */
export function runAbacPolicyTests(
  policy: AbacPolicy,
  cases: readonly AbacPolicyTestCase[],
): { passed: number; failed: number; results: AbacTestCaseResult[] } {
  const results = cases.map((c) => {
    const classifications = c.resource.classifications ?? [];
    const request: AbacRequest = {
      principal: {
        id: c.principal.id ?? NIL_UUID,
        roles: c.principal.roles ?? [],
        roleIds: c.principal.roleIds ?? [],
        teams: c.principal.teams ?? [],
        isAdmin: c.principal.isAdmin ?? false,
        sessionOrigin: c.principal.sessionOrigin ?? "unknown",
        mfaCompleted: c.principal.mfaCompleted ?? false,
        // schema v3 (ADR-0182 A14): a stored case may name it; absent = false, the strict answer
        aiTrainingCurrent: c.principal.aiTrainingCurrent ?? false,
      },
      resource: {
        id: `${c.resource.serverId ?? "server"}/${c.resource.toolName}`,
        serverId: c.resource.serverId ?? "server",
        serverName: c.resource.serverName ?? "",
        toolName: c.resource.toolName,
        kind: c.resource.kind,
        priceTier: c.resource.priceTier ?? "unpriced",
        projectId: c.resource.projectId ?? null,
        projectName: c.resource.projectName ?? null,
        classifications,
        dataSensitivity:
          c.resource.dataSensitivity ??
          (classifications.length > 0 ? [...classifications].sort()[0]! : null),
      },
      context: {
        deployModes: c.context?.deployModes ?? [],
        environments: c.context?.environments ?? [],
        rateLimitUsagePct: c.context?.rateLimitUsagePct ?? 0,
        // Schema v2. A TEST CASE may name an address, because previewing "what
        // does this network rule do to a call from 203.0.113.7" is the whole
        // point of the surface — and this path EXECUTES NOTHING (ADR-0120). It
        // is the one place a caller-supplied address is legitimate, for exactly
        // the reason the enforcement path's is not.
        clientIp: c.context?.clientIp ?? null,
      },
      ...(c.at ? { at: new Date(c.at) } : {}),
    };
    const d = abacEngine.evaluate([policy], request);
    const actual: "match" | "no_match" = d.effect === "permit" ? "no_match" : "match";
    return {
      name: c.name,
      expected: c.expect,
      actual,
      passed: actual === c.expect,
      effect: d.effect,
    };
  });
  return {
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    results,
  };
}

// ---------------------------------------------------------------------------
// Admin surface
// ---------------------------------------------------------------------------

const testCaseSchema: z.ZodType<AbacPolicyTestCase> = z.object({
  name: z.string().trim().min(1).max(200),
  at: z.string().datetime().nullish(),
  principal: z.object({
    id: z.string().nullish(),
    roles: z.array(z.string()).optional(),
    roleIds: z.array(z.string()).optional(),
    teams: z.array(z.string()).optional(),
    isAdmin: z.boolean().optional(),
    sessionOrigin: z.string().optional(),
    mfaCompleted: z.boolean().optional(),
    /** schema v3 (ADR-0182 A14) */
    aiTrainingCurrent: z.boolean().optional(),
  }),
  resource: z.object({
    serverId: z.string().nullish(),
    serverName: z.string().nullish(),
    toolName: z.string().min(1),
    kind: z.enum(["read", "write"]),
    priceTier: z.string().optional(),
    projectId: z.string().nullish(),
    projectName: z.string().nullish(),
    classifications: z.array(z.string()).optional(),
    dataSensitivity: z.string().nullish(),
  }),
  context: z
    .object({
      deployModes: z.array(z.string()).optional(),
      environments: z.array(z.string()).optional(),
      rateLimitUsagePct: z.number().int().min(0).max(100).optional(),
      /** schema v2 — a literal address to evaluate the case at. Unparseable
       *  values are dropped by the engine rather than rejected here, so a test
       *  case can deliberately exercise the "undeterminable" branch. */
      clientIp: z.string().max(45).nullish(),
    })
    .optional(),
  expect: z.enum(["match", "no_match"]),
}) as z.ZodType<AbacPolicyTestCase>;

const versionBodySchema = z.object({
  source: z.string().trim().min(1).max(20_000),
  mode: z.enum(ABAC_POLICY_MODES as unknown as [string, ...string[]]).default("forbid"),
  schemaVersion: z.string().default(ABAC_CURRENT_SCHEMA_VERSION),
  timezone: z.string().trim().min(1).max(64).default("UTC"),
  approverUserId: z.string().uuid().nullish(),
  testCases: z.array(testCaseSchema).max(100).optional(),
});

const createPolicySchema = versionBodySchema.extend({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullish(),
});

const simulateSchema = z.object({
  userId: z.string().uuid(),
  serverId: z.string().uuid(),
  toolName: z.string().min(1),
  projectId: z.string().uuid().nullish(),
  /** the hypothetical instant — a SIMULATION input only; enforcement never
   * accepts a caller-supplied clock */
  at: z.string().datetime().optional(),
  sessionOrigin: z.string().optional(),
  mfaCompleted: z.boolean().optional(),
});

export function registerAbacRoutes(app: FastifyInstance, db: Db): void {
  const audit = (
    actorUserId: string | null,
    objectId: string | null,
    ruleId: string,
    reason: string,
    detail: Record<string, unknown>,
  ) =>
    db.insert(auditLog).values({
      userId: actorUserId ?? NIL_UUID,
      objectType: "abac_policy",
      objectId,
      effect: "allow",
      ruleId,
      ruleChain: [],
      reason,
      detail: { phase: "abac-policy-admin", ...detail },
    });

  /** the versioned attribute schema, as readable Cedar, for the editor pane */
  app.get("/v1/abac/schema", async () => ({
    engine: abacEngine.engine,
    versions: ABAC_SCHEMA_VERSIONS,
    current: ABAC_CURRENT_SCHEMA_VERSION,
    modes: ABAC_POLICY_MODES,
    schemaText: abacSchemaText(ABAC_CURRENT_SCHEMA_VERSION),
    /** stated in the payload so the UI never has to infer it */
    abacCanGrant: false,
  }));

  /** dry-run the validator without storing anything */
  app.post("/v1/abac/validate", async (req) => {
    const body = z
      .object({
        source: z.string().min(1).max(20_000),
        schemaVersion: z.string().default(ABAC_CURRENT_SCHEMA_VERSION),
      })
      .parse(req.body);
    return abacEngine.validate(body.source, body.schemaVersion);
  });

  app.get("/v1/abac/policies", async () => {
    const rows = await db
      .select({
        id: abacPolicies.id,
        name: abacPolicies.name,
        description: abacPolicies.description,
        enabled: abacPolicies.enabled,
        activeVersionId: abacPolicies.activeVersionId,
        createdAt: abacPolicies.createdAt,
        activeVersion: abacPolicyVersions.version,
        mode: abacPolicyVersions.mode,
        timezone: abacPolicyVersions.timezone,
        schemaVersion: abacPolicyVersions.schemaVersion,
        source: abacPolicyVersions.source,
        approverUserId: abacPolicyVersions.approverUserId,
      })
      .from(abacPolicies)
      .leftJoin(abacPolicyVersions, eq(abacPolicyVersions.id, abacPolicies.activeVersionId))
      .orderBy(asc(abacPolicies.name));
    return {
      policies: rows,
      engine: abacEngine.engine,
      /** an empty/deactivated set is byte-identical to the pre-ADR-0040 kernel */
      activeCount: rows.filter((r) => r.enabled && r.activeVersionId).length,
    };
  });

  app.get("/v1/abac/policies/:policyId", async (req, reply) => {
    const { policyId } = z.object({ policyId: z.string().uuid() }).parse(req.params);
    const [policy] = await db.select().from(abacPolicies).where(eq(abacPolicies.id, policyId));
    if (!policy) return reply.status(404).send({ error: "unknown_policy" });
    const versions = await db
      .select()
      .from(abacPolicyVersions)
      .where(eq(abacPolicyVersions.policyId, policyId))
      .orderBy(desc(abacPolicyVersions.version));
    return { policy, versions };
  });

  /**
   * Create a policy AND its version 1. The source is validated against the
   * named schema version BEFORE anything is stored — a policy referencing an
   * undefined attribute never reaches the database, so it can never become a
   * silent runtime no-match.
   */
  app.post("/v1/abac/policies", async (req, reply) => {
    const body = createPolicySchema.parse(req.body);
    const validation = abacEngine.validate(body.source, body.schemaVersion, body.mode as never);
    if (!validation.ok) {
      return reply.status(422).send({ error: "invalid_policy", ...validation });
    }
    if (!isValidTimezone(body.timezone)) {
      return reply.status(422).send({
        error: "invalid_timezone",
        detail: `'${body.timezone}' is not an IANA timezone this deployment can resolve`,
      });
    }
    if (body.mode === "require_approval" && !body.approverUserId) {
      return reply.status(422).send({
        error: "approver_required",
        detail: "a require_approval policy must name the approver its paused calls route to",
      });
    }
    const [existing] = await db.select().from(abacPolicies).where(eq(abacPolicies.name, body.name));
    if (existing) return reply.status(409).send({ error: "policy_exists", policy: existing });

    const actor = req.authCtx.userId ?? null;
    const [policy] = await db
      .insert(abacPolicies)
      .values({ name: body.name, description: body.description ?? null, createdByUserId: actor })
      .returning();
    const [version] = await db
      .insert(abacPolicyVersions)
      .values({
        policyId: policy!.id,
        version: 1,
        source: body.source,
        schemaVersion: body.schemaVersion,
        mode: body.mode as "forbid" | "require_approval",
        timezone: body.timezone,
        approverUserId: body.approverUserId ?? null,
        testCases: body.testCases ?? null,
        authorUserId: actor,
      })
      .returning();
    await audit(actor, policy!.id, "abac-policy-created",
      `admin created ABAC policy '${body.name}' at version 1 — it is INACTIVE until a version is explicitly activated, and even then it can only deny or pause a call the RBAC layer already allowed`,
      { name: body.name, version: 1, mode: body.mode, schemaVersion: body.schemaVersion, timezone: body.timezone });
    return reply.status(201).send({ policy: policy!, version: version!, validation });
  });

  /**
   * A new VERSION. Never an in-place edit: the previous version row is
   * untouched, so "what did this say when that call was denied" stays
   * answerable and a rollback has something to roll back to.
   */
  app.post("/v1/abac/policies/:policyId/versions", async (req, reply) => {
    const { policyId } = z.object({ policyId: z.string().uuid() }).parse(req.params);
    const body = versionBodySchema.parse(req.body);
    const [policy] = await db.select().from(abacPolicies).where(eq(abacPolicies.id, policyId));
    if (!policy) return reply.status(404).send({ error: "unknown_policy" });
    const validation = abacEngine.validate(body.source, body.schemaVersion, body.mode as never);
    if (!validation.ok) return reply.status(422).send({ error: "invalid_policy", ...validation });
    if (!isValidTimezone(body.timezone)) {
      return reply.status(422).send({ error: "invalid_timezone" });
    }
    if (body.mode === "require_approval" && !body.approverUserId) {
      return reply.status(422).send({ error: "approver_required" });
    }
    const maxRows = await db
      .select({ max: sql<number>`coalesce(max(${abacPolicyVersions.version}), 0)` })
      .from(abacPolicyVersions)
      .where(eq(abacPolicyVersions.policyId, policyId));
    const nextVersion = Number(maxRows[0]?.max ?? 0) + 1;
    const actor = req.authCtx.userId ?? null;
    const [version] = await db
      .insert(abacPolicyVersions)
      .values({
        policyId,
        version: nextVersion,
        source: body.source,
        schemaVersion: body.schemaVersion,
        mode: body.mode as "forbid" | "require_approval",
        timezone: body.timezone,
        approverUserId: body.approverUserId ?? null,
        testCases: body.testCases ?? null,
        authorUserId: actor,
      })
      .returning();
    await audit(actor, policyId, "abac-policy-version-created",
      `admin added version ${nextVersion} of ABAC policy '${policy.name}' — the previously active version keeps enforcing until this one is explicitly activated`,
      { name: policy.name, version: nextVersion, mode: body.mode });
    return reply.status(201).send({ version: version!, validation });
  });

  /**
   * ACTIVATE a version — and therefore also ROLL BACK, because rolling back is
   * activating an older version. There is deliberately no separate rollback
   * verb: one audited operation, one shape, and the "rollback" is itself
   * revertible because nothing was destroyed.
   */
  app.post("/v1/abac/policies/:policyId/activate", async (req, reply) => {
    const { policyId } = z.object({ policyId: z.string().uuid() }).parse(req.params);
    const body = z.object({ version: z.number().int().positive() }).parse(req.body);
    const [policy] = await db.select().from(abacPolicies).where(eq(abacPolicies.id, policyId));
    if (!policy) return reply.status(404).send({ error: "unknown_policy" });
    const [target] = await db
      .select()
      .from(abacPolicyVersions)
      .where(
        and(eq(abacPolicyVersions.policyId, policyId), eq(abacPolicyVersions.version, body.version)),
      );
    if (!target) return reply.status(404).send({ error: "unknown_version" });

    // ADR-0059 / ADR-0040's honest-risks note: activating a policy that can deny
    // every governed call in the org must not be a one-click default. The
    // BLAST-RADIUS PREVIEW of this EXACT version is the friction. It is recorded
    // unconditionally — an un-previewed activation is permanently legible in the
    // audit row either way — and it BLOCKS only where the deployment has turned
    // the dial on, because refusing retroactively would break every install that
    // already has policies and no simulation history.
    const preview = await versionHasBlastRadiusPreview(db, target.id);
    if (!preview.previewed) {
      const settings = await loadPolicySimulationSettings(db);
      if (settings.requirePreviewBeforeActivate) {
        await audit(
          req.authCtx.userId ?? null,
          policyId,
          "abac-activation-refused-no-preview",
          `activation of '${policy.name}' version ${target.version} REFUSED: this deployment requires a blast-radius preview of the exact version being activated, and none exists`,
          { name: policy.name, version: target.version, versionId: target.id },
        );
        return reply.status(409).send({
          error: "blast_radius_not_previewed",
          detail:
            `no blast-radius preview exists for version ${target.version} of '${policy.name}'. ` +
            `POST /v1/policy-simulations with policyVersionId=${target.id} to see who this would newly ` +
            "block before it goes live.",
          policyVersionId: target.id,
        });
      }
    }

    const [previous] = policy.activeVersionId
      ? await db
          .select({ version: abacPolicyVersions.version })
          .from(abacPolicyVersions)
          .where(eq(abacPolicyVersions.id, policy.activeVersionId))
      : [];
    const rollingBack = previous != null && previous.version > target.version;

    await db
      .update(abacPolicies)
      .set({ activeVersionId: target.id, enabled: true })
      .where(eq(abacPolicies.id, policyId));
    await audit(req.authCtx.userId ?? null, policyId,
      rollingBack ? "abac-policy-rolled-back" : "abac-policy-activated",
      rollingBack
        ? `admin rolled ABAC policy '${policy.name}' back from version ${previous!.version} to version ${target.version} — version ${previous!.version} still exists and can be re-activated`
        : `admin activated version ${target.version} of ABAC policy '${policy.name}' — it now denies or pauses matching calls that the RBAC layer allows`,
      {
        name: policy.name,
        from: previous?.version ?? null,
        to: target.version,
        rollback: rollingBack,
        // ADR-0059: whether anyone previewed WHO this would newly block, before
        // it went live. Recorded on every activation, previewed or not — the
        // omission has to be as legible as the preview.
        blastRadiusPreviewed: preview.previewed,
        blastRadiusSimulationId: preview.latest?.id ?? null,
        ...(preview.latest
          ? {
              blastRadiusNewlyDenied: preview.latest.newlyDenied,
              blastRadiusNewlyApprovalRequired: preview.latest.newlyApprovalRequired,
              blastRadiusAffectedUsers: preview.latest.affectedUsers,
            }
          : {}),
      });
    return {
      policyId,
      activeVersion: target.version,
      enabled: true,
      rollback: rollingBack,
      blastRadiusPreviewed: preview.previewed,
      blastRadiusSimulationId: preview.latest?.id ?? null,
      ...(preview.previewed
        ? {}
        : {
            warning:
              "activated WITHOUT a blast-radius preview: nobody checked whose calls this newly blocks. " +
              "The omission is recorded on the activation audit row.",
          }),
    };
  });

  /** Take a policy OUT of the active set without deleting any history. */
  app.post("/v1/abac/policies/:policyId/deactivate", async (req, reply) => {
    const { policyId } = z.object({ policyId: z.string().uuid() }).parse(req.params);
    const [policy] = await db.select().from(abacPolicies).where(eq(abacPolicies.id, policyId));
    if (!policy) return reply.status(404).send({ error: "unknown_policy" });
    await db.update(abacPolicies).set({ enabled: false }).where(eq(abacPolicies.id, policyId));
    await audit(req.authCtx.userId ?? null, policyId, "abac-policy-deactivated",
      `admin deactivated ABAC policy '${policy.name}' — every version is retained and the policy can be re-activated unchanged`,
      { name: policy.name });
    return { policyId, enabled: false };
  });

  app.delete("/v1/abac/policies/:policyId", async (req, reply) => {
    const { policyId } = z.object({ policyId: z.string().uuid() }).parse(req.params);
    const [policy] = await db.select().from(abacPolicies).where(eq(abacPolicies.id, policyId));
    if (!policy) return reply.status(404).send({ error: "unknown_policy" });
    await db.delete(abacPolicies).where(eq(abacPolicies.id, policyId));
    await audit(req.authCtx.userId ?? null, policyId, "abac-policy-deleted",
      `admin deleted ABAC policy '${policy.name}' and all of its versions — past DECISIONS remain in the audit log, which is the record that matters`,
      { name: policy.name });
    return { removed: true };
  });

  /**
   * The policy unit-test runner (ADR-0040 "Testable"). Same code path CI runs,
   * so a red run here is a red run there.
   */
  app.post("/v1/abac/policies/:policyId/test", async (req, reply) => {
    const { policyId } = z.object({ policyId: z.string().uuid() }).parse(req.params);
    const body = z.object({ version: z.number().int().positive().optional() }).parse(req.body ?? {});
    const [policy] = await db.select().from(abacPolicies).where(eq(abacPolicies.id, policyId));
    if (!policy) return reply.status(404).send({ error: "unknown_policy" });
    const versionRows = await db
      .select()
      .from(abacPolicyVersions)
      .where(
        body.version
          ? and(
              eq(abacPolicyVersions.policyId, policyId),
              eq(abacPolicyVersions.version, body.version),
            )
          : eq(abacPolicyVersions.id, policy.activeVersionId ?? NIL_UUID),
      );
    const version = versionRows[0];
    if (!version) return reply.status(404).send({ error: "unknown_version" });
    const cases = version.testCases ?? [];
    const outcome = runAbacPolicyTests(
      {
        id: policy.id,
        name: policy.name,
        source: version.source,
        mode: version.mode,
        timezone: version.timezone,
        schemaVersion: version.schemaVersion,
        version: version.version,
        approverUserId: version.approverUserId,
        description: policy.description,
      },
      cases,
    );
    return { policyId, version: version.version, total: cases.length, ...outcome };
  });

  /** Run EVERY active policy's stored tests — the CI entry point. */
  app.post("/v1/abac/test", async () => {
    const policies = await loadActiveAbacPolicies(db);
    const versions = policies.length
      ? await db
          .select()
          .from(abacPolicyVersions)
          .where(inArray(abacPolicyVersions.policyId, policies.map((p) => p.id)))
      : [];
    const results = policies.map((p) => {
      const version = versions.find((v) => v.policyId === p.id && v.version === p.version);
      const outcome = runAbacPolicyTests(p, version?.testCases ?? []);
      return { policyId: p.id, name: p.name, version: p.version, ...outcome };
    });
    return {
      policies: results,
      passed: results.reduce((n, r) => n + r.passed, 0),
      failed: results.reduce((n, r) => n + r.failed, 0),
    };
  });

  /**
   * ADR-0040 "Simulatable" — the access-preview hook, extended to ABAC.
   *
   * Answers "what would the ABAC layer say about this hypothetical request?"
   * WITHOUT executing anything and without writing a queue entry. The full
   * dry-run-a-proposed-version-against-recorded-history surface is ADR-0059;
   * this is the hook it will build on.
   *
   * NOTE WHAT IS AND IS NOT ACCEPTED FROM THE CALLER. A hypothetical `at`
   * (instant) is accepted, because "what would happen at 23:00" is the whole
   * question. `environment` and `deployMode` are NOT accepted in any form —
   * they are derived from the named project exactly as enforcement derives
   * them, so a preview cannot be made to answer a question enforcement would
   * never ask.
   */
  app.post("/v1/abac/simulate", async (req, reply) => {
    const body = simulateSchema.parse(req.body);
    const [tool] = await db
      .select()
      .from(mcpTools)
      .where(and(eq(mcpTools.serverId, body.serverId), eq(mcpTools.name, body.toolName)));
    if (!tool) return reply.status(404).send({ error: "unknown_tool" });

    const policies = await loadActiveAbacPolicies(db);
    const request = await assembleAbacRequest(db, {
      userId: body.userId,
      serverId: body.serverId,
      toolName: body.toolName,
      toolKind: tool.kind,
      projectId: body.projectId ?? null,
      principal: {
        sessionOrigin: body.sessionOrigin ?? null,
        mfaCompleted: body.mfaCompleted ?? null,
      },
      ...(body.at ? { at: new Date(body.at) } : {}),
    });
    const decision = policies.length === 0 ? null : abacEngine.evaluate(policies, request);
    return {
      /** exactly the attributes enforcement would have evaluated */
      attributes: request,
      activePolicies: policies.map((p) => ({
        id: p.id, name: p.name, mode: p.mode, version: p.version, timezone: p.timezone,
      })),
      abacDecision: decision,
      /** said plainly: ABAC never grants, so a 'permit' here is not an allow */
      note:
        policies.length === 0
          ? "no active ABAC policies — the kernel receives no ABAC input and decides exactly as it did before ADR-0040"
          : "an ABAC 'permit' means 'nothing forbade this'; the RBAC grant check still decides whether the call is allowed at all",
    };
  });
}
