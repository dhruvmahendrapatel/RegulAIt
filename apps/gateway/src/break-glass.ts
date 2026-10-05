/**
 * ADR-0174 — the break-glass "somebody can still sign in" invariant, in ONE
 * place (security review, finding 5).
 *
 * While `org_settings.local_sign_in = 'break_glass_only'`, the organisation
 * gets in through two doors, and the settings writer refuses to engage the mode
 * unless both exist:
 *   - the front door: at least one ENABLED SSO provider (OIDC + SAML counted
 *     together, `countEnabledSsoProviders`), and
 *   - the spare key: at least one USABLE break-glass admin — listed in
 *     `break_glass_user_ids`, still an admin, active, and holding a password.
 *
 * The same two conditions are re-checked on every change that could break one
 * of them afterwards: demoting or deactivating a user (admin API and SCIM), and
 * disabling or deleting an SSO provider (OIDC and SAML). A refusal is a named
 * 409 — `break_glass_last_admin` or `break_glass_last_sso_provider`. Users are
 * never hard-deleted (ADR-0022: deactivate, never delete) and no route clears
 * a password (an admin reset issues a one-time password, which still signs
 * in), so demote and deactivate are the user-side events.
 *
 * Separately, a demoted user's id is dropped from `break_glass_user_ids` in
 * the same request, so the list never names somebody who is no longer an admin
 * (a deactivated admin keeps their place: reactivation restores them).
 *
 * ── CONCURRENCY (AER-056) ───────────────────────────────────────────────────
 * A count is only a promise about the rows it read. Two administrative writes
 * that each check "somebody would remain" and then commit separately can both
 * pass — two admins demoting the two break-glass admins, an OIDC and a SAML
 * provider disabled at once, SCIM deactivating one spare key while the admin
 * API demotes the other, the mode engaged while the last provider is removed —
 * and leave nobody. So every writer that can REDUCE either door, and the
 * writer that engages or re-points the mode, runs its re-read, its check, its
 * mutation and its audit row inside ONE transaction that first takes
 * `pg_advisory_xact_lock(SIGN_IN_INVARIANT_LOCK_KEY)` (`withSignInInvariant`).
 * The second writer waits on the lock, and under READ COMMITTED each of its
 * later statements reads a fresh snapshot taken after the first committed, so
 * it counts what really remains and gets the named refusal. The lock is
 * released at COMMIT or ROLLBACK, so a failed write (an audit insert that
 * throws) leaves neither a half-applied change nor a held lock. The ADR-0036
 * `sso_only` guard and the ADR-0022 "last active admin" guard share the lock:
 * they are the same kind of count over the same rows.
 */
import { and, eq, inArray, isNotNull, isNull, ne, orgSettings, ORG_SETTINGS_ID, sql, users, type Db, type OrgSettingsRow } from "@regulait/db";
import { countEnabledSsoProviders, SSO_ONLY_LAST_PROVIDER } from "./sso-providers.js";

