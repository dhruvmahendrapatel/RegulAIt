/**
 * ADR-0158 — `GET /v1/regulatory/updates` and the feed join.
 *
 * Pinned: a mapped control resolves to its LIVE pack evaluation status; a ref
 * in no active pack and a framework with no active pack are gaps, never
 * silently dropped; tier-scoped entries include only use cases whose computed
 * tier matches; the route serves the loaded feed (or says plainly that none is
 * loaded); admin-only. The database is shared — assertions are on ids and
 * refs this file controls (M-008, M-040).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiUseCases, and, compliancePacks, createDb, eq, runMigrations, users, type Db } from "@regulait/db";
import { CONTROL_EVALUATION_STATUSES, type RegulatoryUpdate } from "@regulait/shared";
import { buildApp } from "./app.js";
import { computeRegulatoryFeed, regulatoryFeed } from "./regulatory-intel.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `g158-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const REF = "eu-ai-act:art-14-human-oversight"; // present in every eu-ai-act version

let db: Db;
let app: ReturnType<typeof buildApp>;
let highId = "";
let minimalId = "";

const entry = (over: Partial<RegulatoryUpdate> = {}): RegulatoryUpdate => ({
  key: `g158-${RUN}`,
  jurisdiction: "EU",
  instrument: "Synthetic instrument",
  title: "Synthetic obligation",
  summary: "test entry",
  effectiveDate: "2027-01-01",
  status: "upcoming",
  frameworks: ["eu-ai-act", `no-such-framework-${RUN}`],
  controlRefs: [REF, `no-such-control-${RUN}`],
  sourceUrl: "https://example.org/source",
  verifiedOn: "2026-10-02",
  ...over,
});

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  expect([200, 201]).toContain((await app.inject({ method: "POST", url: "/v1/compliance/packs/seed", headers: AUTH, payload: {} })).statusCode);
  // some eu-ai-act version must be active; leave whichever another file chose
  const active = await db
    .select()
    .from(compliancePacks)
    .where(and(eq(compliancePacks.framework, "eu-ai-act"), eq(compliancePacks.status, "active")));
  if (active.length === 0) {
    const [v1] = await db
      .select()
      .from(compliancePacks)
      .where(and(eq(compliancePacks.framework, "eu-ai-act"), eq(compliancePacks.version, 1)));
    await db.update(compliancePacks).set({ status: "active" }).where(eq(compliancePacks.id, v1!.id));
  }
  const [owner] = await db.insert(users).values({ email: `g158-${RUN}@example.com`, displayName: "Reg owner" }).returning({ id: users.id });
  const base = { description: "synthetic", businessContext: "reg test", dataSensitivity: "internal" as const, ownerUserId: owner!.id };
  const [h] = await db.insert(aiUseCases).values({ ...base, name: `g158 high ${RUN}`, status: "approved", euAiActTier: "high", euAiActRulesetVersion: 1, euAiActReasons: [] }).returning({ id: aiUseCases.id });
  const [m] = await db.insert(aiUseCases).values({ ...base, name: `g158 minimal ${RUN}`, status: "under_review", euAiActTier: "minimal", euAiActRulesetVersion: 1, euAiActReasons: [] }).returning({ id: aiUseCases.id });
  highId = h!.id;
  minimalId = m!.id;
}, 120_000);

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
});

describe("ADR-0158 regulatory intelligence", () => {
  it("joins a mapped control to its live evaluation, and reports gaps instead of dropping them", async () => {
    const out = await computeRegulatoryFeed(db, { feed: [entry()] });
    const [u] = out.updates;
    const [known, unknown] = u!.controls;
    expect(known!.controlRef).toBe(REF);
    expect(known!.framework).toBe("eu-ai-act");
    expect(CONTROL_EVALUATION_STATUSES as readonly string[]).toContain(known!.status);
    expect(unknown).toMatchObject({ status: "not_in_active_pack", framework: null });
    expect(u!.frameworks.find((f) => f.framework === "eu-ai-act")!.packActive).toBe(true);
    expect(u!.impact.frameworkGaps).toBe(1);
    expect(u!.impact.controlGaps).toBeGreaterThanOrEqual(1);
    const ids = u!.impact.useCases.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining([highId, minimalId]));
  });

  it("narrows by computed tier when the entry says so", async () => {
    const out = await computeRegulatoryFeed(db, { feed: [entry({ scope: { euAiActTiers: ["high"] } })] });
    const ids = out.updates[0]!.impact.useCases.map((x) => x.id);
    expect(ids).toContain(highId);
    expect(ids).not.toContain(minimalId);
    expect(out.updates[0]!.impact.scopeBasis).toBe("eu_ai_act_tier");
  });

  it("serves the loaded feed (or says none is loaded), filters, and is admin-only", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/regulatory/updates", headers: AUTH });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.summary.total).toBe(regulatoryFeed().length);
    if (regulatoryFeed().length === 0) expect(body.notes.feed).toContain("not 'nothing applies'");
    const f = await app.inject({ method: "GET", url: "/v1/regulatory/updates?status=proposed&framework=eu-ai-act", headers: AUTH });
    expect(f.statusCode).toBe(200);
    for (const u of f.json().updates) expect(u.status).toBe("proposed");
    expect((await app.inject({ method: "GET", url: "/v1/regulatory/updates?status=bogus", headers: AUTH })).statusCode).toBe(400);

    const m = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `g158-m-${RUN}@example.com`, displayName: "M" } });
    const key = (await app.inject({ method: "POST", url: `/v1/users/${m.json().id}/keys`, headers: AUTH, payload: { name: "k" } })).json().token;
    expect((await app.inject({ method: "GET", url: "/v1/regulatory/updates", headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(403);
  });
});
