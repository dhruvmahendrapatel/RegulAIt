/**
 * ADR-0174 — federated identity: which account a federated login belongs to,
 * whether the identity provider asserted multi-factor authentication, and the
 * account-linking rule that keeps a federated identity from silently taking
 * over a local account.
 *
 * Shared by the OIDC callback (auth.ts) and the SAML ACS (saml.ts), so both
 * federated paths answer to ONE linking rule.
 *
 * THE LINKING RULE (ADR-0174 §5). A federated login resolves, in order:
 *
 *  1. a `federated_identities` row for (provider, subject) — the IdP's stable
 *     subject is the anchor once a link exists;
 *  2. otherwise the existing account with the asserted VERIFIED email
 *     (case-insensitive; never the username — ADR-0025/0030):
 *       - an account with NO local credential (no password, no TOTP) was
 *         created by an admin or by SCIM for exactly this person, so the
 *         verified email links it (`preprovisioned`) — the behaviour every
 *         pre-0174 SSO deployment relies on, unchanged;
 *       - an account WITH a local credential links only after the person
 *         proves it (password, plus TOTP when enrolled) in the same browser,
 *         or an admin approves a link request. Never silently: an IdP that
 *         asserts somebody's email address is not, on that basis alone,
 *         allowed to become them;
 *  3. otherwise no account: the caller applies its provider's JIT policy
 *     (default-deny), unchanged, and records the new link as `jit`.
 */
import { randomBytes } from "node:crypto";
import {
  and,
  asc,
  eq,
  federatedIdentities,
  federatedLinkRequests,
  sql,
  users,
  type Db,
  type FederatedLinkVia,
  type OrgSettingsRow,
} from "@regulait/db";
import { hashToken } from "./token-hash.js";

export type UserRow = typeof users.$inferSelect;

export interface ProviderRef {
  kind: "oidc" | "saml";
  id: string;
  name: string;
}

/** RFC 8176 authentication-method references that mean "more than one factor"
 * (mfa), or a factor that is itself a second factor / possession proof. */
export const MFA_AMR_VALUES: ReadonlySet<string> = new Set(["mfa", "otp", "hwk", "swk", "pop"]);

export interface MfaAssertion {
  asserted: boolean;
  amr: string[];
  acr: string | null;
  /** which claim satisfied it, for the audit row */
  via: "amr" | "acr" | null;
}

/** does this ID token assert MFA? `amr` per RFC 8176, or an `acr` value the
 * admin configured for the provider as meaning multi-factor. */
export function idTokenMfa(claims: Record<string, unknown>, mfaAcrValues: readonly string[] | null): MfaAssertion {
  const amr = Array.isArray(claims.amr) ? claims.amr.filter((x): x is string => typeof x === "string") : [];
  const acr = typeof claims.acr === "string" ? claims.acr : null;
  if (amr.some((m) => MFA_AMR_VALUES.has(m))) return { asserted: true, amr, acr, via: "amr" };
  if (acr !== null && (mfaAcrValues ?? []).includes(acr)) return { asserted: true, amr, acr, via: "acr" };
  return { asserted: false, amr, acr, via: null };
}

/** the org MFA requirement, as it applies to one person (ADR-0025 dial) */
export function orgRequiresMfa(org: OrgSettingsRow, isAdmin: boolean): boolean {
  return org.mfaRequired === "all" || (org.mfaRequired === "admins" && isAdmin);
}

/** a local credential = something the person could prove the account with */
export function hasLocalCredential(user: UserRow): boolean {
  return Boolean(user.passwordHash) || user.totpEnabled;
}

const providerColumns = (ref: ProviderRef) => ({
  oidcProviderId: ref.kind === "oidc" ? ref.id : null,
  samlProviderId: ref.kind === "saml" ? ref.id : null,
});
const providerPredicate = (ref: ProviderRef, table: typeof federatedIdentities | typeof federatedLinkRequests) =>
  ref.kind === "oidc" ? eq(table.oidcProviderId, ref.id) : eq(table.samlProviderId, ref.id);

export interface FederatedMatch {
  user: UserRow | null;
  /** the (provider, subject) is already linked to `user` */
  linked: boolean;
}

/** READ-ONLY: which account would this login reach? Nothing is written, so a
 * refusal decided on the answer (disabled account, MFA not asserted) leaves no
 * trace but its audit row. */
