/**
 * ADR-0174 amendment — the demo password under Docker Compose.
 *
 * `docker compose up` seeds the demo (SEED_DEMO=1) on EVERY boot, and
 * `demo:set-passwords` needs a valid demo licence. One opt-in switch,
 * REGULAIT_DEMO_LICENSE=1, makes the seed mint its ephemeral licence into a
 * named-volume keyring the gateway also reads. Pinned here:
 *
 *  1. the image's start script: only the exact value "1" (not on a
 *     byoc/air_gapped deployment; ADR-0181 FX3: it seeds by itself, since
 *     SEED_DEMO now defaults to 0) sets REGULAIT_EPHEMERAL_LICENSE
 *     and REGULAIT_LICENSE_KEYRING; anything else leaves both UNSET, so the
 *     gateway reads its default keyring exactly as before;
 *  2. an empty REGULAIT_LICENSE_KEYRING falls back to the default keyring;
 *  3. the compose / Dockerfile shapes (read as text, no daemon);
 *  4. the installer refuses the switch and pins it off in its override;
 *  5. a re-seed (a gateway restart) KEEPS a valid demo licence instead of
 *     minting a new one, and does not touch a demo password already set —
 *     run against the BUILT seed (dist/seed.js), twice, on a scratch database;
 *  6. demo prep (the Docker demo is prepared like `demo:prepare`): with the
 *     switch honoured the start script makes the export key, starts the demo
 *     MCP server in the background, and after the seed runs setup → intake →
 *     traffic → check only on an unprepared database, with REGULAIT_OFFLINE_CHECKS
 *     and the export key set for every step and the gateway; a failed step is
 *     named and the gateway still starts. Switch off: none of it. The marker
 *     reader (dist/demo-docker-prepared.js) runs against the scratch database.
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
import { DEMO_TRAFFIC_KEY_NAME } from "./demo-traffic-lib.js";
import { ensureEphemeralLicense, type EphemeralLicenseInject } from "./ephemeral-license.js";
import { licenseKeyringDir, resolveLicense } from "./licensing.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const startScript = path.join(root, "apps/gateway/docker-start.sh");

// ---------------------------------------------------------------------------
// 1. the start script
// ---------------------------------------------------------------------------

/**
 * runs docker-start.sh with a fake `node` that records, per call, the script it was started with and
 * the demo environment it saw. The fake answers where the start script reads an answer:
 * demo-export-key.js --env prints the two `export` lines, demo-docker-prepared.js exits
 * FAKE_PREPARED_EXIT (0 prepared, 3 not, 2 cannot tell), and the script named FAKE_FAIL exits 7.
 * The demo MCP server runs in the BACKGROUND, so its record can land anywhere: it is returned
 * separately (`mcp`), never in the ordered `calls`.
 */
