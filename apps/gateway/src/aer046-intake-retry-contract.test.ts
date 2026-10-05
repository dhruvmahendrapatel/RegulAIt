/**
 * AER-046 — the gateway half of the intake wizard's retry contract.
 *
 * The SPA (apps/web/src/views/admin/governance/intakeCheckpoint.ts) binds each
 * retry checkpoint to the inputs that wrote it, and on a changed input either
 * brings the written record up to date through the gateway's own edit paths or
 * refuses the retry. That split rests on four gateway facts, each proved here
 * by replaying the page's exact retry sequence against the real routes:
 *
 *  1. PATCH /v1/use-cases/:id is REFUSED (409 `locked_under_review`, ADR-0170
 *     §4) once the use case is under_review (after the first questionnaire
 *     submission) and writes nothing — so the page refuses a retry whose
 *     use-case fields changed after that point, before sending anything.
 *  2. A second questionnaire submission is a NEW VERSION: it supersedes the
 *     sign-off that was pending on version 1 and raises exactly one fresh
 *     pending sign-off, and the use-case detail serves the new version.
 *  3. PATCH /v1/risks/:id edits an open risk's description.
 *  4. What the page REFUSES has no honest edit: PATCH /v1/use-cases ignores
 *     name / dataSensitivity / complianceTags (they are not in the update
 *     schema, so a PATCH "succeeds" and changes nothing — exactly the silent
 *     mismatch a retry must not paper over), and PATCH /v1/risks refuses
 *     `category` by name.
 *
 * Shares one DB with the other gateway suites (fileParallelism off);
 * everything here is prefixed a46-.
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

const BOOT = "a46-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let proposerAuth: { authorization: string };

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "9".repeat(64) });
  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: "a46-proposer@example.com", displayName: "a46 proposer" },
  });
  expect(user.statusCode).toBe(201);
  const key = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${user.json().id}/keys`,
    payload: { name: "a46" },
  });
  proposerAuth = { authorization: `Bearer ${key.json().token}` };
});

afterAll(async () => {
  await app.close();
  await db.$client.end();
});

const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: proposerAuth, ...(payload ? { payload } : {}) });

const pendingSignoffs = async (instanceId: string) =>
  ((await call("GET", "/v1/approvals?status=pending")).json().approvals as Array<{ id: string; instanceId: string | null; stageId: string | null }>)
    .filter((a) => a.instanceId === instanceId && a.stageId === "signoff");

describe("AER-046: the retry sequence the intake page sends after an edit leaves one coherent, all-new record", () => {
  it("first attempt (fails after the first risk), then the edited retry: the use case is locked, questionnaire v2, PATCH risk, create the missing risk", async () => {
    // ---- the first attempt, exactly as the page sends it ----
    const created = await call("POST", "/v1/use-cases", {
      name: "a46 credit assistant",
      description: "Recommends limit increases.",
      businessContext: "Recommends limit increases.",
      dataSensitivity: "regulated",
      complianceTags: [],
      intendedAgentIds: [],
    });
    expect(created.statusCode).toBe(201);
    const useCaseId = created.json().id as string;
    const instanceId = created.json().instance.id as string;
    expect((await call("POST", `/v1/workflows/instances/${instanceId}/advance`, { stageId: "plan" })).statusCode).toBe(200);
    const v1 = await call("POST", `/v1/workflows/instances/${instanceId}/artifacts`, {
      stageId: "questionnaire",
      content: "## 1. Purpose\n\nDraft answer 1",
    });
    expect(v1.json()).toMatchObject({ version: 1, status: "blocked_on_approval" });
    const firstSignoff = await pendingSignoffs(instanceId);
    expect(firstSignoff).toHaveLength(1);
    const riskA = await call("POST", "/v1/risks", {
      title: "a46 disparate outcomes",
      description: "Old bias text.",
      category: "bias_fairness",
      likelihood: "medium",
      impact: "high",
      useCaseId,
    });
    expect(riskA.statusCode).toBe(201);
    // (the second risk's POST failed in the browser; nothing was written for it)
    expect((await call("GET", `/v1/use-cases/${useCaseId}`)).json().useCase.status).toBe("under_review");

    // ---- under review, the use case's own fields are locked (ADR-0170 §4) ----
    const patched = await call("PATCH", `/v1/use-cases/${useCaseId}`, {
      description: "Edited: a human decides every increase.",
      businessContext: "Edited: a human decides every increase.",
    });
    expect(patched.statusCode).toBe(409);
    expect(patched.json().error).toBe("locked_under_review");

    // ---- the retry after the proposer edited an answer and both risks ----
    const v2 = await call("POST", `/v1/workflows/instances/${instanceId}/artifacts`, {
      stageId: "questionnaire",
      content: "## 1. Purpose\n\nEdited purpose answer.",
    });
    expect(v2.statusCode).toBe(201);
    expect(v2.json()).toMatchObject({ version: 2, status: "blocked_on_approval" });
    const riskPatched = await call("PATCH", `/v1/risks/${riskA.json().id}`, { description: "Edited bias text." });
    expect(riskPatched.statusCode).toBe(200);
    const riskB = await call("POST", "/v1/risks", {
      title: "a46 prompt injection",
      description: "Edited injection text.",
      category: "prompt_injection",
      likelihood: "medium",
      impact: "medium",
      useCaseId,
    });
    expect(riskB.statusCode).toBe(201);

    // ---- the record is entirely the edited inputs ----
    const detail = (await call("GET", `/v1/use-cases/${useCaseId}`)).json();
    expect(detail.useCase).toMatchObject({
      name: "a46 credit assistant",
      description: "Recommends limit increases.",
      businessContext: "Recommends limit increases.",
      status: "under_review",
    });
    expect(detail.questionnaire).toMatchObject({ version: 2, content: "## 1. Purpose\n\nEdited purpose answer." });
    // the approver can only decide the NEW version: the v1 sign-off was superseded, one fresh one waits
    const nowPending = await pendingSignoffs(instanceId);
    expect(nowPending).toHaveLength(1);
    expect(nowPending[0]!.id).not.toBe(firstSignoff[0]!.id);
    for (const [id, description] of [[riskA.json().id, "Edited bias text."], [riskB.json().id, "Edited injection text."]] as const) {
      const risk = (await call("GET", `/v1/risks/${id}`)).json().risk;
      expect(risk).toMatchObject({ description, useCaseId });
    }
    const listed = (await call("GET", "/v1/use-cases")).json().useCases as Array<{ name: string }>;
    expect(listed.filter((u) => u.name === "a46 credit assistant")).toHaveLength(1);
  });

  it("the edits the page refuses have no honest gateway edit: name/sensitivity/tags are silently not applied, category is refused by name", async () => {
    const created = await call("POST", "/v1/use-cases", {
      name: "a46 fixed fields",
      description: "d",
      businessContext: "d",
      dataSensitivity: "regulated",
      complianceTags: ["eu-ai-act"],
      intendedAgentIds: [],
    });
    expect(created.statusCode).toBe(201);
    const useCaseId = created.json().id as string;
    const attempt = await call("PATCH", `/v1/use-cases/${useCaseId}`, {
      name: "a46 renamed",
      dataSensitivity: "public",
      complianceTags: [],
    });
    // the PATCH reports success but carries none of the three — a retry that
    // relied on it would finish with the OLD name beside the new inputs
    expect(attempt.statusCode).toBe(200);
    expect((await call("GET", `/v1/use-cases/${useCaseId}`)).json().useCase).toMatchObject({
      name: "a46 fixed fields",
      dataSensitivity: "regulated",
      complianceTags: ["eu-ai-act"],
    });

    const risk = await call("POST", "/v1/risks", {
      title: "a46 category",
      description: "d",
      category: "bias_fairness",
      likelihood: "low",
      impact: "low",
      useCaseId,
    });
    expect(risk.statusCode).toBe(201);
    const recategorised = await call("PATCH", `/v1/risks/${risk.json().id}`, { category: "prompt_injection" });
    expect(recategorised.statusCode).toBe(422);
    expect(recategorised.json().error).toBe("category_is_the_evidence_key");
  });
});
