/**
 * ADR-0189 (batch 6 item 2) B1 — the Decision BOM / AI BOM FOUNDATION, on a
 * real database through the real app and the real migrations:
 *
 *  - MIGRATION 0182: every table exists, the journal entry sits after 0181 in
 *    order and `when`, no BOM table has a foreign key to `audit_log` (R16), no
 *    column could hold a secret.
 *  - #280 (4237493038) THE LEGACY-SAFE TSA CONSTRAINT, on an UPGRADED database:
 *    a granted anchor with no send time, written at 0181, survives the
 *    migration as legacy; a new grant without request facts is refused; the
 *    legacy marker cannot be set, changed or used to rewrite a token.
 *  - R4 / R44: the flush records the observation and the read-back lock.
 *  - SECURE BY DEFAULT: the eight BOM settings read strict; relaxing needs a
 *    `settings_relax` step-up and is audited; the bounds hold in zod and SQL.
 *  - THE CAPTURE-STATUS MARKER (4237322635): captured ⇔ facts in the same
 *    transaction, capture_off ⇔ none, facts hash computed in SQL equals the
 *    shared canonical hash.
 *  - THE COMMON expires_at (4237322627) across marker, facts, addenda,
 *    signatures and Decision BOMs; the addendum chain (R35) and signing order (R15).
 *  - APPEND-ONLY (negative controls): every UPDATE and direct DELETE refused.
 *  - RETENTION (R16, R38): deletes only inside a recorded prune, only when
 *    expired, never with unbounded retention (#280 4237493042's null
 *    expires_at), never while the audit row exists, never under a hold; a
 *    snapshot referenced only from retained facts is linked (#280 4237493040);
 *    renderings go only with their parent (R36).
 *  - THE LOCK TARGETS (4237322632, 4237344247): per subject and per decision,
 *    a second writer waits; different keys do not contend.
 *  - SNAPSHOT VERSIONS: contiguous with supersedes, the v8 serial number in SQL
 *    equals the shared one, the install subject is the nil uuid (R20).
 *  - RECEIPT v2 (R34, R42, R43) on a scratch database: the sweep still EMITS v1
 *    (negative control); after a recorded boundary it signs v1 only below it,
 *    the database refuses a v1 at or above it and a v2 below it or unbound to
 *    its marker, and the gateway refuses to boot.
 *  - THE STUBS: every §9 route answers 501 to an admin, 403 to a member and 401
 *    without a credential, and the registries agree with BOM_ROUTES.
 *
 * Global state (M-068): relaxed settings are restored in `finally`; rows on the
 * shared database are written inside rolled-back transactions, except the few
 * expired, audit-less markers the retention and lock tests need, which those
 * tests prune themselves. Scenarios that must COMMIT a boundary or run an
 * upgrade use their own scratch databases, dropped afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  GetObjectLockConfigurationCommand,
  GetObjectRetentionCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  and,
  approvalDecisions,
  approvals,
  auditAnchors,
  auditLog,
  createDb,
  decisionReceipts,
  delegationGrants,
  desc,
  eq,
  evalCases,
  issuedTokens,
  lockAiBomSubject,
  lockDecisionForBom,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  sql,
  traceSpans,
  usageEvents,
  workloadIdentities,
  type Db,
} from "@regulait/db";
import {
  AI_BOM_INSTALL_SUBJECT_ID,
  AI_BOM_VERSION,
  aiBomSerialNumber,
  BOM_ROUTES,
  BOM_ROW_PROJECTIONS,
  BOM_SETTING_COLUMNS,
  BOM_STRICT_DEFAULTS,
  bomCanonicalBytes,
  bomDigestOf,
  bomRowDigest,
  DECISION_BOM_VERSION,
  DECISION_FACTS_ADDENDUM_VERSION,
  DECISION_FACTS_VERSION,
  decisionFactsSchema,
  projectBomRow,
  RECEIPT_PAYLOAD_VERSION,
  RECEIPT_PAYLOAD_VERSION_V2,
  type BomSettingKey,
} from "@regulait/shared";
import { buildApp } from "./app.js";
import { captureAnchor, LocalWormSink, S3ObjectLockSink, type S3SendClient } from "./audit-chain.js";
import { assertReceiptEmitterBootable, ReceiptV2BootError, runDecisionReceiptSignSweep } from "./decision-receipts.js";
import { startGateway } from "./boot.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";
import { routeAuthClass } from "./route-classes.js";
import { ROUTE_STABILITY, ROUTE_TAGS } from "./openapi-registry.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `a189-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const BOOT_USER = "00000000-0000-0000-0000-000000000000";
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};
let db: Db;
let app: ReturnType<typeof buildApp>;
const users = {} as Record<"admin" | "member", { id: string; auth: { authorization: string } }>;

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

const NEW_TABLES = [
  "receipt_payload_versions",
  "decision_capture_status",
  "decision_facts",
  "decision_fact_addenda",
  "decision_fact_addendum_signatures",
  "decision_boms",
  "ai_bom_snapshots",
  "bom_renderings",
  "bom_retention_prunes",
  "bom_retention_holds",
  "bom_auditor_grants",
] as const;

const STRICT_SQL = sql`UPDATE org_settings SET decision_facts_capture = 'on', decision_bom_finality = 'anchored',
  bom_export_roles = 'admins_only', bom_person_identifiers = 'id_only', ai_bom_snapshot_triggers = 'sign_off_events',
  ai_bom_snapshot_without_key = 'refuse', cyclonedx_export_versions = '["1.7"]'::jsonb, bom_export_rate_limit_per_minute = 30`;

const RELAXED: Record<BomSettingKey, unknown> = {
  decisionFactsCapture: "off",
  decisionBomFinality: "chain_signed",
  bomExportRoles: "admins_and_auditors",
  bomPersonIdentifiers: "display_name",
  aiBomSnapshotTriggers: "on_demand_only",
  aiBomSnapshotWithoutKey: "skip_and_record",
  cyclonedxExportVersions: ["1.7", "1.6"],
  bomExportRateLimitPerMinute: 120,
};

const H = (c: string) => c.repeat(64);
const SIG = "A".repeat(86);
const rows = <T>(r: unknown) => (r as { rows: T[] }).rows;
function refusalText(e: unknown): string {
  return `${String((e as Error)?.message ?? e)} ${String((e as { cause?: Error })?.cause?.message ?? "")}`;
}
async function expectRefused(p: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  const e = await Promise.resolve(p).then(
    () => null,
    (err: unknown) => err,
  );
  expect(e, `the statement was refused (${pattern})`).not.toBeNull();
  expect(refusalText(e)).toMatch(pattern);
}
class RolledBack extends Error {}
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
async function inRolledBackTx(body: (tx: Tx) => Promise<void>, on: Db = db): Promise<void> {
  await on
    .transaction(async (tx) => {
      await body(tx);
      throw new RolledBack();
    })
    .catch((e: unknown) => {
      if (!(e instanceof RolledBack)) throw e;
    });
}
const inSavepoint = (tx: Tx, stmt: ReturnType<typeof sql>) => tx.transaction((sp) => sp.execute(stmt));
const one = async <T>(tx: Tx | Db, stmt: ReturnType<typeof sql>) => rows<T>(await tx.execute(stmt))[0]!;

/** a valid `regulait.decision-facts.v1` payload for an audit id */
function factsFor(auditId: string, auditSeq: number, aiBomSnapshotId: string | null = null) {
  const projection = projectBomRow("approvals", { id: randomUUID(), status: "approved", quorum: 1, argumentsDigest: H("a"), requestedAt: new Date("2026-10-10T00:00:00.000Z") });
  return decisionFactsSchema.parse({
    v: DECISION_FACTS_VERSION,
    auditId,
    auditSeq,
    action: null,
    policy: null,
    model: { agentId: null, provider: null, requestedModel: null, servedModel: null, pinnedModelVersion: null, modelCardId: null, modelCardApprovalId: null, aiBomSnapshotId },
    actors: null,
    outcome: { effect: "allow", refusalCode: null, upstreamStatusClass: null },
    rows: [{ table: "approvals", id: projection.id as string, projection, digest: bomRowDigest("approvals", projection) }],
  });
}
const jsonb = (v: unknown) => sql`${JSON.stringify(v)}::jsonb`;

