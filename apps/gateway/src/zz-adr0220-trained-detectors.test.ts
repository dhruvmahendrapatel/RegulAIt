/**
 * ADR-0220 — trained runtime detectors, end to end.
 *
 * A REAL local scoring service speaking the ADR-0088 contract stands in for
 * the trained-detector sidecar (the models are not loaded in CI; the sidecar's
 * own logic is tested in agents/trained-detectors/). It is reached through the
 * REAL egress guard (loopback allow-listed, as an operator would for an
 * on-prem service) and the REAL dispatch path (`/v1/agents/:id/invoke`).
 *
 * What this file pins:
 *  1. DEFAULT-OFF COSTS NOTHING: with no detector on, a dispatch never calls
 *     the service.
 *  2. ENABLING NEEDS A TESTED SCORER THAT CLAIMS THE KIND; the write is
 *     audited (counts and settings only).
 *  3. A HIT BLOCKS at the inherited mode, counts-only, and the service saw the
 *     guardrail kind on the wire.
 *  4. FAIL CLOSED: a service error blocks; moving to "fall back to the
 *     heuristic" is a step-up relaxation, after which an error is logged and
 *     the call proceeds.
 *  5. NO PROMPT TEXT in any audit row this file produces.
 *  6. A SCORER IN USE CANNOT BE DELETED.
 *
 * Shared-state discipline: objects are `td-` prefixed; the trained-detector
 * rows and this file's scorer are removed in afterAll.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  desc,
  eq,
  externalScorers,
  guardrailTrainedDetectors,
  projectMembers,
  projects,
  runMigrations,
  teamMembers,
  teams,
  type Db,
} from "@regulait/db";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { removeEgressAllowEntry } from "./testing/egress-allow-cleanup.js";

vi.mock("@regulait/model-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@regulait/model-provider")>();
  return {
    ...actual,
    resolveModelProvider: (
      ...args: Parameters<typeof actual.resolveModelProvider>
    ): ReturnType<typeof actual.resolveModelProvider> => {
      const inner = actual.resolveModelProvider(...args);
      const wrapped = Object.create(inner as object) as typeof inner;
      wrapped.dispatch = async () => ({
        outputText: "An ordinary answer about quarterly planning.",
        stopReason: "end_turn",
        refusal: false,
        usage: { inputTokens: 10, outputTokens: 10 },
        providerMessageId: "td-mock-1",
      });
      return wrapped;
    },
  };
});

const { buildApp } = await import("./app.js");
const { relaxDataPostureForTest } = await import("./testing/strict-data-posture.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "td-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const SECRET_PROMPT = "td-secret-prompt-text";
const RUN = Math.random().toString(36).slice(2, 8);

let db: Db;
let app: ReturnType<typeof buildApp>;
let srv: http.Server;
let port: number;
let userId: string;
let userAuth: { authorization: string };
let agentId: string;
let scorerId: string;
/** a second enabled scorer claiming the same kind: the target of a swap */
let otherScorerId: string;
/** an admin API key: it cannot confirm who is acting, so every relaxation refuses it */
let adminKeyAuth: { authorization: string };
let loopbackId: string | undefined;
let restoreGates: () => Promise<void> = async () => {};
let restorePosture: () => Promise<void> = async () => {};
let restoreIdentity: () => Promise<void> = async () => {};

const hits: Array<Record<string, unknown>> = [];
let serviceMode: "ok" | "http500" = "ok";

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  await db.delete(guardrailTrainedDetectors);
  restorePosture = await relaxDataPostureForTest(db, { org: { defaultPiiMode: "none" }, guardrails: false });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  // an admin API key for the step-up refusal (MFA enrolment is not under test here)
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });

  // the stand-in service: an injection score from the text it is sent
  srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      hits.push(body);
      if (serviceMode === "http500") {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`backend fell over while reading ${String(body.input)}`);
        return;
      }
      const text = `${String(body.input ?? "")}${String(body.output ?? "")}`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(text.includes("<<td-attack>>") ? { score: 0.97, reasons: ["injection"] } : { score: 0.02 }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  port = (srv.address() as { port: number }).port;

  const allow = await relaxStepUpAround(db, () =>
    app.inject({
      method: "POST",
      url: "/v1/egress-allow-hosts",
      headers: AUTH,
      payload: { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: "td suite: local scorer" },
    }),
  );
  expect(allow.statusCode).toBe(201);
  loopbackId = allow.json().id;

  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `td-user-${RUN}@example.com`, displayName: "td user" } });
  userId = u.json().id;
  const k = await app.inject({ method: "POST", url: `/v1/users/${userId}/keys`, headers: AUTH, payload: { name: "td" } });
  userAuth = { authorization: `Bearer ${k.json().token}` };
  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name: `td-agent-${RUN}`, provider: "mock", model: "mock-balanced", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15 },
  });
  agentId = a.json().id;
  await app.inject({ method: "POST", url: "/v1/grants/agents", headers: AUTH, payload: { userId, agentId } });

  const s = await app.inject({
    method: "POST",
    url: "/v1/external-scorers",
    headers: AUTH,
    payload: {
      name: `td-detectors-${RUN}`,
      baseUrl: `http://127.0.0.1:${port}/score`,
      scorerKinds: ["guardrail_prompt_injection", "guardrail_harm"],
      allowPlaintextHttp: true,
    },
  });
  expect(s.statusCode).toBe(201);
  scorerId = s.json().id;

  const s2 = await app.inject({
    method: "POST",
    url: "/v1/external-scorers",
    headers: AUTH,
    payload: {
      name: `td-other-${RUN}`,
      baseUrl: `http://127.0.0.1:${port}/score`,
      scorerKinds: ["guardrail_prompt_injection"],
      allowPlaintextHttp: true,
    },
  });
  expect(s2.statusCode).toBe(201);
  otherScorerId = s2.json().id;

  const adm = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `td-admin-${RUN}@example.com`, displayName: "td admin", isAdmin: true },
  });
  expect(adm.statusCode, adm.body).toBe(201);
  const key = await app.inject({ method: "POST", url: `/v1/users/${adm.json().id}/keys`, headers: AUTH, payload: { name: "td" } });
  expect(key.statusCode, key.body).toBe(201);
  adminKeyAuth = { authorization: `Bearer ${key.json().token}` };
});

