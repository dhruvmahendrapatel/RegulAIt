/**
 * ADR-0063 §4's NAMED FOLLOW-UP, PROVED BY ATTACK — the re-encryption walk.
 *
 * The claim under test is the one the rotation override could not make:
 * *"after this ran, every ciphertext row is genuinely under the new key."*
 * So the central test proves it in BOTH directions — every seeded row, across
 * three different ciphertext-bearing tables, decrypts under key B **and
 * throws under key A** — rather than trusting a counter.
 *
 * Everything else follows from taking resumability and honesty seriously:
 *
 *  - a KILL mid-walk (simulated by aborting after N committed batches) must
 *    leave a state the next invocation finishes with NO double-processing —
 *    asserted by byte-identical ciphertext for already-settled rows (a second
 *    encryption would mint a fresh IV) and a zero `already_current` count on
 *    the resumed leg — and NO missed rows;
 *  - a row that decrypts under NEITHER key is recorded (table + id) and
 *    walked past, and the run's final status is `completed_with_failures`,
 *    NEVER `completed`;
 *  - a ciphertext column the registry does not name makes the walk REFUSE to
 *    start (fail closed) — proved by planting one and watching the refusal;
 *  - both full keys are required; fingerprints cannot decrypt and are not
 *    accepted; nothing-to-do is a disclosed success, not silent work.
 *
 * Shared-suite hygiene: this file owns its scratch database end to end
 * (created in beforeAll, dropped via the established scratch-db helper) —
 * the walk rewrites real table rows and must never do that under a database
 * any other file reads.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  dataKeyReencryptionFailures,
  dataKeyReencryptionProgress,
  dataKeyReencryptionRuns,
  dataKeyState,
  eq,
  gitConnections,
  modelCredentials,
  runMigrations,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import {
  DATA_KEY_ENV,
  DATA_KEY_OLD_ENV,
  DataKeyBootError,
  dataKeyFingerprint,
  dataKeyPosture,
  verifyDataKeyOnBoot,
} from "./data-key.js";
import {
  REENCRYPTION_RULE_IDS,
  ReencryptionAborted,
  findCiphertextRegistryDrift,
  runReencryptionWalk,
} from "./data-key-reencrypt.js";
import { decryptSecret, encryptSecret, storedKeyFingerprint } from "./secrets.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

// Per-RUN unique (pid + timestamp): a fixed name plus beforeAll's
// DROP ... WITH (FORCE) lets two concurrent runs on one host destroy each
// other's database (PENDING §5); afterAll drops this one, so nothing persists.
const SCRATCH_DB = `regulait_dk_reencrypt_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + SCRATCH_DB;
  return u.toString();
})();
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "reencrypt-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };

const KEY_A = "1".repeat(64); // the old key
const KEY_B = "2".repeat(64); // the new key
const KEY_C = "3".repeat(64); // a key nobody holds — makes corrupt rows
const FP_A = dataKeyFingerprint(KEY_A);
const FP_B = dataKeyFingerprint(KEY_B);

let admin: Db;
let db: Db;

/** strip the batch-B4 fingerprint segment — the shape of every value written
 * before this change */
function legacy(ct: string): string {
  return ct.split(".").slice(0, 3).join(".");
}

interface SeededRow {
  table: string;
  id: string;
  plaintext: string;
  ciphertext: string;
}

/** rows across THREE different ciphertext-bearing tables, all under `key`,
 * in the LEGACY (unmarked) shape a real pre-B4 deployment holds */