function runStart(env: Record<string, string>): { calls: string[]; mcp: string[]; stderr: string; stdout: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "docker-start-"));
  try {
    const log = path.join(dir, "calls.log");
    const fake = path.join(dir, "node");
    writeFileSync(
      fake,
      [
        "#!/bin/sh",
        'echo "$1 keyring=${REGULAIT_LICENSE_KEYRING-<unset>} ephemeral=${REGULAIT_EPHEMERAL_LICENSE-<unset>}' +
          ' offline=${REGULAIT_OFFLINE_CHECKS-<unset>} signing=${REGULAIT_EXPORT_SIGNING_KEY-<unset>}:${REGULAIT_EXPORT_SIGNING_KEY_ID-<unset>}' +
          ' keydir=${REGULAIT_DEMO_KEY_DIR-<unset>}" >> "$CALL_LOG"',
        'case "$1" in',
        '  "apps/gateway/dist/${FAKE_FAIL:-none}.js") exit 7 ;;',
        "  */demo-export-key.js)",
        `    echo "export REGULAIT_EXPORT_SIGNING_KEY='$REGULAIT_DEMO_KEY_DIR/regulait-demo-export.key'"`,
        `    echo "export REGULAIT_EXPORT_SIGNING_KEY_ID='regulait-demo-export'"`,
        '    echo "Reusing the demo export-signing key - fingerprint sha256:fake" >&2 ;;',
        '  */demo-docker-prepared.js) exit "${FAKE_PREPARED_EXIT:-3}" ;;',
        "esac",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(fake, 0o755);
    const r = spawnSync("sh", [startScript], {
      encoding: "utf8",
      env: { PATH: `${dir}:/usr/bin:/bin`, CALL_LOG: log, ...env },
    });
    expect(r.status, r.stderr).toBe(0);
    const all = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    const isMcp = (l: string) => l.startsWith("apps/gateway/dist/demo-mcp-server.js ");
    return { calls: all.filter((l) => !isMcp(l)), mcp: all.filter(isMcp), stderr: r.stderr, stdout: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** switch off: no licence variable, no offline checks, no export key — what the gateway saw before the switch existed */
const UNSET = "keyring=<unset> ephemeral=<unset> offline=<unset> signing=<unset>:<unset> keydir=<unset>";
const DEMO = "keyring=/app/demo-license-keys ephemeral=1";
const KEYDIR = "/app/demo-license-keys/export-signing";
/** the demo environment every prep step and the gateway see once the export key is made */
const DEMO_ENV = `${DEMO} offline=1 signing=${KEYDIR}/regulait-demo-export.key:regulait-demo-export keydir=${KEYDIR}`;
/** demo-export-key.js itself: no signing key is set before it answers */
const KEY_STEP = `apps/gateway/dist/demo-export-key.js ${DEMO} offline=1 signing=<unset>:<unset> keydir=${KEYDIR}`;
const step = (file: string) => `apps/gateway/dist/${file}.js ${DEMO_ENV}`;
const PREP_STEPS = ["demo-setup", "demo-intake-seed", "demo-traffic", "demo-check"].map(step);

describe("docker-start.sh: the switch", () => {
  it("OFF (unset): seed then gateway, with neither licence variable set — the old CMD exactly", () => {
    const r = runStart({ SEED_DEMO: "1" });
    expect(r.calls).toEqual([`apps/gateway/dist/seed.js ${UNSET}`, `apps/gateway/dist/main.js ${UNSET}`]);
    expect(r.mcp).toEqual([]);
    expect(r.stdout + r.stderr).toBe("");
  });

  it("OFF with SEED_DEMO=0: the gateway only, nothing set", () => {
    expect(runStart({ SEED_DEMO: "0" }).calls).toEqual([`apps/gateway/dist/main.js ${UNSET}`]);
  });

  it("a Windows CRLF .env value ('1\\r') counts as '1'", () => {
    const r = runStart({ SEED_DEMO: "1", REGULAIT_DEMO_LICENSE: "1\r", FAKE_PREPARED_EXIT: "0" });
    expect(r.calls).toEqual([
      KEY_STEP,
      `apps/gateway/dist/seed.js ${DEMO_ENV}`,
      step("demo-docker-prepared"),
      `apps/gateway/dist/main.js ${DEMO_ENV}`,
    ]);
  });
  it.each(["", "0", "true", "yes", " 1", "1 ", "01", "\r1", "1\r\r"])("any value but exactly '1' (%j) changes nothing", (v) => {
    const r = runStart({ SEED_DEMO: "1", REGULAIT_DEMO_LICENSE: v });
    expect(r.calls).toEqual([`apps/gateway/dist/seed.js ${UNSET}`, `apps/gateway/dist/main.js ${UNSET}`]);
    expect(r.mcp).toEqual([]);
  });

  it("ON: the seed and the gateway both get the demo keyring", () => {
    const r = runStart({ SEED_DEMO: "1", REGULAIT_DEMO_LICENSE: "1", FAKE_PREPARED_EXIT: "0" });
    expect(r.calls).toContain(`apps/gateway/dist/seed.js ${DEMO_ENV}`);
    expect(r.calls.at(-1)).toBe(`apps/gateway/dist/main.js ${DEMO_ENV}`);
    expect(r.stdout).toContain("NOT A PRODUCTION DEPLOYMENT");
  });

  it("ON with REGULAIT_DEPLOY_MODE=hosted (the compose default is empty) still works", () => {
    const r = runStart({ SEED_DEMO: "1", REGULAIT_DEMO_LICENSE: "1", REGULAIT_DEPLOY_MODE: "hosted", FAKE_PREPARED_EXIT: "0" });
    expect(r.calls.at(-1)).toBe(`apps/gateway/dist/main.js ${DEMO_ENV}`);
  });

  // ADR-0181 FX3: compose and the installer now default SEED_DEMO to 0, and the switch is
  // itself the explicit demo signal, so it seeds (and prepares) without SEED_DEMO=1
  it("ON with SEED_DEMO=0 (the compose default): the switch alone seeds and prepares the demo", () => {
    const r = runStart({ SEED_DEMO: "0", REGULAIT_DEMO_LICENSE: "1", FAKE_PREPARED_EXIT: "0" });
    expect(r.calls).toEqual([
      KEY_STEP,
      `apps/gateway/dist/seed.js ${DEMO_ENV}`,
      step("demo-docker-prepared"),
      `apps/gateway/dist/main.js ${DEMO_ENV}`,
    ]);
    expect(r.stderr).not.toContain("REGULAIT_DEMO_LICENSE=1 ignored");
  });

  it("ADR-0181 FX3: every seed the start script runs carries the explicit --seed-demo signal", () => {
    const src = readFileSync(startScript, "utf8");
    const seeds = src.split("\n").filter((l) => l.includes("dist/seed.js") && !l.trimStart().startsWith("#"));
    expect(seeds.length).toBeGreaterThan(0);
    for (const l of seeds) expect(l).toContain("dist/seed.js --seed-demo");
  });

  it.each(["byoc", "air_gapped"])("ignored on a %s deployment", (mode) => {
    const r = runStart({ SEED_DEMO: "1", REGULAIT_DEMO_LICENSE: "1", REGULAIT_DEPLOY_MODE: mode });
    expect(r.calls).toEqual([`apps/gateway/dist/seed.js ${UNSET}`, `apps/gateway/dist/main.js ${UNSET}`]);
    expect(r.mcp).toEqual([]);
    expect(r.stderr).toContain(`REGULAIT_DEPLOY_MODE=${mode}`);
  });
});

describe("docker-start.sh: demo prep (the Docker demo is prepared like `demo:prepare`)", () => {
  it("ON, fresh database: export key, seed, prepared?, setup, intake, traffic, check, gateway — all with the demo env", () => {
    const r = runStart({ SEED_DEMO: "1", REGULAIT_DEMO_LICENSE: "1", FAKE_PREPARED_EXIT: "3" });
    expect(r.calls).toEqual([
      KEY_STEP,
      `apps/gateway/dist/seed.js ${DEMO_ENV}`,
      step("demo-docker-prepared"),
      ...PREP_STEPS,
      `apps/gateway/dist/main.js ${DEMO_ENV}`,
    ]);
    for (const name of ["demo:setup", "demo:intake", "demo:traffic", "demo:check"]) {
      expect(r.stdout).toContain(`=== demo prep: ${name} ===`);
    }
    expect(r.stdout).toMatch(/demo prep: complete in \d+s/);
    expect(r.stderr).not.toContain("DEMO PREP FAILED");
  });

  it("ON: the demo MCP server starts once, in the background, BEFORE demo:setup, with the demo env", () => {
    const r = runStart({ SEED_DEMO: "1", REGULAIT_DEMO_LICENSE: "1", FAKE_PREPARED_EXIT: "3" });
    expect(r.mcp).toEqual([`apps/gateway/dist/demo-mcp-server.js ${DEMO_ENV}`]);
    const started = r.stdout.indexOf("demo: MCP server started in the background");
    expect(started).toBeGreaterThan(-1);
    expect(started).toBeLessThan(r.stdout.indexOf("=== demo prep: demo:setup ==="));
  });

  it("ON, database already prepared (a restart, or down/up keeping volumes): no prep step runs, the MCP server still does", () => {
    const r = runStart({ SEED_DEMO: "1", REGULAIT_DEMO_LICENSE: "1", FAKE_PREPARED_EXIT: "0" });
    expect(r.calls).toEqual([
      KEY_STEP,
      `apps/gateway/dist/seed.js ${DEMO_ENV}`,
      step("demo-docker-prepared"),
      `apps/gateway/dist/main.js ${DEMO_ENV}`,
    ]);
    expect(r.mcp).toHaveLength(1);
    expect(r.stdout).not.toContain("=== demo prep:");
    expect(r.stderr).not.toContain("***");
  });

  it("ON, cannot tell whether the database is prepared: no prep step runs, it says so, the gateway starts", () => {
    const r = runStart({ SEED_DEMO: "1", REGULAIT_DEMO_LICENSE: "1", FAKE_PREPARED_EXIT: "2" });
    expect(r.calls.slice(2)).toEqual([step("demo-docker-prepared"), `apps/gateway/dist/main.js ${DEMO_ENV}`]);
    expect(r.stderr).toContain("*** DEMO PREP SKIPPED");
  });

  it.each([
    ["demo-setup", "demo:setup", 0],
    ["demo-intake-seed", "demo:intake", 1],
    ["demo-traffic", "demo:traffic", 2],
    ["demo-check", "demo:check", 3],
  ] as const)("ON, %s fails: later steps do not run, the step is named loudly, the gateway STILL starts", (file, name, at) => {
    const r = runStart({ SEED_DEMO: "1", REGULAIT_DEMO_LICENSE: "1", FAKE_PREPARED_EXIT: "3", FAKE_FAIL: file });
    expect(r.calls).toEqual([
      KEY_STEP,
      `apps/gateway/dist/seed.js ${DEMO_ENV}`,
      step("demo-docker-prepared"),
      ...PREP_STEPS.slice(0, at + 1),
      `apps/gateway/dist/main.js ${DEMO_ENV}`,
    ]);
    expect(r.stderr).toContain(`*** DEMO PREP FAILED at step ${name} (exit 7)`);
    expect(r.stdout).not.toContain("demo prep: complete");
  });

  it("ON, the export key cannot be made: named loudly, no signing key is set, everything else still runs", () => {
    const r = runStart({ SEED_DEMO: "1", REGULAIT_DEMO_LICENSE: "1", FAKE_PREPARED_EXIT: "3", FAKE_FAIL: "demo-export-key" });
    expect(r.stderr).toContain("*** DEMO PREP FAILED at step demo:export-key");
    expect(r.calls).toHaveLength(8);
    expect(r.calls.at(-1)).toBe(`apps/gateway/dist/main.js ${DEMO} offline=1 signing=<unset>:<unset> keydir=${KEYDIR}`);
  });

  it("OFF: nothing of the demo runs, whatever the database holds — no key, no MCP, no prep, no offline checks", () => {
    for (const prepared of ["0", "2", "3"]) {
      const r = runStart({ SEED_DEMO: "1", FAKE_PREPARED_EXIT: prepared });
      expect(r.calls).toEqual([`apps/gateway/dist/seed.js ${UNSET}`, `apps/gateway/dist/main.js ${UNSET}`]);
      expect(r.mcp).toEqual([]);
    }
  });

  it("demo-export-key --env writes only the two `export` lines to stdout (the start script evals them); the fingerprint goes to stderr", () => {
    const src = readFileSync(path.join(here, "demo-export-key.ts"), "utf8");
    const envBranch = src.slice(src.indexOf('if (process.argv.includes("--env"))'), src.indexOf("} else {"));
    expect(envBranch.match(/console\.log\(/g)).toHaveLength(2);
    expect(envBranch).toMatch(/console\.log\(`export REGULAIT_EXPORT_SIGNING_KEY='/);
    expect(envBranch).toMatch(/console\.log\(`export REGULAIT_EXPORT_SIGNING_KEY_ID='/);
    expect(envBranch).toContain("console.error(");
    expect(envBranch).not.toMatch(/readFileSync|privateKey/);
  });
});

// ---------------------------------------------------------------------------
// 2. the keyring fallback
// ---------------------------------------------------------------------------

describe("docker-start.sh survives a Windows checkout (CRLF)", () => {
  // git core.autocrlf=true (the Git for Windows default) writes the script with CRLF; `sh` in the
  // container then fails at line 22 ("Syntax error: newline unexpected") and the gateway restart-loops.
  const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
  const crlfCopy = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "docker-start-crlf-"));
    const file = path.join(dir, "docker-start.sh");
    writeFileSync(file, readFileSync(startScript, "utf8").replace(/\r?\n/g, "\r\n"));
    return { dir, file };
  };

  it("a CRLF copy does not parse as-is (the failure being guarded)", () => {
    const { dir, file } = crlfCopy();
    try {
      expect(spawnSync("sh", ["-n", file]).status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the Dockerfile strips CR from the start script before the image runs it, and the result parses", () => {
    const step = dockerfile.match(/RUN sed -i 's\/\\r\$\/\/' apps\/gateway\/docker-start\.sh/);
    expect(step, "Dockerfile normalises docker-start.sh line endings").not.toBeNull();
    expect(dockerfile.indexOf(step![0])).toBeLessThan(dockerfile.indexOf("USER node"));
    const { dir, file } = crlfCopy();
    try {
      execFileSync("sed", ["-i", "s/\\r$//", file]);
      expect(spawnSync("sh", ["-n", file]).status).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(readFileSync(startScript, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(".gitattributes pins shell scripts to LF", () => {
    const attrs = readFileSync(path.join(root, ".gitattributes"), "utf8");
    expect(attrs).toMatch(/^\*\.sh\s+text\s+eol=lf\s*$/m);
  });
});

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
    // ADR-0181 FX3: the seed runs only on an explicit demo signal, as docker-start.sh passes it
    const r = spawnSync(process.execPath, [seedScript, "--seed-demo"], {
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

  it("demo-docker-prepared (built) reads the prep marker from THIS database: 3 before demo:traffic, 0 after, 2 unreadable", async () => {
    const script = path.resolve(here, "../dist/demo-docker-prepared.js");
    const run = (url: string) =>
      spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, DATABASE_URL: url }, timeout: 60_000 });
    // a seeded database (two seed runs, as after a restart) is NOT prepared: the seed mints no demo-traffic key
    const before = run(scratchUrl);
    expect(before.status, before.stdout + before.stderr).toBe(3);
    // demo:traffic mints its keys before it sends traffic — the marker
    const [ada] = await scratch.select({ id: users.id }).from(users).where(eq(users.email, "admin@regulait.local"));
    const minted = await app!.inject({
      method: "POST",
      url: `/v1/users/${ada!.id}/keys`,
      headers: { authorization: `Bearer ${BOOT}` },
      payload: { name: DEMO_TRAFFIC_KEY_NAME },
    });
    expect(minted.statusCode, minted.body).toBe(201);
    const after = run(scratchUrl);
    expect(after.status, after.stdout + after.stderr).toBe(0);
    expect(after.stdout).toContain("already prepared");
    const gone = new URL(scratchUrl);
    gone.pathname = `/${SCRATCH_DB}_does_not_exist`;
    const unreadable = run(gone.toString());
    expect(unreadable.status).toBe(2);
    expect(unreadable.stderr).toContain("could not read whether this database is prepared");
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
