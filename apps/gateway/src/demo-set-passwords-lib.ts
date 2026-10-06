/**
 * ADR-0174 §6 — `demo:set-passwords`: give the demo personas a password the
 * presenter chose, so the demo journeys sign in without the one-time-password
 * dance, WITHOUT that password ever living in the repository, seed data, logs
 * or audit detail.
 *
 * The rules, each enforced here and each pinned by a test:
 *  - the password comes from the environment (`REGULAIT_DEMO_USER_PASSWORD`)
 *    or a secret file (`REGULAIT_DEMO_USER_PASSWORD_FILE`) — never an argument
 *    (shell history) and never a default;
 *  - it must pass the org's own password policy (the same `checkPasswordPolicy`
 *    every password write answers to);
 *  - it runs only on a demo-licensed deployment (ADR-0174 §6, enforced as
 *    written since the security review): the installed licence must be a
 *    VALID demo licence — the ephemeral one `demo:setup` (step 4 of
 *    DEMO_RUNBOOK §1, and therefore `demo:prepare`) installs, or seed's opt-in
 *    `REGULAIT_EPHEMERAL_LICENSE=1` one. No licence, an expired one, or a
 *    customer licence is a refusal, whatever the box looks like;
 *  - it clears the one-time / forced-change flag, resets the lockout counters
 *    and revokes the personas' live sessions (a password change does);
 *  - it writes one audit row per persona that names WHAT happened and from
 *    which source — never the password, never its hash;
 *  - it never prints the password;
 *  - ADR-0181 (FX2): it re-provisions an ADMIN persona's authenticator. The
 *    demo seed enrols the admin's TOTP itself (an admin's API key answers to
 *    the MFA requirement, and the prep tooling acts as her through keys), and
 *    that secret was shown once on the seed's console. Setting the presenter's
 *    own password therefore clears the seed's enrolment too — audited, like
 *    the admin "clear MFA" route — and the admin enrols her own authenticator
 *    at her first browser sign-in, before anything else opens. MFA stays
 *    required throughout; nothing is relaxed.
 */
import { readFileSync } from "node:fs";
import { and, authMfaPending, authSessions, auditLog, eq, inArray, isNull, users, type Db } from "@regulait/db";
import { checkPasswordPolicy, hashPassword } from "./auth.js";
import { networkFacingSignal } from "./dev-secrets.js";
import { resolveLicense } from "./licensing.js";
import { loadOrgSettings } from "./org-settings.js";

/** the personas `seed` / `demo:intake` create (Ada, Dana, Avery) */
export const DEMO_PERSONA_EMAILS = [
  "admin@regulait.local",
  "dana@regulait.local",
  "avery@regulait.local",
] as const;

export const DEMO_PASSWORD_ENV = "REGULAIT_DEMO_USER_PASSWORD";
export const DEMO_PASSWORD_FILE_ENV = "REGULAIT_DEMO_USER_PASSWORD_FILE";

export interface SetDemoPasswordsResult {
  ok: boolean;
  /** 0 done, 1 refused by a rule, 2 setup problem */
  exitCode: 0 | 1 | 2;
  lines: string[];
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** a licence the demo tooling minted for itself (demo-setup / seed), which
 * says on its face that it is not a production deployment */
export function isDemoLicense(doc: { licenseId: string; tenant: string } | null): boolean {
  if (!doc) return false;
  return /^(demo|seed)-/.test(doc.licenseId) && doc.tenant.includes("NOT A PRODUCTION DEPLOYMENT");
}

function readPassword(env: NodeJS.ProcessEnv): { password: string; source: "env" | "file" } | { error: string } {
  const direct = env[DEMO_PASSWORD_ENV];
  const file = env[DEMO_PASSWORD_FILE_ENV]?.trim();
  if (direct !== undefined && direct !== "" && file) {
    return { error: `set ${DEMO_PASSWORD_ENV} or ${DEMO_PASSWORD_FILE_ENV}, not both` };
  }
  if (file) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      return { error: `${DEMO_PASSWORD_FILE_ENV} could not be read (${(err as NodeJS.ErrnoException).code ?? "error"})` };
    }
    // one trailing newline is the file's, not the password's
    const password = raw.replace(/\r?\n$/, "");
    if (!password) return { error: `${DEMO_PASSWORD_FILE_ENV} names an empty file` };
    return { password, source: "file" };
  }
  if (direct !== undefined && direct !== "") return { password: direct, source: "env" };
  return {
    error: `no password given: set ${DEMO_PASSWORD_ENV} (or ${DEMO_PASSWORD_FILE_ENV} pointing at a secret file). Nothing was changed.`,
  };
}

