/**
 * ADR-0194 — the installer creates the first admin with a password the
 * OPERATOR chose. `scripts/install.sh` runs `first-admin.js` inside the
 * gateway container (`docker compose exec -T gateway ...`) and pipes the
 * password on stdin, so it is never an argument (process list, shell
 * history), never in `.env`, a compose file, a log or audit detail.
 *
 * The rules, each enforced here and each pinned by a test
 * (first-admin-lib.test.ts):
 *  - it runs only while the deployment has NO active admin; with one, it
 *    changes nothing and says so (a re-run of the installer skips the step);
 *  - the username answers to the shared `usernameSchema` (USERNAME_PATTERN,
 *    normalised to lower case), the email to `createUserSchema`, exactly as
 *    POST /v1/users and PUT /v1/users/:id/username validate them;
 *  - the password answers to the org's own policy (`checkPasswordPolicy`, the
 *    check every password write makes) BEFORE anything is created;
 *  - the seat gate POST /v1/users applies is applied here too;
 *  - the account, its username, its password hash and the audit rows are
 *    written in ONE transaction under the sign-in invariant lock (so two
 *    installers racing cannot both create "the first" admin);
 *  - the audit rows are the ones the HTTP path writes (`username-set`,
 *    `initial-password-set`, both through `auditAuth`) plus a
 *    `first-admin-created` row naming the installer. None carries the password
 *    or its hash;
 *  - the password is the operator's own choice, so it is NOT flagged
 *    must-change; ADR-0181 still makes the admin enrol TOTP at first sign-in.
 */
import { auditLog, sql, users, type Db } from "@regulait/db";
import { createUserSchema, usernameSchema } from "@regulait/shared";
import { auditAuth, checkPasswordPolicy, hashPassword } from "./auth.js";
import { withSignInInvariant } from "./break-glass.js";
import { realAdminExists } from "./dev-secrets.js";
import { refuseIfSeatCapReached } from "./licensing.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** what the installer suggests when the operator just presses Enter */
export const FIRST_ADMIN_DEFAULT_USERNAME = "admin";
/** a password longer than this is refused before it is hashed (scrypt input bound) */
export const FIRST_ADMIN_PASSWORD_MAX = 1024;

/**
 * Exit codes, shared with scripts/install.sh (which branches on them):
 *  0 created · 1 refused by another rule (seat gate) · 2 setup problem ·
 *  3 skipped, an active admin already exists · 4 the password policy refused
 *  the password · 5 the username or email is invalid or already taken.
 */
export type FirstAdminExitCode = 0 | 1 | 2 | 3 | 4 | 5;

export interface FirstAdminInput {
  username: string;
  email: string;
  password: string;
}

export interface FirstAdminResult {
  ok: boolean;
  exitCode: FirstAdminExitCode;
  outcome: "created" | "admin_exists" | "password_refused" | "identity_refused" | "refused";
  /** never contains the password */
  lines: string[];
  userId?: string;
  username?: string;
}

/** `--status`: is the step still needed? (3 = an active admin exists) */
export async function firstAdminStatus(db: Db): Promise<{ exitCode: 0 | 3; line: string }> {
  return (await realAdminExists(db))
    ? { exitCode: 3, line: "first admin: an active admin already exists — nothing to do" }
    : { exitCode: 0, line: "first admin: none yet" };
}

const ADMIN_EXISTS: FirstAdminResult = {
  ok: true,
  exitCode: 3,
  outcome: "admin_exists",
  lines: ["first admin: an active admin already exists — skipped, nothing was changed"],
};

