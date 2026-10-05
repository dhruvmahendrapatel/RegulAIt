/**
 * ADR-0173 §2 — INBOUND CHANNELS: a Slack or Teams message reaching a builder
 * agent, and the reply going back.
 *
 *   `packages/shared/src/chatops.ts`  signature + replay verification and the
 *                                      strict message parsers. Pure.
 *   `chatops.ts`                       the two public inbound routes (walls 0–2:
 *                                      workspace lookup, signature/replay,
 *                                      parse) and the guarded outbound post.
 *   THIS FILE                          everything after the platform is proved:
 *                                      de-duplication, which agent, which human,
 *                                      whether that human may use the agent,
 *                                      the asynchronous turn and the reply.
 *
 * THE BUILDER ADDS NO AUTHORITY, AND NEITHER DOES THE CHANNEL
 * ----------------------------------------------------------
 * The chat user id is an ASSERTION delivered under the bot's connection. It
 * becomes a RegulAIt human only through the admin-made `chat_identity_links`
 * row — the same trust artifact ChatOps approvals use. An unlinked sender is
 * told to ask for a link and NOTHING runs; a linked person who may not see the
 * agent (builder visibility) is refused the same way. Otherwise the turn is an
 * ordinary `runBuilderTurn(..., source: "channel")` AS THAT PERSON: their model
 * entitlement, the agent's project re-checked for them, budgets, kill switch,
 * guardrails, the per-agent monthly limit — all applied by the runtime, none
 * re-implemented here.
 *
 * WHICH AGENT. An ADMIN binds an agent to a ChatOps connection (ADR-0172
 * review rule) and may route it to one platform channel
 * (`builder_agent_channels.external_channel_id`, unique per connection +
 * channel). A channel with no exact route falls back to the connection's ONE
 * connection-wide binding; two or more is ambiguous and is refused politely,
 * never resolved by picking one.
 *
 * WHEN THE AGENT SPEAKS. In a channel routed to it, to every person's message.
 * Elsewhere on the connection only when it is spoken to — an @-mention or a
 * direct message — or in a platform thread it is already conversing in, so a
 * connection-wide agent does not answer every message in every channel its bot
 * has joined. Teams outgoing webhooks are only ever invoked by a mention.
 *
 * WHY ASYNCHRONOUS. Slack expects an answer within 3 s (and retries otherwise),
 * Teams within 5 s; a governed turn can take far longer. So the route answers
 * as soon as the cheap checks are done and the turn + reply run afterwards.
 * The de-duplication record is written BEFORE the ack, so a platform retry of
 * a message whose turn is still running is acknowledged and dropped.
 *
 * WHAT GOES BACK. The agent's reply, posted through the ChatOps courier — the
 * egress-guarded connector post, never a direct fetch. ADR-0061's sensitivity
 * fence applies to the reply exactly as to an approval card: an agent whose
 * project is in PII mode `block` gets a link, not its content, in the
 * third-party workspace. A turn that pauses (a tool marked "Ask first", or an
 * organisation approval) is announced with a link. In a SLACK thread an "Ask
 * first" pause also carries Approve / Deny buttons (ADR-0173 batch 2b): the
 * click is signature-verified, the clicker is mapped through the identity link
 * and must be the thread's own person, the prompt is claimed once, and the
 * answer goes through the same confirm logic as the web route. A typed chat
 * reply never confirms anything, and Teams keeps the link-to-web confirmation.
 *
 * TEAMS BOT FRAMEWORK (ADR-0173 batch 2b). A registered bot's activities are
 * routed exactly like outgoing-webhook messages; the only difference is that
 * the Bot Framework ignores the response body, so every reply — refusals
 * included — goes out through the courier (`replyVia: "courier"`).
 *
 * INBOUND EMAIL STAYS REFUSED (ADR-0121): an email is an unauthenticated
 * assertion, so there is no email route here at all.
 */
import { z } from "zod";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import {
  and,
  auditLog,
  builderAgentChannels,
  builderAgents,
  builderChannelEvents,
  builderChannelThreads,
  builderStepChatPrompts,
  builderThreads,
  builderToolSteps,
  chatIdentityLinks,
  chatopsConnections,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  sql,
  users,
  type BuilderAgentRow,
  type ChatOpsConnectionRow,
  type Db,
} from "@regulait/db";
import {
  chatContentFenced,
  chatDecidable,
  composeStepAnsweredBlocks,
  composeStepConfirmBlocks,
  type InboundChatMessage,
  type SlackStepInteraction,
} from "@regulait/shared";
import { scheduleBackgroundWork } from "./background-work.js";
import { loadVisibleAgent } from "./builder-access.js";
import { onBuilderTurnResumed, resumeBuilderStep, runBuilderTurn, type TurnOutcome } from "./builder-runtime.js";
import { projectPiiMode } from "./projects.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** stable rule ids — what an operator greps the audit log for */
export const BUILDER_CHANNEL_RULE_IDS = {
  accepted: "builder-channel-message-accepted",
  refusedUnlinked: "builder-channel-refused-unlinked-identity",
  refusedNotVisible: "builder-channel-refused-agent-not-visible",
  refusedUnrouted: "builder-channel-refused-unrouted",
  refusedAmbiguous: "builder-channel-refused-ambiguous-route",
  replyPosted: "builder-channel-reply-posted",
  replyFailed: "builder-channel-reply-failed",
  replyUndeliverable: "builder-channel-reply-undeliverable",
  turnFailed: "builder-channel-turn-failed",
  routeChanged: "builder-channel-route-changed",
  /** ADR-0173 batch 2b — an "Ask first" answer from the Slack buttons */
  stepAnswered: "builder-channel-step-answered",
  stepRefusedUnlinked: "builder-channel-step-refused-unlinked-identity",
  stepRefusedNotThreadPerson: "builder-channel-step-refused-not-thread-person",
  stepRefusedSensitivity: "builder-channel-step-refused-sensitivity-fence",
  stepResumeFailed: "builder-channel-step-resume-failed",
} as const;

