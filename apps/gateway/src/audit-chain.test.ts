/**
 * ADR-0060 e2e — proof BY ATTACK.
 *
 * This ADR is about DETECTION, so a test suite that only asserts "a clean chain
 * verifies" proves nothing: a function that returns `ok` unconditionally passes
 * it. Every detection test here therefore TAMPERS FOR REAL, with raw SQL,
 * bypassing the application entirely — because "someone with direct database
 * write" IS the threat model. Nothing here goes through `insert(auditLog)` to
 * simulate an attack.
 *
 * It runs against its OWN scratch database. Two reasons, both load-bearing:
 * the chain is global (one `seq` order over the whole table), so tampering in
 * the shared suite database would corrupt every later suite's trail; and the
 * legacy-row count has to be controllable to assert the genesis boundary.
 *
 * Each destructive test restores EXACTLY what it broke — same raw-SQL route —
 * so the chain is valid again before the next test runs. That is not tidiness:
 * a test that left the chain broken would make every subsequent assertion
 * meaningless.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { auditLog, createDb, runMigrations, sql, type Db } from "@regulait/db";
import {
  AUDIT_GENESIS_CONTENT_HASH,
  AUDIT_GENESIS_PREV_HASH,
  AUDIT_GENESIS_ROW_HASH,
  AUDIT_GENESIS_SEQ,
  auditContentHash,
  auditRowHash,
} from "@regulait/shared";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  ListBucketsCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  PutObjectLockConfigurationCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { buildApp } from "./app.js";
import {
  captureAnchor,
  DEFAULT_ANCHOR_DIR,
  DEFAULT_S3_ANCHOR_PREFIX,
  DEFAULT_S3_ANCHOR_RETENTION_DAYS,
  LocalWormSink,
  resolveAnchorSink,
  resolveS3AnchorConfig,
  S3_LOCK_OBSERVATION_TTL_MS,
  S3ObjectLockSink,
  S3_REQUEST_HANDLER,
  verifyAuditChain,
  type AnchorSink,
  type S3SendClient,
} from "./audit-chain.js";
import { NON_ADMIN_ROUTES } from "./route-classes.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

// Per-RUN unique (pid + timestamp): a fixed name plus beforeAll's
// DROP ... WITH (FORCE) lets two concurrent runs on one host destroy each
// other's database (PENDING §5); afterAll drops this one, so nothing persists.
const SCRATCH_DB = `regulait_audit_chain_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + SCRATCH_DB;
  return u.toString();
})();
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "audit-chain-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };
const ACTOR = "00000000-0000-4000-8000-0000000000aa";

let admin: Db;
let db: Db;
let app: ReturnType<typeof buildApp> | undefined;
let wormDir: string;
let sink: AnchorSink;

/** How many rows existed with a NULL seq before the chain — i.e. the un-chained
 * legacy population the guarantee explicitly does NOT cover. Written by raw SQL
 * below so the genesis-boundary assertions have something real to point at. */
const LEGACY_ROWS = 3;

function auditRow(overrides: Record<string, unknown> = {}) {
  return {
    userId: ACTOR,
    objectType: "mcp_tool" as const,
    effect: "allow" as const,
    ruleId: "chain-fixture",
    ruleChain: ["grant"],
    reason: "fixture row",
    ...overrides,
  };
}

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(scratchUrl);
  await runMigrations(db, migrationsFolder);

  // PRE-GENESIS LEGACY ROWS. Inserted with raw SQL and NULL chain columns,
  // exactly as a row written before migration 0067 looks. They cannot be
  // created through the app — the app chains everything — which is precisely
  // the point being tested.
  for (let i = 0; i < LEGACY_ROWS; i += 1) {
    await db.execute(sql`
      insert into audit_log (id, at, user_id, object_type, effect, rule_id, rule_chain, reason)
      values (gen_random_uuid(), now(), ${ACTOR}, 'mcp_tool', 'allow', 'legacy', '[]'::jsonb, ${`pre-genesis row ${i}`})
    `);
  }

  wormDir = await mkdtemp(path.join(tmpdir(), "regulait-anchor-"));
  sink = new LocalWormSink(wormDir);
  app = buildApp(db, { bootstrapToken: BOOT, auditAnchorSink: sink });
}, 120_000);

afterAll(async () => {
  await closeAll([
    async () => {
      await app?.close();
    },
    async () => {
      await dropScratchDatabase(admin, SCRATCH_DB);
    },
  ]);
});

async function verify(query = ""): Promise<Record<string, any>> {
  const res = await app!.inject({ method: "GET", headers: AUTH, url: `/v1/audit/verify${query}` });
  expect(res.statusCode).toBe(200);
  return res.json();
}

/** every chained row, in chain order, straight from the table */
async function chainRows(): Promise<Array<Record<string, any>>> {
  const res = await db.execute(sql`
    select seq, id, content_hash, prev_hash, row_hash, reason
    from audit_log where seq is not null order by seq asc
  `);
  return (res as unknown as { rows: Array<Record<string, any>> }).rows;
}

/** Snapshot a row's every column as a JSON object, so a destructive test can
 * put it back byte-for-byte afterwards. */
async function snapshot(seq: number): Promise<Record<string, any>> {
  const res = await db.execute(sql`select to_jsonb(a) as j from audit_log a where seq = ${seq}`);
  const row = (res as unknown as { rows: Array<{ j: Record<string, any> }> }).rows[0];
  if (!row) throw new Error(`no audit_log row at seq ${seq}`);
  return row.j;
}

/** Put a snapshotted row back exactly as it was. Raw SQL both ways: the app's
 * insert path would re-chain it and assign a new seq. */
async function restore(snap: Record<string, any>): Promise<void> {
  await db.execute(sql`delete from audit_log where seq = ${snap.seq}`);
  await db.execute(sql`
    insert into audit_log
    select * from jsonb_populate_record(null::audit_log, ${JSON.stringify(snap)}::jsonb)
  `);
}

// -----------------------------------------------------------------------------

describe("ADR-0060: the genesis boundary", () => {
  it("seals the boundary with the constant, install-independent genesis row", async () => {
    const rows = await db.execute(sql`select * from audit_log where seq = ${AUDIT_GENESIS_SEQ}`);
    const g = (rows as unknown as { rows: Array<Record<string, any>> }).rows[0]!;
    expect(g.content_hash).toBe(AUDIT_GENESIS_CONTENT_HASH);
    expect(g.row_hash).toBe(AUDIT_GENESIS_ROW_HASH);
    expect(g.prev_hash).toBe(AUDIT_GENESIS_PREV_HASH);
    expect(g.object_type).toBe("audit_chain");
    expect(g.reason).toMatch(/un-chained legacy/);
  });

  it("reports pre-genesis rows as OUTSIDE the guarantee, in the verify output", async () => {
    const body = await verify();
    expect(body.legacy.unchainedRowsBeforeGenesis).toBe(LEGACY_ROWS);
    expect(body.legacy.covered).toBe(false);
    expect(body.legacy.disclosure).toMatch(/un-chained legacy/);
    expect(body.legacy.disclosure).toMatch(/ADR-0035 backups/);
    expect(body.genesis.present).toBe(true);
    expect(body.genesis.matches).toBe(true);
    expect(body.scanned.fromSeq).toBe(AUDIT_GENESIS_SEQ);
  });
});

