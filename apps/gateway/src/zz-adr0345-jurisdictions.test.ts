/**
 * ADR-0345 §9 (lane E26) — geography as a factor in risk tiering, against a real database.
 *
 *  - the seeded jurisdictions and obligations are data: every obligation cites a real ADR-0158 regulatory feed entry,
 *    in the same jurisdiction the feed names, and every jurisdiction the feed names is seeded;
 *  - a use case's jurisdictions resolve, through the database rows, to the obligations and tier floor they bring in;
 *  - NEGATIVE: the shape CHECKs refuse a bad code, an unknown agent risk and an unknown tier; a jurisdiction still
 *    referenced by a use case cannot be deleted; all three tables are under forced row-level security.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  aiUseCaseJurisdictions,
  aiUseCases,
  createDb,
  eq,
  inArray,
  jurisdictionObligations,
  jurisdictions,
  runMigrations,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { REGULATORY_UPDATES, effectiveRiskTier, resolveGeography, type JurisdictionObligationRow } from "@regulait/shared";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
let db: Db;
let ownerId: string;
let useCaseId: string;

const failure = (p: Promise<unknown>) =>
  p.then(
    () => "no error",
    (e: { message?: string; cause?: { message?: string } }) => String(e?.cause?.message ?? e?.message),
  );

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  const [u] = await db
    .insert(users)
    .values({ email: `e26-geo-${RUN}@example.test`, displayName: "e26 geo", isAdmin: true })
    .returning({ id: users.id });
  ownerId = u!.id;
  const [uc] = await db
    .insert(aiUseCases)
    .values({
      name: `e26 geography ${RUN}`,
      description: "geography test",
      ownerUserId: ownerId,
      businessContext: "test",
      dataSensitivity: "internal",
    })
    .returning({ id: aiUseCases.id });
  useCaseId = uc!.id;
});

afterAll(async () => {
  await db.delete(aiUseCases).where(eq(aiUseCases.id, useCaseId));
  await db.update(users).set({ disabledAt: new Date() }).where(inArray(users.id, [ownerId]));
});

const loadData = async () => {
  const js = await db.select().from(jurisdictions);
  const os = await db.select().from(jurisdictionObligations);
  return {
    js: js.map((j) => ({ code: j.code, parentCode: j.parentCode, global: j.global })),
    os: os.map(
      (o): JurisdictionObligationRow => ({
        jurisdictionCode: o.jurisdictionCode,
        regulatoryUpdateKey: o.regulatoryUpdateKey,
        agentRiskKey: o.agentRiskKey,
        tierFloor: o.tierFloor,
      }),
    ),
  };
};

describe("ADR-0345 §9: the seeded geography data", () => {
  it("every obligation cites a real feed entry, in the jurisdiction the feed names", async () => {
    const { os } = await loadData();
    const feed = new Map(REGULATORY_UPDATES.map((u) => [u.key, u]));
    const seeded = os.filter((o) => o.regulatoryUpdateKey !== `e26-${RUN}`);
    expect(seeded.length).toBeGreaterThanOrEqual(21);
    for (const o of seeded) {
      const entry = feed.get(o.regulatoryUpdateKey);
      expect(entry, o.regulatoryUpdateKey).toBeDefined();
      expect(entry!.jurisdiction).toBe(o.jurisdictionCode);
      expect(entry!.status).not.toBe("withdrawn");
    }
  });

  it("every jurisdiction the feed names is seeded", async () => {
    const { js } = await loadData();
    const codes = new Set(js.map((j) => j.code));
    expect([...new Set(REGULATORY_UPDATES.map((u) => u.jurisdiction))].filter((c) => !codes.has(c))).toEqual([]);
  });
});

describe("ADR-0345 §9: a use case's jurisdictions decide its obligations and tier floor", () => {
  it("a Colorado use case brings in Colorado, US federal and the international obligations, not the EU ones", async () => {
    await db.insert(aiUseCaseJurisdictions).values({ useCaseId, jurisdictionCode: "US-CO", addedByUserId: ownerId });
    const declared = (
      await db.select().from(aiUseCaseJurisdictions).where(eq(aiUseCaseJurisdictions.useCaseId, useCaseId))
    ).map((r) => r.jurisdictionCode);
    const { js, os } = await loadData();
    const r = resolveGeography(declared, js, os);
    expect(r.inScope).toEqual(["International", "US", "US-CO"]);
    expect(r.obligations.some((o) => o.regulatoryUpdateKey === "colorado-ai-act-sb26-189")).toBe(true);
    expect(r.obligations.some((o) => o.jurisdictionCode === "EU")).toBe(false);
    // no seeded floor: the screened tier stands until an admin records one
    expect(r.tierFloor).toBeNull();
    expect(effectiveRiskTier("minimal", r.tierFloor)).toBe("minimal");
  });

  it("an admin-recorded floor raises the tier", async () => {
    await db.insert(jurisdictionObligations).values({
      jurisdictionCode: "US-CO",
      regulatoryUpdateKey: `e26-${RUN}`,
      agentRiskKey: "governance_gap",
      tierFloor: "high",
      createdByUserId: ownerId,
    });
    const { js, os } = await loadData();
    const r = resolveGeography(["US-CO"], js, os);
    expect(r.tierFloor).toBe("high");
    expect(effectiveRiskTier("limited", r.tierFloor)).toBe("high");
    await db.delete(jurisdictionObligations).where(eq(jurisdictionObligations.regulatoryUpdateKey, `e26-${RUN}`));
  });

  it("NEGATIVE: a jurisdiction a use case still names cannot be deleted", async () => {
    expect(await failure(db.delete(jurisdictions).where(eq(jurisdictions.code, "US-CO")))).toMatch(/foreign key/);
  });
});

describe("ADR-0345 §9: NEGATIVE shape checks and row-level security", () => {
  it("refuses a bad code, an unknown agent risk and an unknown tier", async () => {
    expect(await failure(db.execute(sql`insert into jurisdictions (code, name) values ('eu', 'x')`))).toMatch(/jurisdictions_code_check/);
    expect(
      await failure(
        db.execute(sql`insert into jurisdiction_obligations (jurisdiction_code, regulatory_update_key, agent_risk_key)
          values ('EU', 'x', 'nope')`),
      ),
    ).toMatch(/jurisdiction_obligations_risk_check/);
    expect(
      await failure(
        db.execute(sql`insert into jurisdiction_obligations (jurisdiction_code, regulatory_update_key, agent_risk_key, tier_floor)
          values ('EU', 'x', 'governance_gap', 'severe')`),
      ),
    ).toMatch(/jurisdiction_obligations_tier_check/);
  });

  it("all three tables are under forced row-level security; a plain connection sees no row", async () => {
    const r = await db.execute(sql`
      select relname, relrowsecurity as on, relforcerowsecurity as forced from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'r'
         and relname in ('jurisdictions', 'jurisdiction_obligations', 'ai_use_case_jurisdictions') order by relname`);
    expect(r.rows).toEqual(
      ["ai_use_case_jurisdictions", "jurisdiction_obligations", "jurisdictions"].map((relname) => ({ relname, on: true, forced: true })),
    );
    const n = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('role', 'regulait_app', true)`);
      return ((await tx.execute(sql`select count(*)::int as n from jurisdictions`)).rows[0] as { n: number }).n;
    });
    expect(n).toBe(0);
  });
});
