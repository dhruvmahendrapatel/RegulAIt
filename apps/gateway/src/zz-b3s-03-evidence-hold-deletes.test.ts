/**
 * B3S-03 (batch-3 security review) — every memory-retention DELETE is
 * serialised with evidence-hold creation.
 *
 * Under READ COMMITTED the hold re-check inside a DELETE reads the statement's
 * snapshot, so an incident (or link) committing while the DELETE ran was not
 * seen and the evidence was deleted. Each DELETE (a person's own conversation,
 * the conversation sweep, the semantic-cache sweep) now takes
 * EVIDENCE_HOLD_LOCK_KEY shared as its transaction's first statement; hold
 * creation takes it exclusive (incidents.ts).
 *
 * DETERMINISTIC, no sleeps: a second connection opens a transaction, takes the
 * hold lock EXCLUSIVE (exactly as incident create/link does), inserts an open
 * incident and its link, and stays open (the pause point). The DELETE is
 * started; the test waits until it is either finished or visibly queued on the
 * advisory lock (pg_locks), then commits the incident. The row must survive.
 *
 * Global state (M-068): every incident, conversation and cache row this file
 * makes is removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  aiIncidentLinks,
  aiIncidents,
  conversations,
  createDb,
  eq,
  inArray,
  runMigrations,
  semanticCache,
  sql,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { EVIDENCE_HOLD_LOCK_KEY, lockEvidenceHoldsExclusive } from "./agent-evidence-hold.js";
import { deleteOwnConversation, runConversationRetentionSweep, runSemanticCachePurgeSweep } from "./memory-retention.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `b3s03-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
/** the second connection pool: the in-flight hold-creating transaction */
let holderDb: Db;
let app: ReturnType<typeof buildApp>;
let userId = "";
const created = { incidents: [] as string[], conversations: [] as string[], cacheAgents: [] as string[] };

