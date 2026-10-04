/**
 * ADR-0174 — federated identity: which account a federated login belongs to,
 * whether the identity provider asserted multi-factor authentication, and the
 * account-linking rule that keeps a federated identity from silently taking
 * over an account.
 *
 * Shared by the OIDC callback (auth.ts) and the SAML ACS (saml.ts), so both
 * federated paths answer to ONE linking rule.
 *
 * THE LINKING RULE (ADR-0174 §5, as amended by the security review). A
 * federated login resolves, in order:
 *
 *  1. a `federated_identities` row for (provider, issuer, subject format,
 *     subject) — the IdP's stable subject under its own issuer is the anchor
 *     once a link exists. A SAML transient NameID is never an anchor (it
 *     changes every login): such an assertion is anchored on its verified email
 *     under the pinned entity id (`email-anchor`), and that anchor only exists
 *     after one of the linking paths below created it;
 *  2. otherwise the existing account with the asserted VERIFIED email, compared
 *     NFKC-normalised and case-folded on BOTH sides, ASCII only (a non-ASCII
 *     address never links — see normalizeClaimEmail):
 *       - an account that has NEVER signed in, has NO federated identity and
 *         NO local credential was pre-provisioned (admin or SCIM) for exactly
 *         this person, so the verified email links it (`preprovisioned`);
 *       - an account that signed in through THIS provider row before migration
 *         0139 (its pre-0139 `login-succeeded` audit row names this provider and
 *         the same verified email, and it has no link to this provider yet) is
 *         linked as it signs in again (`prior_sso`) — existing SSO users keep
 *         signing in through the provider they already use;
 *       - ANY other account — one already federated (to a different provider,
 *         or to this one under another subject) or one that has ever signed in
 *         — links only after the person proves it (password, plus TOTP when
 *         enrolled) in the same browser, or an admin approves a link request.
 *         An IdP that asserts somebody's email address is not, on that basis
 *         alone, allowed to become them;
 *  3. otherwise no account: the caller applies its provider's JIT policy
 *     (default-deny), unchanged, and records the new link as `jit`.
 */
