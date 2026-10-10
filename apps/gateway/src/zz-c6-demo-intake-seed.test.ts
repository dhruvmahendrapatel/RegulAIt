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
import { aiPolicyAcknowledgements, aiPolicyDocuments, aiRisks, aiUseCases, aiVendors, and, createDb, eq, inArray, isNull, modelCards, runMigrations, sql, users, workflowTemplates, type Db } from "@regulait/db";
import { forgetStepUpMethodsForTest } from "./testing/step-up-posture.js";
import type { DemoIntakeFixtures, IntakeAssistRequest } from "@regulait/shared";
import { buildApp } from "./app.js";
import { DEMO_AUP_EVIDENCE, DEMO_AUP_KEY, seedDemoIntake } from "./demo-intake-seed-lib.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

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
  // ADR-0181 (FX2): a data key, so the seeder can enrol the admin persona in
  // TOTP before minting her key (an admin key answers to mfaRequired)
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  const a = await app.inject({
    method: "POST", url: "/v1/agents", headers: { authorization: `Bearer ${BOOT}` },
    payload: { name: AGENT, provider: "mock", tier: 1, modes: ["chat"], model: "mock-balanced" },
  });
  expect(a.statusCode).toBe(201);
}, 120_000);

afterAll(async () => {
  // B4S-06 (M-068): the seeder enrolled Ada's authenticator on this shared
  // database; an admin who can step up would end first-admin setup for later suites
  const ada = await db.select({ id: users.id }).from(users).where(eq(users.email, "admin@regulait.local"));
  await forgetStepUpMethodsForTest(db, ada.map((u) => u.id));
  // ...and the one-time password the seeder issued with that enrolment, so the next
  // seeder on this database enrols her again through the real routes (it never
  // overwrites a password somebody holds)
  for (const u of ada) await db.update(users).set({ passwordHash: null, mustChangePassword: false }).where(eq(users.id, u.id));
  // the seeder routes use-case sign-offs to Avery with an intake VARIANT
  // (ADR-0165); on a shared database that would redirect every later test
  // file's use-case sign-off, so retire it here (M-040 order independence)
  await db
    .update(workflowTemplates)
    .set({ retiredAt: new Date(), retiredReason: "zz-c6 cleanup" })
    .where(and(sql`${workflowTemplates.name} like ${"ai-use-case-intake/governance-owner%"}`, isNull(workflowTemplates.retiredAt)));
  // ADR-0182 A14 (M-068): the seeder publishes an acceptable-use document for EVERYONE; under the strict
  // literacy gate it would refuse every later file's governed calls, so it goes (its acknowledgements cascade)
  await db.delete(aiPolicyDocuments).where(eq(aiPolicyDocuments.key, DEMO_AUP_KEY));
  app.server.closeAllConnections();
  await restoreSb2Gates();
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

    // D4A-03: the seeder holds only API keys, and a person acknowledges only from an interactive session, so the
    // personas are made current by completions the demo tooling RECORDS (and says so), never by an acknowledgement
    // presented as theirs
    const aupAcks = await db
      .select({ method: aiPolicyAcknowledgements.method, evidenceRef: aiPolicyAcknowledgements.evidenceRef, recordedBy: aiPolicyAcknowledgements.recordedBy })
      .from(aiPolicyAcknowledgements)
      .innerJoin(aiPolicyDocuments, eq(aiPolicyDocuments.id, aiPolicyAcknowledgements.documentId))
      .where(eq(aiPolicyDocuments.key, DEMO_AUP_KEY));
    expect(aupAcks.length).toBeGreaterThanOrEqual(3);
    expect(aupAcks.every((a) => a.method === "admin_recorded" && a.evidenceRef === DEMO_AUP_EVIDENCE && a.recordedBy === null)).toBe(true);
    expect(first.failed.filter((f) => f.includes("acceptable-use"))).toEqual([]);

    // IDEMPOTENT: nothing new on a second run (the shadow import is evidence
    // and is re-imported by design — deduplication is the importer's job)
    const second = await seedDemoIntake(app, fixtures(), { bootstrapToken: BOOT });
    expect(second.failed, second.failed.join("\n")).toEqual([]);
    expect(second.created.filter((c) => !c.startsWith("shadow-AI"))).toEqual([]);
    expect(second.skipped.length).toBeGreaterThanOrEqual(3 + 5 + 5 + 1);
  }, 120_000);
});
