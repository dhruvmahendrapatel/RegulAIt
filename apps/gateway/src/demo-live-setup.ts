/**
 * ADR-0202 (lane L) — `pnpm --filter @regulait/gateway demo:live-setup`.
 *
 * Creates the live-demo profile's real GitHub, Jira Cloud, Azure DevOps and Slack connections (and the Slack ChatOps
 * inbound workspace) through the product's own API, in process, as the seed does. Run AFTER `seed` with
 * `REGULAIT_DEMO_PROFILE=live`, so the egress entries exist before a connection's base URL is checked.
 *
 * Settings: the `REGULAIT_DEMO_*` variables in `demo-live-lib.ts` (`LIVE_DEMO_ENV`), plus DATABASE_URL,
 * REGULAIT_BOOTSTRAP_TOKEN and REGULAIT_DATA_KEY like every other demo script.
 * Secrets: a hidden prompt for each one, or `REGULAIT_DEMO_LIVE_SECRETS_FILE` (absolute path outside the checkout,
 * chmod 600). A secret is never echoed, printed or logged. Idempotent: re-run it freely.
 *
 * The product mints ONE inbound secret per PM connection, which the operator registers in Jira (URL token) and Azure
 * DevOps (service-hook basic-auth password). With `REGULAIT_DEMO_LIVE_INBOUND_FILE` (absolute, outside the checkout)
 * they are written there with mode 0600; without it they are printed once, like every secret the product mints, and
 * only to a terminal (a piped or CI log never receives them).
 *
 * Refuses, before migrations or any write, unless REGULAIT_DEMO_PROFILE=live and every admin in the database is a
 * seed persona (`liveSetupRefusal`, ADR-0181 FX3).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createDb, runMigrations } from "@regulait/db";
import { buildApp } from "./app.js";
import { realAdminEmails } from "./seed-demo-guard.js";
import {
  applyLiveDemoSetup,
  ensureLiveEgressHosts,
  inboundFileRefusal,
  LIVE_DEMO_ENV,
  LIVE_SECRET_KEYS,
  liveDemoEgressHosts,
  liveSetupRefusal,
  loadSecretsFile,
  neededSecrets,
  readLiveDemoConfig,
  type ApiCall,
  type LiveSecrets,
} from "./demo-live-lib.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const connectionString = process.env.DATABASE_URL ?? "postgres://regulait:regulait@localhost:5432/regulait";
const BOOT = process.env.REGULAIT_BOOTSTRAP_TOKEN ?? "seed-bootstrap";
const DATA_KEY = process.env.REGULAIT_DATA_KEY;

/** one line from the terminal with echo off: nothing typed reaches the screen or scrollback */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const mutable = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let muted = false;
    mutable._writeToOutput = (s: string) => {
      if (!muted) mutable.output.write(s);
    };
    rl.question(`${question} (hidden, Enter to skip): `, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
    muted = true;
  });
}

{
  const refusal = liveSetupRefusal(process.env, null);
  if (refusal) {
    console.error(`\n${refusal}\n`);
    process.exit(2);
  }
}
if (!DATA_KEY) {
  console.error("REGULAIT_DATA_KEY is not set: connection tokens are stored encrypted under it. Nothing was done.");
  process.exit(1);
}
const { config, problems } = readLiveDemoConfig(process.env);
for (const p of problems) console.log(`  note: ${p}`);
const needed = neededSecrets(config);
if (needed.length === 0) {
  console.error("No live integration is configured; set the REGULAIT_DEMO_* variables (DEMO_REAL_ACCOUNTS.md). Nothing was done.");
  process.exit(1);
}

let secrets: LiveSecrets = {};
const file = process.env[LIVE_DEMO_ENV.secretsFile];
if (file) {
  try {
    secrets = loadSecretsFile(file, REPO_ROOT, { lstat: lstatSync, realpath: realpathSync, read: (p) => readFileSync(p, "utf8") });
  } catch (err) {
    console.error(`${(err as Error).message}. Nothing was done.`);
    process.exit(1);
  }
} else {
  if (!process.stdin.isTTY) {
    console.error(`No terminal to prompt on: set ${LIVE_DEMO_ENV.secretsFile} instead. Nothing was done.`);
    process.exit(1);
  }
  for (const key of needed) {
    const v = await askHidden(LIVE_SECRET_KEYS[key]);
    if (v) secrets[key] = v;
  }
}