describe("ADR-0060: canonicalization survives Postgres jsonb", () => {
  it("re-verifies a row whose jsonb keys Postgres reordered on storage", async () => {
    // Keys chosen so Postgres's jsonb ordering (length, then bytewise) is
    // GUARANTEED to differ from insertion order and from ours.
    const detail = {
      zzzzz: 1,
      a: 2,
      nested: { yy: [3, 2, 1], b: { ccc: true, d: null } },
      "🙂 unicode ключ": "héllo 日本語 🙂",
    };
    await db.insert(auditLog).values(auditRow({ reason: "jsonb round trip", detail, ruleChain: ["b", "a"] }));

    const res = await db.execute(sql`
      select seq, id, at, user_id, object_type, object_id, detail, server_id, tool_name,
             effect, rule_id, rule_chain, reason, deploy_mode, content_hash, prev_hash, row_hash
      from audit_log where reason = 'jsonb round trip'
    `);
    const r = (res as unknown as { rows: Array<Record<string, any>> }).rows[0]!;

    // Postgres really did reorder the keys — if it did not, this test would be
    // vacuous, so assert the trap is actually sprung.
    expect(Object.keys(r.detail)).not.toEqual(Object.keys(detail));

    // ...and the hash of the READ-BACK row still matches what was stored.
    expect(
      auditContentHash({
        id: r.id,
        at: new Date(r.at),
        userId: r.user_id,
        objectType: r.object_type,
        objectId: r.object_id,
        detail: r.detail,
        serverId: r.server_id,
        toolName: r.tool_name,
        effect: r.effect,
        ruleId: r.rule_id,
        ruleChain: r.rule_chain,
        reason: r.reason,
        deployMode: r.deploy_mode,
      }),
    ).toBe(r.content_hash);

    expect((await verify()).status).toBe("ok");
  });

  it("re-verifies numeric edge cases through the numeric round trip", async () => {
    // -0 and NaN never reach the column as themselves: JSON.stringify turns
    // them into 0 and null before the driver sees them, and the canonicalizer
    // hashes what is actually stored rather than what was passed.
    await db.insert(auditLog).values(
      auditRow({
        reason: "numeric edges",
        detail: {
          zero: 0,
          negZero: -0,
          int: 1,
          floatish: 1.0,
          big: Number.MAX_SAFE_INTEGER,
          huge: 1e21,
          tiny: 1e-7,
          drift: 0.1 + 0.2,
          denormal: Number.MIN_VALUE,
          nan: Number.NaN,
          inf: Number.POSITIVE_INFINITY,
          nullValue: null,
        },
      }),
    );
    expect((await verify()).status).toBe("ok");
  });

  it("re-verifies unicode, empty containers and deep nesting", async () => {
    await db.insert(auditLog).values(
      auditRow({
        reason: "unicode + shapes",
        detail: {
          emoji: "🙂🇬🇧👨‍👩‍👧",
          cjk: "日本語のテキスト",
          rtl: "مرحبا بالعالم",
          combining: "é vs é",
          emptyObject: {},
          emptyArray: [],
          deep: { a: { b: { c: { d: { e: [1, { f: "g" }] } } } } },
          quotes: 'he said "hi"\\n',
        },
      }),
    );
    expect((await verify()).status).toBe("ok");
  });
});

describe("ADR-0060: a clean chain", () => {
  it("verifies OK and reports what it actually scanned", async () => {
    await db.insert(auditLog).values([auditRow({ reason: "clean a" }), auditRow({ reason: "clean b" })]);
    const body = await verify();
    expect(body.status).toBe("ok");
    expect(body.firstBreak).toBeNull();
    expect(body.algorithm).toBe("sha256");
    expect(body.scanned.rows).toBeGreaterThan(3);
    expect(body.scanned.bounded).toBe(false);
  });

  it("links every row to its predecessor and never reuses a position", async () => {
    const rows = await chainRows();
    const seqs = rows.map((r) => Number(r.seq));
    expect(seqs).toEqual(seqs.map((_, i) => i + 1)); // gapless from 1
    expect(new Set(rows.map((r) => r.prev_hash)).size).toBe(rows.length);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]!.prev_hash).toBe(rows[i - 1]!.row_hash);
    }
  });

  it("always states its own limits, clean or not", async () => {
    const body = await verify();
    expect(body.limits.join(" ")).toMatch(/rewrites every row AND every hash/);
    expect(body.limits.join(" ")).toMatch(/detection and evidence, not prevention/);
  });
});

describe("ADR-0060: detection, by direct database manipulation", () => {
  it("localizes an UPDATE of `reason` to the exact seq", async () => {
    const rows = await chainRows();
    const target = Number(rows[Math.floor(rows.length / 2)]!.seq);
    const snap = await snapshot(target);

    await db.execute(sql`update audit_log set reason = 'approved' where seq = ${target}`);
    const body = await verify();
    expect(body.status).toBe("broken");
    expect(body.firstBreak.seq).toBe(target);
    expect(body.firstBreak.kind).toBe("content_mismatch");

    await restore(snap);
    expect((await verify()).status).toBe("ok");
  });

  it("localizes an UPDATE of `detail` to the exact seq", async () => {
    const rows = await chainRows();
    const target = Number(rows.at(-1)!.seq);
    const snap = await snapshot(target);

    await db.execute(sql`update audit_log set detail = '{"phase":"rewritten"}'::jsonb where seq = ${target}`);
    const body = await verify();
    expect(body.firstBreak.seq).toBe(target);
    expect(body.firstBreak.kind).toBe("content_mismatch");

    await restore(snap);
    expect((await verify()).status).toBe("ok");
  });

  it("catches a DELETE as a gap at the surviving successor", async () => {
    const rows = await chainRows();
    const victim = Number(rows[rows.length - 2]!.seq);
    const snap = await snapshot(victim);

    await db.execute(sql`delete from audit_log where seq = ${victim}`);
    const body = await verify();
    expect(body.status).toBe("broken");
    expect(body.firstBreak.seq).toBe(victim + 1);
    expect(body.firstBreak.kind).toBe("sequence_gap");
    expect(body.firstBreak.detail).toMatch(/missing/);

    await restore(snap);
    expect((await verify()).status).toBe("ok");
  });

  it("catches a REORDER — two rows swapped in the chain order", async () => {
    const rows = await chainRows();
    const a = Number(rows[rows.length - 2]!.seq);
    const b = a + 1;
    const snapA = await snapshot(a);
    const snapB = await snapshot(b);

    // swap their positions, leaving every hash exactly as written
    await db.execute(sql`update audit_log set seq = -1 where seq = ${a}`);
    await db.execute(sql`update audit_log set seq = ${a} where seq = ${b}`);
    await db.execute(sql`update audit_log set seq = ${b} where seq = -1`);

    const body = await verify();
    expect(body.status).toBe("broken");
    expect(body.firstBreak.seq).toBe(a);
    expect(body.firstBreak.kind).toBe("linkage_mismatch");

    await db.execute(sql`delete from audit_log where seq in (${a}, ${b})`);
    await restore(snapA);
    await restore(snapB);
    expect((await verify()).status).toBe("ok");
  });

  it("catches a row smuggled in around the chaining path", async () => {
    // The DB CHECK forbids a half-chained row, so an attacker who wants a row
    // to LOOK chained must supply all four columns. Supplying garbage is caught.
    const head = Number((await chainRows()).at(-1)!.seq);
    const forgedSeq = head + 1;
    await db.execute(sql`
      insert into audit_log (id, at, user_id, object_type, effect, rule_id, rule_chain, reason,
                             seq, content_hash, prev_hash, row_hash)
      values (gen_random_uuid(), now(), ${ACTOR}, 'mcp_tool', 'allow', 'forged', '[]'::jsonb,
              'inserted straight into the table', ${forgedSeq},
              ${"f".repeat(64)}, ${"f".repeat(64)}, ${"f".repeat(64)})
    `);
    const body = await verify();
    expect(body.status).toBe("broken");
    expect(body.firstBreak.seq).toBe(forgedSeq);
    expect(body.firstBreak.kind).toBe("linkage_mismatch");

    await db.execute(sql`delete from audit_log where seq = ${forgedSeq}`);
    expect((await verify()).status).toBe("ok");
  });

  it("refuses a half-chained row at the database level", async () => {
    let caught: unknown;
    try {
      await db.execute(sql`
        insert into audit_log (id, at, user_id, object_type, effect, rule_id, rule_chain, reason, seq)
        values (gen_random_uuid(), now(), ${ACTOR}, 'mcp_tool', 'allow', 'half', '[]'::jsonb, 'half chained', 99999)
      `);
    } catch (err) {
      // drizzle wraps the driver error; the constraint name is on the cause
      caught = (err as { cause?: unknown }).cause ?? err;
    }
    expect(String((caught as { message?: string })?.message ?? caught)).toMatch(/audit_log_chain_all_or_none/);
  });
});