export async function setDemoPasswords(db: Db, env: NodeJS.ProcessEnv): Promise<SetDemoPasswordsResult> {
  const lines: string[] = [];
  const pw = readPassword(env);
  if ("error" in pw) return { ok: false, exitCode: 2, lines: [`demo:set-passwords refused: ${pw.error}`] };

  // ---- demo-only ----------------------------------------------------------
  const license = await resolveLicense(db);
  const demoLicensed =
    (license.state === "valid" || license.state === "grace") && isDemoLicense(license.document);
  if (license.document && !isDemoLicense(license.document)) {
    return {
      ok: false,
      exitCode: 1,
      lines: [
        "demo:set-passwords refused: a customer (non-demo) licence is installed — this command only runs on a demo deployment. Nothing was changed.",
      ],
    };
  }
  if (demoLicensed !== true) {
    const signal = networkFacingSignal(env);
    return {
      ok: false,
      exitCode: 1,
      lines: [
        `demo:set-passwords refused: no valid demo licence is installed${signal ? ` (and this box looks like a real deployment: ${signal})` : ""}. Run demo:setup first (DEMO_RUNBOOK §1 step 4 — demo:prepare runs it), which installs the ephemeral demo licence; under Docker Compose, put REGULAIT_DEMO_LICENSE=1 in the .env next to docker-compose.yml and run \`docker compose up -d\` again (demo only — never on an install). Nothing was changed.`,
      ],
    };
  }

  // ---- the org's own password policy ---------------------------------------
  const org = await loadOrgSettings(db);
  const weak = checkPasswordPolicy(pw.password, org.passwordMinLength, org.passwordRequireClasses);
  if (weak) {
    return { ok: false, exitCode: 1, lines: [`demo:set-passwords refused: ${weak} (org password policy). Nothing was changed.`] };
  }

  // ---- the personas ---------------------------------------------------------
  const found = await db
    .select({
      id: users.id,
      email: users.email,
      disabledAt: users.disabledAt,
      mustChangePassword: users.mustChangePassword,
      isAdmin: users.isAdmin,
      totpEnabled: users.totpEnabled,
    })
    .from(users)
    .where(inArray(users.email, [...DEMO_PERSONA_EMAILS]));
  if (found.length === 0) {
    return { ok: false, exitCode: 2, lines: ["demo:set-passwords: no demo personas found — run demo:prepare first. Nothing was changed."] };
  }
  const now = new Date();
  for (const email of DEMO_PERSONA_EMAILS) {
    const u = found.find((f) => f.email === email);
    if (!u) {
      lines.push(`  ${email.padEnd(24)} not found — skipped`);
      continue;
    }
    if (u.disabledAt) {
      lines.push(`  ${email.padEnd(24)} deactivated — skipped`);
      continue;
    }
    await db
      .update(users)
      .set({
        passwordHash: hashPassword(pw.password),
        passwordUpdatedAt: now,
        mustChangePassword: false,
        failedLoginCount: 0,
        lastFailedLoginAt: null,
        lockedUntil: null,
      })
      .where(eq(users.id, u.id));
    // a password change kills every live session for the account
    await db
      .update(authSessions)
      .set({ revokedAt: now })
      .where(and(eq(authSessions.userId, u.id), isNull(authSessions.revokedAt)));
    await db.insert(auditLog).values({
      userId: NIL_UUID,
      objectType: "user",
      objectId: u.id,
      // WHAT happened and from WHICH source — never the password or its hash
      detail: {
        phase: "demo-password",
        email,
        source: pw.source,
        clearedMustChange: u.mustChangePassword,
        demoLicensed,
        via: "demo:set-passwords",
      },
      effect: "allow",
      ruleId: "demo-password-set",
      ruleChain: [],
      reason: `demo:set-passwords set the password of demo persona '${email}' from the ${pw.source === "env" ? DEMO_PASSWORD_ENV : DEMO_PASSWORD_FILE_ENV} ${pw.source === "env" ? "environment variable" : "secret file"} (one-time flag cleared, sessions revoked)`,
    });
    lines.push(`  ${email.padEnd(24)} password set (one-time flag cleared, live sessions revoked)`);
    // ADR-0181 (FX2): the seed-enrolled authenticator of an admin persona is
    // re-provisioned — she enrols her own at her first sign-in (see above)
    if (u.isAdmin && u.totpEnabled) {
      await db
        .update(users)
        .set({ totpEnabled: false, totpSecretCiphertext: null, totpLastUsedStep: null })
        .where(eq(users.id, u.id));
      await db.delete(authMfaPending).where(eq(authMfaPending.userId, u.id));
      await db.insert(auditLog).values({
        userId: NIL_UUID,
        objectType: "user",
        objectId: u.id,
        detail: { phase: "mfa-cleared", email, via: "demo:set-passwords", demoLicensed },
        effect: "allow",
        ruleId: "mfa-cleared-by-admin",
        ruleChain: [],
        reason: `demo:set-passwords re-provisioned the authenticator of demo admin '${email}': the seed's TOTP enrolment is cleared and she enrols her own at her first sign-in (MFA stays required)`,
      });
      lines.push(`  ${"".padEnd(24)} authenticator re-provisioned: enrols TOTP at first sign-in (MFA required for admins)`);
    }
  }
  return {
    ok: true,
    exitCode: 0,
    lines: [
      `demo:set-passwords — password from ${pw.source === "env" ? DEMO_PASSWORD_ENV : DEMO_PASSWORD_FILE_ENV} (not printed)`,
      ...lines,
    ],
  };
}
