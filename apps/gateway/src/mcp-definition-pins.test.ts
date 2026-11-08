/**
 * ADR-0246 — MCP definition pinning (rug-pull detection), on a real database through the real app, against the
 * deliberately vulnerable fixtures of `@regulait/mcp-vuln-fixtures` served over HTTP:
 *
 *  - the first admitted manifest is the baseline (tools, prompts, resources), audited;
 *  - after a rug pull, every change is recorded as changed since approval and audited in the sync's transaction;
 *    under the strict default the changed and added tools are neither stored nor returned, a call to one is refused
 *    before the upstream sees a `tools/call`, and a changed prompt or resource is refused by the same gate;
 *  - the admin diff is an RFC 6902 patch; re-approval needs the step-up, is a compare-and-set on the reviewed
 *    digest, and is audited; a removed item is acknowledged;
 *  - 'warn' serves the change and audits it; relaxing to 'warn' needs the step-up and is audited;
 *  - the poisoning, shadowing and exfiltration fixtures are held by admission and never baselined; the excessive-
 *    permissions fixture's broad tools are classed as writes.
 *
 * Global state (M-068): every org setting this file moves is put back in afterAll. Servers and users are its own.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  desc,
  eq,
  mcpDefinitionPins,
  mcpServers,
  mcpTools,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  users,
  type Db,
} from "@regulait/db";
import { BATCH4_STRICT_DEFAULTS } from "@regulait/shared";
import { fixtureState, pull, serveFixtureOverHttp, vulnFixture, type McpAttackClass, type ServedFixture } from "@regulait/mcp-vuln-fixtures";
import { buildApp } from "./app.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
import {
  definitionPinRefusal,
  MCP_DEFINITION_APPROVED_RULE_ID,
  MCP_DEFINITION_BLOCKED_RULE_ID,
  MCP_DEFINITION_CHANGED_RULE_ID,
  MCP_DEFINITIONS_PINNED_RULE_ID,
  serverChangedSinceApproval,
} from "./mcp-definition-pins.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must name a disposable test database");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `pins-boot-${RUN}`;
const boot = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminKey: { authorization: string };
const restores: Array<() => Promise<void>> = [];
const served: ServedFixture[] = [];

const setPinMode = (mode: "block" | "warn") =>
  db.update(orgSettings).set({ mcpDefinitionPinMode: mode }).where(eq(orgSettings.id, ORG_SETTINGS_ID));

beforeAll(async () => {
  db = createDb(databaseUrl);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  restores.push(await relaxStrictAdmissionForTest(db));
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [before] = await db
    .select({ mode: orgSettings.stepUpMode, actions: orgSettings.stepUpActions, pin: orgSettings.mcpDefinitionPinMode, admission: orgSettings.mcpAdmissionMode })
    .from(orgSettings)
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await db
    .update(orgSettings)
    .set({ stepUpMode: "required", stepUpActions: [...BATCH4_STRICT_DEFAULTS.stepUpActions], mcpDefinitionPinMode: "block", mcpAdmissionMode: "enforce" })
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(async () => {
    await db
      .update(orgSettings)
      .set({ stepUpMode: before!.mode, stepUpActions: before!.actions, mcpDefinitionPinMode: before!.pin, mcpAdmissionMode: before!.admission })
      .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });
  app = buildApp(db, {
    bootstrapToken: BOOT,
    retry: { maxAttempts: 1 },
    timeouts: { mcpConnectMs: 2000, mcpListToolsMs: 2000, mcpCallToolMs: 2000 },
  });
  restores.push(await relaxGovernanceGatesForTest(db, { requireMcpAttribution: false }));
  await app.ready();
  const a = await app.inject({ method: "POST", url: "/v1/users", headers: boot, payload: { email: `pins-admin-${RUN}@example.test`, displayName: "Pins admin" } });
  expect(a.statusCode, a.body).toBe(201);
  adminId = a.json().id;
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  const key = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: boot, payload: { name: "pins" } });
  adminKey = { authorization: `Bearer ${key.json().token}` };
}, 120_000);

afterAll(async () => {
  for (const s of served) await s.close();
  for (const restore of restores.reverse()) await restore();
  await app.close();
});

async function register(id: McpAttackClass) {
  const state = fixtureState(vulnFixture(id));
  const s = await serveFixtureOverHttp(state);
  served.push(s);
  const r = await app.inject({ method: "POST", url: "/v1/servers", headers: boot, payload: { name: `pins-${id}-${crypto.randomUUID()}`, url: s.url } });
  expect(r.statusCode, r.body).toBe(201);
  return { serverId: r.json().id as string, state, served: s };
}

const syncFacts = (serverId: string) => ({ kind: "settings_relax" as const, facts: { serverId, values: { mcpToolSync: serverId } } });
async function sync(serverId: string) {
  const g = await grantStepUpForTest(db, adminId, syncFacts(serverId));
  return app.inject({ method: "POST", url: `/v1/servers/${serverId}/tools/sync`, ...stepUpRequest(g) });
}

type Item = { kind: string; name: string; observedDigest: string | null };
const approveFacts = (serverId: string, items: Item[]) => ({
  kind: "settings_relax" as const,
  facts: {
    serverId,
    values: { mcpDefinitionPinsApproved: [...items].sort((a, b) => (a.kind + a.name < b.kind + b.name ? -1 : 1)).map((i) => [i.kind, i.name, i.observedDigest]) },
  },
});
async function approve(serverId: string, items: Item[], reason = "reviewed the diff") {
  const g = await grantStepUpForTest(db, adminId, approveFacts(serverId, items));
  return app.inject({ method: "POST", url: `/v1/servers/${serverId}/definition-pins/approve`, ...stepUpRequest(g), payload: { items, reason } });
}

const pinsOf = async (serverId: string) => {
  const r = await app.inject({ method: "GET", url: `/v1/servers/${serverId}/definition-pins?limit=200`, headers: boot });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as {
    changedSinceApproval: boolean;
    pendingCount: number;
    pinnedAt: string | null;
    pins: Array<{ kind: string; name: string; status: string; observedDigest: string | null; approvedBy: string | null; diff: Array<{ op: string; path: string }> }>;
  };
};
const pin = (body: Awaited<ReturnType<typeof pinsOf>>, kind: string, name: string) => body.pins.find((p) => p.kind === kind && p.name === name);
const lastAudit = async (ruleId: string, serverId: string) =>
  (await db.select().from(auditLog).where(and(eq(auditLog.ruleId, ruleId), eq(auditLog.serverId, serverId))).orderBy(desc(auditLog.seq)).limit(1))[0];
const storedTools = async (serverId: string) =>
  db.select({ name: mcpTools.name, description: mcpTools.description, kind: mcpTools.kind }).from(mcpTools).where(eq(mcpTools.serverId, serverId));

describe("ADR-0246: a rug pull under the strict default", () => {
  let rug: Awaited<ReturnType<typeof register>>;

  it("takes the admission baseline of tools, prompts and resources at the first admitted manifest", async () => {
    rug = await register("rug-pull");
    const r = await sync(rug.serverId);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().toolCount).toBe(3);
    const body = await pinsOf(rug.serverId);
    expect(body.pinnedAt).not.toBeNull();
    expect(body.changedSinceApproval).toBe(false);
    expect(body.pins.map((p) => `${p.kind}:${p.name}:${p.status}`).sort()).toEqual(
      ["prompt:summarise:approved", "resource:notes://index:approved", "tool:archive_note:approved", "tool:get_weather:approved", "tool:list_notes:approved"].sort(),
    );
    expect(pin(body, "tool", "get_weather")!.approvedBy).toBeNull();
    expect((await lastAudit(MCP_DEFINITIONS_PINNED_RULE_ID, rug.serverId))?.effect).toBe("allow");
  });

  it("records every change since approval, audited, and neither stores nor returns a changed or added tool", async () => {
    pull(rug.state);
    const r = await sync(rug.serverId);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().toolCount).toBe(0);
    const tools = await storedTools(rug.serverId);
    expect(tools.find((t) => t.name === "get_weather")?.description).toBe("Returns the current weather for a city.");
    expect(tools.map((t) => t.name)).not.toContain("delete_all_notes");

    const body = await pinsOf(rug.serverId);
    expect(body.changedSinceApproval).toBe(true);
    expect(body.pendingCount).toBe(6);
    expect(pin(body, "tool", "get_weather")!.status).toBe("changed");
    expect(pin(body, "tool", "get_weather")!.diff).toEqual([expect.objectContaining({ op: "replace", path: "/description" })]);
    expect(pin(body, "tool", "list_notes")!.diff).toEqual([expect.objectContaining({ op: "remove", path: "/inputSchema/properties/folder/enum" })]);
    expect(pin(body, "tool", "delete_all_notes")!.status).toBe("added");
    expect(pin(body, "tool", "archive_note")!.status).toBe("removed");
    expect(pin(body, "prompt", "summarise")!.status).toBe("changed");
    expect(pin(body, "resource", "notes://index")!.status).toBe("changed");
    expect(await serverChangedSinceApproval(db, rug.serverId)).toBe(true);

    const changed = await lastAudit(MCP_DEFINITION_CHANGED_RULE_ID, rug.serverId);
    expect(changed?.effect).toBe("deny");
    expect((changed?.detail as { changeCount: number }).changeCount).toBe(6);

    const queue = await app.inject({ method: "GET", url: "/v1/mcp/definition-pins?limit=200", headers: boot });
    expect(queue.statusCode, queue.body).toBe(200);
    expect(queue.json().blocking).toBe(true);
    expect(queue.json().servers.find((s: { serverId: string }) => s.serverId === rug.serverId)).toMatchObject({ pending: 6, changedSinceApproval: true });
  });

  it("refuses a call to a changed or added tool before the upstream receives any tools/call", async () => {
    for (const toolName of ["get_weather", "delete_all_notes"]) {
      const out = await executeGovernedToolCall(db, undefined, { userId: adminId, serverId: rug.serverId, toolName, arguments: {} });
      expect(out.kind, toolName).toBe("denied");
      if (out.kind === "denied") expect(out.decision.ruleId).toBe(MCP_DEFINITION_BLOCKED_RULE_ID);
    }
    expect(rug.state.calls).toEqual([]);
    expect(rug.state.methods).not.toContain("tools/call");
  });

  it("the same gate refuses a changed prompt and a changed resource, and leaves an unpinned resource URI alone", async () => {
    expect((await definitionPinRefusal(db, rug.serverId, "prompt", "summarise"))?.status).toBe("changed");
    expect((await definitionPinRefusal(db, rug.serverId, "resource", "notes://index"))?.status).toBe("changed");
    expect(await definitionPinRefusal(db, rug.serverId, "resource", "notes://from-a-template/7")).toBeNull();
    expect(await definitionPinRefusal(db, rug.serverId, "prompt", "never-served")).toBeNull();
    expect((await definitionPinRefusal(db, rug.serverId, "tool", "never-served"))?.status).toBe("unpinned");
  });

  it("re-approval needs the step-up, is a compare-and-set on the reviewed digest, and is audited", async () => {
    const body = await pinsOf(rug.serverId);
    const weather = pin(body, "tool", "get_weather")!;
    const item = { kind: "tool", name: "get_weather", observedDigest: weather.observedDigest };

    const noStepUp = await app.inject({
      method: "POST",
      url: `/v1/servers/${rug.serverId}/definition-pins/approve`,
      headers: adminKey,
      payload: { items: [item], reason: "looks fine" },
    });
    expect(noStepUp.statusCode, noStepUp.body).toBe(403);
    expect(noStepUp.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });

    const stale = await approve(rug.serverId, [{ ...item, observedDigest: "0".repeat(64) }]);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error).toBe("definition_pin_stale");
    expect(pin(await pinsOf(rug.serverId), "tool", "get_weather")!.status).toBe("changed");

    const ok = await approve(rug.serverId, [item], "forecast added on purpose; reviewed");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().pendingCount).toBe(5);
    const after = pin(await pinsOf(rug.serverId), "tool", "get_weather")!;
    expect(after.status).toBe("approved");
    expect(after.approvedBy).toBe(adminId);
    const row = await lastAudit(MCP_DEFINITION_APPROVED_RULE_ID, rug.serverId);
    expect(row?.effect).toBe("allow");
    expect(row?.userId).toBe(adminId);

    // the approved tool is served and stored again, with the definition that was approved
    const r = await sync(rug.serverId);
    expect(r.json().toolCount).toBe(1);
    expect((await storedTools(rug.serverId)).find((t) => t.name === "get_weather")?.description).toContain("forecast");
  });

  it("acknowledging a removed item deletes its pin", async () => {
    const ok = await approve(rug.serverId, [{ kind: "tool", name: "archive_note", observedDigest: null }], "retired upstream");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(pin(await pinsOf(rug.serverId), "tool", "archive_note")).toBeUndefined();
  });
});

describe("ADR-0246: 'warn' and relaxing to it", () => {
  it("relaxing to 'warn' needs the step-up and is audited as a relaxation", async () => {
    const asked = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: adminKey, payload: { mcpDefinitionPinMode: "warn" } });
    expect(asked.statusCode, asked.body).toBe(403);
    expect(asked.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    const on = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: boot, payload: { mcpDefinitionPinMode: "warn" } });
    expect(on.statusCode, on.body).toBe(200);
    const row = (await db.select().from(auditLog).where(eq(auditLog.ruleId, "org-settings-updated")).orderBy(desc(auditLog.seq)).limit(1))[0];
    expect(JSON.stringify(row?.detail)).toContain("mcpDefinitionPinMode");
    await setPinMode("block");
  });

  it("under 'warn' a changed tool is stored and served, and the change is still audited", async () => {
    await setPinMode("warn");
    try {
      const rug = await register("rug-pull");
      expect((await sync(rug.serverId)).json().toolCount).toBe(3);
      pull(rug.state);
      const r = await sync(rug.serverId);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().toolCount).toBe(3);
      expect((await lastAudit(MCP_DEFINITION_CHANGED_RULE_ID, rug.serverId))?.effect).toBe("allow");
      expect(await definitionPinRefusal(db, rug.serverId, "tool", "get_weather")).toBeNull();
      expect((await pinsOf(rug.serverId)).changedSinceApproval).toBe(true);
    } finally {
      await setPinMode("block");
    }
  });
});

describe("ADR-0246: the vulnerable fixtures through admission", () => {
  for (const id of ["tool-poisoning", "tool-shadowing", "param-exfiltration"] as const) {
    it(`${id}: held by admission scanning, nothing stored, never baselined`, async () => {
      const f = await register(id);
      const r = await sync(f.serverId);
      expect(r.statusCode, r.body).toBe(403);
      expect(await storedTools(f.serverId)).toEqual([]);
      const [row] = await db.select({ state: mcpServers.admissionState, pinned: mcpServers.definitionsPinnedAt }).from(mcpServers).where(eq(mcpServers.id, f.serverId));
      expect(row).toEqual({ state: "held", pinned: null });
      expect(await db.select().from(mcpDefinitionPins).where(eq(mcpDefinitionPins.serverId, f.serverId))).toEqual([]);
      expect(f.state.calls).toEqual([]);
    });
  }

  it("excessive permissions: admitted, and every tool without a read-only hint is classed as a write", async () => {
    const f = await register("excessive-permissions");
    expect((await sync(f.serverId)).statusCode).toBe(200);
    const kinds = Object.fromEntries((await storedTools(f.serverId)).map((t) => [t.name, t.kind]));
    expect(kinds).toEqual({ read_calendar: "read", run_command: "write", query_database: "write" });
  });

  it("secrets in output and indirect injection: clean manifests are admitted and baselined (their defence is the output guardrail)", async () => {
    for (const id of ["secret-leak", "indirect-injection"] as const) {
      const f = await register(id);
      expect((await sync(f.serverId)).statusCode, id).toBe(200);
      expect((await pinsOf(f.serverId)).pinnedAt, id).not.toBeNull();
    }
  });
});
