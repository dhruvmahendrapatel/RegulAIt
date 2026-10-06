/**
 * ADR-0110 / migration 0109 — A RE-SCAN RE-OPENS A MISS, AND THERE IS EXACTLY
 * ONE `backup_runs` ROW PER FINDING.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * ADR-0109 added nine unique indexes and REFUSED a tenth, on `backup_runs`,
 * with a specific and correct reason:
 *
 *   scan -> a (finding, kind='backup', status='missed') row, written behind a
 *   read FILTERED TO status='missed'; propose -> the SAME row moves to
 *   'restore_proposed'; re-scan -> matches nothing and inserts a SECOND
 *   'missed' row; DENY -> UPDATEs the FIRST row back to 'missed'.
 *
 *   With a unique index, that last step raises 23505, the denial transaction
 *   rolls back, AND AN OPERATOR CANNOT REFUSE A RESTORE.
 *
 * The owner answered the behaviour question ADR-0109 left open — *should a
 * re-scan re-open a miss while a restore is pending?* — with **yes**. So
 * `syncFindingLedger` now keys its read on the finding ALONE and RE-OPENS the
 * existing row; the second row is never written; the deny has nothing to
 * collide with; and the constraint is safe to add.
 *
 * Every one of those clauses is asserted below against a real HTTP surface —
 * ADR-0109's honest-limits section recorded that the hazard was "argued from
 * the code paths, not reproduced end-to-end through the HTTP surface", and this
 * file is that reproduction.
 *
 * SHARED-DATABASE RULES
 * ---------------------
 * 175 test files share one database (`fileParallelism: false`). Every fixture
 * here is prefixed `brr-`, every count is scoped to this file's own resources,
 * and nothing asserts an empty table.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  backupRuns,
  createDb,
  desc,
  eq,
  infraFindings,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "brr-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);
/** per-run token — this file shares its database with 174 others */
const T = `brr${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminAuth: { authorization: string };
let approverId: string;
let approverAuth: { authorization: string };

async function post(url: string, payload: unknown, headers = adminAuth) {
  return app.inject({ method: "POST", url, headers, payload: payload as object });
}
async function makeUser(email: string, displayName: string, isAdmin: boolean) {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email, displayName, isAdmin },
  });
  const id = u.json().id;
  const k = await app.inject({
    method: "POST",
    url: `/v1/users/${id}/keys`,
    headers: AUTH,
    payload: { name: "brr" },
  });
  return { id, auth: { authorization: `Bearer ${k.json().token}` } };
}
async function decide(approvalId: string, decision: "approved" | "denied") {
  return app.inject({
    method: "POST",
    url: `/v1/approvals/${approvalId}/decide`,
    headers: approverAuth,
    payload: { decision },
  });
}

/**
 * Create a backup_target resource whose mock provider always reports the backup
 * missing, and scan it once. Returns the finding and its single ledger row.
 */
async function newMissedBackup(label: string) {
  const res = await post("/v1/infra/resources", {
    name: `${T}-${label}`,
    kind: "backup_target",
    config: { hoursSinceLastBackup: 100 },
  });
  const resourceId = res.json().id;
  const scan = await post("/v1/infra/scan", { resourceId });
  expect(scan.statusCode).toBe(200);
  const rows = await ledgerRows(resourceId);
  expect(rows, `the scan did not raise a backup miss on ${label}`).toHaveLength(1);
  const [finding] = await db
    .select()
    .from(infraFindings)
    .where(and(eq(infraFindings.resourceId, resourceId), eq(infraFindings.kind, "backup_missed")));
  expect(finding).toBeTruthy();
  return { resourceId, findingId: finding!.id, runId: rows[0]!.id };
}

/** every kind='backup' ledger row for one resource, newest first */
async function ledgerRows(resourceId: string) {
  return db
    .select()
    .from(backupRuns)
    .where(and(eq(backupRuns.resourceId, resourceId), eq(backupRuns.kind, "backup")))
    .orderBy(desc(backupRuns.createdAt));
}

async function rescan(resourceId: string) {
  const r = await post("/v1/infra/scan", { resourceId });
  expect(r.statusCode).toBe(200);
  return r.json();
}

/** Walk an error chain for a pg SQLSTATE and the constraint it names. */
function pgErrorOf(err: unknown): { code?: string; constraint?: string } {
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i += 1) {
    const c = cur as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof c.code === "string") {
      return { code: c.code, constraint: typeof c.constraint === "string" ? c.constraint : undefined };
    }
    cur = c.cause;
  }
  return {};
}

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181 (FX2): an admin's API key now answers to mfaRequired. This suite
  // drives admins through keys and is not about MFA, so it relaxes the dial
  // explicitly and hands the shared database back strict in afterAll (M-068).
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  const admin = await makeUser(`${T}-admin@example.com`, "BRR Admin", true);
  adminAuth = admin.auth;
  const approver = await makeUser(`${T}-approver@example.com`, "BRR Approver", false);
  approverId = approver.id;
  approverAuth = approver.auth;
});

afterAll(async () => {
  await restoreAdminKeyMfa?.();
  await app.close();
});

describe("ADR-0110 — a re-scan RE-OPENS a pending restore proposal, in ONE row", () => {
  it("propose -> re-scan: still one row, back to 'missed', and the supersession is AUDITED", async () => {
    const { resourceId, findingId, runId } = await newMissedBackup("reopen");

    const proposed = await post(`/v1/infra/backups/${runId}/restore`, { approverUserId: approverId });
    expect(proposed.statusCode).toBe(202);
    expect((await ledgerRows(resourceId))[0]!.status).toBe("restore_proposed");

    await rescan(resourceId);

    // THE WHOLE POINT: one row, not two. Before ADR-0110 this was 2.
    const rows = await ledgerRows(resourceId);
    expect(rows, "the re-scan inserted a SECOND backup row — ADR-0110's fix is not in effect").toHaveLength(1);
    expect(rows[0]!.id).toBe(runId);
    expect(rows[0]!.status).toBe("missed");

    // ...and it is VISIBLE. An operator whose proposal disappeared must be able
    // to find out why, so the supersession is an audited fact with a reason.
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.objectType, "infra_operation"),
          eq(auditLog.objectId, findingId),
          eq(auditLog.ruleId, "infra-restore-proposal-superseded"),
        ),
      );
    expect(audits, "the superseded proposal was silent — no audit row").toHaveLength(1);
    expect(audits[0]!.reason).toContain("SUPERSEDED");
    expect((audits[0]!.detail as Record<string, unknown>).supersededStatus).toBe("restore_proposed");
    expect((audits[0]!.detail as Record<string, unknown>).ledgerId).toBe(runId);

    // the proposal is cheap to re-make — the row is 'missed', so /restore takes it again
    const again = await post(`/v1/infra/backups/${runId}/restore`, { approverUserId: approverId });
    expect(again.statusCode).toBe(202);
  });

  it("DENY after that re-scan still succeeds — the exact failure ADR-0109 refused the constraint over", async () => {
    const { resourceId, runId } = await newMissedBackup("deny");

    const proposed = await post(`/v1/infra/backups/${runId}/restore`, { approverUserId: approverId });
    expect(proposed.statusCode).toBe(202);
    const approvalId = proposed.json().approvalId;

    // the re-scan that used to write the second row
    await rescan(resourceId);
    expect(await ledgerRows(resourceId)).toHaveLength(1);

    // ADR-0109 §7 step 4. With a duplicate present this UPDATE raises 23505 and
    // the whole denial rolls back. It must not.
    const denied = await decide(approvalId, "denied");
    expect(denied.statusCode, `deny failed: ${denied.body}`).toBe(200);
    expect(denied.body).not.toContain("23505");
    expect(denied.body).not.toContain("conflict");

    const rows = await ledgerRows(resourceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("missed");
  });

  it("a restore that EXECUTED is not re-opened by a later re-scan", async () => {
    const { resourceId, runId } = await newMissedBackup("executed");

    const proposed = await post(`/v1/infra/backups/${runId}/restore`, { approverUserId: approverId });
    expect(proposed.statusCode).toBe(202);
    expect((await decide(proposed.json().approvalId, "approved")).statusCode).toBe(200);

    // the miss is CLOSED: the source row is terminal, and the restore itself is
    // its own kind='restore' row carrying the same finding_id (which is why the
    // index is partial on kind).
    expect((await ledgerRows(resourceId))[0]!.status).toBe("restored");
    const restoreRows = await db
      .select()
      .from(backupRuns)
      .where(and(eq(backupRuns.resourceId, resourceId), eq(backupRuns.kind, "restore")));
    expect(restoreRows).toHaveLength(1);
    expect(restoreRows[0]!.status).toBe("restored");

    // the mock provider still reports the backup missing, so this re-scan is
    // exactly the one that would wrongly re-open a completed restore.
    await rescan(resourceId);

    const rows = await ledgerRows(resourceId);
    expect(rows, "the re-scan inserted a second row against an executed restore").toHaveLength(1);
    expect(rows[0]!.id).toBe(runId);
    expect(rows[0]!.status, "a COMPLETED restore was re-opened — 'restored' must be terminal").toBe(
      "restored",
    );
    // and re-opening being refused is not the same as it being audited as a
    // supersession: nothing was superseded, so nothing is claimed.
    const audits = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.objectId, rows[0]!.findingId!),
          eq(auditLog.ruleId, "infra-restore-proposal-superseded"),
        ),
      );
    expect(audits[0]!.n).toBe(0);
  });
});

describe("ADR-0110 — the constraint bites (M-033: 23505 AND the named index)", () => {
  it("a second kind='backup' row for one finding is refused by backup_runs_finding_uq", async () => {
    const { resourceId, findingId } = await newMissedBackup("bite");

    let thrown: unknown;
    try {
      // deliberately DIFFERENT from its twin in every column but the key, so
      // nothing except finding_id can be doing the refusing.
      await db.insert(backupRuns).values({
        resourceId,
        findingId,
        kind: "backup",
        status: "failed",
        startedAt: new Date(),
        finishedAt: new Date(),
        sizeBytes: 4242,
        source: "test:brr",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown, "the duplicate write SUCCEEDED — backup_runs_finding_uq does not bite").toBeDefined();
    const { code, constraint } = pgErrorOf(thrown);
    // 23505 SPECIFICALLY — a CHECK (23514), NOT NULL (23502) or FK (23503)
    // failure would mean the fixture is wrong, not that the constraint works.
    expect(code, `expected SQLSTATE 23505, got ${code}`).toBe("23505");
    // and by THIS index, not some other unique index over the same fixture.
    expect(constraint).toBe("backup_runs_finding_uq");
  });

  it("the index is PARTIAL exactly where it claims: kind='restore' and NULL finding_id are outside it", async () => {
    const { resourceId, findingId } = await newMissedBackup("partial");

    // an executed restore's row carries the SAME finding_id by design. A TOTAL
    // index on finding_id would refuse it and break the approve path — which is
    // the class of failure ADR-0109 refused the index over.
    await db.insert(backupRuns).values({
      resourceId,
      findingId,
      kind: "restore",
      status: "restored",
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    // and the scheduler's verified rows have no finding at all — two of them on
    // one resource must still both insert.
    for (const size of [1, 2]) {
      await db.insert(backupRuns).values({
        resourceId,
        findingId: null,
        kind: "backup",
        status: "success",
        sizeBytes: size,
        source: "scheduler:mock",
      });
    }
    const all = await db.select().from(backupRuns).where(eq(backupRuns.resourceId, resourceId));
    // 1 missed + 1 restore + 2 success
    expect(all).toHaveLength(4);
  });
});

describe("ADR-0110 — the pre-flight now BLOCKS on backup_runs instead of noting it", () => {
  it("the backup_runs check is enforced, names migration 0109's index, and is clean here", async () => {
    const { DEFERRED_UNIQUE_CHECKS, runDeferredUniquePreflight } = await import("@regulait/db");
    const backup = DEFERRED_UNIQUE_CHECKS.find((c) => c.table === "backup_runs");
    expect(backup, "the backup_runs check vanished from the pre-flight").toBeTruthy();
    expect(backup!.enforced, "backup_runs is still advisory — ADR-0110 makes it a blocker").toBe(true);
    expect(backup!.index).toBe("backup_runs_finding_uq");
    expect(backup!.predicate).toBe("kind = 'backup' AND finding_id IS NOT NULL");

    // the index it names really exists — this is what stops the report and the
    // migration drifting apart.
    const n = (
      (await db.execute(
        sql`select count(*)::int as n from pg_indexes where indexname = 'backup_runs_finding_uq'`,
      )) as unknown as { rows: Array<{ n: number }> }
    ).rows[0]!.n;
    expect(n, "the pre-flight names backup_runs_finding_uq but it does not exist").toBe(1);

    const report = await runDeferredUniquePreflight(db);
    expect(report.blocking).toEqual([]);
    expect(report.clean).toBe(true);
  });
});
