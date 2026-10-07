import type { FastifyInstance } from "fastify";
import {
  agents,
  and,
  asc,
  conversationMessages,
  auditLog,
  conversations,
  count,
  desc,
  eq,
  gte,
  isNull,
  or,
  projects,
  type Db,
} from "@regulait/db";
import type { ModelChatMessage } from "@regulait/model-provider";
import { createConversationSchema } from "@regulait/shared";
import { z } from "zod";
import { assertProjectAttribution } from "./projects.js";
import { installConversationPresentationScrub } from "./conversation-presentation.js";
import {
  MEMORY_RETENTION_RULE_IDS,
  conversationHeldSql,
  conversationRetentionCutoff,
  conversationRetentionState,
  deleteOwnConversation,
} from "./memory-retention.js";
import { loadOrgSettings } from "./org-settings.js";

/** ADR-0185 I3 — what a person is told about an expired or held conversation */
const EXPIRED_DETAIL = (days: number) =>
  `this conversation was last used more than ${days} days ago, past the organisation's conversation retention, ` +
  `and has been (or is about to be) deleted`;
const HELD_DETAIL =
  "this conversation is kept as evidence for an incident that is not yet closed; it cannot be deleted or continued " +
  "until the incident closes";

/**
 * MULTI-TURN CONVERSATIONS — the storage and access layer behind the
 * Playground's memory. A conversation is strictly PERSONAL: every route here
 * is own-scoped by the authenticated identity, admins included — an admin
 * reads the audit trail and the usage ledger, not other people's threads.
 *
 * Persistence contract (kept identical for streaming and non-streaming
 * dispatches — both call recordConversationTurns after the outcome):
 * - successful dispatch: user turn + assistant turn (dispatch facts in
 *   detail) persist together in one transaction;
 * - model refusal: both turns persist; the assistant turn carries
 *   detail.refusal=true and a refusal marker where outputText is empty;
 * - governance DENIAL (403): the user turn persists with detail.denied so
 *   history shows the attempt honestly — but a denied turn is EXCLUDED from
 *   the model-bound history of later turns (content the governance layer
 *   refused to send must never reach a provider afterwards), and no
 *   assistant turn is written;
 * - dispatch failure (no_model_credential, provider 5xx, budget gate):
 *   NOTHING persists — the turn never reached a model, and a retry after
 *   fixing the config must not leave duplicate user turns behind.
 * conversationId only takes effect on dispatch=true invokes; a decision-only
 * invoke never touches history.
 */

const conversationIdParam = z.object({ conversationId: z.string().uuid() });

export type ConversationRow = typeof conversations.$inferSelect;
export type StoredConversationMessage = typeof conversationMessages.$inferSelect;

export type ConversationContext =
  | {
      ok: true;
      conversation: ConversationRow;
      /** prior turns in order, denied attempts excluded — the FULL model-bound
       * history (compaction.ts decides per dispatch whether a summary replaces
       * the older part of it) */
      history: ModelChatMessage[];
      /** size signal for the optimizer's input-token estimate */
      historyChars: number;
      /** every stored row in order, denied included — compaction planning
       * needs ids and per-message sizes, and must never mutate these */
      messages: StoredConversationMessage[];
    }
  | { ok: false; status: number; error: string; detail?: string };

/**
 * Load a conversation for the INVOKE path: 404 unknown, 403 not the caller's
 * own (admins included), else the row plus its model-bound history.
 *
 * ADR-0112 — THIS LOADER IS FAITHFUL ON PURPOSE, AND THE NAME SAYS SO.
 * What it returns is REPLAY material: `history` becomes the prior turns sent to
 * the model provider on a multi-turn dispatch, and `messages` is what
 * `compaction.ts` summarizes. It must carry the user's ORIGINAL text, marker-
 * free, or the model receives `[redacted:…]` where the question was and the
 * thread starts answering something nobody asked.
 *
 * So: DO NOT scrub here, and do not reuse this for anything a human or a file
 * will see. The owner's ADR-0112 choice — store faithfully, redact what is
 * handed out — is implemented at the presentation boundary instead, by
 * `installConversationPresentationScrub` on the route scope below. Presentation
 * is not replay.
 */