/** a reply longer than this is cut, with a link to the whole of it */
export const CHANNEL_REPLY_MAX_CHARS = 3_500;
/** de-duplication rows older than this are pruned (platform retries stop well within it) */
const EVENT_RETENTION_HOURS = 24;

/** the courier post, handed in by chatops.ts (egress-guarded, connector credential) */
export type ChannelPoster = (
  conn: ChatOpsConnectionRow,
  input: {
    target: string;
    threadRef: string | null;
    text: string;
    /** Slack only: Block Kit blocks shown in place of `text` (which stays the notification text) */
    blocks?: Array<Record<string, unknown>>;
    /** Slack only: rewrite this message (chat.update) instead of posting a new one */
    updateRef?: string;
  },
  actorUserId: string | null,
  label: string,
) => Promise<{ ok: true; messageRef: string | null } | { ok: false; status: number; body: Record<string, unknown> }>;

export interface ChannelDeps {
  dataKey?: string | undefined;
  post: ChannelPoster;
  log?: FastifyBaseLogger | undefined;
}

export interface InboundResult {
  /** what the platform is answered with, immediately */
  ack: { status: number; body: Record<string, unknown> };
  /** the work that runs after the ack (the turn and/or a reply), if any */
  work: (() => Promise<void>) | null;
}

// ---------------------------------------------------------------------------
// the after-the-ack work tracker
// ---------------------------------------------------------------------------

// one tracker for all after-the-response work (background-work.ts), so a
// closing app and a test drain channel turns and resumed turns alike
export {
  scheduleBackgroundWork as scheduleChannelWork,
  drainBackgroundWork as drainChannelWork,
  backgroundWorkInFlight as channelWorkInFlight,
} from "./background-work.js";

// ---------------------------------------------------------------------------
// the words that go back
// ---------------------------------------------------------------------------

/**
 * Where the person continues in RegulAIt: the SPA's builder inbox, under its
 * `/ui` base. ABSOLUTE when the gateway's public origin is known — taken from
 * the inbound request itself (scheme + Host, the same derivation the SAML/OIDC
 * redirect URIs use, `baseUrlFor`), since there is no configured public URL —
 * and stored with the conversation so a reply posted later (a resumed turn)
 * links the same way. Relative (`/ui/…`) only when no origin was ever seen.
 */
export const threadLink = (threadId: string, origin?: string | null) =>
  `${origin ? origin.replace(/\/+$/, "") : ""}/ui/builder/inbox?tab=all&thread=${threadId}`;

export type TurnPause = "confirmation" | "approval" | null;

/** the "Ask first" step a turn paused on, if it did */
export function confirmationStepOf(outcome: TurnOutcome): { id: string; displayName: string } | null {
  if (!outcome.ok) return null;
  if (outcome.pending?.status === "pending_confirmation") return { id: outcome.pending.stepId, displayName: outcome.pending.displayName };
  const pools: unknown[] = [...(outcome.steps ?? [])];
  for (const m of outcome.messages as unknown[]) {
    const steps = (m as { steps?: unknown }).steps;
    if (Array.isArray(steps)) pools.push(...steps);
  }
  for (const s of pools) {
    const r = s && typeof s === "object" ? (s as { id?: unknown; status?: unknown; displayName?: unknown }) : null;
    if (r?.status === "pending_confirmation" && typeof r.id === "string") {
      return { id: r.id, displayName: typeof r.displayName === "string" ? r.displayName : "the tool" };
    }
  }
  return null;
}

/**
 * A paused turn, read off the runtime's outcome without depending on its
 * internals: a step whose status is `pending_confirmation` (a tool marked
 * "Ask first") or `pending_approval` (an organisation approval). Looked for on
 * the outcome and on each returned message, where the tool-use runtime reports
 * its steps.
 */
export function pauseOf(outcome: TurnOutcome): TurnPause {
  if (!outcome.ok) return null;
  const pools: unknown[] = [];
  const top = (outcome as unknown as { steps?: unknown }).steps;
  if (Array.isArray(top)) pools.push(...top);
  for (const m of outcome.messages as unknown[]) {
    const steps = (m as { steps?: unknown }).steps;
    if (Array.isArray(steps)) pools.push(...steps);
  }
  const statuses = pools.map((s) => (s && typeof s === "object" ? (s as { status?: unknown }).status : null));
  if (statuses.includes("pending_confirmation")) return "confirmation";
  if (statuses.includes("pending_approval")) return "approval";
  return null;
}

/** the text posted back for a finished turn. Pure. */
export function composeChannelReply(input: {
  replyText: string | null;
  fenced: boolean;
  pause: TurnPause;
  link: string;
}): string {
  const parts: string[] = [];
  if (input.fenced) {
    parts.push(
      "The reply is withheld from chat: this agent's project has a compliance classification that blocks " +
        `sensitive content leaving RegulAIt. Read it in RegulAIt: ${input.link}`,
    );
  } else if (input.replyText && input.replyText.trim()) {
    const text = input.replyText.trim();
    parts.push(
      text.length > CHANNEL_REPLY_MAX_CHARS
        ? `${text.slice(0, CHANNEL_REPLY_MAX_CHARS)}… (cut short — the whole reply is in RegulAIt: ${input.link})`
        : text,
    );
  }
  if (input.pause === "confirmation") {
    parts.push(`Waiting for your confirmation in RegulAIt before using a tool: ${input.link}`);
  } else if (input.pause === "approval") {
    parts.push(`Waiting for an approval in RegulAIt before using a tool; I'll continue once it is decided: ${input.link}`);
  }
  if (parts.length === 0) parts.push(`Done — see the conversation in RegulAIt: ${input.link}`);
  return parts.join("\n\n");
}

