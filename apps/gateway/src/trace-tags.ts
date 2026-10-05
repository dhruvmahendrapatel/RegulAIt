/**
 * ADR-0173 batch 2c (T) — TRACE TAGS: key/value labels on a trace, so people
 * can find and group traces ("release=2026.10", "customer-escalation").
 *
 * THE RULES, each a test in `trace-tags.test.ts`:
 *  1. **Only the trace's owner or an admin writes its tags.** Anyone else gets
 *     403 and a deny audit row (the same posture as reading the trace,
 *     ADR-0070 rule 4). The bulk route skips such a trace with a reason and
 *     audits the refusal; for a non-admin it does not say whether the trace
 *     exists (`not_found_or_forbidden`).
 *  2. **Shape:** a key matches `^[a-z0-9_.-]{1,64}$` (also a DB CHECK); a value
 *     is at most 256 characters (also a DB CHECK); at most 20 tags per trace;
 *     keys under `regulait.` are reserved for system-written tags and refused.
 *  3. **The 20-tag cap holds under concurrency:** each write locks the trace
 *     row (`SELECT … FOR UPDATE`) before counting, so two writers cannot both
 *     see 19 and both insert.
 *  4. **Every write is audited** (`trace-tag-set` / `trace-tag-removed`), with
 *     the key and value: a tag is a label a person chose, not trace content.
 *
 * Reading tags rides the trace list and tree (tracing.ts), which are already
 * owner-or-admin scoped, so there is no separate read route to get wrong.
 *
 * Open source first: zod (validation) and drizzle (SQL) do the generic work;
 * who may label whose trace is governance logic, so none fits beyond those.
 */
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { and, auditLog, count, eq, inArray, traceTags, traces, type Db } from "@regulait/db";
import { TRACE_TAG_KEY_PATTERN, TRACE_TAG_LIMITS } from "@regulait/shared";

export const TRACE_TAG_RULE_IDS = {
  set: "trace-tag-set",
  removed: "trace-tag-removed",
  refused: "trace-tag-refused",
} as const;

/** the most traces one bulk-tag call may touch */
export const TRACE_TAG_BULK_MAX = 200;

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export const traceTagKeySchema = z
  .string()
  .regex(TRACE_TAG_KEY_PATTERN, "a tag key is 1-64 characters of a-z, 0-9, '_', '.' or '-'")
  .refine((k) => !k.startsWith(TRACE_TAG_LIMITS.reservedPrefix), {
    message: `keys starting '${TRACE_TAG_LIMITS.reservedPrefix}' are reserved for system-written tags`,
  });
export const traceTagValueSchema = z.string().max(TRACE_TAG_LIMITS.valueChars);

const tagParams = z.object({ traceId: z.string().uuid(), key: z.string().min(1).max(200) });
const putBody = z.object({ value: traceTagValueSchema.default("") }).strict();
const bulkBody = z
  .object({
    traceIds: z.array(z.string().uuid()).min(1).max(TRACE_TAG_BULK_MAX),
    key: traceTagKeySchema,
    value: traceTagValueSchema.default(""),
  })
  .strict();

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Upsert one tag on one (already authorised) trace inside `tx`, honouring the
 * per-trace cap. Locks the trace row first (rule 3).
 */
async function upsertTag(
  tx: Tx,
  traceId: string,
  key: string,
  value: string,
  userId: string | null,
): Promise<"set" | "tag_limit" | "not_found"> {
  const [locked] = await tx.select({ id: traces.id }).from(traces).where(eq(traces.id, traceId)).for("update");
  if (!locked) return "not_found";
  const [existing] = await tx
    .select({ id: traceTags.id })
    .from(traceTags)
    .where(and(eq(traceTags.traceId, traceId), eq(traceTags.key, key)));
  if (existing) {
    await tx.update(traceTags).set({ value, updatedAt: new Date() }).where(eq(traceTags.id, existing.id));
    return "set";
  }
  const [n] = await tx.select({ n: count() }).from(traceTags).where(eq(traceTags.traceId, traceId));
  if ((n?.n ?? 0) >= TRACE_TAG_LIMITS.tagsPerTrace) return "tag_limit";
  await tx.insert(traceTags).values({ traceId, key, value, createdByUserId: userId });
  return "set";
}

/** the tags of these traces, keyed by trace id, in key order */
export async function loadTraceTags(db: Db, traceIds: readonly string[]): Promise<Map<string, Array<{ key: string; value: string }>>> {
  const out = new Map<string, Array<{ key: string; value: string }>>();
  if (traceIds.length === 0) return out;
  const rows = await db
    .select({ traceId: traceTags.traceId, key: traceTags.key, value: traceTags.value })
    .from(traceTags)
    .where(inArray(traceTags.traceId, [...traceIds]))
    .orderBy(traceTags.traceId, traceTags.key);
  for (const r of rows) {
    const list = out.get(r.traceId) ?? [];
    list.push({ key: r.key, value: r.value });
    out.set(r.traceId, list);
  }
  return out;
}