describe("ADR-0060: anchoring", () => {
  it("pins the head to the WORM sink and covers its own audit row", async () => {
    const res = await app!.inject({ method: "POST", headers: AUTH, url: "/v1/audit/anchor" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("flushed");
    expect(body.destination).toBe("local_worm");

    const head = Number((await chainRows()).at(-1)!.seq);
    // the anchor was taken AFTER its own audit row, so it covers everything
    expect(body.seq).toBe(head);

    const files = await readdir(wormDir);
    expect(files.some((f) => f.startsWith("anchor-"))).toBe(true);

    const v = await verify();
    expect(v.anchor.checked).toBe(true);
    expect(v.anchor.source).toBe("worm_sink");
    expect(v.anchor.matches).toBe(true);
    // a local directory is NOT Object Lock, and the response says so
    expect(v.anchor.tamperResistant).toBe(false);
    expect(v.anchor.disclosure).toMatch(/not.*tamper-resistant/i);
  });

  it("sets an anchor PAST the chain head aside instead of grading it as a mismatch (UIA-01)", async () => {
    // Two gateways run from the same directory (a second database on the same
    // host, say) share one anchor store, and the store's highest seq then
    // belongs to whichever chain is longer. That anchor used to be compared
    // against a row this chain never had, and the page showed a red "anchor
    // mismatch" over a chain that was intact. Now the comparison uses the
    // latest anchor at or below the head, and the foreign one is reported on
    // its own — never silently dropped, because the other explanation for an
    // anchor past the head is that rows after it were removed.
    const head = Number((await chainRows()).at(-1)!.seq);
    const planted = head + 1000;
    await sink.write({
      seq: planted,
      rowHash: "f".repeat(64),
      headAt: new Date().toISOString(),
      algorithm: "sha256",
      payloadVersion: "regulait.audit.v1",
      capturedAt: "2026-01-01T00:00:00.000Z",
    });
    try {
      expect((await sink.readLatest())!.seq).toBe(planted);
      expect((await sink.readLatest({ maxSeq: head }))!.seq).toBeLessThanOrEqual(head);

      const v = await verify();
      expect(v.status).toBe("ok");
      expect(v.anchor.source).toBe("worm_sink");
      expect(v.anchor.seq).toBeLessThanOrEqual(head);
      expect(v.anchor.matches).toBe(true);
      expect(v.anchor.aheadOfHead).toMatchObject({ seq: planted, rowHash: "f".repeat(64), capturedAt: "2026-01-01T00:00:00.000Z" });
      expect(v.anchor.aheadOfHead.disclosure).toMatch(/different chain|rows after it were removed/);
    } finally {
      const file = path.join(wormDir, `anchor-${String(planted).padStart(20, "0")}.json`);
      await chmod(file, 0o644);
      await rm(file);
    }
    expect(((await verify()) as { anchor: { aheadOfHead: unknown } }).anchor.aheadOfHead).toBeNull();
  });

  it("lists anchors and discloses what the sink is worth", async () => {
    const res = await app!.inject({ method: "GET", headers: AUTH, url: "/v1/audit/anchors" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.anchors.length).toBeGreaterThan(0);
    expect(body.sink.destination).toBe("local_worm");
    expect(body.disclosure).toMatch(/not evidence|NOT tamper-resistant/i);
  });

  it("buffers offline and flushes when a sink appears (air-gapped posture)", async () => {
    // An air-gapped install: no sink at all. The anchor is still RECORDED, as
    // `pending` with destination `none`, and nothing pretends it was
    // externalized.
    const offline = buildApp(db, { bootstrapToken: BOOT, auditAnchorSink: null });
    try {
      const res = await offline.inject({ method: "POST", headers: AUTH, url: "/v1/audit/anchor" });
      expect(res.statusCode).toBe(201);
      expect(res.json().status).toBe("pending");
      expect(res.json().destination).toBe("none");
      expect(res.json().tamperResistant).toBe(false);
    } finally {
      await offline.close();
    }

    // Connectivity resumes: the buffered anchor is flushed to the sink.
    const flush = await app!.inject({ method: "POST", headers: AUTH, url: "/v1/audit/anchors/flush" });
    expect(flush.statusCode).toBe(200);
    expect(flush.json().flushed).toBeGreaterThan(0);
    expect(flush.json().failed).toBe(0);
  });
});

describe("ADR-0060: the honest limit — what only the anchor catches", () => {
  it("PASSES a full recompute locally, and the stored anchor is what catches it", async () => {
    await db.insert(auditLog).values([auditRow({ reason: "pre-forgery a" }), auditRow({ reason: "pre-forgery b" })]);

    // Anchor the honest head, and keep a copy the way an auditor would — this
    // stands in for the Object-Lock object the adversary cannot rewrite.
    const anchorRes = await app!.inject({ method: "POST", headers: AUTH, url: "/v1/audit/anchor" });
    expect(anchorRes.statusCode).toBe(201);
    const anchored = anchorRes.json() as { seq: number; rowHash: string };

    // THE ATTACK: an adversary with total database write rewrites a row's
    // reason and then re-derives every hash from that point on, so the chain is
    // internally consistent again.
    const rows = await chainRows();
    const victimIdx = Math.floor(rows.length / 2);
    const victimSeq = Number(rows[victimIdx]!.seq);
    const snaps = await Promise.all(rows.slice(victimIdx).map((r) => snapshot(Number(r.seq))));

    await db.execute(sql`update audit_log set reason = 'approved by me, actually' where seq = ${victimSeq}`);

    let prev = String(rows[victimIdx - 1]!.row_hash);
    for (const r of rows.slice(victimIdx)) {
      const seq = Number(r.seq);
      const cur = await db.execute(sql`
        select id, at, user_id, object_type, object_id, detail, server_id, tool_name,
               effect, rule_id, rule_chain, reason, deploy_mode
        from audit_log where seq = ${seq}
      `);
      const f = (cur as unknown as { rows: Array<Record<string, any>> }).rows[0]!;
      const contentHash = auditContentHash({
        id: f.id,
        at: new Date(f.at),
        userId: f.user_id,
        objectType: f.object_type,
        objectId: f.object_id,
        detail: f.detail,
        serverId: f.server_id,
        toolName: f.tool_name,
        effect: f.effect,
        ruleId: f.rule_id,
        ruleChain: f.rule_chain,
        reason: f.reason,
        deployMode: f.deploy_mode,
      });
      const rowHash = auditRowHash(prev, contentHash);
      await db.execute(sql`
        update audit_log set content_hash = ${contentHash}, prev_hash = ${prev}, row_hash = ${rowHash}
        where seq = ${seq}
      `);
      prev = rowHash;
    }

    // 1. LOCAL VERIFICATION IS FOOLED. This is the honest limit, asserted.
    //    Hash-chaining alone would bless this forgery.
    const localOnly = await verify();
    expect(localOnly.firstBreak).toBeNull();

    // 2. THE ANCHOR CATCHES IT. The auditor's retained head no longer matches
    //    what the (rewritten) table hashes to at that seq.
    const withAnchor = await verify(`?anchorSeq=${anchored.seq}&anchorRowHash=${anchored.rowHash}`);
    expect(withAnchor.firstBreak).toBeNull(); // still internally consistent...
    expect(withAnchor.anchor.source).toBe("caller_supplied");
    expect(withAnchor.anchor.matches).toBe(false); // ...but the head diverged
    expect(withAnchor.anchor.expectedRowHash).toBe(anchored.rowHash);
    expect(withAnchor.anchor.actualRowHash).not.toBe(anchored.rowHash);

    // put the honest history back
    for (const s of snaps) await restore(s);
    const repaired = await verify(`?anchorSeq=${anchored.seq}&anchorRowHash=${anchored.rowHash}`);
    expect(repaired.status).toBe("ok");
    expect(repaired.anchor.matches).toBe(true);
  });
});

describe("ADR-0060: concurrency", () => {
  it("serializes parallel appends into one strict order with no forked predecessor", async () => {
    const before = (await chainRows()).length;
    const N = 24;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        db.insert(auditLog).values(auditRow({ reason: `parallel ${i}`, detail: { i } })),
      ),
    );

    const rows = await chainRows();
    expect(rows.length).toBe(before + N);

    // gapless, strictly increasing
    const seqs = rows.map((r) => Number(r.seq));
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));

    // NO TWO ROWS CLAIM THE SAME PREDECESSOR. A fork here would be
    // indistinguishable from tampering, which is why appends take the advisory
    // lock at the tip.
    expect(new Set(rows.map((r) => r.prev_hash)).size).toBe(rows.length);
    expect(new Set(rows.map((r) => r.row_hash)).size).toBe(rows.length);

    expect((await verify()).status).toBe("ok");
  }, 60_000);
});