export async function loadOwnConversationForReplay(
  db: Db,
  conversationId: string,
  userId: string,
): Promise<ConversationContext> {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  if (!row) return { ok: false, status: 404, error: "unknown_conversation" };
  if (row.userId !== userId) return { ok: false, status: 403, error: "forbidden" };
  // ADR-0185 I3 — past retention it is not continued: expired and unheld it is
  // gone (404); held, it is incident evidence, and a new turn would both alter
  // it and restart its retention clock (409)
  const retention = await conversationRetentionState(db, row);
  if (retention.expired) {
    return retention.held
      ? { ok: false, status: 409, error: "incident_evidence_hold", detail: HELD_DETAIL }
      : { ok: false, status: 404, error: "conversation_expired", detail: EXPIRED_DETAIL(retention.retentionDays) };
  }
  const msgs = await db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conversationId))
    .orderBy(asc(conversationMessages.createdAt));
  const history: ModelChatMessage[] = msgs
    .filter((m) => !(m.detail as { denied?: boolean } | null)?.denied)
    .map((m) => ({ role: m.role, content: m.content }));
  return {
    ok: true,
    conversation: row,
    history,
    historyChars: history.reduce((n, m) => n + m.content.length, 0),
    messages: msgs,
  };
}

/** first ~60 chars of the first user turn, whitespace-collapsed */
function autoTitle(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 60);
}

/** Persist one exchange atomically: the user turn, optionally the assistant
 * turn, the updated-at bump, and the auto-title (first user turn, only while
 * title is null) — all or nothing, so a crash mid-write can never leave a
 * half-written exchange. createdAt is written explicitly (assistant strictly
 * 1ms after user) so ordering never depends on a shared transaction
 * timestamp. */
export async function recordConversationTurns(
  db: Db,
  conversation: ConversationRow,
  turns: {
    userContent: string;
    userDetail?: Record<string, unknown>;
    assistant?: { content: string; detail: Record<string, unknown> };
  },
): Promise<void> {
  const at = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(conversationMessages).values({
      conversationId: conversation.id,
      role: "user",
      content: turns.userContent,
      detail: turns.userDetail ?? null,
      createdAt: at,
    });
    if (turns.assistant) {
      await tx.insert(conversationMessages).values({
        conversationId: conversation.id,
        role: "assistant",
        content: turns.assistant.content,
        detail: turns.assistant.detail,
        createdAt: new Date(at.getTime() + 1),
      });
    }
    await tx
      .update(conversations)
      .set({
        updatedAt: new Date(at.getTime() + 1),
        ...(conversation.title === null && turns.userContent.trim()
          ? { title: autoTitle(turns.userContent) }
          : {}),
      })
      .where(eq(conversations.id, conversation.id));
  });
}

/** Own-scoped CRUD for conversations (all four are NON_ADMIN_ROUTES; the
 * dispatch-with-history path lives on the existing governed invoke route). */