async function receiptKey(tx: Tx | Db, id = `b1-${RUN}-${randomUUID().slice(0, 8)}`): Promise<string> {
  const x = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!;
  await tx.execute(sql`insert into receipt_signing_keys (key_id, public_jwk) values (${id}, ${jsonb({ kty: "OKP", crv: "Ed25519", x })})`);
  return id;
}
async function marker(tx: Tx | Db, o: { auditId?: string; seq: number; at?: string; status: "captured" | "capture_off"; hash?: string | null; expires?: string | null }) {
  const auditId = o.auditId ?? randomUUID();
  await tx.execute(sql`insert into decision_capture_status (audit_id, audit_seq, audit_at, status, facts_hash, expires_at)
    values (${auditId}, ${o.seq}, ${o.at ?? "2026-10-10T00:00:00Z"}, ${o.status}, ${o.hash ?? null}, ${o.expires ?? null})`);
  return auditId;
}
async function insertFacts(tx: Tx | Db, auditId: string, seq: number, f: unknown, o: { hash?: string; expires?: string | null; snapshot?: string | null } = {}) {
  await tx.execute(sql`insert into decision_facts (audit_id, audit_seq, facts, facts_hash, ai_bom_snapshot_id, expires_at)
    values (${auditId}, ${seq}, ${jsonb(f)}, ${o.hash ?? bomDigestOf(f)}, ${o.snapshot ?? null}, ${o.expires ?? null})`);
}
/** a minimal native AI BOM body, valid for the 0182 CHECKs */
function snapshotBody(id: string, kind: string, subjectId: string, version: number, supersedes: string | null) {
  return bomCanonicalBytes({
    v: AI_BOM_VERSION,
    snapshot: { id, subjectKind: kind, subjectId, version, supersedes, trigger: "on_demand", createdAt: "2026-10-10T00:00:00.000Z", basis: [] },
    serialNumber: `urn:uuid:${aiBomSerialNumber(id)}`,
    subject: {},
    records: {},
    unrecorded: [],
    compositions: [],
    renderings: {},
  });
}
async function insertSnapshot(
  tx: Tx | Db,
  keyId: string,
  o: { kind?: string; subjectId?: string; version?: number; supersedes?: string | null; createdAt?: string; expires?: string | null; serial?: string; id?: string },
) {
  const id = o.id ?? randomUUID();
  const kind = o.kind ?? "use_case";
  const subjectId = o.subjectId ?? randomUUID();
  const version = o.version ?? 1;
  const body = snapshotBody(id, kind, subjectId, version, o.supersedes ?? null);
  await tx.execute(sql`insert into ai_bom_snapshots (id, subject_kind, subject_id, version, serial_number, supersedes_id, trigger, basis, body, body_sha256, signature, key_id, created_at, expires_at)
    values (${id}, ${kind}, ${subjectId}, ${version}, ${o.serial ?? aiBomSerialNumber(id)}, ${o.supersedes ?? null}, 'on_demand', '{}'::jsonb, ${body},
            encode(sha256(convert_to(${body}, 'UTF8')), 'hex'), ${SIG}, ${keyId}, ${o.createdAt ?? new Date().toISOString()}, ${o.expires ?? null})`);
  return { id, subjectId };
}

let restoreMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  for (const [k, isAdmin] of [["admin", true], ["member", false]] as const) {
    const u = await inject("POST", "/v1/users", AUTH, { email: `a189-${k}-${RUN}@example.com`, displayName: `a189 ${k} ${RUN}`, isAdmin });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "a189" })).json().token as string;
    users[k] = { id, auth: { authorization: `Bearer ${token}` } };
  }
}, 120_000);

afterAll(async () => {
  await db.execute(STRICT_SQL);
  await restoreMfa?.();
  app.server.closeAllConnections();
  await app.close();
});

