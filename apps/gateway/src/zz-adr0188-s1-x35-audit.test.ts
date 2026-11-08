/**
 * ADR-0188 S1 — the audit v2 boundary on a real database, after PR #257's CI
 * failure and Codex's X35 review. Runs on its OWN scratch database (prefix
 * `a188x35_`), dropped in afterAll, so a full verification from genesis sees
 * only the rows written here.
 *
 *  CI   A database migrated only part of the way (a journal cut before 0180)
 *       has no `audit_chain_versions`. `runMigrations` no longer drains the
 *       migration audit outbox into it (the rows wait, and move on the run that
 *       brings the schema level with this build), and the chained writer FAILS
 *       CLOSED there with `AuditChainSchemaBehindError` instead of assuming v1.
 *       `zz-b4c8-migration-0171.test.ts` was the CI casualty: at 0170 the
 *       outbox held 0160's rows and the drain hit the missing table.
 *  I7S-01  actor fields written onto a v1 row by a raw UPDATE are a definite
 *       `actor_on_v1` break, on a full and on a bounded scan; the v1 hash is
 *       byte-identical (the row's stored hashes are untouched).
 *  I7S-02  the writer, the verifier and the receipt sweep load the boundary
 *       through one loader; a boundary of an unknown version is a definite
 *       `unsupported_chain_version` break (full and bounded), never a pass.
 *  I7S-03  the depth setting's copy counts actors as decision 26 does.
 *  X33  `workload_identities.grants_revision` starts at 0 and moves forward
 *       by exactly one per grant-set replacement.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { AuditChainSchemaBehindError, auditLog, createDb, eq, runMigrations, sql, type Db } from "@regulait/db";
import { actorChainDepthForGrantDepth, auditContentHashFor, IDENTITY_SETTING_COPY, IDENTITY_STRICT_DEFAULTS } from "@regulait/shared";
import { verifyAuditChain } from "./audit-chain.js";
import { dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `a188x35_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};
const rows = <T>(r: unknown) => (r as { rows: T[] }).rows;

let admin: Db;
let db: Db;
let tmp: string | null = null;
/** what the partial (pre-0180) stage observed, asserted in the CI describe below */
const partial = {} as { drainError: unknown; outboxAfterPartial: number; writerError: unknown };

const OUTBOX_RULE = "a188x35-outbox-fixture";

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(urlFor(SCRATCH_DB));

  // a migrations folder whose journal stops before 0180
  tmp = mkdtempSync(path.join(tmpdir(), "a188x35-"));
  cpSync(migrationsFolder, tmp, { recursive: true });
  const journalPath = path.join(tmp, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ idx: number; tag: string }> };
  const cut = journal.entries.find((e) => e.tag === "0180_agent_workload_identity")!.idx;
  journal.entries = journal.entries.filter((e) => e.idx < cut);
  writeFileSync(journalPath, JSON.stringify(journal));
  await runMigrations(db, tmp);

  // a migration's audit row waiting in the outbox at the partial schema
  await db.execute(sql`INSERT INTO migration_audit_outbox (migration, object_type, object_id, rule_id, reason, detail)
    VALUES ('a188x35_fixture', 'kri', NULL, ${OUTBOX_RULE}, 'a row a migration wrote', '{}'::jsonb)`);
  partial.drainError = await runMigrations(db, tmp).then(
    () => null,
    (e: unknown) => e,
  );
  // (0160–0179's own first-load rows wait there too, as they did in CI's 0171 test)
  partial.outboxAfterPartial = rows<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM migration_audit_outbox WHERE rule_id = ${OUTBOX_RULE}`),
  )[0]!.n;
  partial.writerError = await db
    .transaction(async (tx) => {
      await tx.insert(auditLog).values({ userId: randomUUID(), effect: "allow", ruleId: "a188x35", ruleChain: [], reason: "pre-0180 write" });
    })
    .then(
      () => null,
      (e: unknown) => e,
    );

  // and the rest of the way
  await runMigrations(db, migrationsFolder);
}, 180_000);

afterAll(async () => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  await db?.$client.end();
  await dropScratchDatabase(admin, SCRATCH_DB);
  await admin?.$client.end();
});

class RolledBack extends Error {}
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
async function inRolledBackTx(body: (tx: Tx) => Promise<void>): Promise<void> {
  await db
    .transaction(async (tx) => {
      await body(tx);
      throw new RolledBack();
    })
    .catch((e: unknown) => {
      if (!(e instanceof RolledBack)) throw e;
    });
}
const row = () => ({
  userId: "00000000-0000-0000-0000-000000000000",
  effect: "allow" as const,
  ruleId: "a188x35",
  ruleChain: [] as string[],
  reason: "synthetic S1 review row",
});

describe("CI (PR #257): a database behind this build's audit schema", () => {
  it("runMigrations on a pre-0180 database leaves the outbox rows waiting instead of failing", () => {
    expect(partial.drainError).toBeNull();
    expect(partial.outboxAfterPartial).toBe(1);
  });

  it("the chained writer fails closed there, naming the missing boundary table", () => {
    expect(partial.writerError).toBeInstanceOf(AuditChainSchemaBehindError);
    expect(String((partial.writerError as Error).message)).toMatch(/audit_chain_versions/);
  });

  it("the run that brings the schema level drains the waiting row into the chain, which verifies", async () => {
    expect(rows<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM migration_audit_outbox`))[0]!.n).toBe(0);
    const [moved] = await db.select().from(auditLog).where(eq(auditLog.ruleId, OUTBOX_RULE));
    expect(moved?.seq).not.toBeNull();
    expect(moved?.chainVersion).toBeNull();
    const report = await verifyAuditChain(db, null);
    expect(report.firstBreak).toBeNull();
    expect(report.status).toBe("ok");
  });
});