/** a refused turn: the code and a link, never the refusal's detail (which
 * names governance internals a third-party workspace has no business holding) */
export function composeChannelRefusal(error: string, link: string | null): string {
  if (error === "thread_waiting_on_tool_step") {
    // the one refusal the person can clear themselves — say how (a Slack DM is
    // ONE conversation, so a pause blocks the whole DM until it is answered)
    return (
      "This conversation is waiting on a tool step, so I can't take a new message yet. " +
      (link ? `Open it in RegulAIt: ${link} — then confirm or cancel the step there, and write again.` : "Open the conversation in RegulAIt, confirm or cancel the step there, and write again.")
    );
  }
  return link
    ? `RegulAIt refused this request (${error}). The details are in RegulAIt: ${link}`
    : `RegulAIt refused this request (${error}).`;
}

const UNLINKED_TEXT =
  "Your chat account isn't linked to a RegulAIt user yet, so I can't act for you. Ask a RegulAIt admin to link " +
  "it (Admin → ChatOps → identity links), then try again.";
const NOT_VISIBLE_TEXT =
  "You don't have access to the agent connected here. Ask its owner to share it with you, then try again.";
const UNROUTED_TEXT =
  "No RegulAIt agent is connected to this channel. An admin can connect one in the agent's Channels settings.";
const AMBIGUOUS_TEXT =
  "More than one RegulAIt agent is connected to this workspace and none is routed to this channel, so I won't " +
  "guess which one should answer. An admin can route this channel to one agent.";

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

type Route =
  | { kind: "agent"; agent: BuilderAgentRow; exact: boolean }
  | { kind: "unrouted" }
  | { kind: "ambiguous" };

async function routeFor(db: Db, conn: ChatOpsConnectionRow, msg: InboundChatMessage): Promise<Route> {
  const rows = await db
    .select({ binding: builderAgentChannels, agent: builderAgents })
    .from(builderAgentChannels)
    .innerJoin(builderAgents, eq(builderAgentChannels.agentId, builderAgents.id))
    .where(
      and(
        eq(builderAgentChannels.chatopsConnectionId, conn.id),
        // a binding of the SAME provider only — a Slack binding never answers
        // a Teams workspace that happens to share a connection id space
        eq(builderAgentChannels.provider, msg.provider),
        isNull(builderAgents.archivedAt),
      ),
    );
  const exact = rows.find((r) => r.binding.externalChannelId === msg.channelId);
  if (exact) return { kind: "agent", agent: exact.agent, exact: true };
  const wide = rows.filter((r) => r.binding.externalChannelId === null);
  const agentIds = [...new Set(wide.map((r) => r.agent.id))];
  if (agentIds.length === 1) return { kind: "agent", agent: wide[0]!.agent, exact: false };
  return agentIds.length === 0 ? { kind: "unrouted" } : { kind: "ambiguous" };
}

// ---------------------------------------------------------------------------
// the inbound decision
// ---------------------------------------------------------------------------

async function audit(
  db: Db,
  userId: string | null,
  objectType: "builder_agent" | "chatops_connection",
  objectId: string,
  ruleId: string,
  effect: "allow" | "deny",
  reason: string,
  detail: Record<string, unknown>,
) {
  await db.insert(auditLog).values({
    userId: userId ?? NIL_UUID,
    objectType,
    objectId,
    detail: { subsystem: "builder-channels", ...detail },
    effect,
    ruleId,
    ruleChain: [],
    reason,
  });
}

/**
 * Decide what to do with one verified, parsed inbound message. Everything
 * before the returned `work` is a handful of indexed reads plus the
 * de-duplication insert — cheap enough to finish inside the platform's ack
 * deadline. The turn itself is in `work`.
 */
