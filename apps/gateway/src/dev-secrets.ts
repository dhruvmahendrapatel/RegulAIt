/**
 * ADR-0167 (AUTHZ-05 / CFG-03) — the published dev-grade secrets, named at boot.
 *
 * docker-compose.yml ships `REGULAIT_BOOTSTRAP_TOKEN=dev-bootstrap` and a
 * 64×`a` `REGULAIT_DATA_KEY` so that `docker compose up --build` needs no
 * setup. Both are printed in the public repository. The bootstrap token
 * authenticates as a FULL ADMIN with no user identity on every route, never
 * expires, is exempt from the IP envelope by design, and the only thing that
 * refused the published value was scripts/install.sh — which a bare compose
 * `--profile tls` on a public host never runs. The gateway itself printed
 * nothing about either, so an operator could not tell from the boot log that
 * the break-glass door was open, or that every stored secret was decryptable
 * with a key anyone can read.
 *
 * Two outcomes, deliberately:
 *
 *   - PRINT, always. The posture block names whether a bootstrap token is
 *     configured (and whether a real admin already exists, at which point the
 *     token has done its one job) and every dev-grade fact it finds.
 *   - REFUSE, only when the process shows a sign of being a real deployment:
 *     `REGULAIT_DEPLOY_MODE` is set (install.sh writes it) or `REGULAIT_HSTS`
 *     is set (an operator on a real domain). A laptop following the README,
 *     the e2e harness and the demo's local gateway set neither and keep
 *     booting with a loud line. `REGULAIT_ALLOW_DEV_SECRETS=1` overrides the
 *     refusal for a deployment that knows what it is doing (a disposable
 *     staging box), and is itself printed.
 *
 * A SHORT token is warned about, never refused: CI's `e2e-bootstrap-token`
 * is 19 characters and the demo's is whatever the presenter typed. The
 * refusing class is the PUBLISHED values and a key with no entropy — the
 * strings a scanner tries first.
 */
import { and, eq, isNull, users, type Db } from "@regulait/db";

export const PUBLISHED_BOOTSTRAP_TOKENS: ReadonlySet<string> = new Set(["dev-bootstrap", "seed-bootstrap"]);
export const PUBLISHED_DATA_KEY = "a".repeat(64);
export const DEV_SECRETS_OVERRIDE_ENV = "REGULAIT_ALLOW_DEV_SECRETS";
export const BOOTSTRAP_TOKEN_MIN_LENGTH = 16;

export interface DevSecretsAssessment {
  /** one line per dev-grade fact; empty when nothing dev-grade was found */
  findings: string[];
  /** the facts that would refuse a real deployment (a subset of findings) */
  refusing: string[];
  /** the env signal that says "this is a real deployment", or null */
  networkFacingSignal: string | null;
  /** true when the override env var is set */
  overridden: boolean;
  /** true = the boot must not proceed */
  refuse: boolean;
  /** the `bootstrap:` line of the posture block */
  bootstrapLine: string;
}

function distinctHexChars(key: string): number {
  return new Set(key.trim().toLowerCase()).size;
}

/** `REGULAIT_DEPLOY_MODE` or `REGULAIT_HSTS` set = somebody deployed this */
export function networkFacingSignal(env: NodeJS.ProcessEnv): string | null {
  const mode = env.REGULAIT_DEPLOY_MODE?.trim();
  if (mode) return `REGULAIT_DEPLOY_MODE=${mode}`;
  const hsts = env.REGULAIT_HSTS?.trim();
  if (hsts) return "REGULAIT_HSTS is set";
  return null;
}

export function assessDevSecrets(
  env: NodeJS.ProcessEnv,
  opts: { bootstrapToken?: string | undefined; dataKey?: string | undefined; realAdminExists?: boolean },
): DevSecretsAssessment {
  const findings: string[] = [];
  const refusing: string[] = [];
  const token = opts.bootstrapToken?.trim() ?? "";
  if (token && PUBLISHED_BOOTSTRAP_TOKENS.has(token)) {
    const f =
      `REGULAIT_BOOTSTRAP_TOKEN is the published dev default '${token}' — a full-admin credential ` +
      `anyone with the repository knows (mint one: openssl rand -hex 24)`;
    findings.push(f);
    refusing.push(f);
  } else if (token && token.length < BOOTSTRAP_TOKEN_MIN_LENGTH) {
    findings.push(
      `REGULAIT_BOOTSTRAP_TOKEN is ${token.length} characters — a break-glass admin credential should be at least ` +
        `${BOOTSTRAP_TOKEN_MIN_LENGTH} (mint one: openssl rand -hex 24)`,
    );
  }
  const key = opts.dataKey?.trim() ?? "";
  if (key && (key.toLowerCase() === PUBLISHED_DATA_KEY || (/^[0-9a-f]{64}$/i.test(key) && distinctHexChars(key) < 8))) {
    const f =
      key.toLowerCase() === PUBLISHED_DATA_KEY
        ? "REGULAIT_DATA_KEY is the published dev default — every stored secret is decryptable with a key printed in the public repository"
        : "REGULAIT_DATA_KEY has almost no entropy (fewer than 8 distinct hex characters) — mint one: openssl rand -hex 32";
    findings.push(f);
    refusing.push(f);
  }
  const signal = networkFacingSignal(env);
  const overridden = (env[DEV_SECRETS_OVERRIDE_ENV] ?? "").trim() === "1";
  const refuse = refusing.length > 0 && signal !== null && !overridden;
  const bootstrapLine = !token
    ? "not configured (no break-glass admin — every call carries a real identity)"
    : opts.realAdminExists
      ? "CONFIGURED and a real admin already exists — remove REGULAIT_BOOTSTRAP_TOKEN; the break-glass token has done its one job"
      : "CONFIGURED (break-glass admin, no user identity — remove REGULAIT_BOOTSTRAP_TOKEN once the first admin exists)";
  return { findings, refusing, networkFacingSignal: signal, overridden, refuse, bootstrapLine };
}

/** is there a live admin user, i.e. is the bootstrap token still needed at all? */
export async function realAdminExists(db: Db): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isAdmin, true), isNull(users.disabledAt)))
    .limit(1);
  return Boolean(row);
}

/** the refusal, as the one message an operator reads — like DataKeyBootError */
export class DevSecretsBootError extends Error {
  constructor(readonly assessment: DevSecretsAssessment) {
    super(
      `regulait gateway refused to start: dev-grade secrets on a deployed box (${assessment.networkFacingSignal}).\n` +
        assessment.refusing.map((f) => `  - ${f}`).join("\n") +
        `\nSet real values (scripts/install.sh generates them), or set ${DEV_SECRETS_OVERRIDE_ENV}=1 to boot anyway on a box you accept is dev-grade.`,
    );
    this.name = "DevSecretsBootError";
  }
}