import { randomBytes } from "node:crypto";
import {
  and,
  asc,
  auditLog,
  authSessions,
  desc,
  eq,
  federatedIdentities,
  federatedLinkRequests,
  oidcProviders,
  samlProviders,
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

/** WHO the identity provider says this is: the provider row, the issuer it
 * spoke as (OIDC `iss` / SAML entity id), and the subject under it. */
export interface FederatedAnchor {
  ref: ProviderRef;
  issuer: string;
  /** SAML NameID Format, `email-anchor`, or '' for OIDC */
  subjectFormat: string;
  subject: string;
}

export const SAML_TRANSIENT_NAMEID = "urn:oasis:names:tc:SAML:2.0:nameid-format:transient";
/** the subject format of an anchor made from the verified email because the
 * IdP sent no stable NameID (transient, or none at all) */
export const EMAIL_ANCHOR_FORMAT = "email-anchor";

// ---------------------------------------------------------------------------
// email normalisation (security review, finding 7)
// ---------------------------------------------------------------------------

/**
 * One normalisation for every federated email: NFKC, trimmed, lower-cased.
 * `linkable` is false unless the address the IdP SENT is plain printable
 * ASCII. Case- and compatibility-folding outside ASCII is where look-alikes
 * live: U+212A KELVIN SIGN lower-cases to an ASCII `k` in both JavaScript and
 * Postgres, and NFKC folds full-width letters onto ASCII — so a mailbox the IdP
 * verified as `Kate@x` would otherwise reach the account `kate@x`. A
 * non-ASCII address is never compared against an account (nor JIT-provisioned);
 * stored addresses are held to the same rule on the database side
 * (`ASCII_EMAIL`), so both sides compare the same normalised ASCII value.
 */
export function normalizeClaimEmail(raw: unknown): { email: string; linkable: boolean } | null {
  if (typeof raw !== "string") return null;
  const sent = raw.trim();
  const email = sent.normalize("NFKC").toLowerCase();
  if (email.length === 0 || !email.includes("@")) return null;
  return { email, linkable: /^[\x21-\x7e]+$/.test(sent) };
}

/** the database half of the same rule: only an all-ASCII stored address is a
 * candidate, so `lower()` there means exactly what `toLowerCase()` means here */
const ASCII_EMAIL = sql`${users.email} ~ '^[!-~]+$'`;

/** a SAML assertion's anchor: its NameID when that is stable, else its
 * verified email (never a transient NameID — finding 6) */
export function samlAnchor(
  ref: ProviderRef,
  entityId: string,
  nameID: unknown,
  nameIDFormat: unknown,
  email: string,
): FederatedAnchor {
  const format = typeof nameIDFormat === "string" ? nameIDFormat : "";
  if (typeof nameID === "string" && nameID.length > 0 && format !== SAML_TRANSIENT_NAMEID) {
    return { ref, issuer: entityId, subjectFormat: format, subject: nameID };
  }
  return { ref, issuer: entityId, subjectFormat: EMAIL_ANCHOR_FORMAT, subject: email };
}

// ---------------------------------------------------------------------------
// MFA assertions
// ---------------------------------------------------------------------------

/** RFC 8176 authentication-method references, by factor class (finding 4).
 * `mfa` on its own means the IdP vouches for more than one factor. */
const AMR_CLASS: Readonly<Record<string, "know" | "have" | "are">> = {
  pwd: "know",
  pin: "know",
  kba: "know",
  otp: "have",
  hwk: "have",
  swk: "have",
  sms: "have",
  tel: "have",
  sc: "have",
  pop: "have",
  fpt: "are",
  face: "are",
  iris: "are",
  retina: "are",
  vbm: "are",
};
/** the single possession factors a broker that ENFORCES a second factor may
 * report on their own (`oidc_providers.broker_enforces_mfa`) */
const BROKER_SINGLE_FACTORS: ReadonlySet<string> = new Set(["otp", "hwk", "swk"]);

export interface MfaAssertion {
  asserted: boolean;
  amr: string[];
  acr: string | null;
  /** which claim satisfied it, for the audit row */
  via: "amr" | "acr" | "broker" | null;
}

/** does this ID token assert MFA? `amr` says `mfa`, or names at least two
 * distinct factor classes (know / have / are); or a single otp/hwk/swk from a
 * provider flagged as an MFA-enforcing broker; or an `acr` value the admin
 * configured for the provider as meaning multi-factor. One weak method alone
 * (`["otp"]`, `["pwd"]`, `["pwd","pin"]`) is NOT multi-factor. */
export function idTokenMfa(
  claims: Record<string, unknown>,
  mfaAcrValues: readonly string[] | null,
  brokerEnforcesMfa = false,
): MfaAssertion {
  const amr = Array.isArray(claims.amr) ? claims.amr.filter((x): x is string => typeof x === "string") : [];
  const acr = typeof claims.acr === "string" ? claims.acr : null;
  const classes = new Set(amr.map((m) => AMR_CLASS[m]).filter((c) => c !== undefined));
  if (amr.includes("mfa") || classes.size >= 2) return { asserted: true, amr, acr, via: "amr" };
  if (brokerEnforcesMfa && amr.some((m) => BROKER_SINGLE_FACTORS.has(m))) {
    return { asserted: true, amr, acr, via: "broker" };
  }
  if (acr !== null && (mfaAcrValues ?? []).includes(acr)) return { asserted: true, amr, acr, via: "acr" };
  return { asserted: false, amr, acr, via: null };
}

/** the SAML twin: did the VERIFIED assertion's AuthnContextClassRef name a
 * context the admin configured as multi-factor for this IdP? (finding 1) */
export function samlAuthnContextMfa(
  contexts: readonly string[],
  mfaAuthnContexts: readonly string[] | null,
): { asserted: boolean; contexts: string[] } {
  const configured = mfaAuthnContexts ?? [];
  return { asserted: contexts.some((c) => configured.includes(c)), contexts: [...contexts] };
}

/** the org MFA requirement, as it applies to one person (ADR-0025 dial) */
export function orgRequiresMfa(org: OrgSettingsRow, isAdmin: boolean): boolean {
  return org.mfaRequired === "all" || (org.mfaRequired === "admins" && isAdmin);
}

/** a local credential = something the person could prove the account with */
export function hasLocalCredential(user: UserRow): boolean {
  return Boolean(user.passwordHash) || user.totpEnabled;
}

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

const providerColumns = (ref: ProviderRef) => ({
  oidcProviderId: ref.kind === "oidc" ? ref.id : null,
  samlProviderId: ref.kind === "saml" ? ref.id : null,
});
const providerPredicate = (ref: ProviderRef, table: typeof federatedIdentities | typeof federatedLinkRequests) =>
  ref.kind === "oidc" ? eq(table.oidcProviderId, ref.id) : eq(table.samlProviderId, ref.id);
const anchorPredicate = (a: FederatedAnchor) =>
  and(
    providerPredicate(a.ref, federatedIdentities),
    eq(federatedIdentities.issuer, a.issuer),
    eq(federatedIdentities.subjectFormat, a.subjectFormat),
    eq(federatedIdentities.subject, a.subject),
  );

export type FederatedResolution =
  /** the anchor is already linked to this account */
  | { kind: "linked"; user: UserRow }
  /** link now, without proof: a never-used pre-provisioned account, or a
   * pre-0139 SSO user signing in again through the same provider */
  | { kind: "link"; user: UserRow; via: Extract<FederatedLinkVia, "preprovisioned" | "prior_sso"> }
  /** the email matched an account in use: proof or admin approval first */
  | { kind: "proof"; user: UserRow; why: "already_federated" | "signed_in_before" | "local_credential" }
  /** no account: the provider's JIT policy applies */
  | { kind: "none" }
  /** the asserted email is not ASCII and matched no link: never compared */
  | { kind: "not_linkable" };

/** has this account EVER signed in? A session row (never deleted — revocation
 * only stamps it) or a `login-succeeded` audit row by the account. */
export async function hasSignedInBefore(db: Db, userId: string): Promise<boolean> {
  const [s] = await db.select({ id: authSessions.id }).from(authSessions).where(eq(authSessions.userId, userId)).limit(1);
  if (s) return true;
  const [a] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.userId, userId), eq(auditLog.ruleId, "login-succeeded")))
    .limit(1);
  return Boolean(a);
}

