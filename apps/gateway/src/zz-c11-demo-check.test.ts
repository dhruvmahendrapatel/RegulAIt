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
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, createDb, isNull, runMigrations, sql, workflowTemplates, type Db } from "@regulait/db";

const like = (col: unknown, pattern: string) => sql`${col} like ${pattern}`;
import { DEMO_INTAKE_FIXTURES } from "@regulait/shared";
import { buildApp } from "./app.js";
import { runDemoCheck, type DemoCheck } from "./demo-check-lib.js";
import { seedDemoIntake } from "./demo-intake-seed-lib.js";
import { runDemoGate } from "./demo-gate-lib.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = `c11-boot-${Math.random().toString(36).slice(2, 8)}`;
let db: Db;
let app: ReturnType<typeof buildApp>;
let checks: DemoCheck[] = [];
// the 3 Evidence beat needs the deployment's export-signing key (what `demo:export-key` sets up)
const prevKey = process.env.REGULAIT_EXPORT_SIGNING_KEY;
const prevKeyId = process.env.REGULAIT_EXPORT_SIGNING_KEY_ID;
let keyDir = "";

beforeAll(async () => {
  keyDir = mkdtempSync(path.join(tmpdir(), "c11-export-key-"));
  const keyPath = path.join(keyDir, "c11.key");
  writeFileSync(keyPath, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
  process.env.REGULAIT_EXPORT_SIGNING_KEY = keyPath;
  process.env.REGULAIT_EXPORT_SIGNING_KEY_ID = "c11-demo-export";
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
  if (prevKey === undefined) delete process.env.REGULAIT_EXPORT_SIGNING_KEY;
  else process.env.REGULAIT_EXPORT_SIGNING_KEY = prevKey;
  if (prevKeyId === undefined) delete process.env.REGULAIT_EXPORT_SIGNING_KEY_ID;
  else process.env.REGULAIT_EXPORT_SIGNING_KEY_ID = prevKeyId;
  if (keyDir) rmSync(keyDir, { recursive: true, force: true });
  // the seeder routes use-case sign-offs to Avery with an intake VARIANT
  // (ADR-0165); on a shared database that would redirect every later test
  // file's use-case sign-off, so retire it here (M-040 order independence)
  await db
    .update(workflowTemplates)
    .set({ retiredAt: new Date(), retiredReason: "zz-c11 cleanup" })
    .where(and(like(workflowTemplates.name, "ai-use-case-intake/governance-owner%"), isNull(workflowTemplates.retiredAt)));
  app.server.closeAllConnections();
  await app.close();
});

describe("demo:check over the real dataset", () => {
  it("reports every storyline beat", () => {
    const beats = new Set(checks.map((c) => c.beat));
    for (const b of [
      "0 Personas", "1 Shadow AI", "1 Intake assistant", "2 Register", "2 Use-case 360", "2 Risks",
      "3 Trust dashboard", "3 Dependency graph", "3 Monitor", "3 Regulatory", "2 Approval gate", "2 Deploy gate",
      "3 Evidence",
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

  it("3 Evidence FAILs — with the fix — when the export-signing key is missing (the 3E button would 409)", async () => {
    expect(checks.find((c) => c.beat === "3 Evidence")!.level).toBe("PASS");
    const key = process.env.REGULAIT_EXPORT_SIGNING_KEY;
    delete process.env.REGULAIT_EXPORT_SIGNING_KEY;
    try {
      const keyless = await runDemoCheck(app, { bootstrapToken: BOOT, fixtures: null });
      const evidence = keyless.find((c) => c.beat === "3 Evidence")!;
      expect(evidence.level).toBe("FAIL");
      expect(evidence.fix).toContain("demo:export-key");
    } finally {
      process.env.REGULAIT_EXPORT_SIGNING_KEY = key;
    }
  }, 120_000);
});

describe("demo:gate — the deploy-gate beat as a CI step", () => {
  it("prints the gate's own decision for an approved use case, with the exit code a pipeline acts on", async () => {
    const approved = DEMO_INTAKE_FIXTURES.useCases.find((u) => u.targetStatus === "approved")!;
    const r = await runDemoGate(app, { bootstrapToken: BOOT, useCase: approved.name, environment: "staging", ref: "c11-build" });
    expect(r.lines.join("\n")).toContain(`"${approved.name}"`);
    expect(r.lines.join("\n")).toMatch(/^(ALLOW|DENY) /m);
    expect(r.exitCode).toBe(r.ok ? 0 : 1);
    expect(r.lines.join("\n")).toContain("audited as deploy-gate-");
  });

  it("an unknown use case is a setup error (exit 2), not a decision", async () => {
    const r = await runDemoGate(app, { bootstrapToken: BOOT, useCase: "no such system c11" });
    expect(r.exitCode).toBe(2);
    expect(r.lines[0]).toContain("no use case matches");
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