export async function acceptInboundMessage(
  db: Db,
  deps: ChannelDeps,
  conn: ChatOpsConnectionRow,
  msg: InboundChatMessage,
  retryNum: number | null,
  /** the gateway's public origin as this request reached it (links in replies) */
  origin: string | null = null,
  /** how a reply reaches the platform: in the HTTP response (a Teams outgoing
   * webhook) or through the courier (Slack, and the Teams Bot Framework, which
   * ignores the response body) */
  replyVia: "response" | "courier" = msg.provider === "teams" ? "response" : "courier",
): Promise<InboundResult> {
  const isTeams = msg.provider === "teams" && replyVia === "response";
  // Teams outgoing webhooks post the RESPONSE BODY as the reply, so a refusal
  // is said there (no outbound call needed); Slack and the Bot Framework ignore
  // the body, so a refusal is posted afterwards through the courier.
  const say = (text: string, audited: () => Promise<void>): InboundResult =>
    isTeams
      ? { ack: { status: 200, body: { type: "message", text } }, work: audited }
      : {
          ack: { status: 200, body: { ok: true } },
          work: async () => {
            await audited();
            await postReply(db, deps, conn, msg, text, null, "builder-channel-refusal");
          },
        };
  const ignore = (reason: string): InboundResult => ({
    ack: { status: 200, body: isTeams ? { type: "message", text: "" } : { ok: true, ignored: reason } },
    work: null,
  });
  const baseDetail = {
    connection: conn.name,
    provider: conn.provider,
    chatUserId: msg.chatUserId,
    externalChannelId: msg.channelId,
    externalThreadId: msg.threadId,
    eventId: msg.eventId,
  };

  // read-only lookups first: nothing is written for a message the agent ignores
  const route = await routeFor(db, conn, msg);
  const [link] = await db
    .select({ link: chatIdentityLinks, user: users })
    .from(chatIdentityLinks)
    .innerJoin(users, eq(chatIdentityLinks.userId, users.id))
    .where(and(eq(chatIdentityLinks.connectionId, conn.id), eq(chatIdentityLinks.chatUserId, msg.chatUserId)));
  const person = link && !link.user.disabledAt ? link.user : null;
  const [mapped] = person
    ? await db
        .select()
        .from(builderChannelThreads)
        .where(
          and(
            eq(builderChannelThreads.connectionId, conn.id),
            eq(builderChannelThreads.externalChannelId, msg.channelId),
            eq(builderChannelThreads.externalThreadId, msg.threadId),
            eq(builderChannelThreads.userId, person.id),
          ),
        )
    : [];

  const exactRoute = route.kind === "agent" && route.exact;
  if (!msg.addressed && !exactRoute && !mapped) return ignore("not_addressed");

  // DE-DUPLICATION, before any side effect: a redelivery (Slack retry, a Teams
  // re-send inside the replay window) or the second of Slack's paired
  // message/app_mention events resolves to the first and does nothing.
  const fresh = await db
    .insert(builderChannelEvents)
    .values({ connectionId: conn.id, externalEventId: msg.eventId, messageKey: msg.messageKey, retryNum })
    .onConflictDoNothing()
    .returning({ id: builderChannelEvents.id });
  if (fresh.length === 0) {
    return {
      ack: { status: 200, body: isTeams ? { type: "message", text: "" } : { ok: true, duplicate: true } },
      work: null,
    };
  }
  // keep the record bounded (indexed on received_at; a no-op most of the time)
  await db
    .delete(builderChannelEvents)
    .where(lt(builderChannelEvents.receivedAt, sql`now() - make_interval(hours => ${EVENT_RETENTION_HOURS})`));

  if (route.kind === "unrouted") {
    return say(UNROUTED_TEXT, () =>
      audit(db, person?.id ?? null, "chatops_connection", conn.id, BUILDER_CHANNEL_RULE_IDS.refusedUnrouted, "deny",
        `a ${conn.provider} message on '${conn.name}' reached no builder agent: none is bound to the connection or routed to channel ${msg.channelId}`,
        baseDetail),
    );
  }
  if (route.kind === "ambiguous") {
    return say(AMBIGUOUS_TEXT, () =>
      audit(db, person?.id ?? null, "chatops_connection", conn.id, BUILDER_CHANNEL_RULE_IDS.refusedAmbiguous, "deny",
        `a ${conn.provider} message on '${conn.name}' was refused: several agents are bound connection-wide and none is routed to channel ${msg.channelId}`,
        baseDetail),
    );
  }
  const agent = route.agent;

  // IDENTITY. The chat user id is an assertion; only an admin-made link turns
  // it into a person. Unlinked (or linked to a disabled user) → nothing runs.
  if (!person) {
    return say(UNLINKED_TEXT, () =>
      audit(db, link?.user.id ?? null, "builder_agent", agent.id, BUILDER_CHANNEL_RULE_IDS.refusedUnlinked, "deny",
        `${conn.provider} identity '${msg.chatUserId}' wrote to builder agent '${agent.name}' but ${link ? "is linked to a disabled user" : "is linked to no RegulAIt user"} — nothing ran`,
        baseDetail),
    );
  }

  // BUILDER VISIBILITY, as that person — the same check the web chat makes.
  const visible = await loadVisibleAgent(db, agent.id, { userId: person.id, isAdmin: person.isAdmin });
  if (!visible) {
    return say(NOT_VISIBLE_TEXT, () =>
      audit(db, person.id, "builder_agent", agent.id, BUILDER_CHANNEL_RULE_IDS.refusedNotVisible, "deny",
        `${person.email} wrote to builder agent '${agent.name}' over ${conn.provider} but may not use it — nothing ran`,
        baseDetail),
    );
  }

  await audit(db, person.id, "builder_agent", agent.id, BUILDER_CHANNEL_RULE_IDS.accepted, "allow",
    `${conn.provider} message from ${person.email} accepted for builder agent '${agent.name}'; the turn runs as them`,
    { ...baseDetail, retryNum, routedExactly: exactRoute });

  const work = async () => {
    // an existing conversation continues only while its builder thread does
    let threadId: string | undefined;
    if (mapped) {
      const [t] = await db.select().from(builderThreads).where(eq(builderThreads.id, mapped.builderThreadId));
      if (t && t.agentId === visible.id && t.userId === person.id) threadId = t.id;
    }
    let outcome: TurnOutcome;
    try {
      outcome = await runBuilderTurn(db, deps.dataKey, {
        agent: visible,
        userId: person.id,
        isAdmin: person.isAdmin,
        message: msg.text,
        threadId,
        source: "channel",
      });
    } catch (err) {
      await audit(db, person.id, "builder_agent", agent.id, BUILDER_CHANNEL_RULE_IDS.turnFailed, "deny",
        `the ${conn.provider} turn for '${agent.name}' failed: ${err instanceof Error ? err.message : String(err)}`,
        baseDetail);
      await postReply(db, deps, conn, msg, composeChannelRefusal("internal_error", null), person.id, "builder-channel-refusal");
      throw err;
    }
    const builderThreadId = outcome.ok ? outcome.thread.id : (outcome.threadId ?? null);
    // where a LATER reply (a resumed turn) goes: the platform thread of the
    // newest message, and the origin its links are built on
    const replyTo = {
      replyTarget: msg.replyTarget,
      replyThreadRef: msg.replyThreadRef,
      linkOrigin: origin ?? mapped?.linkOrigin ?? null,
    };
    if (builderThreadId && builderThreadId !== mapped?.builderThreadId) {
      await db
        .insert(builderChannelThreads)
        .values({
          connectionId: conn.id,
          externalChannelId: msg.channelId,
          externalThreadId: msg.threadId,
          userId: person.id,
          agentId: visible.id,
          builderThreadId,
          ...replyTo,
        })
        .onConflictDoUpdate({
          target: [
            builderChannelThreads.connectionId,
            builderChannelThreads.externalChannelId,
            builderChannelThreads.externalThreadId,
            builderChannelThreads.userId,
          ],
          set: { builderThreadId, agentId: visible.id, updatedAt: new Date(), ...replyTo },
        });
    } else if (mapped) {
      await db.update(builderChannelThreads).set({ updatedAt: new Date(), ...replyTo }).where(eq(builderChannelThreads.id, mapped.id));
    }
    const link = builderThreadId ? threadLink(builderThreadId, replyTo.linkOrigin) : null;
    let text: string;
    let confirm: AskFirstButtons | null = null;
    if (!outcome.ok) {
      text = composeChannelRefusal(outcome.error, link);
    } else {
      const reply = [...outcome.messages].reverse().find((m) => m.role === "agent");
      const fenced = chatContentFenced(await projectPiiMode(db, visible.projectId ?? null));
      text = composeChannelReply({ replyText: reply?.content ?? null, fenced, pause: pauseOf(outcome), link: link! });
      confirm = askFirstButtons(conn, outcome, fenced);
    }
    await postReply(db, deps, conn, msg, text, person.id, "builder-channel-reply", {
      agentId: visible.id,
      builderThreadId,
      turn: outcome.ok ? "ok" : outcome.error,
    }, confirm);
  };

  return {
    ack: isTeams
      ? { status: 200, body: { type: "message", text: `${visible.name} is working on it and will reply in this thread.` } }
      : { status: 200, body: { ok: true, accepted: true } },
    work,
  };
}

