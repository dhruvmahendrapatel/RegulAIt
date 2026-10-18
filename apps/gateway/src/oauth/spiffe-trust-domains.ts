/**
 * ADR-0188 S9 — READING the SPIFFE trust bundles (decisions 10, 21).
 *
 * The bundles live in `spiffe_trust_bundles` (migration 0199), written only by
 * the audited admin routes in `spiffe-bundles.ts`. These are the reads every
 * validator uses, at the point of use and never cached, so an upload or a
 * revocation reaches the next request on every replica:
 *  - `loadSpiffeTrustAnchors`: trust domain → the ACTIVE bundle's authorities
 *    (DER), for `validateClientCertificate`;
 *  - `activeSpiffeTrustDomains`: the domains with an active bundle, for binding
 *    a `spiffe_id` credential (an ID in any other domain could never authenticate);
 *  - `loadSpiffeJwtAuthorities` (S9 follow-up): one domain's active bundle's JWT
 *    authorities, for `verifyJwtSvid`.
 *
 * S9 follow-up: a bundle FETCHED from the domain's bundle endpoint is used for
 * authentication only while its endpoint's `trust_until` (last successful fetch
 * + `SPIFFE_FETCHED_BUNDLE_MAX_AGE_SECONDS`) is in the future on the database
 * clock. A failed refresh keeps the last good bundle until then, and never
 * after: a domain whose refreshes keep failing stops authenticating (fail
 * closed). An uploaded bundle is pinned and does not lapse.
 *
 * The S5 environment variable `REGULAIT_SPIFFE_TRUST_BUNDLES` is never read
 * (secure by default, ADR-0180: nothing is trusted that was not uploaded through
 * the audited route); `legacySpiffeEnvSet` only lets the boot log and the list
 * view say it is ignored.
 */
import { and, eq, isNull, spiffeTrustBundles, sql, type Db } from "@regulait/db";
import { SPIFFE_TRUST_BUNDLES_LEGACY_ENV } from "@regulait/shared";
import { pemBundleToDer } from "./x509.js";

const activeWhere = () => and(isNull(spiffeTrustBundles.supersededAt), isNull(spiffeTrustBundles.revokedAt));
/** active, and either uploaded (pinned) or fetched and still inside its endpoint's trust window (database clock) */
const usableWhere = () =>
  and(
    activeWhere(),
    sql`(${spiffeTrustBundles.source} = 'upload' OR EXISTS (SELECT 1 FROM spiffe_bundle_endpoints e WHERE e.trust_domain = ${spiffeTrustBundles.trustDomain} AND e.trust_until > now()))`,
  );

/** one domain's active bundle: its id (the token endpoint locks it while it issues, #389 review M1) and its authorities */
export interface SpiffeTrustAnchors {
  bundleId: string;
  authorities: Buffer[];
}

/**
 * trust domain → the active bundle's X.509 authorities (DER). A stored bundle that does not parse throws (fail closed).
 * A fetched bundle past its trust window is left out (the domain authenticates nothing until a fetch succeeds).
 */
export async function loadSpiffeTrustAnchors(db: Db): Promise<Map<string, SpiffeTrustAnchors>> {
  const rows = await db
    .select({ id: spiffeTrustBundles.id, trustDomain: spiffeTrustBundles.trustDomain, authoritiesPem: spiffeTrustBundles.authoritiesPem })
    .from(spiffeTrustBundles)
    .where(usableWhere());
  const out = new Map<string, SpiffeTrustAnchors>();
  for (const r of rows) out.set(r.trustDomain, { bundleId: r.id, authorities: pemBundleToDer(r.authoritiesPem) });
  return out;
}

/**
 * #389 review M1 and recheck Low 3: inside the transaction that creates a SPIFFE-authenticated grant, hold every
 * bundle row of the domain FOR SHARE and apply `spiffeIssueAllowed`. A concurrent upload or revocation (each takes
 * the active row FOR UPDATE) then either commits first, and the rule sees it, or waits for this grant and token to
 * commit, and its cascade ends them. A superseded bundle still qualifies while no later bundle was revoked: rotation
 * is not revocation (decision 12).
 */
