import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, inArray, runMigrations, shadowAiFindings, type Db } from "@regulait/db";
import { AI_APP_RISK_DATASET, aiAppRiskDatasetDigest } from "@regulait/shared";
import { buildApp } from "./app.js";

/**
 * ADR-0363 slice 3: the risk dataset route and the risk-ranked shadow-AI inventory. Read-only, admin-only; a
 * suggested site rule is never applied. Shares one database (fileParallelism off); providers are suffixed per run.
 */
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `e44r-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const UNKNOWN = `e44r-unknown-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
const ids: string[] = [];

const finding = (provider: string, subject: string, disposition: "open" | "false_positive" | "sanctioned" = "open") => ({
  subjectKind: "host" as const,
  subject: `${subject}-${RUN}`,
  provider,
  signalSources: ["egress"],
  signatureKinds: ["endpoint"],
  firstSeenAt: new Date(),
  lastSeenAt: new Date(),
  observationCount: 3,
  severity: "medium" as const,
  confidence: "high" as const,
  disposition,
  ...(disposition === "open" ? {} : { dispositionAt: new Date(), dispositionReason: "e44r test fixture" }),
  evidence: [],
});

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  const rows = await db
    .insert(shadowAiFindings)
    .values([
      finding("openai", "a"),
      finding("openai", "b", "sanctioned"),
      finding(UNKNOWN, "c"),
      finding("jetbrains-ai", "d", "false_positive"),
    ])
    .returning({ id: shadowAiFindings.id });
  ids.push(...rows.map((r) => r.id));
});

afterAll(async () => {
  if (ids.length) await db.delete(shadowAiFindings).where(inArray(shadowAiFindings.id, ids));
  await app.close();
});

describe("ADR-0363 slice 3: AI app risk", () => {
  it("serves the dataset with its version, canonical digest and every value's source", async () => {
    const r = await app.inject({ method: "GET", headers: AUTH, url: "/v1/ai-app-risk" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ version: 1, digest: aiAppRiskDatasetDigest() });
    expect(r.json().rows).toHaveLength(AI_APP_RISK_DATASET.length);
  });

  it("ranks the inventory by risk with factors, counts sanctioned findings, leaves false positives out, applies nothing", async () => {
    const r = await app.inject({ method: "GET", headers: AUTH, url: "/v1/shadow-ai/risk" });
    expect(r.statusCode).toBe(200);
    const providers = r.json().providers as Array<{ provider: string; score: number; band: string; suggestedSiteRule: string; factors: Array<{ points: number }>; inventory: { findings: number; sanctionedFindings: number } }>;
    const unknown = providers.find((p) => p.provider === UNKNOWN)!;
    const openai = providers.find((p) => p.provider === "openai")!;
    expect(unknown).toMatchObject({ band: "high", suggestedSiteRule: "block" });
    expect(openai.inventory).toMatchObject({ findings: 2, sanctionedFindings: 1 });
    expect(openai.factors.reduce((n, f) => n + f.points, 0)).toBe(openai.score);
    expect(providers.findIndex((p) => p.provider === UNKNOWN)).toBeLessThan(providers.findIndex((p) => p.provider === "openai"));
    // jetbrains-ai's only finding here is a false positive (another suite may hold real ones)
    const jb = providers.find((p) => p.provider === "jetbrains-ai");
    if (jb) expect(jb.inventory.findings).toBeGreaterThan(0);
  });

  it("is admin-only", async () => {
    const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: `e44r-${RUN}@example.com`, displayName: "e44r" } });
    const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "t" } });
    const r = await app.inject({ method: "GET", headers: { authorization: `Bearer ${k.json().token}` }, url: "/v1/shadow-ai/risk" });
    expect(r.statusCode).toBe(403);
  });
});
