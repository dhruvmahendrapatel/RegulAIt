/**
 * ADR-0172 — THE AGENT BUILDER API (`/v1/builder/*`).
 *
 * Every route is for a SIGNED-IN PERSON (non-admin; owner/sharing checks
 * in-handler). An identity-less token is refused with 403
 * `builder_requires_identity`: a builder agent runs with its user's
 * entitlements, and a token with no user has none to lend it. The one admin
 * route is the manual schedule sweep, which runs every due schedule as each
 * agent's OWNER, never as the caller.
 *
 *  - visibility: owner, everyone (sharing=workspace), listed people
 *    (sharing=people), admins. Edit: owner or admin.
 *  - tools: only what the EDITOR holds a grant for (403 tool_not_entitled),
 *    re-checked for the person at run time (`entitledForYou`).
 *  - chat: the governed core as the caller (see builder-runtime.ts).
 *  - audit: `builder-agent-*` / `builder-skill-*` rows on every change.
 *  - ADR-0175 A6: every skill save (create, SKILL.md import, update, template
 *    seed, bundle import) is scanned by the ADR-0097 admission rules — high
 *    refuses (422 `skill_admission_refused`), medium holds — and carries a
 *    content digest and version. A held skill cannot be attached; widening a
 *    skill's visibility beyond private waits for an admin.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  agents,
  approvals,
  and,
  asc,
  auditLog,
  builderAgentChannels,
  builderAgentMemory,
  builderAgentSchedules,
  builderAgentShares,
  builderAgentSkills,
  builderAgentSubagents,
  builderAgentTools,
  builderAgents,
  builderMessages,
  builderSkills,
  builderThreads,
  builderToolSteps,
  chatopsConnections,
  connectors,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  mcpServers,
  mcpTools,
  or,
  projectMembers,
  projects,
  sql,
  users,
  type BuilderAgentRow,
  type BuilderScheduleRow,
  type BuilderSkillRow,
  type BuilderThreadRow,
  type BuilderToolStepRow,
  type Db,
} from "@regulait/db";
import {
  BUILDER_AGENT_COLORS,
  BUILDER_LIMITS,
  builderAddMemorySchema,
  builderChatSchema,
  builderColorFor,
  builderConfirmStepSchema,
  builderCreateAgentSchema,
  builderCreateChannelSchema,
  builderCreateScheduleSchema,
  builderCreateSkillSchema,
  builderImportAgentSchema,
  builderImportSkillSchema,
  builderSetSkillsSchema,
  builderSetSubagentsSchema,
  builderSetToolsSchema,
  builderThreadListQuerySchema,
  builderUpdateAgentSchema,
  builderUpdateScheduleSchema,
  builderUpdateSkillSchema,
  builderUpdateThreadSchema,
  builderUsageQuerySchema,
  nextScheduleRun,
  parseSkillMarkdown,
  type BuilderBundle,
  type BuilderCadenceValue,
} from "@regulait/shared";
import type { AgentRow } from "./agents-connectors.js";
import {
  canEditAgent,
  canSeeAgent,
  defaultModelFor,
  entitledConnectorIds,
  entitledMcpToolIds,
  grantedMcpServerIds,
  listVisibleAgents,
  loadConnectorsById,
  loadMcpTools,
  loadVisibleAgent,
  modelAllowed,
  skillVisible,
  toolboxOptionsFor,
  type Viewer,
} from "./builder-access.js";
import { BUILDER_INTEGRATION_GROUPS, BUILDER_TEMPLATES, CONNECT_HREF, findTemplate } from "./builder-catalog.js";
import {
  configuredPrompt,
  messageView,
  monthStartUtc,
  pinnedSkillsForRun,
  promptTooLarge,
  cancelBuilderStep,
  resumeBuilderStep,
  settleLapsedApprovalPause,
  runBuilderScheduleSweep,
  runBuilderTurn,
  stepView,
  threadSteps,
  type TurnPending,
} from "./builder-runtime.js";
import { loadVirtualKeyContext } from "./virtual-keys.js";
import {
  admissionColumns,
  admitSkillText,
  auditSkillAdmission,
  ensureSkillScanned,
  pinnedBodyWithheld,
  pinnedFrom,
  sightSkill,
  skillAttachRefusal,
  skillDigest,
  skillRefusalBody,
} from "./skill-admission.js";
import { minReleaseAgeDays, skillReleaseStatus } from "./release-age.js";
import { skillNameProblem, type McpAdmissionFinding } from "@regulait/shared";

/** ADR-0175 review fix: a skill name is a prompt heading — no line breaks,
 * control or invisible formatting characters (422 `skill_name_invalid`) */
function skillNameRefusal(name: string): { error: string; detail: string } | null {
  const problem = skillNameProblem(name);
  return problem ? { error: "skill_name_invalid", detail: problem } : null;
}

export interface BuilderRouteOptions {
  dataKey?: string | undefined;
}

const idParam = z.object({ id: z.string().uuid() });
const memoryParam = z.object({ id: z.string().uuid(), memoryId: z.string().uuid() });
const scheduleParam = z.object({ id: z.string().uuid(), scheduleId: z.string().uuid() });
const channelParam = z.object({ id: z.string().uuid(), channelId: z.string().uuid() });
const skillParam = z.object({ id: z.string().uuid(), skillId: z.string().uuid() });
const templateParam = z.object({ id: z.string().min(1).max(80) });
const stepParam = z.object({ id: z.string().uuid(), stepId: z.string().uuid() });

/** palette colours only (shared BUILDER_AGENT_COLORS): white initials keep AA */
function colorFor(name: string): string {
  return builderColorFor(name);
}
/** owner rule (2026-10-04): the named refusal for an agent with no project */
const PROJECT_REQUIRED = {
  error: "project_required",
  detail: "every agent bills its spend to a project; choose one you are a member of",
} as const;

/**
 * May `viewer` bill an agent's spend to `projectId`? Attribution is a member's
 * act: the project must exist and the viewer must belong to it (or be an
 * admin). null when allowed, else the status and body to send.
 */
async function projectRefusal(
  db: Db,
  viewer: Viewer,
  projectId: string | null | undefined,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  if (!projectId) return { status: 422, body: { ...PROJECT_REQUIRED } };
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
  if (!project) return { status: 404, body: { error: "unknown_project" } };
  if (viewer.isAdmin) return null;
  const [member] = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, viewer.userId)));
  return member
    ? null
    : {
        status: 403,
        body: { error: "not_a_project_member", detail: "you can only bill an agent's spend to a project you are a member of" },
      };
}

/** a bundle may carry any #rrggbb from elsewhere; off-palette falls back */
function paletteOr(color: string | undefined, name: string): string {
  const c = color?.toLowerCase();
  return c && (BUILDER_AGENT_COLORS as readonly string[]).includes(c) ? c : builderColorFor(name);
}

/** the identity gate shared by every builder route */
function viewerOf(req: FastifyRequest, reply: FastifyReply): Viewer | null {
  const userId = req.authCtx.userId;
  if (!userId) {
    void reply.status(403).send({
      error: "builder_requires_identity",
      detail:
        "A builder agent runs with the entitlements of the person using it. A token with no user identity has " +
        "none to lend it.",
    });
    return null;
  }
  return { userId, isAdmin: req.authCtx.isAdmin };
}

async function audit(
  db: Db,
  userId: string,
  objectType: "builder_agent" | "builder_skill",
  objectId: string,
  ruleId: string,
  reason: string,
  detail: Record<string, unknown> = {},
  effect: "allow" | "deny" = "allow",
) {
  await db.insert(auditLog).values({ userId, objectType, objectId, detail, effect, ruleId, ruleChain: [], reason });
}

async function userNames(db: Db, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (!uniq.length) return new Map();
  const rows = await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, uniq));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

async function summaries(db: Db, rows: BuilderAgentRow[], viewer: Viewer) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const since = monthStartUtc();
  const modelIds = [...new Set(rows.map((r) => r.modelAgentId).filter((x): x is string => !!x))];
  const [models, names, spend, toolSpend, toolCounts, skillCounts, scheduleCounts] = await Promise.all([
    modelIds.length
      ? db
          .select({ id: agents.id, name: agents.name, provider: agents.provider, model: agents.model })
          .from(agents)
          .where(inArray(agents.id, modelIds))
      : Promise.resolve([]),
    userNames(db, rows.map((r) => r.ownerUserId)),
    db
      .select({ agentId: builderMessages.agentId, total: sql<number>`coalesce(sum(${builderMessages.costUsd}), 0)::float8` })
      .from(builderMessages)
      .where(and(inArray(builderMessages.agentId, ids), gte(builderMessages.createdAt, since)))
      .groupBy(builderMessages.agentId),
    // ADR-0173: governed tool calls count toward the agent's spend too
    db
      .select({ agentId: builderToolSteps.agentId, total: sql<number>`coalesce(sum(${builderToolSteps.costUsd}), 0)::float8` })
      .from(builderToolSteps)
      .where(and(inArray(builderToolSteps.agentId, ids), gte(builderToolSteps.createdAt, since)))
      .groupBy(builderToolSteps.agentId),
    db
      .select({ agentId: builderAgentTools.agentId, n: count() })
      .from(builderAgentTools)
      .where(inArray(builderAgentTools.agentId, ids))
      .groupBy(builderAgentTools.agentId),
    db
      .select({ agentId: builderAgentSkills.agentId, n: count() })
      .from(builderAgentSkills)
      .innerJoin(builderSkills, eq(builderAgentSkills.skillId, builderSkills.id))
      .where(and(inArray(builderAgentSkills.agentId, ids), isNull(builderSkills.archivedAt)))
      .groupBy(builderAgentSkills.agentId),
    db
      .select({ agentId: builderAgentSchedules.agentId, n: count() })
      .from(builderAgentSchedules)
      .where(inArray(builderAgentSchedules.agentId, ids))
      .groupBy(builderAgentSchedules.agentId),
  ]);
  const modelById = new Map(models.map((m) => [m.id, m]));
  const by = <T extends { agentId: string }>(list: T[]) => new Map(list.map((x) => [x.agentId, x]));
  const spendBy = by(spend);
  const toolSpendBy = by(toolSpend);
  const toolsBy = by(toolCounts);
  const skillsBy = by(skillCounts);
  const schedBy = by(scheduleCounts);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    color: r.color,
    ownerUserId: r.ownerUserId,
    ownerName: names.get(r.ownerUserId) ?? null,
    sharing: r.sharing,
    modelAgent: r.modelAgentId ? (modelById.get(r.modelAgentId) ?? null) : null,
    templateId: r.templateId,
    monthlyLimitUsd: r.monthlyLimitUsd,
    spentThisMonthUsd: Number((Number(spendBy.get(r.id)?.total ?? 0) + Number(toolSpendBy.get(r.id)?.total ?? 0)).toFixed(6)),
    toolCount: Number(toolsBy.get(r.id)?.n ?? 0),
    skillCount: Number(skillsBy.get(r.id)?.n ?? 0),
    scheduleCount: Number(schedBy.get(r.id)?.n ?? 0),
    updatedAt: r.updatedAt.toISOString(),
    canEdit: canEditAgent(r, viewer),
  }));
}

function scheduleView(s: BuilderScheduleRow, ownerUserId: string, names: Map<string, string> = new Map()) {
  const lastEditor = s.updatedByUserId ?? s.createdByUserId;
  return {
    id: s.id,
    name: s.name,
    cadence: s.cadence,
    timeUtc: s.timeUtc,
    prompt: s.prompt,
    enabled: s.enabled,
    /** someone other than the owner wrote or changed it: it stays off until
     * the OWNER turns it on (it would run, and spend, as them) */
    awaitingOwner: !s.enabled && !!lastEditor && lastEditor !== ownerUserId,
    lastEditedByName: lastEditor ? (names.get(lastEditor) ?? null) : null,
    nextRunAt: s.nextRunAt ? s.nextRunAt.toISOString() : null,
    lastRunAt: s.lastRunAt ? s.lastRunAt.toISOString() : null,
  };
}

