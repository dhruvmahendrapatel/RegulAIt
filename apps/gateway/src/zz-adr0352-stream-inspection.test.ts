/**
 * ADR-0352 (lane E33 slice 3): incremental streaming inspection, end to end over SSE.
 *
 * The mock's `<<emit-long>>` streams about 2,700 characters of clean prose in 40-char
 * deltas; `<<emit-long-ssn>>` streams the same and then the invalid test SSN. The
 * project PII mode is `block` (an output-phase block policy), so before ADR-0352 the
 * stream was suppressed or buffered. Pinned here:
 *   - buffer (the strict default) is unchanged: no live deltas;
 *   - incremental releases a clean answer in several pieces whose concatenation is the
 *     scanned result, with the tail held until the final scan;
 *   - a finding ends the stream with an explicit `error` event, no released delta ever
 *     contains it, and the spend is still recorded (bill-and-withhold);
 *   - the OpenAI-compatible stream ends with its own error chunk and [DONE];
 *   - the end-to-end latency of both modes, measured (recorded in ADR-0352).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, eq, runMigrations, usageEvents, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxDataPostureForTest, setOrgSettingsForTest } from "./testing/strict-data-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `adr0352-stream-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const SSN = "123-45-6789";

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId = "";
let auth = { authorization: "" };
let agentId = "";
const restore: Array<() => Promise<void>> = [];

const post = (url: string, payload: unknown, headers = AUTH) => app.inject({ method: "POST", url, headers, payload: payload as object });

function sse(body: string): Array<{ event: string; data: unknown }> {
  return body
    .split("\n\n")
    .filter((b) => b.includes("data:"))
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? "message";
      const raw = /^data: (.*)$/m.exec(block)?.[1] ?? "";
      let data: unknown = raw;
      try {
        data = JSON.parse(raw);
      } catch {
        /* [DONE] */
      }
      return { event, data };
    });
}

async function streamInvoke(input: string) {
  const t0 = performance.now();
  const res = await app.inject({
    method: "POST",
    url: `/v1/agents/${agentId}/invoke`,
    headers: { ...auth, "x-regulait-accept-buffered": "1" },
    payload: { mode: "chat", dispatch: true, stream: true, input },
  });
  return { res, ms: performance.now() - t0, events: sse(res.body) };
}

const usage = async () => (await db.select({ id: usageEvents.id }).from(usageEvents).where(eq(usageEvents.userId, userId))).length;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "f".repeat(64) });
  restore.push(await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false }));
  // the org PII floor at block (an output-phase block policy); the cache off so every call dispatches
  restore.push(await relaxDataPostureForTest(db, { org: { defaultPiiMode: "block", semanticCachePolicy: "off" }, interception: false, guardrails: false }));
  const u = await post("/v1/users", { email: `adr0352-stream-${RUN}@example.com`, displayName: "Stream" });
  userId = u.json().id;
  auth = { authorization: `Bearer ${(await post(`/v1/users/${userId}/keys`, { name: "k" })).json().token}` };
  const a = await post("/v1/agents", { name: `adr0352-stream-${RUN}`, provider: "mock", tier: 1, modes: ["chat", "execute"], costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" });
  agentId = a.json().id;
  expect((await post("/v1/grants/agents", { userId, agentId })).statusCode).toBeLessThan(300);
}, 120_000);

afterAll(async () => {
  for (const r of restore.reverse()) await r();
  app.server.closeAllConnections();
  await app.close();
});

const timings: Record<string, number> = {};

describe("ADR-0352 stream inspection: buffer (strict default)", () => {
  it("is the default, and keeps today's behaviour: no live deltas under a block policy", async () => {
    const s = await app.inject({ method: "GET", url: "/v1/org/settings", headers: AUTH });
    expect(s.json().settings.streamOutputInspection).toBe("buffer");
    const { res, ms } = await streamInvoke("<<emit-long>>");
    timings["buffer"] = ms;
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("event: delta");
    expect(res.json().streamingSuppressed).toBe(true);
  });
});

describe("ADR-0352 stream inspection: incremental", () => {
  beforeAll(async () => {
    restore.push(await setOrgSettingsForTest(db, { streamOutputInspection: "incremental" }));
  });

  it("releases a clean answer in several scanned pieces that add up to the result", async () => {
    const { res, ms, events } = await streamInvoke("<<emit-long>>");
    timings["incremental"] = ms;
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const deltas = events.filter((e) => e.event === "delta").map((e) => (e.data as { text: string }).text);
    expect(deltas.length).toBeGreaterThan(1);
    const result = events.find((e) => e.event === "result")?.data as { dispatch: { outputText: string; streamInspection?: { mode: string } } };
    expect(result.dispatch.outputText.length).toBeGreaterThan(2000);
    expect(deltas.join("")).toBe(result.dispatch.outputText);
    expect(result.dispatch.streamInspection?.mode).toBe("incremental");
  });

  it("a finding ends the stream with an explicit error event, and no delta carries it", async () => {
    const before = await usage();
    const { res, events } = await streamInvoke("<<emit-long-ssn>>");
    expect(res.statusCode).toBe(200);
    const deltas = events.filter((e) => e.event === "delta").map((e) => (e.data as { text: string }).text);
    // the clean opening was released before the finding arrived
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.join("")).not.toContain(SSN);
    expect(res.body).not.toContain(SSN);
    const last = events.at(-1)!;
    expect(last.event).toBe("error");
    expect(last.data).toMatchObject({ error: "pii_blocked" });
    expect((last.data as { detail: string }).detail).toMatch(/discard the partial text/);
    expect(events.some((e) => e.event === "result")).toBe(false);
    // bill-and-withhold: the call ran and its spend is recorded
    expect(await usage()).toBe(before + 1);
  });

  it("the OpenAI-compatible stream ends with its own error chunk and [DONE]", async () => {
    // ADR-0020 ships the compat edges off and ADR-0181 requires a project header; both relaxed
    // for this case and restored in afterAll (shared database)
    restore.push(
      await relaxDataPostureForTest(db, {
        org: false,
        interception: { openaiCompatEnabled: true, requireProjectAttribution: false },
        guardrails: false,
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...auth, "x-regulait-agent-id": agentId },
      payload: { model: `adr0352-${RUN}`, stream: true, messages: [{ role: "user", content: "<<emit-long-ssn>>" }] },
    });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(res.body).not.toContain(SSN);
    const chunks = sse(res.body);
    expect(chunks.at(-1)!.data).toBe("[DONE]");
    expect(chunks.at(-2)!.data).toMatchObject({ error: { regulait_code: "pii_blocked" } });
  });

  it("measures end-to-end time for both modes (recorded in ADR-0352)", () => {
    // eslint-disable-next-line no-console
    console.log(`ADR-0352 e2e: buffer ${timings["buffer"]?.toFixed(1)} ms, incremental ${timings["incremental"]?.toFixed(1)} ms`);
    expect(timings["incremental"]).toBeGreaterThan(0);
  });
});
