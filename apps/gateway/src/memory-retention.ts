/**
 * ADR-0185 I3 — MEMORY RETENTION THAT RUNS.
 *
 * Two stores held what people asked and what agents answered, and neither was
 * ever deleted: the semantic cache filtered expired rows at read time only,
 * and conversations had no retention at all. This module deletes them.
 *
 *   job  semantic-cache-purge-sweep    hourly: deletes cache rows older than
 *                                      `semantic_cache_ttl_seconds` (strict
 *                                      3600). One summary audit row per pass.
 *   job  conversation-retention-sweep  daily: deletes conversations whose last
 *                                      message is older than
 *                                      `conversation_retention_days` (strict
 *                                      30); their messages cascade. One audit
 *                                      row per conversation, no content.
 *
 * Both walk OLDEST FIRST, in bounded batches (at most `PURGE_BATCH` ×
 * `PURGE_MAX_BATCHES` rows per pass, the rest on the next pass), and are
 * idempotent: a second pass over the same state deletes nothing.
 *
 * THE INCIDENT HOLD. Nothing that is evidence in an incident not yet closed is
 * deleted, whatever its age and whatever the D4 hold toggle says (as the D4
 * feedback sweep does): a conversation is held when such an incident LINKS it
 * (object type `conversation`) or COVERS its agent; a cache row is held when
 * such an incident covers its agent. "Covers" is `incidentCoversAgent`, the
 * one predicate the D4 evidence hold and the steward's read access already
 * share. The predicate is applied when selecting AND re-checked inside the
 * DELETE, so an incident opened between the two still holds the row (the
 * `feedback.ts` pattern).
 *
 * READ TIME too, so a missed pass never extends what a person can see:
 * `conversationRetentionState` says whether a conversation is past retention
 * and whether it is held; `conversations.ts` answers 404
 * `conversation_expired` for an expired, unheld one, refuses to continue an
 * expired one, and refuses a user's DELETE of a held one (409
 * `incident_evidence_hold`). The cache's lookup already filters on the TTL.
 *
 * `incidents.ts` is imported LAZILY: it reaches `conversations.ts` through
 * `use-cases.ts` → `agents-connectors.ts`, so a static import here would close
 * a module cycle (M-070).
 */
import {
  aiIncidentLinks,
  aiIncidents,
  and,
  asc,
  auditLog,
  builderAgentMemory,
  conversations,
  count,
  desc,
  eq,
  inArray,
  lt,
  projectContextItems,
  schedulerRuns,
  semanticCache,
  sql,
  type Db,
  type SQL,
} from "@regulait/db";
import type { SchedulerJobDefinition } from "./scheduler.js";
import { loadOrgSettings } from "./org-settings.js";

export const MEMORY_RETENTION_JOB_NAMES = {
  semanticCachePurge: "semantic-cache-purge-sweep",
  conversationRetention: "conversation-retention-sweep",
} as const;

/** stable rule ids — the strings an operator greps the audit log for */
export const MEMORY_RETENTION_RULE_IDS = {
  semanticCachePurged: "semantic-cache-purged",
  conversationPurged: "conversation-retention-purged",
  /** a person's DELETE of a conversation an incident holds (409) */
  conversationDeleteHeld: "conversation-delete-refused-incident-hold",
} as const;

const NIL = "00000000-0000-0000-0000-000000000000";
const DAY_MS = 86_400_000;
/** rows per DELETE */
export const PURGE_BATCH = 500;
/** batches per pass: a pass deletes at most PURGE_BATCH × this, the rest next pass */
export const PURGE_MAX_BATCHES = 20;

/** `audit_log.object_type` is plain text; these two are not in schema.ts's
 * TypeScript enum yet (a type-only addition requested from its owner) */
const OBJECT_CONVERSATION = "conversation" as typeof auditLog.$inferInsert.objectType;
const OBJECT_SEMANTIC_CACHE = "semantic_cache" as typeof auditLog.$inferInsert.objectType;

// ---------------------------------------------------------------------------
// the hold predicates
// ---------------------------------------------------------------------------