/** email channels ride the Outlook ChatOps connection (ADR-0121) */
const chatopsProviderFor = (provider: string) => (provider === "email" ? "outlook" : provider);

async function toolViews(db: Db, agentId: string, viewer: Viewer) {
  const tools = await db
    .select()
    .from(builderAgentTools)
    .where(eq(builderAgentTools.agentId, agentId))
    .orderBy(asc(builderAgentTools.createdAt));
  const connectorRows = await loadConnectorsById(db, tools.filter((t) => t.kind === "connector").map((t) => t.refId));
  const mcpRows = await loadMcpTools(db, tools.filter((t) => t.kind === "mcp_tool").map((t) => t.refId));
  const [okConnectors, okTools] = await Promise.all([
    entitledConnectorIds(db, viewer.userId),
    entitledMcpToolIds(db, viewer.userId, mcpRows),
  ]);
  return tools.map((t) => {
    if (t.kind === "connector") {
      const c = connectorRows.find((r) => r.id === t.refId);
      return {
        kind: t.kind,
        refId: t.refId,
        name: c?.name ?? "Unavailable connector",
        provider: c ? (c.providerKind ?? c.kind) : null,
        requiresApproval: t.requiresApproval,
        entitledForYou: !!c && okConnectors.has(c.id),
      };
    }
    const m = mcpRows.find((r) => r.id === t.refId);
    return {
      kind: t.kind,
      refId: t.refId,
      name: m ? m.name : "Unavailable tool",
      provider: m?.serverName ?? null,
      requiresApproval: t.requiresApproval,
      entitledForYou: !!m && okTools.has(m.id),
    };
  });
}

async function agentDetail(db: Db, agent: BuilderAgentRow, viewer: Viewer) {
  const [summary] = await summaries(db, [agent], viewer);
  const [shares, tools, subs, skills, memory, schedules, channels, project, owner] = await Promise.all([
    db.select({ userId: builderAgentShares.userId }).from(builderAgentShares).where(eq(builderAgentShares.agentId, agent.id)),
    toolViews(db, agent.id, viewer),
    db
      .select({
        childId: builderAgentSubagents.childId,
        name: builderAgentSubagents.name,
        description: builderAgentSubagents.description,
        child: builderAgents,
      })
      .from(builderAgentSubagents)
      .innerJoin(builderAgents, eq(builderAgentSubagents.childId, builderAgents.id))
      .where(and(eq(builderAgentSubagents.parentId, agent.id), isNull(builderAgents.archivedAt)))
      .orderBy(asc(builderAgentSubagents.position)),
    db
      .select({
        skill: builderSkills,
        skillUpdatedAt: builderAgentSkills.skillUpdatedAt,
        skillId: builderAgentSkills.skillId,
        snapshotName: builderAgentSkills.snapshotName,
        snapshotDigest: builderAgentSkills.snapshotDigest,
        snapshotVersion: builderAgentSkills.snapshotVersion,
        snapshotAdmissionState: builderAgentSkills.snapshotAdmissionState,
      })
      .from(builderAgentSkills)
      .innerJoin(builderSkills, eq(builderAgentSkills.skillId, builderSkills.id))
      .where(and(eq(builderAgentSkills.agentId, agent.id), isNull(builderSkills.archivedAt)))
      .orderBy(asc(builderSkills.name)),
    db
      .select()
      .from(builderAgentMemory)
      .where(eq(builderAgentMemory.agentId, agent.id))
      .orderBy(desc(builderAgentMemory.createdAt))
      .limit(50),
    db
      .select()
      .from(builderAgentSchedules)
      .where(eq(builderAgentSchedules.agentId, agent.id))
      .orderBy(asc(builderAgentSchedules.createdAt)),
    db
      .select({
        id: builderAgentChannels.id,
        provider: builderAgentChannels.provider,
        connectionId: chatopsConnections.id,
        connectionName: chatopsConnections.name,
        connectionProvider: chatopsConnections.provider,
        connectionEnabled: chatopsConnections.enabled,
      })
      .from(builderAgentChannels)
      .leftJoin(chatopsConnections, eq(builderAgentChannels.chatopsConnectionId, chatopsConnections.id))
      .where(eq(builderAgentChannels.agentId, agent.id))
      .orderBy(asc(builderAgentChannels.createdAt)),
    agent.projectId
      ? db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.id, agent.projectId))
      : Promise.resolve([]),
    db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, agent.ownerUserId)),
  ]);
  // a sub-agent's NAME is shown only to someone who may see that agent
  const childIds = subs.map((x) => x.childId);
  const sharedChildren = childIds.length
    ? new Set(
        (
          await db
            .select({ agentId: builderAgentShares.agentId })
            .from(builderAgentShares)
            .where(and(inArray(builderAgentShares.agentId, childIds), eq(builderAgentShares.userId, viewer.userId)))
        ).map((r) => r.agentId),
      )
    : new Set<string>();
  const ownerViewer: Viewer = { userId: agent.ownerUserId, isAdmin: !!owner[0]?.isAdmin };
  // ADR-0175: a pinned body the scanner holds (or the cooldown quarantines)
  // is kept out of the prompt — say so beside the skill
  const minDays = skills.length ? await minReleaseAgeDays(db) : 0;
  const withheld = await Promise.all(skills.map((k) => pinnedBodyWithheld(db, k, minDays)));
  const names = await userNames(db, [
    ...shares.map((s) => s.userId),
    ...memory.map((m) => m.createdByUserId),
    ...schedules.map((x) => x.updatedByUserId ?? x.createdByUserId),
  ]);
  return {
    ...summary!,
    instructions: agent.instructions,
    connectionFormat: agent.connectionFormat,
    computerUse: agent.computerUse,
    project: project[0] ?? null,
    sharedUserIds: shares.map((s) => s.userId),
    sharedUsers: shares.map((s) => ({ id: s.userId, name: names.get(s.userId) ?? null })),
    tools,
    subagents: subs.map((x) => ({
      childId: x.childId,
      name: x.name,
      description: x.description,
      childName: canSeeAgent(x.child, viewer, sharedChildren.has(x.childId)) ? x.child.name : PRIVATE_AGENT_NAME,
    })),
    skills: skills.map((k, i) => ({
      id: k.skill.id,
      name: k.skill.name,
      /** the name the agent runs with (pinned with the body; a rename is a new
       * version taken by re-attach) */
      pinnedName: k.snapshotName || k.skill.name,
      description: k.skill.description,
      /** the library copy's prompt text (name or body) changed since this agent
       * pinned it: re-attach to take it */
      updateAvailable: k.snapshotDigest
        ? k.skill.contentDigest !== "" && k.skill.contentDigest !== k.snapshotDigest
        : k.skill.updatedAt.getTime() > k.skillUpdatedAt.getTime(),
      /** ADR-0175 review fix: a skill private to its owner on an agent shared
       * beyond its owner — it runs only in its owner's (and admins') turns;
       * everyone else's turns run without it until it is approved for the
       * workspace */
      ...(k.skill.visibility === "private" && agent.sharing !== "private"
        ? { withheldFromOthers: true, visibilityRequested: k.skill.requestedVisibility === "workspace" }
        : {}),
      /** the owner can no longer see it (made private by its author), or its
       * pinned body is withheld: it is left out of the agent's prompt */
      unavailable: !skillVisible(k.skill, ownerViewer) || withheld[i] !== null,
      /** ADR-0175: why the pinned body is withheld (absent when it runs) */
      ...(withheld[i] ? { withheld: withheld[i], pinnedVersion: k.snapshotVersion } : {}),
    })),
    memory: memory.map((m) => ({
      id: m.id,
      content: m.content,
      createdByName: m.createdByUserId ? (names.get(m.createdByUserId) ?? null) : null,
      createdAt: m.createdAt.toISOString(),
    })),
    schedules: schedules.map((x) => scheduleView(x, agent.ownerUserId, names)),
    channels: channels.map((c) => {
      const connected =
        !!c.connectionId && !!c.connectionEnabled && c.connectionProvider === chatopsProviderFor(c.provider);
      return {
        id: c.id,
        provider: c.provider,
        status: connected ? ("connected" as const) : ("needs_setup" as const),
        connectionName: c.connectionName ?? null,
      };
    }),
  };
}

/** what a viewer who may not see a sub-agent is shown in its place */
const PRIVATE_AGENT_NAME = "A private agent";