async function seedFixtures(key: string, n = 3): Promise<SeededRow[]> {
  const out: SeededRow[] = [];
  for (let i = 0; i < n; i++) {
    const pt = `totp-secret-${i}`;
    const ct = legacy(encryptSecret(key, pt));
    const [u] = await db
      .insert(users)
      .values({ email: `walker-${i}-${Date.now()}@example.com`, displayName: `Walker ${i}`, totpSecretCiphertext: ct })
      .returning();
    out.push({ table: "users", id: u!.id, plaintext: pt, ciphertext: ct });
  }
  for (let i = 0; i < n; i++) {
    const pt = `model-key-${i}`;
    const ct = legacy(encryptSecret(key, pt));
    const [m] = await db
      .insert(modelCredentials)
      .values({ provider: `walk-provider-${i}-${Date.now()}`, keyCiphertext: ct })
      .returning();
    out.push({ table: "model_credentials", id: m!.id, plaintext: pt, ciphertext: ct });
  }
  for (let i = 0; i < n; i++) {
    const pt = `git-token-${i}`;
    const ct = legacy(encryptSecret(key, pt));
    const [g] = await db
      .insert(gitConnections)
      .values({ name: `walk-git-${i}-${Date.now()}`, provider: "mock", tokenCiphertext: ct })
      .returning();
    out.push({ table: "git_connections", id: g!.id, plaintext: pt, ciphertext: ct });
  }
  return out;
}

const COLUMN_OF: Record<string, string> = {
  users: "totp_secret_ciphertext",
  model_credentials: "key_ciphertext",
  git_connections: "token_ciphertext",
};

async function ciphertextOf(row: SeededRow): Promise<string> {
  const res = await db.execute(
    sql.raw(`SELECT ${COLUMN_OF[row.table]} AS v FROM ${row.table} WHERE id = '${row.id}'`),
  );
  return String((res as unknown as { rows: Array<{ v: string }> }).rows[0]!.v);
}

/** wipe everything a previous scenario wrote, so each describe block starts
 * from a known state in this file's own database */
async function resetScenario(recordedFingerprint: string | null): Promise<void> {
  await db.delete(dataKeyReencryptionFailures);
  await db.delete(dataKeyReencryptionProgress);
  await db.delete(dataKeyReencryptionRuns);
  await db.delete(users);
  await db.delete(modelCredentials);
  await db.delete(gitConnections);
  await db.delete(dataKeyState);
  if (recordedFingerprint !== null) {
    await db.insert(dataKeyState).values({ fingerprint: recordedFingerprint });
  }
}

async function auditCount(ruleId: string): Promise<number> {
  const rows = await db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId));
  return rows.length;
}

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(scratchUrl);
  await runMigrations(db, migrationsFolder);
}, 60_000);

afterAll(async () => {
  await closeAll([
    async () => {
      await dropScratchDatabase(admin, SCRATCH_DB);
    },
  ]);
});

// ===========================================================================
// 1. THE ENVELOPE'S NEW MARKER — the detection the walk's idempotence rides on
// ===========================================================================

describe("the ciphertext key marker", () => {
  it("new writes carry the encrypting key's fingerprint as a fourth segment", () => {
    const ct = encryptSecret(KEY_A, "hello");
    expect(ct.split(".")).toHaveLength(4);
    expect(storedKeyFingerprint(ct)).toBe(FP_A);
    expect(decryptSecret(KEY_A, ct)).toBe("hello");
  });

  it("legacy three-segment values still decrypt, and report no marker", () => {
    const ct = legacy(encryptSecret(KEY_A, "hello"));
    expect(ct.split(".")).toHaveLength(3);
    expect(storedKeyFingerprint(ct)).toBeNull();
    expect(decryptSecret(KEY_A, ct)).toBe("hello");
  });

  it("the marker is a claim, not a proof — the GCM tag still decides", () => {
    // a marker naming key B on a value encrypted under key A must not make
    // key B able to open it
    const parts = encryptSecret(KEY_A, "hello").split(".");
    const lied = [parts[0], parts[1], parts[2], FP_B.slice(FP_B.indexOf(":") + 1)].join(".");
    expect(storedKeyFingerprint(lied)).toBe(FP_B);
    expect(() => decryptSecret(KEY_B, lied)).toThrow();
    expect(decryptSecret(KEY_A, lied)).toBe("hello");
  });
});

// ===========================================================================
// 2. REFUSALS — the walk must not start on a half-truth
// ===========================================================================

