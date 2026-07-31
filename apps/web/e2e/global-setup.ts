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
  execFileSync("psql", [`${PG}/postgres`, "-v", "ON_ERROR_STOP=1", "-c",
    `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`]);
  execFileSync("psql", [`${PG}/postgres`, "-v", "ON_ERROR_STOP=1", "-c",
    `CREATE DATABASE ${DB_NAME}`]);

  const env = {
    ...process.env,
    DATABASE_URL,
    REGULAIT_BOOTSTRAP_TOKEN: BOOT,
    REGULAIT_DATA_KEY: DATA_KEY,
    PORT: String(PORT),
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

  // 3. boot the gateway (dist) — logs to a file for post-mortems
  const logDir = process.env.E2E_LOG_DIR ?? here;
  mkdirSync(logDir, { recursive: true });
  const log = createWriteStream(path.join(logDir, "gateway-e2e.log"));
  const child = spawn("node", [path.join(repoRoot, "apps/gateway/dist/main.js")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
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
