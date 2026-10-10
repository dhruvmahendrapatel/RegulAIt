/**
 * ADR-0189 B1 — security review fix round (F1–F5, F7b), on a real database.
 *
 * Each `it` is written as the ATTACK, asserting it is refused. On the branch
 * before the fix (4a74b59) the F1–F4 attacks succeeded, so these tests failed
 * there; that run is the negative control recorded in the PR.
 *
 *  F1  a writer-chosen, future-dated prune row let an unexpired row go;
 *  F2  a TEMP table shadowing bom_retention_prunes / audit_log / holds (pg_temp
 *      is searched first) satisfied the guard with no real prune row;
 *  F3  TRUNCATE skipped every row trigger;
 *  F4  a receipt v2 boundary could commit below an in-flight v1 receipt;
 *  F5  the SQL canonicaliser and RFC 8785 disagree on non-integer numbers,
 *      unsafe integers and non-ASCII keys: refused here in SQL (the TS side is
 *      in packages/shared/src/bom/bom.test.ts), and for every admitted shape the
 *      SQL hash equals the TS hash;
 *  F7b the newest snapshot of a subject is never pruned (versions never reused).
 *
 * Shared-database rows are written in rolled-back transactions; F4 commits a
 * boundary, so it runs on its own scratch database, dropped afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createDb, runMigrations, sql, type Db } from "@regulait/db";
import { AI_BOM_VERSION, aiBomSerialNumber, bomCanonicalBytes, bomDigestOf, DECISION_FACTS_VERSION } from "@regulait/shared";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const RUN = Math.random().toString(36).slice(2, 8);
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};
const H = (c: string) => c.repeat(64);
const SIG = "A".repeat(86);
let db: Db;

function text(e: unknown): string {
  return `${String((e as Error)?.message ?? e)} ${String((e as { cause?: Error })?.cause?.message ?? "")}`;
}
async function refused(p: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  const e = await Promise.resolve(p).then(
    () => null,
    (err: unknown) => err,
  );
  expect(e, `refused (${pattern})`).not.toBeNull();
  expect(text(e)).toMatch(pattern);
}
class RolledBack extends Error {}
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
async function rolledBack(body: (tx: Tx) => Promise<void>, on: Db = db) {
  await on.transaction(async (tx) => { await body(tx); throw new RolledBack(); }).catch((e: unknown) => { if (!(e instanceof RolledBack)) throw e; });
}
const sp = (tx: Tx, stmt: ReturnType<typeof sql>) => tx.transaction((s) => s.execute(stmt));
const rows = <T>(r: unknown) => (r as { rows: T[] }).rows;

async function receiptKey(tx: Tx | Db) {
  const id = `b1s-${RUN}-${randomUUID().slice(0, 8)}`;
  const x = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!;
  await tx.execute(sql`insert into receipt_signing_keys (key_id, public_jwk) values (${id}, ${JSON.stringify({ kty: "OKP", crv: "Ed25519", x })}::jsonb)`);
  return id;
}
async function snapshot(tx: Tx | Db, key: string, o: { subjectId?: string; version?: number; supersedes?: string | null; createdAt?: string; expires?: string | null } = {}) {
  const id = randomUUID();
  const subjectId = o.subjectId ?? randomUUID();
  const version = o.version ?? 1;
  const body = bomCanonicalBytes({
    v: AI_BOM_VERSION,
    snapshot: { id, subjectKind: "use_case", subjectId, version, supersedes: o.supersedes ?? null, trigger: "on_demand", createdAt: "2026-10-10T00:00:00.000Z", basis: [] },
    serialNumber: `urn:uuid:${aiBomSerialNumber(id)}`, subject: {}, records: {}, unrecorded: [], compositions: [], renderings: {},
  });
  await tx.execute(sql`insert into ai_bom_snapshots (id, subject_kind, subject_id, version, serial_number, supersedes_id, trigger, basis, body, body_sha256, signature, key_id, created_at, expires_at)
    values (${id}, 'use_case', ${subjectId}, ${version}, ${aiBomSerialNumber(id)}, ${o.supersedes ?? null}, 'on_demand', '{}'::jsonb, ${body}, encode(sha256(convert_to(${body}, 'UTF8')), 'hex'), ${SIG}, ${key}, ${o.createdAt ?? new Date().toISOString()}, ${o.expires ?? null})`);
  return { id, subjectId };
}
const expiredMarker = (tx: Tx | Db, auditId = randomUUID()) =>
  tx.execute(sql`insert into decision_capture_status (audit_id, audit_seq, audit_at, status, expires_at) values (${auditId}, ${600000 + Math.floor(Math.random() * 99_999)}, '2020-01-01Z', 'capture_off', '2020-02-01Z')`).then(() => auditId);

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
}, 120_000);
afterAll(async () => {
  await db.$client.end();
});

describe("F1: a prune row cannot be future-dated", () => {
  it("refuses an as_of in the future, and forces created_at to now()", async () => {
    await rolledBack(async (tx) => {
      const key = await receiptKey(tx);
      const s = await snapshot(tx, key, { expires: new Date(Date.now() + 10 * 365 * 86_400_000).toISOString() });
      await snapshot(tx, key, { subjectId: s.subjectId, version: 2, supersedes: s.id });
      await refused(sp(tx, sql`insert into bom_retention_prunes (as_of, created_at) values ('9999-01-01Z', '9999-01-01Z')`), /as_of in the future/);
      await tx.execute(sql`insert into bom_retention_prunes (as_of, created_at) values (now() - interval '1 minute', '9999-01-01Z')`);
      const [p] = rows<{ future: boolean }>(await tx.execute(sql`select created_at > now() as future from bom_retention_prunes where txid = txid_current()`));
      expect(p!.future).toBe(false);
      await refused(sp(tx, sql`delete from ai_bom_snapshots where id = ${s.id}`), /within its retention/);
    });
  });
});

describe("F2: temp tables cannot shadow what the guard reads (search_path pinned, tables qualified)", () => {
  it("a TEMP bom_retention_prunes does not count as a recorded prune", async () => {
    const client = await db.$client.connect();
    try {
      await client.query("BEGIN");
      const auditId = randomUUID();
      await client.query(`insert into decision_capture_status (audit_id, audit_seq, audit_at, status, expires_at) values ($1, $2, '2020-01-01Z', 'capture_off', '2020-02-01Z')`, [auditId, 650000 + Math.floor(Math.random() * 99_999)]);
      await client.query("create temp table bom_retention_prunes (txid bigint default txid_current(), as_of timestamptz) on commit drop");
      await client.query("insert into bom_retention_prunes (as_of) values (now())");
      await refused(client.query("delete from public.decision_capture_status where audit_id = $1", [auditId]), /outside a recorded retention prune/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  it("a TEMP audit_log / bom_retention_holds does not hide the real audit row or hold", async () => {
    const client = await db.$client.connect();
    try {
      await client.query("BEGIN");
      const audit = (await client.query("select id from public.audit_log order by seq desc limit 1")).rows[0] as { id: string };
      await client.query(`insert into decision_capture_status (audit_id, audit_seq, audit_at, status, expires_at) values ($1, $2, '2020-01-01Z', 'capture_off', '2020-02-01Z')`, [audit.id, 660000 + Math.floor(Math.random() * 99_999)]);
      const held = randomUUID();
      await client.query(`insert into decision_capture_status (audit_id, audit_seq, audit_at, status, expires_at) values ($1, $2, '2020-01-01Z', 'capture_off', '2020-02-01Z')`, [held, 670000 + Math.floor(Math.random() * 99_999)]);
      await client.query(`insert into bom_retention_holds (scope, audit_id, hold_kind, created_by) values ('decision', $1, 'legal', $1)`, [held]);
      await client.query("insert into public.bom_retention_prunes (as_of) values (now())");
      await client.query("create temp table audit_log (id uuid) on commit drop");
      await client.query("create temp table bom_retention_holds (released_at timestamptz, scope text, audit_id uuid, subject_kind text, subject_id uuid) on commit drop");
      await client.query("SAVEPOINT a");
      await refused(client.query("delete from public.decision_capture_status where audit_id = $1", [audit.id]), /audit row still exists/);
      await client.query("ROLLBACK TO SAVEPOINT a");
      await refused(client.query("delete from public.decision_capture_status where audit_id = $1", [held]), /evidence hold covers the row/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  it("every plpgsql/sql function 0182 adds pins its search_path", async () => {
    const res = await db.execute(sql`
      select p.proname, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = any(${`{regulait_audit_anchor_request_facts_guard,regulait_bom_retention_hold_guard,regulait_bom_prune_guard,regulait_ai_bom_serial,regulait_ai_bom_snapshot_version_guard,regulait_decision_facts_marker_guard,regulait_capture_status_consistent,regulait_decision_fact_addendum_guard,regulait_decision_fact_addendum_signature_guard,regulait_decision_bom_version_guard,regulait_bom_rendering_guard,regulait_bom_auditor_grant_guard,regulait_decision_receipt_version_guard,regulait_receipt_payload_version_guard,regulait_refuse_truncate,regulait_bom_prune_record_guard,regulait_bom_json_safe}`}::text[])`);
    const found = rows<{ proname: string; proconfig: string[] | null }>(res);
    expect(found.length).toBeGreaterThanOrEqual(17);
    for (const f of found) expect(f.proconfig ?? [], f.proname).toContain("search_path=pg_catalog, public, pg_temp");
  });
});

describe("F3: TRUNCATE is refused on every BOM table and the receipt boundary", () => {
  const TABLES = [
    "decision_capture_status", "decision_facts", "decision_fact_addenda", "decision_fact_addendum_signatures", "decision_boms",
    "ai_bom_snapshots", "bom_renderings", "bom_retention_prunes", "bom_retention_holds", "bom_auditor_grants", "receipt_payload_versions",
  ];
  for (const t of TABLES) {
    it(t, async () => {
      await rolledBack(async (tx) => {
        await refused(sp(tx, sql.raw(`truncate table public.${t} cascade`)), /TRUNCATE refused/);
      });
      const trig = await db.execute(sql`select tgname, tgfoid::regproc::text as fn from pg_trigger where tgrelid = ${`public.${t}`}::regclass and tgname = ${`${t}_no_truncate`}`);
      expect(rows<{ fn: string }>(trig)[0]?.fn, `${t}_no_truncate`).toBe("regulait_refuse_truncate");
    });
  }
});

describe("F5: facts and addenda hold only shapes both canonicalisers agree on", () => {
  for (const [label, raw] of [
    ["1e21", "1e21"], ["1.0", "1.0"], ["1e-7", "1e-7"], ["2^53 + 1", "9007199254740993"], ["0.5", "0.5"],
    ["a non-ASCII key", `{"é": 1}`], ["a non-BMP key", `{"😀": 1}`],
  ] as const) {
    it(`SQL refuses ${label}`, async () => {
      await rolledBack(async (tx) => {
        const auditId = randomUUID();
        const body = `{"v":"${DECISION_FACTS_VERSION}","auditId":"${auditId}","auditSeq":1,"model":null,"x":${raw}}`;
        const hash = sql`encode(sha256(convert_to(regulait_canonical_json(${body}::jsonb), 'UTF8')), 'hex')`;
        // the marker carries the SQL hash, so the only thing left to refuse the facts is the shape check
        await tx.execute(sql`insert into decision_capture_status (audit_id, audit_seq, audit_at, status, facts_hash) values (${auditId}, 1, now(), 'captured', ${hash})`);
        await refused(sp(tx, sql`insert into decision_facts (audit_id, audit_seq, facts, facts_hash) values (${auditId}, 1, ${body}::jsonb, ${hash})`), /decision_facts_json_safe_check/);
        const ok = rows<{ ok: boolean }>(await tx.execute(sql`select regulait_bom_json_safe(${body}::jsonb) as ok`))[0]!.ok;
        expect(ok).toBe(false);
      });
    });
  }
  it("PROPERTY: for admitted shapes the SQL facts hash equals the TS (RFC 8785) hash", async () => {
    let seed = 1;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const chars = ["a", "Z", "0", "-", " ", "\"", "\\", "/", "\u0001", "\u001f", "\u007f", "é", "中", "😀", " ", "<", "\n"];
    const str = () => Array.from({ length: Math.floor(rnd() * 8) }, () => chars[Math.floor(rnd() * chars.length)]).join("");
    const key = () => Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => "aZ0_-. ~"[Math.floor(rnd() * 8)]).join("");
    const value = (d: number): unknown => {
      const k = Math.floor(rnd() * (d > 2 ? 4 : 6));
      if (k === 0) return Math.floor((rnd() - 0.5) * 2 * Number.MAX_SAFE_INTEGER);
      if (k === 1) return str();
      if (k === 2) return rnd() < 0.5 ? null : rnd() < 0.5;
      if (k === 3) return Math.floor(rnd() * 1000) - 500;
      if (k === 4) return Array.from({ length: Math.floor(rnd() * 4) }, () => value(d + 1));
      return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 4) }, () => [key(), value(d + 1)]));
    };
    for (let i = 0; i < 300; i += 1) {
      const v = { root: value(0), k: key() };
      const r = rows<{ h: string; ok: boolean }>(await db.execute(sql`select encode(sha256(convert_to(regulait_canonical_json(${JSON.stringify(v)}::jsonb), 'UTF8')), 'hex') as h, regulait_bom_json_safe(${JSON.stringify(v)}::jsonb) as ok`))[0]!;
      expect(r.ok, JSON.stringify(v)).toBe(true);
      expect(r.h, JSON.stringify(v)).toBe(bomDigestOf(v));
    }
  });
});

describe("F7b: the newest snapshot of a subject is never pruned", () => {
  it("an expired older version goes; the newest stays", async () => {
    await rolledBack(async (tx) => {
      await tx.execute(sql`insert into bom_retention_prunes (as_of) values (now())`);
      const key = await receiptKey(tx);
      const v1 = await snapshot(tx, key, { createdAt: "2020-01-01Z", expires: "2020-02-01Z" });
      const v2 = await snapshot(tx, key, { subjectId: v1.subjectId, version: 2, supersedes: v1.id, createdAt: "2020-01-02Z", expires: "2020-02-02Z" });
      await refused(sp(tx, sql`delete from ai_bom_snapshots where id = ${v2.id}`), /newest snapshot/);
      await expiredMarker(tx); // unrelated row in the same pass
      await tx.execute(sql`delete from ai_bom_snapshots where id = ${v1.id}`);
    });
  });
});

describe("F4: a receipt v2 boundary can never sit below a stored or in-flight receipt (scratch database)", () => {
  const SCRATCH = `a189_f4_${RUN}`;
  let admin: Db;
  let s: Db;
  beforeAll(async () => {
    admin = createDb(DATABASE_URL);
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`));
    await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH}`));
    s = createDb(urlFor(SCRATCH));
    await runMigrations(s, migrationsFolder);
  }, 180_000);
  afterAll(async () => {
    await closeAll([async () => s?.$client.end(), async () => dropScratchDatabase(admin, SCRATCH), async () => admin.$client.end()]);
  });

  it("A inserts v1@100 uncommitted, B tries boundary 50: B waits, then is refused once A commits", async () => {
    const key = await receiptKey(s);
    const a = await s.$client.connect();
    const b = await s.$client.connect();
    try {
      await a.query("BEGIN");
      const payload = { v: "regulait.receipt.v1", receiptSeq: 1, audit: { id: randomUUID(), seq: 100, rowHash: H("1"), contentHash: H("2") }, decision: {}, prev: H("0"), keyId: key };
      await a.query(`insert into decision_receipts (receipt_seq, audit_id, audit_seq, payload, payload_hash, prev_hash, signature, key_id) values (1, $1, 100, $2::jsonb, $3, $4, $5, $6)`, [payload.audit.id, JSON.stringify(payload), H("7"), H("0"), SIG, key]);
      await b.query("BEGIN");
      let bDone = false;
      const bInsert = b.query("insert into receipt_payload_versions (version, from_audit_seq) values (2, 50)").then(
        () => { bDone = true; return null; },
        (e: unknown) => { bDone = true; return e; },
      );
      await new Promise((r) => setTimeout(r, 400));
      expect(bDone, "the boundary insert waits for the in-flight receipt").toBe(false);
      await a.query("COMMIT");
      const err = await bInsert;
      expect(text(err)).toMatch(/at or below a stored receipt/);
      await b.query("ROLLBACK");
      // and with nothing in flight, a boundary below the stored receipt is refused outright
      await refused(s.execute(sql`insert into receipt_payload_versions (version, from_audit_seq) values (2, 100)`), /at or below a stored receipt/);
      expect(rows(await s.execute(sql`select 1 from receipt_payload_versions`))).toHaveLength(0);
    } finally {
      a.release();
      b.release();
    }
  });
});
