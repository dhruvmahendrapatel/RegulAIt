import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents, asc, auditLog, createDb, eq, mcpServers, mcpTools, ORG_SETTINGS_ID,
  orgSettings, runMigrations, sql, type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations",
);
const tag = `aer019-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const AUTH = { authorization: `Bearer ${tag}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let agentId: string;
let serverId: string;
let toolId: string;
const toolName = `${tag}-tool`;
const reason = "aer019 test incident with an operator reason";
const failReason = "aer019-inject deliberate audit failure";

const mode = (value: string, why = reason) => app.inject({
  method: "PUT", url: "/v1/execution/mode", headers: AUTH,
  payload: { mode: value, reason: why },
});
const agent = (action: "halt" | "unhalt", why = reason) => app.inject({
  method: "POST", url: `/v1/agents/${agentId}/${action}`, headers: AUTH,
  payload: { reason: why },
});
const tool = (action: "halt" | "unhalt", why = reason) => app.inject({
  method: "POST", url: `/v1/servers/${serverId}/tools/${toolName}/${action}`,
  headers: AUTH, payload: { reason: why },
});

const auditCount = async (ruleId: string) =>
  (await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.ruleId, ruleId))).length;
const currentMode = async () =>
  (await db.select({ mode: orgSettings.executionMode }).from(orgSettings)
    .where(eq(orgSettings.id, ORG_SETTINGS_ID)))[0]?.mode;
const currentAgent = async () =>
  (await db.select({ haltedAt: agents.haltedAt }).from(agents).where(eq(agents.id, agentId)))[0]?.haltedAt;
const currentTool = async () =>
  (await db.select({ haltedAt: mcpTools.haltedAt }).from(mcpTools).where(eq(mcpTools.id, toolId)))[0]?.haltedAt;
