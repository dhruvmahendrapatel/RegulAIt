/**
 * ADR-0316 (lane E4, pillar 4) — distil a governed agent session into the Shared Project context store.
 *
 * A session is a person's own conversation thread attributed to a project. Its author asks for a distillation at a
 * checkpoint or when the session ends. One governed, metered dispatch turns the session's turns since the last
 * checkpoint (plus the previous distilled text, so earlier turns are never re-read) into a short context entry, and
 * that entry is written as an ordinary revision of the key `session/<conversationId>` through the ONE context write
 * path (`writeContextRevision` in projects.ts): contributor role, archived refusal, read-before-write and the named
 * arbiter's conflict path all apply unchanged. Its provenance (source session, author, agents, turns read, declared
 * context inputs, timestamps) is written in the same transaction.
 *
 * Non-negotiables:
 * - OFF by default per project (ADR-0180). Only an admin turns it on, with a `settings_relax` step-up, audited.
 * - Only the session's author distils it: a conversation is personal, admins included. Partial sharing stays opt-in:
 *   the author chooses the checkpoint (`throughMessageId`) and nothing is distilled without their request.
 * - The dispatch is the author's own: their agent decision (chat feature matrix) is taken first, and
 *   `executeGovernedDispatch` bills it to the session's project (pillar 5), applies the compliance cascade's PII mode
 *   on input and output (pillar 3) and the governed core's optimisation (pillar 6). Denied turns are never sent.
 * - A reader sees the result only while they could read what it was derived from (session-distillation-access.ts).
 */
import type { FastifyInstance } from "fastify";
import {
  agents,
  auditLog,
  desc,
  eq,
  projectContextDistillationAgents,
  projectContextDistillationContextInputs,
  projectContextDistillationMessages,
  projectContextDistillations,
  projectContextItems,
  projects,
  projectSessionDistillationPolicies,
  and,
  inArray,
  type Db,
} from "@regulait/db";
import { z } from "zod";
import { agentDecision } from "./copilot.js";
import { executeGovernedDispatch, type AgentRow } from "./agents-connectors.js";
import { loadOwnConversationForReplay, type StoredConversationMessage } from "./conversations.js";
import { projectArchivedRefusal } from "./project-archive.js";
import type { registerProjectRoutes } from "./projects.js";
import { hiddenDistilledItems, mayReadDerivedContent } from "./session-distillation-access.js";
import { requireStepUp } from "./step-up.js";

type ProjectRouteHandles = ReturnType<typeof registerProjectRoutes>;

export const SESSION_DISTILLATION_RULE_IDS = {
  enabled: "session-distillation-enabled",
  disabled: "session-distillation-disabled",
  distilled: "session-distilled",
  refused: "session-distillation-refused",
} as const;

/** the context key a session's distillations are revisions of */
export const sessionContextKey = (conversationId: string) => `session/${conversationId}`;

const MAX_CONTEXT_INPUTS = 20;
/** the audit row's user when the bootstrap token (no user row) changes the switch, as project-archive.ts records it */
const NIL_USER = "00000000-0000-0000-0000-000000000000";
const DISTILLED_MAX_TOKENS = 1024;

const DISTIL_SYSTEM = [
  "You distil a working session between a person and an AI agent into shared project context for teammates.",
  "Keep decisions and their reasons, constraints, open questions, names and numbers. Drop small talk and anything",
  "that only mattered in the moment. Write short plain sentences or bullets. Reply with only the distilled text.",
].join("\n");

const projectIdParam = z.object({ projectId: z.string().uuid() });
const conversationIdParam = z.object({ conversationId: z.string().uuid() });
const policyBody = z.object({ enabled: z.boolean() }).strict();
const distilBody = z
  .object({
    /** the checkpoint: distil the turns after the last checkpoint up to and including this one (default: all) */
    throughMessageId: z.string().uuid().optional(),
    /** shared context revisions the session drew on; each must be readable by the author */
    contextInputItemIds: z.array(z.string().uuid()).max(MAX_CONTEXT_INPUTS).optional(),
    /** the agent that distils; default the session's own agent. Decided as the author like any chat turn */
    agentId: z.string().uuid().optional(),
  })
  .strict();

