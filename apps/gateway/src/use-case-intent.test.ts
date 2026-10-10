/**
 * ADR-0089 amendment (batch B3) — INTENT CAPTURE closes the "no intent
 * recorded" boundary ADR-0089 named. What this file proves end to end:
 *
 *  1. THE CAPTURE HALF EXISTS AND FEEDS THE ONE COLUMN. A use case proposed
 *     with NO intended agents gains them through the ordinary PATCH while
 *     the proposal is in flight — the SAME `intendedAgentIds` column the
 *     ADR-0089 alignment comparison reads; nothing parallel.
 *  2. ALIGNMENT LIGHTS UP FROM A CAPTURED INTENT: propose → capture intent →
 *     approve (through the ONE decide path, never a seeded row) → the
 *     ADR-0082 inventory shows `aligned` for the provisioned agent and
 *     `undershoot` (gap naming this use case) for the unprovisioned one, and
 *     the use-case detail tells the same story from its side.
 *  3. INTENT IS EDITABLE ONLY PRE-DECISION. A post-approval intent PATCH is
 *     refused BY NAME (`intent_is_decided_not_patched` — changing intent
 *     after approval is a NEW use case), distinct from the generic
 *     `use_case_not_editable` other post-decision edits get.
 *
 * Shares one DB with the other gateway suites (fileParallelism off);
 * everything here is prefixed uci-. No singleton is touched (M-012);
 * anything org-wide is a delta (M-008).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "uci-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let priyaId: string;
let priyaAuth: { authorization: string };
let agentProvisioned: string; // granted to the proposing owner → aligned
let agentUnprovisioned: string; // granted to nobody → undershoot
let useCaseId: string;
let instanceId: string;

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    // no "@" in the display name — another suite asserts nothing email-shaped
    // leaks through the names-only directory
    payload: { email, displayName: email.split("@")[0]!.replace(/-/g, " ") },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${u.json().id}/keys`,
    payload: { name: "uci" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function mkAgent(name: string) {
  const r = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name, provider: "mock", tier: 1, model: "mock-balanced", costPerMTokIn: 1, costPerMTokOut: 2 },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

const detailOf = (id: string, auth = priyaAuth) =>
  app.inject({ method: "GET", headers: auth, url: `/v1/use-cases/${id}` });

const patch = (id: string, payload: Record<string, unknown>, auth = priyaAuth) =>
  app.inject({ method: "PATCH", headers: auth, url: `/v1/use-cases/${id}`, payload });

async function inventoryAgent(agentId: string) {
  const res = await app.inject({ method: "GET", headers: AUTH, url: `/v1/inventory/agents/${agentId}` });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    alignment: {
      approvedUseCases: number;
      aligned: boolean;
      overreach: boolean;
      undershoot: boolean;
      gaps: Array<{ useCaseId: string; name: string }>;
    };
  };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "9".repeat(64) });

  const priya = await makeUser("uci-priya@example.com");
  priyaId = priya.id;
  priyaAuth = priya.auth;

  agentProvisioned = await mkAgent("uci-provisioned");
  agentUnprovisioned = await mkAgent("uci-unprovisioned");
  // the proposing owner is a participant (ADR-0089): granting her the first
  // agent is what will make the captured intent read `aligned`
  const g = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/agents",
    payload: { userId: priyaId, agentId: agentProvisioned },
  });
  expect(g.statusCode).toBe(201);
});

afterAll(async () => {
  await app.close();
  await db.$client.end();
});

describe("capture → approve → alignment, end to end on the one column", () => {
  it("proposes with NO intent, captures it via PATCH while in flight, and the detail says 'not approved' until decided", async () => {
    const uc = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: "/v1/use-cases",
      payload: {
        name: "uci-triage-bot",
        description: "triage inbound tickets",
        businessContext: "reduce queue latency",
        dataSensitivity: "internal",
        // deliberately empty: this is exactly the ADR-0089 "no intent
        // recorded" state the capture flow exists to close
        intendedAgentIds: [],
      },
    });
    expect(uc.statusCode).toBe(201);
    useCaseId = uc.json().id;
    instanceId = uc.json().instance.id;

    // THE CAPTURE: the ordinary in-flight edit, feeding intendedAgentIds
    const captured = await patch(useCaseId, {
      intendedAgentIds: [agentProvisioned, agentUnprovisioned],
    });
    expect(captured.statusCode, captured.body).toBe(200);
    expect(captured.json().intendedAgentIds).toEqual([agentProvisioned, agentUnprovisioned]);

    // alignment stands only behind APPROVED intent — captured-but-undecided
    // reads not_approved, never a guessed alignment
    const mid = await detailOf(useCaseId);
    expect(mid.json().intendedVsGranted.status).toBe("not_approved");
  });

  it("an unknown agent id in the capture is refused (invalid_reference), not stored dangling", async () => {
    const res = await patch(useCaseId, {
      intendedAgentIds: ["00000000-0000-4000-8000-0000000000ab"],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_reference", field: "intendedAgentIds" });
  });

  it("approval through the ONE decide path lights the alignment flags from the captured intent", async () => {
    // drive the intake exactly as use-cases.test.ts does
    const left = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: `/v1/workflows/instances/${instanceId}/advance`,
      payload: { stageId: "plan" },
    });
    expect(left.statusCode).toBe(200);
    const art = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "questionnaire", content: "# AI use-case intake questionnaire\n\nuci filled." },
    });
    expect(art.statusCode).toBe(201);
    const q = await app.inject({ method: "GET", headers: priyaAuth, url: "/v1/approvals?status=pending" });
    const signoff = q
      .json()
      .approvals.find(
        (a: { instanceId: string | null; stageId: string | null }) =>
          a.instanceId === instanceId && a.stageId === "signoff",
      );
    expect(signoff).toBeTruthy();
    const approved = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: `/v1/approvals/${signoff.id}/decide`,
      payload: { decision: "approved", reason: "uci-e2e: self-review acknowledged for the test" },
    });
    expect(approved.statusCode).toBe(200);

    // the use-case side: undershoot, with the per-agent split
    const after = await detailOf(useCaseId);
    expect(after.json().useCase.status).toBe("approved");
    const ivg = after.json().intendedVsGranted;
    expect(ivg.status).toBe("undershoot");
    expect(
      ivg.agents.find((a: { agentId: string }) => a.agentId === agentProvisioned)?.grantedToParticipants,
    ).toBe(true);
    expect(
      ivg.agents.find((a: { agentId: string }) => a.agentId === agentUnprovisioned)?.grantedToParticipants,
    ).toBe(false);

    // the inventory side: the captured intent is what the flags stand on
    const provisioned = await inventoryAgent(agentProvisioned);
    expect(provisioned.alignment.approvedUseCases).toBe(1);
    expect(provisioned.alignment.aligned).toBe(true);
    expect(provisioned.alignment.undershoot).toBe(false);

    const unprovisioned = await inventoryAgent(agentUnprovisioned);
    expect(unprovisioned.alignment.approvedUseCases).toBe(1);
    expect(unprovisioned.alignment.undershoot).toBe(true);
    expect(unprovisioned.alignment.aligned).toBe(false);
    expect(unprovisioned.alignment.gaps).toEqual([
      expect.objectContaining({ useCaseId, name: "uci-triage-bot" }),
    ]);
  });
});

describe("the edit boundary — intent is decided with the use case", () => {
  it("a post-approval intent PATCH is refused BY NAME: changing intent after approval is a NEW use case", async () => {
    const res = await patch(useCaseId, { intendedAgentIds: [agentUnprovisioned] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("intent_is_decided_not_patched");
    expect(res.json().detail).toContain("NEW use case");

    // control: the stored intent did not move
    const after = await detailOf(useCaseId);
    expect(after.json().useCase.intendedAgentIds).toEqual([agentProvisioned, agentUnprovisioned]);
  });

  it("other post-approval edits still get the GENERIC refusal — the named one is intent-specific", async () => {
    const res = await patch(useCaseId, { description: "rewrite history" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("use_case_not_editable");
  });
});
