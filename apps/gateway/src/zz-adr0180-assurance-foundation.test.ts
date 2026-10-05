/**
 * ADR-0180 (ADR-0175 batch D3) — the continuous-assurance FOUNDATION (P0).
 *
 * Pinned on a real database, through the real app:
 *  - SECURE BY DEFAULT: a freshly migrated org reads `assurance_gate_mode =
 *    enforce` (the column default, and the singleton the migration upgraded).
 *  - THE SETTING: GET/PUT /v1/org/settings/assurance-gate-mode are admin-only;
 *    a change is audited with the value it replaced AND the value it set; a
 *    bad mode is a 400; the general org PUT does not take the key, so this
 *    route is the only way to relax the gate.
 *  - THE STUBS: every D3 route is registered with its deliberate auth class
 *    and answers 501 `not_implemented` until its owner lands.
 *  - THE MONITOR: the six assurance rules are in the catalogue; a breach an
 *    owner's loader reports becomes an alert under its rule; a failed loader
 *    leaves every rule it feeds unevaluated (episodes held, not resolved).
 *
 * Global state (M-068): the gate mode is restored to `enforce`, and the alert
 * episode this file raises is deleted, before the file ends.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiRisks,
  and,
  auditLog,
  riskAcceptances,
  createDb,
  desc,
  eq,
  governanceAlerts,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { ASSURANCE_MONITOR_RULE_IDS, MONITOR_RULES } from "@regulait/shared";
import { buildApp } from "./app.js";
import { runGovernanceMonitor } from "./governance-monitor.js";
import { routeAuthClass } from "./route-classes.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `a180-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const MODE_PATH = "/v1/org/settings/assurance-gate-mode";
let db: Db;
let app: ReturnType<typeof buildApp>;
const users = {} as Record<"admin" | "member", { id: string; auth: { authorization: string } }>;

const inject = (method: "GET" | "PUT" | "POST", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  for (const [k, isAdmin] of [["admin", true], ["member", false]] as const) {
    const u = await inject("POST", "/v1/users", AUTH, {
      email: `a180-${k}-${RUN}@example.com`,
      displayName: `a180 ${k} ${RUN}`,
      isAdmin,
    });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "a180" })).json().token as string;
    users[k] = { id, auth: { authorization: `Bearer ${token}` } };
  }
}, 120_000);

afterAll(async () => {
  // M-068: leave the org at its strict default whatever happened above
  await db.execute(sql`UPDATE org_settings SET assurance_gate_mode = 'enforce'`);
  app.server.closeAllConnections();
  await app.close();
});

describe("ADR-0180 secure by default: assurance_gate_mode", () => {
  it("a freshly migrated org reads enforce — the column default and the stored singleton", async () => {
    const res = await db.execute(sql`
      select column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'org_settings' and column_name = 'assurance_gate_mode'`);
    const rows = (res as unknown as { rows: Array<{ column_default: string | null }> }).rows;
    expect(rows[0]?.column_default ?? "").toContain("'enforce'");

    const r = await inject("GET", MODE_PATH, users.admin.auth);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ mode: "enforce", defaultMode: "enforce", strictDefault: true });
    // and the general settings read carries the same value
    const s = await inject("GET", "/v1/org/settings", users.admin.auth);
    expect(s.json().settings.assuranceGateMode).toBe("enforce");
  });

  it("is admin-only: a non-admin is refused 403 on GET and PUT, and the routes are classed admin", async () => {
    expect(routeAuthClass("GET", MODE_PATH)).toBe("admin");
    expect(routeAuthClass("PUT", MODE_PATH)).toBe("admin");
    expect((await inject("GET", MODE_PATH, users.member.auth)).statusCode).toBe(403);
    const put = await inject("PUT", MODE_PATH, users.member.auth, { mode: "off" });
    expect(put.statusCode).toBe(403);
    expect((await inject("GET", MODE_PATH, users.admin.auth)).json().mode).toBe("enforce");
  });

  it("an admin relaxes it, audited with the old and the new value, and sets it back", async () => {
    try {
      const put = await inject("PUT", MODE_PATH, users.admin.auth, { mode: "warn" });
      expect(put.statusCode, put.body).toBe(200);
      expect(put.json()).toMatchObject({ mode: "warn", strictDefault: false });
      expect((await inject("GET", MODE_PATH, users.admin.auth)).json().mode).toBe("warn");

      const [row] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.ruleId, "assurance-gate-mode-set"), eq(auditLog.userId, users.admin.id)))
        .orderBy(desc(auditLog.at))
        .limit(1);
      expect(row, "the change is audited").toBeDefined();
      expect(row!.objectType).toBe("org_settings");
      expect(row!.detail).toMatchObject({ setting: "assuranceGateMode", from: "enforce", to: "warn", changed: true });
      expect(row!.reason).toContain("from enforce to warn");
      expect(row!.reason).toContain("RELAXED");
    } finally {
      const back = await inject("PUT", MODE_PATH, users.admin.auth, { mode: "enforce" });
      expect(back.statusCode, back.body).toBe(200);
    }
    const [restored] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "assurance-gate-mode-set"), eq(auditLog.userId, users.admin.id)))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(restored!.detail).toMatchObject({ from: "warn", to: "enforce" });
  });

  it("refuses an unknown mode (400), and the general org PUT does not take the key", async () => {
    expect((await inject("PUT", MODE_PATH, users.admin.auth, { mode: "lenient" })).statusCode).toBe(400);
    expect((await inject("PUT", MODE_PATH, users.admin.auth, {})).statusCode).toBe(400);
    const general = await inject("PUT", "/v1/org/settings", users.admin.auth, { assuranceGateMode: "off" });
    expect(general.statusCode).toBe(400);
    expect((await inject("GET", MODE_PATH, users.admin.auth)).json().mode).toBe("enforce");
  });
});

describe("ADR-0180 migration 0155: the strict rules the database holds", () => {
  const riskIds: string[] = [];
  afterAll(async () => {
    for (const id of riskIds) await db.delete(aiRisks).where(eq(aiRisks.id, id));
  });
  async function mkRisk(): Promise<string> {
    const [r] = await db
      .insert(aiRisks)
      .values({
        title: `a180 risk ${RUN}`,
        description: "synthetic ADR-0180 fixture",
        category: "tool_misuse",
        ownerUserId: users.admin.id,
        likelihood: "high",
        impact: "high",
      })
      .returning({ id: aiRisks.id });
    riskIds.push(r!.id);
    return r!.id;
  }
  const days = (n: number) => new Date(Date.now() + n * 86_400_000);
  const accept = (riskId: string, band: "medium" | "high", expiresAt: Date) =>
    db.insert(riskAcceptances).values({
      riskId,
      responseType: "accept",
      residualBand: band,
      acceptedByUserId: users.admin.id,
      acceptedAt: new Date(),
      expiresAt,
      rationale: "synthetic rationale",
    });

  it("caps an acceptance's expiry: high/critical at ~6 months, others at ~12", async () => {
    await expect(accept(await mkRisk(), "high", days(200))).rejects.toThrow();
    await expect(accept(await mkRisk(), "medium", days(400))).rejects.toThrow();
    await expect(accept(await mkRisk(), "high", days(-1))).rejects.toThrow();
    await accept(await mkRisk(), "high", days(150));
    await accept(await mkRisk(), "medium", days(300));
  });

  it("allows one LIVE acceptance per risk; a superseded one is history", async () => {
    const id = await mkRisk();
    await accept(id, "medium", days(30));
    await expect(accept(id, "medium", days(60))).rejects.toThrow();
    await db.update(riskAcceptances).set({ supersededAt: new Date() }).where(eq(riskAcceptances.riskId, id));
    await accept(id, "medium", days(60));
    expect(await db.select().from(riskAcceptances).where(eq(riskAcceptances.riskId, id))).toHaveLength(2);
  });

  it("scrubs a credential typed into an acceptance rationale", async () => {
    const id = await mkRisk();
    await db.insert(riskAcceptances).values({
      riskId: id,
      responseType: "transfer",
      residualBand: "medium",
      expiresAt: days(30),
      rationale: "insurer portal key AKIAIOSFODNN7EXAMPLE covers it",
    });
    const [row] = await db.select().from(riskAcceptances).where(eq(riskAcceptances.riskId, id));
    expect(row!.rationale).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("indexes the guardrail hit rows for the guardrail_hits metric", async () => {
    const res = await db.execute(sql`select indexdef from pg_indexes where indexname = 'audit_log_guardrail_hits_idx'`);
    const def = ((res as unknown as { rows: Array<{ indexdef: string }> }).rows[0]?.indexdef ?? "").replace(/\s+/g, " ");
    expect(def).toContain("(rule_id, at)");
    for (const id of ["guardrail-blocked", "guardrail-warned", "guardrail-logged"]) expect(def).toContain(`'${id}'`);
  });
});

describe("ADR-0180 D3 routes: every stub has landed", () => {
  // P0 shipped these as 501 stubs; each owner's own test pins its behaviour.
  // This only proves no stub is left behind (A2 zz-adr0180-a2-conditions,
  // A3 zz-adr0180-a3-required-tests, A8 autonomy.test, A10 zz-adr0180-a10-risk-tolerance).
  const ROUTES: Array<{ method: "GET" | "PUT" | "POST"; url: string }> = [
    { method: "POST", url: "/v1/use-cases/00000000-0000-4000-8000-000000000001/conditions/00000000-0000-4000-8000-000000000002/evaluate" },
    { method: "POST", url: "/v1/use-cases/00000000-0000-4000-8000-000000000001/conditions/00000000-0000-4000-8000-000000000002/waive" },
    { method: "GET", url: "/v1/governance/review-policy/required-tests" },
    { method: "PUT", url: "/v1/governance/review-policy/required-tests" },
    { method: "GET", url: "/v1/builder/agents/00000000-0000-4000-8000-000000000003/autonomy" },
    { method: "PUT", url: "/v1/builder/agents/00000000-0000-4000-8000-000000000003/autonomy" },
    { method: "GET", url: "/v1/risk-tolerances" },
    { method: "PUT", url: "/v1/risk-tolerances" },
    { method: "GET", url: "/v1/risks/00000000-0000-4000-8000-000000000004/acceptances" },
    { method: "POST", url: "/v1/risks/00000000-0000-4000-8000-000000000004/acceptances" },
  ];

  it.each(ROUTES)("$method $url no longer answers 501", async (s) => {
    const r = await inject(s.method, s.url, users.admin.auth, s.method === "GET" ? undefined : {});
    expect(r.statusCode, r.body).not.toBe(501);
  });
});

describe("ADR-0180 monitor: the six assurance rules", () => {
  it("are in the rule catalogue", () => {
    expect([...ASSURANCE_MONITOR_RULE_IDS].sort()).toEqual([
      "autonomy_declared_below_observed",
      "autonomy_floor_unmet",
      "condition_metric_breached",
      "required_test_stale",
      "residual_above_tolerance",
      "risk_acceptance_expired",
    ]);
    for (const id of ASSURANCE_MONITOR_RULE_IDS) expect(MONITOR_RULES[id].label.length).toBeGreaterThan(0);
  });

  it("raise an owner-reported breach as an alert; a failed loader leaves its rules unevaluated", async () => {
    const subjectKey = `use_case:a180-${RUN}>condition:c1`;
    const open = () =>
      db
        .select({ id: governanceAlerts.id, status: governanceAlerts.status, severity: governanceAlerts.severity })
        .from(governanceAlerts)
        .where(and(eq(governanceAlerts.ruleId, "condition_metric_breached"), eq(governanceAlerts.subjectKey, subjectKey)));
    try {
      // the default (P0 no-op) loaders report nothing, and every assurance rule was evaluated
      const quiet = await runGovernanceMonitor(db, { actorUserId: users.admin.id });
      for (const id of ASSURANCE_MONITOR_RULE_IDS) expect(quiet.notEvaluated).not.toContain(id);
      expect(await open()).toEqual([]);

      const raised = await runGovernanceMonitor(db, {
        actorUserId: users.admin.id,
        optionalInputs: {
          conditionMetrics: async () => ({
            condition_metric_breached: {
              breaches: [{ subjectKey, title: `a180 ${RUN}: error rate 12% over 7 days, above 5%`, detail: { runId: RUN } }],
            },
          }),
          autonomy: async () => {
            throw new Error("injected autonomy failure");
          },
        },
      });
      expect(raised.notEvaluated).toEqual(expect.arrayContaining(["autonomy_declared_below_observed", "autonomy_floor_unmet"]));
      const rows = await open();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "open", severity: MONITOR_RULES.condition_metric_breached.severity });

      // a subject the owner HOLDS (too few samples) is neither refreshed nor resolved
      const held = await runGovernanceMonitor(db, {
        actorUserId: users.admin.id,
        optionalInputs: {
          conditionMetrics: async () => ({ condition_metric_breached: { breaches: [], heldSubjectKeys: [subjectKey] } }),
        },
      });
      expect(held.notEvaluated).not.toContain("condition_metric_breached");
      expect((await open())[0]?.status).toBe("open");

      // the owner reports no breach: the episode resolves
      await runGovernanceMonitor(db, { actorUserId: users.admin.id });
      expect((await open())[0]?.status).toBe("resolved");
    } finally {
      await db
        .delete(governanceAlerts)
        .where(and(eq(governanceAlerts.ruleId, "condition_metric_breached"), eq(governanceAlerts.subjectKey, subjectKey)));
    }
  }, 120_000);
});