/**
 * A not-closed incident covers the agent `agentIdText` (an SQL expression
 * yielding the id), or — for a conversation — links `conversationIdText`.
 * Correlated to whatever row is in scope; safe inside SELECT, UPDATE and
 * DELETE (every column renders qualified).
 */
async function heldByOpenIncident(agentIdText: SQL, conversationIdText?: SQL): Promise<SQL> {
  const { incidentCoversAgent } = await import("./incidents.js");
  const linked = conversationIdText
    ? sql`EXISTS (SELECT 1 FROM ${aiIncidentLinks} WHERE ${aiIncidentLinks.incidentId} = ${aiIncidents.id}
        AND ${aiIncidentLinks.objectType} = 'conversation' AND ${aiIncidentLinks.objectId} = (${conversationIdText})::text) OR `
    : sql``;
  return sql`EXISTS (SELECT 1 FROM ${aiIncidents} WHERE ${aiIncidents.status} <> 'closed'
    AND (${linked}${incidentCoversAgent(agentIdText)}))`;
}

/** the hold for the conversation row in scope */
export function conversationHeldSql(): Promise<SQL> {
  return heldByOpenIncident(sql`${conversations.agentId}`, sql`${conversations.id}`);
}

/** the hold for the semantic-cache row in scope */
export function semanticCacheHeldSql(): Promise<SQL> {
  return heldByOpenIncident(sql`${semanticCache.agentId}`);
}

/** the instant before which a conversation's last activity means it has expired */
export function conversationRetentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

export interface ConversationRetentionState {
  /** last activity is older than the org's retention */
  expired: boolean;
  /** an incident not yet closed holds it (only computed when expired) */
  held: boolean;
  retentionDays: number;
}

/** READ-TIME enforcement: is this conversation past retention, and is it held? */
export async function conversationRetentionState(
  db: Db,
  conversation: { id: string; updatedAt: Date },
  now: Date = new Date(),
): Promise<ConversationRetentionState> {
  const { conversationRetentionDays: retentionDays } = await loadOrgSettings(db);
  const expired = conversation.updatedAt.getTime() < conversationRetentionCutoff(now, retentionDays).getTime();
  if (!expired) return { expired, held: false, retentionDays };
  return { expired, held: await conversationIsHeld(db, conversation.id), retentionDays };
}

/** is this conversation held by an incident not yet closed? */
export async function conversationIsHeld(db: Db, conversationId: string): Promise<boolean> {
  const held = await conversationHeldSql();
  const [row] = await db
    .select({ held: sql<boolean>`${held}` })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return Boolean(row?.held);
}

/**
 * A person's DELETE of their own conversation, with the hold re-checked inside
 * the statement. `deleted` false + `held` true = an incident holds it (409).
 */
export async function deleteOwnConversation(
  db: Db,
  conversationId: string,
  userId: string,
): Promise<{ deleted: boolean; held: boolean }> {
  const held = await conversationHeldSql();
  const rows = await db
    .delete(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId), sql`NOT ${held}`))
    .returning({ id: conversations.id });
  if (rows.length > 0) return { deleted: true, held: false };
  return { deleted: false, held: await conversationIsHeld(db, conversationId) };
}

// ---------------------------------------------------------------------------
// the sweeps
// ---------------------------------------------------------------------------

export interface SweepOptions {
  batch?: number;
  maxBatches?: number;
  /** TEST SEAM: runs between selecting a batch and deleting it, so a test can
   * open an incident in that gap and prove the DELETE re-checks the hold */
  onBatchSelected?: (ids: string[]) => Promise<void>;
}

export interface SemanticCachePurgeResult {
  purged: number;
  ttlSeconds: number;
  /** expired rows kept because an incident holds them (counted up to one batch) */
  held: number;
  /** the batch cap was reached: more expired rows remain for the next pass */
  more: boolean;
}

/**
 * `semantic-cache-purge-sweep`: delete cache rows older than the TTL, oldest
 * first, the hold re-checked in the DELETE. One summary audit row per pass
 * that deleted anything (counts and times only — never a prompt or answer).
 */