/** the Approve / Deny buttons a reply carries, when it may carry them */
interface AskFirstButtons {
  stepId: string;
  toolLabel: string;
}

/**
 * Buttons only in a SLACK thread, only on an "Ask first" pause, and only where
 * a chat tap may answer at all: ADR-0061's sensitivity fence applies to a
 * confirmation exactly as to an approval card (a fenced agent's pause is
 * answered in RegulAIt unless an admin opted this workspace in).
 */
function askFirstButtons(conn: ChatOpsConnectionRow, outcome: TurnOutcome, fenced: boolean): AskFirstButtons | null {
  if (conn.provider !== "slack" || pauseOf(outcome) !== "confirmation") return null;
  if (!chatDecidable({ fenced, allowFencedDecide: conn.allowFencedDecide })) return null;
  const step = confirmationStepOf(outcome);
  return step ? { stepId: step.id, toolLabel: step.displayName } : null;
}

/** post a reply into the platform thread the message came from, and audit it */
async function postReply(
  db: Db,
  deps: ChannelDeps,
  conn: ChatOpsConnectionRow,
  msg: InboundChatMessage,
  text: string,
  actorUserId: string | null,
  label: string,
  detail: Record<string, unknown> = {},
  confirm: AskFirstButtons | null = null,
): Promise<void> {
  await postTo(
    db,
    deps,
    conn,
    { target: msg.replyTarget, threadRef: msg.replyThreadRef, externalChannelId: msg.channelId, eventId: msg.eventId },
    text,
    actorUserId,
    label,
    detail,
    confirm,
  );
}

/** post into a platform thread through the courier, and audit the outcome */
async function postTo(
  db: Db,
  deps: ChannelDeps,
  conn: ChatOpsConnectionRow,
  where: { target: string; threadRef: string | null; externalChannelId: string; eventId: string | null },
  text: string,
  actorUserId: string | null,
  label: string,
  detail: Record<string, unknown> = {},
  confirm: AskFirstButtons | null = null,
): Promise<void> {
  // the prompt record exists BEFORE the post: its id is the buttons' value.
  // One per step and workspace (a re-post reuses it); answered at most once.
  let promptId: string | null = null;
  if (confirm) {
    const [created] = await db
      .insert(builderStepChatPrompts)
      .values({ stepId: confirm.stepId, connectionId: conn.id, channel: where.target })
      .onConflictDoNothing()
      .returning({ id: builderStepChatPrompts.id });
    const [existing] = created
      ? [created]
      : await db
          .select({ id: builderStepChatPrompts.id })
          .from(builderStepChatPrompts)
          .where(
            and(
              eq(builderStepChatPrompts.stepId, confirm.stepId),
              eq(builderStepChatPrompts.connectionId, conn.id),
              isNull(builderStepChatPrompts.answeredAt),
            ),
          );
    promptId = existing?.id ?? null;
  }
  const blocks = promptId && confirm ? composeStepConfirmBlocks({ text, toolLabel: confirm.toolLabel, promptId }) : undefined;
  let res: Awaited<ReturnType<ChannelPoster>>;
  try {
    res = await deps.post(conn, { target: where.target, threadRef: where.threadRef, text, ...(blocks ? { blocks } : {}) }, actorUserId, label);
  } catch (err) {
    res = { ok: false, status: 502, body: { error: err instanceof Error ? err.message : String(err) } };
  }
  if (promptId && res.ok) {
    await db
      .update(builderStepChatPrompts)
      .set({ messageRef: res.messageRef, channel: where.target, postedAt: new Date() })
      .where(eq(builderStepChatPrompts.id, promptId));
  }
  await audit(
    db,
    actorUserId,
    "chatops_connection",
    conn.id,
    res.ok ? BUILDER_CHANNEL_RULE_IDS.replyPosted : BUILDER_CHANNEL_RULE_IDS.replyFailed,
    res.ok ? "allow" : "deny",
    res.ok
      ? `${label} posted to ${conn.provider} channel ${where.externalChannelId}`
      : `${label} NOT posted to '${conn.name}': ${String(res.body.error ?? res.status)}`,
    {
      ...detail,
      label,
      externalChannelId: where.externalChannelId,
      ...(where.eventId ? { eventId: where.eventId } : {}),
      ...(res.ok ? {} : { status: res.status }),
      ...(promptId && confirm ? { stepPromptId: promptId, builderStepId: confirm.stepId } : {}),
    },
  );
}

