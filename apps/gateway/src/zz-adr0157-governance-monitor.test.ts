/**
 * ADR-0157 — the governance monitor and its alerts.
 *
 * Pinned: an approved use case's conditions raise alerts keyed by (rule,
 * subject); a persisting condition refreshes the SAME row and keeps an
 * acknowledgement; a cleared condition resolves it; a recurrence opens a NEW
 * episode; concurrent passes never duplicate an active alert; acknowledging
 * needs an identity and a note and cannot touch a resolved alert; the job is
 * registered with the scheduler; admin-only. Assertions are scoped to subject
 * keys this file creates (M-008) — the database is shared.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agents, aiRisks, aiUseCases, and, createDb, eq, governanceAlerts, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { SCHEDULER_JOB_NAMES, schedulerJobRegistry } from "./scheduler-jobs.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `g157-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
const admin = { id: "", auth: { authorization: "" } };
let agentId = "";
let useCaseId = "";
let riskId = "";

const call = (method: "GET" | "POST", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

type Alert = { id: string; ruleId: string; status: string; severity: string; title: string; subject: any; detail: any; ackNote: string | null };
const list = async (status = "all") =>
  (await call("GET", `/v1/governance/alerts?status=${status}&limit=500`, admin.auth)).json() as {
    alerts: Alert[];
    counts: Record<string, number>;
    lastEvaluatedAt: string | null;
    rules: Array<{ id: string }>;
  };
const evaluate = async () => {
  const r = await call("POST", "/v1/governance/monitor/evaluate", admin.auth);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
const mine = (alerts: Alert[], ruleId: string) =>
  alerts.filter((a) => a.ruleId === ruleId && a.subject.key.includes(ruleId === "high_risk_without_control" ? riskId : useCaseId));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  const u = await call("POST", "/v1/users", AUTH, { email: `g157-${RUN}@example.com`, displayName: "Monitor admin", isAdmin: true });
  admin.id = u.json().id;
  admin.auth = { authorization: `Bearer ${(await call("POST", `/v1/users/${admin.id}/keys`, AUTH, { name: "k" })).json().token}` };
  // the pack controls a risk can be linked to (idempotent across files)
  expect([200, 201]).toContain((await call("POST", "/v1/compliance/packs/seed", AUTH, {})).statusCode);

  const [a] = await db
    .insert(agents)
    .values({ name: `g157-agent-${RUN}`, provider: "mock", tier: 1, model: `g157-model-${RUN}`, ownerUserId: admin.id })
    .returning({ id: agents.id });
  agentId = a!.id;
  const [uc] = await db
    .insert(aiUseCases)
    .values({
      name: `g157-use-case-${RUN}`,
      description: "synthetic",
      businessContext: "monitor test",
      dataSensitivity: "confidential",
      ownerUserId: admin.id,
      intendedAgentIds: [agentId],
      status: "approved",
    })
    .returning({ id: aiUseCases.id });
  useCaseId = uc!.id;
  const [r] = await db
    .insert(aiRisks)
    .values({
      title: `g157 risk ${RUN}`,
      description: "synthetic",
      category: "prompt_injection",
      ownerUserId: admin.id,
      useCaseId,
      likelihood: "high",
      impact: "high",
    })
    .returning({ id: aiRisks.id });
  riskId = r!.id;
}, 120_000);

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
});

describe("ADR-0157 governance monitor", () => {
  it("raises alerts for an approved use case's conditions, with the evidence attached", async () => {
    const out = await evaluate();
    expect(out.raised).toBeGreaterThanOrEqual(3);
    const { alerts, rules, lastEvaluatedAt } = await list("active");
    expect(lastEvaluatedAt).not.toBeNull();
    expect(rules.map((r) => r.id)).toContain("use_case_inherited_high_risk");

    const own = mine(alerts, "use_case_inherited_high_risk");
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ status: "open", severity: "high", title: `g157-use-case-${RUN} carries a HIGH-rated risk of its own` });
    expect(own[0]!.detail.sourceRiskId).toBe(riskId);
    expect(own[0]!.subject).toMatchObject({ type: "use_case", id: useCaseId, label: `g157-use-case-${RUN}` });

    const bare = mine(alerts, "high_risk_without_control");
    expect(bare).toHaveLength(1);
    expect(bare[0]!.subject).toMatchObject({ type: "risk", id: riskId, label: `g157 risk ${RUN}` });

    // no approved model card: keyed by (use case, agent), the agent is the subject
    const card = mine(alerts, "use_case_agent_no_approved_model_card");
    expect(card).toHaveLength(1);
    expect(card[0]!.subject).toMatchObject({ type: "agent", id: agentId, context: { id: useCaseId } });

    // owned and active: these rules stay quiet (negative controls)
    expect(mine(alerts, "use_case_agent_unowned")).toHaveLength(0);
    expect(mine(alerts, "use_case_agent_halted")).toHaveLength(0);
  });

  it("acknowledging needs an identity and a note; it survives a persisting condition", async () => {
    const [target] = mine((await list("active")).alerts, "high_risk_without_control");
    const url = `/v1/governance/alerts/${target!.id}/acknowledge`;
    expect((await call("POST", url, AUTH, { note: "x" })).statusCode).toBe(403); // bootstrap: no identity
    expect((await call("POST", url, admin.auth, { note: "  " })).statusCode).toBe(400);
    expect((await call("POST", `/v1/governance/alerts/00000000-0000-4000-8000-000000000000/acknowledge`, admin.auth, { note: "x" })).statusCode).toBe(404);
    const ok = await call("POST", url, admin.auth, { note: "owner linking a control today" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: "acknowledged", ackNote: "owner linking a control today" });

    await evaluate();
    const after = mine((await list("all")).alerts, "high_risk_without_control");
    expect(after).toHaveLength(1); // the SAME row, refreshed — not a second one
    expect(after[0]).toMatchObject({ id: target!.id, status: "acknowledged", ackNote: "owner linking a control today" });
  });

  it("resolves when the condition clears, refuses acknowledging it, and a recurrence is a new episode", async () => {
    const link = await call("POST", `/v1/risks/${riskId}/controls`, admin.auth, { controlRef: "eu-ai-act:art-15-accuracy-robustness" });
    expect(link.statusCode, link.body).toBe(201);
    const out = await evaluate();
    expect(out.resolved).toBeGreaterThanOrEqual(1);
    const [resolved] = mine((await list("resolved")).alerts, "high_risk_without_control");
    expect(resolved).toMatchObject({ status: "resolved" });
    expect((await call("POST", `/v1/governance/alerts/${resolved!.id}/acknowledge`, admin.auth, { note: "late" })).json()).toEqual({
      error: "already_resolved",
    });

    // halt the agent: a new rule fires; unhalt: it resolves; halt again: NEW row
    const halt = (on: boolean) =>
      db
        .update(agents)
        .set(on ? { haltedAt: new Date(), haltedReason: "incident drill", haltedByUserId: admin.id } : { haltedAt: null, haltedReason: null, haltedByUserId: null })
        .where(eq(agents.id, agentId));
    await halt(true);
    await evaluate();
    const first = mine((await list("active")).alerts, "use_case_agent_halted");
    expect(first).toHaveLength(1);
    expect(first[0]!.title).toContain("halted");
    await halt(false);
    await evaluate();
    await halt(true);
    await evaluate();
    const episodes = await db
      .select()
      .from(governanceAlerts)
      .where(and(eq(governanceAlerts.ruleId, "use_case_agent_halted"), eq(governanceAlerts.subjectKey, `use_case:${useCaseId}>agent:${agentId}`)));
    expect(episodes.map((e) => e.status).sort()).toEqual(["open", "resolved"]);
    await halt(false);
  });

  it("concurrent passes never duplicate an active alert", async () => {
    await Promise.all([evaluate(), evaluate(), evaluate()]);
    const active = await db
      .select({ ruleId: governanceAlerts.ruleId, subjectKey: governanceAlerts.subjectKey })
      .from(governanceAlerts)
      .where(eq(governanceAlerts.status, "open"));
    const keys = active.map((a) => `${a.ruleId}|${a.subjectKey}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is admin-only, and the sweep is a registered scheduler job", async () => {
    const u = await call("POST", "/v1/users", AUTH, { email: `g157-member-${RUN}@example.com`, displayName: "Member" });
    const key = (await call("POST", `/v1/users/${u.json().id}/keys`, AUTH, { name: "k" })).json().token as string;
    const member = { authorization: `Bearer ${key}` };
    expect((await call("GET", "/v1/governance/alerts", member)).statusCode).toBe(403);
    expect((await call("POST", "/v1/governance/monitor/evaluate", member)).statusCode).toBe(403);

    // the scheduler writes its `scheduler_jobs` row when it starts (off in
    // tests); the registry is what it starts from
    expect(schedulerJobRegistry().has(SCHEDULER_JOB_NAMES.governanceMonitor)).toBe(true);
  });
});
