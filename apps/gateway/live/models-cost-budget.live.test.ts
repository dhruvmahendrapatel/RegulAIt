/**
 * ADR-0326, pilot criterion 2 — real provider calls through the gateway's coding-tool surfaces, with cost
 * attribution per user and per project and a budget alert firing.
 *
 * One in-process gateway on the job's disposable Postgres. For each provider with a key: an agent at the provider's
 * real model, a project with a tiny budget, one call through the surface a coding tool uses (Anthropic `/v1/messages`
 * for Claude Code, OpenAI `/v1/chat/completions` for Cursor/Codex-style clients), then:
 *   - a `usage_events` row for that user AND that project with a positive cost (visible at once: the ledger is
 *     written synchronously, so "within minutes" is measured here as the call's own latency);
 *   - the per-user, per-project spend readable through the summary API;
 *   - a budget signal: the threshold alert (`budget-threshold-alert` audit row) or, when the one call already
 *     exceeds the cap, the escalation into the Approvals Queue — and the NEXT call refused.
 * Bedrock and Vertex have no native route (PILOT_READINESS G2-1, G2-2), so their groups are `todo` until one lands.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, approvals, auditLog, createDb, eq, interceptionSettings, runMigrations, usageEvents, type Db } from "@regulait/db";
import { buildApp } from "../src/app.js";
import { PROJECT_HEADER } from "../src/compat-core.js";
import { relaxGovernanceGatesForTest } from "../src/testing/governance-gates.js";
import { liveEnabled, liveTitle, redact, type LiveGroup } from "./live-env.js";

const PROVIDERS: Array<{
  group: LiveGroup;
  provider: "anthropic" | "openai" | "google";
  model: string;
  surface: "/v1/messages" | "/v1/chat/completions";
  priceIn: number;
  priceOut: number;
}> = [
  { group: "anthropic", provider: "anthropic", model: process.env.REGULAIT_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-4-5", surface: "/v1/messages", priceIn: 1, priceOut: 5 },
  { group: "openai", provider: "openai", model: process.env.REGULAIT_LIVE_OPENAI_MODEL ?? "gpt-4o-mini", surface: "/v1/chat/completions", priceIn: 0.15, priceOut: 0.6 },
  { group: "gemini", provider: "google", model: process.env.REGULAIT_LIVE_GEMINI_MODEL ?? "gemini-2.5-flash", surface: "/v1/chat/completions", priceIn: 0.3, priceOut: 2.5 },
];
const anyProvider = PROVIDERS.some((p) => liveEnabled(p.group));

const BOOT = "live-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreGates: () => Promise<void> = async () => {};
let devId = "";
let devAuth = { authorization: "" };
let approverId = "";

async function mkUser(email: string) {
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: email.split("@")[0] } });
  expect(u.statusCode, redact(u.body)).toBe(201);
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "live" } });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

describe.skipIf(!anyProvider)("[live] model routing, cost attribution and budget alerts", () => {
  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL must be set");
    db = createDb(url);
    await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
    app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });
    restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
    const r = await app.inject({ method: "PUT", headers: AUTH, url: "/v1/interception/settings", payload: { anthropicCompatEnabled: true, openaiCompatEnabled: true, requireProjectAttribution: true } });
    expect(r.statusCode, redact(r.body)).toBe(200);
    const dev = await mkUser(`live-dev-${Date.now()}@example.com`);
    devId = dev.id;
    devAuth = dev.auth;
    approverId = (await mkUser(`live-approver-${Date.now()}@example.com`)).id;
  });

  afterAll(async () => {
    if (!db) return;
    await db.update(interceptionSettings).set({ anthropicCompatEnabled: false, openaiCompatEnabled: false });
    await restoreGates();
    await app?.close();
  });

  for (const p of PROVIDERS) {
    describe.skipIf(!liveEnabled(p.group))(liveTitle(p.group, `${p.provider} via ${p.surface}`), () => {
      it("is attributed to the user and project, priced, and trips the project budget", async () => {
        const tag = `live-${p.group}-${Date.now()}`;
        const a = await app.inject({ method: "POST", headers: AUTH, url: "/v1/agents", payload: { name: tag, provider: p.provider, tier: 1, model: p.model, costPerMTokIn: p.priceIn, costPerMTokOut: p.priceOut } });
        expect(a.statusCode, redact(a.body)).toBe(201);
        const agentId = a.json().id as string;
        expect((await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: devId, agentId } })).statusCode).toBe(201);
        // a budget so small that one short call crosses its 1% alert threshold
        const pr = await app.inject({ method: "POST", headers: AUTH, url: "/v1/projects", payload: { name: tag, budgetUsd: 0.000001, alertThresholdPct: 1, budgetApproverUserId: approverId } });
        expect(pr.statusCode, redact(pr.body)).toBe(201);
        const projectId = pr.json().id as string;
        expect((await app.inject({ method: "POST", headers: AUTH, url: `/v1/projects/${projectId}/members`, payload: { userId: devId, role: "contributor" } })).statusCode).toBe(201);

        // the same minimal body is valid on both wire formats
        const body = { model: p.model, max_tokens: 16, messages: [{ role: "user", content: "Reply with the single word: ok" }] };
        const started = Date.now();
        const call = await app.inject({ method: "POST", url: p.surface, headers: { ...devAuth, [PROJECT_HEADER]: projectId }, payload: body });
        expect(call.statusCode, redact(call.body)).toBe(200);
        const latencyMs = Date.now() - started;

        const rows = await db.select().from(usageEvents).where(and(eq(usageEvents.userId, devId), eq(usageEvents.projectId, projectId)));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.costUsd ?? 0).toBeGreaterThan(0);
        expect(latencyMs).toBeLessThan(120_000);

        // the developer's own per-user summary shows the spend broken down by this project
        const summary = await app.inject({ method: "GET", headers: devAuth, url: "/v1/usage-events/summary" });
        expect(summary.statusCode, redact(summary.body)).toBe(200);
        expect(summary.body).toContain(projectId);

        const alerts = await db.select().from(auditLog).where(and(eq(auditLog.objectId, projectId), eq(auditLog.ruleId, "budget-threshold-alert")));
        const escalations = await db.select().from(approvals).where(eq(approvals.projectId, projectId));
        expect(alerts.length + escalations.length, "a budget signal fired").toBeGreaterThan(0);

        if (escalations.length > 0) {
          const next = await app.inject({ method: "POST", url: p.surface, headers: { ...devAuth, [PROJECT_HEADER]: projectId }, payload: body });
          expect(next.statusCode, "the call after an exceeded budget is refused").not.toBe(200);
        }
      });
    });
  }

  it.todo("[live:bedrock] Bedrock inference with SigV4 / an IAM role (gap G2-1, no native provider yet)");
  it.todo("[live:vertex] Vertex AI inference with a service account (gap G2-2, no native provider yet)");
});