describe("refusals", () => {
  it("refuses without BOTH full keys, naming exactly what is missing", async () => {
    await resetScenario(FP_A);
    const runsBefore = (await db.select().from(dataKeyReencryptionRuns)).length;

    const noOld = await runReencryptionWalk(db, { newKeyHex: KEY_B, oldKeyHex: undefined });
    expect(noOld.kind).toBe("refused");
    expect((noOld as { reason: string }).reason).toContain(DATA_KEY_OLD_ENV);
    expect((noOld as { reason: string }).reason).toContain("not its fingerprint");

    const noNew = await runReencryptionWalk(db, { newKeyHex: undefined, oldKeyHex: KEY_A });
    expect(noNew.kind).toBe("refused");
    expect((noNew as { reason: string }).reason).toContain(DATA_KEY_ENV);

    // a FINGERPRINT in the old-key slot (the natural operator mistake — it is
    // what REGULAIT_DATA_KEY_ROTATED_FROM holds) is malformed, not accepted
    const fpNotKey = await runReencryptionWalk(db, { newKeyHex: KEY_B, oldKeyHex: FP_A });
    expect(fpNotKey.kind).toBe("refused");

    const sameKey = await runReencryptionWalk(db, { newKeyHex: KEY_A, oldKeyHex: KEY_A });
    expect(sameKey.kind).toBe("refused");
    expect((sameKey as { reason: string }).reason).toContain("SAME key");

    // none of the refusals created a run
    expect((await db.select().from(dataKeyReencryptionRuns)).length).toBe(runsBefore);
  });

  it("FAILS CLOSED when a ciphertext column exists that CIPHERTEXT_COLUMNS does not name", async () => {
    await resetScenario(FP_A);
    await db.execute(sql.raw(`CREATE TABLE walk_drift_probe (id uuid PRIMARY KEY, sneaky_ciphertext text)`));
    try {
      const drift = await findCiphertextRegistryDrift(db);
      expect(drift.join(" ")).toContain("walk_drift_probe.sneaky_ciphertext");

      const refused = await runReencryptionWalk(db, { newKeyHex: KEY_B, oldKeyHex: KEY_A });
      expect(refused.kind).toBe("refused");
      expect((refused as { reason: string }).reason).toContain("walk_drift_probe.sneaky_ciphertext");
      expect((refused as { reason: string }).reason).toContain("REFUSING TO WALK");
      expect(await db.select().from(dataKeyReencryptionRuns)).toEqual([]);
    } finally {
      await db.execute(sql.raw(`DROP TABLE walk_drift_probe`));
    }
    // with the stray column gone the registry is clean again
    expect(await findCiphertextRegistryDrift(db)).toEqual([]);
  });
});

// ===========================================================================
// 3. THE WALK — every row under B, and NOT under A, across three tables
// ===========================================================================