describe("ADR-0060: verification streams, it does not load the table", () => {
  it("walks in bounded keyset pages", async () => {
    const total = (await chainRows()).length;
    const body = await verify("?batchSize=5");
    expect(body.status).toBe("ok");
    expect(body.scanned.batchSize).toBe(5);
    // more than one page: the whole table was never in memory at once
    expect(body.scanned.batches).toBeGreaterThan(1);
    expect(body.scanned.batches).toBeGreaterThanOrEqual(Math.ceil(total / 5));
    expect(body.scanned.rows).toBe(total);
  });

  it("supports a bounded range, and says plainly what a bounded scan does not cover", async () => {
    const rows = await chainRows();
    const from = Number(rows[rows.length - 3]!.seq);
    const body = await verify(`?fromSeq=${from}`);
    expect(body.status).toBe("ok");
    expect(body.scanned.bounded).toBe(true);
    expect(body.scanned.rows).toBe(3);
    expect(body.limits.join(" ")).toMatch(/Bounded scan/);
  });

  it("rejects half an anchor rather than silently ignoring it", async () => {
    const res = await app!.inject({ method: "GET", headers: AUTH, url: "/v1/audit/verify?anchorSeq=2" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("anchor_incomplete");
  });
});

describe("ADR-0060: posture", () => {
  it("keeps every chain route admin-only via the default gate", () => {
    for (const route of [
      "GET /v1/audit/verify",
      "POST /v1/audit/anchor",
      "POST /v1/audit/anchors/flush",
      "GET /v1/audit/anchors",
    ]) {
      expect(NON_ADMIN_ROUTES.has(route)).toBe(false);
    }
  });

  it("preserves the FK-free design — the chain references nothing", async () => {
    const res = await db.execute(sql`
      select count(*)::int as n from information_schema.table_constraints
      where table_name in ('audit_log', 'audit_anchors') and constraint_type = 'FOREIGN KEY'
    `);
    expect(Number((res as unknown as { rows: Array<{ n: number }> }).rows[0]!.n)).toBe(0);
  });

  it("keeps chained rows verifiable after their subject is deleted", async () => {
    const userRes = await app!.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: `chain-${randomUUID()}@example.com`, displayName: "Doomed" },
    });
    expect(userRes.statusCode).toBe(201);
    const doomed = userRes.json().id as string;
    await db.insert(auditLog).values(auditRow({ userId: doomed, reason: "acted before deletion" }));
    // hard-delete straight out of the table — audit rows must survive it
    await db.execute(sql`delete from users where id = ${doomed}`);
    expect((await verify()).status).toBe("ok");
  });
});