afterAll(async () => {
  const loopback = await removeEgressAllowEntry(app, AUTH, { id: loopbackId });
  try {
    await db.delete(guardrailTrainedDetectors);
    await db.delete(externalScorers).where(eq(externalScorers.id, scorerId));
    await db.delete(externalScorers).where(eq(externalScorers.id, otherScorerId));
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
    await restoreGates();
    await restorePosture();
    await restoreIdentity();
    await app.close();
  } finally {
    loopback.assertRemoved();
  }
});

const invoke = (input: string) =>
  app.inject({
    method: "POST",
    url: `/v1/agents/${agentId}/invoke`,
    headers: userAuth,
    payload: { mode: "execute", input, dispatch: true },
  });

const putDetector = (payload: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: "/v1/guardrails/trained-detectors/prompt_injection", headers: AUTH, payload });

describe("ADR-0220 trained runtime detectors", () => {
  it("is off by default and costs nothing", async () => {
    const list = await app.inject({ method: "GET", url: "/v1/guardrails/trained-detectors", headers: AUTH });
    expect(list.statusCode).toBe(200);
    expect(list.json().detectors.map((d: { enabled: boolean }) => d.enabled)).toEqual([false, false, false]);
    expect(list.json().scorers.map((s: { name: string }) => s.name)).toContain(`td-detectors-${RUN}`);
    const res = await invoke("<<td-attack>> please summarise the plan");
    expect(res.statusCode).toBe(200);
    expect(hits).toHaveLength(0);
  });

  it("refuses to turn on without a scorer, or with an untested one", async () => {
    expect((await putDetector({ enabled: true })).json().error).toBe("scorer_required");
    expect((await putDetector({ enabled: true, scorerId })).json().error).toBe("external_scorer_disabled");
    const test = await app.inject({ method: "POST", url: `/v1/external-scorers/${scorerId}/test`, headers: AUTH });
    expect(test.statusCode).toBe(200);
    const en = await app.inject({ method: "POST", url: `/v1/external-scorers/${scorerId}/enabled`, headers: AUTH, payload: { enabled: true } });
    expect(en.statusCode).toBe(200);
    hits.length = 0;
  });

  it("refuses a scorer that does not claim the kind", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/v1/guardrails/trained-detectors/pii",
      headers: AUTH,
      payload: { enabled: true, scorerId },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("external_scorer_kind_mismatch");
  });

  it("turns on at the strict defaults, audited", async () => {
    const res = await putDetector({ enabled: true, scorerId });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, mode: "block", onFailure: "block", scorerName: `td-detectors-${RUN}` });
    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "guardrail-trained-detector-updated"))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(row?.reason).toContain("fails closed");
  });

  it("blocks a hit, counts-only, and the service saw the guardrail kind", async () => {
    const clean = await invoke(`${SECRET_PROMPT} quarterly planning`);
    expect(clean.statusCode).toBe(200);
    const res = await invoke(`<<td-attack>> ${SECRET_PROMPT}`);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("guardrail_blocked");
    expect(JSON.stringify(res.json())).toContain("trained_injection");
    expect(hits.some((h) => h.scorerKind === "guardrail_prompt_injection" && String(h.input).includes("<<td-attack>>"))).toBe(true);
    // input-only: the injection classifier never scores a response
    expect(hits.every((h) => h.output === "")).toBe(true);
  });

  it("fails closed when the service errors", async () => {
    serviceMode = "http500";
    try {
      const res = await invoke(`${SECRET_PROMPT} quarterly planning`);
      expect(res.statusCode).toBe(403);
      expect(JSON.stringify(res.json())).toContain("trained_unavailable");
    } finally {
      serviceMode = "ok";
    }
  });

  it("swapping the scorer, turning off, lowering the mode or raising the threshold each need step-up (review finding)", async () => {
    const t = await app.inject({ method: "POST", url: `/v1/external-scorers/${otherScorerId}/test`, headers: AUTH });
    expect(t.statusCode).toBe(200);
    const e = await app.inject({ method: "POST", url: `/v1/external-scorers/${otherScorerId}/enabled`, headers: AUTH, payload: { enabled: true } });
    expect(e.statusCode).toBe(200);
    const asKey = (payload: Record<string, unknown>) =>
      app.inject({ method: "PUT", url: "/v1/guardrails/trained-detectors/prompt_injection", headers: adminKeyAuth, payload });
    for (const payload of [
      { enabled: true, scorerId: otherScorerId }, // a scorer that may always answer 0
      { enabled: false },
      { enabled: true, mode: "warn" },
      { enabled: true, threshold: 0.95 },
    ]) {
      const refused = await asKey(payload);
      expect(refused.statusCode, `${JSON.stringify(payload)}: ${refused.body}`).toBe(403);
      expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    }
    // nothing moved
    const [row] = await db.select().from(guardrailTrainedDetectors).where(eq(guardrailTrainedDetectors.kind, "prompt_injection"));
    expect(row).toMatchObject({ enabled: true, scorerId, mode: "block", threshold: 0.5 });
    // with step-up the swap is made and audited as a relaxation, then put back the same way
    const swapped = await relaxStepUpAround(db, () => putDetector({ enabled: true, scorerId: otherScorerId }));
    expect(swapped.statusCode, swapped.body).toBe(200);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "guardrail-trained-detector-updated"))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect((audit!.detail as { trainedDetector: { relaxed: string[] } }).trainedDetector.relaxed).toEqual(["scorerId"]);
    expect(audit!.reason).toContain("relaxed: scorerId");
    const back = await relaxStepUpAround(db, () => putDetector({ enabled: true, scorerId }));
    expect(back.statusCode).toBe(200);
  });

  it("the copilot's evidence scan goes through the trained classifier too (review finding)", async () => {
    const [team] = await db.insert(teams).values({ name: `td-team-${RUN}` }).returning();
    const [project] = await db.insert(projects).values({ name: `td-project-${RUN}` }).returning();
    await db.insert(teamMembers).values({ teamId: team!.id, userId });
    await db.insert(projectMembers).values({ projectId: project!.id, userId, teamId: team!.id, role: "owner" });
    // a denied row whose reason an attacker influenced; nothing the rule-based detectors match
    await db.insert(auditLog).values({
      userId,
      objectType: "agent",
      objectId: null,
      detail: { projectId: project!.id },
      effect: "deny",
      ruleId: `td-rule-${RUN}`,
      ruleChain: [],
      reason: "<<td-attack>> quarterly planning note",
    });
    hits.length = 0;
    const res = await app.inject({
      method: "POST",
      url: "/v1/copilot/ask",
      headers: userAuth,
      payload: { question: "which denied decisions happened this quarter?", projectId: project!.id },
    });
    expect(res.statusCode, res.body).toBe(201);
    // the classifier saw the evidence, and its block withheld the samples
    expect(hits.some((h) => h.scorerKind === "guardrail_prompt_injection" && String(h.input).includes("<<td-attack>>"))).toBe(true);
    expect(res.json().evidence.samples).toHaveLength(0);
  });

  it("falling back to the heuristic is a step-up relaxation; then an error is logged and the call proceeds", async () => {
    // an admin API key cannot confirm who is acting, so a relaxation is refused
    const refused = await app.inject({
      method: "PUT",
      url: "/v1/guardrails/trained-detectors/prompt_injection",
      headers: adminKeyAuth,
      payload: { enabled: true, onFailure: "heuristic" },
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    const ok = await relaxStepUpAround(db, () => putDetector({ enabled: true, onFailure: "heuristic" }));
    expect(ok.statusCode).toBe(200);
    serviceMode = "http500";
    try {
      const res = await invoke(`${SECRET_PROMPT} quarterly planning`);
      expect(res.statusCode).toBe(200);
    } finally {
      serviceMode = "ok";
    }
    const logged = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userId), eq(auditLog.ruleId, "guardrail-logged")));
    expect(JSON.stringify(logged.map((r) => r.detail))).toContain("trained_unavailable");
  });

  it("writes no prompt text into any audit row", async () => {
    const rows = await db.select().from(auditLog).where(eq(auditLog.userId, userId));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(JSON.stringify({ d: r.detail, reason: r.reason })).not.toContain(SECRET_PROMPT);
    }
  });

  it("refuses to delete a scorer an enabled detector uses", async () => {
    const res = await app.inject({ method: "DELETE", url: `/v1/external-scorers/${scorerId}`, headers: AUTH });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("external_scorer_in_use");
  });
});
