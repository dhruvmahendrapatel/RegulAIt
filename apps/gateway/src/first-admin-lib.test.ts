/**
 * ADR-0194 — the installer's first admin (first-admin-lib.ts and the
 * first-admin.js CLI scripts/install.sh runs inside the gateway container).
 *
 *  1. Refusals change nothing: an invalid username or email (exit 5), a
 *     password the org policy refuses (exit 4) — and the refusal never echoes
 *     the password.
 *  2. Creation: one active admin, username normalised by the shared schema,
 *     the operator's password verifies, NOT must-change, and the audit rows
 *     (`first-admin-created`, `username-set`, `initial-password-set`) are
 *     written with neither the password nor its hash anywhere in them.
 *  3. Re-run: with an active admin it skips (exit 3) and changes nothing,
 *     without needing a valid password; two concurrent runs create ONE admin.
 *  4. The CLI: the password comes on stdin only, is never printed, and the
 *     exit codes are the ones install.sh branches on.
 *
 * Each describe block owns a scratch database (the shared test database
 * already has admins, and "no admin yet" is the state under test).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditLog, createDb, eq, inArray, runMigrations, sql, users, type Db } from "@regulait/db";
import { verifyPassword } from "./auth.js";
import { createFirstAdmin, firstAdminStatus } from "./first-admin-lib.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../../packages/db/migrations");
const cliScript = path.resolve(here, "../dist/first-admin.js");

function scratchUrlFor(name: string): string {
  const u = new URL(DATABASE_URL!);
  u.pathname = "/" + name;
  return u.toString();
}

/** synthetic, minted per run — never a real password (gitleaks: CANARY) */
const strongPassword = () => `CANARY-${randomBytes(9).toString("base64url")}-Aa1!`;
const WEAK = "CANARYweak";

async function firstAdminAuditRows(db: Db) {
  return db
    .select()
    .from(auditLog)
    .where(inArray(auditLog.ruleId, ["first-admin-created", "username-set", "initial-password-set"]));
}

describe("createFirstAdmin (first-admin-lib.ts)", () => {
  const SCRATCH_DB = `regulait_first_admin_lib_${process.pid}_${Date.now()}`;
  let admin: Db;
  let db: Db;

  beforeAll(async () => {
    admin = createDb(DATABASE_URL);
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
    await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
    db = createDb(scratchUrlFor(SCRATCH_DB));
    await runMigrations(db, migrationsFolder);
  }, 120_000);

  afterAll(async () => {
    await closeAll([
      () => (db.$client as { end: () => Promise<void> }).end(),
      () => dropScratchDatabase(admin, SCRATCH_DB),
      () => (admin.$client as { end: () => Promise<void> }).end(),
    ]);
  });

  it("status: no admin yet", async () => {
    expect((await firstAdminStatus(db)).exitCode).toBe(0);
  });

  it("refuses an invalid username or email (exit 5) and creates nothing", async () => {
    for (const username of ["a", "Bad User", "x@y", "-lead", "a".repeat(70)]) {
      const r = await createFirstAdmin(db, { username, email: "ops@acme.example", password: strongPassword() });
      expect(r.exitCode, username).toBe(5);
      expect(r.lines.join("\n")).toContain("username refused");
    }
    const bad = await createFirstAdmin(db, { username: "admin", email: "not-an-email", password: strongPassword() });
    expect(bad.exitCode).toBe(5);
    expect(bad.lines.join("\n")).toContain("email refused");
    expect(await db.select({ id: users.id }).from(users)).toHaveLength(0);
  });

  it("refuses a password the org policy refuses (exit 4), never echoing it, and creates nothing", async () => {
    for (const weak of [WEAK, "CANARYCANARYCANARY", "canaryalllowerletters"]) {
      const r = await createFirstAdmin(db, { username: "admin", email: "ops@acme.example", password: weak });
      expect(r.exitCode, weak).toBe(4);
      expect(r.outcome).toBe("password_refused");
      expect(r.lines.join("\n")).toContain("org password policy");
      expect(r.lines.join("\n")).not.toContain(weak);
    }
    expect(await db.select({ id: users.id }).from(users)).toHaveLength(0);
    expect(await firstAdminAuditRows(db)).toHaveLength(0);
  });

  it("refuses a username another (non-admin) account holds (exit 5)", async () => {
    const [member] = await db
      .insert(users)
      .values({ email: "member@acme.example", displayName: "member", username: "taken" })
      .returning({ id: users.id });
    try {
      const r = await createFirstAdmin(db, { username: "taken", email: "ops@acme.example", password: strongPassword() });
      expect(r.exitCode).toBe(5);
      expect(r.lines.join("\n")).toContain("already belongs to another account");
      const sameEmail = await createFirstAdmin(db, { username: "admin", email: "MEMBER@acme.example", password: strongPassword() });
      expect(sameEmail.exitCode).toBe(5);
    } finally {
      await db.delete(users).where(eq(users.id, member!.id));
    }
  });

  let created: { id: string; password: string } | undefined;

  it("creates the first admin: normalised username, the operator's password, not must-change, audited without the password", async () => {
    const password = strongPassword();
    const r = await createFirstAdmin(db, { username: " Admin ", email: " ops@acme.example ", password });
    expect(r.exitCode, r.lines.join("\n")).toBe(0);
    expect(r.outcome).toBe("created");
    expect(r.username).toBe("admin");
    expect(r.lines.join("\n")).not.toContain(password);

    const [u] = await db.select().from(users).where(eq(users.id, r.userId!));
    expect(u).toMatchObject({ username: "admin", email: "ops@acme.example", isAdmin: true, mustChangePassword: false, disabledAt: null });
    expect(u!.passwordUpdatedAt).toBeInstanceOf(Date);
    expect(verifyPassword(password, u!.passwordHash)).toBe(true);

    const rows = await firstAdminAuditRows(db);
    expect(rows.map((a) => a.ruleId).sort()).toEqual(["first-admin-created", "initial-password-set", "username-set"]);
    for (const a of rows) {
      expect(a.objectId).toBe(r.userId);
      expect(a.objectType).toBe("user");
      expect(a.effect).toBe("allow");
      const text = JSON.stringify(a);
      expect(text).not.toContain(password);
      expect(text).not.toContain(u!.passwordHash!);
      expect(text).not.toContain("scrypt$");
    }
    const pw = rows.find((a) => a.ruleId === "initial-password-set")!;
    expect(pw.detail).toMatchObject({ phase: "set-initial-password", mustChangePassword: false, via: "installer" });
    expect((await firstAdminStatus(db)).exitCode).toBe(3);
    created = { id: r.userId!, password };
  });

  it("a re-run skips (exit 3) and changes nothing — even with a weak or empty password", async () => {
    expect(created).toBeDefined();
    const usersBefore = await db.select({ id: users.id, h: users.passwordHash }).from(users).orderBy(users.id);
    const auditBefore = await db.select({ n: sql<number>`count(*)::int` }).from(auditLog);
    for (const password of ["", WEAK, strongPassword()]) {
      const r = await createFirstAdmin(db, { username: "second", email: "second@acme.example", password });
      expect(r.exitCode).toBe(3);
      expect(r.outcome).toBe("admin_exists");
    }
    expect(await db.select({ id: users.id, h: users.passwordHash }).from(users).orderBy(users.id)).toEqual(usersBefore);
    expect(await db.select({ n: sql<number>`count(*)::int` }).from(auditLog)).toEqual(auditBefore);
  });

  it("two concurrent runs on an admin-less database create exactly one admin", async () => {
    // make the database admin-less again (the account above stays, demoted)
    await db.update(users).set({ isAdmin: false }).where(eq(users.id, created!.id));
    const [a, b] = await Promise.all([
      createFirstAdmin(db, { username: "racer-a", email: "a@acme.example", password: strongPassword() }),
      createFirstAdmin(db, { username: "racer-b", email: "b@acme.example", password: strongPassword() }),
    ]);
    expect([a.exitCode, b.exitCode].sort()).toEqual([0, 3]);
    const admins = await db.select({ id: users.id }).from(users).where(eq(users.isAdmin, true));
    expect(admins).toHaveLength(1);
  });
});