describe("the walk", () => {
  let seeded: SeededRow[];

  it("re-encrypts every row across three tables — provable in BOTH directions", async () => {
    await resetScenario(FP_A);
    seeded = await seedFixtures(KEY_A);
    // one row that was ALREADY written under the new key, in legacy unmarked
    // shape — the try-old-then-new path must settle it without failing it
    const preNewPt = "already-under-b";
    const [preNew] = await db
      .insert(modelCredentials)
      .values({ provider: `walk-pre-new-${Date.now()}`, keyCiphertext: legacy(encryptSecret(KEY_B, preNewPt)) })
      .returning();

    const startedBefore = await auditCount(REENCRYPTION_RULE_IDS.started);
    const completedBefore = await auditCount(REENCRYPTION_RULE_IDS.completed);

    const outcome = await runReencryptionWalk(db, { newKeyHex: KEY_B, oldKeyHex: KEY_A, batchSize: 2 });
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("unreachable");

    // THE CLAIM, both directions, per row: decrypts under B, throws under A,
    // carries B's marker, and the stored bytes actually changed
    for (const row of seeded) {
      const ct = await ciphertextOf(row);
      expect(ct).not.toBe(row.ciphertext);
      expect(decryptSecret(KEY_B, ct)).toBe(row.plaintext);
      expect(() => decryptSecret(KEY_A, ct)).toThrow();
      expect(storedKeyFingerprint(ct)).toBe(FP_B);
    }

    // the legacy row already under B: settled (marker added), counted as
    // already-current, NOT as a failure
    const [preNewAfter] = await db.select().from(modelCredentials).where(eq(modelCredentials.id, preNew!.id));
    expect(decryptSecret(KEY_B, preNewAfter!.keyCiphertext)).toBe(preNewPt);
    expect(storedKeyFingerprint(preNewAfter!.keyCiphertext)).toBe(FP_B);
    expect(outcome.failures).toEqual([]);

    // the per-table accounting matches what was seeded
    const byTable = Object.fromEntries(outcome.perColumn.map((c) => [`${c.table}.${c.column}`, c]));
    expect(byTable["users.totp_secret_ciphertext"]).toMatchObject({ reencrypted: 3, failed: 0 });
    expect(byTable["model_credentials.key_ciphertext"]).toMatchObject({ reencrypted: 3, alreadyCurrent: 1, failed: 0 });
    expect(byTable["git_connections.token_ciphertext"]).toMatchObject({ reencrypted: 3, failed: 0 });

    // the deployment's recorded identity moved with the ciphertext
    const [state] = await db.select().from(dataKeyState);
    expect(state?.fingerprint).toBe(FP_B);
    expect(state?.rotatedFrom).toBe(FP_A);

    // the run record is finished and honest
    const [run] = await db.select().from(dataKeyReencryptionRuns).where(eq(dataKeyReencryptionRuns.id, outcome.runId));
    expect(run?.status).toBe("completed");
    expect(run?.finishedAt).not.toBeNull();

    // audited: one started, one completed (deltas, M-008)
    expect(await auditCount(REENCRYPTION_RULE_IDS.started)).toBe(startedBefore + 1);
    expect(await auditCount(REENCRYPTION_RULE_IDS.completed)).toBe(completedBefore + 1);
  });

  it("after the walk, boot under the NEW key alone succeeds cleanly", async () => {
    const res = await verifyDataKeyOnBoot(db, KEY_B, {});
    expect(res.code).toBe("verified");
    expect(res.pendingReencryption).toBeNull();
  });

  it("a second invocation has NOTHING TO DO and says so instead of pretending to work", async () => {
    const runsBefore = (await db.select().from(dataKeyReencryptionRuns)).length;
    const again = await runReencryptionWalk(db, { newKeyHex: KEY_B, oldKeyHex: KEY_A });
    expect(again.kind).toBe("nothing_to_do");
    expect((again as { message: string }).message).toContain("destroy it per the custody runbook");
    // no new run, no rewrites
    expect((await db.select().from(dataKeyReencryptionRuns)).length).toBe(runsBefore);
    for (const row of seeded.slice(0, 2)) {
      expect(decryptSecret(KEY_B, await ciphertextOf(row))).toBe(row.plaintext);
    }
  });
});

// ===========================================================================
// 4. RESUME AFTER A KILL — no double-processing, no missed rows
// ===========================================================================

