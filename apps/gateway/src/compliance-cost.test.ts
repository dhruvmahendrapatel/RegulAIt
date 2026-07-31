import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, usageEvents, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { effectiveCompliancePolicy, preDispatchProjectGate } from "./projects.js";

/**
 * O2 (ADR-0027, migration 0045) — per-framework COST policies. A compliance
 * profile may declare a project-budget CEILING (MIN-composed, strictest
 * wins, caps unbudgeted projects too) and a budget-enforcement FLOOR
 * ('block' forces blocking even in a warn_only org; 'warn_only' can never
 * relax and is surfaced as inert). Wired into the project budget gate;
 * conflicts surfaced like the existing cascade conflicts. Shares one DB
 * (fileParallelism off); prefix o2-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "o2-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let umaId: string;
let approverId: string;

type ProfileRow = Parameters<typeof effectiveCompliancePolicy>[0][number];
const profile = (over: Partial<ProfileRow>): ProfileRow =>
  ({
    id: "p", tag: "t", requiredTemplateIds: null, mcpDefaultMode: "read_write",
    auditRetentionDays: null, piiMode: "log", backupRetentionDays: null,
    patchCadenceDays: null, maxProjectBudgetUsd: null, budgetEnforcement: null,
    createdAt: new Date(), ...over,
  }) as ProfileRow;

async function mkProject(payload: Record<string, unknown>): Promise<string> {
  const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/projects", payload });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

async function spend(projectId: string, costUsd: number) {
  await db.insert(usageEvents).values({ userId: umaId, objectType: "agent", projectId, costUsd });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  const mk = async (email: string) => {
    const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: email.split("@")[0] } });
    return u.json().id as string;
  };
  umaId = await mk("o2-uma@example.com");
  approverId = await mk("o2-approver@example.com");
  const p = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/compliance/profiles",
    payload: { tag: "o2-finreg", maxProjectBudgetUsd: 0.01, budgetEnforcement: "block", piiMode: "log" },
  });
  expect(p.statusCode).toBe(201);
  expect(p.json()).toMatchObject({ maxProjectBudgetUsd: 0.01, budgetEnforcement: "block" });
});

describe("cascade composition (strictest wins, matching the existing rules)", () => {
  it("maxProjectBudgetUsd composes as MIN; budgetEnforcement 'block' beats 'warn_only' beats no-opinion", () => {
    const eff = effectiveCompliancePolicy([
      profile({ maxProjectBudgetUsd: 500, budgetEnforcement: "warn_only" }),
      profile({ maxProjectBudgetUsd: 100, budgetEnforcement: "block" }),
      profile({}),
    ]);
    expect(eff.maxProjectBudgetUsd).toBe(100);
    expect(eff.budgetEnforcement).toBe("block");
    const none = effectiveCompliancePolicy([profile({})]);
    expect(none.maxProjectBudgetUsd).toBeNull();
    expect(none.budgetEnforcement).toBeNull();
  });
});

describe("the project budget gate honours the framework's cost policy", () => {
  it("the compliance ceiling governs when tighter than the project budget — the 409 names the framework", async () => {
    const projectId = await mkProject({
      name: "o2-capped", budgetUsd: 1000, budgetApproverUserId: approverId,
      classifications: ["o2-finreg"],
    });
    await spend(projectId, 0.02); // past the $0.01 ceiling, far under the $1000 budget
    const gate = await preDispatchProjectGate(db, projectId, umaId);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.error).toBe("project_budget_exceeded");
      expect(gate.detail).toContain("compliance ceiling $0.01");
      expect(gate.detail).toContain("o2-finreg");
    }
  });

  it("the ceiling caps an UNBUDGETED project too — a framework cap is not opt-out-able", async () => {
    const projectId = await mkProject({ name: "o2-unbudgeted", classifications: ["o2-finreg"] });
    await spend(projectId, 0.02);
    const gate = await preDispatchProjectGate(db, projectId, umaId);
    expect(gate.ok).toBe(false);
  });

  it("a profile's 'block' forces blocking even when the org says warn_only (strictest wins)", async () => {
    const put = await app.inject({
      method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: { budgetEnforcement: "warn_only" },
    });
    expect(put.statusCode).toBe(200);
    try {
      const projectId = await mkProject({
        name: "o2-forced-block", budgetUsd: 1000, budgetApproverUserId: approverId,
        classifications: ["o2-finreg"],
      });
      await spend(projectId, 0.02);
      const gate = await preDispatchProjectGate(db, projectId, umaId);
      expect(gate.ok).toBe(false);
      if (!gate.ok) expect(gate.detail).toContain("blocking forced by the compliance cascade");
      // an UNCLASSIFIED project keeps the org's warn_only (advisory) behaviour
      const openId = await mkProject({ name: "o2-warned", budgetUsd: 0.01, budgetApproverUserId: approverId });
      await spend(openId, 0.02);
      const warned = await preDispatchProjectGate(db, openId, umaId);
      expect(warned.ok).toBe(true);
    } finally {
      await app.inject({
        method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: { budgetEnforcement: "block" },
      });
    }
  });

  it("an unclassified project is byte-identical to before (no cascade, project budget only)", async () => {
    const projectId = await mkProject({ name: "o2-plain", budgetUsd: 1000, budgetApproverUserId: approverId });
    await spend(projectId, 0.02);
    const gate = await preDispatchProjectGate(db, projectId, umaId);
    expect(gate.ok).toBe(true);
  });
});

describe("conflicts are SURFACED like the existing cascade conflicts", () => {
  it("GET /v1/projects/:id/compliance reports the ceiling conflict and the enforcement override", async () => {
    const projectId = await mkProject({
      name: "o2-conflicted", budgetUsd: 1000, budgetApproverUserId: approverId,
      classifications: ["o2-finreg"],
    });
    const r = await app.inject({ method: "GET", headers: AUTH, url: `/v1/projects/${projectId}/compliance` });
    expect(r.statusCode).toBe(200);
    const cost = r.json().costPolicy;
    expect(cost.maxProjectBudgetUsd).toBe(0.01);
    expect(cost.budgetEnforcement).toBe("block");
    expect(cost.conflicts.join(" ")).toContain("exceeds the compliance ceiling");
  });
});