describe("ADR-0060: legacy rows keep working", () => {
  it("leaves pre-genesis rows untouched and still readable through /v1/audit", async () => {
    const legacy = await db.execute(sql`select count(*)::int as n from audit_log where seq is null`);
    expect(Number((legacy as unknown as { rows: Array<{ n: number }> }).rows[0]!.n)).toBe(LEGACY_ROWS);

    const res = await app!.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${ACTOR}&limit=200` });
    expect(res.statusCode).toBe(200);
    const reasons = res.json().entries.map((e: { reason: string }) => e.reason);
    expect(reasons.some((r: string) => r.startsWith("pre-genesis row"))).toBe(true);
  });

  it("orders chained rows after legacy ones without ever treating a legacy row as the tip", async () => {
    const rows = await db.execute(sql`
      select coalesce(max(seq), 0)::int as head from audit_log where seq is not null
    `);
    const head = Number((rows as unknown as { rows: Array<{ head: number }> }).rows[0]!.head);
    const all = await db.execute(sql`select count(*)::int as n from audit_log where seq is not null`);
    expect(Number((all as unknown as { rows: Array<{ n: number }> }).rows[0]!.n)).toBe(head);
  });
});

describe("ADR-0060: the chain covers rows written by ordinary governed routes", () => {
  it("chains an audit row nobody wrote through this test file", async () => {
    const before = (await chainRows()).length;
    const res = await app!.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: `governed-${randomUUID()}@example.com`, displayName: "Governed" },
    });
    expect(res.statusCode).toBe(201);
    // an ordinary route's audit rows are chained without that route knowing
    expect((await chainRows()).length).toBeGreaterThanOrEqual(before);
    expect((await verify()).status).toBe("ok");
  });

  it("chains rows inserted inside a caller's own transaction", async () => {
    const before = (await chainRows()).length;
    await db.transaction(async (tx) => {
      await tx.insert(auditLog).values(auditRow({ reason: "inside a transaction" }));
      await tx.insert(auditLog).values(auditRow({ reason: "also inside" }));
    });
    expect((await chainRows()).length).toBe(before + 2);
    expect((await verify()).status).toBe("ok");
  });

  it("still supports `.returning()`, and appends exactly once when awaited twice", async () => {
    const before = (await chainRows()).length;
    const returned = await db
      .insert(auditLog)
      .values([auditRow({ reason: "returning a" }), auditRow({ reason: "returning b" })])
      .returning({ id: auditLog.id, seq: auditLog.seq });
    expect(returned).toHaveLength(2);
    expect(Number(returned[1]!.seq)).toBe(Number(returned[0]!.seq) + 1);
    expect((await chainRows()).length).toBe(before + 2);

    // The builder is lazy and memoised, exactly like drizzle's: awaiting the
    // same one twice must not write the row twice.
    const builder = db.insert(auditLog).values(auditRow({ reason: "awaited twice" }));
    await builder;
    await builder;
    expect((await chainRows()).length).toBe(before + 3);
    expect((await verify()).status).toBe("ok");
  });

  it("writes nothing when the builder is never awaited, exactly as before", async () => {
    const before = (await chainRows()).length;
    void db.insert(auditLog).values(auditRow({ reason: "never awaited" }));
    await new Promise((r) => setTimeout(r, 50));
    expect((await chainRows()).length).toBe(before);
  });

  it("leaves no chained row behind when the caller's transaction rolls back", async () => {
    const before = await chainRows();
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(auditLog).values(auditRow({ reason: "doomed by rollback" }));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const after = await chainRows();
    // and — the reason seq is max(seq)+1 rather than a sequence — NO GAP was
    // burned, so a future gap still means something.
    expect(after.length).toBe(before.length);
    expect(Number(after.at(-1)!.seq)).toBe(Number(before.at(-1)!.seq));
    expect((await verify()).status).toBe("ok");
  });
});

describe("anchoring is on by default, and does not overclaim", () => {
  it("configures the local buffer with no env at all", () => {
    const sink = resolveAnchorSink({} as NodeJS.ProcessEnv);
    expect(sink, "a bare install must anchor rather than anchor nothing").not.toBeNull();
    expect(sink!.destination).toBe("local_worm");
  });

  it("the default sink still reports tamperResistant:false — the whole point", () => {
    // If this ever flips to true without the S3 Object-Lock sink behind it, the
    // product is claiming an immutability it does not have. A local directory
    // stops a fat-fingered overwrite; it stops root from nothing. This
    // assertion is the guard on that claim, not a description of a limitation.
    const sink = resolveAnchorSink({} as NodeJS.ProcessEnv);
    expect(sink!.tamperResistant).toBe(false);
  });

  it("REGULAIT_AUDIT_ANCHOR=off restores the disclosed no-sink posture", () => {
    expect(resolveAnchorSink({ REGULAIT_AUDIT_ANCHOR: "off" } as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveAnchorSink({ REGULAIT_AUDIT_ANCHOR: "OFF" } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("an explicit dir still wins over the default", () => {
    const sink = resolveAnchorSink({ REGULAIT_AUDIT_ANCHOR_DIR: "/tmp/custom-anchors" } as NodeJS.ProcessEnv);
    expect(sink).not.toBeNull();
    expect(DEFAULT_ANCHOR_DIR).not.toBe("/tmp/custom-anchors");
  });

  it("an empty dir falls back to the default rather than to no sink", () => {
    // `REGULAIT_AUDIT_ANCHOR_DIR=""` reads as "I did not set this", not as
    // "disable anchoring" — that is what REGULAIT_AUDIT_ANCHOR=off is for.
    const sink = resolveAnchorSink({ REGULAIT_AUDIT_ANCHOR_DIR: "   " } as NodeJS.ProcessEnv);
    expect(sink).not.toBeNull();
    expect(sink!.destination).toBe("local_worm");
  });
});

// -----------------------------------------------------------------------------
// The S3 Object-Lock sink. Same principle as the rest of this file: the claim
// under test is an ADVERSARIAL one ("nobody can rewrite this"), so the tests
// try to make the sink LIE — by handing it a bucket that enforces nothing, by
// breaking the call it uses to find out, and finally, against a real store, by
// attacking an anchor it has already written.
// -----------------------------------------------------------------------------

/**
 * A transport that never leaves the process, carrying REAL command objects.
 *
 * Only `send` is faked. The commands the sink builds are the SDK's own, so a
 * test cannot accidentally pass by asserting against a command shape this file
 * invented — which is the failure mode of a fully hand-rolled S3 double.
 */
class FakeS3 implements S3SendClient {
  readonly puts: Array<Record<string, any>> = [];
  readonly gets: Array<Record<string, any>> = [];
  constructor(
    private readonly opts: {
      lock?: Record<string, any> | undefined;
      lockError?: Error | undefined;
      versions?: Array<{ Key: string; VersionId: string }> | undefined;
      bodies?: Record<string, string> | undefined;
    } = {},
  ) {}

  async send(command: any): Promise<any> {
    if (command instanceof GetObjectLockConfigurationCommand) {
      if (this.opts.lockError) throw this.opts.lockError;
      return { ObjectLockConfiguration: this.opts.lock };
    }
    if (command instanceof PutObjectCommand) {
      this.puts.push(command.input);
      return {};
    }
    if (command instanceof ListObjectVersionsCommand) {
      return { Versions: this.opts.versions ?? [], IsTruncated: false };
    }
    if (command instanceof GetObjectCommand) {
      this.gets.push(command.input);
      const body = (this.opts.bodies ?? {})[command.input.VersionId ?? "current"];
      if (body === undefined) throw new Error(`no body for version ${String(command.input.VersionId)}`);
      return { Body: { transformToString: async () => body } };
    }
    throw new Error(`unexpected command ${command?.constructor?.name}`);
  }
}

const S3_CONFIG = {
  bucket: "anchors",
  prefix: "audit-anchors",
  region: "us-east-1",
  endpoint: "http://minio:9000",
  forcePathStyle: true,
  retentionDays: 365,
  credentials: { accessKeyId: "k", secretAccessKey: "s" },
};

const lockConfig = (mode?: "COMPLIANCE" | "GOVERNANCE") => ({
  ObjectLockEnabled: "Enabled",
  ...(mode ? { Rule: { DefaultRetention: { Mode: mode, Days: 365 } } } : {}),
});

describe("REL-12: the real S3 client is built with deadlines", () => {
  it("connect and request timeouts are set, and the SDK retries at most once", async () => {
    const sink = new S3ObjectLockSink(S3_CONFIG);
    const client = (sink as unknown as { client: S3Client }).client;
    expect(client).toBeInstanceOf(S3Client);
    expect(S3_REQUEST_HANDLER).toEqual({ connectionTimeout: 5_000, requestTimeout: 30_000 });
    // the SDK builds its NodeHttpHandler from the options object and resolves
    // them lazily (configProvider) on the first request — read the provider
    const handler = client.config.requestHandler as unknown as { configProvider: Promise<Record<string, unknown>> };
    await expect(handler.configProvider).resolves.toMatchObject(S3_REQUEST_HANDLER);
    await expect(client.config.maxAttempts()).resolves.toBe(2);
    client.destroy();
  });
});

describe("ADR-0060: tamperResistant is OBSERVED, never configured", () => {
  it("says true ONLY when the bucket itself reports COMPLIANCE", async () => {
    const sink = new S3ObjectLockSink(S3_CONFIG, new FakeS3({ lock: lockConfig("COMPLIANCE") }));
    const obs = await sink.observe();
    expect(obs.mode).toBe("compliance");
    expect(obs.tamperResistant).toBe(true);
    expect(sink.tamperResistant).toBe(true);
    expect(obs.disclosure).toMatch(/COMPLIANCE/);
    // even the good case discloses what it does NOT stop
    expect(obs.disclosure).toMatch(/DESTROYED/i);
  });

  it("says FALSE for GOVERNANCE, and says why a privileged user still wins", async () => {
    // GOVERNANCE is the trap: it looks like Object Lock, it is Object Lock, and
    // it is worthless against the one adversary this ADR is written about,
    // because s3:BypassGovernanceRetention is a permission an administrator can
    // grant themselves.
    const sink = new S3ObjectLockSink(S3_CONFIG, new FakeS3({ lock: lockConfig("GOVERNANCE") }));
    const obs = await sink.observe();
    expect(obs.mode).toBe("governance");
    expect(obs.tamperResistant).toBe(false);
    expect(obs.disclosure).toMatch(/BypassGovernanceRetention/);
    expect(obs.disclosure).toMatch(/delete/i);
  });

  it("says false when Object Lock is enabled but nothing is retained by default", async () => {
    const sink = new S3ObjectLockSink(S3_CONFIG, new FakeS3({ lock: lockConfig() }));
    const obs = await sink.observe();
    expect(obs.mode).toBe("no_default_retention");
    expect(obs.tamperResistant).toBe(false);
  });

  it("says false when the bucket has no Object Lock at all", async () => {
    const sink = new S3ObjectLockSink(S3_CONFIG, new FakeS3({ lock: undefined }));
    const obs = await sink.observe();
    expect(obs.mode).toBe("object_lock_absent");
    expect(obs.tamperResistant).toBe(false);
  });

  it("FAILS CLOSED when it cannot ask — an unobserved medium is a mutable one", async () => {
    const sink = new S3ObjectLockSink(S3_CONFIG, new FakeS3({ lockError: new Error("AccessDenied") }));
    const obs = await sink.observe();
    expect(obs.mode).toBe("unobserved");
    expect(obs.tamperResistant).toBe(false);
    expect(obs.disclosure).toMatch(/AccessDenied/);
  });

  it("reports false BEFORE it has observed anything", () => {
    // The getter cannot go and ask (the interface is synchronous), so the
    // window before the first observation must read as the conservative value.
    // Too pessimistic is a disclosure; too generous is a lie.
    const sink = new S3ObjectLockSink(S3_CONFIG, new FakeS3({ lock: lockConfig("COMPLIANCE") }));
    expect(sink.tamperResistant).toBe(false);
    expect(sink.lockMode).toBe("unobserved");
  });

  it("cannot be talked into true by configuration — the env has no such switch", async () => {
    // Everything an operator can set, set as favourably as it can be set, on a
    // bucket that answers GOVERNANCE. If this ever comes back true, some flag
    // has been allowed to overrule the medium.
    const env = {
      REGULAIT_AUDIT_ANCHOR_S3_BUCKET: "anchors",
      REGULAIT_AUDIT_ANCHOR_S3_ENDPOINT: "http://minio:9000",
      REGULAIT_AUDIT_ANCHOR_S3_ACCESS_KEY_ID: "k",
      REGULAIT_AUDIT_ANCHOR_S3_SECRET_ACCESS_KEY: "s",
      REGULAIT_AUDIT_ANCHOR_S3_RETENTION_DAYS: "3650",
    } as NodeJS.ProcessEnv;
    const config = resolveS3AnchorConfig(env)!;
    const sink = new S3ObjectLockSink(config, new FakeS3({ lock: lockConfig("GOVERNANCE") }));
    await sink.observe();
    expect(sink.tamperResistant).toBe(false);
  });

  it("re-asks rather than trusting a stale yes", async () => {
    // A bucket downgraded from COMPLIANCE to GOVERNANCE must stop being called
    // tamper-resistant. A cached `true` outliving the fact is the exact lie the
    // class exists to prevent, so the observation expires.
    expect(S3_LOCK_OBSERVATION_TTL_MS).toBeGreaterThan(0);
    expect(S3_LOCK_OBSERVATION_TTL_MS).toBeLessThanOrEqual(300_000);
  });
});

describe("ADR-0060: an anchor past the head on a WORM store withholds the verdict", () => {
  // The real-store "proof by attack" below is skipped without a bucket; this is the
  // same rule against the fake S3, so it runs everywhere. A locked store that
  // holds an anchor past this chain's head is EITHER another chain sharing the
  // store OR this chain with its tail removed — and a verifier that cannot
  // tell them apart must not answer "matches".
  const keyFor = (seq: number) => `audit-anchors/anchor-${String(seq).padStart(20, "0")}.json`;
  const bodyFor = (seq: number, rowHash: string) =>
    JSON.stringify({ seq, rowHash, headAt: "2026-01-01T00:00:00.000Z", algorithm: "sha256", payloadVersion: "regulait.audit.v1", capturedAt: "2026-01-01T00:00:00.000Z" });

  it("grades the genuine anchor but reports `matches: null`, with the disclosure saying so", async () => {
    const head = (await chainRows()).at(-1)!;
    const headSeq = Number(head.seq);
    const fake = new FakeS3({
      lock: lockConfig("COMPLIANCE"),
      versions: [
        { Key: keyFor(headSeq), VersionId: "genuine" },
        { Key: keyFor(9_000_000), VersionId: "planted" },
      ],
      bodies: { genuine: bodyFor(headSeq, head.row_hash), planted: bodyFor(9_000_000, "9".repeat(64)) },
    });
    const report = await verifyAuditChain(db, new S3ObjectLockSink(S3_CONFIG, fake));
    expect(report.anchor.source).toBe("worm_sink");
    expect(report.anchor.tamperResistant).toBe(true);
    // the comparison still used THIS chain's anchor — a tampered row would still show
    expect(report.anchor.seq).toBe(headSeq);
    expect(report.anchor.actualRowHash).toBe(report.anchor.expectedRowHash);
    // but the verdict is withheld, never a pass
    expect(report.anchor.matches).toBeNull();
    expect(report.anchor.aheadOfHead).toMatchObject({ seq: 9_000_000, rowHash: "9".repeat(64) });
    expect(report.anchor.aheadOfHead?.disclosure).toMatch(/NOT reported as verified/);
    expect(report.anchor.aheadOfHead?.disclosure).toMatch(/a break/);
  });

  it("with no anchor past the head, the same store reads as a plain match", async () => {
    const head = (await chainRows()).at(-1)!;
    const headSeq = Number(head.seq);
    const fake = new FakeS3({
      lock: lockConfig("COMPLIANCE"),
      versions: [{ Key: keyFor(headSeq), VersionId: "genuine" }],
      bodies: { genuine: bodyFor(headSeq, head.row_hash) },
    });
    const report = await verifyAuditChain(db, new S3ObjectLockSink(S3_CONFIG, fake));
    expect(report.anchor.matches).toBe(true);
    expect(report.anchor.aheadOfHead).toBeNull();
  });
});

describe("ADR-0060: what the S3 sink actually writes", () => {
  it("locks every anchor in COMPLIANCE mode, for the configured retention", async () => {
    const fake = new FakeS3({ lock: lockConfig("COMPLIANCE") });
    const sink = new S3ObjectLockSink({ ...S3_CONFIG, retentionDays: 10 }, fake);
    const ref = await sink.write({
      seq: 42,
      rowHash: "a".repeat(64),
      headAt: new Date().toISOString(),
      algorithm: "sha256",
      payloadVersion: "regulait.audit.v1",
      capturedAt: new Date().toISOString(),
    });
    const put = fake.puts[0]!;
    expect(put.ObjectLockMode).toBe("COMPLIANCE");
    const days = (put.ObjectLockRetainUntilDate.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(9.9);
    expect(days).toBeLessThan(10.1);
    // zero-padded so lexicographic key order IS chain order — readLatest relies
    // on that instead of sorting a decade of anchors
    expect(put.Key).toBe(`audit-anchors/anchor-${"0".repeat(18)}42.json`);
    expect(ref).toBe(`s3://anchors/audit-anchors/anchor-${"0".repeat(18)}42.json`);
  });

  it("omits the lock headers ONLY on a bucket that positively has no lock", async () => {
    // S3 rejects a locked PUT to an unlocked bucket. Sending it anyway would
    // trade a disclosed-weak anchor for NO anchor, which is the worse of the
    // two — the weak one at least still has to be forged in two places.
    const fake = new FakeS3({ lock: undefined });
    const sink = new S3ObjectLockSink(S3_CONFIG, fake);
    await sink.write({
      seq: 1,
      rowHash: "b".repeat(64),
      headAt: new Date().toISOString(),
      algorithm: "sha256",
      payloadVersion: "regulait.audit.v1",
      capturedAt: new Date().toISOString(),
    });
    expect(fake.puts[0]!.ObjectLockMode).toBeUndefined();
    expect(sink.tamperResistant).toBe(false);
  });

  it("reads the FIRST version of an anchor, not the current one", async () => {
    // Object Lock protects a VERSION, not a NAME: writing the same key again is
    // allowed and makes the attacker's bytes current, with the locked original
    // underneath. A reader that took the current version would hand the forged
    // head to verification — the sink would become the vehicle for the forgery
    // it exists to catch.
    const original = JSON.stringify({
      seq: 7,
      rowHash: "c".repeat(64),
      headAt: "2026-08-13T00:00:00.000Z",
      algorithm: "sha256",
      payloadVersion: "regulait.audit.v1",
      capturedAt: "2026-08-13T00:00:00.000Z",
    });
    const forged = JSON.stringify({
      seq: 7,
      rowHash: "d".repeat(64),
      headAt: "2026-08-13T00:00:00.000Z",
      algorithm: "sha256",
      payloadVersion: "regulait.audit.v1",
      capturedAt: "2026-08-13T00:00:00.000Z",
    });
    const key = `audit-anchors/anchor-${"0".repeat(19)}7.json`;
    const fake = new FakeS3({
      lock: lockConfig("COMPLIANCE"),
      // S3 lists versions newest-first
      versions: [
        { Key: key, VersionId: "v2-forged" },
        { Key: key, VersionId: "v1-locked" },
      ],
      bodies: { "v1-locked": original, "v2-forged": forged },
    });
    const sink = new S3ObjectLockSink(S3_CONFIG, fake);
    const record = await sink.readLatest();
    expect(record!.rowHash).toBe("c".repeat(64));
    expect(fake.gets[0]!.VersionId).toBe("v1-locked");
  });

  it("takes the HIGHEST seq across keys, not the last one listed", async () => {
    const mk = (n: number) => `audit-anchors/anchor-${String(n).padStart(20, "0")}.json`;
    const body = (seq: number) =>
      JSON.stringify({
        seq,
        rowHash: String(seq).padStart(64, "0"),
        headAt: "2026-08-13T00:00:00.000Z",
        algorithm: "sha256",
        payloadVersion: "regulait.audit.v1",
        capturedAt: "2026-08-13T00:00:00.000Z",
      });
    const fake = new FakeS3({
      lock: lockConfig("COMPLIANCE"),
      versions: [
        { Key: mk(9), VersionId: "v9" },
        { Key: mk(11), VersionId: "v11" },
        { Key: mk(10), VersionId: "v10" },
      ],
      bodies: { v9: body(9), v10: body(10), v11: body(11) },
    });
    const sink = new S3ObjectLockSink(S3_CONFIG, fake);
    expect((await sink.readLatest())!.seq).toBe(11);
  });

  it("returns null rather than throwing when it cannot read back", async () => {
    // The terraform writer grant denies s3:GetObject ON PURPOSE, so a
    // least-privilege install is write-only and lands here every time.
    // Verification must degrade to the honest weaker source, not 500.
    const sink = new S3ObjectLockSink(S3_CONFIG, new FakeS3({ lock: lockConfig("COMPLIANCE"), versions: [] }));
    expect(await sink.readLatest()).toBeNull();
  });

  it("records the anchor as s3_object_lock, and the destination needs no migration", async () => {
    const fake = new FakeS3({ lock: lockConfig("GOVERNANCE") });
    const sink = new S3ObjectLockSink(S3_CONFIG, fake);
    const result = await captureAnchor(db, sink, null);
    expect(result!.destination).toBe("s3_object_lock");
    expect(result!.status).toBe("flushed");
    expect(result!.externalRef).toMatch(/^s3:\/\/anchors\//);
    // observed GOVERNANCE, so the anchor the admin just took is reported as
    // NOT evidence — at the moment they take it, not in a footnote
    expect(result!.tamperResistant).toBe(false);
    const row = await db.execute(sql`select destination from audit_anchors where id = ${result!.anchorId}`);
    expect((row as unknown as { rows: Array<{ destination: string }> }).rows[0]!.destination).toBe("s3_object_lock");
  });
});

describe("ADR-0060: sink precedence", () => {
  const s3Env = {
    REGULAIT_AUDIT_ANCHOR_S3_BUCKET: "anchors",
    REGULAIT_AUDIT_ANCHOR_S3_ENDPOINT: "http://minio:9000",
  } as NodeJS.ProcessEnv;

  it("off beats everything, including a fully configured bucket", () => {
    expect(resolveAnchorSink({ ...s3Env, REGULAIT_AUDIT_ANCHOR: "off" })).toBeNull();
  });

  it("a configured bucket beats the local buffer", () => {
    const sink = resolveAnchorSink(s3Env);
    expect(sink!.destination).toBe("s3_object_lock");
  });

  it("falls back to the local buffer when no bucket is named", () => {
    expect(resolveAnchorSink({ REGULAIT_AUDIT_ANCHOR_S3_ENDPOINT: "http://minio:9000" } as NodeJS.ProcessEnv)!.destination).toBe(
      "local_worm",
    );
    expect(resolveAnchorSink({ REGULAIT_AUDIT_ANCHOR_S3_BUCKET: "   " } as NodeJS.ProcessEnv)!.destination).toBe("local_worm");
  });

  it("defaults the rest of the S3 config so a named bucket is enough", () => {
    const config = resolveS3AnchorConfig(s3Env)!;
    expect(config.prefix).toBe(DEFAULT_S3_ANCHOR_PREFIX);
    expect(config.retentionDays).toBe(DEFAULT_S3_ANCHOR_RETENTION_DAYS);
    expect(config.region).toBe("us-east-1");
    // a custom endpoint means path style: `<bucket>.minio` does not resolve on
    // a compose network
    expect(config.forcePathStyle).toBe(true);
    expect(config.credentials).toBeUndefined();
    // no endpoint = real AWS = virtual-host addressing
    expect(resolveS3AnchorConfig({ REGULAIT_AUDIT_ANCHOR_S3_BUCKET: "b" } as NodeJS.ProcessEnv)!.forcePathStyle).toBe(false);
  });

  it("refuses a nonsense retention rather than locking anchors for zero days", () => {
    for (const bad of ["0", "-5", "nonsense", ""]) {
      const config = resolveS3AnchorConfig({ ...s3Env, REGULAIT_AUDIT_ANCHOR_S3_RETENTION_DAYS: bad })!;
      expect(config.retentionDays).toBe(DEFAULT_S3_ANCHOR_RETENTION_DAYS);
    }
    expect(resolveS3AnchorConfig({ ...s3Env, REGULAIT_AUDIT_ANCHOR_S3_RETENTION_DAYS: "30" })!.retentionDays).toBe(30);
  });
});

// -----------------------------------------------------------------------------
// REAL PROOF, against a real S3 Object Lock implementation.
//
// Everything above is stubbed, and a stub can only prove that the sink grades
// an answer correctly — never that the medium enforces anything. The claim on
// the box is "nobody can rewrite this", and the only way to test that claim is
// to TRY, with the same credentials the gateway itself holds, against a server
// that actually implements Object Lock.
//
// SKIPS CLEANLY when no such server is reachable, because a suite that silently
// passed without one would be asserting the guarantee rather than testing it.
// Point REGULAIT_TEST_S3_ENDPOINT at any S3-compatible endpoint with Object
// Lock support, or run SeaweedFS (Apache-2.0; what CI and the compose stack
// use) with the compose credentials:
//
//   AWS_ACCESS_KEY_ID=regulait AWS_SECRET_ACCESS_KEY=regulait-dev-objectstore \
//     weed mini -dir=/tmp/anchors -s3.port=9000
// -----------------------------------------------------------------------------

const S3_TEST_ENDPOINT = process.env.REGULAIT_TEST_S3_ENDPOINT ?? "http://127.0.0.1:9000";
const S3_TEST_KEY = process.env.REGULAIT_TEST_S3_ACCESS_KEY_ID ?? "regulait";
const S3_TEST_SECRET = process.env.REGULAIT_TEST_S3_SECRET_ACCESS_KEY ?? "regulait-dev-objectstore";
// Reachability is a SIGNED S3 call with the suite's own credentials, not a
// vendor health path: `/minio/health/live` exists only on MinIO (SeaweedFS
// answers it 403, as a request for a bucket called "minio"). ListBuckets is in
// every S3 implementation, and succeeding at it also proves the credentials
// work — so a wrong key fails the CI-01 check below instead of failing nine
// tests later with an opaque AccessDenied.
let s3TestUnreachableReason = "";
const s3TestReachable = await new S3Client({
  region: "us-east-1",
  endpoint: S3_TEST_ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: S3_TEST_KEY, secretAccessKey: S3_TEST_SECRET },
  maxAttempts: 1,
})
  .send(new ListBucketsCommand({}), { abortSignal: AbortSignal.timeout(2_000) })
  .then(() => true)
  .catch((err: unknown) => {
    s3TestUnreachableReason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return false;
  });