export async function runSemanticCachePurgeSweep(
  db: Db,
  now: Date,
  actorUserId: string | null = null,
  opts: SweepOptions = {},
): Promise<SemanticCachePurgeResult> {
  const batch = opts.batch ?? PURGE_BATCH;
  const maxBatches = opts.maxBatches ?? PURGE_MAX_BATCHES;
  const { semanticCacheTtlSeconds: ttlSeconds } = await loadOrgSettings(db);
  const cutoff = new Date(now.getTime() - ttlSeconds * 1000);
  const held = await semanticCacheHeldSql();
  const expired = lt(semanticCache.createdAt, cutoff);
  let purged = 0;
  let more = false;
  let oldest: Date | null = null;
  let newest: Date | null = null;
  const users = new Set<string>();
  const agentIds = new Set<string>();
  for (let i = 0; i < maxBatches; i++) {
    const due = await db
      .select({ id: semanticCache.id })
      .from(semanticCache)
      .where(and(expired, sql`NOT ${held}`))
      .orderBy(asc(semanticCache.createdAt), asc(semanticCache.id))
      .limit(batch);
    if (due.length === 0) break;
    await opts.onBatchSelected?.(due.map((d) => d.id));
    const rows = await db
      .delete(semanticCache)
      .where(
        and(
          inArray(
            semanticCache.id,
            due.map((d) => d.id),
          ),
          expired,
          sql`NOT ${held}`,
        ),
      )
      .returning({ userId: semanticCache.userId, agentId: semanticCache.agentId, createdAt: semanticCache.createdAt });
    purged += rows.length;
    for (const r of rows) {
      users.add(r.userId);
      agentIds.add(r.agentId);
      if (!oldest || r.createdAt < oldest) oldest = r.createdAt;
      if (!newest || r.createdAt > newest) newest = r.createdAt;
    }
    if (due.length < batch) break;
    if (i === maxBatches - 1) more = true;
  }
  const [{ n: heldCount } = { n: 0 }] = await db
    .select({ n: count() })
    .from(
      db
        .select({ id: semanticCache.id })
        .from(semanticCache)
        .where(and(expired, held))
        .limit(batch)
        .as("held_rows"),
    );
  if (purged > 0) {
    await db.insert(auditLog).values({
      userId: actorUserId ?? NIL,
      objectType: OBJECT_SEMANTIC_CACHE,
      objectId: null,
      detail: {
        subsystem: "memory-retention",
        job: MEMORY_RETENTION_JOB_NAMES.semanticCachePurge,
        purged,
        ttlSeconds,
        held: heldCount,
        more,
        users: users.size,
        agents: agentIds.size,
        oldestCreatedAt: oldest?.toISOString() ?? null,
        newestCreatedAt: newest?.toISOString() ?? null,
      },
      effect: "allow",
      ruleId: MEMORY_RETENTION_RULE_IDS.semanticCachePurged,
      ruleChain: [],
      reason:
        `semantic cache: ${purged} cached answer(s) older than ${ttlSeconds} s deleted` +
        (heldCount > 0 ? `; ${heldCount} kept as evidence for an incident not yet closed` : ""),
    });
  }
  return { purged, ttlSeconds, held: heldCount, more };
}

export interface ConversationRetentionResult {
  purged: number;
  retentionDays: number;
  /** expired conversations kept because an incident holds them (up to one batch) */
  held: number;
  heldIds: string[];
  more: boolean;
}

/**
 * `conversation-retention-sweep`: delete conversations whose last message is
 * older than the retention, oldest first, the hold re-checked in the DELETE;
 * messages cascade. One audit row per conversation: who, which agent, when —
 * never the title or a message.
 */
