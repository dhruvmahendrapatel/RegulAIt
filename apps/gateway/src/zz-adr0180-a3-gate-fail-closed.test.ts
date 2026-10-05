/**
 * ADR-0180 A3 — the deploy gate FAILS CLOSED when an assurance check throws.
 *
 * One owner's interface function (here A10's `residualPosition`) is made to
 * throw. Under `enforce` the gate denies with `assurance_check_unavailable`;
 * under `warn` it reports the same code as a warning. A check that did not
 * run is never read as clear. Global state (M-068): the gate mode is restored.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiUseCases, createDb, eq, governanceReviewPolicy, runMigrations, type Db } from "@regulait/db";

vi.mock("./risk-tolerance.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./risk-tolerance.js")>();
  return {
    ...real,
    residualPosition: async () => {
      throw new Error("synthetic residual-position failure");
    },
  };
});

const { buildApp } = await import("./app.js");
const { setAssuranceGateModeForTest } = await import("./testing/assurance-mode.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `a3fc-boot-${RUN}`;
let db: Db;
let app: ReturnType<typeof buildApp>;
let ucId = "";
let restore = async (): Promise<void> => {};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: { authorization: `Bearer ${BOOT}` }, payload: { email: `a3fc-${RUN}@example.com`, displayName: "a3fc", isAdmin: true } });
  const [uc] = await db
    .insert(aiUseCases)
    .values({ name: `a3fc ${RUN}`, description: "synthetic", businessContext: "fail closed", dataSensitivity: "internal", ownerUserId: u.json().id, status: "approved", intendedAgentIds: [] })
    .returning({ id: aiUseCases.id });
  ucId = uc!.id;
  // nothing required, so the only assurance reason left is the failed check
  await db
    .insert(governanceReviewPolicy)
    .values({ id: "default", requiredTests: { unscreened: { classes: [], freshnessDays: 30 } } })
    .onConflictDoUpdate({ target: governanceReviewPolicy.id, set: { requiredTests: { unscreened: { classes: [], freshnessDays: 30 } } } });
}, 120_000);

afterAll(async () => {
  await restore();
  await db.update(governanceReviewPolicy).set({ requiredTests: {} });
  if (ucId) await db.delete(aiUseCases).where(eq(aiUseCases.id, ucId));
  app.server.closeAllConnections();
  await app.close();
});

const gate = async () => {
  const r = await app.inject({ method: "POST", url: "/v1/gates/deploy", headers: { authorization: `Bearer ${BOOT}` }, payload: { useCaseId: ucId } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { decision: string; reasons: Array<{ code: string; severity: string }> };
};

describe("ADR-0180 A3 the gate fails closed on a check that throws", () => {
  it("enforce: denies with assurance_check_unavailable", async () => {
    restore = await setAssuranceGateModeForTest(db, "enforce");
    const g = await gate();
    expect(g.decision).toBe("deny");
    expect(g.reasons.map((r) => [r.code, r.severity])).toEqual([["assurance_check_unavailable", "block"]]);
  });

  it("warn: the same code, as a warning", async () => {
    restore = await setAssuranceGateModeForTest(db, "warn");
    const g = await gate();
    expect(g.decision).toBe("allow");
    expect(g.reasons.map((r) => [r.code, r.severity])).toEqual([["assurance_check_unavailable", "warn"]]);
  });
});
