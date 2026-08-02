/**
 * ADR-0036 — the ONE place that answers "how many federated login doors are
 * open right now?".
 *
 * ADR-0025 shipped a lockout guard: `org_settings.sso_only` turns password
 * login off, so engaging it with zero enabled OIDC providers — or disabling
 * the last one while it is engaged — would strand every human behind a door
 * that does not exist. ADR-0036 adds SAML as a CO-EQUAL second path, which
 * makes counting only OIDC wrong in both directions:
 *   - a SAML-only org would be refused `sso_only` although its people can
 *     perfectly well sign in, and
 *   - an admin could disable the last SAML provider (or the last OIDC one)
 *     while believing the other family was keeping the lights on.
 *
 * So the count is generalized here, in a module of its own, and consulted by
 * every surface that can change the answer: the OIDC provider PATCH/DELETE,
 * the SAML provider PATCH/DELETE, and the org-settings writer. A second copy
 * of this rule anywhere is a lockout waiting to happen — and it lives outside
 * auth.ts so org-settings.ts can use it without an import cycle.
 */
import { and, eq, ne, oidcProviders, samlProviders, type Db } from "@regulait/db";

export interface EnabledSsoCount {
  oidc: number;
  saml: number;
  total: number;
}

/**
 * Enabled providers across BOTH families. `exclude` names the row that is
 * about to be disabled or deleted, so the answer is "what would remain AFTER
 * this change" rather than "what exists now".
 */
export async function countEnabledSsoProviders(
  db: Db,
  exclude: { oidcId?: string; samlId?: string } = {},
): Promise<EnabledSsoCount> {
  const oidcRows = await db
    .select({ id: oidcProviders.id })
    .from(oidcProviders)
    .where(
      exclude.oidcId
        ? and(eq(oidcProviders.enabled, true), ne(oidcProviders.id, exclude.oidcId))
        : eq(oidcProviders.enabled, true),
    );
  const samlRows = await db
    .select({ id: samlProviders.id })
    .from(samlProviders)
    .where(
      exclude.samlId
        ? and(eq(samlProviders.enabled, true), ne(samlProviders.id, exclude.samlId))
        : eq(samlProviders.enabled, true),
    );
  return { oidc: oidcRows.length, saml: samlRows.length, total: oidcRows.length + samlRows.length };
}

/** the ONE wording both provider families answer with when the guard bites */
export const SSO_ONLY_LAST_PROVIDER = {
  error: "sso_only_needs_a_provider",
  detail:
    "sso_only is on and this is the last enabled SSO provider (OIDC + SAML are counted together) — turn sso_only off first",
};
