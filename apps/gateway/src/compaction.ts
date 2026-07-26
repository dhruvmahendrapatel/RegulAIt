/**
 * PILLAR 6 §5 — automatic context compaction for multi-turn conversations
 * (TOKEN_OPTIMIZATION_SPEC §5, EPIC-04).
 *
 * When a conversation's model-bound history outgrows the kernel's threshold,
 * the OLDER turns are summarized into one persisted summary by a governed,
 * metered dispatch to the CHEAPEST dispatchable agent the caller is entitled
 * to; later dispatches send [summary context] + [recent verbatim turns].
 *
 * Non-negotiables:
 * - Stored messages are NEVER deleted or altered — compaction only changes
 *   what is model-bound. GET /v1/conversations/:id always returns everything.
 * - The summarizer inherits the caller's entitlements (candidates are the
 *   invoke path's own governed, dispatchable roster) and bills to the same
 *   project attribution — its cost is a normal usage row, the visible price
 *   paid for the savings.
 * - FAIL-OPEN: a failed/refused compaction dispatch must never fail the
 *   user's turn. It is audited, compaction is skipped, and the full history
 *   dispatches as before (noted in the result trace).
 * - Re-compaction is CUMULATIVE: when the post-summary history crosses the
 *   threshold again, the new summarization input is the existing summary +
 *   the turns since — compacted-away turns are never re-read.
 * - A governance-DENIED turn is excluded from model-bound history (PR #27's
 *   rule) and equally excluded from what the summarizer sees: content the
 *   governance layer refused to send must never reach a provider, the
 *   summarizer included.
 */

import { auditLog, conversations, eq, type Db } from "@regulait/db";
import {
  compactionSavings,
  planCompaction,
} from "@regulait/optimizer-kernel";
import { CONVERSATION_COMPACTION_SENTINEL, type ModelChatMessage } from "@regulait/model-provider";
import type {
  ConversationRow,
  StoredConversationMessage,
} from "./conversations.js";
// type-only: erased at compile time, so no runtime cycle with agents-connectors
import type { AgentRow, executeGovernedDispatch } from "./agents-connectors.js";

/** the same crude chars/4 estimator the optimizer's other estimates use */
export const estimateMessageTokens = (content: string): number =>
  Math.max(1, Math.ceil(content.length / 4));

/** the clearly-marked leading context message a summary rides in as */
const SUMMARY_CONTEXT_PREFIX = "Context — summary of the conversation so far: ";

const COMPACTION_SYSTEM = [
  CONVERSATION_COMPACTION_SENTINEL,
  "Summarize this conversation faithfully for continued assistance; preserve decisions, constraints, names, and numbers.",
  "Reply with only the summary — it will be shown to the model in place of the summarized turns.",
].join("\n");

/** what the invoke result/SSE/audit surfaces (spec item 8) */
export interface CompactionPublicDetail {
  /** true when the MAIN dispatch rode a summary instead of the full history */
  active: boolean;
  summaryTokens: number;
  omittedMessages: number;
  savedTokensEst: number;
  /** present (true) only on the turn whose invoke triggered a compaction */
  compacted?: boolean;
  /** fail-open marker: the compaction dispatch failed and the turn proceeded
   * with the full history */
  failOpen?: { error: string };
}

export interface PreparedConversationContext {
  /** model-bound prior turns for the main dispatch (newest turn NOT included):
   * [summary context message, ...post-boundary turns] when a summary exists,
   * else the full non-denied history */
  modelBound: ModelChatMessage[];
  /** size signal for the optimizer's input estimate — matches modelBound */
  modelBoundChars: number;
  /** true when modelBound leads with a summary context message */
  summaryUsed: boolean;
  savedTokensEst: number;
  /** null when no summary is in play and nothing was attempted this turn */
  publicDetail: CompactionPublicDetail | null;
}

const asChat = (m: StoredConversationMessage): ModelChatMessage => ({
  role: m.role,
  content: m.content,
});

const isDenied = (m: StoredConversationMessage): boolean =>
  Boolean((m.detail as { denied?: boolean } | null)?.denied);

/** Cheapest dispatchable candidate: lowest list price, then lowest tier, then
 * stable name order — mirroring decompose.ts's cheapest-roster pick. */
export function cheapestSummarizer(candidates: readonly AgentRow[]): AgentRow | undefined {
  const price = (a: AgentRow) =>
    (a.costPerMTokIn ?? Number.POSITIVE_INFINITY) + (a.costPerMTokOut ?? Number.POSITIVE_INFINITY);
  return [...candidates].sort(
    (a, b) => price(a) - price(b) || a.tier - b.tier || a.name.localeCompare(b.name),
  )[0];
}

/**
 * Decide, (maybe) compact, and assemble the model-bound prior turns for one
 * conversation dispatch. Runs strictly BEFORE the main dispatch and strictly
 * AFTER governance — `candidates` is the caller's already-governed,
 * dispatchable roster for this mode, so the summarizer can never widen
 * entitlement.
 */