const isDenied = (m: StoredConversationMessage) => Boolean((m.detail as { denied?: boolean } | null)?.denied);
const servedAgentOf = (m: StoredConversationMessage): string | null => {
  const id = (m.detail as { servedAgentId?: unknown } | null)?.servedAgentId;
  return typeof id === "string" && z.string().uuid().safeParse(id).success ? id : null;
};

/** thrown inside the write transaction to roll the revision back with a clean refusal */
class DistillationRefusal extends Error {
  constructor(
    readonly status: number,
    readonly body: { error: string; detail: string },
  ) {
    super(body.error);
  }
}

export async function sessionDistillationEnabled(db: Db, projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: projectSessionDistillationPolicies.enabled })
    .from(projectSessionDistillationPolicies)
    .where(eq(projectSessionDistillationPolicies.projectId, projectId));
  return row?.enabled === true;
}

export function registerSessionDistillationRoutes(
  app: FastifyInstance,
  db: Db,
  handles: ProjectRouteHandles,
  opts: { dataKey?: string | undefined } = {},
): void {
  const { writeContextRevision, requireRole } = handles;

  app.get("/v1/projects/:projectId/session-distillation", async (req, reply) => {
    const { projectId } = projectIdParam.parse(req.params);
    const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
    if (!project) return reply.status(404).send({ error: "unknown_project" });
    const gate = await requireRole(req, projectId, "viewer");
    if (!gate.ok) return reply.status(gate.status).send({ error: gate.error });
    const [row] = await db
      .select()
      .from(projectSessionDistillationPolicies)
      .where(eq(projectSessionDistillationPolicies.projectId, projectId));
    return {
      projectId,
      enabled: row?.enabled === true,
      updatedAt: row?.updatedAt ?? null,
      updatedByUserId: row?.updatedByUserId ?? null,
    };
  });

  app.put("/v1/projects/:projectId/session-distillation", async (req, reply) => {
    if (!req.authCtx.isAdmin) return reply.status(403).send({ error: "admin_only" });
    const { projectId } = projectIdParam.parse(req.params);
    const parsed = policyBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: "expected { enabled: boolean }" });
    const { enabled } = parsed.data;
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) return reply.status(404).send({ error: "unknown_project" });
    if (enabled && project.archivedAt) {
      const r = projectArchivedRefusal(project.name);
      return reply.status(r.status).send(r.body);
    }
    // turning it on lets session content leave a personal thread: a relaxation, so it takes a step-up
    if (enabled) {
      const su = await requireStepUp(db, req, reply, {
        kind: "settings_relax",
        facts: { op: "session_distillation_enable", projectId },
      });
      if (!su.ok) return reply;
    }
    const actor = req.authCtx.userId ?? null;
    await db.transaction(async (tx) => {
      await tx
        .insert(projectSessionDistillationPolicies)
        .values({ projectId, enabled, updatedByUserId: actor, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: projectSessionDistillationPolicies.projectId,
          set: { enabled, updatedByUserId: actor, updatedAt: new Date() },
        });
      await tx.insert(auditLog).values({
        userId: actor ?? NIL_USER,
        objectType: "project",
        objectId: projectId,
        detail: { phase: "session-distillation-policy", enabled, receiptClass: "decision" },
        effect: "allow",
        ruleId: enabled ? SESSION_DISTILLATION_RULE_IDS.enabled : SESSION_DISTILLATION_RULE_IDS.disabled,
        ruleChain: [],
        reason: enabled
          ? `session distillation turned on for project '${project.name}': members may distil their own sessions into its shared context`
          : `session distillation turned off for project '${project.name}'`,
      });
    });
    return { projectId, enabled };
  });

  app.post("/v1/conversations/:conversationId/distil", async (req, reply) => {
    const { conversationId } = conversationIdParam.parse(req.params);
    const parsed = distilBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues[0]?.message });
    const body = parsed.data;
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_contribute" });

    // own-scoped like every conversation route, admins included; retention-expired or held sessions are refused
    const convo = await loadOwnConversationForReplay(db, conversationId, userId);
    if (!convo.ok) {
      return reply.status(convo.status).send({ error: convo.error, ...(convo.detail ? { detail: convo.detail } : {}) });
    }
    const { conversation, messages } = convo;
    const projectId = conversation.projectId;
    if (!projectId) {
      return reply.status(422).send({
        error: "conversation_not_attributed",
        detail: "only a session attributed to a project can be distilled into that project's shared context",
      });
    }
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) return reply.status(404).send({ error: "unknown_project" });
    if (project.archivedAt) {
      const r = projectArchivedRefusal(project.name);
      return reply.status(r.status).send(r.body);
    }
    if (!(await sessionDistillationEnabled(db, projectId))) {
      return reply.status(409).send({
        error: "session_distillation_disabled",
        detail: "session distillation is off for this project; an admin turns it on",
      });
    }
    // checked before any model spend; the write path checks it again
    const gate = await requireRole(req, projectId, "contributor");
    if (!gate.ok) return reply.status(gate.status).send({ error: gate.error });

    const refuse = async (status: number, error: string, detail: string, extra: Record<string, unknown> = {}) => {
      await db.insert(auditLog).values({
        userId,
        objectType: "project",
        objectId: projectId,
        detail: { phase: "session-distillation", conversationId, error, ...extra, receiptClass: "decision" },
        effect: "deny",
        ruleId: SESSION_DISTILLATION_RULE_IDS.refused,
        ruleChain: [],
        reason: `session distillation refused: ${detail}`,
      });
      return reply.status(status).send({ error, detail });
    };

    // --- the checkpoint: the turns after the last distillation of this session ---------------------------------
    const key = sessionContextKey(conversationId);
    const [previous] = await db
      .select({
        id: projectContextDistillations.id,
        throughMessageId: projectContextDistillations.throughMessageId,
        itemId: projectContextDistillations.contextItemId,
      })
      .from(projectContextDistillations)
      .innerJoin(projectContextItems, eq(projectContextItems.id, projectContextDistillations.contextItemId))
      .where(
        and(
          eq(projectContextDistillations.conversationId, conversationId),
          eq(projectContextItems.projectId, projectId),
          eq(projectContextItems.accepted, true),
        ),
      )
      .orderBy(desc(projectContextItems.revision))
      .limit(1);
    const startIdx = previous ? messages.findIndex((m) => m.id === previous.throughMessageId) + 1 : 0;
    let endIdx = messages.length - 1;
    if (body.throughMessageId) {
      endIdx = messages.findIndex((m) => m.id === body.throughMessageId);
      if (endIdx === -1) return reply.status(422).send({ error: "unknown_message", detail: "throughMessageId is not a turn of this session" });
      if (endIdx < startIdx) {
        return reply.status(409).send({ error: "already_distilled", detail: "that turn is at or before the last checkpoint" });
      }
    }
    const window = messages.slice(startIdx, endIdx + 1);
    const turns = window.filter((m) => !isDenied(m));
    if (turns.length === 0) {
      return reply.status(409).send({ error: "nothing_to_distil", detail: "no new turns since the last checkpoint" });
    }

    // --- the inputs: agents whose output the text carries, and declared shared context ----------------------------
    const [carriedAgents, carriedInputs] = previous
      ? await Promise.all([
          db
            .select({ agentId: projectContextDistillationAgents.agentId })
            .from(projectContextDistillationAgents)
            .where(eq(projectContextDistillationAgents.distillationId, previous.id)),
          db
            .select({ itemId: projectContextDistillationContextInputs.contextItemId })
            .from(projectContextDistillationContextInputs)
            .where(eq(projectContextDistillationContextInputs.distillationId, previous.id)),
        ])
      : [[], []];
    const agentIds = [
      ...new Set([
        conversation.agentId,
        ...turns.map(servedAgentOf).filter((x): x is string => x !== null),
        ...carriedAgents.map((a) => a.agentId),
      ]),
    ];
    const contextInputIds = [...new Set([...(body.contextInputItemIds ?? []), ...carriedInputs.map((i) => i.itemId)])];
    if (!(await mayReadDerivedContent(db, req.authCtx, { agentIds, contextItemIds: contextInputIds }))) {
      return refuse(403, "inputs_not_readable", "the author may no longer use an agent of this session, or cannot read a declared context input", { agentIds, contextInputIds });
    }

    // the previous distilled text rides along so earlier turns are never re-read (cumulative, like compaction)
    let priorText: string | null = null;
    if (previous) {
      const [prior] = await db
        .select({ content: projectContextItems.content })
        .from(projectContextItems)
        .where(eq(projectContextItems.id, previous.itemId));
      priorText = prior?.content ?? null;
    }
    const [head] = await db
      .select({ revision: projectContextItems.revision })
      .from(projectContextItems)
      .where(and(eq(projectContextItems.projectId, projectId), eq(projectContextItems.key, key), eq(projectContextItems.accepted, true)))
      .orderBy(desc(projectContextItems.revision))
      .limit(1);

    // --- the governed dispatch, decided as the author ---------------------------------------------------------------
    const distillerId = body.agentId ?? conversation.agentId;
    const [distillerRow] = await db.select().from(agents).where(eq(agents.id, distillerId));
    if (!distillerRow) return reply.status(404).send({ error: "unknown_agent" });
    const distiller = distillerRow as AgentRow;
    const gateFeature = { feature: "chat" as const };
    const decision = await agentDecision(db, userId, distiller, gateFeature);
    if (decision.effect !== "allow") {
      await db.insert(auditLog).values({
        userId,
        objectType: "agent",
        objectId: distiller.id,
        detail: { purpose: "session-distillation", conversationId, projectId, receiptClass: "decision" },
        effect: "deny",
        ruleId: decision.ruleId,
        ruleChain: decision.ruleChain,
        reason: decision.reason,
      });
      return reply.status(403).send({ error: "distiller_not_allowed", detail: decision.reason });
    }
    // turns are labelled `[role]`, never `role:` at a line start (the forged-turn shape the guardrail blocks; ADR-0181)
    const transcript = turns.map((m) => `[${m.role}] ${m.content}`).join("\n\n");
    const input = priorText ? `Previous distillation:\n${priorText}\n\nNewer turns:\n${transcript}` : transcript;
    const outcome = await executeGovernedDispatch(db, opts.dataKey, {
      userId,
      served: distiller,
      requestedAgentId: distiller.id,
      baseline: null,
      input,
      system: DISTIL_SYSTEM,
      maxTokens: DISTILLED_MAX_TOKENS,
      projectId,
      modelFeature: gateFeature,
      detail: { purpose: "session-distillation", conversationId },
    });
    if (!outcome.ok) {
      return refuse(outcome.status, outcome.error, outcome.detail ?? "the distillation dispatch did not complete");
    }
    if (outcome.result.pii?.withheld) {
      return refuse(422, "distillation_withheld_pii", "the project's PII policy withheld the distilled text; nothing was written");
    }
    const distilled = outcome.result.refusal ? "" : outcome.result.outputText.trim();
    if (!distilled) return refuse(422, "distillation_empty", "the distiller returned no text; nothing was written");
    agentIds.push(...[outcome.result.servedAgentId].filter((id) => !agentIds.includes(id)));

    // --- the write: the one context path, provenance in the same transaction ---------------------------------------
    const sessionStartedAt = messages[0]!.createdAt;
    const last = window[window.length - 1]!;
    let status = 500;
    let sent: unknown = null;
    const capture = {
      status(code: number) {
        status = code;
        return { send: (b: unknown) => ((sent = b), b) };
      },
    };
    try {
      await writeContextRevision(req, capture, projectId, {
        key,
        content: distilled,
        baseRevision: head?.revision,
        teamId: undefined,
        onWritten: async (tx, written) => {
          if (written.conflicting) {
            // a conflicting revision goes to the named arbiter, who reads both texts: only when they could read the inputs
            const arbiter = project.arbiterUserId;
            const arbiterMayRead =
              arbiter !== null && (await mayReadDerivedContent(db, { userId: arbiter, isAdmin: false }, { agentIds, contextItemIds: contextInputIds }));
            if (!arbiterMayRead) {
              throw new DistillationRefusal(409, {
                error: "distillation_conflict_unreadable_by_arbiter",
                detail: "the session's key changed while distilling and the named arbiter could not read this session's inputs; nothing was written, distil again",
              });
            }
          }
          const [row] = await tx
            .insert(projectContextDistillations)
            .values({
              contextItemId: written.itemId,
              conversationId,
              distillerAgentId: outcome.result.servedAgentId,
              fromMessageId: window[0]!.id,
              throughMessageId: last.id,
              sessionStartedAt,
              sessionLastTurnAt: last.createdAt,
            })
            .returning({ id: projectContextDistillations.id });
          await tx.insert(projectContextDistillationMessages).values(turns.map((m) => ({ distillationId: row!.id, messageId: m.id })));
          await tx.insert(projectContextDistillationAgents).values(agentIds.map((agentId) => ({ distillationId: row!.id, agentId })));
          if (contextInputIds.length) {
            await tx
              .insert(projectContextDistillationContextInputs)
              .values(contextInputIds.map((contextItemId) => ({ distillationId: row!.id, contextItemId })));
          }
          await tx.insert(auditLog).values({
            userId,
            objectType: "project",
            objectId: projectId,
            detail: {
              phase: "session-distillation",
              conversationId,
              key,
              revision: written.revision,
              itemId: written.itemId,
              turnsRead: turns.length,
              agentIds,
              contextInputIds,
              distillerAgentId: outcome.result.servedAgentId,
              costUsd: outcome.result.costUsd,
              receiptClass: "decision",
            },
            effect: written.conflicting ? "require_approval" : "allow",
            ruleId: SESSION_DISTILLATION_RULE_IDS.distilled,
            ruleChain: [],
            reason: `${turns.length} session turn(s) distilled into revision ${written.revision} of '${key}'; readers see it only while they could read its inputs`,
          });
        },
      });
    } catch (e) {
      if (e instanceof DistillationRefusal) return refuse(e.status, e.body.error, e.body.detail);
      throw e;
    }
    if (status !== 201) return reply.status(status).send(sent);
    return reply.status(201).send({
      ...(sent as Record<string, unknown>),
      conversationId,
      turnsRead: turns.length,
      throughMessageId: last.id,
    });
  });

  // provenance of one distilled revision, for a reader who may see it
  app.get("/v1/projects/:projectId/context/items/:itemId/distillation", async (req, reply) => {
    const { projectId, itemId } = z.object({ projectId: z.string().uuid(), itemId: z.string().uuid() }).parse(req.params);
    const gate = await requireRole(req, projectId, "viewer");
    if (!gate.ok) return reply.status(gate.status).send({ error: gate.error });
    const [row] = await db
      .select({ d: projectContextDistillations, item: projectContextItems })
      .from(projectContextDistillations)
      .innerJoin(projectContextItems, eq(projectContextItems.id, projectContextDistillations.contextItemId))
      .where(and(eq(projectContextDistillations.contextItemId, itemId), eq(projectContextItems.projectId, projectId)));
    // withheld and unknown answer the same, so the route never confirms what a reader may not see
    if (!row || (await hiddenDistilledItems(db, req.authCtx, [itemId])).has(itemId)) {
      return reply.status(404).send({ error: "unknown_distillation" });
    }
    const [msgs, agentRows, inputRows] = await Promise.all([
      db.select({ id: projectContextDistillationMessages.messageId }).from(projectContextDistillationMessages).where(eq(projectContextDistillationMessages.distillationId, row.d.id)),
      db.select({ id: projectContextDistillationAgents.agentId }).from(projectContextDistillationAgents).where(eq(projectContextDistillationAgents.distillationId, row.d.id)),
      db.select({ id: projectContextDistillationContextInputs.contextItemId }).from(projectContextDistillationContextInputs).where(eq(projectContextDistillationContextInputs.distillationId, row.d.id)),
    ]);
    const agentNames = agentRows.length
      ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentRows.map((a) => a.id)))
      : [];
    const nameOf = new Map(agentNames.map((a) => [a.id, a.name]));
    return {
      itemId,
      key: row.item.key,
      revision: row.item.revision,
      source: {
        conversationId: row.d.conversationId,
        userId: row.item.contributedByUserId,
        teamId: row.item.contributedByTeamId,
        sessionStartedAt: row.d.sessionStartedAt,
        sessionLastTurnAt: row.d.sessionLastTurnAt,
        fromMessageId: row.d.fromMessageId,
        throughMessageId: row.d.throughMessageId,
      },
      distillerAgentId: row.d.distillerAgentId,
      distilledAt: row.d.distilledAt,
      inputs: {
        messageIds: msgs.map((m) => m.id),
        agents: agentRows.map((a) => ({ agentId: a.id, name: nameOf.get(a.id) ?? null })),
        contextItemIds: inputRows.map((i) => i.id),
      },
    };
  });
}