describe("first-admin.js (the CLI install.sh runs in the gateway container)", () => {
  const SCRATCH_DB = `regulait_first_admin_cli_${process.pid}_${Date.now()}`;
  let admin: Db;
  let db: Db;

  function cli(args: string[], stdin = "") {
    const r = spawnSync(process.execPath, [cliScript, ...args], {
      input: stdin,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: scratchUrlFor(SCRATCH_DB) },
      timeout: 60_000,
    });
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  beforeAll(async () => {
    admin = createDb(DATABASE_URL);
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
    await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
    db = createDb(scratchUrlFor(SCRATCH_DB));
    await runMigrations(db, migrationsFolder);
  }, 120_000);

  afterAll(async () => {
    await closeAll([
      () => (db.$client as { end: () => Promise<void> }).end(),
      () => dropScratchDatabase(admin, SCRATCH_DB),
      () => (admin.$client as { end: () => Promise<void> }).end(),
    ]);
  });

  it("--status, a policy refusal, creation from stdin, then --status 3 and a skipping re-run — never printing the password", async () => {
    expect(cli(["--status"]).status).toBe(0);

    const weak = cli(["--username", "admin", "--email", "ops@acme.example"], `${WEAK}\n`);
    expect(weak.status).toBe(4);
    expect(weak.out).not.toContain(WEAK);

    expect(cli(["--username", "admin", "--email", "ops@acme.example"], "").status).toBe(2);
    expect(cli(["--username", "admin"]).status).toBe(2);

    const password = strongPassword();
    const made = cli(["--username", "admin", "--email", "ops@acme.example"], `${password}\n`);
    expect(made.status, made.out).toBe(0);
    expect(made.out).toContain("first admin created");
    expect(made.out).not.toContain(password);
    // the trailing newline was the pipe's, not the password's
    const [u] = await db.select().from(users).where(eq(users.username, "admin"));
    expect(verifyPassword(password, u!.passwordHash)).toBe(true);

    expect(cli(["--status"]).status).toBe(3);
    const again = cli(["--username", "other", "--email", "other@acme.example"], `${strongPassword()}\n`);
    expect(again.status).toBe(3);
    expect(again.out).toContain("already exists");
  }, 120_000);
});
