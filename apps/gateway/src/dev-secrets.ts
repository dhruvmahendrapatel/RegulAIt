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
 *   - REFUSE by default (ADR-0167 amendment, S-02 of the 2026-11-07 review).
 *     The published values boot only when the listener is LOOPBACK-ONLY (a
 *     native `pnpm start` with HOST=127.0.0.1, the e2e harness, the demo's
 *     local gateway) and nothing says the box is deployed, or when the
 *     operator sets the explicit dev opt-in `REGULAIT_ALLOW_DEV_SECRETS=1`.
 *     The earlier rule refused only on a deploy signal, and the public
 *     compose profiles (`tls`, `hosted`, `tunnel`) set none, so they booted
 *     with a full-admin credential anyone could read. A deploy signal is
 *     `REGULAIT_DEPLOY_MODE` (install.sh writes it), `REGULAIT_HSTS`, or an
 *     `https` `REGULAIT_PUBLIC_URL` on a non-loopback host. A compose
 *     container listens on every interface, so the compose stack needs the
 *     opt-in (or real values) even with no profile. The opt-in is printed as
 *     a banner at boot and recorded in the audit log.
 *
 * A SHORT token is warned about, never refused: CI's `e2e-bootstrap-token`
 * is 19 characters and the demo's is whatever the presenter typed. The
 * refusing class is the PUBLISHED values and a key with no entropy — the
 * strings a scanner tries first.
 */
import { and, apiKeys, auditLog, authSessions, eq, isNotNull, isNull, or, sql, users, type Db } from "@regulait/db";
import { isLoopbackHost } from "@regulait/shared";

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
  /** true when the gateway listens on a loopback address only */
  loopbackOnly: boolean;
  /** why the published values are not accepted here, or null when they are (loopback, no deploy signal) */
  exposure: string | null;
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

/**
 * `REGULAIT_DEPLOY_MODE` or `REGULAIT_HSTS` set, or an `https` public URL on a
 * host that is not loopback = somebody deployed this. A malformed URL is not a
 * signal here (public-url.ts refuses it at boot on its own terms).
 */
export function networkFacingSignal(env: NodeJS.ProcessEnv): string | null {
  const mode = env.REGULAIT_DEPLOY_MODE?.trim();
  if (mode) return `REGULAIT_DEPLOY_MODE=${mode}`;
  const hsts = env.REGULAIT_HSTS?.trim();
  if (hsts) return "REGULAIT_HSTS is set";
  const pub = env.REGULAIT_PUBLIC_URL?.trim();
  if (pub) {
    let url: URL | null = null;
    try {
      url = new URL(pub);
    } catch {
      url = null;
    }
    if (url && url.protocol === "https:" && !isLoopbackHost(url.hostname)) {
      return `REGULAIT_PUBLIC_URL is https on ${url.hostname}`;
    }
  }
  return null;
}

/** is the listen address loopback-only? `0.0.0.0`, `::` and any real interface are not */
export function isLoopbackListen(host: string | undefined): boolean {
  if (host === undefined) return false;
  const h = host.trim();
  return h !== "" && isLoopbackHost(h);
}

export function assessDevSecrets(
  env: NodeJS.ProcessEnv,
  opts: {
    bootstrapToken?: string | undefined;
    dataKey?: string | undefined;
    realAdminExists?: boolean;
    /** the address the gateway listens on; absent = not known to be loopback */
    listenHost?: string | undefined;
    /** REGULAIT_BOOTSTRAP_AFTER_ADMIN=1: the token is NOT retired once a real admin exists */
    bootstrapAfterAdmin?: boolean;
  },
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
  const loopbackOnly = isLoopbackListen(opts.listenHost);
  const exposure =
    signal !== null
      ? signal
      : loopbackOnly
        ? null
        : `the gateway listens on ${opts.listenHost?.trim() || "every interface"}, not on loopback only`;
  const overridden = (env[DEV_SECRETS_OVERRIDE_ENV] ?? "").trim() === "1";
  const refuse = refusing.length > 0 && exposure !== null && !overridden;
  const bootstrapLine = !token
    ? "not configured (no break-glass admin — every call carries a real identity)"
    : opts.realAdminExists
      ? opts.bootstrapAfterAdmin
        ? "CONFIGURED and a real admin already exists, kept working by REGULAIT_BOOTSTRAP_AFTER_ADMIN=1 (relaxed) — remove both"
        : "RETIRED — a real admin exists, so the token authenticates nothing (remove REGULAIT_BOOTSTRAP_TOKEN)"
      : "CONFIGURED (break-glass admin, no user identity — retires itself once the first admin exists)";
  return { findings, refusing, networkFacingSignal: signal, loopbackOnly, exposure, overridden, refuse, bootstrapLine };
}

/** is there a live (enabled) admin user? (first-admin, ADR-0194, keys off this) */
export async function realAdminExists(db: Pick<Db, "select">): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isAdmin, true), isNull(users.disabledAt)))
    .limit(1);
  return Boolean(row);
}