describe("resume after a kill", () => {
  it("a killed walk resumes from its exact watermark", async () => {
    await resetScenario(FP_A);
    const rows: SeededRow[] = [];
    for (let i = 0; i < 7; i++) {
      const pt = `kill-totp-${i}`;
      const ct = legacy(encryptSecret(KEY_A, pt));
      const [u] = await db
        .insert(users)
        .values({ email: `kill-${i}@example.com`, displayName: `Kill ${i}`, totpSecretCiphertext: ct })
        .returning();
      rows.push({ table: "users", id: u!.id, plaintext: pt, ciphertext: ct });
    }

    // KILL: abort after 2 committed batches of 2 — 4 rows settled, 3 not
    await expect(
      runReencryptionWalk(db, { newKeyHex: KEY_B, oldKeyHex: KEY_A, batchSize: 2, abortAfterBatches: 2 }),
    ).rejects.toBeInstanceOf(ReencryptionAborted);

    const [killedRun] = await db.select().from(dataKeyReencryptionRuns);
    expect(killedRun?.status).toBe("running");
    const settled: Array<{ row: SeededRow; ct: string }> = [];
    let unsettled = 0;
    for (const row of rows) {
      const ct = await ciphertextOf(row);
      if (storedKeyFingerprint(ct) === FP_B) settled.push({ row, ct });
      else unsettled += 1;
    }
    expect(settled.length).toBe(4);
    expect(unsettled).toBe(3);
    // the fingerprint has NOT been re-recorded — the walk is not done
    const [midState] = await db.select().from(dataKeyState);
    expect(midState?.fingerprint).toBe(FP_A);

    // MID-WALK BOOT under the new key alone: still a refusal (the recorded
    // fingerprint is honest), but the refusal names the unfinished walk and
    // the EXACT resume command instead of the abandon-the-ciphertext remedy
    const attempt = await verifyDataKeyOnBoot(db, KEY_B, {}).then(
      () => null,
      (err: unknown) => err,
    );
    expect(attempt).toBeInstanceOf(DataKeyBootError);
    expect((attempt as DataKeyBootError).message).toContain("UNFINISHED RE-ENCRYPTION WALK");
    expect((attempt as DataKeyBootError).message).toContain("pnpm --filter @regulait/gateway reencrypt");
    // ... and the posture read says the same, with both keys still needed
    const posture = await dataKeyPosture(db, KEY_B);
    expect(posture.warnings.join(" ")).toContain("INCOMPLETE");
    expect(posture.warnings.join(" ")).toContain("Keep BOTH keys available");

    // RESUME: same keys, no abort
    const resumed = await runReencryptionWalk(db, { newKeyHex: KEY_B, oldKeyHex: KEY_A, batchSize: 2 });
    expect(resumed.kind).toBe("completed");
    if (resumed.kind !== "completed") throw new Error("unreachable");
    expect(resumed.resumed).toBe(true);
    expect(resumed.runId).toBe(killedRun!.id);

    // NO DOUBLE-PROCESSING: rows settled before the kill are BYTE-IDENTICAL
    // (re-encrypting them again would have minted a fresh IV)
    for (const s of settled) {
      expect(await ciphertextOf(s.row)).toBe(s.ct);
    }
    // NO MISSED ROWS: every row decrypts under B and not under A
    for (const row of rows) {
      const ct = await ciphertextOf(row);
      expect(decryptSecret(KEY_B, ct)).toBe(row.plaintext);
      expect(() => decryptSecret(KEY_A, ct)).toThrow();
    }
    // the run's cumulative accounting proves the resumed leg started at the
    // watermark: 7 re-encrypted in total, and NOTHING re-read as
    // already-current (a restart-from-zero would have re-read the 4 settled
    // rows and counted them here)
    const usersCol = resumed.perColumn.find((c) => c.table === "users")!;
    expect(usersCol.reencrypted).toBe(7);
    expect(usersCol.alreadyCurrent).toBe(0);
    expect(usersCol.failed).toBe(0);

    // and NOW the boot under the new key alone is clean
    const clean = await verifyDataKeyOnBoot(db, KEY_B, {});
    expect(clean.code).toBe("verified");
    expect(clean.pendingReencryption).toBeNull();
  });

  it("a pending walk under DIFFERENT keys refuses rather than interleaving", async () => {
    // leave a running run in place under A -> B
    await resetScenario(FP_A);
    await seedFixtures(KEY_A, 1);
    await expect(
      runReencryptionWalk(db, { newKeyHex: KEY_B, oldKeyHex: KEY_A, batchSize: 1, abortAfterBatches: 1 }),
    ).rejects.toBeInstanceOf(ReencryptionAborted);

    const other = await runReencryptionWalk(db, { newKeyHex: KEY_C, oldKeyHex: KEY_A });
    expect(other.kind).toBe("refused");
    expect((other as { reason: string }).reason).toContain("UNFINISHED");

    // finish the real one so the next scenario starts clean
    const done = await runReencryptionWalk(db, { newKeyHex: KEY_B, oldKeyHex: KEY_A });
    expect(done.kind).toBe("completed");
  });
});

// ===========================================================================
// 5. THE CORRUPT ROW — recorded, walked past, and NEVER called success
// ===========================================================================