const KEY = BigInt(EVIDENCE_HOLD_LOCK_KEY);
/** sessions queued (not granted) on the evidence-hold advisory lock in this database */
async function holdLockWaiters(): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype = 'advisory' AND NOT granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND classid::bigint = ${Number(KEY >> 32n)} AND objid::bigint = ${Number(KEY & 0xffffffffn)} AND objsubid = 1`);
  return r.rows[0]!.n;
}

/** poll a CONDITION (never a fixed sleep) until it holds or the bound passes */
async function waitFor(pred: () => Promise<boolean>, ms = 8000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

/**
 * A hold being created on the second connection: the exclusive hold lock as the
 * first statement (as incidents.ts takes it), an open incident linking
 * `objectType`/`objectId`, and the transaction left OPEN until `commit()`.
 */
async function holdCreationInFlight(objectType: "agent" | "conversation", objectId: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let ready!: () => void;
  let failed!: (e: unknown) => void;
  const inserted = new Promise<void>((r, j) => {
    ready = r;
    failed = j;
  });
  const done = holderDb
    .transaction(async (raw) => {
      const tx = raw as unknown as Db;
      await lockEvidenceHoldsExclusive(tx);
      const [inc] = await tx
        .insert(aiIncidents)
        .values({ title: `b3s03 incident ${RUN}`, severity: "high", detectionSource: "manual", awareAt: new Date() })
        .returning({ id: aiIncidents.id });
      created.incidents.push(inc!.id);
      await tx.insert(aiIncidentLinks).values({ incidentId: inc!.id, objectType, objectId });
      ready();
      await gate;
    })
    .catch((e: unknown) => {
      failed(e);
      throw e;
    });
  await inserted;
  return {
    commit: async () => {
      release();
      await done;
    },
  };
}

/**
 * Start `del` while a hold is being created, let it either finish or queue on
 * the hold lock, then commit the hold. Returns what `del` returned and whether
 * it had queued behind the hold (true with the fix).
 */
async function deleteDuringHoldCreation<T>(
  objectType: "agent" | "conversation",
  objectId: string,
  del: () => Promise<T>,
): Promise<{ result: T; queuedBehindHold: boolean }> {
  const hold = await holdCreationInFlight(objectType, objectId);
  expect(await holdLockWaiters()).toBe(0);
  let finished = false;
  const running = del().finally(() => {
    finished = true;
  });
  await waitFor(async () => finished || (await holdLockWaiters()) > 0);
  const queuedBehindHold = !finished && (await holdLockWaiters()) > 0;
  await hold.commit();
  return { result: await running, queuedBehindHold };
}

async function mkConversation(lastActivity: Date, agentId = randomUUID()) {
  const [row] = await db
    .insert(conversations)
    .values({ userId, agentId, title: `b3s03 ${RUN}`, createdAt: lastActivity, updatedAt: lastActivity })
    .returning();
  created.conversations.push(row!.id);
  return row!;
}
const convExists = async (id: string) =>
  (await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, id))).length === 1;
const cacheExists = async (id: string) =>
  (await db.select({ id: semanticCache.id }).from(semanticCache).where(eq(semanticCache.id, id))).length === 1;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  holderDb = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `b3s03-${RUN}@example.com`, displayName: `b3s03 ${RUN}` },
  });
  expect(u.statusCode, u.body).toBe(201);
  userId = u.json().id as string;
}, 120_000);

afterAll(async () => {
  for (const id of created.incidents) {
    await db.execute(sql`UPDATE ai_incidents SET status = 'closed', closed_at = now(), root_cause = 'fixture',
      lessons_learned = 'fixture' WHERE id = ${id} AND status <> 'closed'`);
  }
  if (created.incidents.length) await db.delete(aiIncidents).where(inArray(aiIncidents.id, created.incidents));
  if (created.conversations.length) await db.delete(conversations).where(inArray(conversations.id, created.conversations));
  if (created.cacheAgents.length) await db.delete(semanticCache).where(inArray(semanticCache.agentId, created.cacheAgents));
  await app.close();
});

describe("B3S-03: a retention DELETE waits for an in-flight hold and then honours it", () => {
  it("a person's DELETE of their own conversation, while an incident linking it is being created", async () => {
    const conv = await mkConversation(new Date());
    const { result, queuedBehindHold } = await deleteDuringHoldCreation("conversation", conv.id, () =>
      deleteOwnConversation(db, conv.id, userId),
    );
    expect(await convExists(conv.id), "deleted while an incident linking it was being created").toBe(true);
    expect(result).toEqual({ deleted: false, held: true });
    expect(queuedBehindHold).toBe(true);
  });

  it("the conversation-retention sweep, while an incident linking an expired conversation is being created", async () => {
    const conv = await mkConversation(new Date("2000-01-01T00:00:00Z"));
    const { result, queuedBehindHold } = await deleteDuringHoldCreation("conversation", conv.id, () =>
      runConversationRetentionSweep(db, new Date()),
    );
    expect(await convExists(conv.id), "swept while an incident linking it was being created").toBe(true);
    expect(result.heldIds).toContain(conv.id);
    expect(queuedBehindHold).toBe(true);
  });

  it("the semantic-cache sweep, while an incident covering the row's agent is being created", async () => {
    const agentId = randomUUID();
    created.cacheAgents.push(agentId);
    const [row] = await db
      .insert(semanticCache)
      .values({
        userId,
        agentId,
        promptHash: `b3s03-${RUN}`,
        normalizedInput: "b3s03 prompt",
        outputText: "b3s03 answer",
        createdAt: new Date("2000-01-01T00:00:00Z"),
      })
      .returning({ id: semanticCache.id });
    const { result, queuedBehindHold } = await deleteDuringHoldCreation("agent", agentId, () =>
      runSemanticCachePurgeSweep(db, new Date()),
    );
    expect(await cacheExists(row!.id), "purged while an incident covering its agent was being created").toBe(true);
    expect(result.held).toBeGreaterThanOrEqual(1);
    expect(queuedBehindHold).toBe(true);
  });
});