// ---------------------------------------------------------------------------
describe("ADR-0189 migration 0182 on a freshly migrated database", () => {
  it("creates every table the slice names", async () => {
    const res = await db.execute(sql`select table_name from information_schema.tables where table_schema = 'public'`);
    const have = new Set(rows<{ table_name: string }>(res).map((r) => r.table_name));
    for (const t of NEW_TABLES) expect(have.has(t), t).toBe(true);
  });

  it("is journalled right after 0181 (idx 182, when 1785117000000), in journal order, and was applied", async () => {
    const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const mine = journal.entries.find((e) => e.tag === "0182_decision_bom_foundation")!;
    expect(mine).toMatchObject({ idx: 182, when: 1785117000000 });
    const at = journal.entries.indexOf(mine);
    expect(journal.entries[at - 1]!.tag).toBe("0181_outbound_credential_audience");
    for (const e of journal.entries.slice(0, at)) expect(mine.when).toBeGreaterThan(e.when);
    for (const e of journal.entries.slice(at + 1)) expect(e.when).toBeGreaterThan(mine.when);
    const applied = await db.execute(sql`select max(created_at)::bigint as w from drizzle.__drizzle_migrations`);
    expect(Number(rows<{ w: string }>(applied)[0]!.w)).toBeGreaterThanOrEqual(1785117000000);
  });

  it("R16: no BOM table has a foreign key to audit_log", async () => {
    const res = await db.execute(sql`
      select conrelid::regclass::text as t, conname from pg_constraint
       where contype = 'f' and confrelid = 'audit_log'::regclass
         and conrelid::regclass::text = any(${`{${NEW_TABLES.join(",")}}`}::text[])`);
    expect(rows(res)).toEqual([]);
  });

  it("no new table has a column that could hold a secret, prose or a private key", async () => {
    const res = await db.execute(sql`
      select table_name, column_name from information_schema.columns
       where table_schema = 'public' and table_name = any(${`{${NEW_TABLES.join(",")}}`}::text[])
         and column_name ~ '(secret|private|password|ciphertext|token|api_key|reason|note|email|preview|prompt)'`);
    expect(rows(res)).toEqual([]);
  });

  it("every projected column exists on its drizzle table (R5, R18)", () => {
    const tables: Record<string, Record<string, unknown>> = {
      approvals, approval_decisions: approvalDecisions, usage_events: usageEvents, trace_spans: traceSpans,
      delegation_grants: delegationGrants, issued_tokens: issuedTokens, workload_identities: workloadIdentities, eval_cases: evalCases,
    } as unknown as Record<string, Record<string, unknown>>;
    for (const [table, cols] of Object.entries(BOM_ROW_PROJECTIONS)) {
      for (const c of cols) expect(tables[table]![c], `${table}.${c}`).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
describe("#280 (4237493038): the legacy-safe audit_anchors TSA constraint, on an UPGRADED database", () => {
  const UPGRADE_DB = `a189_upgrade_${RUN}`;
  let admin: Db;
  let upgrade: Db;
  let tmp: string;
  const legacyId = randomUUID();
  const pendingId = randomUUID();
  beforeAll(async () => {
    admin = createDb(DATABASE_URL);
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${UPGRADE_DB} WITH (FORCE)`));
    await admin.execute(sql.raw(`CREATE DATABASE ${UPGRADE_DB}`));
    tmp = mkdtempSync(path.join(tmpdir(), "a189-mig-"));
    cpSync(migrationsFolder, tmp, { recursive: true });
    const journalPath = path.join(tmp, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ idx: number }> };
    journal.entries = journal.entries.filter((e) => e.idx < 182);
    writeFileSync(journalPath, JSON.stringify(journal));
    upgrade = createDb(urlFor(UPGRADE_DB));
    await runMigrations(upgrade, tmp);
    // at 0181: a GRANTED timestamp with no request facts (0170 allowed it), and one still failing
    await upgrade.execute(sql`insert into audit_anchors (id, seq, row_hash, head_at, destination, status, tsa_status, tsa_token, tsa_gen_time, tsa_message_imprint, tsa_url)
      values (${legacyId}, 1, ${H("1")}, now(), 'local_worm', 'flushed', 'granted', 'MIIB', now(), ${H("2")}, 'https://tsa.example.test')`);
    await upgrade.execute(sql`insert into audit_anchors (id, seq, row_hash, head_at, destination, status, tsa_status, tsa_nonce)
      values (${pendingId}, 2, ${H("3")}, now(), 'local_worm', 'flushed', 'failed', 'ab12')`);
    await runMigrations(upgrade, migrationsFolder);
  }, 180_000);
  afterAll(async () => {
    await closeAll([
      async () => upgrade?.$client.end(),
      async () => dropScratchDatabase(admin, UPGRADE_DB),
      async () => admin.$client.end(),
      async () => tmp && rmSync(tmp, { recursive: true, force: true }),
    ]);
  });

  it("the legacy granted anchor survives the migration and is marked legacy; the failing one is not", async () => {
    const [legacy] = await upgrade.select().from(auditAnchors).where(eq(auditAnchors.id, legacyId));
    expect(legacy).toMatchObject({ tsaStatus: "granted", tsaRequestFactsLegacy: true, tsaRequestSentAt: null, tamperResistant: false, retainUntil: null });
    const [pending] = await upgrade.select().from(auditAnchors).where(eq(auditAnchors.id, pendingId));
    expect(pending).toMatchObject({ tsaStatus: "failed", tsaRequestFactsLegacy: false });
  });

  it("a NEW grant without its nonce and send time is refused; with them it is accepted", async () => {
    await expectRefused(
      upgrade.execute(sql`update audit_anchors set tsa_status = 'granted', tsa_token = 'MIIB', tsa_gen_time = now(), tsa_message_imprint = ${H("4")}, tsa_url = 'https://tsa.example.test' where id = ${pendingId}`),
      /audit_anchors_tsa_granted_check/,
    );
    await inRolledBackTx(async (tx) => {
      await tx.execute(sql`update audit_anchors set tsa_status = 'granted', tsa_token = 'MIIB', tsa_gen_time = now(), tsa_message_imprint = ${H("4")}, tsa_url = 'https://tsa.example.test', tsa_request_sent_at = now() where id = ${pendingId}`);
    }, upgrade);
  });

  it("the legacy marker cannot be set on a new row, changed, or used to rewrite a legacy token", async () => {
    await expectRefused(
      upgrade.execute(sql`insert into audit_anchors (seq, row_hash, head_at, destination, tsa_status, tsa_token, tsa_gen_time, tsa_message_imprint, tsa_url, tsa_request_facts_legacy)
        values (3, ${H("5")}, now(), 'none', 'granted', 'MIIB', now(), ${H("6")}, 'https://tsa.example.test', true)`),
      /cannot be marked as a legacy timestamp/,
    );
    await expectRefused(upgrade.execute(sql`update audit_anchors set tsa_request_facts_legacy = false where id = ${legacyId}`), /never changes/);
    await expectRefused(upgrade.execute(sql`update audit_anchors set tsa_request_facts_legacy = true where id = ${pendingId}`), /never changes/);
    await expectRefused(upgrade.execute(sql`update audit_anchors set tsa_token = 'MIIC' where id = ${legacyId}`), /never rewritten/);
    // unrelated columns of a legacy row still move (e.g. a later flush bookkeeping field)
    await inRolledBackTx(async (tx) => {
      await tx.execute(sql`update audit_anchors set last_error = null where id = ${legacyId}`);
    }, upgrade);
  });
});

// ---------------------------------------------------------------------------
describe("R4 / R44: the flush records the observed tamper-resistance and the read-back lock", () => {
  const noTimestamp = { afterFlush: async () => {} };
  const S3_CONFIG = { bucket: "anchors", prefix: "audit-anchors", region: "us-east-1", endpoint: "http://minio:9000", forcePathStyle: true, retentionDays: 365, credentials: { accessKeyId: "k", secretAccessKey: "s" } };
  class FakeS3 implements S3SendClient {
    constructor(private readonly o: { mode: "COMPLIANCE" | "GOVERNANCE"; retention: "COMPLIANCE" | "GOVERNANCE" | "denied"; until: Date }) {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async send(command: any): Promise<any> {
      if (command instanceof GetObjectLockConfigurationCommand) return { ObjectLockConfiguration: { ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: this.o.mode, Days: 365 } } } };
      if (command instanceof PutObjectCommand) return { VersionId: "v-1" };
      if (command instanceof GetObjectRetentionCommand) {
        expect(command.input.VersionId).toBe("v-1");
        if (this.o.retention === "denied") throw new Error("AccessDenied");
        return { Retention: { Mode: this.o.retention, RetainUntilDate: this.o.until } };
      }
      throw new Error(`unexpected ${command?.constructor?.name}`);
    }
  }

  it("a local directory is recorded as its constant answer, never tamper-resistant", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "a189-worm-"));
    try {
      const out = await captureAnchor(db, new LocalWormSink(dir), null, noTimestamp);
      const [row] = await db.select().from(auditAnchors).where(eq(auditAnchors.id, out!.anchorId));
      expect(row).toMatchObject({ status: "flushed", tamperResistant: false, tamperObservationMode: "sink_constant", retainUntil: null });
      expect(row!.tamperObservedAt).toBeInstanceOf(Date);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an observed COMPLIANCE bucket is recorded tamper-resistant with the version's read-back retain-until", async () => {
    const until = new Date(Date.now() + 400 * 86_400_000);
    const out = await captureAnchor(db, new S3ObjectLockSink(S3_CONFIG, new FakeS3({ mode: "COMPLIANCE", retention: "COMPLIANCE", until })), null, noTimestamp);
    const [row] = await db.select().from(auditAnchors).where(eq(auditAnchors.id, out!.anchorId));
    expect(row).toMatchObject({ status: "flushed", tamperResistant: true, tamperObservationMode: "compliance" });
    expect(row!.retainUntil!.getTime()).toBe(until.getTime());
  });

  it("NEGATIVE CONTROLS: GOVERNANCE is not tamper-resistant; an unreadable or governance lock records no retain-until", async () => {
    const until = new Date(Date.now() + 400 * 86_400_000);
    const gov = await captureAnchor(db, new S3ObjectLockSink(S3_CONFIG, new FakeS3({ mode: "GOVERNANCE", retention: "GOVERNANCE", until })), null, noTimestamp);
    const [g] = await db.select().from(auditAnchors).where(eq(auditAnchors.id, gov!.anchorId));
    expect(g).toMatchObject({ tamperResistant: false, tamperObservationMode: "governance", retainUntil: null });
    const denied = await captureAnchor(db, new S3ObjectLockSink(S3_CONFIG, new FakeS3({ mode: "COMPLIANCE", retention: "denied", until })), null, noTimestamp);
    const [d] = await db.select().from(auditAnchors).where(eq(auditAnchors.id, denied!.anchorId));
    expect(d).toMatchObject({ tamperResistant: true, retainUntil: null });
    // the database refuses a claim the observation does not back
    await inRolledBackTx(async (tx) => {
      await expectRefused(inSavepoint(tx, sql`update audit_anchors set tamper_resistant = true, tamper_observation_mode = 'governance' where id = ${gov!.anchorId}`), /audit_anchors_tamper_resistant_check/);
      await expectRefused(inSavepoint(tx, sql`update audit_anchors set status = 'pending' where id = ${denied!.anchorId}`), /audit_anchors_tamper_resistant_check/);
    });
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0189 secure by default: the BOM org settings", () => {
  it("a freshly migrated org reads every BOM setting strict — the column defaults and the stored row", async () => {
    const res = await db.execute(sql`select column_name, column_default from information_schema.columns where table_schema = 'public' and table_name = 'org_settings'`);
    const defaults = new Map(rows<{ column_name: string; column_default: string | null }>(res).map((r) => [r.column_name, r.column_default ?? ""]));
    const g = await inject("GET", "/v1/org/settings", users.admin.auth);
    expect(g.statusCode, g.body).toBe(200);
    const settings = g.json().settings as Record<string, unknown>;
    for (const [key, strict] of Object.entries(BOM_STRICT_DEFAULTS)) {
      expect(settings[key], key).toEqual(strict);
      const def = defaults.get(BOM_SETTING_COLUMNS[key as BomSettingKey]);
      expect(def, key).toBeDefined();
      if (typeof strict === "number") expect(def, key).toBe(String(strict));
      else if (typeof strict === "string") expect(def, key).toBe(`'${strict}'::text`);
      else expect(JSON.parse(def!.replace(/^'/, "").replace(/'::jsonb$/, "")), key).toEqual(strict);
    }
  });

  it("each relaxation round-trips and is audited as a relaxation; strict comes back", async () => {
    try {
      for (const [key, value] of Object.entries(RELAXED)) {
        const put = await inject("PUT", "/v1/org/settings", AUTH, { [key]: value });
        expect(put.statusCode, `${key}: ${put.body}`).toBe(200);
        expect(put.json().settings[key], key).toEqual(value);
        const [row] = await db
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.ruleId, "org-settings-updated"), eq(auditLog.userId, BOOT_USER)))
          .orderBy(desc(auditLog.seq))
          .limit(1);
        const detail = row!.detail as { transitions: Record<string, unknown>; relaxed?: string[] };
        expect(detail.transitions[key], key).toEqual({ from: BOM_STRICT_DEFAULTS[key as BomSettingKey], to: value });
        expect(detail.relaxed, key).toEqual([key]);
      }
    } finally {
      const back = await inject("PUT", "/v1/org/settings", AUTH, { ...BOM_STRICT_DEFAULTS });
      expect(back.statusCode, back.body).toBe(200);
    }
  });

  it("relaxing needs a settings_relax step-up an API key cannot give (OWNER DECISION 12 included); tightening needs nothing", async () => {
    try {
      for (const [key, value] of Object.entries(RELAXED)) {
        const r = await inject("PUT", "/v1/org/settings", users.admin.auth, { [key]: value });
        expect(r.statusCode, `${key}: ${r.body}`).toBe(403);
        expect(r.json(), key).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
      }
      const tighter = await inject("PUT", "/v1/org/settings", users.admin.auth, { bomExportRateLimitPerMinute: 10 });
      expect(tighter.statusCode, tighter.body).toBe(200);
      const back = await inject("PUT", "/v1/org/settings", users.admin.auth, { bomExportRateLimitPerMinute: 30 });
      expect(back.statusCode, back.body).toBe(403);
    } finally {
      await db.execute(STRICT_SQL);
    }
  });

  it("refuses a value outside its bounds (400); the database holds the same bounds", async () => {
    for (const body of [
      { decisionFactsCapture: "sometimes" },
      { decisionBomFinality: "anchored_finite_lock" },
      { cyclonedxExportVersions: ["1.6"] },
      { cyclonedxExportVersions: ["1.7", "1.5"] },
      { bomExportRateLimitPerMinute: 0 },
      { bomExportRateLimitPerMinute: 601 },
      { aiBomSnapshotWithoutKey: "queue" },
    ]) {
      const r = await inject("PUT", "/v1/org/settings", AUTH, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    for (const [stmt, constraint] of [
      [sql`UPDATE org_settings SET decision_facts_capture = 'maybe'`, "org_settings_decision_facts_capture_check"],
      [sql`UPDATE org_settings SET decision_bom_finality = 'whenever'`, "org_settings_decision_bom_finality_check"],
      [sql`UPDATE org_settings SET ai_bom_snapshot_without_key = 'queue'`, "org_settings_ai_bom_snapshot_without_key_check"],
      [sql`UPDATE org_settings SET cyclonedx_export_versions = '["1.6"]'::jsonb`, "org_settings_cyclonedx_export_versions_check"],
      [sql`UPDATE org_settings SET bom_export_rate_limit_per_minute = 601`, "org_settings_bom_export_rate_limit_per_minute_check"],
    ] as const) {
      await expectRefused(db.execute(stmt), new RegExp(constraint));
    }
    const [org] = await db.select({ w: orgSettings.aiBomSnapshotWithoutKey }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    expect(org!.w).toBe("refuse");
  });
});

// ---------------------------------------------------------------------------
describe("the capture-status marker (4237322635), decision facts and the common expires_at (4237322627)", () => {
  it("captured ⇔ facts in the same transaction; the SQL facts hash equals the shared canonical hash", async () => {
    await inRolledBackTx(async (tx) => {
      const auditId = randomUUID();
      const f = factsFor(auditId, 900001);
      await marker(tx, { auditId, seq: 900001, status: "captured", hash: bomDigestOf(f) });
      await insertFacts(tx, auditId, 900001, f);
      await tx.execute(sql`SET CONSTRAINTS "decision_capture_status_consistent" IMMEDIATE`);
    });
  });

  it("NEGATIVE CONTROLS: a captured marker with no facts, a capture_off marker with facts, a forged hash, a different expires_at", async () => {
    await inRolledBackTx(async (tx) => {
      await marker(tx, { seq: 900002, status: "captured", hash: H("c") });
      await expectRefused(tx.execute(sql`SET CONSTRAINTS "decision_capture_status_consistent" IMMEDIATE`), /marked captured but its facts were not written/);
    });
    await inRolledBackTx(async (tx) => {
      const auditId = await marker(tx, { seq: 900003, status: "capture_off" });
      await expectRefused(inSavepoint(tx, sql`insert into decision_facts (audit_id, audit_seq, facts, facts_hash) select ${auditId}, 900003, ${jsonb(factsFor(auditId, 900003))}, ${bomDigestOf(factsFor(auditId, 900003))}`), /do not match its capture-status marker/);
      await expectRefused(inSavepoint(tx, sql`insert into decision_capture_status (audit_id, audit_seq, audit_at, status, facts_hash) values (${randomUUID()}, 900004, now(), 'capture_off', ${H("d")})`), /decision_capture_status_facts_hash_check/);
    });
    await inRolledBackTx(async (tx) => {
      const auditId = randomUUID();
      const f = factsFor(auditId, 900005);
      await marker(tx, { auditId, seq: 900005, status: "captured", hash: H("e") });
      // the hash is recomputed by the database: a value that is not SHA-256 of the canonical bytes is refused
      await expectRefused(inSavepoint(tx, sql`insert into decision_facts (audit_id, audit_seq, facts, facts_hash) values (${auditId}, 900005, ${jsonb(f)}, ${H("e")})`), /decision_facts_hash_check/);
    });
    await inRolledBackTx(async (tx) => {
      const auditId = randomUUID();
      const f = factsFor(auditId, 900006);
      await marker(tx, { auditId, seq: 900006, status: "captured", hash: bomDigestOf(f), expires: "2027-10-10T00:00:00Z" });
      await expectRefused(inSavepoint(tx, sql`insert into decision_facts (audit_id, audit_seq, facts, facts_hash, expires_at) values (${auditId}, 900006, ${jsonb(f)}, ${bomDigestOf(f)}, '2028-10-10T00:00:00Z')`), /do not match its capture-status marker/);
      await expectRefused(inSavepoint(tx, sql`insert into decision_capture_status (audit_id, audit_seq, audit_at, status, expires_at) values (${randomUUID()}, 900007, '2026-10-10T00:00:00Z', 'capture_off', '2026-10-09T00:00:00Z')`), /decision_capture_status_expires_check/);
    });
  });

  it("R35 addenda chain from the facts hash, sequenced; R15 signatures in n order; every row shares the decision's expires_at", async () => {
    await inRolledBackTx(async (tx) => {
      const key = await receiptKey(tx);
      const auditId = randomUUID();
      const exp = "2027-10-10T00:00:00Z";
      const f = factsFor(auditId, 900010);
      await marker(tx, { auditId, seq: 900010, status: "captured", hash: bomDigestOf(f), expires: exp });
      await insertFacts(tx, auditId, 900010, f, { expires: exp });
      const addendum = (n: number, prev: string) => ({ v: DECISION_FACTS_ADDENDUM_VERSION, auditId, n, prev, rows: [], postActionVerification: null });
      const add = (n: number, prev: string, expires: string | null = exp) => {
        const a = addendum(n, prev);
        return sql`insert into decision_fact_addenda (audit_id, n, prev_hash, facts, facts_hash, expires_at) values (${auditId}, ${n}, ${prev}, ${jsonb(a)}, ${bomDigestOf(a)}, ${expires})`;
      };
      const h1 = bomDigestOf(addendum(1, bomDigestOf(f)));
      await expectRefused(inSavepoint(tx, add(1, H("9"))), /does not extend the chain/);
      await expectRefused(inSavepoint(tx, add(1, bomDigestOf(f), null)), /does not extend the chain/);
      await expectRefused(inSavepoint(tx, add(2, h1)), /does not extend the chain/);
      await tx.execute(add(1, bomDigestOf(f)));
      await expectRefused(inSavepoint(tx, add(1, bomDigestOf(f))), /decision_fact_addenda_pk|duplicate key/);
      const h2 = bomDigestOf(addendum(2, h1));
      await tx.execute(add(2, h1));
      const signature = (n: number, hash: string, expires: string | null = exp) =>
        sql`insert into decision_fact_addendum_signatures (audit_id, n, facts_hash, signature, key_id, expires_at) values (${auditId}, ${n}, ${hash}, ${SIG}, ${key}, ${expires})`;
      await expectRefused(inSavepoint(tx, signature(2, h2)), /signed before addendum 1/);
      await expectRefused(inSavepoint(tx, signature(1, h2)), /decision_fact_addendum_signatures_addendum_fk/);
      await expectRefused(inSavepoint(tx, signature(1, h1, null)), /expires_at differs/);
      await tx.execute(signature(1, h1));
      await tx.execute(signature(2, h2));
      // APPEND-ONLY negative controls
      for (const stmt of [
        sql`update decision_capture_status set status = 'capture_off' where audit_id = ${auditId}`,
        sql`update decision_facts set expires_at = null where audit_id = ${auditId}`,
        sql`update decision_fact_addenda set expires_at = null where audit_id = ${auditId}`,
        sql`update decision_fact_addendum_signatures set signature = ${"B".repeat(86)} where audit_id = ${auditId}`,
        sql`delete from decision_fact_addendum_signatures where audit_id = ${auditId}`,
        sql`delete from decision_fact_addenda where audit_id = ${auditId}`,
        sql`delete from decision_facts where audit_id = ${auditId}`,
        sql`delete from decision_capture_status where audit_id = ${auditId}`,
      ]) {
        await expectRefused(inSavepoint(tx, stmt), /append-only/);
      }
    });
  });

  it("Decision BOM versions are contiguous, supersede the last, and carry the decision's expires_at", async () => {
    await inRolledBackTx(async (tx) => {
      const key = await receiptKey(tx);
      const auditId = await marker(tx, { seq: 900020, status: "capture_off", expires: "2027-10-10T00:00:00Z" });
      const bom = (id: string, version: number, supersedes: string | null, expires: string | null = "2027-10-10T00:00:00Z") => {
        const body = bomCanonicalBytes({ v: DECISION_BOM_VERSION, id, auditId, version, finality: "chain_signed", supersedes });
        return sql`insert into decision_boms (id, audit_id, version, supersedes_id, finality, body, body_sha256, signature, key_id, basis, expires_at)
          values (${id}, ${auditId}, ${version}, ${supersedes}, 'chain_signed', ${body}, encode(sha256(convert_to(${body}, 'UTF8')), 'hex'), ${SIG}, ${key}, '{}'::jsonb, ${expires})`;
      };
      const v1 = randomUUID();
      await expectRefused(inSavepoint(tx, bom(v1, 1, null, null)), /expires_at differs/);
      await expectRefused(inSavepoint(tx, bom(v1, 2, null)), /decision_boms_supersedes_check|must be 1 and supersede/);
      await tx.execute(bom(v1, 1, null));
      await expectRefused(inSavepoint(tx, bom(randomUUID(), 3, v1)), /must be 2 and supersede/);
      await expectRefused(inSavepoint(tx, bom(randomUUID(), 2, randomUUID())), /must be 2 and supersede|foreign key/);
      const v2 = randomUUID();
      await tx.execute(bom(v2, 2, v1));
      await expectRefused(inSavepoint(tx, sql`update decision_boms set finality = 'anchored' where id = ${v1}`), /append-only/);
      // a body whose bytes disagree with its columns is refused
      const forged = bomCanonicalBytes({ v: AI_BOM_VERSION, id: randomUUID(), auditId, version: 3, finality: "chain_signed" });
      await expectRefused(
        inSavepoint(tx, sql`insert into decision_boms (audit_id, version, supersedes_id, finality, body, body_sha256, signature, key_id, basis, expires_at) values (${auditId}, 3, ${v2}, 'chain_signed', ${forged}, encode(sha256(convert_to(${forged}, 'UTF8')), 'hex'), ${SIG}, ${key}, '{}'::jsonb, '2027-10-10T00:00:00Z')`),
        /decision_boms_body_check/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
describe("AI BOM snapshots: contiguous versions, the v8 serial in SQL, the install subject", () => {
  it("the database's serial number equals the shared derivation", async () => {
    for (let i = 0; i < 5; i += 1) {
      const id = randomUUID();
      const r = await one<{ s: string }>(db, sql`select "regulait_ai_bom_serial"(${id}::uuid)::text as s`);
      expect(r.s).toBe(aiBomSerialNumber(id));
    }
  });

  it("versions 1, 2 … supersede in order; a skipped, forked or wrongly serialised version is refused", async () => {
    await inRolledBackTx(async (tx) => {
      const key = await receiptKey(tx);
      const subjectId = randomUUID();
      const v1 = await insertSnapshot(tx, key, { subjectId });
      await expectRefused(insertSnapshotInSavepoint(tx, key, { subjectId, version: 1 }), /must be 2|ai_bom_snapshots_subject_version_uq/);
      await expectRefused(insertSnapshotInSavepoint(tx, key, { subjectId, version: 3, supersedes: v1.id }), /must be 2 and supersede/);
      await expectRefused(insertSnapshotInSavepoint(tx, key, { subjectId, version: 2, supersedes: null }), /ai_bom_snapshots_supersedes_check|must be 2 and supersede/);
      await expectRefused(insertSnapshotInSavepoint(tx, key, { serial: aiBomSerialNumber(randomUUID()) }), /ai_bom_snapshots_serial_check|ai_bom_snapshots_body_check/);
      await insertSnapshotInSavepoint(tx, key, { subjectId, version: 2, supersedes: v1.id });
      await expectRefused(insertSnapshotInSavepoint(tx, key, { kind: "install", subjectId: randomUUID() }), /ai_bom_snapshots_install_subject_check/);
      await insertSnapshotInSavepoint(tx, key, { kind: "install", subjectId: AI_BOM_INSTALL_SUBJECT_ID });
      await expectRefused(inSavepoint(tx, sql`update ai_bom_snapshots set trigger = 'on_demand' where id = ${v1.id}`), /append-only/);
    });
    function insertSnapshotInSavepoint(tx: Tx, key: string, o: Parameters<typeof insertSnapshot>[2]) {
      return tx.transaction((sp) => insertSnapshot(sp as unknown as Tx, key, o));
    }
  });
});

// ---------------------------------------------------------------------------
describe("retention through the immutability rules (R16, R38, #280)", () => {
  /** markers committed for real: expired (2020), audit row absent. Each test prunes its own. */
  async function expiredMarker(o: { auditId?: string; expires?: string | null } = {}) {
    return marker(db, { auditId: o.auditId, seq: 800000 + Math.floor(Math.random() * 99_999), at: "2020-01-01T00:00:00Z", status: "capture_off", expires: o.expires === undefined ? "2020-02-01T00:00:00Z" : o.expires });
  }
  const prune = (body: (tx: Tx) => Promise<void>) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`insert into bom_retention_prunes (as_of, counts) values (now(), '{}'::jsonb)`);
      await body(tx);
    });

  it("a direct DELETE is refused; inside a recorded prune an expired, audit-less, unheld row goes", async () => {
    const auditId = await expiredMarker();
    await expectRefused(db.execute(sql`delete from decision_capture_status where audit_id = ${auditId}`), /outside a recorded retention prune/);
    await prune(async (tx) => {
      await tx.execute(sql`delete from decision_capture_status where audit_id = ${auditId}`);
    });
    expect(rows(await db.execute(sql`select 1 from decision_capture_status where audit_id = ${auditId}`))).toHaveLength(0);
  });

  it("refused within retention, with UNBOUNDED retention (null expires_at), while the audit row exists, and under a hold", async () => {
    // all inside one rolled-back transaction (most of these rows could never be pruned, by design)
    await inRolledBackTx(async (tx) => {
      await tx.execute(sql`insert into bom_retention_prunes (as_of, counts) values (now(), '{}'::jsonb)`);
      const m = (o: { auditId?: string; expires: string | null }) =>
        marker(tx, { auditId: o.auditId, seq: 800000 + Math.floor(Math.random() * 99_999), at: "2020-01-01T00:00:00Z", status: "capture_off", expires: o.expires });
      const unbounded = await m({ expires: null });
      const future = await m({ expires: "2999-01-01T00:00:00Z" });
      const [audit] = await tx.select({ id: auditLog.id }).from(auditLog).orderBy(desc(auditLog.seq)).limit(1);
      const withAudit = await m({ auditId: audit!.id, expires: "2020-02-01T00:00:00Z" });
      const held = await m({ expires: "2020-02-01T00:00:00Z" });
      const free = await m({ expires: "2020-02-01T00:00:00Z" });
      await tx.execute(sql`insert into bom_retention_holds (scope, audit_id, hold_kind, created_by) values ('decision', ${held}, 'legal', ${users.admin.id})`);
      for (const [id, why] of [
        [unbounded, /within its retention/],
        [future, /within its retention/],
        [withAudit, /audit row still exists/],
        [held, /evidence hold covers the row/],
      ] as const) {
        await expectRefused(inSavepoint(tx, sql`delete from decision_capture_status where audit_id = ${id}`), why);
      }
      // positive control in the same pass
      await tx.execute(sql`delete from decision_capture_status where audit_id = ${free}`);
      // a hold is released once, never deleted or edited; then the row can go
      await expectRefused(inSavepoint(tx, sql`delete from bom_retention_holds where audit_id = ${held}`), /only ever released/);
      await expectRefused(inSavepoint(tx, sql`update bom_retention_holds set hold_kind = 'audit' where audit_id = ${held}`), /only ever released/);
      await tx.execute(sql`update bom_retention_holds set released_at = now(), released_by = ${users.admin.id} where audit_id = ${held}`);
      await tx.execute(sql`delete from decision_capture_status where audit_id = ${held}`);
    });
  });

  it("#280 (4237493040): a snapshot referenced only from retained facts is linked; renderings go only with their parent (R36)", async () => {
    await inRolledBackTx(async (tx) => {
      await tx.execute(sql`insert into bom_retention_prunes (as_of, counts) values (now(), '{}'::jsonb)`);
      const key = await receiptKey(tx);
      const linked = await insertSnapshot(tx, key, { createdAt: "2020-01-01T00:00:00Z", expires: "2020-02-01T00:00:00Z" });
      const free = await insertSnapshot(tx, key, { createdAt: "2020-01-01T00:00:00Z", expires: "2020-02-01T00:00:00Z" });
      const auditId = randomUUID();
      const f = factsFor(auditId, 900030, linked.id);
      await marker(tx, { auditId, seq: 900030, status: "captured", hash: bomDigestOf(f) });
      await insertFacts(tx, auditId, 900030, f, { snapshot: linked.id });
      // the facts row names the snapshot inside its hashed payload too
      await expectRefused(inSavepoint(tx, sql`insert into decision_facts (audit_id, audit_seq, facts, facts_hash, ai_bom_snapshot_id) values (${randomUUID()}, 900031, ${jsonb(f)}, ${bomDigestOf(f)}, ${free.id})`), /decision_facts_payload_check|capture-status marker|foreign key/);
      const rendering = (parent: string) =>
        sql`insert into bom_renderings (ai_bom_snapshot_id, format, bytes, sha256, validator) values (${parent}, 'cyclonedx-1.7', '{}', encode(sha256(convert_to('{}', 'UTF8')), 'hex'), 'cyclonedx bom-1.7 schema')`;
      await tx.execute(rendering(free.id));
      await expectRefused(inSavepoint(tx, sql`delete from bom_renderings where ai_bom_snapshot_id = ${free.id}`), /append-only/);
      await expectRefused(inSavepoint(tx, sql`update bom_renderings set validator = 'x' where ai_bom_snapshot_id = ${free.id}`), /append-only/);
      await expectRefused(inSavepoint(tx, sql`insert into bom_renderings (format, bytes, sha256, validator) values ('cyclonedx-1.7', '{}', encode(sha256(convert_to('{}', 'UTF8')), 'hex'), 'v')`), /bom_renderings_one_parent_check/);
      // the linked snapshot cannot be pruned while the facts are retained
      await expectRefused(inSavepoint(tx, sql`delete from ai_bom_snapshots where id = ${linked.id}`), /decision_facts_ai_bom_snapshot_id_fkey|foreign key/);
      // the free one goes, and its rendering with it
      await tx.execute(sql`delete from ai_bom_snapshots where id = ${free.id}`);
      expect(rows(await tx.execute(sql`select 1 from bom_renderings where ai_bom_snapshot_id = ${free.id}`))).toHaveLength(0);
    });
  });

  it("a subject hold keeps an expired snapshot", async () => {
    await inRolledBackTx(async (tx) => {
      await tx.execute(sql`insert into bom_retention_prunes (as_of, counts) values (now(), '{}'::jsonb)`);
      const key = await receiptKey(tx);
      const s = await insertSnapshot(tx, key, { createdAt: "2020-01-01T00:00:00Z", expires: "2020-02-01T00:00:00Z" });
      await tx.execute(sql`insert into bom_retention_holds (scope, subject_kind, subject_id, hold_kind, created_by) values ('ai_bom_subject', 'use_case', ${s.subjectId}, 'regulator_request', ${users.admin.id})`);
      await expectRefused(inSavepoint(tx, sql`delete from ai_bom_snapshots where id = ${s.id}`), /evidence hold covers the row/);
    });
  });

  it("the auditor grant is only ever revoked, once (§7 bom_export_roles)", async () => {
    await inRolledBackTx(async (tx) => {
      const g = await one<{ id: string }>(tx, sql`insert into bom_auditor_grants (user_id, granted_by) values (${users.member.id}, ${users.admin.id}) returning id`);
      await expectRefused(inSavepoint(tx, sql`insert into bom_auditor_grants (user_id, granted_by) values (${users.member.id}, ${users.admin.id})`), /bom_auditor_grants_active_uq/);
      await expectRefused(inSavepoint(tx, sql`delete from bom_auditor_grants where id = ${g.id}`), /only ever revoked/);
      await tx.execute(sql`update bom_auditor_grants set revoked_at = now(), revoked_by = ${users.admin.id} where id = ${g.id}`);
      await expectRefused(inSavepoint(tx, sql`update bom_auditor_grants set revoked_at = now() + interval '1 day' where id = ${g.id}`), /only ever revoked/);
    });
  });
});

// ---------------------------------------------------------------------------
describe("the lock targets (4237322632, 4237344247)", () => {
  async function contend(first: (tx: Tx) => Promise<unknown>, second: (tx: Tx) => Promise<unknown>): Promise<"waited" | "proceeded"> {
    const other = createDb(DATABASE_URL!);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let ready!: () => void;
    const isHeld = new Promise<void>((r) => (ready = r));
    const a = db.transaction(async (tx) => {
      await first(tx);
      ready();
      await held;
    });
    try {
      await isHeld;
      return await other
        .transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout = '300ms'`);
          await second(tx);
        })
        .then(
          () => "proceeded" as const,
          (e: unknown) => {
            expect(refusalText(e)).toMatch(/lock timeout/);
            return "waited" as const;
          },
        );
    } finally {
      release();
      await a;
      await other.$client.end();
    }
  }

  it("per subject: a second writer of the same subject waits; another subject does not", async () => {
    const s = randomUUID();
    expect(await contend((tx) => lockAiBomSubject(tx, "agent", s), (tx) => lockAiBomSubject(tx, "agent", s))).toBe("waited");
    expect(await contend((tx) => lockAiBomSubject(tx, "agent", s), (tx) => lockAiBomSubject(tx, "agent", randomUUID()))).toBe("proceeded");
    expect(await contend((tx) => lockAiBomSubject(tx, "agent", s), (tx) => lockAiBomSubject(tx, "use_case", s))).toBe("proceeded");
  });

  it("per decision: the capture-status marker row when one exists, else an advisory lock keyed by the audit id", async () => {
    const withMarker = await marker(db, { seq: 700000 + Math.floor(Math.random() * 99_999), at: "2020-01-01T00:00:00Z", status: "capture_off", expires: "2020-02-01T00:00:00Z" });
    try {
      await db.transaction(async (tx) => expect(await lockDecisionForBom(tx, withMarker)).toEqual({ target: "capture_marker" }));
      expect(await contend((tx) => lockDecisionForBom(tx, withMarker), (tx) => lockDecisionForBom(tx, withMarker))).toBe("waited");
      const legacy = randomUUID();
      await db.transaction(async (tx) => expect(await lockDecisionForBom(tx, legacy)).toEqual({ target: "advisory" }));
      expect(await contend((tx) => lockDecisionForBom(tx, legacy), (tx) => lockDecisionForBom(tx, legacy))).toBe("waited");
      expect(await contend((tx) => lockDecisionForBom(tx, legacy), (tx) => lockDecisionForBom(tx, randomUUID()))).toBe("proceeded");
    } finally {
      await db.transaction(async (tx) => {
        await tx.execute(sql`insert into bom_retention_prunes (as_of, counts) values (now(), '{}'::jsonb)`);
        await tx.execute(sql`delete from decision_capture_status where audit_id = ${withMarker}`);
      });
    }
  });
});

// ---------------------------------------------------------------------------
describe("receipt payload v2 (R34, R42, R43) on a scratch database: verified, never emitted", () => {
  const RECEIPT_DB = `a189_receipts_${RUN}`;
  let admin: Db;
  let rdb: Db;
  const dir = mkdtempSync(path.join(tmpdir(), "a189-receipts-"));
  const saved = { file: process.env.REGULAIT_RECEIPT_SIGNING_KEY, id: process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID };
  let author: string;
  beforeAll(async () => {
    admin = createDb(DATABASE_URL);
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${RECEIPT_DB} WITH (FORCE)`));
    await admin.execute(sql.raw(`CREATE DATABASE ${RECEIPT_DB}`));
    rdb = createDb(urlFor(RECEIPT_DB));
    await runMigrations(rdb, migrationsFolder);
    const file = path.join(dir, "receipt.pem");
    writeFileSync(file, generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    process.env.REGULAIT_RECEIPT_SIGNING_KEY = file;
    process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID = `a189-${RUN}`;
    author = randomUUID();
  }, 180_000);
  afterAll(async () => {
    if (saved.file === undefined) delete process.env.REGULAIT_RECEIPT_SIGNING_KEY;
    else process.env.REGULAIT_RECEIPT_SIGNING_KEY = saved.file;
    if (saved.id === undefined) delete process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID;
    else process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID = saved.id;
    await closeAll([
      async () => rdb?.$client.end(),
      async () => dropScratchDatabase(admin, RECEIPT_DB),
      async () => admin.$client.end(),
      async () => rmSync(dir, { recursive: true, force: true }),
    ]);
  });
  const decision = async () => {
    const [row] = await rdb.insert(auditLog).values({ userId: author, objectType: "mcp_tool", effect: "allow", ruleId: "a189-policy", ruleChain: [], reason: "synthetic", detail: { receiptClass: "decision" } }).returning();
    return row!;
  };
  const receiptOf = async (auditId: string) => (await rdb.select().from(decisionReceipts).where(eq(decisionReceipts.auditId, auditId)))[0];

  it("NEGATIVE CONTROL: with no boundary the sweep still emits a v1 receipt, and the build boots", async () => {
    const row = await decision();
    expect((await runDecisionReceiptSignSweep(rdb)).state).toBe("signing");
    expect(((await receiptOf(row.id))!.payload as { v: string }).v).toBe(RECEIPT_PAYLOAD_VERSION);
    await assertReceiptEmitterBootable(rdb);
  });

  it("after a recorded boundary: v1 only below it, the database refuses the wrong version, and the gateway refuses to boot", async () => {
    const below = await decision();
    const tip = await one<{ s: string }>(rdb, sql`select max(seq)::bigint as s from audit_log`);
    const boundary = Number(tip.s) + 1;
    await rdb.execute(sql`insert into receipt_payload_versions (version, from_audit_seq) values (2, ${boundary})`);
    await expectRefused(rdb.execute(sql`delete from receipt_payload_versions`), /append-only/);
    const above = await decision();
    expect(above.seq!).toBeGreaterThanOrEqual(boundary);
    await runDecisionReceiptSignSweep(rdb);
    expect(((await receiptOf(below.id))!.payload as { v: string }).v).toBe(RECEIPT_PAYLOAD_VERSION);
    expect(await receiptOf(above.id)).toBeUndefined();

    // the export carries the boundary the offline verifier needs
    const exported = buildApp(rdb, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
    try {
      const res = await exported.inject({ method: "GET", url: "/v1/receipts/export", headers: AUTH });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().receiptV2FromAuditSeq).toBe(boundary);
    } finally {
      await exported.close();
    }

    const [last] = await rdb.select().from(decisionReceipts).orderBy(desc(decisionReceipts.receiptSeq)).limit(1);
    const payload = (v: string, seq: number, extra: Record<string, unknown> = {}) => ({
      v, receiptSeq: last!.receiptSeq + 1, audit: { id: above.id, seq, rowHash: H("1"), contentHash: H("2") },
      decision: {}, prev: last!.payloadHash, keyId: last!.keyId, ...extra,
    });
    const insert = (p: Record<string, unknown>, seq: number) =>
      sql`insert into decision_receipts (receipt_seq, audit_id, audit_seq, payload, payload_hash, prev_hash, signature, key_id)
          values (${last!.receiptSeq + 1}, ${above.id}, ${seq}, ${jsonb(p)}, ${H("7")}, ${last!.payloadHash}, ${SIG}, ${last!.keyId})`;
    const v2 = (status: "captured" | "capture_off", hash: string | null) => ({ actor: { identityId: null, delegationGrantId: null, chain: null }, factsStatus: status, factsHash: hash });
    await inRolledBackTx(async (tx) => {
      await expectRefused(inSavepoint(tx, insert(payload(RECEIPT_PAYLOAD_VERSION, above.seq!), above.seq!)), /v1 receipt at or above the recorded v2 boundary/);
      await expectRefused(inSavepoint(tx, insert(payload(RECEIPT_PAYLOAD_VERSION_V2, above.seq!, v2("capture_off", null)), above.seq!)), /does not match its capture-status marker/);
      await expectRefused(inSavepoint(tx, insert(payload(RECEIPT_PAYLOAD_VERSION_V2, below.seq!, v2("capture_off", null)), below.seq!)), /below the recorded boundary/);
      await expectRefused(inSavepoint(tx, insert(payload(RECEIPT_PAYLOAD_VERSION_V2, above.seq!, v2("captured", null)), above.seq!)), /decision_receipts_payload_check|does not match its capture-status marker/);
      await marker(tx, { auditId: above.id, seq: above.seq!, status: "capture_off" });
      await tx.execute(insert(payload(RECEIPT_PAYLOAD_VERSION_V2, above.seq!, v2("capture_off", null)), above.seq!));
    }, rdb);

    // R43: this build cannot emit v2, so it refuses to boot
    await expectRefused(assertReceiptEmitterBootable(rdb), /refusing to start/i);
    await expect(assertReceiptEmitterBootable(rdb, true)).resolves.toBeUndefined();
    const lines: string[] = [];
    const started = await startGateway({ db: rdb, migrationsFolder, port: 0, host: "127.0.0.1", log: (l) => lines.push(l), env: { NODE_ENV: "test" }, bootstrapToken: BOOT, dataKey: "a".repeat(64) }).then(
      (g) => g,
      (e: unknown) => e,
    );
    if (!(started instanceof ReceiptV2BootError)) {
      if (started && typeof started === "object" && "app" in started) await (started as { app: { close: () => Promise<void> } }).app.close();
    }
    expect(started).toBeInstanceOf(ReceiptV2BootError);
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0189 §9: every route is a 501 stub under the admin route class", () => {
  const url = (p: string) => p.replace(":subjectKind", "agent").replace(/:[A-Za-z]+/g, randomUUID());
  it("the route classes, stability and tags agree with BOM_ROUTES", () => {
    for (const r of BOM_ROUTES) {
      const [method, p] = r.split(" ") as [string, string];
      expect(routeAuthClass(method, p), r).toBe("admin");
      expect(ROUTE_STABILITY[r], r).toBe("internal");
      expect(ROUTE_TAGS[r], r).toBe("audit");
    }
  });
  it("each answers 501 not_built to an admin, 403 to a member and 401 with no credential", async () => {
    for (const r of BOM_ROUTES) {
      const [method, p] = r.split(" ") as [Method, string];
      const body = method === "POST" ? {} : undefined;
      const ok = await inject(method, url(p), users.admin.auth, body);
      expect(ok.statusCode, `${r}: ${ok.body}`).toBe(501);
      expect(ok.json(), r).toEqual({ error: "not_built" });
      expect((await inject(method, url(p), users.member.auth, body)).statusCode, r).toBe(403);
      expect((await inject(method, url(p), {}, body)).statusCode, r).toBe(401);
    }
  });
});