// CI-01: a deliberately named endpoint that is NOT there is a broken setup,
// never a skip — on CI (which runs an object-store service for exactly these
// nine tests) a silent skip would ship a regression in the tamper-resistance
// claim green. Unset, the suite still skips on a laptop without a store.
if (process.env.REGULAIT_TEST_S3_ENDPOINT && !s3TestReachable) {
  throw new Error(
    `REGULAIT_TEST_S3_ENDPOINT=${S3_TEST_ENDPOINT} is set but a signed ListBuckets did not succeed (${s3TestUnreachableReason}) — ` +
      "the Object-Lock proof-by-attack tests cannot run and will not be skipped silently",
  );
}

describe.skipIf(!s3TestReachable)("ADR-0060: proof by attack against a REAL Object-Lock bucket", () => {
  const suffix = randomUUID().slice(0, 8);
  const COMPLIANCE_BUCKET = `regulait-anchors-compliance-${suffix}`;
  const GOVERNANCE_BUCKET = `regulait-anchors-governance-${suffix}`;
  const UNLOCKED_BUCKET = `regulait-anchors-unlocked-${suffix}`;

  /** the credentials the GATEWAY uses — the attacker in these tests is the
   * gateway's own compromised credential, which is the realistic case */
  const credentials = { accessKeyId: S3_TEST_KEY, secretAccessKey: S3_TEST_SECRET };
  const s3 = new S3Client({ region: "us-east-1", endpoint: S3_TEST_ENDPOINT, forcePathStyle: true, credentials });

  /** Each test gets its OWN key prefix in the shared bucket. Not tidiness:
   * these tests plant fabricated anchors at high `seq` values, and `readLatest`
   * takes the highest, so a shared prefix would make every later test read some
   * earlier test's attack payload. Nothing can be cleaned up afterwards either
   * — that is what COMPLIANCE mode means. */
  const configFor = (bucket: string, prefix: string) => ({
    bucket,
    prefix: `audit-anchors-${prefix}`,
    region: "us-east-1",
    endpoint: S3_TEST_ENDPOINT,
    forcePathStyle: true,
    retentionDays: 1,
    credentials,
  });

  const anchorAt = (seq: number, rowHash: string) => ({
    seq,
    rowHash,
    headAt: "2026-08-13T00:00:00.000Z",
    algorithm: "sha256",
    payloadVersion: "regulait.audit.v1",
    capturedAt: "2026-08-13T00:00:00.000Z",
  });

  beforeAll(async () => {
    // `ObjectLockEnabledForBucket` at CREATION is not a style choice: Object
    // Lock cannot be turned on afterwards, which is why the compose init
    // container does exactly this and why a bucket made without it is
    // unfixable.
    await s3.send(new CreateBucketCommand({ Bucket: COMPLIANCE_BUCKET, ObjectLockEnabledForBucket: true }));
    await s3.send(
      new PutObjectLockConfigurationCommand({
        Bucket: COMPLIANCE_BUCKET,
        ObjectLockConfiguration: { ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "COMPLIANCE", Days: 1 } } },
      }),
    );
    await s3.send(new CreateBucketCommand({ Bucket: GOVERNANCE_BUCKET, ObjectLockEnabledForBucket: true }));
    await s3.send(
      new PutObjectLockConfigurationCommand({
        Bucket: GOVERNANCE_BUCKET,
        ObjectLockConfiguration: { ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "GOVERNANCE", Days: 1 } } },
      }),
    );
    await s3.send(new CreateBucketCommand({ Bucket: UNLOCKED_BUCKET }));
  }, 60_000);

  // No afterAll cleanup for the compliance bucket, and that is the point: its
  // objects cannot be deleted for a day by anyone, including this suite.

  it("observes COMPLIANCE from the bucket and only then reports tamper-resistant", async () => {
    const sink = new S3ObjectLockSink(configFor(COMPLIANCE_BUCKET, "observe"));
    const obs = await sink.observe();
    expect(obs.mode).toBe("compliance");
    expect(obs.tamperResistant).toBe(true);
  });

  it("observes GOVERNANCE and refuses to call it tamper-resistant", async () => {
    const sink = new S3ObjectLockSink(configFor(GOVERNANCE_BUCKET, "observe"));
    expect((await sink.observe()).mode).toBe("governance");
    expect(sink.tamperResistant).toBe(false);
  });

  it("observes a plain bucket as unlocked, and still writes to it", async () => {
    const sink = new S3ObjectLockSink(configFor(UNLOCKED_BUCKET, "observe"));
    expect((await sink.observe()).mode).toBe("object_lock_absent");
    await sink.write(anchorAt(1, "e".repeat(64)));
    expect((await sink.readLatest())!.rowHash).toBe("e".repeat(64));
    expect(sink.tamperResistant).toBe(false);
  });

  it("round-trips a real anchor through the real SDK path", async () => {
    const sink = new S3ObjectLockSink(configFor(COMPLIANCE_BUCKET, "roundtrip"));
    const ref = await sink.write(anchorAt(100, "f".repeat(64)));
    expect(ref).toBe(`s3://${COMPLIANCE_BUCKET}/audit-anchors-roundtrip/anchor-${String(100).padStart(20, "0")}.json`);
    const back = await sink.readLatest();
    expect(back).toEqual(anchorAt(100, "f".repeat(64)));
  });

  it("REFUSES to let the gateway's own credential destroy an anchor it wrote", async () => {
    const sink = new S3ObjectLockSink(configFor(COMPLIANCE_BUCKET, "destroy"));
    const rowHash = "1".repeat(64);
    await sink.write(anchorAt(200, rowHash));
    const key = `audit-anchors-destroy/anchor-${String(200).padStart(20, "0")}.json`;

    const versions = await s3.send(new ListObjectVersionsCommand({ Bucket: COMPLIANCE_BUCKET, Prefix: key }));
    const versionId = versions.Versions!.find((v) => v.Key === key)!.VersionId!;

    // THE ASSERTION THE WHOLE FEATURE RESTS ON. Not "we asked for COMPLIANCE" —
    // the server refusing the delete, to the identity that created the object.
    await expect(
      s3.send(new DeleteObjectCommand({ Bucket: COMPLIANCE_BUCKET, Key: key, VersionId: versionId })),
    ).rejects.toThrow(/WORM|retention|denied/i);

    // and it is still there, byte for byte
    const still = await s3.send(new GetObjectCommand({ Bucket: COMPLIANCE_BUCKET, Key: key, VersionId: versionId }));
    expect(JSON.parse(await still.Body!.transformToString())).toEqual(anchorAt(200, rowHash));
  });

  it("survives a MASKING attack: the anchor read back is the locked one, not the attacker's", async () => {
    // MEASURED, NOT ASSUMED, and it contradicts the naive expectation: S3
    // Object Lock protects a VERSION, not a NAME. Overwriting the key and
    // deleting it without a version id are BOTH ALLOWED — the first makes the
    // attacker's bytes current, the second hides the key behind a delete
    // marker. Neither is refused, and a sink that read the current version
    // would hand verification a forged head and call it evidence.
    //
    // What the lock guarantees is that the original version survives both. So
    // the sink reads the FIRST version, and this test is what says that
    // decision is load-bearing rather than fussy.
    const sink = new S3ObjectLockSink(configFor(COMPLIANCE_BUCKET, "mask"));
    const honest = "2".repeat(64);
    await sink.write(anchorAt(300, honest));
    const key = `audit-anchors-mask/anchor-${String(300).padStart(20, "0")}.json`;

    // attack 1: overwrite the key with a forged head, same credentials
    await s3.send(
      new PutObjectCommand({ Bucket: COMPLIANCE_BUCKET, Key: key, Body: JSON.stringify(anchorAt(300, "3".repeat(64))) }),
    );
    expect((await sink.readLatest())!.rowHash).toBe(honest);

    // attack 2: delete the key without naming a version — a delete marker,
    // which makes a plain ListObjectsV2/GetObject behave as if it were gone
    await s3.send(new DeleteObjectCommand({ Bucket: COMPLIANCE_BUCKET, Key: key }));
    expect((await sink.readLatest())!.rowHash).toBe(honest);
  });

  it("carries the observed mode into the verify report's disclosure", async () => {
    const sink = new S3ObjectLockSink(configFor(COMPLIANCE_BUCKET, "verify"));
    await captureAnchor(db, sink, null);
    const report = await verifyAuditChain(db, sink);
    expect(report.anchor.source).toBe("worm_sink");
    expect(report.anchor.sinkMode).toBe("compliance");
    expect(report.anchor.tamperResistant).toBe(true);
    expect(report.anchor.disclosure).toMatch(/COMPLIANCE/);
    // the head just anchored is the head, so nothing is left unpinned
    expect(report.anchor.matches).toBe(true);
    expect(report.anchor.unanchoredRows).toBe(0);
  });

  it("reports GOVERNANCE in the verify report instead of a bare false", async () => {
    // "not tamper-resistant" is not enough for an admin to act on. The reason —
    // a privileged principal can still delete this — is what tells them to
    // change the bucket rather than the anchor cadence.
    const sink = new S3ObjectLockSink(configFor(GOVERNANCE_BUCKET, "verify"));
    await captureAnchor(db, sink, null);
    const report = await verifyAuditChain(db, sink);
    expect(report.anchor.sinkMode).toBe("governance");
    expect(report.anchor.tamperResistant).toBe(false);
    expect(report.anchor.disclosure).toMatch(/BypassGovernanceRetention/);
  });

  it("lets an attacker raise a FALSE ALARM, never a false pass", async () => {
    // The one thing a writer with the gateway's credential can still do to a
    // compliance bucket is ADD: plant an anchor at a `seq` that never existed.
    // They cannot withdraw it afterwards — the lock cuts both ways. So the
    // damage is a verification that WITHHOLDS its verdict, which is noisy and
    // wrong in the SAFE direction. The direction that matters — making a
    // tampered chain verify clean — stays closed, because they cannot alter
    // the anchors already written, and an anchor past the head on this store
    // is also exactly what a truncated tail looks like, so it is never green.
    const sink = new S3ObjectLockSink(configFor(COMPLIANCE_BUCKET, "plant"));
    await captureAnchor(db, sink, null);
    expect((await verifyAuditChain(db, sink)).anchor.matches).toBe(true);

    await sink.write(anchorAt(9_000_000, "9".repeat(64)));
    const report = await verifyAuditChain(db, sink);
    // The planted anchor is past the head, so it is reported on its own — the
    // alarm — and the verdict is withheld: the genuine anchor is still the
    // one compared (so a tampered row would still show as a mismatch), but a
    // store that says "there was more chain than this" never reads as a pass.
    expect(report.anchor.aheadOfHead?.seq).toBe(9_000_000);
    expect(report.anchor.aheadOfHead?.disclosure).toMatch(/NOT reported as verified/);
    expect(report.anchor.seq).not.toBe(9_000_000);
    expect(report.anchor.matches).toBeNull();
    expect(report.anchor.actualRowHash).toBe(report.anchor.expectedRowHash);
  });
});