const inboundFile = process.env.REGULAIT_DEMO_LIVE_INBOUND_FILE;
if (inboundFile) {
  const lstatOrNull = (p: string) => {
    try {
      return lstatSync(p);
    } catch {
      return null;
    }
  };
  const refusal = inboundFileRefusal(inboundFile, REPO_ROOT, { lstat: lstatOrNull, realpath: realpathSync });
  if (refusal) {
    console.error(`${refusal}. Nothing was done.`);
    process.exit(1);
  }
} else if (!process.stdout.isTTY) {
  console.error("Output is not a terminal, so the inbound webhook secrets cannot be shown: set REGULAIT_DEMO_LIVE_INBOUND_FILE. Nothing was done.");
  process.exit(1);
}

const db = createDb(connectionString);
(db.$client as { on: (ev: string, fn: (err: Error) => void) => void }).on("error", () => {});
{
  const refusal = liveSetupRefusal(process.env, await realAdminEmails(db));
  if (refusal) {
    console.error(`\n${refusal}\n`);
    await (db.$client as { end: () => Promise<void> }).end();
    process.exit(2);
  }
}
await runMigrations(db, path.resolve(here, "../../../packages/db/migrations"));
const app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
await app.ready();
const call: ApiCall = async (method, url, payload) => {
  const res = await app.inject({
    method: method as "GET",
    url,
    headers: { authorization: `Bearer ${BOOT}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  let body: unknown = null;
  try {
    body = res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.statusCode, body };
};

let failed = false;
try {
  const egress = await ensureLiveEgressHosts(call, liveDemoEgressHosts(process.env));
  console.log(`egress allow-list: ${egress.added.length} added, ${egress.present.length} already present`);
  if (egress.needsAdmin.length > 0) {
    console.log(
      `  NOT added (an admin must add them under Custom LLM providers > Egress allow-list, with a step-up): ${egress.needsAdmin.join(", ")}`,
    );
  }
  for (const f of egress.failed) console.log(`  FAILED: ${f}`);

  const result = await applyLiveDemoSetup(call, config, secrets);
  for (const s of result.steps) console.log(`${s.outcome.toUpperCase().padEnd(8)} ${s.beat.padEnd(17)} ${s.step}: ${s.detail}`);
  failed = result.steps.some((s) => s.outcome === "failed");

  if (result.inbound.length > 0) {
    const publicUrl = (process.env.REGULAIT_PUBLIC_URL ?? "https://demo.example.com").replace(/\/$/, "");
    const entries = result.inbound.map((i) => ({
      connection: i.connection,
      provider: i.provider,
      webhookUrl:
        i.provider === "jira"
          ? `${publicUrl}/v1/pm/webhooks/${i.connection}?token=${encodeURIComponent(i.webhookSecret)}`
          : `${publicUrl}/v1/pm/webhooks/${i.connection}`,
      ...(i.provider === "azure_devops" ? { basicAuthPassword: i.webhookSecret } : {}),
    }));
    if (inboundFile) {
      // a fresh 0600 temp file (`wx`: never an existing file or link), renamed over the path: rename replaces a link, never follows it
      const tmp = path.join(path.dirname(inboundFile), `.${path.basename(inboundFile)}.${process.pid}.tmp`);
      try {
        writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        renameSync(tmp, inboundFile);
      } catch (err) {
        try {
          unlinkSync(tmp);
        } catch {
          /* not created */
        }
        throw err;
      }
      console.log(`inbound webhook settings for ${entries.map((e) => e.connection).join(", ")} written to ${inboundFile} (mode 0600)`);
    } else {
      console.log("\nInbound webhook settings (shown ONCE; register them now, see DEMO_REAL_ACCOUNTS.md):");
      for (const e of entries) console.log(`  ${JSON.stringify(e)}`);
    }
  }
} finally {
  await app.close();
  await (db.$client as { end: () => Promise<void> }).end();
}
process.exit(failed ? 1 : 0);
