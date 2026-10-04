/**
 * ADR-0175 batch D2 — A4 (record the served model; `served_model_drift`) and
 * A9 (`unregistered_ai_traffic`), end to end against the usage ledger.
 *
 * A4 pinned: a governed dispatch stores what the provider SAID it served in
 * `usage_events.served_model` and returns it on the result; a different served
 * model raises ONE medium episode per agent; an alias resolving to its dated
 * snapshot raises nothing; rows with no reported model raise nothing; an
 * approved card's pinned version turns a mismatch high; the alert resolves
 * once the window is clean; the inventory shows the last served model.
 *
 * A9 pinned: model/MCP spend on a project no approved use case links raises an
 * alert with a prefilled "register as use case" remediation; the dispatch is
 * never blocked; approving a use case linking the project resolves it;
 * projectless traffic groups by virtual key, else by caller.
 *
 * Shared database (M-008): every assertion is scoped to subjects this file
 * creates; the usage rows it writes are deleted and its use case retired at
 * the end, so no condition it created outlives it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  agents,
  aiUseCases,
  and,
  createDb,
  eq,
  governanceAlerts,
  inArray,
  modelCardApprovals,
  modelCards,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `g175m-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DAY = 86_400_000;

let db: Db;
let app: ReturnType<typeof buildApp>;
const admin = { id: "", auth: { authorization: "" } };
const ids = { swapped: "", aliased: "", pinned: "", silent: "", project: "", useCase: "", vk: randomUUID() };
const usageIds: string[] = [];

const call = (method: "GET" | "POST" | "PATCH", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const evaluate = async () => {
  const r = await call("POST", "/v1/governance/monitor/evaluate", admin.auth);
  expect(r.statusCode, r.body).toBe(200);
};
const alertsFor = (ruleId: string, subjectKey: string) =>
  db.select().from(governanceAlerts).where(and(eq(governanceAlerts.ruleId, ruleId), eq(governanceAlerts.subjectKey, subjectKey)));
const activeFor = async (ruleId: string, subjectKey: string) =>
  (await alertsFor(ruleId, subjectKey)).filter((a) => a.status !== "resolved");
const ledger = async (values: Partial<typeof usageEvents.$inferInsert>) => {
  const [row] = await db
    .insert(usageEvents)
    .values({ userId: admin.id, objectType: "agent", provider: "mock", ...values })
    .returning({ id: usageEvents.id });
  usageIds.push(row!.id);
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  const u = await call("POST", "/v1/users", AUTH, { email: `g175m-${RUN}@example.com`, displayName: `Monitor admin ${RUN}`, isAdmin: true });
  admin.id = u.json().id;
  admin.auth = { authorization: `Bearer ${(await call("POST", `/v1/users/${admin.id}/keys`, AUTH, { name: "k" })).json().token}` };

  const mk = async (name: string, model: string) => {
    const r = await call("POST", "/v1/agents", AUTH, { name: `g175m-${name}-${RUN}`, provider: "mock", tier: 1, model, costPerMTokIn: 1, costPerMTokOut: 2 });
    expect(r.statusCode, r.body).toBe(201);
    await call("POST", "/v1/grants/agents", AUTH, { userId: admin.id, agentId: r.json().id });
    await db.update(agents).set({ ownerUserId: admin.id }).where(eq(agents.id, r.json().id));
    return r.json().id as string;
  };
  ids.swapped = await mk("swapped", `g175m-model-${RUN}`);
  ids.aliased = await mk("aliased", `g175m-alias-${RUN}`);
  ids.pinned = await mk("pinned", `g175m-pin-${RUN}`);
  ids.silent = await mk("silent", `g175m-silent-${RUN}`);
  const p = await call("POST", "/v1/projects", AUTH, { name: `g175m-project-${RUN}` });
  expect(p.statusCode, p.body).toBe(201);
  ids.project = p.json().id;
}, 120_000);

afterAll(async () => {
  // a governed dispatch writes its own rows: collect every row this file's agents and project produced
  const own = await db
    .select({ id: usageEvents.id })
    .from(usageEvents)
    .where(inArray(usageEvents.agentId, [ids.swapped, ids.aliased, ids.pinned, ids.silent]));
  const all = [...new Set([...usageIds, ...own.map((r) => r.id)])];
  if (all.length) await db.delete(usageEvents).where(inArray(usageEvents.id, all));
  await db.delete(usageEvents).where(eq(usageEvents.projectId, ids.project));
  if (ids.useCase) await db.update(aiUseCases).set({ status: "retired" }).where(eq(aiUseCases.id, ids.useCase));
  // one last pass so the conditions this file created resolve rather than linger
  await call("POST", "/v1/governance/monitor/evaluate", admin.auth);
  app.server.closeAllConnections();
  await app.close();
});

describe("ADR-0175 A4 — the served model is recorded", () => {
  it("a governed dispatch stores and returns what the provider reported serving", async () => {
    const plain = await call("POST", `/v1/agents/${ids.swapped}/invoke`, admin.auth, { mode: "execute", input: "summarize the note", dispatch: true, costSensitivity: "quality-sensitive" });
    expect(plain.statusCode, plain.body).toBe(200);
    const swapped = await call("POST", `/v1/agents/${ids.swapped}/invoke`, admin.auth, {
      mode: "execute",
      input: "summarize the note <<serve-as:g175m-other-model>>",
      dispatch: true,
      costSensitivity: "quality-sensitive",
    });
    expect(swapped.statusCode, swapped.body).toBe(200);
    expect(swapped.json().dispatch.servedModel).toBe("g175m-other-model");
    expect(swapped.json().dispatch.model).toBe(`g175m-model-${RUN}`);
    const rows = await db
      .select({ model: usageEvents.model, servedModel: usageEvents.servedModel })
      .from(usageEvents)
      .where(eq(usageEvents.agentId, ids.swapped));
    expect(rows.map((r) => r.servedModel).sort()).toEqual([`g175m-model-${RUN}`, "g175m-other-model"].sort());
    expect(rows.every((r) => r.model === `g175m-model-${RUN}`)).toBe(true);
  });
});

describe("ADR-0175 A4 — served_model_drift", () => {
  it("raises ONE medium episode for the swapped agent, and nothing for an alias, a match, or an unreported model", async () => {
    // alias → its dated snapshot: the matching rule says same model
    await ledger({ agentId: ids.aliased, requestedAgentId: ids.aliased, model: `g175m-alias-${RUN}`, servedModel: `g175m-alias-${RUN}-20250101` });
    // the provider reported nothing: never counted
    await ledger({ agentId: ids.silent, requestedAgentId: ids.silent, model: `g175m-silent-${RUN}`, servedModel: null });
    // a second swapped call, so the episode carries both
    await ledger({ agentId: ids.swapped, requestedAgentId: ids.swapped, model: `g175m-model-${RUN}`, servedModel: "g175m-other-model" });
    await evaluate();

    const [alert, ...rest] = await activeFor("served_model_drift", `agent:${ids.swapped}`);
    expect(rest).toEqual([]);
    expect(alert).toMatchObject({ severity: "medium", status: "open" });
    expect(alert!.title).toBe(`g175m-swapped-${RUN} was served g175m-other-model instead of its configured g175m-model-${RUN} on 2 calls`);
    expect(alert!.detail).toMatchObject({ agentId: ids.swapped, calls: 2, windowDays: 7, pinnedModelVersions: [] });
    expect(await activeFor("served_model_drift", `agent:${ids.aliased}`)).toEqual([]);
    expect(await activeFor("served_model_drift", `agent:${ids.silent}`)).toEqual([]);

    const plan = await call("GET", `/v1/governance/alerts/${alert!.id}/remediation`, admin.auth);
    expect(plan.statusCode, plan.body).toBe(200);
    expect(plan.json().candidates.map((c: any) => [c.kind, c.executable])).toEqual([["review_served_model", false]]);

    const listed = await call("GET", "/v1/governance/alerts?status=active&limit=500", admin.auth);
    const row = listed.json().alerts.find((a: any) => a.id === alert!.id);
    expect(row).toMatchObject({ ruleLabel: "Provider served a different model than configured", subject: { type: "agent", id: ids.swapped, label: `g175m-swapped-${RUN}` } });
    expect(listed.json().rules.map((r: any) => r.id)).toEqual(expect.arrayContaining(["served_model_drift", "unregistered_ai_traffic"]));
  });

  it("an approved card's pinned version turns an otherwise alias-compatible id into a HIGH alert", async () => {
    const card = await call("POST", "/v1/mrm/cards", admin.auth, {
      agentId: ids.pinned,
      intendedUse: `g175m pinned use ${RUN}`,
      pinnedModelVersion: `g175m-pin-${RUN}-20250101`,
    });
    expect(card.statusCode, card.body).toBe(201);
    expect(card.json().card.pinnedModelVersion).toBe(`g175m-pin-${RUN}-20250101`);
    // the sign-off itself is ADR-0045's flow; here only its outcome matters
    await db.insert(modelCardApprovals).values({
      cardId: card.json().card.id,
      status: "approved",
      approverUserId: admin.id,
      decidedBy: admin.id,
      decidedAt: new Date(),
      validUntil: new Date(Date.now() + 30 * DAY),
    });
    // exactly the pin: nothing
    await ledger({ agentId: ids.pinned, requestedAgentId: ids.pinned, model: `g175m-pin-${RUN}`, servedModel: `g175m-pin-${RUN}-20250101` });
    await evaluate();
    expect(await activeFor("served_model_drift", `agent:${ids.pinned}`)).toEqual([]);

    // a different dated snapshot: the alias rule alone would pass it; the pin does not
    await ledger({ agentId: ids.pinned, requestedAgentId: ids.pinned, model: `g175m-pin-${RUN}`, servedModel: `g175m-pin-${RUN}-20250301` });
    await evaluate();
    const [alert] = await activeFor("served_model_drift", `agent:${ids.pinned}`);
    expect(alert).toMatchObject({ severity: "high" });
    expect(alert!.title).toBe(
      `g175m-pinned-${RUN} was served g175m-pin-${RUN}-20250301 instead of its model card's pinned g175m-pin-${RUN}-20250101 on 1 call`,
    );

    // the pin's change is audited with both values
    const patched = await call("PATCH", `/v1/mrm/cards/${card.json().card.id}`, admin.auth, { pinnedModelVersion: null });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().card.pinnedModelVersion).toBeNull();
    await db.delete(modelCards).where(eq(modelCards.id, card.json().card.id));
  });

  it("the agent's inventory detail shows the model the provider last reported serving", async () => {
    const r = await call("GET", `/v1/inventory/agents/${ids.swapped}`, admin.auth);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().observed.lastServedModel).toMatchObject({ servedModel: "g175m-other-model", configuredModel: `g175m-model-${RUN}` });
    const silent = await call("GET", `/v1/inventory/agents/${ids.silent}`, admin.auth);
    expect(silent.json().observed.lastServedModel).toBeNull();
  });

  it("resolves once the window holds no drifted call", async () => {
    await db
      .update(usageEvents)
      .set({ at: new Date(Date.now() - 8 * DAY) })
      .where(and(eq(usageEvents.agentId, ids.swapped), eq(usageEvents.servedModel, "g175m-other-model")));
    await evaluate();
    const all = await alertsFor("served_model_drift", `agent:${ids.swapped}`);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((a) => a.status === "resolved")).toBe(true);
  });
});

describe("ADR-0175 A9 — unregistered_ai_traffic", () => {
  it("project spend no approved use case covers raises an alert — and the dispatch was never blocked", async () => {
    const r = await call("POST", `/v1/agents/${ids.aliased}/invoke`, admin.auth, {
      mode: "execute",
      input: "draft the weekly summary",
      dispatch: true,
      costSensitivity: "quality-sensitive",
      projectId: ids.project,
    });
    expect(r.statusCode, r.body).toBe(200); // observe-only
    await ledger({ objectType: "mcp_tool", provider: null, operation: "search", projectId: ids.project, costUsd: 0.002 });
    await evaluate();

    const [alert, ...rest] = await activeFor("unregistered_ai_traffic", `project:${ids.project}`);
    expect(rest).toEqual([]);
    expect(alert).toMatchObject({ severity: "medium", status: "open" });
    expect(alert!.title).toBe(
      `Project g175m-project-${RUN}: 1 model call and 1 MCP tool call in 7 days, no approved use case links this project`,
    );
    expect(alert!.detail).toMatchObject({
      subjectType: "project",
      subjectId: ids.project,
      modelCalls: 1,
      mcpCalls: 1,
      callers: [{ id: admin.id, name: `Monitor admin ${RUN}`, calls: 2 }],
    });

    const plan = await call("GET", `/v1/governance/alerts/${alert!.id}/remediation`, admin.auth);
    const [c] = plan.json().candidates;
    expect(c).toMatchObject({ kind: "register_use_case", executable: false, params: { projectId: ids.project } });
    const href = new URL(c.href, "http://x");
    expect(href.pathname).toBe("/admin/governance/intake");
    expect(href.searchParams.get("title")).toBe(`AI use in project g175m-project-${RUN}`);

    const listed = await call("GET", "/v1/governance/alerts?status=active&limit=500", admin.auth);
    expect(listed.json().alerts.find((a: any) => a.id === alert!.id).subject).toMatchObject({
      type: "project",
      id: ids.project,
      label: `g175m-project-${RUN}`,
    });
  });

  it("a proposed use case linking the project does not cover it; approving one resolves the alert", async () => {
    const [uc] = await db
      .insert(aiUseCases)
      .values({
        name: `g175m use case ${RUN}`,
        description: "synthetic",
        businessContext: "A9 test",
        dataSensitivity: "internal",
        ownerUserId: admin.id,
        projectId: ids.project,
        status: "under_review",
      })
      .returning({ id: aiUseCases.id });
    ids.useCase = uc!.id;
    await evaluate();
    const [still] = await activeFor("unregistered_ai_traffic", `project:${ids.project}`);
    expect(still!.detail).toMatchObject({ linkedUseCasesNotApproved: [{ id: ids.useCase, status: "under_review" }] });

    await db.update(aiUseCases).set({ status: "approved" }).where(eq(aiUseCases.id, ids.useCase));
    await evaluate();
    expect(await activeFor("unregistered_ai_traffic", `project:${ids.project}`)).toEqual([]);
  });

  it("projectless traffic is grouped by virtual key, else by caller", async () => {
    await ledger({ agentId: ids.aliased, model: `g175m-alias-${RUN}`, servedModel: `g175m-alias-${RUN}`, virtualKeyId: ids.vk });
    await evaluate();
    const [vk] = await activeFor("unregistered_ai_traffic", `virtual_key:${ids.vk}`);
    expect(vk).toMatchObject({ severity: "medium" });
    expect(vk!.detail).toMatchObject({ subjectType: "virtual_key", modelCalls: 1, mcpCalls: 0 });

    // the caller's own projectless calls (from the dispatches above) are one caller subject
    const [caller] = await activeFor("unregistered_ai_traffic", `caller:${admin.id}`);
    expect(caller!.title).toContain(`Monitor admin ${RUN}:`);
    expect(caller!.title).toContain("attributed to no project and on no virtual key");
  });
});
