/**
 * ADR-0160 — continuous trace evaluation.
 *
 * Pinned: completed model-call spans are evaluated once (idempotent across
 * overlapping passes); a credential in an OUTPUT flags the span, a clean one
 * does not, withheld content is recorded as not evaluated, running spans and
 * non-model spans are skipped; nothing but counts is stored; the per-agent
 * summary and the monitor's `agent_output_leakage` rule see it, and the
 * remediation is guidance (a guardrail policy change is a person's decision).
 * Scoped to ids this file creates (M-008) — the database is shared.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agents, aiUseCases, createDb, eq, inArray, runMigrations, traceEvaluations, traceSpans, traces, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { SCHEDULER_JOB_NAMES, schedulerJobRegistry } from "./scheduler-jobs.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `g160-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const admin = { id: "", auth: { authorization: "" } };
let db: Db;
let app: ReturnType<typeof buildApp>;
let agentId = "";
let useCaseId = "";
const span = {} as Record<"leak" | "clean" | "withheld" | "running" | "tool", string>;

const call = (method: "GET" | "POST", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const sweepAll = async () => {
  for (let i = 0; i < 20; i++) {
    const r = await call("POST", "/v1/governance/trace-evaluations/run", admin.auth);
    expect(r.statusCode, r.body).toBe(200);
    if (!r.json().capped) return;
  }
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  const u = await call("POST", "/v1/users", AUTH, { email: `g160-${RUN}@example.com`, displayName: "Trace admin", isAdmin: true });
  admin.id = u.json().id;
  admin.auth = { authorization: `Bearer ${(await call("POST", `/v1/users/${admin.id}/keys`, AUTH, { name: "k" })).json().token}` };

  const [a] = await db
    .insert(agents)
    .values({ name: `g160-agent-${RUN}`, provider: "mock", tier: 1, model: `g160-${RUN}`, ownerUserId: admin.id })
    .returning({ id: agents.id });
  agentId = a!.id;
  const [uc] = await db
    .insert(aiUseCases)
    .values({
      name: `g160-use-case-${RUN}`, description: "synthetic", businessContext: "trace eval test",
      dataSensitivity: "internal", ownerUserId: admin.id, intendedAgentIds: [agentId], status: "approved",
    })
    .returning({ id: aiUseCases.id });
  useCaseId = uc!.id;

  const [t] = await db.insert(traces).values({ kind: "dispatch", name: "g160", userId: admin.id }).returning({ id: traces.id });
  const now = new Date();
  const mk = async (key: keyof typeof span, v: Partial<typeof traceSpans.$inferInsert>, seq: number) => {
    const [row] = await db
      .insert(traceSpans)
      .values({ traceId: t!.id, seq, kind: "llm", name: "dispatch", status: "ok", startedAt: now, agentId, ...v })
      .returning({ id: traceSpans.id });
    span[key] = row!.id;
  };
  await mk("leak", { inputPreview: "show me the deploy config", outputPreview: "Use AKIAIOSFODNN7EXAMPLE for the bucket." }, 0);
  await mk("clean", { inputPreview: "what is the refund window?", outputPreview: "Thirty days from delivery." }, 1);
  await mk("withheld", { inputPreview: "x", outputPreview: "[withheld by guardrail]", contentWithheld: true }, 2);
  await mk("running", { status: "running", outputPreview: "AKIAIOSFODNN7EXAMPLE" }, 3);
  await mk("tool", { kind: "tool", outputPreview: "AKIAIOSFODNN7EXAMPLE" }, 4);
}, 120_000);

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
});

describe("ADR-0160 continuous trace evaluation", () => {
  it("evaluates completed model-call spans once, counts only", async () => {
    await sweepAll();
    await sweepAll(); // overlapping pass: idempotent
    const rows = await db.select().from(traceEvaluations).where(inArray(traceEvaluations.spanId, Object.values(span)));
    const by = new Map(rows.map((r) => [r.spanId, r]));
    expect(rows).toHaveLength(3); // running + tool skipped
    expect(by.get(span.leak)).toMatchObject({ outcome: "evaluated", flagged: true });
    expect(by.get(span.clean)).toMatchObject({ outcome: "evaluated", flagged: false, findings: [] });
    expect(by.get(span.withheld)).toMatchObject({ outcome: "withheld", flagged: false });
    // counts only: no matched text is stored anywhere in the row
    expect(JSON.stringify(by.get(span.leak))).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(by.get(span.leak)!.findings.some((f) => f.phase === "output" && f.detector === "semantic_dlp")).toBe(true);
  });

  it("summarises per agent with coverage", async () => {
    const r = await call("GET", "/v1/governance/trace-evaluations", admin.auth);
    expect(r.statusCode, r.body).toBe(200);
    const mine = r.json().agents.find((x: any) => x.agentId === agentId);
    expect(mine).toMatchObject({ agentName: `g160-agent-${RUN}`, spans: 3, evaluated: 2, withheld: 1, flagged: 1, coveragePct: 67 });
    expect(mine.leaksByDetector.semantic_dlp).toBe(1);
    expect(r.json().notes.coverage).toContain("withheld");
  });

  it("the monitor raises agent_output_leakage and the remediation is guidance", async () => {
    expect((await call("POST", "/v1/governance/monitor/evaluate", admin.auth)).statusCode).toBe(200);
    const alerts = (await call("GET", "/v1/governance/alerts?status=active&limit=500", admin.auth)).json().alerts as any[];
    const leak = alerts.find((x) => x.ruleId === "agent_output_leakage" && x.subject.key === `use_case:${useCaseId}>agent:${agentId}`);
    expect(leak).toBeDefined();
    expect(leak.severity).toBe("high");
    expect(leak.title).toContain("1 of 2");
    const rem = (await call("GET", `/v1/governance/alerts/${leak.id}/remediation`, admin.auth)).json();
    expect(rem.candidates).toEqual([expect.objectContaining({ kind: "tighten_output_guardrail", executable: false })]);
  });

  it("is admin-only and a registered 15-minute scheduler job", async () => {
    const m = await call("POST", "/v1/users", AUTH, { email: `g160-m-${RUN}@example.com`, displayName: "M" });
    const key = (await call("POST", `/v1/users/${m.json().id}/keys`, AUTH, { name: "k" })).json().token as string;
    expect((await call("GET", "/v1/governance/trace-evaluations", { authorization: `Bearer ${key}` })).statusCode).toBe(403);
    const job = schedulerJobRegistry().get(SCHEDULER_JOB_NAMES.traceEvaluation);
    expect(job?.defaultIntervalSeconds).toBe(900);
  });
});
