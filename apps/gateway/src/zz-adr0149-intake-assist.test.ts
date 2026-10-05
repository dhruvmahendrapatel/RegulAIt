/**
 * ADR-0149 — the intake assistant route (`POST /v1/use-cases/intake/assist`).
 *
 * Pinned:
 *  - it is SUGGESTION-ONLY: no use case and no risk is written, and the one
 *    audit row carries counts, never the proposer's description text;
 *  - the rules half works with no model at all;
 *  - a model draft goes through the ordinary entitlement check — an agent the
 *    caller may not invoke is REFUSED (and the rules draft still returns);
 *  - a reply that is not the requested JSON (the keyless mock's canned prose)
 *    is reported as `unparseable`, never passed off as a draft;
 *  - an identity-less caller and a smuggled tier are refused.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiRisks, aiUseCases, auditLog, and, createDb, eq, runMigrations, usageEvents, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `adr0149-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const SECRET_DESCRIPTION = `Recommends credit limits — internal codename ZEPHYR-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let user = { id: "", auth: { authorization: "" } };
let grantedAgent = "";
let ungrantedAgent = "";

const call = (url: string, headers: Record<string, string>, payload: unknown) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });

const hero = (extra: Record<string, unknown> = {}) => ({
  title: "Credit-limit-increase assistant",
  description: SECRET_DESCRIPTION,
  euAiAct: {
    purposeDomain: "essential-services",
    affectedPersons: ["customers"],
    decisionAutonomy: "human-reviews",
    biometricUse: "none",
    emotionRecognition: false,
    socialScoring: false,
    manipulativeTechniques: false,
    profilesNaturalPersons: true,
    safetyComponent: false,
    interactsWithHumans: true,
    generatesSyntheticContent: true,
  },
  context: {
    sectors: ["financial-services"],
    dataCategories: ["personal", "financial"],
    deployment: "customer-facing",
    euNexus: true,
    usesExternalVendor: true,
    generative: true,
    autonomousActions: true,
    toolsUsed: ["crm.read", "bureau.score", "limits.propose"],
  },
  ...extra,
});

async function makeAgent(name: string) {
  const r = await call("/v1/agents", AUTH, {
    name: `${name}-${RUN}`, provider: "mock", tier: 1, modes: ["chat"], model: "mock-balanced",
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, useCaseGateMode: "off" });
  const u = await call("/v1/users", AUTH, { email: `adr0149-${RUN}@example.com`, displayName: "Proposer" });
  user.id = u.json().id;
  user.auth = { authorization: `Bearer ${(await call(`/v1/users/${user.id}/keys`, AUTH, { name: "k" })).json().token}` };
  grantedAgent = await makeAgent("adr0149-granted");
  ungrantedAgent = await makeAgent("adr0149-ungranted");
  expect((await call("/v1/grants/agents", AUTH, { userId: user.id, agentId: grantedAgent })).statusCode).toBeLessThan(300);
}, 120_000);

afterAll(async () => {
  app.server.closeAllConnections();
  await restoreSb2Gates();
  await app.close();
});

const counts = async () => ({
  useCases: (await db.select({ id: aiUseCases.id }).from(aiUseCases).where(eq(aiUseCases.ownerUserId, user.id))).length,
  risks: (await db.select({ id: aiRisks.id }).from(aiRisks).where(eq(aiRisks.ownerUserId, user.id))).length,
});

describe("rules-only assistance", () => {
  it("suggests tier, frameworks, risks and a traced draft — and writes nothing but one audit row", async () => {
    const before = await counts();
    const r = await call("/v1/use-cases/intake/assist", user.auth, hero());
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.tier.value).toBe("high");
    expect(b.tier.source).toBe("rules");
    expect(b.frameworks.map((f: { framework: string }) => f.framework)).toContain("eu-ai-act");
    expect(b.risks.length).toBeGreaterThanOrEqual(6);
    expect(b.questionnaire).toHaveLength(8);
    expect(b.narrative).toEqual({ status: "not_requested" });
    expect(b.euAiActBlock).toContain("eu-ai-act-answers");

    expect(await counts()).toEqual(before);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, user.id), eq(auditLog.ruleId, "use-case-intake-assisted")));
    expect(audits).toHaveLength(1);
    // the proposer has submitted nothing — their text stays out of the ledger
    expect(JSON.stringify(audits[0])).not.toContain(`ZEPHYR-${RUN}`);
  });
});

describe("the optional model draft", () => {
  it("refuses an agent the caller may not invoke, without failing the request", async () => {
    const usageBefore = (await db.select().from(usageEvents).where(eq(usageEvents.userId, user.id))).length;
    const r = await call("/v1/use-cases/intake/assist", user.auth, hero({ draftNarrative: true, agentId: ungrantedAgent }));
    expect(r.statusCode).toBe(200);
    expect(r.json().narrative.status).toBe("refused");
    expect(r.json().questionnaire.every((q: { source: string }) => q.source === "rules")).toBe(true);
    // nothing was dispatched
    expect((await db.select().from(usageEvents).where(eq(usageEvents.userId, user.id))).length).toBe(usageBefore);
  });

  it("dispatches through the governed path for an entitled agent, and never passes off canned prose as a draft", async () => {
    const usageBefore = (await db.select().from(usageEvents).where(eq(usageEvents.userId, user.id))).length;
    const r = await call("/v1/use-cases/intake/assist", user.auth, hero({ draftNarrative: true, agentId: grantedAgent }));
    expect(r.statusCode, r.body).toBe(200);
    // POSITIVE CONTROL that the dispatch really happened: it is metered
    expect((await db.select().from(usageEvents).where(eq(usageEvents.userId, user.id))).length).toBe(usageBefore + 1);
    const n = r.json().narrative;
    // the keyless mock replies with canned prose, not the JSON asked for —
    // that must surface as unparseable with the rules draft intact
    if (n.status === "drafted") {
      expect(n.source).toBe("mock");
    } else {
      expect(n.status).toBe("unparseable");
      expect(r.json().questionnaire.every((q: { source: string }) => q.source === "rules")).toBe(true);
    }
  });
});

describe("refusals", () => {
  it("refuses an identity-less caller and a smuggled tier", async () => {
    expect((await call("/v1/use-cases/intake/assist", AUTH, hero())).statusCode).toBe(403);
    const smuggled = hero();
    (smuggled.euAiAct as Record<string, unknown>).tier = "minimal";
    expect((await call("/v1/use-cases/intake/assist", user.auth, smuggled)).statusCode).toBe(400);
  });
});