async function threadSummaries(db: Db, threads: BuilderThreadRow[]) {
  if (!threads.length) return [];
  const ids = threads.map((t) => t.id);
  const agentIds = [...new Set(threads.map((t) => t.agentId))];
  const [agentRows, last, pendingSteps] = await Promise.all([
    db
      .select({ id: builderAgents.id, name: builderAgents.name, color: builderAgents.color })
      .from(builderAgents)
      .where(inArray(builderAgents.id, agentIds)),
    db
      .selectDistinctOn([builderMessages.threadId], { threadId: builderMessages.threadId, content: builderMessages.content })
      .from(builderMessages)
      .where(inArray(builderMessages.threadId, ids))
      .orderBy(builderMessages.threadId, desc(builderMessages.createdAt)),
    // ADR-0173: a thread paused on a tool step says which pause it is
    db
      .select({ threadId: builderToolSteps.threadId, id: builderToolSteps.id, status: builderToolSteps.status, displayName: builderToolSteps.displayName })
      .from(builderToolSteps)
      .where(and(inArray(builderToolSteps.threadId, ids), inArray(builderToolSteps.status, ["pending_confirmation", "pending_approval"]))),
  ]);
  const agentBy = new Map(agentRows.map((a) => [a.id, a]));
  const pendingBy = new Map(pendingSteps.map((p) => [p.threadId, p]));
  const lastBy = new Map(last.map((l) => [l.threadId, l.content]));
  return threads.map((t) => ({
    id: t.id,
    agentId: t.agentId,
    // the FK guarantees the row; the fallbacks keep the type non-null
    agentName: agentBy.get(t.agentId)?.name ?? "Agent",
    agentColor: agentBy.get(t.agentId)?.color ?? builderColorFor(t.agentId),
    title: t.title,
    status: t.status,
    source: t.source,
    lastMessagePreview: (lastBy.get(t.id) ?? "").replace(/\s+/g, " ").slice(0, 160),
    pendingStep: pendingBy.has(t.id)
      ? { id: pendingBy.get(t.id)!.id, status: pendingBy.get(t.id)!.status, displayName: pendingBy.get(t.id)!.displayName }
      : null,
    updatedAt: t.updatedAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// writers shared by create / template / import
// ---------------------------------------------------------------------------

/**
 * The skill a template or an imported bundle attaches. NEVER someone else's:
 * a library skill is only reused when it is the caller's OWN skill with the
 * same name AND the identical body; otherwise a private copy of the template's
 * (or bundle's) body is created. Matching by name alone would let anyone squat
 * a template skill's name with a workspace skill of their own wording and have
 * it silently attached to every agent made from that template.
 */
/** ADR-0175 A6: a template or bundle skill the scanner refuses */
class SkillRefusedError extends Error {
  constructor(readonly body: ReturnType<typeof skillRefusalBody>) {
    super(body.detail);
  }
}

async function ensureSkill(
  db: Db,
  ownerUserId: string,
  s: { name: string; description: string; body: string },
  trigger: "template" | "bundle" = "template",
) {
  const [existing] = await db
    .select()
    .from(builderSkills)
    .where(
      and(
        eq(builderSkills.name, s.name),
        eq(builderSkills.ownerUserId, ownerUserId),
        eq(builderSkills.body, s.body),
        isNull(builderSkills.archivedAt),
      ),
    )
    .orderBy(asc(builderSkills.createdAt))
    .limit(1);
  if (existing) return existing;
  // ADR-0175 A6: a seeded or imported body is scanned like any other save
  const admission = admitSkillText(s);
  if (admission.state === "refused") throw new SkillRefusedError(skillRefusalBody(s.name, admission.scan));
  const [row] = await db
    .insert(builderSkills)
    .values({ name: s.name, description: s.description, body: s.body, visibility: "private", ownerUserId, ...admissionColumns(admission) })
    .returning();
  await sightSkill(db, row!.id, admission.digest);
  await auditSkillAdmission(db, { userId: ownerUserId, skillId: row!.id, name: s.name, admission, trigger });
  return row!;
}

/** the pinned attachment row for a skill (its body, digest, version and
 * verdict now) */
const pinned = (agentId: string, skill: BuilderSkillRow) => pinnedFrom(agentId, skill);

interface Seed {
  instructions: string;
  skills: Array<{ name: string; description: string; body: string }>;
  subagents: Array<{ name: string; description: string }>;
  schedules: Array<{ name: string; cadence: BuilderCadenceValue; timeUtc: string; prompt: string }>;
}

/** attach seeded skills, child agents and schedules to a freshly created agent.
 * Child agents are private, owned by the creator, on the same model. Seeded
 * schedules start DISABLED: nothing spends until the owner turns one on. */
async function applySeed(db: Db, agent: BuilderAgentRow, seed: Seed, trigger: "template" | "bundle" = "template") {
  for (const s of seed.skills) {
    const skill = await ensureSkill(db, agent.ownerUserId, s, trigger);
    await db.insert(builderAgentSkills).values(pinned(agent.id, skill)).onConflictDoNothing();
  }
  let position = 0;
  for (const sub of seed.subagents) {
    const [child] = await db
      .insert(builderAgents)
      .values({
        name: sub.name.slice(0, 80),
        description: sub.description.slice(0, 500),
        color: colorFor(sub.name),
        ownerUserId: agent.ownerUserId,
        sharing: "private",
        modelAgentId: agent.modelAgentId,
        instructions: `# ${sub.name}\n\n${sub.description}`,
        connectionFormat: agent.connectionFormat,
        computerUse: false,
        // owner rule: a seeded sub-agent bills where its parent does
        projectId: agent.projectId,
      })
      .returning();
    await db.insert(builderAgentSubagents).values({
      parentId: agent.id,
      childId: child!.id,
      name: sub.name.slice(0, 80),
      description: sub.description.slice(0, 500),
      position: position++,
    });
  }
  for (const s of seed.schedules) {
    await db.insert(builderAgentSchedules).values({
      agentId: agent.id,
      name: s.name,
      cadence: s.cadence,
      timeUtc: s.timeUtc,
      prompt: s.prompt,
      enabled: false,
      nextRunAt: null,
      createdByUserId: agent.ownerUserId,
    });
  }
}

/**
 * Would making `children` sub-agents of `parentId` close a cycle? Walks only
 * the edges REACHABLE from those children (a recursive CTE), never the whole
 * table, and ignores `parentId`'s own current edges (this write replaces them).
 */
async function closesCycle(db: Db, parentId: string, children: string[]): Promise<boolean> {
  if (!children.length) return false;
  if (children.includes(parentId)) return true;
  const res = await db.execute<{ hit: boolean }>(sql`
    WITH RECURSIVE reach(id) AS (
      SELECT unnest(${sql`ARRAY[${sql.join(children.map((c) => sql`${c}::uuid`), sql`, `)}]`})
      UNION
      SELECT e.child_id FROM builder_agent_subagents e
        JOIN reach r ON e.parent_id = r.id
       WHERE e.parent_id <> ${parentId}::uuid
    )
    SELECT EXISTS (SELECT 1 FROM reach WHERE id = ${parentId}::uuid) AS hit
  `);
  return !!res.rows[0]?.hit;
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

export function registerBuilderRoutes(app: FastifyInstance, db: Db, opts: BuilderRouteOptions = {}): void {
  /** load an agent the viewer may see; sends 404 otherwise */
  const visible = async (req: FastifyRequest, reply: FastifyReply, viewer: Viewer) => {
    const { id } = idParam.parse(req.params);
    const agent = await loadVisibleAgent(db, id, viewer);
    if (!agent) {
      void reply.status(404).send({ error: "unknown_builder_agent" });
      return null;
    }
    return agent;
  };
  /** load an agent the viewer may EDIT; 404 when invisible, 403 when read-only */
  const editable = async (req: FastifyRequest, reply: FastifyReply, viewer: Viewer) => {
    const agent = await visible(req, reply, viewer);
    if (!agent) return null;
    if (!canEditAgent(agent, viewer)) {
      void reply.status(403).send({ error: "not_agent_editor", detail: "only the agent's owner or an admin can change it" });
      return null;
    }
    return agent;
  };
  const touch = (id: string) => db.update(builderAgents).set({ updatedAt: new Date() }).where(eq(builderAgents.id, id));

  // --- agents ----------------------------------------------------------------

  app.get("/v1/builder/agents", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    return { agents: await summaries(db, await listVisibleAgents(db, viewer), viewer) };
  });

  app.post("/v1/builder/agents", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const body = builderCreateAgentSchema.parse(req.body ?? {});
    const template = body.templateId ? findTemplate(body.templateId) : undefined;
    if (body.templateId && !template) return reply.status(404).send({ error: "unknown_template" });
    // ADR-0175 A6: catalogue skills are scanned like any other body, before
    // the agent exists (so a refusal leaves nothing half-made)
    for (const sk of template?.skills ?? []) {
      const admission = admitSkillText(sk);
      if (admission.state === "refused") return reply.status(422).send(skillRefusalBody(sk.name, admission.scan));
    }
    const noProject = await projectRefusal(db, viewer, body.projectId);
    if (noProject) return reply.status(noProject.status).send(noProject.body);

    let model: AgentRow | null = null;
    if (body.modelAgentId) {
      const [m] = await db.select().from(agents).where(eq(agents.id, body.modelAgentId));
      if (!m) return reply.status(404).send({ error: "unknown_model" });
      if (!(await modelAllowed(db, viewer.userId, m))) {
        return reply.status(403).send({ error: "model_not_entitled", detail: `you may not use the model '${m.name}'` });
      }
      model = m;
    } else {
      model = await defaultModelFor(db, viewer.userId);
    }

    const [agent] = await db
      .insert(builderAgents)
      .values({
        name: body.name,
        description: body.description ?? (template ? template.description.slice(0, 500) : ""),
        color: colorFor(body.name),
        ownerUserId: viewer.userId,
        sharing: "private",
        modelAgentId: model?.id ?? null,
        templateId: template?.id ?? null,
        instructions: template?.instructions ?? "",
        connectionFormat: body.connectionFormat,
        computerUse: body.computerUse,
        projectId: body.projectId!,
      })
      .returning();
    if (template) await applySeed(db, agent!, template);
    await audit(db, viewer.userId, "builder_agent", agent!.id, "builder-agent-created", `builder agent '${agent!.name}' created`, {
      templateId: template?.id ?? null,
      modelAgentId: model?.id ?? null,
      projectId: body.projectId,
      connectionFormat: body.connectionFormat,
      computerUse: body.computerUse,
    });
    return reply.status(201).send({ agent: await agentDetail(db, agent!, viewer) });
  });

  app.get("/v1/builder/agents/:id", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const agent = await visible(req, reply, viewer);
    if (!agent) return;
    return { agent: await agentDetail(db, agent, viewer) };
  });

  app.patch("/v1/builder/agents/:id", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const body = builderUpdateAgentSchema.parse(req.body ?? {});
    const agent = await editable(req, reply, viewer);
    if (!agent) return;
    if (body.connectionFormat !== undefined) {
      return reply.status(409).send({
        error: "connection_format_locked",
        detail: "the connection format is fixed when an agent is created; create a new agent to change it",
      });
    }
    if (body.modelAgentId !== undefined && body.modelAgentId !== agent.modelAgentId) {
      const [m] = await db.select().from(agents).where(eq(agents.id, body.modelAgentId));
      if (!m) return reply.status(404).send({ error: "unknown_model" });
      if (!(await modelAllowed(db, viewer.userId, m))) {
        return reply.status(403).send({ error: "model_not_entitled", detail: `you may not use the model '${m.name}'` });
      }
    }
    if (body.sharedUserIds?.length) {
      const found = await db.select({ id: users.id }).from(users).where(inArray(users.id, body.sharedUserIds));
      if (found.length !== new Set(body.sharedUserIds).size) return reply.status(422).send({ error: "unknown_user" });
    }
    // owner rule: a project can be changed (by a member of the new one) but
    // never cleared
    if (body.projectId !== undefined && body.projectId !== agent.projectId) {
      const refused = await projectRefusal(db, viewer, body.projectId);
      if (refused) return reply.status(refused.status).send(refused.body);
    }
    if (body.instructions !== undefined) {
      const tooLarge = promptTooLarge(
        configuredPrompt({ ...agent, instructions: body.instructions, name: body.name ?? agent.name }, await pinnedSkillsForRun(db, agent)),
      );
      if (tooLarge) return reply.status(422).send(tooLarge);
    }
    const set: Partial<typeof builderAgents.$inferInsert> = { updatedAt: new Date() };
    for (const k of ["name", "description", "color", "instructions", "modelAgentId", "sharing", "computerUse", "projectId"] as const) {
      if (body[k] !== undefined) (set as Record<string, unknown>)[k] = body[k];
    }
    if (body.monthlyLimitUsd !== undefined) set.monthlyLimitUsd = body.monthlyLimitUsd;
    const [updated] = await db.update(builderAgents).set(set).where(eq(builderAgents.id, agent.id)).returning();
    if (body.sharedUserIds !== undefined) {
      await db.delete(builderAgentShares).where(eq(builderAgentShares.agentId, agent.id));
      const uniq = [...new Set(body.sharedUserIds)].filter((u) => u !== agent.ownerUserId);
      if (uniq.length) await db.insert(builderAgentShares).values(uniq.map((userId) => ({ agentId: agent.id, userId })));
    }
    const changed = Object.keys(body);
    if (body.sharing !== undefined || body.sharedUserIds !== undefined) {
      await audit(db, viewer.userId, "builder_agent", agent.id, "builder-agent-sharing-changed",
        `sharing of '${agent.name}' set to ${body.sharing ?? agent.sharing}`,
        { from: agent.sharing, to: body.sharing ?? agent.sharing, sharedUserIds: body.sharedUserIds ?? null });
    }
    if (body.monthlyLimitUsd !== undefined) {
      await audit(db, viewer.userId, "builder_agent", agent.id, "builder-agent-limit-changed",
        `monthly limit of '${agent.name}' set to ${body.monthlyLimitUsd === null ? "none" : `$${body.monthlyLimitUsd}`}`,
        { from: agent.monthlyLimitUsd, to: body.monthlyLimitUsd });
    }
    if (body.projectId !== undefined && body.projectId !== agent.projectId) {
      await audit(db, viewer.userId, "builder_agent", agent.id, "builder-agent-project-changed",
        `spend of '${agent.name}' now bills to project ${body.projectId}`,
        { from: agent.projectId, to: body.projectId });
    }
    const rest = changed.filter((k) => !["sharing", "sharedUserIds", "monthlyLimitUsd", "projectId"].includes(k));
    if (rest.length) {
      await audit(db, viewer.userId, "builder_agent", agent.id, "builder-agent-updated",
        `builder agent '${updated!.name}' updated (${rest.join(", ")})`,
        { fields: rest, ...(body.modelAgentId ? { modelAgentId: body.modelAgentId } : {}) });
    }
    return { agent: await agentDetail(db, updated!, viewer) };
  });

  app.delete("/v1/builder/agents/:id", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const agent = await editable(req, reply, viewer);
    if (!agent) return;
    await db.update(builderAgents).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(builderAgents.id, agent.id));
    // an archived agent stops being anyone's sub-agent, and its schedules stop
    await db.delete(builderAgentSubagents).where(eq(builderAgentSubagents.childId, agent.id));
    await db.update(builderAgentSchedules).set({ enabled: false, nextRunAt: null }).where(eq(builderAgentSchedules.agentId, agent.id));
    await audit(db, viewer.userId, "builder_agent", agent.id, "builder-agent-deleted", `builder agent '${agent.name}' archived`);
    return reply.status(204).send();
  });

  app.put("/v1/builder/agents/:id/tools", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const body = builderSetToolsSchema.parse(req.body ?? {});
    const agent = await editable(req, reply, viewer);
    if (!agent) return;
    const connectorIds = body.tools.filter((t) => t.kind === "connector").map((t) => t.refId);
    const toolIds = body.tools.filter((t) => t.kind === "mcp_tool").map((t) => t.refId);
    const [connectorRows, mcpRows] = await Promise.all([loadConnectorsById(db, connectorIds), loadMcpTools(db, toolIds)]);
    for (const id of connectorIds) {
      if (!connectorRows.some((c) => c.id === id)) return reply.status(404).send({ error: "unknown_tool", refId: id });
    }
    for (const id of toolIds) {
      if (!mcpRows.some((m) => m.id === id)) return reply.status(404).send({ error: "unknown_tool", refId: id });
    }
    // THE EDITOR'S OWN GRANTS bound the toolbox — admins included.
    const [okConnectors, okTools] = await Promise.all([
      entitledConnectorIds(db, viewer.userId),
      entitledMcpToolIds(db, viewer.userId, mcpRows),
    ]);
    for (const c of connectorRows) {
      if (!okConnectors.has(c.id)) {
        await audit(db, viewer.userId, "builder_agent", agent.id, "builder-agent-tool-not-entitled",
          `refused adding connector '${c.name}' to '${agent.name}': the editor holds no grant for it`,
          { kind: "connector", refId: c.id }, "deny");
        return reply.status(403).send({
          error: "tool_not_entitled",
          tool: { kind: "connector", refId: c.id, name: c.name },
          detail: `you hold no grant for the connector '${c.name}', so you cannot give it to an agent`,
        });
      }
    }
    for (const m of mcpRows) {
      if (!okTools.has(m.id)) {
        await audit(db, viewer.userId, "builder_agent", agent.id, "builder-agent-tool-not-entitled",
          `refused adding MCP tool '${m.serverName}/${m.name}' to '${agent.name}': the editor holds no grant for it`,
          { kind: "mcp_tool", refId: m.id }, "deny");
        return reply.status(403).send({
          error: "tool_not_entitled",
          tool: { kind: "mcp_tool", refId: m.id, name: `${m.serverName}/${m.name}` },
          detail: `you hold no grant for the MCP tool '${m.serverName}/${m.name}', so you cannot give it to an agent`,
        });
      }
    }
    const seen = new Set<string>();
    const rows = body.tools.filter((t) => {
      const k = `${t.kind}:${t.refId}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // ADR-0181: ask-first is on by default, so turning it off for a tool is a
    // relaxation — the audit row carries the previous toolbox (old -> new)
    const previousTools = await db
      .select({ kind: builderAgentTools.kind, refId: builderAgentTools.refId, requiresApproval: builderAgentTools.requiresApproval })
      .from(builderAgentTools)
      .where(eq(builderAgentTools.agentId, agent.id));
    await db.transaction(async (tx) => {
      await tx.delete(builderAgentTools).where(eq(builderAgentTools.agentId, agent.id));
      if (rows.length) {
        await tx.insert(builderAgentTools).values(
          rows.map((t) => ({ agentId: agent.id, kind: t.kind, refId: t.refId, requiresApproval: t.requiresApproval })),
        );
      }
    });
    await touch(agent.id);
    await audit(db, viewer.userId, "builder_agent", agent.id, "builder-agent-tools-changed",
      `toolbox of '${agent.name}' set to ${rows.length} tool(s)`,
      {
        tools: rows.map((t) => ({ kind: t.kind, refId: t.refId, requiresApproval: t.requiresApproval })),
        previousTools,
      });
    return { agent: await agentDetail(db, (await loadVisibleAgent(db, agent.id, viewer))!, viewer) };
  });

  app.put("/v1/builder/agents/:id/subagents", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const body = builderSetSubagentsSchema.parse(req.body ?? {});
    const agent = await editable(req, reply, viewer);
    if (!agent) return;
    const childIds = [...new Set(body.subagents.map((s) => s.childId))];
    if (childIds.includes(agent.id)) {
      return reply.status(422).send({ error: "subagent_self", detail: "an agent cannot be its own sub-agent" });
    }
    for (const id of childIds) {
      if (!(await loadVisibleAgent(db, id, viewer))) return reply.status(404).send({ error: "unknown_subagent", childId: id });
    }
    if (await closesCycle(db, agent.id, childIds)) {
      return reply.status(422).send({
        error: "subagent_cycle",
        detail: "one of these agents already uses this agent (directly or through others) as a sub-agent",
      });
    }
    await db.transaction(async (tx) => {
      await tx.delete(builderAgentSubagents).where(eq(builderAgentSubagents.parentId, agent.id));
      const seen = new Set<string>();
      const rows = body.subagents.filter((s) => (seen.has(s.childId) ? false : (seen.add(s.childId), true)));
      if (rows.length) {
        await tx.insert(builderAgentSubagents).values(
          rows.map((s, i) => ({ parentId: agent.id, childId: s.childId, name: s.name, description: s.description, position: i })),
        );
      }
    });
    await touch(agent.id);
    await audit(db, viewer.userId, "builder_agent", agent.id, "builder-agent-subagents-changed",
      `sub-agents of '${agent.name}' set to ${childIds.length}`, { childIds });
    return { agent: await agentDetail(db, (await loadVisibleAgent(db, agent.id, viewer))!, viewer) };
  });

  app.put("/v1/builder/agents/:id/skills", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const body = builderSetSkillsSchema.parse(req.body ?? {});
    const agent = await editable(req, reply, viewer);
    if (!agent) return;
    const ids = [...new Set(body.skillIds)];
    const rows = ids.length ? await db.select().from(builderSkills).where(inArray(builderSkills.id, ids)) : [];
    for (const id of ids) {
      const s = rows.find((r) => r.id === id);
      if (!s || !skillVisible(s, viewer)) return reply.status(404).send({ error: "unknown_skill", skillId: id });
    }
    // a skill already attached KEEPS its pinned body; a newly attached one is
    // pinned at its current version (taking a newer version is a re-attach)
    const current = await db.select().from(builderAgentSkills).where(eq(builderAgentSkills.agentId, agent.id));
    const kept = new Map(current.map((c) => [c.skillId, c]));
    // ADR-0175: a NEWLY attached skill must be admitted and past the cooldown
    for (const id of ids) {
      if (kept.has(id)) continue;
      // a row that predates the scanner is scanned before it can be pinned
      const i = rows.findIndex((r) => r.id === id);
      rows[i] = await ensureSkillScanned(db, rows[i]!);
      const refusal = await skillAttachRefusal(db, rows[i]!);
      if (refusal) {
        await audit(db, viewer.userId, "builder_agent", agent.id, "builder-agent-skill-attach-refused",
          `skill not attached to '${agent.name}': ${String(refusal.detail)}`, { skillId: id, error: refusal.error }, "deny");
        return reply.status(409).send(refusal);
      }
    }
    const next = ids.map((id) => {
      const k = kept.get(id);
      return k ? { ...k, agentId: agent.id, skillId: id } : pinned(agent.id, rows.find((r) => r.id === id)!);
    });
    const tooLarge = promptTooLarge(
      configuredPrompt(agent, next.map((n) => ({ name: n.snapshotName || rows.find((r) => r.id === n.skillId)!.name, body: n.bodySnapshot }))),
    );
    if (tooLarge) return reply.status(422).send(tooLarge);
    await db.transaction(async (tx) => {
      await tx.delete(builderAgentSkills).where(eq(builderAgentSkills.agentId, agent.id));
      if (next.length) await tx.insert(builderAgentSkills).values(next);
    });
    await touch(agent.id);
    await audit(db, viewer.userId, "builder_agent", agent.id, "builder-agent-skills-changed",
      `skills of '${agent.name}' set to ${ids.length}`, { skillIds: ids });
    return { agent: await agentDetail(db, (await loadVisibleAgent(db, agent.id, viewer))!, viewer) };
  });

  // re-attach: take the library's current version of an attached skill
  app.post("/v1/builder/agents/:id/skills/:skillId/reattach", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const { skillId } = skillParam.parse(req.params);
    const agent = await editable(req, reply, viewer);
    if (!agent) return;
    const [link] = await db
      .select()
      .from(builderAgentSkills)
      .where(and(eq(builderAgentSkills.agentId, agent.id), eq(builderAgentSkills.skillId, skillId)));
    const [found] = link ? await db.select().from(builderSkills).where(eq(builderSkills.id, skillId)) : [];
    if (!link || !found || !skillVisible(found, viewer)) return reply.status(404).send({ error: "unknown_skill", skillId });
    // a row that predates the scanner is scanned before it can be pinned
    const skill = await ensureSkillScanned(db, found);
    // ADR-0175: a held source skill (or a version still in cooldown) is not
    // taken; the agent keeps running the body it already pinned
    const refusal = await skillAttachRefusal(db, skill);
    if (refusal) {
      await audit(db, viewer.userId, "builder_agent", agent.id, "builder-agent-skill-attach-refused",
        `skill '${skill.name}' not re-attached on '${agent.name}': ${String(refusal.detail)}`, { skillId, error: refusal.error }, "deny");
      return reply.status(409).send(refusal);
    }
    const others = (await pinnedSkillsForRun(db, agent)).filter((x) => x.skillId !== skillId);
    const tooLarge = promptTooLarge(configuredPrompt(agent, [...others, { name: skill.name, body: skill.body }]));
    if (tooLarge) return reply.status(422).send(tooLarge);
    await db
      .update(builderAgentSkills)
      .set((({ agentId: _a, skillId: _s, ...rest }) => rest)(pinned(agent.id, skill)))
      .where(and(eq(builderAgentSkills.agentId, agent.id), eq(builderAgentSkills.skillId, skillId)));
    await touch(agent.id);
    await audit(db, viewer.userId, "builder_agent", agent.id, "builder-agent-skill-reattached",
      `skill '${skill.name}' on '${agent.name}' updated to the library's current version`,
      {
        skillId,
        from: link.skillUpdatedAt.toISOString(),
        to: skill.updatedAt.toISOString(),
        fromVersion: link.snapshotVersion,
        toVersion: skill.version,
        fromName: link.snapshotName,
        toName: skill.name,
        fromDigest: link.snapshotDigest,
        toDigest: skillDigest(skill.name, skill.body),
      });
    return { agent: await agentDetail(db, (await loadVisibleAgent(db, agent.id, viewer))!, viewer) };
  });

  // --- memory ------------------------------------------------------------------

  app.post("/v1/builder/agents/:id/memory", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const body = builderAddMemorySchema.parse(req.body ?? {});
    const agent = await editable(req, reply, viewer);
    if (!agent) return;
    // a ceiling, refused by name: memory is append-only, so nothing is ever
    // pruned behind the owner's back — they choose what to remove
    const [held] = await db.select({ n: count() }).from(builderAgentMemory).where(eq(builderAgentMemory.agentId, agent.id));
    if (Number(held?.n ?? 0) >= BUILDER_LIMITS.memoryPerAgent) {
      return reply.status(422).send({
        error: "memory_limit_reached",
        detail: `an agent keeps at most ${BUILDER_LIMITS.memoryPerAgent} memory items; remove some before adding more`,
        limit: BUILDER_LIMITS.memoryPerAgent,
      });
    }
    const [row] = await db
      .insert(builderAgentMemory)
      .values({ agentId: agent.id, content: body.content, createdByUserId: viewer.userId })
      .returning();
    await audit(db, viewer.userId, "builder_agent", agent.id, "builder-agent-memory-added", `memory added to '${agent.name}'`, { memoryId: row!.id });
    const names = await userNames(db, [viewer.userId]);
    return reply.status(201).send({
      id: row!.id,
      content: row!.content,
      createdByName: names.get(viewer.userId) ?? null,
      createdAt: row!.createdAt.toISOString(),
    });
  });

  app.delete("/v1/builder/agents/:id/memory/:memoryId", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const { memoryId } = memoryParam.parse(req.params);
    const agent = await editable(req, reply, viewer);
    if (!agent) return;
    const deleted = await db
      .delete(builderAgentMemory)
      .where(and(eq(builderAgentMemory.id, memoryId), eq(builderAgentMemory.agentId, agent.id)))
      .returning({ id: builderAgentMemory.id });
    if (!deleted.length) return reply.status(404).send({ error: "unknown_memory" });
    await audit(db, viewer.userId, "builder_agent", agent.id, "builder-agent-memory-removed", `memory removed from '${agent.name}'`, { memoryId });
    return reply.status(204).send();
  });

  // --- schedules -----------------------------------------------------------------

  /** a schedule spends as the agent's OWNER; anyone else (an admin) may write
   * one, but it is saved OFF and only the owner can turn it on */
  const ownerMustEnable = (agent: BuilderAgentRow) =>
    ({
      error: "owner_must_enable_schedule",
      detail: `a schedule runs as the agent's owner, so only the owner can turn it on`,
      ownerUserId: agent.ownerUserId,
    }) as const;

  app.post("/v1/builder/agents/:id/schedules", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const body = builderCreateScheduleSchema.parse(req.body ?? {});
    const agent = await editable(req, reply, viewer);
    if (!agent) return;
    const [held] = await db.select({ n: count() }).from(builderAgentSchedules).where(eq(builderAgentSchedules.agentId, agent.id));
    if (Number(held?.n ?? 0) >= BUILDER_LIMITS.schedulesPerAgent) {
      return reply.status(422).send({
        error: "schedule_limit_reached",
        detail: `an agent has at most ${BUILDER_LIMITS.schedulesPerAgent} schedules`,
        limit: BUILDER_LIMITS.schedulesPerAgent,
      });
    }
    const isOwner = viewer.userId === agent.ownerUserId;
    const enabled = body.enabled && isOwner;
    const now = new Date();
    const [row] = await db
      .insert(builderAgentSchedules)
      .values({
        agentId: agent.id,
        name: body.name,
        cadence: body.cadence,
        timeUtc: body.timeUtc,
        prompt: body.prompt,
        enabled,
        nextRunAt: enabled ? nextScheduleRun(body.cadence, body.timeUtc, now, now) : null,
        createdByUserId: viewer.userId,
        updatedByUserId: viewer.userId,
        enabledByUserId: enabled ? viewer.userId : null,
        createdAt: now,
      })
      .returning();
    await touch(agent.id);
    await audit(db, viewer.userId, "builder_agent", agent.id, "builder-agent-schedule-created",
      `schedule '${body.name}' (${body.cadence} ${body.timeUtc} UTC) added to '${agent.name}'` +
        (isOwner ? "" : " by someone other than the owner: saved off until the owner turns it on"),
      { scheduleId: row!.id, cadence: body.cadence, timeUtc: body.timeUtc, enabled, awaitingOwner: !isOwner });
    const names = await userNames(db, [viewer.userId]);
    return reply.status(201).send(scheduleView(row!, agent.ownerUserId, names));
  });

  app.patch("/v1/builder/agents/:id/schedules/:scheduleId", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const { scheduleId } = scheduleParam.parse(req.params);
    const body = builderUpdateScheduleSchema.parse(req.body ?? {});
    const agent = await editable(req, reply, viewer);
    if (!agent) return;
    const [s] = await db
      .select()
      .from(builderAgentSchedules)
      .where(and(eq(builderAgentSchedules.id, scheduleId), eq(builderAgentSchedules.agentId, agent.id)));
    if (!s) return reply.status(404).send({ error: "unknown_schedule" });
    const isOwner = viewer.userId === agent.ownerUserId;
    if (!isOwner && body.enabled === true) {
      await audit(db, viewer.userId, "builder_agent", agent.id, "builder-agent-schedule-owner-must-enable",
        `refused turning on schedule '${s.name}' of '${agent.name}': only the owner can`, { scheduleId: s.id }, "deny");
      return reply.status(403).send(ownerMustEnable(agent));
    }
    const contentChanged = (["name", "cadence", "timeUtc", "prompt"] as const).some(
      (k) => body[k] !== undefined && body[k] !== s[k],
    );
    const merged = { ...s, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) } as BuilderScheduleRow;
    // anyone else's edit to what it does or when switches it OFF for the owner to review
    if (!isOwner && contentChanged) merged.enabled = false;
    const now = new Date();
    const timingChanged = body.cadence !== undefined || body.timeUtc !== undefined || body.enabled !== undefined;
    const nextRunAt = !merged.enabled
      ? null
      : timingChanged || !s.nextRunAt
        ? nextScheduleRun(merged.cadence as BuilderCadenceValue, merged.timeUtc, now, s.createdAt)
        : s.nextRunAt;
    const turnedOn = merged.enabled && !s.enabled;
    const [row] = await db
      .update(builderAgentSchedules)
      .set({
        name: merged.name,
        cadence: merged.cadence,
        timeUtc: merged.timeUtc,
        prompt: merged.prompt,
        enabled: merged.enabled,
        nextRunAt,
        enabledByUserId: !merged.enabled ? null : turnedOn ? viewer.userId : s.enabledByUserId,
        ...(contentChanged || turnedOn ? { updatedByUserId: viewer.userId } : {}),
        updatedAt: now,
      })
      .where(eq(builderAgentSchedules.id, s.id))
      .returning();
    await audit(db, viewer.userId, "builder_agent", agent.id, "builder-agent-schedule-updated",
      `schedule '${merged.name}' of '${agent.name}' updated (${Object.keys(body).join(", ")})` +
        (!isOwner && contentChanged ? " by someone other than the owner: switched off until the owner turns it on" : ""),
      { scheduleId: s.id, fields: Object.keys(body), enabled: merged.enabled, awaitingOwner: !isOwner && contentChanged });
    const names = await userNames(db, [row!.updatedByUserId ?? row!.createdByUserId]);
    return scheduleView(row!, agent.ownerUserId, names);
  });

  app.delete("/v1/builder/agents/:id/schedules/:scheduleId", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const { scheduleId } = scheduleParam.parse(req.params);
    const agent = await editable(req, reply, viewer);
    if (!agent) return;
    const deleted = await db
      .delete(builderAgentSchedules)
      .where(and(eq(builderAgentSchedules.id, scheduleId), eq(builderAgentSchedules.agentId, agent.id)))
      .returning({ id: builderAgentSchedules.id, name: builderAgentSchedules.name });
    if (!deleted.length) return reply.status(404).send({ error: "unknown_schedule" });
    await audit(db, viewer.userId, "builder_agent", agent.id, "builder-agent-schedule-deleted",
      `schedule '${deleted[0]!.name}' removed from '${agent.name}'`, { scheduleId });
    return reply.status(204).send();
  });

  // Admin (the default gate): run due schedules now. Each runs as its agent's
  // OWNER; the scheduler job `builder-agent-schedules` calls the same function.
  app.post("/v1/builder/schedules/sweep", async () => {
    return runBuilderScheduleSweep(db, opts.dataKey);
  });

  // --- channels -----------------------------------------------------------------

  app.post("/v1/builder/agents/:id/channels", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const body = builderCreateChannelSchema.parse(req.body ?? {});
    const agent = await editable(req, reply, viewer);
    if (!agent) return;
    const [held] = await db.select({ n: count() }).from(builderAgentChannels).where(eq(builderAgentChannels.agentId, agent.id));
    if (Number(held?.n ?? 0) >= BUILDER_LIMITS.channelsPerAgent) {
      return reply.status(422).send({
        error: "channel_limit_reached",
        detail: `an agent has at most ${BUILDER_LIMITS.channelsPerAgent} channels`,
        limit: BUILDER_LIMITS.channelsPerAgent,
      });
    }
    // Binding a workspace ChatOps connection (an org-owned bot identity) is an
    // ADMIN act — choosing one, or having one picked. Anyone else's channel is
    // recorded as needing setup, and no connection is named back to them.
    if (body.chatopsConnectionId && !viewer.isAdmin) {
      await audit(db, viewer.userId, "builder_agent", agent.id, "builder-agent-channel-binding-refused",
        `refused binding a ChatOps connection to '${agent.name}': only an admin can bind one`,
        { provider: body.provider }, "deny");
      return reply.status(403).send({
        error: "channel_binding_requires_admin",
        detail: "only an admin can connect an agent to one of the workspace's chat connections; add the channel and ask an admin to finish setting it up",
      });
    }
    const wanted = chatopsProviderFor(body.provider) as "slack" | "teams" | "outlook";
    let connectionId: string | null = null;
    if (body.chatopsConnectionId) {
      const [c] = await db.select().from(chatopsConnections).where(eq(chatopsConnections.id, body.chatopsConnectionId));
      if (!c) return reply.status(404).send({ error: "unknown_chatops_connection" });
      if (c.provider !== wanted) {
        return reply.status(422).send({
          error: "chatops_provider_mismatch",
          detail: `connection '${c.name}' is a ${c.provider} connection, not ${wanted}`,
        });
      }
      connectionId = c.id;
    } else if (viewer.isAdmin) {
      const [c] = await db
        .select()
        .from(chatopsConnections)
        .where(and(eq(chatopsConnections.provider, wanted), eq(chatopsConnections.enabled, true)))
        .orderBy(asc(chatopsConnections.createdAt))
        .limit(1);
      connectionId = c?.id ?? null;
    }
    const [row] = await db
      .insert(builderAgentChannels)
      .values({ agentId: agent.id, provider: body.provider, chatopsConnectionId: connectionId })
      .returning();
    await touch(agent.id);
    await audit(db, viewer.userId, "builder_agent", agent.id, "builder-agent-channel-added",
      `${body.provider} channel added to '${agent.name}'${connectionId ? "" : viewer.isAdmin ? " (needs setup: no matching ChatOps connection)" : " (needs setup: an admin binds the connection)"}`,
      { channelId: row!.id, provider: body.provider, chatopsConnectionId: connectionId });
    const detail = await agentDetail(db, agent, viewer);
    return reply.status(201).send(detail.channels.find((c) => c.id === row!.id));
  });

  app.delete("/v1/builder/agents/:id/channels/:channelId", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const { channelId } = channelParam.parse(req.params);
    const agent = await editable(req, reply, viewer);
    if (!agent) return;
    const deleted = await db
      .delete(builderAgentChannels)
      .where(and(eq(builderAgentChannels.id, channelId), eq(builderAgentChannels.agentId, agent.id)))
      .returning({ id: builderAgentChannels.id, provider: builderAgentChannels.provider });
    if (!deleted.length) return reply.status(404).send({ error: "unknown_channel" });
    await audit(db, viewer.userId, "builder_agent", agent.id, "builder-agent-channel-removed",
      `${deleted[0]!.provider} channel removed from '${agent.name}'`, { channelId });
    return reply.status(204).send();
  });

  // --- export / import ---------------------------------------------------------

  // export is an EDITOR act (owner or admin): a bundle carries the agent's
  // instructions and skill bodies, which a person it is merely shared with
  // can use but not take away
  app.get("/v1/builder/agents/:id/export", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const agent = await editable(req, reply, viewer);
    if (!agent) return;
    const [model] = agent.modelAgentId
      ? await db.select().from(agents).where(eq(agents.id, agent.modelAgentId))
      : [];
    const tools = await db.select().from(builderAgentTools).where(eq(builderAgentTools.agentId, agent.id));
    const connectorRows = await loadConnectorsById(db, tools.filter((t) => t.kind === "connector").map((t) => t.refId));
    const mcpRows = await loadMcpTools(db, tools.filter((t) => t.kind === "mcp_tool").map((t) => t.refId));
    const detail = await agentDetail(db, agent, viewer);
    // the PINNED bodies the agent runs — and only skills the exporter can see
    // (a colleague's skill made private since stays out of the bundle)
    const skillRows = (
      await db
        .select({ skill: builderSkills, body: builderAgentSkills.bodySnapshot })
        .from(builderAgentSkills)
        .innerJoin(builderSkills, eq(builderAgentSkills.skillId, builderSkills.id))
        .where(eq(builderAgentSkills.agentId, agent.id))
        .orderBy(asc(builderSkills.name))
    )
      .filter((r) => skillVisible(r.skill, viewer))
      .map((r) => ({ name: r.skill.name, description: r.skill.description, body: r.body }));
    const bundle: BuilderBundle = {
      version: 1,
      agent: {
        name: agent.name,
        description: agent.description,
        color: agent.color,
        instructions: agent.instructions,
        connectionFormat: agent.connectionFormat,
        computerUse: agent.computerUse,
        monthlyLimitUsd: agent.monthlyLimitUsd,
        model: model ? { name: model.name, provider: model.provider, model: model.model } : null,
        tools: tools.flatMap((t): BuilderBundle["agent"]["tools"] => {
          if (t.kind === "connector") {
            const c = connectorRows.find((r) => r.id === t.refId);
            return c ? [{ kind: "connector" as const, name: c.name, server: null, requiresApproval: t.requiresApproval }] : [];
          }
          const m = mcpRows.find((r) => r.id === t.refId);
          return m ? [{ kind: "mcp_tool" as const, name: m.name, server: m.serverName, requiresApproval: t.requiresApproval }] : [];
        }),
        subagents: detail.subagents.map((s) => ({ name: s.name, description: s.description })),
        skills: skillRows.map((s) => s.name),
        schedules: detail.schedules.map((s) => ({
          name: s.name,
          cadence: s.cadence as BuilderCadenceValue,
          timeUtc: s.timeUtc,
          prompt: s.prompt,
        })),
      },
      skills: skillRows,
    };
    return { bundle };
  });

  app.post("/v1/builder/agents/import", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const { bundle, projectId } = builderImportAgentSchema.parse(req.body ?? {});
    const a = bundle.agent;
    const noProject = await projectRefusal(db, viewer, projectId);
    if (noProject) return reply.status(noProject.status).send(noProject.body);
    if (a.subagents.length > BUILDER_LIMITS.importSubagents) {
      return reply.status(422).send({
        error: "import_too_many_subagents",
        detail: `an import creates at most ${BUILDER_LIMITS.importSubagents} sub-agents; this bundle has ${a.subagents.length}`,
        limit: BUILDER_LIMITS.importSubagents,
      });
    }
    const skillsByName = new Map(bundle.skills.map((s) => [s.name, s]));
    const importedSkills = a.skills.map((n) => skillsByName.get(n) ?? { name: n, description: "", body: "" });
    // ADR-0175 A6: a bundle's skill bodies are scanned before anything is
    // created; one refused body refuses the whole import
    for (const sk of importedSkills) {
      const badName = skillNameRefusal(sk.name);
      if (badName) return reply.status(422).send(badName);
      const admission = admitSkillText(sk);
      if (admission.state === "refused") {
        await auditSkillAdmission(db, { userId: viewer.userId, skillId: null, name: sk.name, admission, trigger: "bundle" });
        return reply.status(422).send(skillRefusalBody(sk.name, admission.scan));
      }
    }
    const tooLarge = promptTooLarge(configuredPrompt({ instructions: a.instructions, name: a.name, description: a.description }, importedSkills));
    if (tooLarge) return reply.status(422).send(tooLarge);
    // the model: the bundle's binding by name if the importer may use it
    let model: AgentRow | null = null;
    if (a.model) {
      const [m] = await db.select().from(agents).where(eq(agents.name, a.model.name));
      if (m && (await modelAllowed(db, viewer.userId, m))) model = m;
    }
    model ??= await defaultModelFor(db, viewer.userId);

    // tools: re-resolved by name and re-entitled for the IMPORTER
    const dropped: Array<{ kind: string; name: string; reason: "not_found" | "not_entitled" }> = [];
    const keep: Array<{ kind: "connector" | "mcp_tool"; refId: string; requiresApproval: boolean }> = [];
    const okConnectors = await entitledConnectorIds(db, viewer.userId);
    for (const t of a.tools) {
      const label = t.kind === "mcp_tool" && t.server ? `${t.server}/${t.name}` : t.name;
      if (t.kind === "connector") {
        const [c] = await db.select({ id: connectors.id }).from(connectors).where(eq(connectors.name, t.name));
        if (!c) dropped.push({ kind: t.kind, name: label, reason: "not_found" });
        else if (!okConnectors.has(c.id)) dropped.push({ kind: t.kind, name: label, reason: "not_entitled" });
        else keep.push({ kind: "connector", refId: c.id, requiresApproval: t.requiresApproval });
      } else {
        const [m] = t.server
          ? await db
              .select({ id: mcpTools.id })
              .from(mcpTools)
              .innerJoin(mcpServers, eq(mcpTools.serverId, mcpServers.id))
              .where(and(eq(mcpTools.name, t.name), eq(mcpServers.name, t.server)))
          : [];
        if (!m) {
          dropped.push({ kind: t.kind, name: label, reason: "not_found" });
          continue;
        }
        const info = await loadMcpTools(db, [m.id]);
        if (!(await entitledMcpToolIds(db, viewer.userId, info)).has(m.id)) {
          dropped.push({ kind: t.kind, name: label, reason: "not_entitled" });
        } else keep.push({ kind: "mcp_tool", refId: m.id, requiresApproval: t.requiresApproval });
      }
    }
    const [agent] = await db
      .insert(builderAgents)
      .values({
        name: a.name,
        description: a.description,
        color: paletteOr(a.color, a.name),
        ownerUserId: viewer.userId,
        sharing: "private",
        modelAgentId: model?.id ?? null,
        instructions: a.instructions,
        connectionFormat: a.connectionFormat,
        computerUse: a.computerUse,
        monthlyLimitUsd: a.monthlyLimitUsd,
        projectId: projectId!,
      })
      .returning();
    const uniqKeep = [...new Map(keep.map((k) => [`${k.kind}:${k.refId}`, k])).values()];
    if (uniqKeep.length) await db.insert(builderAgentTools).values(uniqKeep.map((k) => ({ ...k, agentId: agent!.id })));
    await applySeed(db, agent!, {
      instructions: a.instructions,
      skills: importedSkills,
      subagents: a.subagents,
      schedules: a.schedules,
    }, "bundle");
    await audit(db, viewer.userId, "builder_agent", agent!.id, "builder-agent-imported",
      `builder agent '${agent!.name}' imported (${uniqKeep.length} tool(s) kept, ${dropped.length} dropped)`,
      { dropped, modelAgentId: model?.id ?? null });
    return reply.status(201).send({ agent: await agentDetail(db, agent!, viewer), dropped });
  });

  // --- chat, threads, inbox ------------------------------------------------------

  app.post("/v1/builder/agents/:id/chat", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const body = builderChatSchema.parse(req.body ?? {});
    const agent = await visible(req, reply, viewer);
    if (!agent) return;
    const out = await runBuilderTurn(db, opts.dataKey, {
      agent,
      userId: viewer.userId,
      isAdmin: viewer.isAdmin,
      message: body.message,
      threadId: body.threadId,
      source: "chat",
      virtualKey: await loadVirtualKeyContext(db, req),
    });
    if (!out.ok) {
      return reply.status(out.status).send({
        error: out.error,
        ...(out.detail ? { detail: out.detail } : {}),
        ...(out.threadId ? { threadId: out.threadId } : {}),
      });
    }
    const [thread] = await threadSummaries(db, [out.thread]);
    const steps = out.steps ?? [];
    return {
      thread,
      messages: out.messages.map((m) => messageView(m, steps)),
      pending: out.pending ? pendingView(out.pending, steps) : null,
    };
  });

  /** the pause a turn stopped on, as the thread shows it — with the step
   * itself, so the confirmation shows the exact (redacted) arguments */
  const pendingView = (p: TurnPending, steps: BuilderToolStepRow[]) => {
    const step = steps.find((s) => s.id === p.stepId);
    return {
      stepId: p.stepId,
      status: p.status,
      toolName: p.toolName,
      displayName: p.displayName,
      approvalId: p.approvalId,
      approverName: p.approverName,
      ...(step ? { step: stepView(step) } : {}),
    };
  };

  app.get("/v1/builder/threads", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const q = builderThreadListQuerySchema.parse(req.query ?? {});
    const where = [eq(builderThreads.userId, viewer.userId)];
    if (q.status !== "all") where.push(eq(builderThreads.status, q.status));
    if (q.agentId) where.push(eq(builderThreads.agentId, q.agentId));
    const rows = await db
      .select()
      .from(builderThreads)
      .where(and(...where))
      .orderBy(desc(builderThreads.updatedAt))
      .limit(200);
    return { threads: await threadSummaries(db, rows) };
  });

  const ownThread = async (req: FastifyRequest, reply: FastifyReply, viewer: Viewer) => {
    const { id } = idParam.parse(req.params);
    const [t] = await db.select().from(builderThreads).where(eq(builderThreads.id, id));
    // threads are personal (like conversations): someone else's reads as unknown
    if (!t || t.userId !== viewer.userId) {
      void reply.status(404).send({ error: "unknown_thread" });
      return null;
    }
    return t;
  };

  app.get("/v1/builder/threads/:id", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const t = await ownThread(req, reply, viewer);
    if (!t) return;
    // a pause on an approval that lapsed (expired, superseded) ends on read
    if (await settleLapsedApprovalPause(db, t)) {
      const [fresh] = await db.select().from(builderThreads).where(eq(builderThreads.id, t.id));
      return threadDetail(fresh ?? t);
    }
    return threadDetail(t);
  });

  /** a thread with every message, each carrying its tool steps, and the
   * pending step (if the turn is paused) with who it waits on */
  const threadDetail = async (t: BuilderThreadRow) => {
    const [msgs, steps] = await Promise.all([
      db.select().from(builderMessages).where(eq(builderMessages.threadId, t.id)).orderBy(asc(builderMessages.createdAt)),
      threadSteps(db, t.id),
    ]);
    const [thread] = await threadSummaries(db, [t]);
    const waiting = steps.find((s) => s.status === "pending_confirmation" || s.status === "pending_approval") ?? null;
    let approverName: string | null = null;
    if (waiting?.approvalId) {
      const [row] = await db
        .select({ name: users.displayName, email: users.email })
        .from(approvals)
        .innerJoin(users, eq(approvals.approverUserId, users.id))
        .where(eq(approvals.id, waiting.approvalId));
      approverName = row ? row.name || row.email : null;
    }
    return {
      thread,
      messages: msgs.map((m) => messageView(m, steps)),
      pending: waiting
        ? {
            stepId: waiting.id,
            status: waiting.status as TurnPending["status"],
            toolName: waiting.name,
            displayName: waiting.displayName,
            approvalId: waiting.approvalId,
            approverName,
            step: stepView(waiting),
          }
        : null,
    };
  };

  // ADR-0173 §1 — the thread owner answers an "Ask first" pause. A
  // CONFIRMATION, not an approval: only the person the turn runs as decides,
  // with the exact (redacted) arguments in front of them; the call then runs
  // through the governed path like any other (which may still require an
  // organisation approval).
  app.post("/v1/builder/threads/:id/steps/:stepId/confirm", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const { stepId } = stepParam.parse(req.params);
    const body = builderConfirmStepSchema.parse(req.body ?? {});
    const t = await ownThread(req, reply, viewer);
    if (!t) return;
    const out = await resumeBuilderStep(db, opts.dataKey, {
      threadId: t.id,
      stepId,
      via: "confirmation",
      decision: body.decision,
      deciderUserId: viewer.userId,
    });
    const [fresh] = await db.select().from(builderThreads).where(eq(builderThreads.id, t.id));
    if (!out.ok) {
      return reply.status(out.status).send({
        error: out.error,
        ...(out.detail ? { detail: out.detail } : {}),
        ...(fresh ? await threadDetail(fresh) : {}),
      });
    }
    return threadDetail(fresh ?? out.thread);
  });

  // ADR-0173 review — the way out of a pause nobody will answer: the thread's
  // person (or an admin) cancels the pending step. Nothing runs; the paused
  // turn is cleared, a note is written, a pending approval it waited on is
  // superseded, and the act is audited.
  app.post("/v1/builder/threads/:id/steps/:stepId/cancel", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const { id, stepId } = stepParam.parse(req.params);
    const out = await cancelBuilderStep(db, { threadId: id, stepId, actorUserId: viewer.userId, actorIsAdmin: viewer.isAdmin });
    const [fresh] = await db.select().from(builderThreads).where(eq(builderThreads.id, id));
    if (!out.ok) {
      return reply.status(out.status).send({
        error: out.error,
        ...(out.detail ? { detail: out.detail } : {}),
        // someone else's thread reads as unknown: nothing of it is returned
        ...(fresh && out.status !== 404 && (fresh.userId === viewer.userId || viewer.isAdmin) ? await threadDetail(fresh) : {}),
      });
    }
    return threadDetail(fresh ?? out.thread);
  });

  app.patch("/v1/builder/threads/:id", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const body = builderUpdateThreadSchema.parse(req.body ?? {});
    const t = await ownThread(req, reply, viewer);
    if (!t) return;
    const [row] = await db
      .update(builderThreads)
      .set({ status: body.status, updatedAt: new Date() })
      .where(eq(builderThreads.id, t.id))
      .returning();
    const [thread] = await threadSummaries(db, [row!]);
    return { thread };
  });

  // --- skills library ---------------------------------------------------------

  const skillView = async (rows: BuilderSkillRow[], viewer: Viewer) => {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const minDays = await minReleaseAgeDays(db);
    const releases = await Promise.all(
      rows.map((r) => (minDays > 0 ? skillReleaseStatus(db, r.id, r.contentDigest, minDays) : Promise.resolve(null))),
    );
    const [names, used] = await Promise.all([
      userNames(db, rows.map((r) => r.ownerUserId)),
      db
        .select({ skillId: builderAgentSkills.skillId, n: count() })
        .from(builderAgentSkills)
        .innerJoin(builderAgents, eq(builderAgentSkills.agentId, builderAgents.id))
        .where(and(inArray(builderAgentSkills.skillId, ids), isNull(builderAgents.archivedAt)))
        .groupBy(builderAgentSkills.skillId),
    ]);
    const usedBy = new Map(used.map((u) => [u.skillId, Number(u.n)]));
    return rows.map((s, i) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      visibility: s.visibility,
      ownerName: names.get(s.ownerUserId) ?? null,
      usedBy: usedBy.get(s.id) ?? 0,
      updatedAt: s.updatedAt.toISOString(),
      canEdit: viewer.isAdmin || s.ownerUserId === viewer.userId,
      // ADR-0175 A6/A5 — integrity, verdict, pending widening, cooldown
      version: s.version,
      contentDigest: s.contentDigest,
      admissionState: s.admissionState,
      requestedVisibility: s.requestedVisibility,
      ...(viewer.isAdmin || s.ownerUserId === viewer.userId
        ? {
            admissionSeverity: s.admissionSeverity,
            admissionFindings: (s.admissionFindings as McpAdmissionFinding[] | null) ?? [],
          }
        : {}),
      release: releases[i] ? { quarantined: releases[i]!.quarantined, readyAt: releases[i]!.readyAt, ageDays: releases[i]!.ageDays } : null,
    }));
  };

  const visibleSkill = async (req: FastifyRequest, reply: FastifyReply, viewer: Viewer, forEdit: boolean) => {
    const { id } = idParam.parse(req.params);
    const [s] = await db.select().from(builderSkills).where(eq(builderSkills.id, id));
    if (!s || !skillVisible(s, viewer)) {
      void reply.status(404).send({ error: "unknown_skill" });
      return null;
    }
    if (forEdit && !(viewer.isAdmin || s.ownerUserId === viewer.userId)) {
      void reply.status(403).send({ error: "not_skill_editor", detail: "only the skill's owner or an admin can change it" });
      return null;
    }
    return s;
  };

  app.get("/v1/builder/skills", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const rows = await db
      .select()
      .from(builderSkills)
      .where(
        viewer.isAdmin
          ? isNull(builderSkills.archivedAt)
          : and(
              isNull(builderSkills.archivedAt),
              or(eq(builderSkills.ownerUserId, viewer.userId), eq(builderSkills.visibility, "workspace")),
            ),
      )
      .orderBy(asc(builderSkills.name));
    return { skills: await skillView(rows, viewer) };
  });

  /** ADR-0175: a non-admin's widening is a REQUEST an admin decides; an
   * admin's is applied. Narrowing is never gated. */
  const visibilityFor = (viewer: Viewer, want: "private" | "workspace") =>
    want === "workspace" && !viewer.isAdmin
      ? { visibility: "private" as const, requestedVisibility: "workspace" as const, visibilityRequestedAt: new Date() }
      : { visibility: want, requestedVisibility: null, visibilityRequestedAt: null };

  /** null on success (with the created view), else the refusal already sent */
  const createSkill = async (
    viewer: Viewer,
    s: { name: string; description: string; body: string; visibility: "private" | "workspace" },
    ruleId: string,
    trigger: "create" | "import",
  ): Promise<{ ok: true; skill: Record<string, unknown> } | { ok: false; status: number; body: Record<string, unknown> }> => {
    const badName = skillNameRefusal(s.name);
    if (badName) return { ok: false, status: 422, body: badName };
    // ADR-0175 A6 — scan before anything is stored
    const admission = admitSkillText(s);
    if (admission.state === "refused") {
      await auditSkillAdmission(db, { userId: viewer.userId, skillId: null, name: s.name, admission, trigger });
      return { ok: false, status: 422, body: skillRefusalBody(s.name, admission.scan) };
    }
    const vis = visibilityFor(viewer, s.visibility);
    const [row] = await db
      .insert(builderSkills)
      .values({ ...s, ...vis, ownerUserId: viewer.userId, version: 1, ...admissionColumns(admission) })
      .returning();
    await sightSkill(db, row!.id, admission.digest);
    await audit(db, viewer.userId, "builder_skill", row!.id, ruleId, `skill '${row!.name}' added to the library (${row!.visibility})`, {
      visibility: row!.visibility,
      requestedVisibility: row!.requestedVisibility,
      version: 1,
      digest: admission.digest,
      admissionState: admission.state,
    });
    await auditSkillAdmission(db, { userId: viewer.userId, skillId: row!.id, name: row!.name, admission, trigger });
    if (vis.requestedVisibility) {
      await audit(db, viewer.userId, "builder_skill", row!.id, "builder-skill-visibility-requested",
        `widening skill '${row!.name}' to workspace is waiting for an admin`, { requested: "workspace" });
    }
    const [view] = await skillView([row!], viewer);
    return { ok: true, skill: { ...view!, body: row!.body } };
  };

  app.post("/v1/builder/skills", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const body = builderCreateSkillSchema.parse(req.body ?? {});
    const out = await createSkill(viewer, body, "builder-skill-created", "create");
    if (!out.ok) return reply.status(out.status).send(out.body);
    return reply.status(201).send({ skill: out.skill });
  });

  app.post("/v1/builder/skills/import", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const { markdown } = builderImportSkillSchema.parse(req.body ?? {});
    const parsed = parseSkillMarkdown(markdown);
    if (!parsed) {
      return reply.status(422).send({
        error: "skill_frontmatter_missing",
        detail: "a SKILL.md starts with a --- block that names the skill (name: …) and describes it (description: …)",
      });
    }
    if (parsed.body.length > 20_000) return reply.status(422).send({ error: "skill_body_too_long" });
    const out = await createSkill(viewer, { ...parsed, visibility: "private" }, "builder-skill-imported", "import");
    if (!out.ok) return reply.status(out.status).send(out.body);
    return reply.status(201).send({ skill: out.skill });
  });

  app.get("/v1/builder/skills/:id", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const s = await visibleSkill(req, reply, viewer, false);
    if (!s) return;
    const [view] = await skillView([s], viewer);
    return { skill: { ...view!, body: s.body } };
  });

  app.patch("/v1/builder/skills/:id", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const body = builderUpdateSkillSchema.parse(req.body ?? {});
    const s = await visibleSkill(req, reply, viewer, true);
    if (!s) return;
    if (body.name !== undefined) {
      const badName = skillNameRefusal(body.name);
      if (badName) return reply.status(422).send(badName);
    }
    const set: Partial<typeof builderSkills.$inferInsert> = { updatedAt: new Date() };
    for (const k of ["name", "description", "body"] as const) {
      if (body[k] !== undefined) (set as Record<string, unknown>)[k] = body[k];
    }
    // ADR-0175 A6 — any change to scanned text is re-scanned. The NAME and the
    // body are the prompt text (`skillPromptSection`): a change to either is a
    // new version with a new digest (and, under A5, a new release), and the
    // agents that pinned the old text see "update available". A description
    // is scanned text too, but not prompt text: no new version.
    const next = { name: body.name ?? s.name, description: body.description ?? s.description, body: body.body ?? s.body };
    const promptChanged = next.name !== s.name || next.body !== s.body;
    const textChanged = promptChanged || next.description !== s.description;
    let admission: ReturnType<typeof admitSkillText> | null = null;
    if (textChanged) {
      admission = admitSkillText(next, s.admittedDigest);
      if (admission.state === "refused") {
        await auditSkillAdmission(db, { userId: viewer.userId, skillId: s.id, name: next.name, admission, trigger: "update", previousState: s.admissionState });
        return reply.status(422).send(skillRefusalBody(next.name, admission.scan));
      }
      // the digest is of exactly the name and body this update stores (the
      // update below is conditional on nothing else having changed them)
      Object.assign(set, admissionColumns(admission));
      if (promptChanged) set.version = s.version + 1;
    }
    // ADR-0175 — visibility: narrowing applies (and withdraws any request);
    // a non-admin's widening becomes a request for an admin
    let requested = false;
    if (body.visibility !== undefined) {
      if (body.visibility === "private") Object.assign(set, { visibility: "private", requestedVisibility: null, visibilityRequestedAt: null });
      else if (body.visibility !== s.visibility && body.visibility !== s.requestedVisibility) {
        const vis = visibilityFor(viewer, body.visibility);
        Object.assign(set, vis);
        requested = vis.requestedVisibility !== null;
      }
    }
    // ADR-0175 review fix — OPTIMISTIC CONCURRENCY. The verdict and digest
    // above are for the row as it was read; the write lands only if the row
    // still has that digest and that updated_at (to the millisecond a JS Date
    // carries). Otherwise a concurrent save has moved it and this one would
    // store a verdict for text it never scanned: 409, nothing written.
    const [row] = await db
      .update(builderSkills)
      .set(set)
      .where(
        and(
          eq(builderSkills.id, s.id),
          eq(builderSkills.contentDigest, s.contentDigest),
          sql`abs(extract(epoch from (${builderSkills.updatedAt} - ${s.updatedAt.toISOString()}::timestamptz))) < 0.001`,
        ),
      )
      .returning();
    if (!row) {
      return reply.status(409).send({
        error: "skill_changed_concurrently",
        detail: `skill '${s.name}' was changed by another save while this one was being checked; reload it and try again`,
      });
    }
    if (admission && promptChanged) await sightSkill(db, s.id, admission.digest);
    await audit(db, viewer.userId, "builder_skill", s.id, "builder-skill-updated",
      `skill '${row.name}' updated (${Object.keys(body).join(", ")})`, {
        fields: Object.keys(body),
        version: row.version,
        digest: row.contentDigest,
        ...(promptChanged ? { fromVersion: s.version, fromDigest: s.contentDigest } : {}),
        ...(next.name !== s.name ? { renamedFrom: s.name } : {}),
        admissionState: row.admissionState,
      });
    if (admission) await auditSkillAdmission(db, { userId: viewer.userId, skillId: s.id, name: row.name, admission, trigger: "update", previousState: s.admissionState });
    if (requested) {
      await audit(db, viewer.userId, "builder_skill", s.id, "builder-skill-visibility-requested",
        `widening skill '${row.name}' to workspace is waiting for an admin`, { requested: "workspace" });
    }
    const [view] = await skillView([row!], viewer);
    return { skill: { ...view!, body: row!.body } };
  });

  app.delete("/v1/builder/skills/:id", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const s = await visibleSkill(req, reply, viewer, true);
    if (!s) return;
    await db.update(builderSkills).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(builderSkills.id, s.id));
    await audit(db, viewer.userId, "builder_skill", s.id, "builder-skill-deleted", `skill '${s.name}' removed from the library`);
    return reply.status(204).send();
  });

  // --- templates, integrations, usage ------------------------------------------

  app.get("/v1/builder/templates", async (req, reply) => {
    if (!viewerOf(req, reply)) return;
    return { templates: BUILDER_TEMPLATES };
  });

  app.get("/v1/builder/templates/:id", async (req, reply) => {
    if (!viewerOf(req, reply)) return;
    const { id } = templateParam.parse(req.params);
    const template = findTemplate(id);
    if (!template) return reply.status(404).send({ error: "unknown_template" });
    return { template };
  });

  // the connectors and MCP tools the CALLER may add to a toolbox — the same
  // entitlement helpers the PUT …/tools check uses, so the Add connection
  // dialog never offers something the save would refuse
  app.get("/v1/builder/toolbox-options", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    return { options: await toolboxOptionsFor(db, viewer.userId) };
  });

  app.get("/v1/builder/integrations", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const [connectorRows, allServers, chatops, toolCounts, granted] = await Promise.all([
      db.select({ name: connectors.name, kind: connectors.kind, providerKind: connectors.providerKind }).from(connectors),
      db.select({ id: mcpServers.id, name: mcpServers.name }).from(mcpServers).orderBy(asc(mcpServers.name)),
      db.select({ provider: chatopsConnections.provider }).from(chatopsConnections).where(eq(chatopsConnections.enabled, true)),
      db.select({ serverId: mcpTools.serverId, n: count() }).from(mcpTools).groupBy(mcpTools.serverId),
      viewer.isAdmin ? Promise.resolve(null) : grantedMcpServerIds(db, viewer.userId),
    ]);
    // MCP servers are named only to someone holding a grant on them (admins: all)
    const serverRows = granted ? allServers.filter((sv) => granted.has(sv.id)) : allServers;
    const chatopsProviders = new Set(chatops.map((c) => c.provider as string));
    const connected = (kind: string, match: string[]) => {
      if (kind === "chatops") return match.some((m) => chatopsProviders.has(m));
      if (kind === "mcp") return serverRows.some((s) => match.some((m) => s.name.toLowerCase().includes(m)));
      return connectorRows.some((c) =>
        match.some(
          (m) =>
            c.kind.toLowerCase() === m || (c.providerKind ?? "").toLowerCase() === m || c.name.toLowerCase().includes(m),
        ),
      );
    };
    const counts = new Map(toolCounts.map((t) => [t.serverId, Number(t.n)]));
    return {
      groups: BUILDER_INTEGRATION_GROUPS.map((g) => ({
        name: g.name,
        items: g.items.map((i) => ({
          key: i.key,
          name: i.name,
          description: i.description,
          category: i.category,
          status: connected(i.kind, i.match) ? ("connected" as const) : ("available" as const),
          connectHref: CONNECT_HREF[i.kind],
          kind: i.kind,
        })),
      })),
      custom: { mcpServers: serverRows.map((s) => ({ id: s.id, name: s.name, toolCount: counts.get(s.id) ?? 0 })) },
    };
  });

  app.get("/v1/builder/usage", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const { days } = builderUsageQuerySchema.parse(req.query ?? {});
    const now = new Date();
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
    const scope = [gte(builderMessages.createdAt, since), eq(builderMessages.role, "agent")];
    // ADR-0173: governed tool calls are spend too, under the same scope
    const toolScope = [gte(builderToolSteps.createdAt, since)];
    if (!viewer.isAdmin) {
      const owned = await db
        .select({ id: builderAgents.id })
        .from(builderAgents)
        .where(eq(builderAgents.ownerUserId, viewer.userId));
      const ownedIds = owned.map((o) => o.id);
      scope.push(
        ownedIds.length
          ? or(eq(builderMessages.userId, viewer.userId), inArray(builderMessages.agentId, ownedIds))!
          : eq(builderMessages.userId, viewer.userId),
      );
      toolScope.push(
        ownedIds.length
          ? or(eq(builderToolSteps.userId, viewer.userId), inArray(builderToolSteps.agentId, ownedIds))!
          : eq(builderToolSteps.userId, viewer.userId),
      );
    }
    const where = and(...scope);
    const toolWhere = and(...toolScope);
    const toolSpend = sql<number>`coalesce(sum(${builderToolSteps.costUsd}), 0)::float8`;
    const toolDay = sql<string>`to_char(${builderToolSteps.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
    const [toolTotals, toolByAgent, toolByUser, toolDaily] = await Promise.all([
      db.select({ spendUsd: toolSpend }).from(builderToolSteps).where(toolWhere),
      db.select({ agentId: builderToolSteps.agentId, spendUsd: toolSpend }).from(builderToolSteps).where(toolWhere).groupBy(builderToolSteps.agentId),
      db.select({ userId: builderToolSteps.userId, spendUsd: toolSpend }).from(builderToolSteps).where(toolWhere).groupBy(builderToolSteps.userId),
      db.select({ date: toolDay, spendUsd: toolSpend }).from(builderToolSteps).where(toolWhere).groupBy(toolDay),
    ]);
    const toolAgentBy = new Map(toolByAgent.map((x) => [x.agentId, Number(x.spendUsd)]));
    const toolUserBy = new Map(toolByUser.map((x) => [x.userId, Number(x.spendUsd)]));
    const toolDayBy = new Map(toolDaily.map((x) => [x.date, Number(x.spendUsd)]));
    const spend = sql<number>`coalesce(sum(${builderMessages.costUsd}), 0)::float8`;
    const day = sql<string>`to_char(${builderMessages.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
    const [totals, byAgent, byUser, byModel, daily] = await Promise.all([
      db
        .select({
          spendUsd: spend,
          messages: count(),
          agents: sql<number>`count(distinct ${builderMessages.agentId})::int`,
          activeUsers: sql<number>`count(distinct ${builderMessages.userId})::int`,
        })
        .from(builderMessages)
        .where(where),
      db
        .select({ agentId: builderMessages.agentId, spendUsd: spend, messages: count() })
        .from(builderMessages)
        .where(where)
        .groupBy(builderMessages.agentId),
      db
        .select({ userId: builderMessages.userId, spendUsd: spend, messages: count() })
        .from(builderMessages)
        .where(where)
        .groupBy(builderMessages.userId),
      db
        .select({ provider: builderMessages.provider, model: builderMessages.model, spendUsd: spend, messages: count() })
        .from(builderMessages)
        .where(where)
        .groupBy(builderMessages.provider, builderMessages.model),
      db
        .select({ date: day, spendUsd: spend, messages: count() })
        .from(builderMessages)
        .where(where)
        .groupBy(day),
    ]);
    const agentRows = byAgent.length
      ? await db
          .select({ id: builderAgents.id, name: builderAgents.name, limitUsd: builderAgents.monthlyLimitUsd })
          .from(builderAgents)
          .where(inArray(builderAgents.id, byAgent.map((a) => a.agentId)))
      : [];
    const agentBy = new Map(agentRows.map((a) => [a.id, a]));
    const names = await userNames(db, byUser.map((u) => u.userId));
    const round = (n: unknown) => Number(Number(n ?? 0).toFixed(6));
    const dailyBy = new Map(daily.map((d) => [d.date, d]));
    const series = Array.from({ length: days }, (_, i) => {
      const d = new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      const row = dailyBy.get(d);
      return { date: d, spendUsd: round(Number(row?.spendUsd ?? 0) + (toolDayBy.get(d) ?? 0)), messages: Number(row?.messages ?? 0) };
    });
    const bySpend = <T extends { spendUsd: number }>(a: T, b: T) => b.spendUsd - a.spendUsd;
    return {
      totals: {
        spendUsd: round(Number(totals[0]?.spendUsd ?? 0) + Number(toolTotals[0]?.spendUsd ?? 0)),
        toolSpendUsd: round(toolTotals[0]?.spendUsd),
        messages: Number(totals[0]?.messages ?? 0),
        agents: Number(totals[0]?.agents ?? 0),
        activeUsers: Number(totals[0]?.activeUsers ?? 0),
      },
      byAgent: byAgent
        .map((a) => ({
          agentId: a.agentId,
          name: agentBy.get(a.agentId)?.name ?? "Agent",
          spendUsd: round(Number(a.spendUsd) + (toolAgentBy.get(a.agentId) ?? 0)),
          messages: Number(a.messages),
          limitUsd: agentBy.get(a.agentId)?.limitUsd ?? null,
        }))
        .sort(bySpend),
      byUser: byUser
        .map((u) => ({ userId: u.userId, name: names.get(u.userId) ?? "Unknown person", spendUsd: round(Number(u.spendUsd) + (toolUserBy.get(u.userId) ?? 0)), messages: Number(u.messages) }))
        .sort(bySpend),
      byModel: byModel
        .map((m) => ({ provider: m.provider ?? "unknown", model: m.model ?? "unknown", spendUsd: round(m.spendUsd), messages: Number(m.messages) }))
        .sort(bySpend),
      daily: series,
    };
  });
}