export async function lockSpiffeBundleUnrevoked(tx: Db, bundleId: string): Promise<boolean> {
  const [auth] = await tx.select({ trustDomain: spiffeTrustBundles.trustDomain }).from(spiffeTrustBundles).where(eq(spiffeTrustBundles.id, bundleId));
  if (!auth) return false;
  // #389 recheck Low 3: EVERY bundle row of the domain, FOR SHARE, in one statement. Under READ COMMITTED a row a
  // concurrent writer holds is waited for and then read in its committed version, so the facts below are current
  const rows = await tx
    .select({ id: spiffeTrustBundles.id, createdAt: spiffeTrustBundles.createdAt, supersededAt: spiffeTrustBundles.supersededAt, revokedAt: spiffeTrustBundles.revokedAt })
    .from(spiffeTrustBundles)
    .where(eq(spiffeTrustBundles.trustDomain, auth.trustDomain))
    .orderBy(spiffeTrustBundles.createdAt)
    .for("share");
  return spiffeIssueAllowed(rows, bundleId);
}

/**
 * The issue rule (#389 recheck Low 3), pure so it is tested on its own. A token may be issued under bundle `authId`
 * only when:
 *  1. it is not revoked;
 *  2. no bundle of the domain created at or after it was revoked: a rotation away from it that ended in a revocation
 *     ends what it authenticated too (B1 superseded by B2, B2 revoked: B1's authorities are dead);
 *  3. the domain has an ACTIVE bundle now.
 * Why this is final under READ COMMITTED: when the rule passes, the issuing transaction holds the domain's active row
 * FOR SHARE until it commits. Superseding that row (an upload) and revoking it both take it FOR UPDATE first, so
 * neither can commit while the grant is being made, and a later revocation stamps `revoked_at` with
 * `clock_timestamp()` after its own lock, i.e. after this grant's `created_at`. Live-chain rule (b)
 * (`revoked_at >= grant.created_at`) then refuses the grant for good, whatever is uploaded later. When the rule fails,
 * nothing is issued. A first upload into a domain with no active bundle is the one write that takes no row lock, and
 * rule 3 refuses exactly that state.
 */
export function spiffeIssueAllowed(
  rows: ReadonlyArray<{ id: string; createdAt: Date; supersededAt: Date | null; revokedAt: Date | null }>,
  authId: string,
): boolean {
  const auth = rows.find((r) => r.id === authId);
  if (!auth || auth.revokedAt !== null) return false;
  if (rows.some((r) => r.revokedAt !== null && r.createdAt.getTime() >= auth.createdAt.getTime())) return false;
  return rows.some((r) => r.supersededAt === null && r.revokedAt === null);
}

/** one domain's usable bundle's JWT authorities (public JWKs, each with its `kid`), or null when it has none */
export async function loadSpiffeJwtAuthorities(db: Db, trustDomain: string): Promise<{ bundleId: string; keys: Array<Record<string, string>> } | null> {
  const [row] = await db
    .select({ id: spiffeTrustBundles.id, jwtAuthorities: spiffeTrustBundles.jwtAuthorities })
    .from(spiffeTrustBundles)
    .where(and(eq(spiffeTrustBundles.trustDomain, trustDomain), usableWhere()));
  if (!row || !Array.isArray(row.jwtAuthorities) || row.jwtAuthorities.length === 0) return null;
  return { bundleId: row.id, keys: row.jwtAuthorities };
}

/** the trust domains with an active bundle */
export async function activeSpiffeTrustDomains(db: Db): Promise<ReadonlySet<string>> {
  const rows = await db.select({ trustDomain: spiffeTrustBundles.trustDomain }).from(spiffeTrustBundles).where(activeWhere());
  return new Set(rows.map((r) => r.trustDomain));
}

/** is the retired S5 variable still set? (it is ignored; the boot log and the list view say so) */
export function legacySpiffeEnvSet(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[SPIFFE_TRUST_BUNDLES_LEGACY_ENV];
  return typeof v === "string" && v.trim() !== "";
}