async function restartAndRead(): Promise<{
  mode: string;
  haltedAgents: Array<{ id: string }>;
  haltedTools: Array<{ name: string }>;
}> {
  await app.close();
  app = buildApp(db, { bootstrapToken: tag, dataKey: "a".repeat(64) });
  const response = await app.inject({ method: "GET", url: "/v1/execution", headers: AUTH });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function withAuditFailure(run: () => Promise<void>): Promise<void> {
  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION aer019_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.reason LIKE '%aer019-inject%' THEN
        RAISE EXCEPTION 'aer019 injected audit failure';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER aer019_test_reject_audit BEFORE INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION aer019_test_reject_audit();
  `));
  try {
    await run();
  } finally {
    await db.execute(sql.raw("DROP TRIGGER IF EXISTS aer019_test_reject_audit ON audit_log"));
    await db.execute(sql.raw("DROP FUNCTION IF EXISTS aer019_test_reject_audit()"));
  }
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: tag, dataKey: "a".repeat(64) });
  const [a] = await db.insert(agents).values({ name: `${tag}-agent`, provider: "mock", tier: 1 })
    .returning({ id: agents.id });
  agentId = a!.id;
  const [s] = await db.insert(mcpServers).values({ name: `${tag}-server`, url: "http://127.0.0.1:9/" })
    .returning({ id: mcpServers.id });
  serverId = s!.id;
  const [t] = await db.insert(mcpTools).values({ serverId, name: toolName, kind: "write" })
    .returning({ id: mcpTools.id });
  toolId = t!.id;
  await mode("normal");
});

afterAll(async () => {
  await db.execute(sql.raw("DROP TRIGGER IF EXISTS aer019_test_reject_audit ON audit_log"));
  await db.execute(sql.raw("DROP FUNCTION IF EXISTS aer019_test_reject_audit()"));
  await mode("normal", "aer019 teardown returned to normal mode");
  await db.delete(mcpServers).where(eq(mcpServers.id, serverId));
  await db.delete(agents).where(eq(agents.id, agentId));
  await app.close();
  await db.$client.end();
});

describe("AER-019 emergency transitions are one durable fact", () => {
  it("rolls back mode set and clear when their audit insert fails", async () => {
    const setBefore = await auditCount("execution-mode-set");
    await withAuditFailure(async () => {
      expect((await mode("halted", failReason)).statusCode).toBe(500);
      expect(await currentMode()).toBe("normal");
      expect(await auditCount("execution-mode-set")).toBe(setBefore);
    });
    expect((await restartAndRead()).mode).toBe("normal");
    expect((await mode("halted")).json().changed).toBe(true);
    const clearBefore = await auditCount("execution-mode-cleared");
    await withAuditFailure(async () => {
      expect((await mode("normal", failReason)).statusCode).toBe(500);
      expect(await currentMode()).toBe("halted");
      expect(await auditCount("execution-mode-cleared")).toBe(clearBefore);
    });
    expect((await restartAndRead()).mode).toBe("halted");
    expect((await mode("normal")).json().changed).toBe(true);
  });

  it("rolls back agent halt and lift when their audit insert fails", async () => {
    const haltBefore = await auditCount("execution-agent-halted");
    await withAuditFailure(async () => {
      expect((await agent("halt", failReason)).statusCode).toBe(500);
      expect(await currentAgent()).toBeNull();
      expect(await auditCount("execution-agent-halted")).toBe(haltBefore);
    });
    expect((await restartAndRead()).haltedAgents.some((row) => row.id === agentId)).toBe(false);
    expect((await agent("halt")).json().changed).toBe(true);
    const liftBefore = await auditCount("execution-agent-unhalted");
    await withAuditFailure(async () => {
      expect((await agent("unhalt", failReason)).statusCode).toBe(500);
      expect(await currentAgent()).not.toBeNull();
      expect(await auditCount("execution-agent-unhalted")).toBe(liftBefore);
    });
    expect((await restartAndRead()).haltedAgents.some((row) => row.id === agentId)).toBe(true);
    expect((await agent("unhalt")).json().changed).toBe(true);
  });

  it("rolls back tool halt and lift when their audit insert fails", async () => {
    const haltBefore = await auditCount("execution-tool-halted");
    await withAuditFailure(async () => {
      expect((await tool("halt", failReason)).statusCode).toBe(500);
      expect(await currentTool()).toBeNull();
      expect(await auditCount("execution-tool-halted")).toBe(haltBefore);
    });
    expect((await restartAndRead()).haltedTools.some((row) => row.name === toolName)).toBe(false);
    expect((await tool("halt")).json().changed).toBe(true);
    const liftBefore = await auditCount("execution-tool-unhalted");
    await withAuditFailure(async () => {
      expect((await tool("unhalt", failReason)).statusCode).toBe(500);
      expect(await currentTool()).not.toBeNull();
      expect(await auditCount("execution-tool-unhalted")).toBe(liftBefore);
    });
    expect((await restartAndRead()).haltedTools.some((row) => row.name === toolName)).toBe(true);
    expect((await tool("unhalt")).json().changed).toBe(true);
  });

  it("serializes twenty simultaneous halt requests into one transition", async () => {
    const before = await auditCount("execution-agent-halted");
    const results = await Promise.all(Array.from({ length: 20 }, () => agent("halt")));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(results.filter((r) => r.json().changed === true)).toHaveLength(1);
    expect(results.filter((r) => r.json().changed === false)).toHaveLength(19);
    expect(await auditCount("execution-agent-halted")).toBe(before + 1);
    expect(await currentAgent()).not.toBeNull();
    await agent("unhalt");
  }, 60_000);

  it("serializes twenty simultaneous mode changes and tool halts", async () => {
    const modeBefore = await auditCount("execution-mode-set");
    const modes = await Promise.all(Array.from({ length: 20 }, () => mode("halted")));
    expect(modes.every((r) => r.statusCode === 200)).toBe(true);
    expect(modes.filter((r) => r.json().changed === true)).toHaveLength(1);
    expect(await auditCount("execution-mode-set")).toBe(modeBefore + 1);
    expect(await currentMode()).toBe("halted");
    await mode("normal");

    const toolBefore = await auditCount("execution-tool-halted");
    const tools = await Promise.all(Array.from({ length: 20 }, () => tool("halt")));
    expect(tools.every((r) => r.statusCode === 200)).toBe(true);
    expect(tools.filter((r) => r.json().changed === true)).toHaveLength(1);
    expect(await auditCount("execution-tool-halted")).toBe(toolBefore + 1);
    expect(await currentTool()).not.toBeNull();
    await tool("unhalt");
  }, 60_000);

  it("records conflicting concurrent mode changes in committed order", async () => {
    expect(await currentMode()).toBe("normal");
    const [halted, readOnly] = await Promise.all([
      mode("halted", `${reason} mixed-halt`),
      mode("read_only", `${reason} mixed-read-only`),
    ]);
    expect(halted.json().changed).toBe(true);
    expect(readOnly.json().changed).toBe(true);
    const rows = await db.select({ detail: auditLog.detail }).from(auditLog)
      .where(eq(auditLog.ruleId, "execution-mode-set")).orderBy(asc(auditLog.seq));
    const [first, second] = rows.slice(-2).map((row) => row.detail as { from: string; to: string });
    expect(first!.from).toBe("normal");
    expect(second!.from).toBe(first!.to);
    expect(second!.to).toBe(await currentMode());
    await mode("normal");
  });
});