/**
 * Is there an ACTIVE admin, i.e. is the bootstrap token still needed at all?
 * Active = enabled, an admin, and has signed in with a credential of their own
 * at least once (a session of theirs exists, or a key of theirs has been used).
 * An admin row the bootstrap token has only just created is not yet active, so
 * the token can still issue that admin's first password or key; the moment the
 * admin uses it, the token retires.
 */
export async function activeAdminExists(db: Pick<Db, "select">): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.isAdmin, true),
        isNull(users.disabledAt),
        or(
          sql`exists (select 1 from ${authSessions} where ${authSessions.userId} = ${users.id})`,
          sql`exists (select 1 from ${apiKeys} where ${apiKeys.userId} = ${users.id} and ${isNotNull(apiKeys.lastUsedAt)})`,
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// ADR-0167 amendment (S-02): the bootstrap credential RETIRES itself
// ---------------------------------------------------------------------------

/** the relaxation: `REGULAIT_BOOTSTRAP_AFTER_ADMIN=1` keeps the token working after an active admin exists */
export const BOOTSTRAP_AFTER_ADMIN_ENV = "REGULAIT_BOOTSTRAP_AFTER_ADMIN";

export function bootstrapAfterAdminRelaxed(env: NodeJS.ProcessEnv): boolean {
  return (env[BOOTSTRAP_AFTER_ADMIN_ENV] ?? "").trim() === "1";
}

/** one audit row per database handle (= per process) the first time a retired token is presented */
const retirementRecorded = new WeakSet<object>();

/**
 * Is the bootstrap credential retired right now? It is while an active admin
 * exists (see `activeAdminExists`), unless the relaxation is set. Checked on
 * every presentation of the token, so it costs one query only for a request
 * that already matched the token. If every admin is later disabled the token
 * works again: it is the break-glass path for exactly that lockout.
 *
 * The first retired presentation per process is audited (deny,
 * `bootstrap-retired`); later ones are not, so a scanner that knows the
 * published value cannot fill the chain.
 */
export async function bootstrapRetired(db: Db, afterAdmin: boolean): Promise<boolean> {
  if (afterAdmin) return false;
  if (!(await activeAdminExists(db))) return false;
  if (!retirementRecorded.has(db)) {
    retirementRecorded.add(db);
    await db
      .insert(auditLog)
      .values({
        userId: "00000000-0000-0000-0000-000000000000",
        objectType: "api_key",
        objectId: null,
        detail: { subsystem: "bootstrap", phase: "retired", relaxation: BOOTSTRAP_AFTER_ADMIN_ENV },
        effect: "deny",
        ruleId: "bootstrap-retired",
        ruleChain: [],
        reason:
          "the bootstrap credential was presented after an active admin exists, so it is retired and authenticated nothing " +
          "(remove REGULAIT_BOOTSTRAP_TOKEN)",
      })
      .catch(() => {
        retirementRecorded.delete(db);
      });
  }
  return true;
}

/** the refusal, as the one message an operator reads — like DataKeyBootError */
export class DevSecretsBootError extends Error {
  constructor(readonly assessment: DevSecretsAssessment) {
    super(
      `regulait gateway refused to start: dev-grade secrets where they can be reached (${assessment.exposure}).\n` +
        assessment.refusing.map((f) => `  - ${f}`).join("\n") +
        `\nSet real values (scripts/install.sh generates them), listen on loopback only (HOST=127.0.0.1) for a laptop, ` +
        `or set ${DEV_SECRETS_OVERRIDE_ENV}=1 to boot anyway on a box you accept is dev-grade (printed and audited).`,
    );
    this.name = "DevSecretsBootError";
  }
}

/**
 * The dev opt-in, RECORDED: one audit row per boot that used
 * `REGULAIT_ALLOW_DEV_SECRETS=1` to accept published or no-entropy secrets
 * where they would otherwise have been refused. The row names what was
 * accepted and why it would have been refused, never a secret value.
 */
export async function recordDevSecretsOptIn(db: Pick<Db, "insert">, assessment: DevSecretsAssessment): Promise<boolean> {
  if (!assessment.overridden || assessment.refusing.length === 0 || assessment.exposure === null) return false;
  await db.insert(auditLog).values({
    userId: "00000000-0000-0000-0000-000000000000",
    objectType: "org_settings",
    objectId: null,
    detail: { subsystem: "dev-secrets", optIn: DEV_SECRETS_OVERRIDE_ENV, exposure: assessment.exposure, accepted: assessment.refusing },
    effect: "allow",
    ruleId: "dev-secrets-opt-in",
    ruleChain: [],
    reason: `the gateway booted with published or no-entropy secrets (${assessment.exposure}) because ${DEV_SECRETS_OVERRIDE_ENV}=1 is set`,
  });
  return true;
}