/** a transaction on the gateway's handle (it inherits the audit-chain wrapper) */
export type SignInTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The advisory-lock key every sign-in-invariant writer serializes on. One
 * global key, because the invariant is one global question ("can somebody
 * still sign in?") over org_settings, users, oidc_providers and
 * saml_providers. Arbitrary but fixed — `174` is the ADR — and distinct from
 * `AUDIT_CHAIN_LOCK_KEY` (6_000_000_060) and `HEALTH_PROBE_CLAIM_LOCK_KEY`
 * (6_000_000_037). Lock order: this one FIRST; the audit-chain lock (taken by
 * the audit insert at the end) after it — never the other way round.
 */
export const SIGN_IN_INVARIANT_LOCK_KEY = 6_000_000_174;

/** which writer reached the checked-but-not-yet-written point */
export type SignInInvariantSite =
  | "oidc-provider-disable"
  | "oidc-provider-delete"
  | "saml-provider-disable"
  | "saml-provider-delete"
  | "user-deactivate"
  | "user-demote"
  | "scim-deactivate"
  | "org-settings";

/**
 * AER-056 — TEST-ONLY seams. Production never sets them. `checked` parks a
 * writer after its invariant check and before its first write (where a race
 * would bite), so a test can hold two writers there with a barrier;
 * `written` runs after the mutation and before the audit row, so a test can
 * inject a failure and prove that mutation and audit commit or roll back
 * together.
 */
export const signInInvariantTestHooks: {
  checked?: (site: SignInInvariantSite) => Promise<void>;
  written?: (site: SignInInvariantSite) => Promise<void>;
} = {};

/** called by each writer between its check and its first write */
export async function signInInvariantChecked(site: SignInInvariantSite): Promise<void> {
  if (signInInvariantTestHooks.checked) await signInInvariantTestHooks.checked(site);
}
/** called by each writer between its mutation and its audit row */
export async function signInInvariantWritten(site: SignInInvariantSite): Promise<void> {
  if (signInInvariantTestHooks.written) await signInInvariantTestHooks.written(site);
}

/**
 * Run `body` in a transaction that holds the sign-in invariant lock, with the
 * org_settings singleton RE-READ after the lock was granted (so a mode or list
 * change committed by the previous holder is what `body` sees). Everything
 * `body` reads, checks, writes and audits through `tx` is one atomic unit.
 */
export async function withSignInInvariant<T>(
  db: Db,
  body: (tx: SignInTx, org: OrgSettingsRow) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SIGN_IN_INVARIANT_LOCK_KEY})`);
    let [org] = await tx.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    if (!org) {
      await tx.insert(orgSettings).values({ id: ORG_SETTINGS_ID }).onConflictDoNothing();
      [org] = await tx.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    }
    if (!org) throw new Error("org_settings singleton missing");
    return body(tx, org);
  });
}

/** break-glass admins who could sign in right now, optionally ignoring one
 * user who is about to be demoted or deactivated */
export async function usableBreakGlassAdmins(
  db: Pick<Db, "select">,
  ids: readonly string[] | null,
  exceptUserId?: string,
): Promise<number> {
  const list = (ids ?? []).filter((id) => id !== exceptUserId);
  if (list.length === 0) return 0;
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        inArray(users.id, list),
        eq(users.isAdmin, true),
        isNull(users.disabledAt),
        isNotNull(users.passwordHash),
        ...(exceptUserId ? [ne(users.id, exceptUserId)] : []),
      ),
    );
  return rows.length;
}

export const BREAK_GLASS_LAST_ADMIN = {
  error: "break_glass_last_admin",
  detail:
    "email sign-in is break-glass only and this is the last usable break-glass administrator — name another break-glass admin (active, admin, with a password) or turn break-glass mode off first",
} as const;
export const BREAK_GLASS_LAST_SSO_PROVIDER = {
  error: "break_glass_last_sso_provider",
  detail:
    "email sign-in is break-glass only and this is the last enabled SSO provider (OIDC + SAML counted together) — enable another provider or turn break-glass mode off first",
} as const;

export type BreakGlassChange =
  | { kind: "user"; userId: string }
  | { kind: "oidc_provider"; providerId: string }
  | { kind: "saml_provider"; providerId: string };

/** null = the change keeps somebody able to sign in; otherwise the 409 body */
export async function breakGlassLockoutRefusal(
  db: Pick<Db, "select">,
  org: OrgSettingsRow,
  change: BreakGlassChange,
): Promise<typeof BREAK_GLASS_LAST_ADMIN | typeof BREAK_GLASS_LAST_SSO_PROVIDER | null> {
  if (org.localSignIn !== "break_glass_only") return null;
  if (change.kind === "user") {
    if (!(org.breakGlassUserIds ?? []).includes(change.userId)) return null;
    const remaining = await usableBreakGlassAdmins(db, org.breakGlassUserIds, change.userId);
    return remaining === 0 ? BREAK_GLASS_LAST_ADMIN : null;
  }
  const remaining = await countEnabledSsoProviders(
    db,
    change.kind === "oidc_provider" ? { oidcId: change.providerId } : { samlId: change.providerId },
  );
  return remaining.total === 0 ? BREAK_GLASS_LAST_SSO_PROVIDER : null;
}

/**
 * Both refusals a provider disable/delete can meet, in the order the routes
 * have always answered them: ADR-0036 `sso_only` (the last enabled provider
 * while password login is off), then ADR-0174 break-glass. Call it inside
 * `withSignInInvariant`, with the org row and transaction it hands you, and
 * only for a provider that is enabled as re-read under the lock.
 */
export async function providerRemovalRefusal(
  tx: Pick<Db, "select">,
  org: OrgSettingsRow,
  change: Extract<BreakGlassChange, { kind: "oidc_provider" | "saml_provider" }>,
): Promise<typeof SSO_ONLY_LAST_PROVIDER | typeof BREAK_GLASS_LAST_SSO_PROVIDER | null> {
  if (org.ssoOnly) {
    const remaining = await countEnabledSsoProviders(
      tx,
      change.kind === "oidc_provider" ? { oidcId: change.providerId } : { samlId: change.providerId },
    );
    if (remaining.total === 0) return SSO_ONLY_LAST_PROVIDER;
  }
  return breakGlassLockoutRefusal(tx, org, change);
}

/** drop a user from the break-glass list (on demotion); true when they were on it */
export async function dropBreakGlassUser(db: Pick<Db, "update">, userId: string): Promise<boolean> {
  const updated = await db
    .update(orgSettings)
    .set({ breakGlassUserIds: sql`${orgSettings.breakGlassUserIds} - ${userId}::text` })
    .where(and(eq(orgSettings.id, ORG_SETTINGS_ID), sql`${orgSettings.breakGlassUserIds} @> jsonb_build_array(${userId}::text)`))
    .returning({ id: orgSettings.id });
  return updated.length > 0;
}