export async function runConversationRetentionSweep(
  db: Db,
  now: Date,
  actorUserId: string | null = null,
  opts: SweepOptions = {},
): Promise<ConversationRetentionResult> {
  const batch = opts.batch ?? PURGE_BATCH;
  const maxBatches = opts.maxBatches ?? PURGE_MAX_BATCHES;
  const { conversationRetentionDays: retentionDays } = await loadOrgSettings(db);
  const cutoff = conversationRetentionCutoff(now, retentionDays);
  const held = await conversationHeldSql();
  const expired = lt(conversations.updatedAt, cutoff);
  let purged = 0;
  let more = false;
  for (let i = 0; i < maxBatches; i++) {
    const due = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(expired, sql`NOT ${held}`))
      .orderBy(asc(conversations.updatedAt), asc(conversations.id))
      .limit(batch);
    if (due.length === 0) break;
    await opts.onBatchSelected?.(due.map((d) => d.id));
    const n = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const rows = await tx
        .delete(conversations)
        .where(
          and(
            inArray(
              conversations.id,
              due.map((d) => d.id),
            ),
            expired,
            sql`NOT ${held}`,
          ),
        )
        .returning({
          id: conversations.id,
          userId: conversations.userId,
          agentId: conversations.agentId,
          projectId: conversations.projectId,
          createdAt: conversations.createdAt,
          updatedAt: conversations.updatedAt,
          // qualified by hand: drizzle renders RETURNING columns unqualified,
          // and an unqualified "id" here would bind to the message's own id
          messages: sql<number>`(SELECT count(*) FROM conversation_messages m WHERE m.conversation_id = "conversations"."id")`.mapWith(
            Number,
          ),
        });
      if (rows.length > 0) {
        await tx.insert(auditLog).values(
          rows.map((r) => ({
            userId: actorUserId ?? NIL,
            objectType: OBJECT_CONVERSATION,
            objectId: r.id,
            detail: {
              subsystem: "memory-retention",
              job: MEMORY_RETENTION_JOB_NAMES.conversationRetention,
              ownerUserId: r.userId,
              agentId: r.agentId,
              projectId: r.projectId,
              messages: r.messages,
              retentionDays,
              createdAt: r.createdAt.toISOString(),
              lastActivityAt: r.updatedAt.toISOString(),
            },
            effect: "allow" as const,
            ruleId: MEMORY_RETENTION_RULE_IDS.conversationPurged,
            ruleChain: [],
            reason: `conversation ${r.id}: deleted with its ${r.messages} message(s), ${retentionDays} days after its last activity`,
          })),
        );
      }
      return rows.length;
    });
    purged += n;
    if (due.length < batch) break;
    if (i === maxBatches - 1) more = true;
  }
  const heldRows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(expired, held))
    .orderBy(asc(conversations.updatedAt))
    .limit(batch);
  return { purged, retentionDays, held: heldRows.length, heldIds: heldRows.map((r) => r.id), more };
}

