/**
 * ADR-0302 decision 2 — DefenseClaw OTLP/HTTP logs intake. Synthetic exports written from the documented attribute
 * names (no real capture exists, ADR-0261), encoded with the vendored OTLP protos.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditLog, createDb, desc, discoveryPseudonymKeys, eq, runMigrations, thirdPartyIngestRecords, type Db } from "@regulait/db";
import {
  DEFENSECLAW_INGEST_PATH,
  DEFENSECLAW_OTLP_LOGS_PATH,
  OTLP_MAX_DECODED_BYTES,
  OTLP_MAX_STRING_CHARS,
  ThirdPartyBatchRefused,
  otlpLogsRequestToJsonl,
} from "@regulait/shared";
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

describe("ADR-0302 OTLP intake: the decoded batch is bounded (security review of #835)", () => {
  it("a huge resource host.name is not copied into every record: the output stays near the input size", () => {
    const huge = "h".repeat(900_000);
    const req = { resourceLogs: [{ resource: { attributes: [str("host.name", huge)] }, scopeLogs: [{ logRecords: Array.from({ length: 600 }, () => ({})) }] }] };
    const wire = Buffer.byteLength(JSON.stringify(req));
    const out = otlpLogsRequestToJsonl(req);
    expect(out.byteLength).toBeLessThan(wire / 10);
    expect(new TextDecoder().decode(out)).not.toContain("hhhh");
  });

  it("an attribute string past the longest schema string is dropped before it is copied", () => {
    const out = new TextDecoder().decode(otlpLogsRequestToJsonl(request([logRecord("long", { attributes: [str("defenseclaw.guardrail.reason", "r".repeat(OTLP_MAX_STRING_CHARS + 1))] })])));
    expect(JSON.parse(out)).not.toHaveProperty("defenseclaw.guardrail.reason");
    const ok = new TextDecoder().decode(otlpLogsRequestToJsonl(request([logRecord("ok", { attributes: [str("defenseclaw.guardrail.reason", "r".repeat(OTLP_MAX_STRING_CHARS))] })])));
    expect(JSON.parse(ok)["defenseclaw.guardrail.reason"]).toHaveLength(OTLP_MAX_STRING_CHARS);
  });

  it("a batch that would decode past twice the wire limit is refused as batch_too_large", () => {
    const big = "x".repeat(OTLP_MAX_STRING_CHARS);
    const many = Array.from({ length: 512 }, (_, i) => ({ attributes: [str("record_id", `r${i}`), str("defenseclaw.guardrail.reason", big)] }));
    let refused: unknown;
    try {
      otlpLogsRequestToJsonl({ resourceLogs: [{ scopeLogs: [{ logRecords: many }] }] });
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(ThirdPartyBatchRefused);
    expect((refused as ThirdPartyBatchRefused).code).toBe("batch_too_large");
    expect(OTLP_MAX_DECODED_BYTES).toBe(2 * 1024 * 1024);
  });

  it("an attribute named __proto__ is an ordinary key, never a prototype", () => {
    const out = new TextDecoder().decode(
      otlpLogsRequestToJsonl(request([logRecord("proto", { attributes: [{ key: "__proto__", value: { arrayValue: { values: [{ stringValue: "x" }] } } }] })])),
    );
    const line = JSON.parse(out);
    expect(line.record_id).toBe("proto");
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
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
    expect(res.statusCode, res.body).toBe(200);
    expect(await db.select().from(thirdPartyIngestRecords).where(eq(thirdPartyIngestRecords.recordId, rid("deep")))).toHaveLength(1);
  });

  it("nesting past the decoder's recursion limit is refused as invalid_encoding", async () => {
    // protobufjs will not ENCODE this deep, so the wire bytes are written by hand (field numbers from the vendored
    // v1.9.0 protos: AnyValue.array_value = 5, ArrayValue.values = 1, KeyValue.key = 1 / value = 2,
    // LogRecord.attributes = 6, ScopeLogs.log_records = 2, ResourceLogs.scope_logs = 2, request.resource_logs = 1)
    const varint = (n: number) => {
      const out: number[] = [];
      while (n > 0x7f) {
        out.push((n & 0x7f) | 0x80);
        n >>>= 7;
      }
      out.push(n);
      return out;
    };
    const field = (tag: number, body: number[]) => [tag, ...varint(body.length), ...body];
    let any = field(0x0a, [...Buffer.from("leaf")]); // AnyValue{string_value}
    for (let i = 0; i < 80; i += 1) any = field(0x2a, field(0x0a, any)); // AnyValue{array_value{values: any}}
    const kv = [...field(0x0a, [...Buffer.from("x")]), ...field(0x12, any)];
    const wire = Buffer.from(field(0x0a, field(0x12, field(0x12, field(0x32, kv)))));
    const res = await post(DEFENSECLAW_OTLP_LOGS_PATH, wire, "application/x-protobuf");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_encoding");
  });

  it("a compressed body is refused by name (415), never decoded", async () => {
    const res = await app.inject({
      method: "POST",
      url: DEFENSECLAW_OTLP_LOGS_PATH,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-protobuf", "content-encoding": "gzip" },
      payload: protobufBody([logRecord(rid("gz"))]),
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toBe("unsupported_content_encoding");
  });

  it("more than 512 records in one export is refused as too large", async () => {
    const many = Array.from({ length: 513 }, (_, i) => logRecord(rid(`m${i}`)));
    const res = await post(DEFENSECLAW_OTLP_LOGS_PATH, protobufBody(many), "application/x-protobuf");
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe("too_many_records");
  });
});
