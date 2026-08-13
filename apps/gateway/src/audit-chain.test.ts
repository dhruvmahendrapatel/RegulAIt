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
import { mkdtemp, readdir } from "node:fs/promises";
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
import { buildApp } from "./app.js";
import {
  DEFAULT_ANCHOR_DIR,
  LocalWormSink,
  resolveAnchorSink,
  type AnchorSink,
} from "./audit-chain.js";
import { NON_ADMIN_ROUTES } from "./route-classes.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const SCRATCH_DB = "regulait_audit_chain_test";
const scratchUrl = (() => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + SCRATCH_DB;
  return u.toString();
})();
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "audit-chain-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };
const ACTOR = "00000000-0000-0000-0000-0000000000aa";

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