/** The scheduler jobs this slice owns (spread by scheduler-jobs.ts). */
export function memoryRetentionJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: MEMORY_RETENTION_JOB_NAMES.semanticCachePurge,
      description:
        "ADR-0185 I3: deletes semantic-cache answers older than the org's cache lifetime, oldest first. A row whose " +
        "agent an incident not yet closed covers is kept until the incident closes.",
      adr: "ADR-0185",
      defaultIntervalSeconds: 3600,
      run: async (ctx) => {
        const out = await runSemanticCachePurgeSweep(ctx.db, ctx.now, ctx.actorUserId);
        return { itemsProcessed: out.purged, detail: { ...out } };
      },
    },
    {
      name: MEMORY_RETENTION_JOB_NAMES.conversationRetention,
      description:
        "ADR-0185 I3: deletes conversations (and their messages) whose last activity is older than the org's " +
        "conversation retention, oldest first. One linked to, or whose agent is covered by, an incident not yet " +
        "closed is kept until the incident closes.",
      adr: "ADR-0185",
      defaultIntervalSeconds: 24 * 3600,
      run: async (ctx) => {
        const out = await runConversationRetentionSweep(ctx.db, ctx.now, ctx.actorUserId);
        return { itemsProcessed: out.purged, detail: { ...out, heldIds: out.heldIds.slice(0, 50) } };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// the memory-store inventory (counts only, never content)
// ---------------------------------------------------------------------------

export const MEMORY_STORE_KINDS = ["semantic_cache", "conversations", "builder_agent_memory", "project_context_items"] as const;
export type MemoryStoreKind = (typeof MEMORY_STORE_KINDS)[number];

export interface MemoryStoreView {
  kind: MemoryStoreKind;
  rows: number;
  oldestAt: string | null;
  isolation: string;
  retention: {
    setting: "semanticCacheTtlSeconds" | "conversationRetentionDays" | null;
    value: number | null;
    /** the job that deletes past the setting; null = nothing deletes this store yet */
    enforcedBy: string | null;
    lastRunAt: string | null;
  };
  /** past retention but kept because an incident holds it; null where no sweep runs */
  held: number | null;
  owner: { kind: "org" };
}

async function lastOkRun(db: Db, jobName: string): Promise<string | null> {
  const [r] = await db
    .select({ at: schedulerRuns.finishedAt })
    .from(schedulerRuns)
    .where(and(eq(schedulerRuns.jobName, jobName), eq(schedulerRuns.outcome, "ok")))
    .orderBy(desc(schedulerRuns.startedAt))
    .limit(1);
  return r?.at?.toISOString() ?? null;
}

/** `GET /v1/inventory/memory-stores`: one entry per store — counts, oldest
 * row, isolation, the retention that applies and who enforces it. */
export async function memoryStoreInventory(db: Db, now: Date = new Date()): Promise<{ stores: MemoryStoreView[] }> {
  const settings = await loadOrgSettings(db);
  const cacheCutoff = new Date(now.getTime() - settings.semanticCacheTtlSeconds * 1000);
  const convCutoff = conversationRetentionCutoff(now, settings.conversationRetentionDays);
  const [cacheHeld, convHeld] = await Promise.all([semanticCacheHeldSql(), conversationHeldSql()]);
  const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
  const [[cache], [cacheHeldN], [conv], [convHeldN], [bam], [pci], cacheRun, convRun] = await Promise.all([
    db.select({ n: count(), oldest: sql<Date | string | null>`min(${semanticCache.createdAt})` }).from(semanticCache),
    db.select({ n: count() }).from(semanticCache).where(and(lt(semanticCache.createdAt, cacheCutoff), cacheHeld)),
    db.select({ n: count(), oldest: sql<Date | string | null>`min(${conversations.updatedAt})` }).from(conversations),
    db.select({ n: count() }).from(conversations).where(and(lt(conversations.updatedAt, convCutoff), convHeld)),
    db.select({ n: count(), oldest: sql<Date | string | null>`min(${builderAgentMemory.createdAt})` }).from(builderAgentMemory),
    db.select({ n: count(), oldest: sql<Date | string | null>`min(${projectContextItems.createdAt})` }).from(projectContextItems),
    lastOkRun(db, MEMORY_RETENTION_JOB_NAMES.semanticCachePurge),
    lastOkRun(db, MEMORY_RETENTION_JOB_NAMES.conversationRetention),
  ]);
  const noSweep = { setting: null, value: null, enforcedBy: null, lastRunAt: null };
  return {
    stores: [
      {
        kind: "semantic_cache",
        rows: cache?.n ?? 0,
        oldestAt: iso(cache?.oldest),
        isolation: "per user+agent",
        retention: {
          setting: "semanticCacheTtlSeconds",
          value: settings.semanticCacheTtlSeconds,
          enforcedBy: MEMORY_RETENTION_JOB_NAMES.semanticCachePurge,
          lastRunAt: cacheRun,
        },
        held: cacheHeldN?.n ?? 0,
        owner: { kind: "org" },
      },
      {
        kind: "conversations",
        rows: conv?.n ?? 0,
        // a conversation's age for retention is its last activity
        oldestAt: iso(conv?.oldest),
        isolation: "per user",
        retention: {
          setting: "conversationRetentionDays",
          value: settings.conversationRetentionDays,
          enforcedBy: MEMORY_RETENTION_JOB_NAMES.conversationRetention,
          lastRunAt: convRun,
        },
        held: convHeldN?.n ?? 0,
        owner: { kind: "org" },
      },
      {
        kind: "builder_agent_memory",
        rows: bam?.n ?? 0,
        oldestAt: iso(bam?.oldest),
        isolation: "per builder agent",
        retention: noSweep,
        held: null,
        owner: { kind: "org" },
      },
      {
        kind: "project_context_items",
        rows: pci?.n ?? 0,
        oldestAt: iso(pci?.oldest),
        isolation: "per project",
        retention: noSweep,
        held: null,
        owner: { kind: "org" },
      },
    ],
  };
}
