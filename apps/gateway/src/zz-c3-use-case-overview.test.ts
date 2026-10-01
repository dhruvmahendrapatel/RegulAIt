/**
 * Demo task C3 — `GET /v1/use-cases/:id/overview`, the use-case 360.
 *
 * Pinned: owner-or-admin visibility (the detail route's rule); the stack lists
 * intended agents with their MRM state and the vendors linked to them; risks
 * carry inherent, residual and linked controls; the summary counts agree with
 * the lists; nothing is written. Scoped to ids this file creates (M-008).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `c3-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let owner = { id: "", auth: { authorization: "" } };
let stranger = { id: "", auth: { authorization: "" } };
let admin = { id: "", auth: { authorization: "" } };

const call = (method: "GET" | "POST" | "PUT", url: string, headers = AUTH, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function makeUser(tag: string, isAdmin = false) {
  const u = await call("POST", "/v1/users", AUTH, { email: `c3-${tag}-${RUN}@example.com`, displayName: tag, isAdmin });
  const id = u.json().id as string;
  return { id, auth: { authorization: `Bearer ${(await call("POST", `/v1/users/${id}/keys`, AUTH, { name: "k" })).json().token}` } };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  expect((await call("POST", "/v1/compliance/packs/seed", AUTH, {})).statusCode).toBe(201);
  owner = await makeUser("owner");
  stranger = await makeUser("stranger");
  // vendors are proposed by a person — the bootstrap token is refused
  admin = await makeUser("admin", true);
}, 120_000);

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
});

describe("the use-case 360", () => {
  it("assembles stack, risks, approvals and audit for the owner — and nobody else", async () => {
    // a provider token unique to this run, so the vendor link is ours alone
    const provider = "mock";
    const agent = await call("POST", "/v1/agents", AUTH, {
      name: `c3-agent-${RUN}`, provider, tier: 1, modes: ["chat"], model: "mock-balanced",
    });
    expect(agent.statusCode).toBe(201);
    const agentId = agent.json().id as string;
    const vendor = await call("POST", "/v1/vendors", admin.auth, {
      name: `c3-vendor-${RUN}`, description: "synthetic vendor", category: "model_provider",
      linkedAgentProviders: [provider],
    });
    expect(vendor.statusCode, vendor.body).toBe(201);
    const vendorId = vendor.json().id as string;

    const uc = await call("POST", "/v1/use-cases", owner.auth, {
      name: `c3-use-case-${RUN}`, description: "synthetic", businessContext: "demo",
      dataSensitivity: "internal", intendedAgentIds: [agentId],
    });
    expect(uc.statusCode, uc.body).toBe(201);
    const useCaseId = (uc.json().useCase?.id ?? uc.json().id) as string;

    const risk = await call("POST", "/v1/risks", owner.auth, {
      title: `c3 risk ${RUN}`, description: "synthetic", category: "hallucination",
      likelihood: "high", impact: "medium", useCaseId,
    });
    expect(risk.statusCode).toBe(201);
    const riskId = risk.json().id as string;
    expect((await call("POST", `/v1/risks/${riskId}/controls`, owner.auth, { controlRef: "eu-ai-act:art-15-accuracy-robustness" })).statusCode).toBe(201);
    expect((await call("PUT", `/v1/risks/${riskId}/residual`, owner.auth, { likelihood: "low", impact: "medium" })).statusCode).toBe(200);
    // a second, unmitigated live risk
    expect((await call("POST", "/v1/risks", owner.auth, {
      title: `c3 risk2 ${RUN}`, description: "synthetic", category: "prompt_injection",
      likelihood: "medium", impact: "medium", useCaseId,
    })).statusCode).toBe(201);

    const r = await call("GET", `/v1/use-cases/${useCaseId}/overview`, owner.auth);
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.useCase.id).toBe(useCaseId);
    expect(b.useCase.ownerName).toBe("owner");
    expect(b.questionnaire.submitted).toBe(false);

    expect(b.stack.agents.map((a: { id: string }) => a.id)).toEqual([agentId]);
    // no model card exists for the agent — the MRM gate would refuse it
    expect(b.stack.agents[0].modelCardApproved).toBe(false);
    expect(b.summary.agentsWithoutApprovedModelCard).toBe(1);
    const v = b.stack.vendors.find((x: { id: string }) => x.id === vendorId);
    expect(v.linkedVia).toContain("agent provider");

    expect(b.risks).toHaveLength(2);
    const mitigated = b.risks.find((x: { id: string }) => x.id === riskId);
    expect(mitigated.dimension).toBe("reliability");
    expect(mitigated.inherent).toEqual({ likelihood: "high", impact: "medium" });
    expect(mitigated.residual).toEqual({ likelihood: "low", impact: "medium" });
    expect(mitigated.controls.map((c: { controlRef: string }) => c.controlRef)).toEqual(["eu-ai-act:art-15-accuracy-robustness"]);
    expect(b.summary.liveRisks).toBe(2);
    expect(b.summary.liveWithoutControls).toBe(1);

    expect(b.audit.length).toBeGreaterThan(0);
    expect(b.links.frameworks).toBe(`/v1/use-cases/${useCaseId}/frameworks`);

    // visibility: the detail route's rule
    expect((await call("GET", `/v1/use-cases/${useCaseId}/overview`, stranger.auth)).statusCode).toBe(403);
    expect((await call("GET", `/v1/use-cases/${useCaseId}/overview`, AUTH)).statusCode).toBe(200); // admin bootstrap
    expect((await call("GET", "/v1/use-cases/00000000-0000-0000-0000-000000000000/overview", owner.auth)).statusCode).toBe(404);
  });
});
