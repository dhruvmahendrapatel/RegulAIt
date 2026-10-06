/**
 * Boots a real gateway for the web e2e:
 *  1. drops + recreates the scratch database (E2E_DB, default regulait_wt_spa);
 *  2. runs the demo seeder (real HTTP-API seeding) and captures the printed
 *     one-time passwords for the personas;
 *  3. starts the gateway (built dist) on E2E_PORT serving the built SPA at /ui.
 * State (pid, passwords) is handed to the tests via a JSON file.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordTotpSecret, resetTotpStore } from "./totp-sign-in";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
export const STATE_FILE = path.join(here, ".e2e-state.json");

const DB_NAME = process.env.E2E_DB ?? "regulait_wt_spa";
const PORT = Number(process.env.E2E_PORT ?? 3105);
const PG = process.env.E2E_PG ?? "postgres://regulait:regulait@localhost:5432";
const DATABASE_URL = `${PG}/${DB_NAME}`;
const BOOT = "e2e-bootstrap-token";
const DATA_KEY = "a".repeat(64);

async function waitFor(url: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`gateway did not come up at ${url}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export default async function globalSetup() {
  // 1. fresh scratch database
  if (!/^[a-z][a-z0-9_]*$/.test(DB_NAME)) throw new Error("Invalid scratch database identifier");
  // Windows psql stops parsing options at the first positional argument.
  execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-c",
    `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`, `${PG}/postgres`]);
  execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-c",
    `CREATE DATABASE ${DB_NAME}`, `${PG}/postgres`]);
  // ADR-0181: a fresh database has no TOTP enrolments, so no recorded secrets
  resetTotpStore();

  // The suite licenses itself, with an EPHEMERAL key the seeder mints and
  // throws away (see seed.ts). Without it, tier-gated features default CLOSED
  // and two specs fail on a licensing posture that reads exactly like a product
  // defect — phase1's goal decomposition (`advanced_orchestration`) and
  // phase5's custom provider registration (`custom_model_providers`).
  //
  // The keyring is a scratch directory OUTSIDE the source tree, and the SAME
  // one must be visible to both the seeder (which installs) and the gateway
  // (which verifies) — a license signed against a keyring the gateway cannot
  // read is refused, correctly, and would look like the install silently
  // failing.
  const licenseKeyring = path.join(here, ".e2e-license-keys");
  const env = {
    ...process.env,
    REGULAIT_EPHEMERAL_LICENSE: "1",
    REGULAIT_LICENSE_KEYRING: licenseKeyring,
    DATABASE_URL,
    REGULAIT_BOOTSTRAP_TOKEN: BOOT,
    REGULAIT_DATA_KEY: DATA_KEY,
    PORT: String(PORT),
    // Every spec performs a REAL UI sign-in against the same gateway from the
    // same IP. The production default for the credential bucket (10 per 300s)
    // was already at the suite tail's edge — the 112th spec tipped zz-vendors
    // into `rate_limited` purely by adding one more login to the rolling
    // window. The limiter's own behaviour is covered by the gateway unit
    // suite (rate-limit.test.ts); this suite tests the app THROUGH sign-in,
    // so give the bucket suite-sized headroom instead of testing the limiter
    // by accident.
    REGULAIT_AUTH_RATE_LIMIT_MAX: "1000",
    // The SAME argument, one bucket up. The GLOBAL per-IP bucket (1200 per
    // 60s) is a rolling window and the whole suite drives one gateway from one
    // IP: at 132 specs the tail was already inside it, and the four L6 specs
    // tipped the last few into `rate_limited` — a page that renders the
    // limiter's JSON instead of the SPA, which then fails an unrelated
    // assertion and reads as an app defect (it is not; the b3 spec's snapshot
    // was the limiter's own body). The limiter is covered on its own terms by
    // the gateway suite (rate-limit.test.ts, trusted-proxy.test.ts); this
    // suite tests the app THROUGH HTTP, so give the bucket suite-sized
    // headroom rather than testing the limiter by accident.
    REGULAIT_RATE_LIMIT_MAX: "20000",
    // ADR-0181: the scheduler is ON by default; the journeys assert what a
    // human's action did, so no background sweep may run underneath them.
    // Set off EXPLICITLY here. (REGULAIT_DATABASE_SSL is not set here: it
    // comes from the caller's environment, and CI sets `disable` for its
    // TLS-less Postgres service.)
    REGULAIT_SCHEDULER: "off",
  };

  // 2. seed via the real API (prints one-time passwords exactly once)
  const seedOut = execFileSync("node", [path.join(repoRoot, "apps/gateway/dist/seed.js")], {
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const password = (name: string, email: string): string => {
    const re = new RegExp(`${name}\\s+${email.replace(".", "\\.")}\\s+(\\S+)`);
    const m = re.exec(seedOut);
    if (!m?.[1] || m[1].startsWith("(")) {
      throw new Error(`could not capture ${name}'s one-time password from the seed output`);
    }
    return m[1];
  };
  const passwords = {
    admin: password("admin", "admin@regulait.local"),
    dana: password("dana", "dana@regulait.local"),
    avery: password("avery", "avery@regulait.local"),
  };
  // ADR-0181 (FX2): an admin's API key answers to the MFA requirement, so the
  // seed enrols Ada's TOTP before minting her key and prints the authenticator
  // URI ONCE, beside her one-time password — taken from there exactly as a
  // presenter would add it to an authenticator app, and kept in the run's
  // git-ignored secret store (cleared above) for the TOTP challenge.
  {
    const uri = /admin TOTP \(shown ONCE[^)]*\): (otpauth:\/\/totp\/\S+)/.exec(seedOut)?.[1];
    const secret = uri ? new URL(uri).searchParams.get("secret") : null;
    if (!secret) throw new Error("could not capture the admin's TOTP enrolment from the seed output");
    recordTotpSecret("admin@regulait.local", secret);
  }

  // 3. boot the gateway (dist) — logs to a file for post-mortems
  const logDir = process.env.E2E_LOG_DIR ?? here;
  mkdirSync(logDir, { recursive: true });
  const log = createWriteStream(path.join(logDir, "gateway-e2e.log"));
  const child = spawn("node", [path.join(repoRoot, "apps/gateway/dist/main.js")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    windowsHide: true,
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.unref();

  await waitFor(`http://127.0.0.1:${PORT}/health`, 30_000);

  writeFileSync(
    STATE_FILE,
    JSON.stringify({ pid: child.pid, passwords, baseUrl: `http://127.0.0.1:${PORT}` }, null, 2),
  );
  process.env.E2E_BASE_URL = `http://127.0.0.1:${PORT}`;
}