describe("X35 I7S-01: actor attribution on a v1 row is a break", () => {
  it("a raw UPDATE of the three actor columns on a valid v1 row fails a full and a bounded scan; the v1 hash is unchanged", async () => {
    await inRolledBackTx(async (tx) => {
      const [before] = await tx.insert(auditLog).values(row()).returning();
      expect(before!.chainVersion).toBeNull();
      expect((await verifyAuditChain(tx as unknown as Db, null)).status).toBe("ok");
      await tx.execute(sql`UPDATE audit_log SET actor_identity_id = ${randomUUID()}, delegation_grant_id = ${randomUUID()},
        actor_chain = ${JSON.stringify([randomUUID()])}::jsonb WHERE id = ${before!.id}`);
      const [after] = await tx.select().from(auditLog).where(eq(auditLog.id, before!.id));
      // byte-identical v1 hashing: the stored hashes still match a v1 recompute
      expect(after!.contentHash).toBe(before!.contentHash);
      expect(auditContentHashFor(after as never, 1)).toBe(before!.contentHash);

      const full = await verifyAuditChain(tx as unknown as Db, null);
      expect(full.status).toBe("broken");
      expect(full.firstBreak).toMatchObject({ seq: before!.seq, kind: "actor_on_v1" });
      const bounded = await verifyAuditChain(tx as unknown as Db, null, { fromSeq: before!.seq! });
      expect(bounded.scanned.bounded).toBe(true);
      expect(bounded.status).toBe("broken");
      expect(bounded.firstBreak).toMatchObject({ seq: before!.seq, kind: "actor_on_v1" });
    });
  });

  it("positive control: changing a v2 row's actor chain is still a content break", async () => {
    await inRolledBackTx(async (tx) => {
      const tip = rows<{ s: string }>(await tx.execute(sql`SELECT max(seq)::bigint AS s FROM audit_log`))[0]!;
      await tx.execute(sql`INSERT INTO audit_chain_versions (version, from_seq) VALUES (2, ${Number(tip.s) + 1})`);
      const [v2] = await tx
        .insert(auditLog)
        .values({ ...row(), actorIdentityId: randomUUID(), delegationGrantId: randomUUID(), actorChain: [randomUUID()] })
        .returning();
      expect(v2!.chainVersion).toBe(2);
      expect((await verifyAuditChain(tx as unknown as Db, null)).status).toBe("ok");
      await tx.execute(sql`UPDATE audit_log SET actor_chain = ${JSON.stringify([randomUUID()])}::jsonb WHERE id = ${v2!.id}`);
      expect((await verifyAuditChain(tx as unknown as Db, null)).firstBreak).toMatchObject({ seq: v2!.seq, kind: "content_mismatch" });
    });
  });
});