// ---------------------------------------------------------------------------
// a paused turn that finished LATER (confirmed in the web app, or resumed by
// an approval decision, or cancelled): its outcome goes back to the platform
// thread the conversation came from
// ---------------------------------------------------------------------------

/**
 * Post a resumed channel turn's outcome — the text the agent added after the
 * pause, the next pause notice, or the refusal — to the platform thread the
 * conversation lives in, through the same courier, PII fence and audit as the
 * first reply. Teams: the courier posts through the Bot Framework connector
 * (as it does for the first reply), so a later reply is deliverable whenever
 * the first one was; when there is no conversation to post to (the mapping or
 * the connection is gone or disabled) that is audited as undeliverable.
 */
export async function postResumedChannelTurn(
  db: Db,
  deps: ChannelDeps,
  event: { threadId: string; outcome: TurnOutcome },
): Promise<void> {
  const [thread] = await db.select().from(builderThreads).where(eq(builderThreads.id, event.threadId));
  if (!thread || thread.source !== "channel") return;
  const [mapped] = await db
    .select()
    .from(builderChannelThreads)
    .where(and(eq(builderChannelThreads.builderThreadId, thread.id), eq(builderChannelThreads.userId, thread.userId)))
    .orderBy(desc(builderChannelThreads.updatedAt))
    .limit(1);
  const [conn] = mapped ? await db.select().from(chatopsConnections).where(eq(chatopsConnections.id, mapped.connectionId)) : [];
  if (!mapped || !conn || !conn.enabled || !mapped.replyTarget) {
    await audit(db, thread.userId, "builder_agent", thread.agentId, BUILDER_CHANNEL_RULE_IDS.replyUndeliverable, "deny",
      `the resumed turn of builder thread ${thread.id} could not be posted back: ${
        !mapped ? "no platform conversation is mapped to it" : !conn ? "its ChatOps connection was deleted" : !conn.enabled ? "its ChatOps connection is disabled" : "no reply target was recorded for it"
      }`,
      { builderThreadId: thread.id, connectionId: mapped?.connectionId ?? null });
    return;
  }
  const link = threadLink(thread.id, mapped.linkOrigin);
  const outcome = event.outcome;
  let text: string;
  let confirm: AskFirstButtons | null = null;
  if (!outcome.ok) {
    text = composeChannelRefusal(outcome.error, link);
  } else {
    const [agent] = await db.select({ projectId: builderAgents.projectId }).from(builderAgents).where(eq(builderAgents.id, thread.agentId));
    const fenced = chatContentFenced(await projectPiiMode(db, agent?.projectId ?? null));
    // what the agent ADDED after the pause; with nothing added (a cancel, a
    // denial it could not continue from), the note saying what happened
    const added =
      outcome.resumedText !== undefined ? outcome.resumedText : ([...outcome.messages].reverse().find((m) => m.role === "agent")?.content ?? "");
    const note = [...outcome.messages].reverse().find((m) => m.role === "system")?.content ?? null;
    const replyText = added.trim() ? added : note;
    text = composeChannelReply({ replyText, fenced, pause: pauseOf(outcome), link });
    confirm = askFirstButtons(conn, outcome, fenced);
  }
  await postTo(
    db,
    deps,
    conn,
    { target: mapped.replyTarget, threadRef: mapped.replyThreadRef, externalChannelId: mapped.externalChannelId, eventId: null },
    text,
    thread.userId,
    "builder-channel-resumed-reply",
    { agentId: thread.agentId, builderThreadId: thread.id, turn: outcome.ok ? "ok" : outcome.error, resumed: true },
    confirm,
  );
}

// ---------------------------------------------------------------------------
// ADR-0173 batch 2b — "Ask first" answered from the Slack buttons
// ---------------------------------------------------------------------------

/**
 * A click on an Approve / Deny button. The interaction route has already
 * proved the platform (walls 0–1: the workspace, the v0 signature and its
 * replay window); everything after that is here, in this order:
 *
 *  1. the prompt id names a prompt ONLY on the workspace that posted it;
 *  2. the clicking chat user becomes a person only through the admin-made
 *     identity link (unlinked or disabled: refused, audited);
 *  3. that person must be THE THREAD'S OWN PERSON — a confirmation is not an
 *     approval: no other linked user and no admin answers it;
 *  4. the sensitivity fence, as for an approval card;
 *  5. the step must still be waiting, and the prompt is CLAIMED ONCE (a second
 *     click, from anyone, is a 409);
 *  6. the answer runs through `resumeBuilderStep(via: "confirmation")` — the
 *     function the web route calls, which claims the step itself — after the
 *     response, because Slack expects an answer within 3 seconds. Its outcome
 *     is posted back into the thread by the resumed-turn subscriber.
 */
