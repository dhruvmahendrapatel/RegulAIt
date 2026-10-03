/**
 * ADR-0167 (AUTHZ-05 / CFG-03) — the published dev-grade secrets are named at
 * boot, and refused on a deployed box.
 *
 * docker-compose.yml defaults `REGULAIT_BOOTSTRAP_TOKEN` to `dev-bootstrap`
 * and `REGULAIT_DATA_KEY` to sixty-four `a`s. The bootstrap token is a full
 * admin with no identity on every route; the key opens every stored secret.
 * Only scripts/install.sh refused them, and the gateway's boot log said
 * nothing — so a `docker compose --profile tls up` from a bare checkout put a
 * published admin credential on :443 silently.
 *
 * Part 1 is the pure decision. Part 2 drives the REAL boot sequence
 * (`startGateway`, the same function main.ts calls) against a scratch
 * database, because "the gateway refuses to start" is a claim about starting.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, sql, type Db } from "@regulait/db";
import { startGateway } from "./boot.js";
import {
  DEV_SECRETS_OVERRIDE_ENV,
  DevSecretsBootError,
  PUBLISHED_DATA_KEY,
  assessDevSecrets,
} from "./dev-secrets.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const REAL_KEY = "3f9a1c7e2b8d4f60a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718";
const REAL_TOKEN = "a-real-break-glass-token-of-decent-length";

// ---------------------------------------------------------------------------
// 1. THE DECISION
// ---------------------------------------------------------------------------

describe("the decision", () => {
  const clean = {} as NodeJS.ProcessEnv;
  const deployed = { REGULAIT_DEPLOY_MODE: "hosted" } as NodeJS.ProcessEnv;

  it("real secrets: nothing found, nothing refused, the door is reported as configured", () => {
    const a = assessDevSecrets(deployed, { bootstrapToken: REAL_TOKEN, dataKey: REAL_KEY });
    expect(a.findings).toEqual([]);
    expect(a.refuse).toBe(false);
    expect(a.bootstrapLine).toContain("CONFIGURED");
    expect(a.bootstrapLine).toContain("remove REGULAIT_BOOTSTRAP_TOKEN");
  });

  it("no bootstrap token: the door is reported shut", () => {
    const a = assessDevSecrets(deployed, { dataKey: REAL_KEY });
    expect(a.bootstrapLine).toContain("not configured");
    expect(a.refuse).toBe(false);
  });

  it("a real admin already existing is said out loud — the token has done its one job", () => {
    const a = assessDevSecrets(clean, { bootstrapToken: REAL_TOKEN, dataKey: REAL_KEY, realAdminExists: true });
    expect(a.bootstrapLine).toContain("a real admin already exists");
  });

  it("the published defaults are named, and refused ONLY on a deployed box", () => {
    for (const token of ["dev-bootstrap", "seed-bootstrap"]) {
      const laptop = assessDevSecrets(clean, { bootstrapToken: token, dataKey: PUBLISHED_DATA_KEY });
      expect(laptop.findings).toHaveLength(2);
      expect(laptop.refusing).toHaveLength(2);
      expect(laptop.refuse).toBe(false); // nothing says this box is deployed
      expect(laptop.networkFacingSignal).toBeNull();

      const box = assessDevSecrets(deployed, { bootstrapToken: token, dataKey: PUBLISHED_DATA_KEY });
      expect(box.refuse).toBe(true);
      expect(box.networkFacingSignal).toBe("REGULAIT_DEPLOY_MODE=hosted");
    }
    // REGULAIT_HSTS is the other signal
    const hsts = assessDevSecrets({ REGULAIT_HSTS: "max-age=31536000" } as NodeJS.ProcessEnv, {
      bootstrapToken: "dev-bootstrap",
      dataKey: REAL_KEY,
    });
    expect(hsts.refuse).toBe(true);
    expect(hsts.networkFacingSignal).toBe("REGULAIT_HSTS is set");
  });

  it("a key with no entropy refuses like the published one; a real key with repeated characters does not", () => {
    const flat = assessDevSecrets(deployed, { bootstrapToken: REAL_TOKEN, dataKey: "0101".repeat(16) });
    expect(flat.refuse).toBe(true);
    expect(flat.findings[0]).toContain("entropy");
    const real = assessDevSecrets(deployed, { bootstrapToken: REAL_TOKEN, dataKey: REAL_KEY });
    expect(real.refuse).toBe(false);
  });

  it("a SHORT token warns and never refuses — CI's 19-character e2e token must keep booting", () => {
    const a = assessDevSecrets(deployed, { bootstrapToken: "e2e-bootstrap-token", dataKey: REAL_KEY });
    expect(a.findings).toHaveLength(0); // 19 >= 16
    const short = assessDevSecrets(deployed, { bootstrapToken: "short", dataKey: REAL_KEY });
    expect(short.findings).toHaveLength(1);
    expect(short.findings[0]).toContain("5 characters");
    expect(short.refusing).toHaveLength(0);
    expect(short.refuse).toBe(false);
  });

  it("the override boots a deployed box anyway, and says so", () => {
    const a = assessDevSecrets({ ...deployed, [DEV_SECRETS_OVERRIDE_ENV]: "1" } as NodeJS.ProcessEnv, {
      bootstrapToken: "dev-bootstrap",
      dataKey: PUBLISHED_DATA_KEY,
    });
    expect(a.refuse).toBe(false);
    expect(a.overridden).toBe(true);
    expect(a.refusing).toHaveLength(2);
  });

  it("the refusal message names every refusing fact and the two ways out", () => {
    const a = assessDevSecrets(deployed, { bootstrapToken: "dev-bootstrap", dataKey: PUBLISHED_DATA_KEY });
    const err = new DevSecretsBootError(a);
    expect(err.message).toContain("REGULAIT_DEPLOY_MODE=hosted");
    expect(err.message).toContain("dev-bootstrap");
    expect(err.message).toContain("REGULAIT_DATA_KEY is the published dev default");
    expect(err.message).toContain("scripts/install.sh");
    expect(err.message).toContain(DEV_SECRETS_OVERRIDE_ENV);
  });
});

// ---------------------------------------------------------------------------
// 2. THE REAL BOOT
// ---------------------------------------------------------------------------

const SCRATCH_DB = `regulait_devsecrets_${process.pid}`;
const scratchUrl = DATABASE_URL.replace(/\/[^/?]+(\?|$)/, `/${SCRATCH_DB}$1`);
let admin: Db;
let db: Db;
let port = 0;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === "object" && addr ? resolve(addr.port) : reject(new Error("no port"))));
    });
  });
}

/**
 * drive the REAL boot sequence main.ts runs, with the env of the test's
 * choosing. A fresh port per boot: a boot that threw after listen (a bug this
 * harness exists to catch) must not poison the next test with EADDRINUSE.
 */
