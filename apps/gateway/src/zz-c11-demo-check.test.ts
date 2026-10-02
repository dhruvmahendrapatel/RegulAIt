/**
 * Demo task C11 — `demo:check` over the REAL demo dataset.
 *
 * Seeds `DEMO_INTAKE_FIXTURES` through the C6 seeder and walks every
 * storyline beat. Pinned: every beat is reported, and none FAILs — so a
 * change anywhere in the stack that breaks a demo moment breaks CI, not the
 * Monday morning. WARN is allowed (it tracks content still in progress).
 *
 * Shadow-AI rows are patched to a catalogued provider host until G5 lands, so
 * the Discover beat is checked against matching evidence rather than skipped.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { DEMO_INTAKE_FIXTURES } from "@regulait/shared";
import { buildApp } from "./app.js";
import { runDemoCheck, type DemoCheck } from "./demo-check-lib.js";
import { seedDemoIntake } from "./demo-intake-seed-lib.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = `c11-boot-${Math.random().toString(36).slice(2, 8)}`;
let db: Db;
let app: ReturnType<typeof buildApp>;
let checks: DemoCheck[] = [];

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  // the approver persona the base seed creates
  await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: { authorization: `Bearer ${BOOT}` },
    payload: { email: "avery@regulait.local", displayName: "Avery Approver" },
  });
  const fixtures = {
    ...DEMO_INTAKE_FIXTURES,
    shadowAi: DEMO_INTAKE_FIXTURES.shadowAi.some((s) => s.vendorHost.endsWith("openai.com") || s.vendorHost === "claude.ai")
      ? DEMO_INTAKE_FIXTURES.shadowAi
      : [...DEMO_INTAKE_FIXTURES.shadowAi, { appName: "Credit desk prototype", vendorHost: "api.openai.com", grantedBy: "user-9@acme.example", installCount: 1 }],
  };
  const report = await seedDemoIntake(app, fixtures, { bootstrapToken: BOOT });
  expect(report.failed, report.failed.join("\n")).toEqual([]);
  checks = await runDemoCheck(app, { bootstrapToken: BOOT, fixtures });
}, 180_000);

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
});

describe("demo:check over the real dataset", () => {
  it("reports every storyline beat", () => {
    const beats = new Set(checks.map((c) => c.beat));
    for (const b of [
      "0 Personas", "1 Shadow AI", "1 Intake assistant", "2 Register", "2 Use-case 360", "2 Risks",
      "3 Trust dashboard", "3 Dependency graph", "3 Monitor", "3 Regulatory", "2 Approval gate", "2 Deploy gate",
    ]) {
      expect(beats.has(b), `missing beat ${b}`).toBe(true);
    }
  });

  it("no beat FAILs", () => {
    const failing = checks.filter((c) => c.level === "FAIL").map((c) => `${c.beat}: ${c.detail}`);
    expect(failing).toEqual([]);
  });

  it("the hero's intake answers land on HIGH", () => {
    expect(checks.find((c) => c.beat === "1 Intake assistant")!.level).toBe("PASS");
  });
});

describe("G2/X8 scenario library over the API", () => {
  it("serves the scenarios without likelihood or impact (the registrant declares those)", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/risks/scenarios", headers: { authorization: `Bearer ${BOOT}` } });
    expect(r.statusCode, r.body).toBe(200);
    const scenarios = r.json().scenarios as Array<Record<string, unknown>>;
    expect(scenarios.length).toBeGreaterThanOrEqual(33);
    for (const s of scenarios) {
      expect(s).not.toHaveProperty("likelihood");
      expect(s).not.toHaveProperty("impact");
    }
  });
});