export async function prepareConversationContext(
  db: Db,
  dataKey: string | undefined,
  args: {
    userId: string;
    conversation: ConversationRow;
    /** every stored row in order, denied included (loadOwnConversation.messages) */
    messages: StoredConversationMessage[];
    /** entitled + dispatchable agents the summarizer may be chosen from */
    candidates: readonly AgentRow[];
    projectId: string | null;
    execute: typeof executeGovernedDispatch;
  },
): Promise<PreparedConversationContext> {
  const { conversation, messages } = args;

  // --- current summary state -----------------------------------------------
  let summary = conversation.summary;
  let summaryTokens = conversation.summaryTokens ?? (summary ? estimateMessageTokens(summary) : 0);
  let boundaryIdx = conversation.summaryThroughMessageId
    ? messages.findIndex((m) => m.id === conversation.summaryThroughMessageId)
    : -1;
  if (summary && boundaryIdx === -1) {
    // defensive: a summary whose boundary message is unknown must not hide
    // history — treat the conversation as uncompacted
    summary = null;
    summaryTokens = 0;
  }

  // model-bound slice AFTER the boundary, denied turns excluded (PR #27 rule)
  let postBound = messages.slice(boundaryIdx + 1).filter((m) => !isDenied(m));

  // --- pure decision --------------------------------------------------------
  const plan = planCompaction({
    messageTokens: postBound.map((m) => estimateMessageTokens(m.content)),
    summaryTokens,
  });

  let compacted = false;
  let failOpen: { error: string } | undefined;

  if (plan.shouldCompact) {
    const toCompact = postBound.slice(0, plan.compactThroughIndex + 1);
    const summarizer = cheapestSummarizer(args.candidates);
    const failOpenAudit = async (error: string) => {
      failOpen = { error };
      await db.insert(auditLog).values({
        userId: args.userId,
        objectType: "agent",
        objectId: summarizer?.id ?? null,
        detail: {
          purpose: "compact",
          conversationId: conversation.id,
          failOpen: true,
          error,
        },
        effect: "allow",
        ruleId: "context-compaction-failed-open",
        ruleChain: [],
        reason: `context compaction failed (${error}); the user's turn proceeds with the full history — fail-open, stored messages untouched`,
      });
    };

    if (!summarizer) {
      await failOpenAudit("no_compaction_agent");
    } else {
      const transcript = toCompact.map((m) => `${m.role}: ${m.content}`).join("\n\n");
      const input = summary
        ? `Prior summary:\n${summary}\n\nNewer turns:\n${transcript}`
        : transcript;
      const outcome = await args.execute(db, dataKey, {
        userId: args.userId,
        served: summarizer,
        requestedAgentId: summarizer.id,
        baseline: null,
        input,
        system: COMPACTION_SYSTEM,
        maxTokens: 1024,
        projectId: args.projectId,
        detail: { purpose: "compact", conversationId: conversation.id },
      });
      if (outcome.ok && !outcome.result.refusal && outcome.result.outputText.trim()) {
        const newSummary = outcome.result.outputText.trim();
        const newBoundaryId = toCompact[toCompact.length - 1]!.id;
        const newTokens = estimateMessageTokens(newSummary);
        await db
          .update(conversations)
          .set({
            summary: newSummary,
            summaryThroughMessageId: newBoundaryId,
            summaryTokens: newTokens,
            compactedAt: new Date(),
          })
          .where(eq(conversations.id, conversation.id));
        await db.insert(auditLog).values({
          userId: args.userId,
          objectType: "agent",
          objectId: summarizer.id,
          detail: {
            purpose: "compact",
            conversationId: conversation.id,
            compactedMessages: toCompact.length,
            cumulative: summary !== null,
            summaryTokens: newTokens,
            servedAgentId: outcome.result.servedAgentId,
            costUsd: outcome.result.costUsd,
          },
          effect: "allow",
          ruleId: "context-compaction",
          ruleChain: [],
          reason: `conversation history (~${plan.historyTokens} est. tokens) crossed the compaction threshold; ${toCompact.length} older message(s) summarized by '${summarizer.name}' — stored messages untouched, model-bound history shrunk`,
        });
        summary = newSummary;
        summaryTokens = newTokens;
        boundaryIdx = messages.findIndex((m) => m.id === newBoundaryId);
        postBound = messages.slice(boundaryIdx + 1).filter((m) => !isDenied(m));
        compacted = true;
      } else {
        await failOpenAudit(
          outcome.ok
            ? outcome.result.refusal
              ? "summarizer_refused"
              : "empty_summary"
            : outcome.error,
        );
      }
    }
  }

  // --- assembly -------------------------------------------------------------
  if (!summary) {
    const modelBound = messages.filter((m) => !isDenied(m)).map(asChat);
    return {
      modelBound,
      modelBoundChars: modelBound.reduce((n, m) => n + m.content.length, 0),
      summaryUsed: false,
      savedTokensEst: 0,
      publicDetail: failOpen
        ? { active: false, summaryTokens: 0, omittedMessages: 0, savedTokensEst: 0, failOpen }
        : null,
    };
  }

  const omitted = messages.slice(0, boundaryIdx + 1).filter((m) => !isDenied(m));
  const omittedTokens = omitted.reduce((n, m) => n + estimateMessageTokens(m.content), 0);
  const savedTokensEst = compactionSavings(omittedTokens, summaryTokens);
  const modelBound: ModelChatMessage[] = [
    { role: "user", content: `${SUMMARY_CONTEXT_PREFIX}${summary}` },
    ...postBound.map(asChat),
  ];
  return {
    modelBound,
    modelBoundChars: modelBound.reduce((n, m) => n + m.content.length, 0),
    summaryUsed: true,
    savedTokensEst,
    publicDetail: {
      active: true,
      summaryTokens,
      omittedMessages: omitted.length,
      savedTokensEst,
      ...(compacted ? { compacted: true } : {}),
      ...(failOpen ? { failOpen } : {}),
    },
  };
}
