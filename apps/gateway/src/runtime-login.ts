/**
 * ADR-0234 batch 7b — THE RUNTIME LOGIN.
 *
 * The gateway serves requests on a login that is a member of `regulait_app` and is not a superuser, not BYPASSRLS and
 * not the owner of the row-level-security tables (`runtimeLoginProblems`). Such a login cannot step out of the
 * policies: the request paths run as their principal, and the paths with no principal under a named reason (batch 7a).
 *
 * Where the login comes from, in order:
 *   1. `REGULAIT_RUNTIME_DATABASE_URL`, operator-managed (a secrets manager, a Kubernetes secret);
 *   2. the install-generated login: with `REGULAIT_INSTALL_SECRETS_DIR` set, the first boot creates
 *      `regulait_runtime` through the owner connection with a generated password and keeps its connection string in
 *      `<dir>/runtime-database-url` (0600, create-exclusive, never overwritten). Later boots read it;
 *   3. neither: requests are served on the owner connection itself.
 *
 * Secure by default (ADR-0180): boot REFUSES a login that is not fit, whichever way it was resolved. A superuser or
 * table-owner login is what every local and CI database uses, so a developer may opt in with
 * `REGULAIT_DEV_PRIVILEGED_DB_LOGIN=1`: the boot then prints a loud banner, writes an audit row and the posture line
 * says RLS does not bind requests. The opt-in never applies silently.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import {
  auditLog,
  createDb,
  inspectRuntimeLogin,
  provisionRuntimeLogin,
  RUNTIME_LOGIN_ROLE,
  runtimeLoginProblems,
  type Db,
  type RuntimeLoginFacts,
} from "@regulait/db";
import { INSTALL_SECRETS_DIR_ENV } from "./receipt-signing-key.js";

export const RUNTIME_DATABASE_URL_ENV = "REGULAIT_RUNTIME_DATABASE_URL";
export const DEV_PRIVILEGED_DB_LOGIN_ENV = "REGULAIT_DEV_PRIVILEGED_DB_LOGIN";
/** the install secrets file holding the generated runtime login's connection string */
export const RUNTIME_URL_FILE = "runtime-database-url";

export type RuntimeLoginSource = "operator_managed" | "install_generated" | "owner";

export interface ResolvedRuntimeDatabase {
  db: Db;
  source: RuntimeLoginSource;
  /** true when this boot created (or re-keyed) the install-generated login */
  created: boolean;
}

const POSIX = process.platform !== "win32";