export async function acceptStepInteraction(
  db: Db,
  deps: ChannelDeps,
  conn: ChatOpsConnectionRow,
  click: SlackStepInteraction,
): Promise<InboundResult> {
  const refuse = (status: number, body: Record<string, unknown>, work: InboundResult["work"] = null): InboundResult => ({
    ack: { status, body },
    work,
  });
  const [prompt] = await db
    .select()
    .from(builderStepChatPrompts)
    .where(and(eq(builderStepChatPrompts.id, click.promptId), eq(builderStepChatPrompts.connectionId, conn.id)));
  const [step] = prompt ? await db.select().from(builderToolSteps).where(eq(builderToolSteps.id, prompt.stepId)) : [];
  const [thread] = step ? await db.select().from(builderThreads).where(eq(builderThreads.id, step.threadId)) : [];
  if (!prompt || !step || !thread) return refuse(404, { error: "unknown_prompt" });
  const detail = {
    connection: conn.name,
    chatUserId: click.chatUserId,
    stepPromptId: prompt.id,
    builderStepId: step.id,
    builderThreadId: thread.id,
    answer: click.answer,
  };

  const [link] = await db
    .select({ link: chatIdentityLinks, user: users })
    .from(chatIdentityLinks)
    .innerJoin(users, eq(chatIdentityLinks.userId, users.id))
    .where(and(eq(chatIdentityLinks.connectionId, conn.id), eq(chatIdentityLinks.chatUserId, click.chatUserId)));
  const person = link && !link.user.disabledAt ? link.user : null;
  if (!person) {
    await audit(db, link?.user.id ?? null, "builder_agent", thread.agentId, BUILDER_CHANNEL_RULE_IDS.stepRefusedUnlinked, "deny",
      `${conn.provider} identity '${click.chatUserId}' tried to ${click.answer} tool step '${step.displayName}' but ${link ? "is linked to a disabled user" : "is linked to no RegulAIt user"} — nothing ran`,
      detail);
    return refuse(403, {
      error: "unmapped_chat_identity",
      detail: "this chat identity is not linked to a RegulAIt user; an admin must create the link before it can answer anything",
    });
  }
  if (person.id !== thread.userId) {
    await audit(db, person.id, "builder_agent", thread.agentId, BUILDER_CHANNEL_RULE_IDS.stepRefusedNotThreadPerson, "deny",
      `${person.email} tried to ${click.answer} tool step '${step.displayName}' from ${conn.provider}, but the conversation runs as someone else — only that person answers it`,
      detail);
    return refuse(403, {
      error: "not_thread_person",
      detail: "only the person this conversation runs as can answer its confirmation",
    });
  }
  const [agent] = await db.select({ projectId: builderAgents.projectId }).from(builderAgents).where(eq(builderAgents.id, thread.agentId));
  const fenced = chatContentFenced(await projectPiiMode(db, agent?.projectId ?? null));
  if (!chatDecidable({ fenced, allowFencedDecide: conn.allowFencedDecide })) {
    await audit(db, person.id, "builder_agent", thread.agentId, BUILDER_CHANNEL_RULE_IDS.stepRefusedSensitivity, "deny",
      `${person.email} tried to ${click.answer} tool step '${step.displayName}' from ${conn.provider}, but the agent's project makes it in-app only`,
      detail);
    return refuse(403, {
      error: "chat_decide_not_permitted_for_sensitivity",
      detail: "this confirmation must be answered in RegulAIt; the agent's project compliance classification blocks chat answers",
    });
  }

  /** rewrite the posted message: the outcome in place of the buttons */
  const retire = (outcome: string) => async () => {
    if (!prompt.messageRef) return;
    let res: Awaited<ReturnType<ChannelPoster>>;
    try {
      res = await deps.post(
        conn,
        {
          target: prompt.channel,
          threadRef: null,
          text: outcome,
          blocks: composeStepAnsweredBlocks({ sections: click.messageSections, outcome }),
          updateRef: prompt.messageRef,
        },
        person.id,
        "builder-step-prompt-retired",
      );
    } catch (err) {
      res = { ok: false, status: 502, body: { error: err instanceof Error ? err.message : String(err) } };
    }
    await audit(db, person.id, "chatops_connection", conn.id,
      res.ok ? BUILDER_CHANNEL_RULE_IDS.replyPosted : BUILDER_CHANNEL_RULE_IDS.replyFailed, res.ok ? "allow" : "deny",
      res.ok
        ? `builder-step-prompt-retired on ${conn.provider} channel ${prompt.channel}`
        : `builder-step-prompt-retired NOT updated on '${conn.name}': ${String(res.body.error ?? res.status)}`,
      { ...detail, label: "builder-step-prompt-retired", externalChannelId: prompt.channel, ...(res.ok ? {} : { status: res.status }) });
  };

  if (step.status !== "pending_confirmation") {
    const state = step.status.replace(/_/g, " ");
    return refuse(409, { error: "step_not_pending", detail: `this step is ${state}` }, retire(`No longer waiting: this step is ${state}.`));
  }
  const claimed = await db
    .update(builderStepChatPrompts)
    .set({ answeredAt: new Date(), answeredByUserId: person.id, answer: click.answer })
    .where(and(eq(builderStepChatPrompts.id, prompt.id), isNull(builderStepChatPrompts.answeredAt)))
    .returning({ id: builderStepChatPrompts.id });
  if (!claimed.length) return refuse(409, { error: "already_answered", detail: "this confirmation was already answered" });
  await audit(db, person.id, "builder_agent", thread.agentId, BUILDER_CHANNEL_RULE_IDS.stepAnswered, click.answer === "approve" ? "allow" : "deny",
    `${person.email} ${click.answer === "approve" ? "approved" : "denied"} tool step '${step.displayName}' from ${conn.provider}; the turn resumes as them`,
    detail);

  const by = person.displayName || person.email;
  const work = async () => {
    await retire(click.answer === "approve" ? `Approved by ${by}. The agent continues.` : `Denied by ${by}.`)();
    const out = await resumeBuilderStep(db, deps.dataKey, {
      threadId: thread.id,
      stepId: step.id,
      via: "confirmation",
      decision: click.answer,
      deciderUserId: person.id,
    });
    if (!out.ok) {
      await audit(db, person.id, "builder_agent", thread.agentId, BUILDER_CHANNEL_RULE_IDS.stepResumeFailed, "deny",
        `the ${click.answer} of tool step '${step.displayName}' from ${conn.provider} did not resume the turn: ${out.error}${out.detail ? ` (${out.detail})` : ""}`,
        { ...detail, error: out.error });
    }
  };
  return { ack: { status: 200, body: { ok: true, answer: click.answer } }, work };
}