describe("X35 I7S-02: an unknown serialisation boundary fails closed", () => {
  it("with no boundary the chain verifies as v1", async () => {
    expect((await verifyAuditChain(db, null)).status).toBe("ok");
  });

  it("a version-3 boundary (a future build's) is a definite break on a full and a bounded scan, and the writer refuses", async () => {
    await inRolledBackTx(async (tx) => {
      const [last] = await tx.insert(auditLog).values(row()).returning();
      // S1's CHECK holds version = 2; a future migration would lift it, as here (rolled back)
      await tx.execute(sql`ALTER TABLE audit_chain_versions DROP CONSTRAINT audit_chain_versions_version_check`);
      await tx.execute(sql`INSERT INTO audit_chain_versions (version, from_seq) VALUES (3, ${last!.seq! + 1})`);

      const full = await verifyAuditChain(tx as unknown as Db, null);
      expect(full.status).toBe("broken");
      expect(full.firstBreak).toMatchObject({ seq: last!.seq! + 1, kind: "unsupported_chain_version", actual: "3" });
      expect(full.limits.join(" ")).toMatch(/Unsupported serialisation boundary/);
      // the rows before the boundary were still verified
      expect(full.scanned.toSeq).toBe(last!.seq);

      const bounded = await verifyAuditChain(tx as unknown as Db, null, { fromSeq: last!.seq! });
      expect(bounded.status).toBe("broken");
      expect(bounded.firstBreak).toMatchObject({ kind: "unsupported_chain_version" });

      const refused = await tx
        .transaction((sp) => sp.insert(auditLog).values(row()).then(() => undefined))
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(String((refused as Error | null)?.message)).toMatch(/serialisation version 3/);
    });
  });

  it("a version-3 boundary at seq 2 (before every written row) fails closed too", async () => {
    await inRolledBackTx(async (tx) => {
      await tx.execute(sql`ALTER TABLE audit_chain_versions DROP CONSTRAINT audit_chain_versions_version_check`);
      await tx.execute(sql`INSERT INTO audit_chain_versions (version, from_seq) VALUES (3, 2)`);
      const report = await verifyAuditChain(tx as unknown as Db, null);
      expect(report.status).toBe("broken");
      expect(report.firstBreak).toMatchObject({ seq: 2, kind: "unsupported_chain_version" });
    });
  });
});

describe("X35 I7S-03: the depth setting's copy counts actors as decision 26 does", () => {
  it("strict depth 3 = the root plus three delegations = four actors", () => {
    expect(IDENTITY_STRICT_DEFAULTS.delegationMaxDepth).toBe(3);
    expect(actorChainDepthForGrantDepth(IDENTITY_STRICT_DEFAULTS.delegationMaxDepth)).toBe(4);
    const copy = IDENTITY_SETTING_COPY.delegationMaxDepth;
    expect(copy.strict).toMatch(/three delegations/);
    expect(copy.strict).toMatch(/four agents/);
    expect(copy.strict).not.toMatch(/delegate's delegate may act/);
    expect(copy.relaxed).toMatch(/8 delegations, nine agents/);
  });
});

describe("X33: an identity's grant-set revision moves forward one step per replacement", () => {
  it("starts at 0; +1 is accepted; a jump or a step back is refused", async () => {
    await inRolledBackTx(async (tx) => {
      const sponsor = rows<{ id: string }>(
        await tx.execute(sql`INSERT INTO users (email, display_name) VALUES (${`a188x35-${randomUUID()}@example.com`}, 'x35') RETURNING id`),
      )[0]!.id;
      const ident = rows<{ id: string; grants_revision: number }>(
        await tx.execute(sql`INSERT INTO workload_identities (kind, identifier, sponsor_user_ids)
          VALUES ('worker_runtime', ${`spiffe://example.org/regulait/test/x35-${randomUUID()}`}, ARRAY[${sponsor}]::uuid[])
          RETURNING id, grants_revision`),
      )[0]!;
      expect(ident.grants_revision).toBe(0);
      await tx.execute(sql`UPDATE workload_identities SET grants_revision = 1 WHERE id = ${ident.id}`);
      for (const bad of [3, 0, -1]) {
        const e = await tx
          .transaction((sp) => sp.execute(sql`UPDATE workload_identities SET grants_revision = ${bad} WHERE id = ${ident.id}`))
          .then(
            () => null,
            (err: unknown) => err,
          );
        expect(e, `revision ${bad} refused`).not.toBeNull();
      }
    });
  });
});
