/**
 * ADR-0357 (lane E38): governance configuration as code. Slice 1a: the JSON Schema, export and the dry-run plan.
 *
 *   GET  /v1/governance-config/schema               the document's JSON Schema (editors, CI)
 *   GET  /v1/governance-config/export?format=yaml   the live configuration as a document (audited)
 *   POST /v1/governance-config/plan                 parse, validate, resolve names, diff, classify (audited; writes nothing)
 *
 * Admin only (the global admin preHandler: none of these is in NON_ADMIN_ROUTES). Secrets are never read here: the
 * reader touches only the role, rate-limit, bundle, template and project tables, never a credential table.
 * The document format, the normal form and the classification are `@regulait/shared` (governance-config.ts).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { CORE_SCHEMA, dump, load } from "js-yaml";
import { z } from "zod";
import {
  agents,
  and,
  auditLog,
  connectors,
  eq,
  inArray,
  isNotNull,
  mcpBundleGrants,
  mcpBundleVersionItems,
  mcpBundleVersions,
  mcpBundles,
  mcpServers,
  mcpTools,
  projects,
  rateLimits,
  roleAgentGrants,
  roleConnectorGrants,
  roleServerGrants,
  roleToolGrants,
  roles,
  teams,
  users,
  workflowTemplates,
  type Db,
} from "@regulait/db";
import {
  GOVERNANCE_CONFIG_LIMITS,
  duplicateKeys,
  governanceConfigJsonSchema,
  governanceConfigSchema,
  normalizeSpec,
  planGovernanceConfig,
  planWidenings,
  toGovernanceDocument,
  type GovernanceChange,
  type GovernancePlan,
  type NormalMcpBundle,
  type NormalRole,
  type NormalSpec,
} from "@regulait/shared";
import { validateBuilderDefinition } from "./workflow-builder.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------------------------------------------------------
// Reading the live configuration, by name
// ---------------------------------------------------------------------------------------------------------------

/** The whole live configuration in normal form. Reads no credential table. */
export async function readLiveGovernanceConfig(db: Db): Promise<Required<NormalSpec>> {
  const [roleRows, toolRows, serverRows, agentRows, connectorRows, limitRows, bundleRows, itemRows, bundleGrantRows, templateRows, budgetRows] =
    await Promise.all([
      db.select({ id: roles.id, name: roles.name, description: roles.description }).from(roles),
      db
        .select({ roleId: roleToolGrants.roleId, server: mcpServers.name, tool: roleToolGrants.toolName })
        .from(roleToolGrants)
        .innerJoin(mcpServers, eq(mcpServers.id, roleToolGrants.serverId)),
      db
        .select({ roleId: roleServerGrants.roleId, server: mcpServers.name, readOnlyAll: roleServerGrants.readOnlyAll })
        .from(roleServerGrants)
        .innerJoin(mcpServers, eq(mcpServers.id, roleServerGrants.serverId)),
      db
        .select({ roleId: roleAgentGrants.roleId, agent: agents.name, allowedModes: roleAgentGrants.allowedModes })
        .from(roleAgentGrants)
        .innerJoin(agents, eq(agents.id, roleAgentGrants.agentId)),
      db
        .select({
          roleId: roleConnectorGrants.roleId,
          connector: connectors.name,
          mode: roleConnectorGrants.mode,
          allowedObjects: roleConnectorGrants.allowedObjects,
        })
        .from(roleConnectorGrants)
        .innerJoin(connectors, eq(connectors.id, roleConnectorGrants.connectorId)),
      db
        .select({
          scope: rateLimits.scope,
          serverScope: rateLimits.serverScope,
          role: roles.name,
          team: teams.name,
          server: mcpServers.name,
          tool: rateLimits.toolName,
          deployMode: rateLimits.deployMode,
          maxCalls: rateLimits.maxCalls,
          windowSeconds: rateLimits.windowSeconds,
          writeOnly: rateLimits.writeOnly,
        })
        .from(rateLimits)
        .leftJoin(roles, eq(roles.id, rateLimits.roleId))
        .leftJoin(teams, eq(teams.id, rateLimits.teamId))
        .leftJoin(mcpServers, eq(mcpServers.id, rateLimits.serverId))
        .where(inArray(rateLimits.scope, ["role", "team", "fleet"])),
      db
        .select({
          id: mcpBundles.id,
          name: mcpBundles.name,
          description: mcpBundles.description,
          archivedAt: mcpBundles.archivedAt,
          approverUserId: mcpBundles.approverUserId,
        })
        .from(mcpBundles),
      // the CURRENT version's items; an item whose server was removed (server_id SET NULL) matches no call and is not exported
      db
        .select({ bundleId: mcpBundleVersions.bundleId, server: mcpServers.name, tool: mcpBundleVersionItems.toolName })
        .from(mcpBundleVersionItems)
        .innerJoin(mcpBundleVersions, eq(mcpBundleVersions.id, mcpBundleVersionItems.versionId))
        .innerJoin(mcpBundles, and(eq(mcpBundles.id, mcpBundleVersions.bundleId), eq(mcpBundles.currentVersion, mcpBundleVersions.version)))
        .innerJoin(mcpServers, eq(mcpServers.id, mcpBundleVersionItems.serverId)),
      // role and team grants only: a user grant is a per-user override (ADR-0357 §1)
      db
        .select({ bundleId: mcpBundleGrants.bundleId, role: roles.name, team: teams.name, maxTier: mcpBundleGrants.maxTier })
        .from(mcpBundleGrants)
        .leftJoin(roles, eq(roles.id, mcpBundleGrants.roleId))
        .leftJoin(teams, eq(teams.id, mcpBundleGrants.teamId)),
      db.select({ name: workflowTemplates.name, definition: workflowTemplates.definition, retiredAt: workflowTemplates.retiredAt }).from(workflowTemplates),
      db
        .select({
          project: projects.name,
          budgetUsd: projects.budgetUsd,
          period: projects.budgetPeriod,
          alertThresholdPct: projects.alertThresholdPct,
          approverUserId: projects.budgetApproverUserId,
        })
        .from(projects)
        .where(isNotNull(projects.budgetUsd)),
    ]);

  const byRole = <T extends { roleId: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.roleId, [...(m.get(r.roleId) ?? []), r]);
    return m;
  };
  const tools = byRole(toolRows);
  const servers = byRole(serverRows);
  const agentG = byRole(agentRows);
  const connG = byRole(connectorRows);
  const roleList: NormalRole[] = roleRows.map((r) => ({
    name: r.name,
    description: r.description,
    toolGrants: (tools.get(r.id) ?? []).map((g) => ({ server: g.server, tool: g.tool })),
    serverGrants: (servers.get(r.id) ?? []).map((g) => ({ server: g.server, readOnlyAll: g.readOnlyAll })),
    agentGrants: (agentG.get(r.id) ?? []).map((g) => ({ agent: g.agent, allowedModes: g.allowedModes ?? null })),
    connectorGrants: (connG.get(r.id) ?? []).map((g) => ({ connector: g.connector, mode: g.mode, allowedObjects: g.allowedObjects ?? null })),
  }));

  const bundles: NormalMcpBundle[] = bundleRows.map((b) => ({
    name: b.name,
    description: b.description,
    archived: b.archivedAt !== null,
    approverUserId: b.approverUserId,
    items: itemRows.filter((i) => i.bundleId === b.id).map((i) => ({ server: i.server, tool: i.tool })),
    grants: bundleGrantRows
      .filter((g) => g.bundleId === b.id && (g.role !== null || g.team !== null))
      .map((g) => ({ role: g.role, team: g.role === null ? g.team : null, maxTier: g.maxTier })),
  }));

  // normalizeSpec sorts and dedupes; feed it the shared schema's input shape
  const spec = normalizeSpec({
    roles: roleList.map((r) => ({ ...r })),
    rateLimits: limitRows
      // a role/team limit whose subject row is gone matches nothing; a `server` scope whose server is gone likewise
      .filter((r) => (r.scope === "role" ? r.role !== null : r.scope === "team" ? r.team !== null : true))
      .filter((r) => r.serverScope === "all" || r.server !== null)
      .map((r) => ({
        scope: r.scope as "role" | "team" | "fleet",
        ...(r.scope === "role" ? { subject: r.role! } : r.scope === "team" ? { subject: r.team! } : {}),
        ...(r.serverScope === "server" ? { server: r.server! } : {}),
        ...(r.tool !== null ? { tool: r.tool } : {}),
        ...(r.deployMode !== null ? { deployMode: r.deployMode } : {}),
        maxCalls: r.maxCalls,
        windowSeconds: r.windowSeconds,
        writeOnly: r.writeOnly,
      })),
    mcpBundles: bundles.map((b) => ({
      name: b.name,
      description: b.description,
      archived: b.archived,
      approverUserId: b.approverUserId,
      items: b.items,
      grants: b.grants.map((g) => (g.role !== null ? { role: g.role, maxTier: g.maxTier } : { team: g.team!, maxTier: g.maxTier })),
    })),
    workflowTemplates: templateRows.map((t) => ({
      name: t.name,
      definition: (t.definition ?? {}) as Record<string, unknown>,
      retired: t.retiredAt !== null,
    })),
    budgets: budgetRows.map((b) => ({
      project: b.project,
      budgetUsd: b.budgetUsd!,
      period: b.period === "monthly" ? "monthly" : "none",
      alertThresholdPct: b.alertThresholdPct,
      approverUserId: b.approverUserId,
    })),
  });
  return {
    roles: spec.roles ?? [],
    rateLimits: spec.rateLimits ?? [],
    mcpBundles: spec.mcpBundles ?? [],
    workflowTemplates: spec.workflowTemplates ?? [],
    budgets: spec.budgets ?? [],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Parsing a submitted document
// ---------------------------------------------------------------------------------------------------------------

export class GovernanceDocumentError extends Error {
  constructor(
    readonly code: "too_large" | "unparseable" | "anchors_refused" | "invalid_document" | "duplicate_keys",
    message: string,
    readonly issues: unknown[] = [],
  ) {
    super(message);
  }
}

class AnchorRefused extends Error {}

/**
 * YAML or JSON text (JSON is YAML) into a validated document. js-yaml's CORE_SCHEMA (no custom tags), duplicate
 * mapping keys refused (js-yaml's default), and anchors refused outright: an alias shares one node many times, so a
 * small file could expand into an exponential walk for the validator (the "billion laughs" shape). A governance file
 * has no need for them.
 */
export function parseGovernanceDocument(content: string) {
  if (Buffer.byteLength(content, "utf8") > GOVERNANCE_CONFIG_LIMITS.documentBytes) {
    throw new GovernanceDocumentError("too_large", `the document is larger than ${GOVERNANCE_CONFIG_LIMITS.documentBytes} bytes`);
  }
  let raw: unknown;
  try {
    raw = load(content, {
      // js-yaml 4.3 also caps nesting at depth 100 by default
      schema: CORE_SCHEMA,
      listener(event, state) {
        if (event === "close" && (state as unknown as { anchor: string | null }).anchor !== null) throw new AnchorRefused();
      },
    });
  } catch (e) {
    if (e instanceof AnchorRefused) throw new GovernanceDocumentError("anchors_refused", "YAML anchors and aliases are not accepted in a governance document");
    throw new GovernanceDocumentError("unparseable", `the document is not valid YAML or JSON: ${(e as Error).message.split("\n")[0]}`);
  }
  const parsed = governanceConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GovernanceDocumentError(
      "invalid_document",
      "the document does not match the governance-config schema",
      parsed.error.issues.slice(0, 100).map((i) => ({ path: i.path.map(String), message: i.message })),
    );
  }
  const dups = duplicateKeys(parsed.data.spec);
  if (dups.length) throw new GovernanceDocumentError("duplicate_keys", "a section names the same object twice", dups);
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------------------------
// Reference checks: every name a change introduces must exist (or be created by the same file)
// ---------------------------------------------------------------------------------------------------------------

export interface PlanIssue {
  section: string;
  key: string;
  code:
    | "unknown_server"
    | "unknown_tool"
    | "unknown_agent"
    | "unknown_connector"
    | "unknown_role"
    | "unknown_team"
    | "unknown_project"
    | "unknown_user"
    | "budget_approver_required"
    | "invalid_workflow_definition";
  detail: string;
}

/** Checks only what a create or update brings in (an unchanged object is as valid as it already is live). */
export async function referenceIssues(db: Db, plan: GovernancePlan, desired: NormalSpec): Promise<PlanIssue[]> {
  const touched = plan.changes.filter((c) => c.op !== "delete");
  const want = { servers: new Set<string>(), tools: new Set<string>(), agents: new Set<string>(), connectors: new Set<string>(), roles: new Set<string>(), teams: new Set<string>(), projects: new Set<string>(), users: new Set<string>() };
  for (const c of touched) {
    const a = c.after as Record<string, unknown>;
    if (c.section === "roles") {
      const r = a as unknown as NormalRole;
      r.toolGrants.forEach((g) => (want.servers.add(g.server), want.tools.add(`${g.server}\u0000${g.tool}`)));
      r.serverGrants.forEach((g) => want.servers.add(g.server));
      r.agentGrants.forEach((g) => want.agents.add(g.agent));
      r.connectorGrants.forEach((g) => want.connectors.add(g.connector));
    } else if (c.section === "rateLimits") {
      if (a.server) want.servers.add(a.server as string);
      if (a.scope === "role") want.roles.add(a.subject as string);
      if (a.scope === "team") want.teams.add(a.subject as string);
    } else if (c.section === "mcpBundles") {
      const b = a as unknown as NormalMcpBundle;
      b.items.forEach((i) => (want.servers.add(i.server), want.tools.add(`${i.server}\u0000${i.tool}`)));
      b.grants.forEach((g) => (g.role !== null ? want.roles.add(g.role) : want.teams.add(g.team!)));
      if (b.approverUserId) want.users.add(b.approverUserId);
    } else if (c.section === "budgets") {
      want.projects.add(a.project as string);
      if (a.approverUserId) want.users.add(a.approverUserId as string);
    }
  }
  const names = async <T extends { name: string }>(set: Set<string>, q: (xs: string[]) => Promise<T[]>) =>
    set.size ? new Set((await q([...set])).map((r) => r.name)) : new Set<string>();
  const [hasServer, hasAgent, hasConnector, hasRole, hasTeam, hasProject] = await Promise.all([
    names(want.servers, (xs) => db.select({ name: mcpServers.name }).from(mcpServers).where(inArray(mcpServers.name, xs))),
    names(want.agents, (xs) => db.select({ name: agents.name }).from(agents).where(inArray(agents.name, xs))),
    names(want.connectors, (xs) => db.select({ name: connectors.name }).from(connectors).where(inArray(connectors.name, xs))),
    names(want.roles, (xs) => db.select({ name: roles.name }).from(roles).where(inArray(roles.name, xs))),
    names(want.teams, (xs) => db.select({ name: teams.name }).from(teams).where(inArray(teams.name, xs))),
    names(want.projects, (xs) => db.select({ name: projects.name }).from(projects).where(inArray(projects.name, xs))),
  ]);
  const toolRows = want.tools.size
    ? await db
        .select({ server: mcpServers.name, tool: mcpTools.name })
        .from(mcpTools)
        .innerJoin(mcpServers, eq(mcpServers.id, mcpTools.serverId))
        .where(inArray(mcpServers.name, [...new Set([...want.tools].map((t) => t.split("\u0000")[0]!))]))
    : [];
  const hasTool = new Set(toolRows.map((t) => `${t.server}\u0000${t.tool}`));
  const userRows = want.users.size ? await db.select({ id: users.id }).from(users).where(inArray(users.id, [...want.users])) : [];
  const hasUser = new Set(userRows.map((u) => u.id));
  // a role created by the same file is a valid reference for its limits and bundle grants
  for (const r of desired.roles ?? []) hasRole.add(r.name);

  const out: PlanIssue[] = [];
  const miss = (c: GovernanceChange, code: PlanIssue["code"], detail: string) => out.push({ section: c.section, key: c.key, code, detail });
  for (const c of touched) {
    const a = c.after as Record<string, unknown>;
    const server = (s: string) => hasServer.has(s) || (miss(c, "unknown_server", `no MCP server named ${s}`), false);
    const tool = (s: string, t: string) => !server(s) || hasTool.has(`${s}\u0000${t}`) || miss(c, "unknown_tool", `server ${s} has no tool named ${t}`);
    if (c.section === "roles") {
      const r = a as unknown as NormalRole;
      r.toolGrants.forEach((g) => tool(g.server, g.tool));
      r.serverGrants.forEach((g) => server(g.server));
      r.agentGrants.forEach((g) => hasAgent.has(g.agent) || miss(c, "unknown_agent", `no agent named ${g.agent}`));
      r.connectorGrants.forEach((g) => hasConnector.has(g.connector) || miss(c, "unknown_connector", `no connector named ${g.connector}`));
    } else if (c.section === "rateLimits") {
      if (a.server) server(a.server as string);
      if (a.scope === "role" && !hasRole.has(a.subject as string)) miss(c, "unknown_role", `no role named ${a.subject}`);
      if (a.scope === "team" && !hasTeam.has(a.subject as string)) miss(c, "unknown_team", `no team named ${a.subject}`);
    } else if (c.section === "mcpBundles") {
      const b = a as unknown as NormalMcpBundle;
      b.items.forEach((i) => tool(i.server, i.tool));
      b.grants.forEach((g) =>
        g.role !== null
          ? hasRole.has(g.role) || miss(c, "unknown_role", `no role named ${g.role}`)
          : hasTeam.has(g.team!) || miss(c, "unknown_team", `no team named ${g.team}`),
      );
      if (b.approverUserId && !hasUser.has(b.approverUserId)) miss(c, "unknown_user", `no user ${b.approverUserId}`);
    } else if (c.section === "budgets") {
      if (!hasProject.has(a.project as string)) miss(c, "unknown_project", `no project named ${a.project}`);
      if (!a.approverUserId) miss(c, "budget_approver_required", "a budget names who approves an overage");
      else if (!hasUser.has(a.approverUserId as string)) miss(c, "unknown_user", `no user ${a.approverUserId}`);
    } else if (c.section === "workflowTemplates") {
      const v = await validateBuilderDefinition(db, a.definition);
      if (!v.valid) for (const i of v.issues.slice(0, 20)) miss(c, "invalid_workflow_definition", `${i.code}: ${i.message}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The dry run, as apply (slice 1b) will run it again under its lock
// ---------------------------------------------------------------------------------------------------------------

export interface GovernancePlanResult {
  plan: GovernancePlan;
  issues: PlanIssue[];
  /** true when apply could write this plan (no issues); widenings still need the relaxation step-up */
  applicable: boolean;
  widenings: ReturnType<typeof planWidenings>;
}

export async function planGovernanceDocument(db: Db, content: string): Promise<GovernancePlanResult> {
  const doc = parseGovernanceDocument(content);
  const desired = normalizeSpec(doc.spec);
  const plan = planGovernanceConfig(await readLiveGovernanceConfig(db), desired);
  const issues = await referenceIssues(db, plan, desired);
  return { plan, issues, applicable: issues.length === 0, widenings: planWidenings(plan) };
}

// ---------------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------------

const exportQuerySchema = z.object({ format: z.enum(["yaml", "json"]).default("yaml") }).strict();
const planBodySchema = z
  .object({
    /** the document as YAML or JSON text (what a Git checkout holds) */
    content: z.string().min(1).optional(),
    /** or the document as a JSON value */
    document: z.unknown().optional(),
  })
  .strict()
  .refine((b) => (b.content === undefined) !== (b.document === undefined), { message: "send exactly one of content or document" });

export function registerGovernanceConfigRoutes(app: FastifyInstance, db: Db): void {
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? NIL_USER;
  const audit = (req: FastifyRequest, ruleId: string, effect: "allow" | "deny", reason: string, detail: Record<string, unknown>) =>
    db.insert(auditLog).values({ userId: actor(req), objectType: "governance_config", objectId: null, detail, effect, ruleId, ruleChain: [], reason });

  app.get("/v1/governance-config/schema", async (_req, reply) => reply.send(governanceConfigJsonSchema()));

  app.get("/v1/governance-config/export", async (req, reply) => {
    const q = exportQuerySchema.safeParse(req.query);
    if (!q.success) return reply.status(400).send({ error: "invalid_query", issues: q.error.issues });
    const doc = toGovernanceDocument(await readLiveGovernanceConfig(db), new Date().toISOString());
    const counts = Object.fromEntries(Object.entries(doc.spec).map(([k, v]) => [k, (v as unknown[]).length]));
    await audit(req, "governance_config.export", "allow", "governance configuration exported", { revision: doc.metadata?.revision, format: q.data.format, counts });
    if (q.data.format === "json") return reply.header("content-type", "application/json; charset=utf-8").send(doc);
    return reply
      .header("content-type", "application/yaml; charset=utf-8")
      .send(dump(doc, { schema: CORE_SCHEMA, noRefs: true, lineWidth: 120, sortKeys: false }));
  });

  app.post("/v1/governance-config/plan", { bodyLimit: GOVERNANCE_CONFIG_LIMITS.documentBytes + 64 * 1024 }, async (req, reply) => {
    const body = planBodySchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: "invalid_body", issues: body.error.issues });
    const content = body.data.content ?? JSON.stringify(body.data.document);
    let result: GovernancePlanResult;
    try {
      result = await planGovernanceDocument(db, content);
    } catch (e) {
      if (!(e instanceof GovernanceDocumentError)) throw e;
      await audit(req, "governance_config.plan", "deny", e.message, { error: e.code });
      return reply.status(e.code === "too_large" ? 413 : 400).send({ error: e.code, message: e.message, issues: e.issues });
    }
    await audit(req, "governance_config.plan", "allow", "governance configuration planned (dry run)", {
      planHash: result.plan.planHash,
      liveRevision: result.plan.liveRevision,
      desiredRevision: result.plan.desiredRevision,
      sections: result.plan.sections,
      summary: result.plan.summary,
      issues: result.issues.length,
    });
    return reply.send(result);
  });
}