export function registerConversationRoutes(app: FastifyInstance, db: Db) {
  /**
   * ADR-0112 — THE PRESENTATION CHOKEPOINT.
   *
   * Every conversation route lives inside this ENCAPSULATED scope, and the
   * scrub is installed on the scope before the first route is declared. That
   * is what makes it by-construction rather than by-convention: a route added
   * to this function next month is covered without its author knowing this
   * comment exists, exactly as ADR-0099/0102 argued for the write side.
   *
   * The stored rows are untouched — `conversation_messages.content`,
   * `conversations.title` and `conversations.summary` still hold byte-for-byte
   * what was said. Only what these routes HAND OUT is redacted.
   */
  app.register(async (scope) => {
    installConversationPresentationScrub(scope);

    scope.post("/v1/conversations", async (req, reply) => {
      const body = createConversationSchema.parse(req.body);
      const userId = req.authCtx.userId;
      if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_converse" });
      // fail early on a dangling agent id — every turn will invoke it
      const [agent] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, body.agentId));
      if (!agent) return reply.status(404).send({ error: "unknown_agent" });
      // pillar 5: the thread's default attribution must be a project the
      // caller may bill to — same gate as a direct attributed invoke
      if (body.projectId) {
        const attribution = await assertProjectAttribution(db, body.projectId, userId, req.authCtx.isAdmin);
        if (!attribution.ok) return reply.status(attribution.status).send({ error: attribution.error });
      }
      const [row] = await db
        .insert(conversations)
        .values({ userId, agentId: body.agentId, projectId: body.projectId ?? null })
        .returning();
      return reply.status(201).send(row);
    });

    scope.get("/v1/conversations", async (req, reply) => {
      const userId = req.authCtx.userId;
      if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_converse" });
      // S21: narrow this user's threads to ONE project. `conversations.projectId`
      // is the pillar-5 default attribution for every turn dispatched in the
      // thread, so "my chats on project X" is the question an operator actually
      // asks — the unfiltered list already carried `projectName`, it just could
      // not be asked for one.
      //
      // `none` selects the UNATTRIBUTED threads. That vocabulary is not invented
      // here: ADR-0024 O11 already exposes the null-project bucket as
      // `GET /v1/costs/unattributed`, on the reasoning that spend belonging to no
      // project must stay VISIBLE rather than be silently folded into one. The
      // same argument applies to a conversation: without this, a user with
      // unattributed threads has no way to isolate them.
      //
      // This narrows; it never widens. The ownership predicate below is applied
      // regardless, so a projectId belonging to somebody else's conversations
      // returns an empty list, not theirs.
      const { projectId } = z
        .object({ projectId: z.union([z.literal("none"), z.string().uuid()]).optional() })
        .parse(req.query);
      const projectFilter =
        projectId === undefined
          ? undefined
          : projectId === "none"
            ? isNull(conversations.projectId)
            : eq(conversations.projectId, projectId);
      // ADR-0185 I3 — an expired conversation no incident holds is not listed,
      // whether or not the retention sweep has reached it yet
      const { conversationRetentionDays } = await loadOrgSettings(db);
      const live = or(
        gte(conversations.updatedAt, conversationRetentionCutoff(new Date(), conversationRetentionDays)),
        await conversationHeldSql(),
      );
      const rows = await db
        .select({
          id: conversations.id,
          title: conversations.title,
          agentId: conversations.agentId,
          agentName: agents.name,
          projectId: conversations.projectId,
          projectName: projects.name,
          createdAt: conversations.createdAt,
          updatedAt: conversations.updatedAt,
          messageCount: count(conversationMessages.id),
        })
        .from(conversations)
        .leftJoin(agents, eq(agents.id, conversations.agentId))
        .leftJoin(projects, eq(projects.id, conversations.projectId))
        .leftJoin(conversationMessages, eq(conversationMessages.conversationId, conversations.id))
        .where(
          and(eq(conversations.userId, userId), live, projectFilter),
        )
        .groupBy(conversations.id, agents.name, projects.name)
        .orderBy(desc(conversations.updatedAt));
      return { conversations: rows };
    });

    scope.get("/v1/conversations/:conversationId", async (req, reply) => {
      const { conversationId } = conversationIdParam.parse(req.params);
      const userId = req.authCtx.userId;
      if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_converse" });
      const [row] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
      if (!row) return reply.status(404).send({ error: "unknown_conversation" });
      // personal, admins included — see module doc
      if (row.userId !== userId) return reply.status(403).send({ error: "forbidden" });
      // ADR-0185 I3 — read-time enforcement: an expired, unheld conversation is
      // gone even before the sweep deletes it; a held one stays readable
      const retention = await conversationRetentionState(db, row);
      if (retention.expired && !retention.held) {
        return reply.status(404).send({ error: "conversation_expired", detail: EXPIRED_DETAIL(retention.retentionDays) });
      }
      const [[agent], [project], messages] = await Promise.all([
        db.select({ name: agents.name }).from(agents).where(eq(agents.id, row.agentId)),
        row.projectId
          ? db.select({ name: projects.name }).from(projects).where(eq(projects.id, row.projectId))
          : Promise.resolve([undefined]),
        db
          .select({
            id: conversationMessages.id,
            role: conversationMessages.role,
            content: conversationMessages.content,
            detail: conversationMessages.detail,
            createdAt: conversationMessages.createdAt,
          })
          .from(conversationMessages)
          .where(eq(conversationMessages.conversationId, conversationId))
          .orderBy(asc(conversationMessages.createdAt)),
      ]);
      return {
        ...row,
        agentName: agent?.name ?? null,
        projectName: project?.name ?? null,
        retention: { expired: retention.expired, heldByIncident: retention.held, retentionDays: retention.retentionDays },
        messages,
      };
    });

    scope.delete("/v1/conversations/:conversationId", async (req, reply) => {
      const { conversationId } = conversationIdParam.parse(req.params);
      const userId = req.authCtx.userId;
      if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_converse" });
      const [row] = await db
        .select({ id: conversations.id, userId: conversations.userId, agentId: conversations.agentId })
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      if (!row) return reply.status(404).send({ error: "unknown_conversation" });
      if (row.userId !== userId) return reply.status(403).send({ error: "forbidden" });
      // hard delete; conversation_messages cascade with the FK. ADR-0185 I3:
      // the incident hold is re-checked INSIDE the DELETE, so an incident that
      // links this conversation (or covers its agent) a moment earlier still holds it
      const out = await deleteOwnConversation(db, conversationId, userId);
      if (!out.deleted) {
        if (!out.held) return reply.status(404).send({ error: "unknown_conversation" });
        await db.insert(auditLog).values({
          userId,
          objectType: "conversation",
          objectId: conversationId,
          detail: { subsystem: "memory-retention", agentId: row.agentId },
          effect: "deny",
          ruleId: MEMORY_RETENTION_RULE_IDS.conversationDeleteHeld,
          ruleChain: [],
          reason: `conversation ${conversationId}: its owner's delete refused — an incident not yet closed holds it`,
        });
        return reply.status(409).send({ error: "incident_evidence_hold", detail: HELD_DETAIL });
      }
      return { removed: true };
    });
  });
}