describe("a row that decrypts under neither key", () => {
  it("is recorded with its table + id, the walk CONTINUES, and the status is completed_with_failures", async () => {
    await resetScenario(FP_A);
    const good = await seedFixtures(KEY_A, 2);
    // ciphertext under a key NOBODY holds — the corrupt-row case
    const corpseCt = legacy(encryptSecret(KEY_C, "lost"));
    const [corpse] = await db
      .insert(users)
      .values({ email: "corpse@example.com", displayName: "Corpse", totpSecretCiphertext: corpseCt })
      .returning();

    const outcome = await runReencryptionWalk(db, { newKeyHex: KEY_B, oldKeyHex: KEY_A, batchSize: 2 });
    expect(outcome.kind).toBe("completed_with_failures");
    if (outcome.kind !== "completed_with_failures") throw new Error("unreachable");

    // the corpse is named
    expect(outcome.failures).toEqual([{ table: "users", column: "totp_secret_ciphertext", rowId: corpse!.id }]);
    const [failureRow] = await db.select().from(dataKeyReencryptionFailures);
    expect(failureRow).toMatchObject({ tableName: "users", rowId: corpse!.id });

    // ONE corrupt row did not brick the rotation: every other row, including
    // rows AFTER the corpse in the same table, is under B
    for (const row of good) {
      const ct = await ciphertextOf(row);
      expect(decryptSecret(KEY_B, ct)).toBe(row.plaintext);
      expect(() => decryptSecret(KEY_A, ct)).toThrow();
    }
    // the corpse itself was left untouched, not destroyed
    const [corpseAfter] = await db.select().from(users).where(eq(users.id, corpse!.id));
    expect(corpseAfter?.totpSecretCiphertext).toBe(corpseCt);
    expect(storedKeyFingerprint(corpseAfter!.totpSecretCiphertext!)).toBeNull();

    // the run and the audit record both refuse the word "completed"
    const [run] = await db.select().from(dataKeyReencryptionRuns).where(eq(dataKeyReencryptionRuns.id, outcome.runId));
    expect(run?.status).toBe("completed_with_failures");
    // ADR-0108: by this point the file has run FOUR walks, so four
    // `completed` rows exist — and only THIS one says completed_with_failures
    // and names the corpse. `.at(-1)` on an unordered read picks whichever row
    // the heap happens to hold last, which is not "the newest" and is not
    // stable across a row rewrite. Pin the row this walk wrote, by the same
    // run id the `data_key_reencryption_runs` lookup above already uses.
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.ruleId, REENCRYPTION_RULE_IDS.completed),
          sql`${auditLog.detail}->>'runId' = ${outcome.runId}`,
        ),
      );
    const last = audits.at(-1)!;
    expect(last.reason).toContain("completed_with_failures");
    expect(last.reason).toContain(corpse!.id);
    expect((last.detail as { status?: string }).status).toBe("completed_with_failures");
  });
});

// ===========================================================================
// 6. THE STATUS ENDPOINT — readable over HTTP; the walk is not drivable there
// ===========================================================================

describe("GET /v1/security/data-key/reencryption", () => {
  it("reports the latest run, the resume command, and is admin-only", async () => {
    const app = buildApp(db, { bootstrapToken: BOOT, dataKey: KEY_B });
    try {
      const res = await app.inject({ method: "GET", headers: AUTH, url: "/v1/security/data-key/reencryption" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // scenario 5's run is the latest: finished, honest about its failures
      expect(body.run.status).toBe("completed_with_failures");
      expect(body.run.fromFingerprint).toBe(FP_A);
      expect(body.run.toFingerprint).toBe(FP_B);
      expect(body.run.failures).toHaveLength(1);
      expect(body.resumeCommand).toContain("pnpm --filter @regulait/gateway reencrypt");
      expect(body.note).toContain("NEITHER key");

      // a non-admin member gets the same 403 as the rest of /v1/security
      const member = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/users",
        payload: { email: "walk-member@example.com", displayName: "Member" },
      });
      const key = await app.inject({
        method: "POST",
        headers: AUTH,
        url: `/v1/users/${member.json().id}/keys`,
        payload: { name: "cli" },
      });
      const memberRes = await app.inject({
        method: "GET",
        headers: { authorization: `Bearer ${key.json().token}` },
        url: "/v1/security/data-key/reencryption",
      });
      expect(memberRes.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
