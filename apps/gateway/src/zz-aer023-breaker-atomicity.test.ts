import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, eq, mcpServers, runMigrations, sql, type Db } from "@regulait/db";
import {
  BREAKER_RULE_IDS, breakerAdmits, recordUpstreamFailure, recordUpstreamSuccess,
  type BreakerRow,
} from "./upstream-breaker.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations",
);
const name = `aer023-inject-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const config = { failureThreshold: 1, cooldownMs: 0 };
let db: Db;
let serverId: string;

const read = async (): Promise<BreakerRow> => {
  const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
  return row!;
};
const count = async (ruleId: string) =>
  (await db.select({ id: auditLog.id }).from(auditLog).where(and(
    eq(auditLog.objectId, serverId), eq(auditLog.ruleId, ruleId),
  ))).length;

async function withAuditFailure(run: () => Promise<void>): Promise<void> {
  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION aer023_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.reason LIKE '%${name}%' THEN
        RAISE EXCEPTION 'aer023 injected audit failure';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER aer023_test_reject_audit BEFORE INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION aer023_test_reject_audit();
  `));
  try {
    await run();
  } finally {
    await db.execute(sql.raw("DROP TRIGGER IF EXISTS aer023_test_reject_audit ON audit_log"));
    await db.execute(sql.raw("DROP FUNCTION IF EXISTS aer023_test_reject_audit()"));
  }
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  const [row] = await db.insert(mcpServers).values({ name, url: "http://127.0.0.1:9/" })
    .returning({ id: mcpServers.id });
  serverId = row!.id;
});

afterAll(async () => {
  await db.execute(sql.raw("DROP TRIGGER IF EXISTS aer023_test_reject_audit ON audit_log"));
  await db.execute(sql.raw("DROP FUNCTION IF EXISTS aer023_test_reject_audit()"));
  await db.delete(mcpServers).where(eq(mcpServers.id, serverId));
  await db.$client.end();
});

describe("AER-023 breaker transition facts commit with state", () => {
  it("rolls back an open transition when its audit insert fails", async () => {
    const before = await count(BREAKER_RULE_IDS.opened);
    await withAuditFailure(async () => {
      await expect(recordUpstreamFailure(db, await read(), "unreachable", config))
        .rejects.toThrow();
      const state = await read();
      expect(state.breakerConsecutiveFailures).toBe(0);
      expect(state.breakerOpenedAt).toBeNull();
      expect(await count(BREAKER_RULE_IDS.opened)).toBe(before);
    });
    await recordUpstreamFailure(db, await read(), "unreachable", config);
    expect((await read()).breakerOpenedAt).not.toBeNull();
  });

  it("rolls back a half-open election when its audit insert fails", async () => {
    if ((await read()).breakerOpenedAt === null) {
      await recordUpstreamFailure(db, await read(), "unreachable", config);
    }
    await db.update(mcpServers).set({ breakerOpenedAt: new Date(Date.now() - 1000) })
      .where(eq(mcpServers.id, serverId));
    const beforeState = await read();
    const beforeAudit = await count(BREAKER_RULE_IDS.probing);
    await withAuditFailure(async () => {
      await expect(breakerAdmits(db, beforeState, config))
        .rejects.toThrow();
      expect((await read()).breakerOpenedAt?.getTime())
        .toBe(beforeState.breakerOpenedAt?.getTime());
      expect(await count(BREAKER_RULE_IDS.probing)).toBe(beforeAudit);
    });
    expect(await breakerAdmits(db, beforeState, config)).toBeNull();
    expect(await count(BREAKER_RULE_IDS.probing)).toBe(beforeAudit + 1);
  });

  it("rolls back a close transition when its audit insert fails", async () => {
    if ((await read()).breakerOpenedAt === null) {
      await recordUpstreamFailure(db, await read(), "unreachable", config);
    }
    const beforeAudit = await count(BREAKER_RULE_IDS.closed);
    await withAuditFailure(async () => {
      await expect(recordUpstreamSuccess(db, await read()))
        .rejects.toThrow();
      expect((await read()).breakerOpenedAt).not.toBeNull();
      expect(await count(BREAKER_RULE_IDS.closed)).toBe(beforeAudit);
    });
    await recordUpstreamSuccess(db, await read());
    expect((await read()).breakerOpenedAt).toBeNull();
    expect(await count(BREAKER_RULE_IDS.closed)).toBe(beforeAudit + 1);
  });

  it("serializes twenty failures into one open fact and one recovery fact", async () => {
    const beforeOpen = await count(BREAKER_RULE_IDS.opened);
    const row = await read();
    await Promise.all(Array.from({ length: 20 }, () =>
      recordUpstreamFailure(db, row, "unreachable", config)));
    expect((await read()).breakerConsecutiveFailures).toBe(20);
    expect(await count(BREAKER_RULE_IDS.opened)).toBe(beforeOpen + 1);
    const beforeClosed = await count(BREAKER_RULE_IDS.closed);
    await Promise.all(Array.from({ length: 20 }, () => recordUpstreamSuccess(db, row)));
    expect((await read()).breakerOpenedAt).toBeNull();
    expect(await count(BREAKER_RULE_IDS.closed)).toBe(beforeClosed + 1);
  }, 60_000);
});