function readUrlFile(file: string): string | null {
  try {
    const v = readFileSync(file, "utf8").trim();
    return v.length > 0 ? v : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * The handle requests are served on. `ownerUrl` is the owner's connection string (the install-generated login's URL
 * is the owner's with the user and password replaced); without it no login is generated.
 */
export async function resolveRuntimeDatabase(
  env: NodeJS.ProcessEnv,
  ownerDb: Db,
  ownerUrl: string | undefined,
): Promise<ResolvedRuntimeDatabase> {
  const operator = env[RUNTIME_DATABASE_URL_ENV]?.trim();
  if (operator) return { db: createDb(operator), source: "operator_managed", created: false };

  const dir = env[INSTALL_SECRETS_DIR_ENV]?.trim();
  if (!dir || !ownerUrl) return { db: ownerDb, source: "owner", created: false };

  const file = path.join(dir, RUNTIME_URL_FILE);
  const existing = readUrlFile(file);
  if (existing) return { db: createDb(existing), source: "install_generated", created: false };

  // First boot: claim the file (create-exclusive, so two booting replicas create one login), then create the login.
  const password = randomBytes(32).toString("base64url");
  const url = new URL(ownerUrl);
  url.username = RUNTIME_LOGIN_ROLE;
  url.password = password;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(file, POSIX ? fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW : "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const raced = readUrlFile(file);
      if (raced) return { db: createDb(raced), source: "install_generated", created: false };
    }
    throw err;
  }
  try {
    writeSync(fd, `${url.toString()}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    await provisionRuntimeLogin(ownerDb, password);
  } catch (err) {
    // a file naming a login that does not exist would fail every later boot; the next boot tries again
    try {
      unlinkSync(file);
    } catch {
      /* best effort */
    }
    throw new RuntimeLoginBootError([`could not be created through the owner connection: ${(err as Error).message}`], RUNTIME_LOGIN_ROLE);
  }
  return { db: createDb(url.toString()), source: "install_generated", created: true };
}

export interface RuntimeLoginCheck {
  facts: RuntimeLoginFacts;
  problems: string[];
  /** true when the login is not fit and the dev opt-in let the boot continue */
  privileged: boolean;
}

/** The boot refusal: the login requests run on, and what is wrong with it. */
export class RuntimeLoginBootError extends Error {
  constructor(
    readonly problems: string[],
    readonly login: string,
  ) {
    super(
      `[regulait] refusing to start: the database login that serves requests ('${login}') ${problems.join("; ")}. ` +
        `Row-level security would not bind it (ADR-0234). Set ${INSTALL_SECRETS_DIR_ENV} so the first boot creates the ` +
        `${RUNTIME_LOGIN_ROLE} login through the owner connection, or set ${RUNTIME_DATABASE_URL_ENV} to a login that is ` +
        `a member of regulait_app and is not a superuser, BYPASSRLS or the table owner. On a development database only, ` +
        `${DEV_PRIVILEGED_DB_LOGIN_ENV}=1 starts anyway, loudly and audited.`,
    );
    this.name = "RuntimeLoginBootError";
  }
}

/** Read the login `db` connects as and refuse it when it is not fit (unless the dev opt-in is set). */
export async function checkRuntimeLogin(db: Db, env: NodeJS.ProcessEnv): Promise<RuntimeLoginCheck> {
  const facts = await inspectRuntimeLogin(db);
  const problems = runtimeLoginProblems(facts);
  if (problems.length === 0) return { facts, problems, privileged: false };
  if (env[DEV_PRIVILEGED_DB_LOGIN_ENV]?.trim() === "1") return { facts, problems, privileged: true };
  throw new RuntimeLoginBootError(problems, facts.login);
}

/** the banner a privileged (dev opt-in) boot prints, before anything else is served */
export function privilegedRuntimeLoginBanner(check: RuntimeLoginCheck): string[] {
  const bar = "*".repeat(100);
  return [
    bar,
    `*** ${DEV_PRIVILEGED_DB_LOGIN_ENV}=1: requests are served on '${check.facts.login}', which ${check.problems.join("; ")}.`,
    "*** Row-level security does NOT bind this gateway's requests (ADR-0234). Development databases only; this boot is audited.",
    bar,
  ];
}

/** the posture line for the boot block */
export function describeRuntimeLogin(check: RuntimeLoginCheck, source: RuntimeLoginSource): string {
  if (check.privileged) return `'${check.facts.login}' PRIVILEGED (${DEV_PRIVILEGED_DB_LOGIN_ENV}=1), row-level security does not bind requests`;
  const how = source === "operator_managed" ? RUNTIME_DATABASE_URL_ENV : source === "install_generated" ? "install-generated" : "the owner URL";
  return `'${check.facts.login}' (${how}), member of regulait_app, row-level security enforced`;
}

const NIL_USER = "00000000-0000-0000-0000-000000000000";

/** one audit row per boot that used the dev opt-in */
export async function auditPrivilegedRuntimeLogin(db: Db, check: RuntimeLoginCheck): Promise<void> {
  await db.insert(auditLog).values({
    userId: NIL_USER,
    objectType: "org_settings",
    objectId: null,
    detail: { subsystem: "runtime-db-login", login: check.facts.login, problems: check.problems, optIn: DEV_PRIVILEGED_DB_LOGIN_ENV },
    effect: "deny",
    ruleId: "runtime-db-login-privileged",
    ruleChain: [],
    reason: `the gateway started on a database login that row-level security does not bind ('${check.facts.login}': ${check.problems.join("; ")}), because ${DEV_PRIVILEGED_DB_LOGIN_ENV}=1 was set`,
  });
}