export function registerTraceTagRoutes(app: FastifyInstance, db: Db): void {
  const audit = async (
    userId: string | null,
    objectId: string | null,
    ruleId: string,
    effect: "allow" | "deny",
    reason: string,
    detail: Record<string, unknown>,
  ) => {
    await db.insert(auditLog).values({
      userId: userId ?? NIL_UUID,
      objectType: "trace",
      objectId,
      detail,
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });
  };

  /** 404 / 403(+audit) / ok for a single-trace write */
  const authorise = async (
    req: { authCtx: { userId: string | null; isAdmin: boolean } },
    reply: FastifyReply,
    traceId: string,
    action: string,
  ): Promise<boolean> => {
    const [row] = await db.select({ userId: traces.userId }).from(traces).where(eq(traces.id, traceId));
    if (!row) {
      reply.status(404).send({ error: "not_found" });
      return false;
    }
    if (!req.authCtx.isAdmin && row.userId !== req.authCtx.userId) {
      await audit(req.authCtx.userId, traceId, TRACE_TAG_RULE_IDS.refused, "deny", `refused to ${action} a tag on another user's trace`, {});
      reply.status(403).send({
        error: "forbidden",
        detail: "only the trace's owner or an admin may change its tags",
      });
      return false;
    }
    return true;
  };

  app.put("/v1/traces/:traceId/tags/:key", async (req, reply) => {
    const { traceId, key: rawKey } = tagParams.parse(req.params);
    const key = traceTagKeySchema.parse(rawKey);
    const { value } = putBody.parse(req.body ?? {});
    if (!(await authorise(req, reply, traceId, "set"))) return reply;
    const result = await db.transaction((tx) => upsertTag(tx, traceId, key, value, req.authCtx.userId));
    if (result === "not_found") return reply.status(404).send({ error: "not_found" });
    if (result === "tag_limit") {
      return reply.status(409).send({
        error: "tag_limit",
        detail: `a trace carries at most ${TRACE_TAG_LIMITS.tagsPerTrace} tags; remove one first`,
      });
    }
    await audit(req.authCtx.userId, traceId, TRACE_TAG_RULE_IDS.set, "allow", `tagged trace ${key}=${value}`, { key, value });
    return { traceId, key, value };
  });

  app.delete("/v1/traces/:traceId/tags/:key", async (req, reply) => {
    const { traceId, key: rawKey } = tagParams.parse(req.params);
    // a reserved (system-written) tag is not a person's to remove either
    const key = traceTagKeySchema.parse(rawKey);
    if (!(await authorise(req, reply, traceId, "remove"))) return reply;
    const removed = await db
      .delete(traceTags)
      .where(and(eq(traceTags.traceId, traceId), eq(traceTags.key, key)))
      .returning({ value: traceTags.value });
    if (removed.length === 0) return reply.status(404).send({ error: "tag_not_found" });
    await audit(req.authCtx.userId, traceId, TRACE_TAG_RULE_IDS.removed, "allow", `removed tag ${key}`, {
      key,
      value: removed[0]!.value,
    });
    return { traceId, key, removed: true };
  });

  /**
   * BULK: one key=value on many traces (the multi-select "Tag" action).
   * Answers `{added, skipped:[{id, reason}]}` — the same shape the dataset and
   * annotation-queue actions answer, so the page reports all three alike.
   */
  app.post("/v1/traces/tags", async (req) => {
    const body = bulkBody.parse(req.body ?? {});
    const ids = [...new Set(body.traceIds)];
    const isAdmin = req.authCtx.isAdmin;
    const rows = await db.select({ id: traces.id, userId: traces.userId }).from(traces).where(inArray(traces.id, ids));
    const owner = new Map(rows.map((r) => [r.id, r.userId]));
    const skipped: Array<{ id: string; reason: string }> = [];
    const allowed: string[] = [];
    const refused: string[] = [];
    for (const id of ids) {
      const o = owner.get(id);
      if (isAdmin) {
        if (o === undefined) skipped.push({ id, reason: "not_found" });
        else allowed.push(id);
      } else if (o === undefined || o !== req.authCtx.userId) {
        // a non-admin is not told whether somebody else's trace exists
        skipped.push({ id, reason: "not_found_or_forbidden" });
        if (o !== undefined) refused.push(id);
      } else {
        allowed.push(id);
      }
    }
    if (refused.length > 0) {
      await audit(
        req.authCtx.userId,
        null,
        TRACE_TAG_RULE_IDS.refused,
        "deny",
        `refused to tag ${refused.length} trace(s) owned by another user`,
        { traceIds: refused, key: body.key },
      );
    }
    const added: string[] = [];
    for (const id of allowed) {
      const result = await db.transaction((tx) => upsertTag(tx, id, body.key, body.value, req.authCtx.userId));
      if (result === "set") added.push(id);
      else skipped.push({ id, reason: result });
    }
    if (added.length > 0) {
      await db.insert(auditLog).values(
        added.map((id) => ({
          userId: req.authCtx.userId ?? NIL_UUID,
          objectType: "trace" as const,
          objectId: id,
          detail: { key: body.key, value: body.value, bulk: true },
          effect: "allow" as const,
          ruleId: TRACE_TAG_RULE_IDS.set,
          ruleChain: [],
          reason: `tagged trace ${body.key}=${body.value}`,
        })),
      );
    }
    return { added: added.length, addedIds: added, skipped };
  });
}