/**
 * The backfill evidence for a pre-0139 SSO user (finding 2). Before migration
 * 0139 there was no federated_identities table and auth_sessions records only
 * the ORIGIN (`oidc`/`saml`), never the provider — so the one record of WHICH
 * provider row signed the person in is the `login-succeeded` audit row every
 * federated login wrote:
 *
 *   actor = the user, rule_id = 'login-succeeded', detail.method = 'oidc' |
 *   'saml', detail.provider = the provider's NAME, detail.email = the verified
 *   email it asserted.
 *
 * It counts as evidence for provider row P only when the name is P's, the row
 * is no older than P itself (a deleted provider's name reused by a new row is
 * not the same provider), the email equals the one asserted now, and the row
 * has NO `providerId` key — every federated `login-succeeded` row written from
 * 0139 on carries `providerId`, so only pre-0139 history qualifies, and a
 * post-0139 login (which always records a link) can never be replayed as
 * backfill evidence. Bounded by the audit-retention floor: a person whose
 * every pre-0139 sign-in row was pruned proves the account or is approved.
 */
export async function priorSsoEvidence(db: Db, ref: ProviderRef, userId: string, email: string): Promise<Date | null> {
  const [provider] =
    ref.kind === "oidc"
      ? await db.select({ name: oidcProviders.name, createdAt: oidcProviders.createdAt }).from(oidcProviders).where(eq(oidcProviders.id, ref.id))
      : await db.select({ name: samlProviders.name, createdAt: samlProviders.createdAt }).from(samlProviders).where(eq(samlProviders.id, ref.id));
  if (!provider) return null;
  const [row] = await db
    .select({ at: auditLog.at })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.userId, userId),
        eq(auditLog.ruleId, "login-succeeded"),
        sql`${auditLog.detail}->>'method' = ${ref.kind}`,
        sql`${auditLog.detail}->>'provider' = ${provider.name}`,
        sql`(${auditLog.detail}->>'providerId') IS NULL`,
        sql`lower(${auditLog.detail}->>'email') = ${email}`,
        sql`${auditLog.at} >= ${provider.createdAt}`,
      ),
    )
    .orderBy(desc(auditLog.at))
    .limit(1);
  return row?.at ?? null;
}

/** READ-ONLY: which account would this login reach, and on what terms?
 * Nothing is written, so a refusal decided on the answer (disabled account,
 * MFA not asserted) leaves no trace but its audit row. */
