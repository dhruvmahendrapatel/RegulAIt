/**
 * ADR-0164 — approved use-case traffic served outside its approved stack.
 *
 * Pinned against the usage ledger (the measured record of every dispatch,
 * stamped with both the requested and the served agent): calls made to an
 * approved use case's agent but served by another agent raise ONE high alert
 * per (use case, serving agent), naming the requested agent and the count;
 * calls served by the requested agent, calls to an agent no approved use case
 * names, and calls older than the window raise nothing; the planner offers
 * guidance only; and the alert resolves once the window holds no off-stack
 * dispatch. Shared database: assertions are on records this file creates
 * (M-008).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agents, aiUseCases, and, createDb, eq, governanceAlerts, inArray, runMigrations, usageEvents, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `g164-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
let db: Db;
let app: ReturnType<typeof buildApp>;
const admin = { id: "", auth: { authorization: "" } };
const ids = { approved: "", cheap: "", loner: "", useCase: "" };
const usageIds: string[] = [];

const call = (method: "GET" | "POST", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const offStackAlerts = () =>
  db
    .select()
    .from(governanceAlerts)
    .where(and(eq(governanceAlerts.ruleId, "use_case_served_outside_stack"), eq(governanceAlerts.subjectKey, `use_case:${ids.useCase}>agent:${ids.cheap}`)));
const dispatch = async (requestedAgentId: string, servedAgentId: string, at = new Date()) => {
  const [row] = await db
    .insert(usageEvents)
    .values({ userId: admin.id, objectType: "agent", requestedAgentId, agentId: servedAgentId, provider: "mock", model: "m", at })
    .returning({ id: usageEvents.id });
  usageIds.push(row!.id);
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  const u = await call("POST", "/v1/users", AUTH, { email: `g164-${RUN}@example.com`, displayName: "Monitor admin", isAdmin: true });
  admin.id = u.json().id;
  admin.auth = { authorization: `Bearer ${(await call("POST", `/v1/users/${admin.id}/keys`, AUTH, { name: "k" })).json().token}` };

  const mk = async (name: string) =>
    (await db.insert(agents).values({ name: `g164-${name}-${RUN}`, provider: "mock", tier: 1, model: "m", ownerUserId: admin.id }).returning({ id: agents.id }))[0]!.id;
  ids.approved = await mk("approved");
  ids.cheap = await mk("cheap");
  ids.loner = await mk("loner");
  const [uc] = await db
    .insert(aiUseCases)
    .values({
      name: `g164 use case ${RUN}`, description: "synthetic", businessContext: "off-stack test", dataSensitivity: "internal",
      ownerUserId: admin.id, intendedAgentIds: [ids.approved], status: "approved",
    })
    .returning({ id: aiUseCases.id });
  ids.useCase = uc!.id;
}, 120_000);

afterAll(async () => {
  if (usageIds.length) await db.delete(usageEvents).where(inArray(usageEvents.id, usageIds));
  await db.update(aiUseCases).set({ status: "proposed" }).where(eq(aiUseCases.id, ids.useCase)); // out of the monitor's scope
  app.server.closeAllConnections();
  await app.close();
});

describe("ADR-0164 off-stack serving", () => {
  it("raises nothing for on-stack dispatches, unrelated agents, or calls outside the window", async () => {
    await dispatch(ids.approved, ids.approved); // served as requested
    await dispatch(ids.loner, ids.cheap); // no approved use case names the requested agent
    await dispatch(ids.approved, ids.cheap, new Date(Date.now() - 8 * 86_400_000)); // older than the 7-day window
    const r = await call("POST", "/v1/governance/monitor/evaluate", admin.auth);
    expect(r.statusCode, r.body).toBe(200);
    expect(await offStackAlerts()).toEqual([]);
  });

  it("raises one high alert per (use case, serving agent) with the measured count, and offers guidance only", async () => {
    await dispatch(ids.approved, ids.cheap);
    await dispatch(ids.approved, ids.cheap);
    expect((await call("POST", "/v1/governance/monitor/evaluate", admin.auth)).statusCode).toBe(200);
    const [alert, ...rest] = await offStackAlerts();
    expect(rest).toEqual([]);
    expect(alert).toMatchObject({ severity: "high", status: "open" });
    expect(alert!.title).toBe(
      `2 call(s) for g164 use case ${RUN} (to g164-approved-${RUN}) were served by g164-cheap-${RUN}, which is outside its approved stack`,
    );
    expect(alert!.detail).toMatchObject({ calls: 2, servedAgentId: ids.cheap, requested: [{ agentId: ids.approved, calls: 2 }], windowDays: 7 });

    const plan = await call("GET", `/v1/governance/alerts/${alert!.id}/remediation`, admin.auth);
    expect(plan.statusCode, plan.body).toBe(200);
    expect(plan.json().candidates.map((c: any) => [c.kind, c.executable])).toEqual([["contain_routing", false]]);

    // the deploy gate reads the same alert: the use case's pipeline is blocked
    const gate = await call("POST", "/v1/gates/deploy", admin.auth, { useCaseId: ids.useCase });
    expect(gate.json().decision).toBe("deny");
    expect(gate.json().reasons.some((x: any) => x.code === "open_high_alert" && x.ref.id === alert!.id)).toBe(true);
  });

  it("resolves once the window holds no off-stack dispatch", async () => {
    const off = await db
      .select({ id: usageEvents.id })
      .from(usageEvents)
      .where(and(inArray(usageEvents.id, usageIds), eq(usageEvents.requestedAgentId, ids.approved), eq(usageEvents.agentId, ids.cheap)));
    await db
      .update(usageEvents)
      .set({ at: new Date(Date.now() - 8 * 86_400_000) })
      .where(inArray(usageEvents.id, off.map((o) => o.id)));
    expect((await call("POST", "/v1/governance/monitor/evaluate", admin.auth)).statusCode).toBe(200);
    const [alert] = await offStackAlerts();
    expect(alert).toMatchObject({ status: "resolved" });
  });
});
