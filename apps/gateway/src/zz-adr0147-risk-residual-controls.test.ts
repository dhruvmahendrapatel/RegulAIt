/**
 * ADR-0147 — risk categories for the bias and safety dimensions, the DECLARED
 * residual position, and mitigating-control links.
 *
 * What each test pins, and the failure it would catch:
 *  - the two new categories are storable (migration 0123 replaced the CHECK)
 *    and carry evidence that is labelled for what it is — a documented
 *    fairness assessment is configuration evidence, never "measured";
 *  - residual is both-or-neither, owner-or-admin, and refused on a decided
 *    (accepted/closed) risk — the same rule PATCH already applies;
 *  - a control link must name a ref a pack actually defines, is idempotent
 *    (409, not a duplicate row), is audited, and can be removed;
 *  - list/detail carry the links, so the UI never has to join by hand.
 *
 * Writes risks, packs and audit rows, so `zz-` (M-018); scoped to ids made
 * here (M-008).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiRiskControls, auditLog, and, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `adr0147-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const CONTROL = "eu-ai-act:art-14-human-oversight";

let db: Db;
let app: ReturnType<typeof buildApp>;
let owner = { id: "", auth: { authorization: "" } };
let stranger = { id: "", auth: { authorization: "" } };

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, headers = AUTH, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function makeUser(tag: string) {
  const u = await call("POST", "/v1/users", AUTH, { email: `adr0147-${tag}-${RUN}@example.com`, displayName: tag });
  expect(u.statusCode).toBe(201);
  const id = u.json().id as string;
  const k = await call("POST", `/v1/users/${id}/keys`, AUTH, { name: "k" });
  return { id, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function register(category: string, extra: Record<string, unknown> = {}) {
  const r = await call("POST", "/v1/risks", owner.auth, {
    title: `adr0147 ${category} ${RUN}`,
    description: "synthetic risk for ADR-0147",
    category,
    likelihood: "high",
    impact: "high",
    ...extra,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  // idempotent: creates the catalogue the first time, skips it after
  expect((await call("POST", "/v1/compliance/packs/seed", AUTH, {})).statusCode).toBe(201);
  owner = await makeUser("owner");
  stranger = await makeUser("stranger");
}, 120_000);

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
});

describe("the bias and safety categories", () => {
  it("are storable and evidenced honestly", async () => {
    const bias = await register("bias_fairness");
    const detail = await call("GET", `/v1/risks/${bias}`, owner.auth);
    expect(detail.statusCode).toBe(200);
    const entry = detail.json().evidence.entries[0];
    expect(entry.resolver).toBe("model_card_fairness");
    // a documented assessment is an attestation — never reported as measured
    expect(entry.kind).toBe("configuration");
    expect(entry.queried).toContain("does not compute disparity metrics");

    const unsafe = await register("unsafe_output");
    const u = await call("GET", `/v1/risks/${unsafe}`, owner.auth);
    expect(u.json().evidence.entries.map((e: { resolver: string }) => e.resolver)).toEqual([
      "output_safety_config",
      "guardrail_blocks",
    ]);
    // the list filter accepts the new category (it used to be a hand-copied enum)
    const listed = await call("GET", "/v1/risks?category=unsafe_output", owner.auth);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().risks.map((r: { id: string }) => r.id)).toContain(unsafe);
  });
});

describe("the residual position", () => {
  it("is set and cleared as a pair, audited, and shown beside the inherent one", async () => {
    const id = await register("prompt_injection");
    const set = await call("PUT", `/v1/risks/${id}/residual`, owner.auth, { likelihood: "low", impact: "medium" });
    expect(set.statusCode, set.body).toBe(200);
    const detail = await call("GET", `/v1/risks/${id}`, owner.auth);
    expect(detail.json().declared.residual).toEqual({ likelihood: "low", impact: "medium" });
    expect(detail.json().declared.likelihood).toBe("high"); // inherent untouched

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, id), eq(auditLog.ruleId, "risk-residual-set")));
    expect(audits).toHaveLength(1);

    const half = await call("PUT", `/v1/risks/${id}/residual`, owner.auth, { likelihood: "low", impact: null });
    expect(half.statusCode).toBe(400);

    const cleared = await call("PUT", `/v1/risks/${id}/residual`, owner.auth, { likelihood: null, impact: null });
    expect(cleared.statusCode).toBe(200);
    expect((await call("GET", `/v1/risks/${id}`, owner.auth)).json().declared.residual).toBeNull();
  });

  it("refuses a stranger, and refuses a decided risk", async () => {
    const id = await register("hallucination");
    const denied = await call("PUT", `/v1/risks/${id}/residual`, stranger.auth, { likelihood: "low", impact: "low" });
    expect(denied.statusCode).toBe(403);
    // POSITIVE CONTROL for the refusal below: the owner CAN set it while live
    expect((await call("PUT", `/v1/risks/${id}/residual`, owner.auth, { likelihood: "low", impact: "low" })).statusCode).toBe(200);
    expect((await call("POST", `/v1/risks/${id}/transition`, owner.auth, { status: "closed", reason: "done" })).statusCode).toBe(200);
    const late = await call("PUT", `/v1/risks/${id}/residual`, owner.auth, { likelihood: "high", impact: "high" });
    expect(late.statusCode).toBe(409);
  });
});

describe("mitigating-control links", () => {
  it("links a real pack control, refuses a duplicate and an invented ref, shows it, and unlinks it", async () => {
    const id = await register("data_leakage_pii");
    const linked = await call("POST", `/v1/risks/${id}/controls`, owner.auth, { controlRef: CONTROL });
    expect(linked.statusCode, linked.body).toBe(201);
    expect(linked.json().title).toBeTruthy();

    expect((await call("POST", `/v1/risks/${id}/controls`, owner.auth, { controlRef: CONTROL })).statusCode).toBe(409);
    const invented = await call("POST", `/v1/risks/${id}/controls`, owner.auth, { controlRef: `made-up:${RUN}` });
    expect(invented.statusCode).toBe(422);
    expect(invented.json().error).toBe("unknown_control_ref");

    const detail = await call("GET", `/v1/risks/${id}`, owner.auth);
    expect(detail.json().risk.controls.map((c: { controlRef: string }) => c.controlRef)).toEqual([CONTROL]);
    const list = await call("GET", `/v1/risks?useCaseId=00000000-0000-0000-0000-000000000000`, owner.auth);
    expect(list.json().risks).toHaveLength(0); // the new filter narrows

    const stranger403 = await call("DELETE", `/v1/risks/${id}/controls/${encodeURIComponent(CONTROL)}`, stranger.auth);
    expect(stranger403.statusCode).toBe(403);
    const unlinked = await call("DELETE", `/v1/risks/${id}/controls/${encodeURIComponent(CONTROL)}`, owner.auth);
    expect(unlinked.statusCode).toBe(204);
    expect(await db.select().from(aiRiskControls).where(eq(aiRiskControls.riskId, id))).toHaveLength(0);
    expect((await call("DELETE", `/v1/risks/${id}/controls/${encodeURIComponent(CONTROL)}`, owner.auth)).statusCode).toBe(404);

    const trail = await db.select({ ruleId: auditLog.ruleId }).from(auditLog).where(eq(auditLog.objectId, id));
    expect(trail.map((t) => t.ruleId)).toEqual(expect.arrayContaining(["risk-control-linked", "risk-control-unlinked"]));
  });
});
