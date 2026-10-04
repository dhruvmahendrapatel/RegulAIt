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
 */
import { and, eq, inArray, isNotNull, isNull, ne, orgSettings, ORG_SETTINGS_ID, sql, users, type Db, type OrgSettingsRow } from "@regulait/db";
import { countEnabledSsoProviders } from "./sso-providers.js";

/** break-glass admins who could sign in right now, optionally ignoring one
 * user who is about to be demoted or deactivated */
export async function usableBreakGlassAdmins(
  db: Db,
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
  db: Db,
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

/** drop a user from the break-glass list (on demotion); true when they were on it */
export async function dropBreakGlassUser(db: Db, userId: string): Promise<boolean> {
  const updated = await db
    .update(orgSettings)
    .set({ breakGlassUserIds: sql`${orgSettings.breakGlassUserIds} - ${userId}::text` })
    .where(and(eq(orgSettings.id, ORG_SETTINGS_ID), sql`${orgSettings.breakGlassUserIds} @> jsonb_build_array(${userId}::text)`))
    .returning({ id: orgSettings.id });
  return updated.length > 0;
}