async function boot(
  opts: { bootstrapToken?: string; dataKey?: string },
  extraEnv: Record<string, string> = {},
  target: Db = db,
) {
  const log: string[] = [];
  // a CLEAN env: the suite's own process.env must not decide the outcome
  const env = { PATH: process.env.PATH, VITEST: "1", ...extraEnv } as NodeJS.ProcessEnv;
  port = await freePort();
  try {
    const started = await startGateway({ db: target, migrationsFolder, port, host: "127.0.0.1", ...opts, log: (l) => log.push(l), env });
    return { app: started.app, log, error: null as unknown };
  } catch (error) {
    return { app: null, log, error };
  }
}

/** ADR-0063 records the FIRST key a database boots under and refuses any
 * other, so a boot under a different key needs a database of its own */
const SCRATCH_DB_REAL = `${SCRATCH_DB}_real`;
const scratchUrlReal = DATABASE_URL.replace(/\/[^/?]+(\?|$)/, `/${SCRATCH_DB_REAL}$1`);
let dbReal: Db;

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  for (const name of [SCRATCH_DB, SCRATCH_DB_REAL]) {
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    await admin.execute(sql.raw(`CREATE DATABASE ${name}`));
  }
  db = createDb(scratchUrl);
  await runMigrations(db, migrationsFolder);
  dbReal = createDb(scratchUrlReal);
  await runMigrations(dbReal, migrationsFolder);
}, 90_000);