// ---------------------------------------------------------------------------
// admin: routing a platform channel to one agent
// ---------------------------------------------------------------------------

const routeBodySchema = z
  .object({
    /** the platform channel (Slack channel id, Teams conversation id); null = connection-wide */
    externalChannelId: z.string().trim().min(1).max(200).nullable(),
  })
  .strict();

/**
 * Admin-only by the default gate (neither route is in NON_ADMIN_ROUTES): which
 * agent answers a channel is a workspace decision, like binding the
 * connection itself (ADR-0172 review rule).
 */
export function registerBuilderChannelRoutes(app: FastifyInstance, db: Db, deps?: ChannelDeps): void {
  // ONE subscriber per app instance: a channel thread's paused turn that
  // finishes later (confirmed in the web app, an approval decided, cancelled)
  // is posted back into its platform thread — after the response that
  // finished it, as tracked background work. Only this app's own turns (its
  // database handle); unsubscribed when the app closes.
  if (deps) {
    const off = onBuilderTurnResumed((e) => {
      if (e.db !== db || e.source !== "channel") return;
      scheduleBackgroundWork(db, () => postResumedChannelTurn(db, deps, e), deps.log);
    });
    app.addHook("onClose", async () => {
      off();
    });
  }
  app.get("/v1/chatops/builder-routes", async () => {
    const rows = await db
      .select({
        channelId: builderAgentChannels.id,
        agentId: builderAgents.id,
        agentName: builderAgents.name,
        provider: builderAgentChannels.provider,
        connectionId: chatopsConnections.id,
        connectionName: chatopsConnections.name,
        externalChannelId: builderAgentChannels.externalChannelId,
      })
      .from(builderAgentChannels)
      .innerJoin(builderAgents, eq(builderAgentChannels.agentId, builderAgents.id))
      .innerJoin(chatopsConnections, eq(builderAgentChannels.chatopsConnectionId, chatopsConnections.id))
      .where(and(isNull(builderAgents.archivedAt), inArray(builderAgentChannels.provider, ["slack", "teams"])));
    return {
      routes: rows,
      posture:
        "A message on a connection reaches the agent routed to its channel, else the connection's ONE " +
        "connection-wide agent; several connection-wide agents with no route is refused, never guessed. The turn " +
        "runs as the linked RegulAIt user, never as the bot. Inbound email is not accepted (ADR-0121).",
    };
  });

  app.put("/v1/chatops/builder-routes/:channelId", async (req, reply) => {
    const { channelId } = z.object({ channelId: z.string().uuid() }).parse(req.params);
    const body = routeBodySchema.parse(req.body ?? {});
    const [row] = await db.select().from(builderAgentChannels).where(eq(builderAgentChannels.id, channelId));
    if (!row) return reply.status(404).send({ error: "unknown_channel" });
    if (row.provider !== "slack" && row.provider !== "teams") {
      return reply.status(422).send({
        error: "channel_inbound_unsupported",
        detail:
          "outlook and email channels are send-only (ADR-0121): an inbound email is an unauthenticated assertion, " +
          "so there is no inbound message to route",
      });
    }
    if (!row.chatopsConnectionId) {
      return reply.status(409).send({ error: "channel_needs_connection", detail: "bind the channel to a ChatOps connection first" });
    }
    if (body.externalChannelId) {
      const [taken] = await db
        .select({ id: builderAgentChannels.id, agentId: builderAgentChannels.agentId })
        .from(builderAgentChannels)
        .where(
          and(
            eq(builderAgentChannels.chatopsConnectionId, row.chatopsConnectionId),
            eq(builderAgentChannels.externalChannelId, body.externalChannelId),
          ),
        );
      if (taken && taken.id !== row.id) {
        return reply.status(409).send({
          error: "channel_already_routed",
          detail: "another agent already answers this channel on this connection; one agent per connection and channel",
        });
      }
    }
    const [updated] = await db
      .update(builderAgentChannels)
      .set({ externalChannelId: body.externalChannelId })
      .where(eq(builderAgentChannels.id, row.id))
      .returning();
    await audit(db, req.authCtx.userId ?? null, "builder_agent", row.agentId, BUILDER_CHANNEL_RULE_IDS.routeChanged, "allow",
      `${row.provider} channel route for builder agent changed: ${row.externalChannelId ?? "connection-wide"} → ${body.externalChannelId ?? "connection-wide"}`,
      { channelId: row.id, from: row.externalChannelId, to: body.externalChannelId, connectionId: row.chatopsConnectionId });
    return {
      channelId: updated!.id,
      agentId: updated!.agentId,
      provider: updated!.provider,
      connectionId: updated!.chatopsConnectionId,
      externalChannelId: updated!.externalChannelId,
    };
  });
}