export async function createFirstAdmin(db: Db, input: FirstAdminInput): Promise<FirstAdminResult> {
  // ---- re-run: an admin exists, nothing to do (no password needed) ---------
  if (await realAdminExists(db)) return ADMIN_EXISTS;

  // ---- identity: the same validators as the HTTP routes --------------------
  const uname = usernameSchema.safeParse(input.username);
  if (!uname.success) {
    return identityRefused(`username refused: ${uname.error.issues[0]?.message ?? "invalid"}`);
  }
  const username = uname.data;
  const shape = createUserSchema.safeParse({ email: input.email.trim(), displayName: username, isAdmin: true });
  if (!shape.success) return identityRefused("email refused: not a valid email address");
  const email = shape.data.email;

  if (input.password.length > FIRST_ADMIN_PASSWORD_MAX) {
    return passwordRefused(`password must be at most ${FIRST_ADMIN_PASSWORD_MAX} characters`);
  }

  // ---- the seat gate POST /v1/users applies (audited on refusal) ------------
  const seat = await refuseIfSeatCapReached(db, { actorUserId: null, email });
  if (seat) {
    return {
      ok: false,
      exitCode: 1,
      outcome: "refused",
      lines: [`first admin refused: ${String(seat.body.detail ?? seat.body.error)}. Nothing was changed.`],
    };
  }

  // ---- one transaction under the sign-in invariant lock ---------------------
  return withSignInInvariant(db, async (tx, org): Promise<FirstAdminResult> => {
    // re-checked under the lock: a concurrent run (or the manual bootstrap
    // path) may have created an admin since the first look
    if (await realAdminExists(tx)) return ADMIN_EXISTS;
    // the org's own policy, read under the lock, before anything is written
    const weak = checkPasswordPolicy(input.password, org.passwordMinLength, org.passwordRequireClasses);
    if (weak) return passwordRefused(weak);

    const clash = await tx
      .select({ username: users.username, email: users.email })
      .from(users)
      .where(sql`${users.username} = ${username} OR lower(${users.email}) = lower(${email})`)
      .limit(1);
    if (clash[0]) {
      return identityRefused(
        clash[0].username === username
          ? `username '${username}' already belongs to another account`
          : `email '${email}' already belongs to another account`,
      );
    }

    const now = new Date();
    const [row] = await tx
      .insert(users)
      .values({
        email,
        displayName: username,
        username,
        isAdmin: true,
        passwordHash: hashPassword(input.password),
        passwordUpdatedAt: now,
        // the operator chose it: not a one-time password (ADR-0194 §3)
        mustChangePassword: false,
      })
      .returning({ id: users.id });
    const userId = row!.id;

    await tx.insert(auditLog).values({
      userId: NIL_UUID,
      objectType: "user",
      objectId: userId,
      detail: { phase: "first-admin", email, username, isAdmin: true, mustChangePassword: false, via: "installer" },
      effect: "allow",
      ruleId: "first-admin-created",
      ruleChain: [],
      reason:
        `the installer created the first admin '${username}' (${email}) with a password the operator chose ` +
        `(ADR-0194); TOTP enrolment is required at first sign-in (ADR-0181)`,
    });
    await auditAuth(tx, null, userId, "username-set", "allow",
      `installer set the username '${username}' on '${email}'`,
      { phase: "username", email, from: null, to: username, via: "installer" });
    await auditAuth(tx, null, userId, "initial-password-set", "allow",
      `installer set the operator-chosen password for '${email}' (not a one-time password; ADR-0194)`,
      { phase: "set-initial-password", email, forced: false, mustChangePassword: false, via: "installer" });

    return {
      ok: true,
      exitCode: 0,
      outcome: "created",
      userId,
      username,
      lines: [
        `first admin created: '${username}' (${email}) — password set (not printed), not must-change`,
        "  the first browser sign-in enrols an authenticator app (MFA is required for admins)",
      ],
    };
  });
}

function identityRefused(why: string): FirstAdminResult {
  return { ok: false, exitCode: 5, outcome: "identity_refused", lines: [`first admin refused: ${why}. Nothing was changed.`] };
}

function passwordRefused(why: string): FirstAdminResult {
  return {
    ok: false,
    exitCode: 4,
    outcome: "password_refused",
    lines: [`first admin refused: ${why} (org password policy). Nothing was changed.`],
  };
}
