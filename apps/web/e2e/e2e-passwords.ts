/**
 * ADR-0174 §6 (the standing rule): no password a journey sets is a literal in
 * source. The passwords the web e2e journeys settle the seeded personas on (and
 * the fixtures some specs create) are generated per run by `global-setup.ts`, or
 * taken from `E2E_<NAME>_PASSWORD` when one is exported, and handed to the specs
 * in the run's git-ignored state file. Every spec, and a worker Playwright
 * restarts after a failure, therefore settles a persona on the SAME value, which
 * an in-module random value would not give.
 *
 * Without a state file (a mock config, `--list`) the values are generated in the
 * process; nothing then depends on them across specs.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { disposablePassword } from "./demo-credentials";

/** each settled password and the environment variable that may supply it */
export const SETTLED_PASSWORD_ENV = {
  /** Ada once her one-time password is spent (phase2 and most zz- specs) */
  admin: "E2E_ADMIN_PASSWORD",
  /** Dana after phase1 rewrites her one-time password */
  dana: "E2E_DANA_PASSWORD",
  /** Avery after phase2's custody journey */
  averyCustody: "E2E_AVERY_CUSTODY_PASSWORD",
  /** Avery when phase3 is the first to spend her one-time password */
  averyContext: "E2E_AVERY_CONTEXT_PASSWORD",
  /** the separation-of-duties approver fixture (zz-zz-sod-rules) */
  sodApprover: "E2E_SOD_APPROVER_PASSWORD",
  /** Ida, the deploy-override fixture (zz-deploy-override) */
  overrideIda: "E2E_OVERRIDE_IDA_PASSWORD",
} as const;

export type SettledPasswords = Record<keyof typeof SETTLED_PASSWORD_ENV, string>;

/** one fresh password per persona (or its environment override); global-setup calls this once per run */
export function generateSettledPasswords(): SettledPasswords {
  const out = {} as SettledPasswords;
  for (const [key, env] of Object.entries(SETTLED_PASSWORD_ENV) as Array<[keyof SettledPasswords, string]>) {
    out[key] = disposablePassword(env);
  }
  return out;
}

const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), ".e2e-state.json");

function load(): SettledPasswords {
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { settledPasswords?: Partial<SettledPasswords> };
    const given = state.settledPasswords;
    if (given && Object.keys(SETTLED_PASSWORD_ENV).every((k) => typeof given[k as keyof SettledPasswords] === "string")) {
      return given as SettledPasswords;
    }
  } catch {
    // no state file: this process is not part of a global-setup run
  }
  return generateSettledPasswords();
}

/** this run's settled passwords */
export const E2E_PASSWORDS: SettledPasswords = load();