export async function resolveFederatedLogin(
  db: Db,
  anchor: FederatedAnchor,
  email: { email: string; linkable: boolean },
): Promise<FederatedResolution> {
  const [linked] = await db
    .select({ user: users })
    .from(federatedIdentities)
    .innerJoin(users, eq(users.id, federatedIdentities.userId))
    .where(anchorPredicate(anchor))
    .limit(1);
  if (linked) return { kind: "linked", user: linked.user };
  if (!email.linkable) return { kind: "not_linkable" };
  // ADR-0107/0109: case-folded, oldest account wins (see loadUserByEmail)
  const [byEmail] = await db
    .select()
    .from(users)
    .where(and(sql`lower(${users.email}) = ${email.email}`, ASCII_EMAIL))
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(1);
  if (!byEmail) return { kind: "none" };
  const links = await db
    .select({ oidcProviderId: federatedIdentities.oidcProviderId, samlProviderId: federatedIdentities.samlProviderId })
    .from(federatedIdentities)
    .where(eq(federatedIdentities.userId, byEmail.id));
  const signedIn = await hasSignedInBefore(db, byEmail.id);
  if (links.length === 0 && !signedIn && !hasLocalCredential(byEmail)) {
    return { kind: "link", user: byEmail, via: "preprovisioned" };
  }
  const linkedToThisProvider = links.some((l) =>
    anchor.ref.kind === "oidc" ? l.oidcProviderId === anchor.ref.id : l.samlProviderId === anchor.ref.id,
  );
  if (!linkedToThisProvider && (await priorSsoEvidence(db, anchor.ref, byEmail.id, email.email))) {
    return { kind: "link", user: byEmail, via: "prior_sso" };
  }
  return {
    kind: "proof",
    user: byEmail,
    why: links.length > 0 ? "already_federated" : signedIn ? "signed_in_before" : "local_credential",
  };
}

/** record a link (idempotent on the anchor) */
export async function recordFederatedLink(
  db: Db,
  anchor: FederatedAnchor,
  userId: string,
  via: FederatedLinkVia,
): Promise<boolean> {
  const inserted = await db
    .insert(federatedIdentities)
    .values({
      userId,
      ...providerColumns(anchor.ref),
      issuer: anchor.issuer,
      subjectFormat: anchor.subjectFormat,
      subject: anchor.subject,
      linkedVia: via,
      lastLoginAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: federatedIdentities.id });
  return inserted.length > 0;
}

export async function touchFederatedLink(db: Db, anchor: FederatedAnchor): Promise<void> {
  await db.update(federatedIdentities).set({ lastLoginAt: new Date() }).where(anchorPredicate(anchor));
}

/** finding 6: a provider whose issuer (OIDC) or entity id (SAML) changed is a
 * different identity provider — every link and open link request made under
 * the old one goes. The caller audits the counts. */
export async function dropProviderLinks(db: Db, ref: ProviderRef): Promise<{ identities: number; requests: number }> {
  const identities = await db
    .delete(federatedIdentities)
    .where(providerPredicate(ref, federatedIdentities))
    .returning({ id: federatedIdentities.id });
  const requests = await db
    .delete(federatedLinkRequests)
    .where(and(providerPredicate(ref, federatedLinkRequests), eq(federatedLinkRequests.status, "pending")))
    .returning({ id: federatedLinkRequests.id });
  return { identities: identities.length, requests: requests.length };
}

export const LINK_COOKIE = "regulait_link";
export const LINK_PROOF_MINUTES = 15;
export const LINK_ADMIN_WINDOW_DAYS = 7;

/**
 * Raise (or refresh) the link request for a federated identity that matched an
 * account in use. Returns the browser-bound proof token — set as an HttpOnly
 * cookie by the caller, stored here only as a hash.
 */
export async function raiseLinkRequest(
  db: Db,
  anchor: FederatedAnchor,
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
        providerPredicate(anchor.ref, federatedLinkRequests),
        eq(federatedLinkRequests.issuer, anchor.issuer),
        eq(federatedLinkRequests.subjectFormat, anchor.subjectFormat),
        eq(federatedLinkRequests.subject, anchor.subject),
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
    .values({
      userId,
      ...providerColumns(anchor.ref),
      issuer: anchor.issuer,
      subjectFormat: anchor.subjectFormat,
      subject: anchor.subject,
      status: "pending",
      ...values,
    })
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

/** the anchor a link request was raised for */
export function anchorOfRequest(
  row: { oidcProviderId: string | null; samlProviderId: string | null; issuer: string; subjectFormat: string; subject: string },
  name: string,
): FederatedAnchor {
  const ref: ProviderRef = row.oidcProviderId
    ? { kind: "oidc", id: row.oidcProviderId, name }
    : { kind: "saml", id: row.samlProviderId!, name };
  return { ref, issuer: row.issuer, subjectFormat: row.subjectFormat, subject: row.subject };
}

/** is this anchor already linked to SOME account? (a proof or an admin
 * approval must not re-point an identity that belongs to somebody else) */
export async function anchorLinkedUser(db: Db, anchor: FederatedAnchor): Promise<string | null> {
  const [row] = await db
    .select({ userId: federatedIdentities.userId })
    .from(federatedIdentities)
    .where(anchorPredicate(anchor))
    .limit(1);
  return row?.userId ?? null;
}
