/**
 * ADR-0167 (SEC-06) — the OTLP collector headers are a credential and live in
 * the REGULAIT_DATA_KEY envelope.
 *
 * Before migration 0128 `org_settings.tracing_otlp_headers` held the headers
 * the gateway sends to a trace collector — conventionally a Honeycomb /
 * Grafana / Datadog API key — as PLAINTEXT jsonb: readable from any pg_dump,
 * outside the custody probe and the rotation walk, and copied VERBATIM into
 * the hash-chained audit row every settings update writes.
 *
 * What this file proves:
 *   1. A settings write stores the values enveloped: the jsonb column keeps
 *      the header names and the `[redacted]` marker, the envelope decrypts to
 *      the real map, the read is redacted, and the audit row carries no value.
 *   2. The export path reads the REAL headers back out of the envelope, and
 *      refuses honestly when the process does not hold the key.
 *   3. A pre-0128 plaintext row is enveloped by the boot-time backfill, once.
 *   4. Without a data key the write is REFUSED, never stored in the clear.
 *
 * `org_settings` is a singleton every suite shares; its two header columns
 * are snapshotted and restored.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORG_SETTINGS_ID, auditLog, createDb, desc, eq, orgSettings, runMigrations, sql, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import {
  OTLP_HEADER_MARKER,
  backfillOtlpHeaderCiphertext,
  otlpHeadersForExport,
} from "./org-settings.js";
import { decryptSecret } from "./secrets.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "otlp-custody-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);
const SECRET = "Bearer hunter2-otlp-token";

let db: Db;
let app: ReturnType<typeof buildApp>;
let keyless: ReturnType<typeof buildApp>;
let snapshot: { headers: unknown; ciphertext: string | null } = { headers: null, ciphertext: null };

const rawRow = async () => {
  const [row] = await db
    .select({
      headers: orgSettings.tracingOtlpHeaders,
      headersText: sql<string | null>`${orgSettings.tracingOtlpHeaders}::text`,
      ciphertext: orgSettings.tracingOtlpHeadersCiphertext,
    })
    .from(orgSettings)
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  return row!;
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  keyless = buildApp(db, { bootstrapToken: BOOT });
  // the singleton exists after the first read; snapshot it
  await app.inject({ method: "GET", url: "/v1/org/settings", headers: AUTH });
  const row = await rawRow();
  snapshot = { headers: row.headers, ciphertext: row.ciphertext };
});

afterAll(async () => {
  await db
    .update(orgSettings)
    .set({
      tracingOtlpHeaders: snapshot.headers as Record<string, string> | null,
      tracingOtlpHeadersCiphertext: snapshot.ciphertext,
    })
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await app.close();
  await keyless.close();
});

describe("the collector headers are enveloped", () => {
  it("a settings write stores names in the clear and values only inside the envelope; the read and the audit row carry no value", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/v1/org/settings",
      headers: AUTH,
      payload: { tracingOtlpHeaders: { Authorization: SECRET, "x-honeycomb-team": "hc-secret-team" } },
    });
    expect(res.statusCode, res.body).toBe(200);
    // the read: names visible, values redacted, envelope absent
    expect(res.json().settings.tracingOtlpHeaders).toEqual({
      Authorization: OTLP_HEADER_MARKER,
      "x-honeycomb-team": OTLP_HEADER_MARKER,
    });
    expect(res.json().settings.tracingOtlpHeadersCiphertext).toBeNull();

    // the row: the jsonb column never saw the value, the envelope opens to it
    const row = await rawRow();
    expect(row.headersText).not.toContain("hunter2");
    expect(row.headersText).not.toContain("hc-secret");
    expect(row.headers).toEqual({ Authorization: OTLP_HEADER_MARKER, "x-honeycomb-team": OTLP_HEADER_MARKER });
    expect(row.ciphertext).toBeTruthy();
    expect(JSON.parse(decryptSecret(DATA_KEY, row.ciphertext!))).toEqual({
      Authorization: SECRET,
      "x-honeycomb-team": "hc-secret-team",
    });

    // the hash-chained audit row: the diff and the after-image are the marker map
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "org-settings-updated"))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(audit).toBeTruthy();
    const detail = JSON.stringify(audit!.detail);
    expect(detail).not.toContain("hunter2");
    expect(detail).not.toContain("hc-secret");
    expect(detail).toContain(OTLP_HEADER_MARKER);
  });

  it("the export path reads the real headers back out of the envelope, and refuses without the key", async () => {
    const row = await rawRow();
    const opened = otlpHeadersForExport(
      { tracingOtlpHeaders: row.headers, tracingOtlpHeadersCiphertext: row.ciphertext },
      DATA_KEY,
    );
    expect(opened).toEqual({ ok: true, headers: { Authorization: SECRET, "x-honeycomb-team": "hc-secret-team" } });
    const closed = otlpHeadersForExport(
      { tracingOtlpHeaders: row.headers, tracingOtlpHeadersCiphertext: row.ciphertext },
      undefined,
    );
    expect(closed.ok).toBe(false);
    // and a marker map with NO envelope exports nothing, not the marker text
    expect(otlpHeadersForExport({ tracingOtlpHeaders: row.headers, tracingOtlpHeadersCiphertext: null }, DATA_KEY)).toEqual({
      ok: true,
      headers: {},
    });
  });

  it("clearing the headers clears both columns", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/v1/org/settings",
      headers: AUTH,
      payload: { tracingOtlpHeaders: null },
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = await rawRow();
    expect(row.headers).toBeNull();
    expect(row.ciphertext).toBeNull();
  });

  it("a pre-0128 plaintext row is enveloped by the boot-time backfill — once", async () => {
    // the legacy shape: real values in the jsonb column, no envelope
    await db
      .update(orgSettings)
      .set({ tracingOtlpHeaders: { Authorization: "Bearer legacy-plain-token" }, tracingOtlpHeadersCiphertext: null })
      .where(eq(orgSettings.id, ORG_SETTINGS_ID));
    expect(await backfillOtlpHeaderCiphertext(db, DATA_KEY)).toBe("enveloped");
    const row = await rawRow();
    expect(row.headersText).not.toContain("legacy-plain-token");
    expect(row.headers).toEqual({ Authorization: OTLP_HEADER_MARKER });
    expect(JSON.parse(decryptSecret(DATA_KEY, row.ciphertext!))).toEqual({ Authorization: "Bearer legacy-plain-token" });
    // idempotent: nothing left in the clear, nothing to do
    expect(await backfillOtlpHeaderCiphertext(db, DATA_KEY)).toBe("nothing");
  });

  it("without a data key the write is refused rather than stored in the clear", async () => {
    const before = await rawRow();
    const res = await keyless.inject({
      method: "PUT",
      url: "/v1/org/settings",
      headers: AUTH,
      payload: { tracingOtlpHeaders: { Authorization: "Bearer would-be-plaintext" } },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("no_data_key");
    const after = await rawRow();
    expect(after.headersText).not.toContain("would-be-plaintext");
    expect(after.ciphertext).toBe(before.ciphertext);
  });
});
