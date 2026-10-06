/**
 * ADR-0181 security review, integration cross-cut (FX1 x FX3): an EXPIRED
 * guardrail-window override (created_by 'assurance-window', expires_at in the
 * past) is not in force. The resolver already ignores it (FX3); the readers that
 * report configuration must not present it as live either:
 *
 *   - the model card's autofill lists the agent overrides IN FORCE, so an
 *     expired window row is left out, while a live window row is shown (it is
 *     the truth about what applies right now);
 *   - the compliance packs' `guardrail_configs` collector counts configured
 *     controls, so an expired window row is not evidence.
 *
 * Runs on its own scratch database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDb, eq, guardrailConfigs, runMigrations, sql, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { computeCardAutofill } from "./mrm-autofill.js";
import { runCollector } from "./compliance-packs.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../../packages/db/migrations");
const SCRATCH_DB = `regulait_int_win_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};
const BOOT = "int-window-bootstrap";

let admin: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(urlFor(SCRATCH_DB));
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "f".repeat(64) });
}, 120_000);

afterAll(async () => {
  await closeAll([
    async () => app?.close(),
    async () => db?.$client.end(),
    async () => dropScratchDatabase(admin, SCRATCH_DB),
    async () => admin?.$client.end(),
  ]);
});

async function mkAgent(name: string): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: { authorization: `Bearer ${BOOT}` },
    payload: { name, provider: "mock", tier: 0, costPerMTokIn: 1, costPerMTokOut: 1, model: "mock-fast" },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

/** a window override as the assurance window writes it: injection and
 * jailbreak at warn, the rest at block, expiring at `expiresAt` */
async function windowRow(agentId: string, expiresAt: Date): Promise<void> {
  await db.insert(guardrailConfigs).values({
    scope: "agent",
    scopeId: agentId,
    promptInjectionMode: "warn",
    jailbreakMode: "warn",
    toxicityMode: "block",
    semanticDlpMode: "block",
    createdBy: "assurance-window",
    expiresAt,
  });
}

describe("ADR-0181 integration: an expired guardrail window is not read as a live override", () => {
  it("model card autofill lists a LIVE window override and leaves an EXPIRED one out", async () => {
    const live = await mkAgent("int-window-live");
    const expired = await mkAgent("int-window-expired");
    const now = new Date();
    await windowRow(live, new Date(now.getTime() + 20 * 60_000));
    await windowRow(expired, new Date(now.getTime() - 60_000));

    const card = (agentId: string) => ({ id: randomUUID(), agentId, customProviderId: null });
    const liveFill = await computeCardAutofill(db, card(live), now);
    expect(liveFill.sections.guardrails.agentOverrides).toHaveLength(1);
    expect(liveFill.sections.guardrails.agentOverrides[0]!.modes.jailbreak).toBe("warn");

    // the expired row still exists (the sweep has not run) but is not in force
    expect(await db.select().from(guardrailConfigs).where(eq(guardrailConfigs.scopeId, expired))).toHaveLength(1);
    const expiredFill = await computeCardAutofill(db, card(expired), now);
    expect(expiredFill.sections.guardrails.agentOverrides).toEqual([]);
  });

  it("the compliance packs' guardrail_configs collector does not count an expired window row as evidence", async () => {
    await db.delete(guardrailConfigs);
    const ctx = {
      periodStart: new Date(Date.now() - 86_400_000),
      periodEnd: new Date(Date.now() + 86_400_000),
      projectIds: null,
      memberIds: null,
      params: { detector: "prompt_injection", minMode: "warn" },
    } as Parameters<typeof runCollector>[2];
    expect(await runCollector(db, "guardrail_configs", ctx)).toBe(0);

    const a = await mkAgent("int-window-evidence-expired");
    await windowRow(a, new Date(Date.now() - 60_000));
    expect(await runCollector(db, "guardrail_configs", ctx)).toBe(0);

    const b = await mkAgent("int-window-evidence-live");
    await windowRow(b, new Date(Date.now() + 20 * 60_000));
    expect(await runCollector(db, "guardrail_configs", ctx)).toBe(1);
    await db.delete(guardrailConfigs);
  });
});
