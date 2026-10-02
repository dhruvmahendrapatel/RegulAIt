/**
 * Demo task C6 — the intake demo seeder, against a small inline fixture set
 * (Gemini's full fixtures are exercised by the same function in `demo:intake`).
 *
 * Pinned: every object is created through the real APIs and lands in its
 * target state — use cases and vendors driven through their intake workflows
 * (sign-off recorded, tiers COMPUTED from the submitted questionnaire), risks
 * with controls, residual and transitions; a second run creates nothing; a
 * reference to a missing agent is reported, not thrown.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiRisks, aiUseCases, aiVendors, createDb, eq, inArray, modelCards, runMigrations, type Db } from "@regulait/db";
import type { DemoIntakeFixtures, IntakeAssistRequest } from "@regulait/shared";
import { buildApp } from "./app.js";
import { seedDemoIntake } from "./demo-intake-seed-lib.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `c6-boot-${RUN}`;
const AGENT = `c6-agent-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;

const intake = (over: Partial<IntakeAssistRequest["euAiAct"]> = {}, purposeDomain = "internal-productivity"): IntakeAssistRequest => ({
  title: "t",
  description: "d",
  euAiAct: {
    purposeDomain: purposeDomain as IntakeAssistRequest["euAiAct"]["purposeDomain"],
    affectedPersons: [],
    decisionAutonomy: "informs-human",
    biometricUse: "none",
    emotionRecognition: false,
    socialScoring: false,
    manipulativeTechniques: false,
    profilesNaturalPersons: false,
    safetyComponent: false,
    interactsWithHumans: false,
    generatesSyntheticContent: false,
    ...over,
  },
  context: {
    sectors: [], dataCategories: ["proprietary"], deployment: "internal", euNexus: true,
    usesExternalVendor: false, generative: false, autonomousActions: false, toolsUsed: [],
  },
  draftNarrative: false,
});

const uc = (key: string, targetStatus: DemoIntakeFixtures["useCases"][number]["targetStatus"], i: IntakeAssistRequest, decisionReason?: string) => ({
  key, name: `c6 ${key} ${RUN}`, description: "synthetic", businessContext: "demo",
  dataSensitivity: "internal" as const, complianceTags: [], targetStatus, intake: i,
  intendedAgentNames: [AGENT], ...(decisionReason ? { decisionReason } : {}),
});

const fixtures = (): DemoIntakeFixtures => ({
  company: { name: "Acme Bank (fictional)", description: "synthetic" },
  hero: uc("hero", "proposed", intake({ profilesNaturalPersons: true, affectedPersons: ["customers"] }, "essential-services")),
  vendors: [
    { key: "va", name: `c6 vendor approved ${RUN}`, description: "synthetic", category: "model_provider", linkedAgentProviders: ["mock"], targetStatus: "approved" },
    { key: "vp", name: `c6 vendor proposed ${RUN}`, description: "synthetic", category: "model_provider", linkedAgentProviders: [], targetStatus: "proposed" },
    { key: "vr", name: `c6 vendor rejected ${RUN}`, description: "synthetic", category: "data_processor", linkedAgentProviders: [], targetStatus: "rejected" },
  ],
  useCases: [
    uc("approved", "approved", intake()),
    uc("review", "under_review", intake({ profilesNaturalPersons: true, affectedPersons: ["customers"] }, "essential-services")),
    uc("prohibited", "rejected", intake({ socialScoring: true, affectedPersons: ["general-public"] }), "prohibited social scoring"),
    uc("retired", "retired", intake(), "replaced by a newer system"),
    { ...uc("proposed", "proposed", intake()), intendedAgentNames: [AGENT, `missing-agent-${RUN}`] },
  ],
  risks: [
    { key: "r1", useCaseKey: "approved", title: `c6 mitigated ${RUN}`, description: "s", category: "hallucination", likelihood: "high", impact: "medium", targetStatus: "mitigating", residual: { likelihood: "low", impact: "medium" }, controls: ["eu-ai-act:art-15-accuracy-robustness"] },
    { key: "r2", useCaseKey: "approved", vendorKey: "va", title: `c6 accepted ${RUN}`, description: "s", category: "third_party_ai", likelihood: "low", impact: "medium", targetStatus: "accepted", controls: [], acceptanceNote: "carried knowingly" },
    { key: "r3", useCaseKey: "approved", title: `c6 closed ${RUN}`, description: "s", category: "prompt_injection", likelihood: "medium", impact: "medium", targetStatus: "closed", controls: ["soc-2:CC7.2-monitoring"], closeReason: "feature removed" },
    { key: "r5", vendorKey: "va", title: `c6 vendor-only ${RUN}`, description: "s", category: "third_party_ai", likelihood: "high", impact: "high", targetStatus: "open", controls: [] },
    { key: "r4", useCaseKey: "review", title: `c6 open bias ${RUN}`, description: "s", category: "bias_fairness", likelihood: "medium", impact: "high", targetStatus: "open", controls: [] },
  ],
  modelCards: [
    { agentName: AGENT, intendedUse: `c6 card ${RUN}`, dataClaims: { categories: ["financial"] }, limitations: "none known", biasFairness: [{ dimension: "age", method: "parity", status: "assessed", resultRef: "eval-1" }], standardRefs: ["nist-ai-rmf:MEASURE-2.11"] },
  ],
  shadowAi: [{ appName: `c6 app ${RUN}`, vendorHost: "api.openai.com", grantedBy: "user-17@acme.example", installCount: 3 }],
});

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  const a = await app.inject({
    method: "POST", url: "/v1/agents", headers: { authorization: `Bearer ${BOOT}` },
    payload: { name: AGENT, provider: "mock", tier: 1, modes: ["chat"], model: "mock-balanced" },
  });
  expect(a.statusCode).toBe(201);
}, 120_000);

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
});

describe("seedDemoIntake", () => {
  it("drives every object to its target state through the real APIs, idempotently", async () => {
    const first = await seedDemoIntake(app, fixtures(), { bootstrapToken: BOOT });
    expect(first.failed, first.failed.join("\n")).toEqual([]);
    expect(first.notes.some((n) => n.includes(`missing-agent-${RUN}`))).toBe(true);

    const ucs = await db.select().from(aiUseCases).where(inArray(aiUseCases.name, fixtures().useCases.map((u) => u.name)));
    const byKey = (k: string) => ucs.find((u) => u.name === `c6 ${k} ${RUN}`)!;
    expect(byKey("approved").status).toBe("approved");
    expect(byKey("review").status).toBe("under_review");
    expect(byKey("prohibited").status).toBe("rejected");
    expect(byKey("retired").status).toBe("retired");
    expect(byKey("proposed").status).toBe("proposed");
    // the tier is COMPUTED from the submitted questionnaire — never stated
    expect(byKey("review").euAiActTier).toBe("high");
    expect(byKey("prohibited").euAiActTier).toBe("prohibited");
    expect(byKey("proposed").euAiActTier).toBeNull(); // nothing submitted, nothing screened

    const vendors = await db.select().from(aiVendors).where(inArray(aiVendors.name, fixtures().vendors.map((v) => v.name)));
    const vs = (k: string) => vendors.find((v) => v.name === fixtures().vendors.find((f) => f.key === k)!.name)!.status;
    expect(vs("va")).toBe("approved");
    expect(vs("vp")).toBe("proposed");
    expect(vs("vr")).toBe("rejected");

    const risks = await db.select().from(aiRisks).where(inArray(aiRisks.title, fixtures().risks.map((r) => r.title)));
    const rs = (t: string) => risks.find((r) => r.title === `c6 ${t} ${RUN}`)!;
    expect(rs("mitigated").status).toBe("mitigating");
    expect(rs("mitigated").residualLikelihood).toBe("low");
    expect(rs("accepted").status).toBe("accepted");
    expect(rs("accepted").vendorId).toBeTruthy();
    expect(rs("closed").status).toBe("closed");
    expect(rs("open bias").status).toBe("open");
    // a vendor-only risk carries no use case, so the graph shows it as inherited
    expect(rs("vendor-only").vendorId).toBeTruthy();
    expect(rs("vendor-only").useCaseId).toBeNull();

    const cards = await db.select().from(modelCards).where(eq(modelCards.intendedUse, `c6 card ${RUN}`));
    expect(cards).toHaveLength(1);
    expect(first.created).toContain("shadow-AI import (1 rows)");
    // positive control: the catalogue is installed, so a provider host MATCHES
    expect(first.notes.some((n) => n.includes("matched 0 rows"))).toBe(false);

    // IDEMPOTENT: nothing new on a second run (the shadow import is evidence
    // and is re-imported by design — deduplication is the importer's job)
    const second = await seedDemoIntake(app, fixtures(), { bootstrapToken: BOOT });
    expect(second.failed, second.failed.join("\n")).toEqual([]);
    expect(second.created.filter((c) => !c.startsWith("shadow-AI"))).toEqual([]);
    expect(second.skipped.length).toBeGreaterThanOrEqual(3 + 5 + 5 + 1);
  }, 120_000);
});