/** end a drizzle handle's underlying pool, so the drop below has no backends to wait for */
const endPool = async (handle: Db) => {
  const client = (handle as unknown as { $client?: { end?: () => Promise<void> } }).$client;
  if (client?.end) await client.end();
};

afterAll(async () => {
  await closeAll([
    async () => endPool(db),
    async () => endPool(dbReal),
    async () => dropScratchDatabase(admin, SCRATCH_DB),
    async () => dropScratchDatabase(admin, SCRATCH_DB_REAL),
  ]);
});

describe("the real boot", () => {
  it("a laptop with the published defaults boots, and the posture block says DEV-GRADE twice and names the open door", async () => {
    const r = await boot({ bootstrapToken: "dev-bootstrap", dataKey: PUBLISHED_DATA_KEY });
    expect(r.error).toBeNull();
    try {
      const devGrade = r.log.filter((l) => l.includes("secrets:   DEV-GRADE"));
      expect(devGrade).toHaveLength(2);
      expect(devGrade.join("\n")).toContain("dev-bootstrap");
      expect(devGrade.join("\n")).toContain("REGULAIT_DATA_KEY is the published dev default");
      expect(r.log.find((l) => l.includes("bootstrap: CONFIGURED"))).toBeTruthy();
      expect(r.log.find((l) => l.startsWith("  database:"))).toContain("pool max");
      expect(r.log.find((l) => l.startsWith("  logging:"))).toBeTruthy();
    } finally {
      await r.app!.close();
    }
  });

  it("the same defaults on a DEPLOYED box refuse to start, as a DevSecretsBootError, with nothing listening", async () => {
    const r = await boot({ bootstrapToken: "dev-bootstrap", dataKey: PUBLISHED_DATA_KEY }, { REGULAIT_DEPLOY_MODE: "hosted" });
    expect(r.app).toBeNull();
    expect(r.error, String(r.error)).toBeInstanceOf(DevSecretsBootError);
    expect((r.error as Error).message).toContain("dev-bootstrap");
    // nothing listening on the port the boot was asked for
    const reachable = await new Promise<boolean>((resolve) => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => (sock.destroy(), resolve(true)));
      sock.once("error", () => resolve(false));
    });
    expect(reachable).toBe(false);
  });

  it("the override boots the deployed box and the posture block says it is booting anyway", async () => {
    const r = await boot(
      { bootstrapToken: "dev-bootstrap", dataKey: PUBLISHED_DATA_KEY },
      { REGULAIT_DEPLOY_MODE: "hosted", [DEV_SECRETS_OVERRIDE_ENV]: "1" },
    );
    expect(r.error).toBeNull();
    try {
      expect(r.log.find((l) => l.includes("booting anyway"))).toBeTruthy();
    } finally {
      await r.app!.close();
    }
  });

  it("real secrets on a deployed box boot clean: no DEV-GRADE line at all", async () => {
    // its own database: the one above has recorded the published key (ADR-0063)
    const r = await boot({ bootstrapToken: REAL_TOKEN, dataKey: REAL_KEY }, { REGULAIT_DEPLOY_MODE: "hosted" }, dbReal);
    expect(r.error).toBeNull();
    try {
      expect(r.log.filter((l) => l.includes("DEV-GRADE"))).toHaveLength(0);
      expect(r.log.find((l) => l.includes("bootstrap: CONFIGURED"))).toBeTruthy();
    } finally {
      await r.app!.close();
    }
  });
});
