/**
 * ADR-0174 amendment — the demo password under Docker Compose.
 *
 * `docker compose up` seeds the demo (SEED_DEMO=1) on EVERY boot, and
 * `demo:set-passwords` needs a valid demo licence. One opt-in switch,
 * REGULAIT_DEMO_LICENSE=1, makes the seed mint its ephemeral licence into a
 * named-volume keyring the gateway also reads. Pinned here:
 *
 *  1. the image's start script: only the exact value "1" (with SEED_DEMO=1,
 *     and not on a byoc/air_gapped deployment) sets REGULAIT_EPHEMERAL_LICENSE
 *     and REGULAIT_LICENSE_KEYRING; anything else leaves both UNSET, so the
 *     gateway reads its default keyring exactly as before;
 *  2. an empty REGULAIT_LICENSE_KEYRING falls back to the default keyring;
 *  3. the compose / Dockerfile shapes (read as text, no daemon);
 *  4. the installer refuses the switch and pins it off in its override;
 *  5. a re-seed (a gateway restart) KEEPS a valid demo licence instead of
 *     minting a new one, and does not touch a demo password already set —
 *     run against the BUILT seed (dist/seed.js), twice, on a scratch database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditLog, createDb, eq, inArray, licenses, sql, users, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { DEMO_PERSONA_EMAILS, isDemoLicense, setDemoPasswords } from "./demo-set-passwords-lib.js";
import { ensureEphemeralLicense, type EphemeralLicenseInject } from "./ephemeral-license.js";
import { licenseKeyringDir, resolveLicense } from "./licensing.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const startScript = path.join(root, "apps/gateway/docker-start.sh");

// ---------------------------------------------------------------------------
// 1. the start script
// ---------------------------------------------------------------------------

/** runs docker-start.sh with a fake `node` that records what it was started with */
function runStart(env: Record<string, string>): { calls: string[]; stderr: string; stdout: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "docker-start-"));
  try {
    const log = path.join(dir, "calls.log");
    const fake = path.join(dir, "node");
    writeFileSync(
      fake,
      '#!/bin/sh\necho "$1 keyring=${REGULAIT_LICENSE_KEYRING-<unset>} ephemeral=${REGULAIT_EPHEMERAL_LICENSE-<unset>}" >> "$CALL_LOG"\n',
    );
    chmodSync(fake, 0o755);
    const r = spawnSync("sh", [startScript], {
      encoding: "utf8",
      env: { PATH: `${dir}:/usr/bin:/bin`, CALL_LOG: log, ...env },
    });
    expect(r.status, r.stderr).toBe(0);
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    return { calls, stderr: r.stderr, stdout: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const UNSET = "keyring=<unset> ephemeral=<unset>";
const DEMO = "keyring=/app/demo-license-keys ephemeral=1";

describe("docker-start.sh: the switch", () => {
  it("OFF (unset): seed then gateway, with neither licence variable set — the old CMD exactly", () => {
    const r = runStart({ SEED_DEMO: "1" });
    expect(r.calls).toEqual([`apps/gateway/dist/seed.js ${UNSET}`, `apps/gateway/dist/main.js ${UNSET}`]);
    expect(r.stdout + r.stderr).toBe("");
  });

  it("OFF with SEED_DEMO=0: the gateway only, nothing set", () => {
    expect(runStart({ SEED_DEMO: "0" }).calls).toEqual([`apps/gateway/dist/main.js ${UNSET}`]);
  });

  it.each(["", "0", "true", "yes", " 1", "1 ", "01"])("any value but exactly '1' (%j) changes nothing", (v) => {
    const r = runStart({ SEED_DEMO: "1", REGULAIT_DEMO_LICENSE: v });
    expect(r.calls).toEqual([`apps/gateway/dist/seed.js ${UNSET}`, `apps/gateway/dist/main.js ${UNSET}`]);
  });

  it("ON: the seed and the gateway both get the demo keyring", () => {
    const r = runStart({ SEED_DEMO: "1", REGULAIT_DEMO_LICENSE: "1" });
    expect(r.calls).toEqual([`apps/gateway/dist/seed.js ${DEMO}`, `apps/gateway/dist/main.js ${DEMO}`]);
    expect(r.stdout).toContain("NOT A PRODUCTION DEPLOYMENT");
  });

  it("ON with REGULAIT_DEPLOY_MODE=hosted (the compose default is empty) still works", () => {
    const r = runStart({ SEED_DEMO: "1", REGULAIT_DEMO_LICENSE: "1", REGULAIT_DEPLOY_MODE: "hosted" });
    expect(r.calls[1]).toBe(`apps/gateway/dist/main.js ${DEMO}`);
  });

  it("ignored without SEED_DEMO=1 (nothing would mint)", () => {
    const r = runStart({ SEED_DEMO: "0", REGULAIT_DEMO_LICENSE: "1" });
    expect(r.calls).toEqual([`apps/gateway/dist/main.js ${UNSET}`]);
    expect(r.stderr).toContain("REGULAIT_DEMO_LICENSE=1 ignored");
  });

  it.each(["byoc", "air_gapped"])("ignored on a %s deployment", (mode) => {
    const r = runStart({ SEED_DEMO: "1", REGULAIT_DEMO_LICENSE: "1", REGULAIT_DEPLOY_MODE: mode });
    expect(r.calls).toEqual([`apps/gateway/dist/seed.js ${UNSET}`, `apps/gateway/dist/main.js ${UNSET}`]);
    expect(r.stderr).toContain(`REGULAIT_DEPLOY_MODE=${mode}`);
  });
});

// ---------------------------------------------------------------------------
// 2. the keyring fallback
// ---------------------------------------------------------------------------

describe("licenseKeyringDir", () => {
  it("an EMPTY REGULAIT_LICENSE_KEYRING (compose's `${VAR:-}`) falls back to the default keyring", () => {
    const saved = process.env.REGULAIT_LICENSE_KEYRING;
    try {
      delete process.env.REGULAIT_LICENSE_KEYRING;
      const fallback = licenseKeyringDir();
      expect(fallback).toBe(path.join(root, "infra/license-keys"));
      process.env.REGULAIT_LICENSE_KEYRING = "";
      expect(licenseKeyringDir()).toBe(fallback);
      process.env.REGULAIT_LICENSE_KEYRING = "/somewhere/else";
      expect(licenseKeyringDir()).toBe("/somewhere/else");
    } finally {
      if (saved === undefined) delete process.env.REGULAIT_LICENSE_KEYRING;
      else process.env.REGULAIT_LICENSE_KEYRING = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// 3. compose + Dockerfile, as text
// ---------------------------------------------------------------------------

describe("docker-compose.yml and the Dockerfile", () => {
  const compose = readFileSync(path.join(root, "docker-compose.yml"), "utf8");
  const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
  function service(name: string): string {
    const start = compose.indexOf(`\n  ${name}:\n`);
    expect(start, `service ${name}`).toBeGreaterThan(-1);
    const rest = compose.slice(start + 1);
    const next = rest.slice(3).search(/\n {2}[a-z0-9-]+:\n/);
    return next === -1 ? rest : rest.slice(0, next + 3);
  }
  const live = (text: string) => text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

  it("the gateway passes the switch through, empty by default, and never sets the keyring or the ephemeral flag itself", () => {
    const gw = live(service("gateway"));
    expect(gw).toMatch(/\n {6}REGULAIT_DEMO_LICENSE: \$\{REGULAIT_DEMO_LICENSE:-\}\n/);
    expect(live(compose)).not.toContain("REGULAIT_LICENSE_KEYRING");
    expect(live(compose)).not.toContain("REGULAIT_EPHEMERAL_LICENSE");
  });

  it("the demo keyring is a named volume at the path the start script uses", () => {
    expect(live(service("gateway"))).toContain("- demo_license_keys:/app/demo-license-keys");
    expect(live(compose)).toMatch(/\nvolumes:\n(?:.*\n)*? {2}demo_license_keys:\n/);
  });

  it("the compose database publishes no host port", () => {
    expect(live(service("db"))).not.toMatch(/\n {4}ports:/);
  });

  it("the image runs the start script, and owns the keyring directory as `node`", () => {
    expect(live(dockerfile)).toContain('CMD ["sh", "apps/gateway/docker-start.sh"]');
    expect(live(dockerfile)).toMatch(/chown node:node [^\n]*\/app\/demo-license-keys/);
    expect(readFileSync(startScript, "utf8")).toContain("REGULAIT_LICENSE_KEYRING=/app/demo-license-keys");
  });
});

// ---------------------------------------------------------------------------
// 4. the installer
// ---------------------------------------------------------------------------

describe("scripts/install.sh keeps the demo switch off", () => {
  const INSTALL = path.join(root, "scripts/install.sh");
  let sandbox: string;
  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "demo-lic-install-"));
  });
  afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

  function runCheck(dir: string, extraEnv: Record<string, string>): { status: number; output: string } {
    const key = execFileSync("openssl", ["rand", "-hex", "32"], { encoding: "utf8" }).trim();
    const env = { ...process.env, ...extraEnv };
    if (!("REGULAIT_DEMO_LICENSE" in extraEnv)) delete env.REGULAIT_DEMO_LICENSE;
    const r = spawnSync(
      "bash",
      [INSTALL, "--check", "--mode", "byoc", "--domain", "demo-lic.example", "--dir", dir, "--data-key", key],
      { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] },
    );
    return { status: r.status ?? -1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  it("REGULAIT_DEMO_LICENSE=1 in the environment is refused before anything renders", () => {
    const dir = path.join(sandbox, "env");
    const r = runCheck(dir, { REGULAIT_DEMO_LICENSE: "1" });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("REGULAIT_DEMO_LICENSE is set");
    expect(existsSync(path.join(dir, "compose.install.yml"))).toBe(false);
  });

  it("a demo .env carrying REGULAIT_DEMO_LICENSE=1 is refused", () => {
    const dir = path.join(sandbox, "dotenv");
    execFileSync("mkdir", ["-p", dir]);
    writeFileSync(path.join(dir, ".env"), "REGULAIT_DEMO_LICENSE=1\n");
    const r = runCheck(dir, {});
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("REGULAIT_DEMO_LICENSE is set");
  });

  it("CONTROL: without it the install renders, and its override pins the switch to \"0\"", () => {
    const dir = path.join(sandbox, "clean");
    const r = runCheck(dir, {});
    expect(r.output).not.toContain("REGULAIT_DEMO_LICENSE is set");
    const override = readFileSync(path.join(dir, "compose.install.yml"), "utf8");
    expect(override).toMatch(/\n {4}environment:\n {6}REGULAIT_DEMO_LICENSE: "0"\n/);
    expect(readFileSync(path.join(dir, ".env"), "utf8")).not.toContain("REGULAIT_DEMO_LICENSE");
  });
});

// ---------------------------------------------------------------------------
// 5. a re-seed keeps the licence and the demo password
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const SCRATCH_DB = `regulait_demo_lic_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + SCRATCH_DB;
  return u.toString();
})();
const seedScript = path.resolve(here, "../dist/seed.js");
// synthetic, test-only — never an owner's password
const SYNTHETIC = "Synthetic-Demo-Pass-2026!";
const BOOT = "demo-lic-test-boot";

describe("re-seeding a demo-licensed database (a gateway restart under Docker)", () => {
  let admin: Db;
  let scratch: Db;
  let app: ReturnType<typeof buildApp> | undefined;
  let keyring: string;
  const runs: Array<{ status: number | null; stdout: string; stderr: string }> = [];
  let afterFirst: { licenseRowId: string; licenseId: string } | undefined;
  let hashesBefore: Record<string, string | null> = {};
  let setResult: Awaited<ReturnType<typeof setDemoPasswords>> | undefined;

  function seed(): void {
    const r = spawnSync(process.execPath, [seedScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: scratchUrl,
        REGULAIT_BOOTSTRAP_TOKEN: BOOT,
        REGULAIT_EPHEMERAL_LICENSE: "1",
        REGULAIT_LICENSE_KEYRING: keyring,
      },
      timeout: 240_000,
    });
    runs.push({ status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
  }

  beforeAll(async () => {
    keyring = mkdtempSync(path.join(os.tmpdir(), "demo-lic-keyring-"));
    admin = createDb(DATABASE_URL);
    await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
    scratch = createDb(scratchUrl);

    seed(); // first boot
    const [row] = await scratch.select().from(licenses).where(eq(licenses.status, "active"));
    if (row) afterFirst = { licenseRowId: row.id, licenseId: row.licenseId };

    // the presenter sets the demo password
    setResult = await setDemoPasswords(scratch, { REGULAIT_DEMO_USER_PASSWORD: SYNTHETIC });
    const rows = await scratch
      .select({ email: users.email, passwordHash: users.passwordHash })
      .from(users)
      .where(inArray(users.email, [...DEMO_PERSONA_EMAILS]));
    hashesBefore = Object.fromEntries(rows.map((r) => [r.email, r.passwordHash]));

    seed(); // `docker compose restart gateway` re-runs the seed
    app = buildApp(scratch, { bootstrapToken: BOOT });
  }, 600_000);

  afterAll(async () => {
    await closeAll([
      () => app?.close() ?? Promise.resolve(),
      () => scratch?.$client.end() ?? Promise.resolve(),
      () => dropScratchDatabase(admin, SCRATCH_DB),
      () => admin.$client.end(),
    ]);
    rmSync(keyring, { recursive: true, force: true });
  });

  it("both seed runs succeed; the first mints, the second keeps", () => {
    expect(runs).toHaveLength(2);
    for (const r of runs) expect(r.status, r.stderr).toBe(0);
    expect(runs[0]!.stdout).toContain("license  ephemeral");
    expect(runs[1]!.stdout).toContain("license  kept");
    // only the PUBLIC half is ever written
    expect(readdirSync(keyring)).toEqual(["regulait-seed-ephemeral.pub"]);
    expect(readFileSync(path.join(keyring, "regulait-seed-ephemeral.pub"), "utf8")).toContain("BEGIN PUBLIC KEY");
  });

  it("the licence installed on first boot is still the active, valid demo licence", async () => {
    expect(afterFirst).toBeDefined();
    const resolved = await resolveLicense(scratch);
    expect(resolved.state).toBe("valid");
    expect(resolved.row?.id).toBe(afterFirst!.licenseRowId);
    expect(resolved.document?.licenseId).toBe(afterFirst!.licenseId);
    expect(isDemoLicense(resolved.document)).toBe(true);
    expect(resolved.document?.tenant).toContain("NOT A PRODUCTION DEPLOYMENT");
    expect(await scratch.select({ id: licenses.id }).from(licenses)).toHaveLength(1);
  });

  it("the demo password set between the runs is untouched, and nobody is forced to change it", async () => {
    expect(setResult?.ok, setResult?.lines.join("\n")).toBe(true);
    const rows = await scratch
      .select({ email: users.email, passwordHash: users.passwordHash, mustChange: users.mustChangePassword })
      .from(users)
      .where(inArray(users.email, [...DEMO_PERSONA_EMAILS]));
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.passwordHash, r.email).toBe(hashesBefore[r.email]);
      expect(r.mustChange, r.email).toBe(false);
    }
    expect(runs[1]!.stdout).toContain("(already set — unchanged)");
  });

  it("each persona signs in with the demo password after the re-seed", async () => {
    for (const identifier of ["admin", "dana", "avery"]) {
      const res = await app!.inject({
        method: "POST",
        url: "/auth/login",
        headers: { "x-regulait-csrf": "1", "content-type": "application/json" },
        payload: { identifier, password: SYNTHETIC },
      });
      expect(res.statusCode, `${identifier}: ${res.body}`).toBe(200);
      expect(res.json().mustChangePassword, identifier).toBe(false);
    }
  });

  it("no audit row and no seed output carries the password", async () => {
    const hits = await scratch
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(sql`${auditLog.detail}::text like ${"%" + SYNTHETIC + "%"} or ${auditLog.reason} like ${"%" + SYNTHETIC + "%"}`);
    expect(hits).toHaveLength(0);
    for (const r of runs) expect(r.stdout + r.stderr).not.toContain(SYNTHETIC);
  });

  it("a keyring that lost the signing key, or a licence near expiry, is re-minted (and then kept)", async () => {
    const inject: EphemeralLicenseInject = (opts) => app!.inject(opts);
    const headers = { authorization: `Bearer ${BOOT}` };
    const other = mkdtempSync(path.join(os.tmpdir(), "demo-lic-other-"));
    // the in-process gateway must read the same keyring, as under Docker
    const saved = process.env.REGULAIT_LICENSE_KEYRING;
    process.env.REGULAIT_LICENSE_KEYRING = other;
    try {
      const lost = await ensureEphemeralLicense({ db: scratch, inject, headers, keyringDir: other });
      expect(lost.action).toBe("minted");
      const again = await ensureEphemeralLicense({ db: scratch, inject, headers, keyringDir: other });
      expect(again).toMatchObject({ action: "kept", licenseId: lost.licenseId });
      // 25 days on, 5 days left: renewed rather than left to lapse mid-demo
      const later = new Date(Date.now() + 25 * 86_400_000);
      const renewed = await ensureEphemeralLicense({ db: scratch, inject, headers, keyringDir: other, now: later });
      expect(renewed.action).toBe("minted");
      expect(renewed.licenseId).not.toBe(lost.licenseId);
    } finally {
      if (saved === undefined) delete process.env.REGULAIT_LICENSE_KEYRING;
      else process.env.REGULAIT_LICENSE_KEYRING = saved;
      rmSync(other, { recursive: true, force: true });
    }
  });
});