export async function matchFederatedAccount(
  db: Db,
  ref: ProviderRef,
  subject: string,
  email: string,
): Promise<FederatedMatch> {
  const [linked] = await db
    .select({ user: users })
    .from(federatedIdentities)
    .innerJoin(users, eq(users.id, federatedIdentities.userId))
    .where(and(providerPredicate(ref, federatedIdentities), eq(federatedIdentities.subject, subject)))
    .limit(1);
  if (linked) return { user: linked.user, linked: true };
  // ADR-0107/0109: case-folded, oldest account wins (see loadUserByEmail)
  const [byEmail] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(1);
  return { user: byEmail ?? null, linked: false };
}

/** record a link (idempotent on (provider, subject)) */
export async function recordFederatedLink(
  db: Db,
  ref: ProviderRef,
  subject: string,
  userId: string,
  via: FederatedLinkVia,
): Promise<boolean> {
  const inserted = await db
    .insert(federatedIdentities)
    .values({ userId, ...providerColumns(ref), subject, linkedVia: via, lastLoginAt: new Date() })
    .onConflictDoNothing()
    .returning({ id: federatedIdentities.id });
  return inserted.length > 0;
}

export async function touchFederatedLink(db: Db, ref: ProviderRef, subject: string): Promise<void> {
  await db
    .update(federatedIdentities)
    .set({ lastLoginAt: new Date() })
    .where(and(providerPredicate(ref, federatedIdentities), eq(federatedIdentities.subject, subject)));
}

export const LINK_COOKIE = "regulait_link";
export const LINK_PROOF_MINUTES = 15;
export const LINK_ADMIN_WINDOW_DAYS = 7;

/**
 * Raise (or refresh) the link request for a federated identity that matched an
 * account holding a local credential. Returns the browser-bound proof token —
 * set as an HttpOnly cookie by the caller, stored here only as a hash.
 */
export async function raiseLinkRequest(
  db: Db,
  ref: ProviderRef,
  subject: string,
  email: string,
  userId: string,
  idpMfa: boolean,
): Promise<{ requestId: string; proofToken: string; refreshed: boolean }> {
  const proofToken = randomBytes(32).toString("base64url");
  const now = Date.now();
  const values = {
    email,
    idpMfa,
    proofTokenHash: hashToken(proofToken),
    proofExpiresAt: new Date(now + LINK_PROOF_MINUTES * 60_000),
    expiresAt: new Date(now + LINK_ADMIN_WINDOW_DAYS * 86_400_000),
  };
  const [existing] = await db
    .select({ id: federatedLinkRequests.id })
    .from(federatedLinkRequests)
    .where(
      and(
        providerPredicate(ref, federatedLinkRequests),
        eq(federatedLinkRequests.subject, subject),
        eq(federatedLinkRequests.userId, userId),
        eq(federatedLinkRequests.status, "pending"),
      ),
    )
    .limit(1);
  if (existing) {
    await db.update(federatedLinkRequests).set(values).where(eq(federatedLinkRequests.id, existing.id));
    return { requestId: existing.id, proofToken, refreshed: true };
  }
  const [row] = await db
    .insert(federatedLinkRequests)
    .values({ userId, ...providerColumns(ref), subject, status: "pending", ...values })
    .returning({ id: federatedLinkRequests.id });
  return { requestId: row!.id, proofToken, refreshed: false };
}

/** the pending request a presented proof cookie names, still inside its window */
export async function loadPendingProof(db: Db, proofToken: string | null) {
  if (!proofToken) return null;
  const [row] = await db
    .select()
    .from(federatedLinkRequests)
    .where(
      and(
        eq(federatedLinkRequests.proofTokenHash, hashToken(proofToken)),
        eq(federatedLinkRequests.status, "pending"),
        sql`${federatedLinkRequests.proofExpiresAt} > now()`,
      ),
    )
    .limit(1);
  return row ?? null;
}

export function providerRefOf(row: { oidcProviderId: string | null; samlProviderId: string | null }, name: string): ProviderRef {
  return row.oidcProviderId
    ? { kind: "oidc", id: row.oidcProviderId, name }
    : { kind: "saml", id: row.samlProviderId!, name };
}

/** is this subject already linked to SOME account? (an admin approval must not
 * re-point an identity that belongs to somebody else) */
export async function subjectLinkedUser(db: Db, ref: ProviderRef, subject: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: federatedIdentities.userId })
    .from(federatedIdentities)
    .where(and(providerPredicate(ref, federatedIdentities), eq(federatedIdentities.subject, subject)))
    .limit(1);
  return row?.userId ?? null;
}

