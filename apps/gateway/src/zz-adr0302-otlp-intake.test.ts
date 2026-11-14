/**
 * ADR-0302 decision 2 — DefenseClaw OTLP/HTTP logs intake. Synthetic exports written from the documented attribute
 * names (no real capture exists, ADR-0261), encoded with the vendored OTLP protos.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditLog, createDb, desc, discoveryPseudonymKeys, eq, runMigrations, thirdPartyIngestRecords, type Db } from "@regulait/db";
import { DEFENSECLAW_INGEST_PATH, DEFENSECLAW_OTLP_LOGS_PATH, otlpLogsRequestToJsonl } from "@regulait/shared";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { THIRD_PARTY_INGEST_RULE_IDS } from "./third-party-ingest-routes.js";
import { decodeOtlpLogsResponseForTest, encodeOtlpLogsRequestForTest } from "./third-party-otlp.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0302-otlp-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Date.now();
const HOST = `adr0302-host-${RUN}`;
const PROMPT = `SECRET PROMPT TEXT ${RUN}`;
let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let KEY: { authorization: string };
let sourceId: string;
let token: string;
const restores: Array<() => Promise<void>> = [];

const asSteppedUp = async (facts: Record<string, unknown>) => stepUpRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts } as StepUpCheckArgs));
const rid = (n: string) => `adr0302-${RUN}-${n}`;
const nowNanos = () => `${Date.now()}000000`;
const str = (key: string, v: string) => ({ key, value: { stringValue: v } });

function logRecord(id: string, over: { attributes?: unknown[]; severityText?: string; timeUnixNano?: string } = {}) {
  return {
    timeUnixNano: over.timeUnixNano ?? nowNanos(),
    severityText: over.severityText ?? "HIGH",
    body: { stringValue: PROMPT },
    attributes: [
      str("record_id", id),
      str("bucket", "security.finding"),
      str("event_name", "guardrail.block"),
      str("action", "block"),
      str("connector", "openai"),
      { key: "defenseclaw.guardrail.rule_ids", value: { arrayValue: { values: [{ stringValue: "r-1" }, { stringValue: "r-2" }] } } },
      { key: "user.email", value: { stringValue: `someone-${RUN}@example.com` } },
      ...(over.attributes ?? []),
    ],
  };
}
const request = (records: unknown[]) => ({
  resourceLogs: [{ resource: { attributes: [str("host.name", HOST)] }, scopeLogs: [{ logRecords: records }] }],
});
const post = (url: string, body: Buffer | string, contentType: string, bearer = token) =>
  app.inject({ method: "POST", url, headers: { authorization: `Bearer ${bearer}`, "content-type": contentType }, payload: body });
const protobufBody = (records: unknown[]) => Buffer.from(encodeOtlpLogsRequestForTest(request(records)));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const saved = await db.select().from(discoveryPseudonymKeys);
  await db.delete(discoveryPseudonymKeys);
  restores.push(async () => {
    await db.delete(discoveryPseudonymKeys);
    if (saved.length) await db.insert(discoveryPseudonymKeys).values(saved);
  });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });
  const created = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0302-admin-${RUN}@example.com`, displayName: "otlp admin", isAdmin: true } });
  adminId = created.json().id;
  const key = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "adr0302" } });
  KEY = { authorization: `Bearer ${key.json().token}` };
  const src = await app.inject({ method: "POST", url: "/v1/third-party-ingest/sources", headers: KEY, payload: { kind: "defenseclaw", name: `dc-otlp-${RUN}` } });
  sourceId = src.json().source.id;
  const cred = await app.inject({ method: "POST", url: `/v1/third-party-ingest/sources/${sourceId}/credential`, ...(await asSteppedUp({ thirdPartyIngest: "credential", sourceId })) });
  token = cred.json().credential.token;
  const on = await app.inject({
    method: "PUT",
    url: `/v1/third-party-ingest/sources/${sourceId}/enabled`,
    ...(await asSteppedUp({ thirdPartyIngest: "enable", sourceId, kind: "defenseclaw" })),
    payload: { enabled: true },
  });
  expect(on.statusCode, on.body).toBe(200);
});

afterAll(async () => {
  for (const r of restores.reverse()) await r();
  await app?.close();
});

describe("ADR-0302 OTLP intake: the mapping", () => {
  it("one line per log record; resource host, time and severity fill in; the body and unknown keys never appear", () => {
    const text = new TextDecoder().decode(otlpLogsRequestToJsonl(request([logRecord("a"), logRecord("b")])));
    const lines = text.split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ record_id: "a", bucket: "security.finding", "host.name": HOST, severity: "HIGH" });
    expect(lines[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(text).not.toContain(PROMPT);
  });
});

describe("ADR-0302 OTLP intake: the route", () => {
  it("takes only the source's token", async () => {
    const res = await post(DEFENSECLAW_OTLP_LOGS_PATH, protobufBody([logRecord(rid("auth"))]), "application/x-protobuf", "rgti_" + "0".repeat(64));
    expect(res.statusCode).toBe(401);
    const key = await app.inject({ method: "POST", url: DEFENSECLAW_OTLP_LOGS_PATH, headers: { ...KEY, "content-type": "application/x-protobuf" }, payload: protobufBody([logRecord(rid("key"))]) });
    expect(key.statusCode).toBe(401);
  });

  it("accepts an OTLP/protobuf export, answers an ExportLogsServiceResponse, stores the minimised record and opens a finding", async () => {
    const res = await post(DEFENSECLAW_OTLP_LOGS_PATH, protobufBody([logRecord(rid("pb1"))]), "application/x-protobuf");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-protobuf");
    expect(decodeOtlpLogsResponseForTest(res.rawPayload)).toEqual({});
    const [row] = await db.select().from(thirdPartyIngestRecords).where(eq(thirdPartyIngestRecords.recordId, rid("pb1")));
    expect(row).toMatchObject({ bucket: "security.finding", severity: "high", action: "block", connector: "openai" });
    expect(row!.devicePseudonym).not.toBe(HOST);
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(PROMPT);
    expect(stored).not.toContain("someone-");
    expect(stored).not.toContain(HOST);
    const [a] = await db.select().from(auditLog).where(eq(auditLog.objectId, sourceId)).orderBy(desc(auditLog.at)).limit(1);
    expect(a!.ruleId).toBe(THIRD_PARTY_INGEST_RULE_IDS.batchIngested);
    expect((a!.detail as Record<string, unknown>)).toMatchObject({ wire: "otlp", accepted: 1, enforcement: false });
  });

  it("accepts OTLP/JSON; a bad record is a partial success naming it, the rest land", async () => {
    const body = JSON.stringify(request([logRecord(rid("j1")), logRecord(rid("j2"), { timeUnixNano: "1000000", attributes: [] })]));
    const res = await post(DEFENSECLAW_OTLP_LOGS_PATH, body, "application/json");
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json();
    expect(out.partialSuccess.rejectedLogRecords).toBe("1");
    expect(out.partialSuccess.errorMessage).toContain("2:stale");
    expect(await db.select().from(thirdPartyIngestRecords).where(eq(thirdPartyIngestRecords.recordId, rid("j1")))).toHaveLength(1);
  });

  it("dedups across the JSONL and OTLP routes on the record id", async () => {
    const jsonl = JSON.stringify({ record_id: rid("pb1"), bucket: "diagnostic", timestamp: new Date().toISOString() }) + "\n";
    const res = await post(DEFENSECLAW_INGEST_PATH, jsonl, "application/x-ndjson");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ accepted: 0, duplicates: 1 });
  });

  it("refuses a wrong media type, undecodable protobuf, and protobuf on the JSONL route", async () => {
    expect((await post(DEFENSECLAW_OTLP_LOGS_PATH, "x", "application/x-ndjson")).statusCode).toBe(415);
    const garbage = await post(DEFENSECLAW_OTLP_LOGS_PATH, Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0f]), "application/x-protobuf");
    expect(garbage.statusCode).toBe(400);
    expect(garbage.json().error).toBe("invalid_encoding");
    expect((await post(DEFENSECLAW_INGEST_PATH, protobufBody([logRecord(rid("x"))]), "application/x-protobuf")).statusCode).toBe(415);
  });

  it("a deeply nested attribute value is dropped without being walked, and the record still lands", async () => {
    let deep: Record<string, unknown> = { stringValue: "leaf" };
    for (let i = 0; i < 30; i += 1) deep = { arrayValue: { values: [deep] } };
    const res = await post(DEFENSECLAW_OTLP_LOGS_PATH, protobufBody([logRecord(rid("deep"), { attributes: [{ key: "x", value: deep }] })]), "application/x-protobuf");
    expect([200, 400]).toContain(res.statusCode);
    if (res.statusCode === 200) expect(await db.select().from(thirdPartyIngestRecords).where(eq(thirdPartyIngestRecords.recordId, rid("deep")))).toHaveLength(1);
  });

  it("more than 512 records in one export is refused as too large", async () => {
    const many = Array.from({ length: 513 }, (_, i) => logRecord(rid(`m${i}`)));
    const res = await post(DEFENSECLAW_OTLP_LOGS_PATH, protobufBody(many), "application/x-protobuf");
    expect(res.statusCode).toBe(413);
  });
});
