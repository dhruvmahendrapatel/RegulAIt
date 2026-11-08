/**
 * ADR-0261 (backlog P37): the DefenseClaw HTTP JSONL ingest adapter, end to end on a real database.
 *
 * Fixtures are SYNTHETIC, written from DefenseClaw's public docs (bucket names, documented attribute keys); no
 * DefenseClaw output or code is used. What this proves:
 *  - a source is off by default; enabling it and issuing its credential are step-ups, both audited;
 *  - the ingest route takes only the source's own `rgti_` token, refuses a disabled source, a foreign token and an
 *    admin API key, and caps the body;
 *  - accepted records are append-only, deduplicated on record id (a replayed batch adds nothing), and stale or
 *    future records are refused by the window;
 *  - identity and content never reach storage; the host name becomes the device pseudonym;
 *  - a risky record opens a `defenseclaw/<connector>` finding linked to its record, and the batch's audit row says
 *    `attribution: third_party, enforcement: false`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditLog,
  createDb,
  desc,
  discoveryPseudonymKeys,
  eq,
  runMigrations,
  shadowAiFindings,
  sql,
  thirdPartyIngestRecordFindings,
  thirdPartyIngestRecords,
  type Db,
} from "@regulait/db";
import { DEFENSECLAW_INGEST_PATH } from "@regulait/shared";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { THIRD_PARTY_INGEST_RULE_IDS } from "./third-party-ingest-routes.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0261-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Date.now();
const HOST = `adr0261-host-${RUN}`;
let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let KEY: { authorization: string };
let sourceId: string;
let token: string;
const restores: Array<() => Promise<void>> = [];

const asSession = async () => sessionRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts: { unrelated: true } }));
const asSteppedUp = async (facts: Record<string, unknown>) => stepUpRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts } as StepUpCheckArgs));
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const ingest = (body: string, bearer = token, contentType = "application/x-ndjson") =>
  app.inject({ method: "POST", url: DEFENSECLAW_INGEST_PATH, headers: { authorization: `Bearer ${bearer}`, "content-type": contentType }, payload: body });
const rid = (n: string) => `adr0261-${RUN}-${n}`;
const nowIso = () => new Date().toISOString();

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  // the pseudonym key is one row enveloped under the data key: set aside another file's, put it back after
  const saved = await db.select().from(discoveryPseudonymKeys);
  await db.delete(discoveryPseudonymKeys);
  restores.push(async () => {
    await db.delete(discoveryPseudonymKeys);
    if (saved.length) await db.insert(discoveryPseudonymKeys).values(saved);
  });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });
  const created = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0261-admin-${RUN}@example.com`, displayName: "ingest admin", isAdmin: true } });
  expect(created.statusCode, created.body).toBe(201);
  adminId = created.json().id;
  const key = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "adr0261" } });
  KEY = { authorization: `Bearer ${key.json().token}` };
});

afterAll(async () => {
  for (const r of restores.reverse()) await r();
  await app?.close();
});

describe("ADR-0261 source lifecycle", () => {
  it("a new source is off, and has no credential", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/third-party-ingest/sources", headers: KEY, payload: { kind: "defenseclaw", name: `dc-${RUN}` } });
    expect(res.statusCode, res.body).toBe(201);
    const s = res.json().source;
    expect(s).toMatchObject({ kind: "defenseclaw", enabled: false, credential: null, schemaFamily: "v8", attribution: "third_party" });
    sourceId = s.id;
    const dupe = await app.inject({ method: "POST", url: "/v1/third-party-ingest/sources", headers: KEY, payload: { kind: "defenseclaw", name: `DC-${RUN}` } });
    expect(dupe.statusCode).toBe(409);
    const bad = await app.inject({ method: "POST", url: "/v1/third-party-ingest/sources", headers: KEY, payload: { kind: "splunk", name: "x" } });
    expect(bad.statusCode).toBe(400);
  });

  it("issuing the credential needs a step-up bound to the source, and the secret is shown once", async () => {
    const refused = await app.inject({ method: "POST", url: `/v1/third-party-ingest/sources/${sourceId}/credential`, ...(await asSession()) });
    // 403 when the admin has a method to step up with, 422 when none is enrolled yet
    expect([403, 422], refused.body).toContain(refused.statusCode);
    expect(refused.json().error).toMatch(/^step_up_/);
    const res = await app.inject({ method: "POST", url: `/v1/third-party-ingest/sources/${sourceId}/credential`, ...(await asSteppedUp({ thirdPartyIngest: "credential", sourceId })) });
    expect(res.statusCode, res.body).toBe(201);
    token = res.json().credential.token;
    expect(token).toMatch(/^rgti_[0-9a-f]{64}$/);
    const list = await app.inject({ method: "GET", url: "/v1/third-party-ingest/sources", headers: KEY });
    expect(list.body).not.toContain(token);
  });

  it("a disabled source's records are refused, and audited", async () => {
    const res = await ingest(jsonl([{ record_id: rid("off"), bucket: "diagnostic", timestamp: nowIso() }]));
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("source_disabled");
  });

  it("enabling needs a step-up bound to the source and kind, and is audited as a relaxation", async () => {
    const refused = await app.inject({ method: "PUT", url: `/v1/third-party-ingest/sources/${sourceId}/enabled`, ...(await asSession()), payload: { enabled: true } });
    // 403 when the admin has a method to step up with, 422 when none is enrolled yet
    expect([403, 422], refused.body).toContain(refused.statusCode);
    expect(refused.json().error).toMatch(/^step_up_/);
    const res = await app.inject({
      method: "PUT",
      url: `/v1/third-party-ingest/sources/${sourceId}/enabled`,
      ...(await asSteppedUp({ thirdPartyIngest: "enable", sourceId, kind: "defenseclaw" })),
      payload: { enabled: true },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().source.enabled).toBe(true);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.objectId, sourceId)).orderBy(desc(auditLog.at)).limit(1);
    expect(row!.ruleId).toBe(THIRD_PARTY_INGEST_RULE_IDS.sourceEnabled);
    expect((row!.detail as Record<string, unknown>).relaxation).toBe(true);
  });
});

describe("ADR-0261 the ingest route", () => {
  it("takes only the source's own token: no token, a wrong token and an admin API key are all 401", async () => {
    const body = jsonl([{ record_id: rid("auth"), bucket: "diagnostic", timestamp: nowIso() }]);
    expect((await app.inject({ method: "POST", url: DEFENSECLAW_INGEST_PATH, headers: { "content-type": "application/x-ndjson" }, payload: body })).statusCode).toBe(401);
    expect((await ingest(body, "rgti_" + "0".repeat(64))).statusCode).toBe(401);
    const asAdminKey = await app.inject({ method: "POST", url: DEFENSECLAW_INGEST_PATH, headers: { ...KEY, "content-type": "application/x-ndjson" }, payload: body });
    expect(asAdminKey.statusCode).toBe(401);
  });

  it("the source token reaches nothing else", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/third-party-ingest/sources", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });

  it("refuses an oversized body and an unsupported media type", async () => {
    const big = "x".repeat(1024 * 1024 + 1);
    expect((await ingest(big)).statusCode).toBe(413);
    expect((await ingest("{}", token, "application/xml")).statusCode).toBe(415);
  });

  it("accepts a batch: scrubbed evidence, device pseudonym, a defenseclaw/ finding and a third-party audit row", async () => {
    const body = jsonl([
      {
        record_id: rid("block"),
        bucket: "enforcement.action",
        timestamp: nowIso(),
        schema_family: "v8",
        event_name: "hook.decision",
        severity: "HIGH",
        action: "block",
        connector: "claude-code",
        "host.name": HOST,
        "user.id": "501",
        "defenseclaw.user.email": "jane@example.com",
        prompt: "SECRET PROMPT TEXT",
        rule_ids: ["CMD-RM-RF"],
      },
      { record_id: rid("model-io"), bucket: "model.io", timestamp: nowIso(), connector: "claude-code", "host.name": HOST, response: "SECRET RESPONSE" },
      { record_id: rid("stale"), bucket: "diagnostic", timestamp: new Date(Date.now() - 3600_000).toISOString() },
      { record_id: rid("future"), bucket: "diagnostic", timestamp: new Date(Date.now() + 3600_000).toISOString() },
    ]) + "not json\n";
    const res = await ingest(body);
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json();
    expect(out).toMatchObject({ accepted: 2, duplicates: 0, findingsCreated: 1, attribution: "third_party" });
    expect(out.rejected.map((r: { code: string }) => r.code).sort()).toEqual(["future", "invalid_json", "stale"]);

    const stored = await db.select().from(thirdPartyIngestRecords).where(eq(thirdPartyIngestRecords.sourceId, sourceId));
    expect(stored).toHaveLength(2);
    const dump = JSON.stringify(stored);
    for (const leaked of [HOST, "jane@example.com", "SECRET PROMPT TEXT", "SECRET RESPONSE"]) expect(dump).not.toContain(leaked);
    const block = stored.find((r) => r.recordId === rid("block"))!;
    expect(block.devicePseudonym).toMatch(/^psn:/);
    expect(block.action).toBe("block");

    const [finding] = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, block.devicePseudonym!));
    expect(finding).toMatchObject({ subjectKind: "device", provider: "defenseclaw/claude-code", severity: "high", disposition: "open" });
    expect(finding!.signalSources).toEqual(["defenseclaw_export"]);
    const links = await db.select().from(thirdPartyIngestRecordFindings).where(eq(thirdPartyIngestRecordFindings.findingId, finding!.id));
    expect(links.map((l) => l.recordId)).toEqual([block.id]);

    const [batch] = await db.select().from(auditLog).where(eq(auditLog.id, block.auditLogId));
    expect(batch!.ruleId).toBe(THIRD_PARTY_INGEST_RULE_IDS.batchIngested);
    expect(batch!.detail).toMatchObject({ attribution: "third_party", product: "defenseclaw", enforcement: false, accepted: 2 });
  });

  it("a replayed batch adds nothing (dedup on record id)", async () => {
    const body = jsonl([{ record_id: rid("block"), bucket: "enforcement.action", timestamp: nowIso(), severity: "HIGH", action: "block", connector: "claude-code", "host.name": HOST }]);
    const res = await ingest(body);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: 0, duplicates: 1, findingsCreated: 0, findingsUpdated: 0 });
    const n = ((await db.execute(sql`select count(*)::int as n from third_party_ingest_records where source_id = ${sourceId}`)).rows as Array<{ n: number }>)[0]!.n;
    expect(n).toBe(2);
  });

  it("the evidence is append-only: UPDATE, DELETE and TRUNCATE are refused", async () => {
    const refusal = async (q: ReturnType<typeof sql>) => {
      try {
        await db.execute(q);
        return "ran";
      } catch (e) {
        const err = e as { message?: string; cause?: { message?: string } };
        return err.cause?.message ?? err.message ?? "";
      }
    };
    expect(await refusal(sql`update third_party_ingest_records set action = 'allow' where source_id = ${sourceId}`)).toMatch(/append-only/);
    expect(await refusal(sql`delete from third_party_ingest_records where source_id = ${sourceId}`)).toMatch(/append-only/);
    expect(await refusal(sql`truncate third_party_ingest_records cascade`)).toMatch(/TRUNCATE refused/);
  });

  it("the admin evidence view marks every record third-party and links its finding", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/third-party-ingest/sources/${sourceId}/records?limit=10`, headers: KEY });
    expect(res.statusCode).toBe(200);
    const recs = res.json().records as Array<Record<string, unknown>>;
    expect(recs).toHaveLength(2);
    for (const r of recs) expect(r).toMatchObject({ attribution: "third_party", enforcedByRegulAIt: false });
    expect(recs.find((r) => r.recordId === rid("block"))!.findingIds).toHaveLength(1);
  });

  it("a revoked credential is refused, and disabling needs no step-up", async () => {
    const rev = await app.inject({ method: "POST", url: `/v1/third-party-ingest/sources/${sourceId}/credential/revoke`, headers: KEY });
    expect(rev.statusCode).toBe(200);
    expect(rev.json().source.credential).toBeNull();
    expect((await ingest(jsonl([{ record_id: rid("after"), bucket: "diagnostic", timestamp: nowIso() }]))).statusCode).toBe(401);
    const off = await app.inject({ method: "PUT", url: `/v1/third-party-ingest/sources/${sourceId}/enabled`, headers: KEY, payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    expect(off.json().source.enabled).toBe(false);
  });
});
