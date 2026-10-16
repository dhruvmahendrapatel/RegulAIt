/**
 * ADR-0188 S9 — READING the SPIFFE trust bundles (decisions 10, 21).
 *
 * The bundles live in `spiffe_trust_bundles` (migration 0200), written only by
 * the audited admin routes in `spiffe-bundles.ts`. These are the reads every
 * validator uses, at the point of use and never cached, so an upload or a
 * revocation reaches the next request on every replica:
 *  - `loadSpiffeTrustAnchors`: trust domain → the ACTIVE bundle's authorities
 *    (DER), for `validateClientCertificate`;
 *  - `activeSpiffeTrustDomains`: the domains with an active bundle, for binding
 *    a `spiffe_id` credential (an ID in any other domain could never authenticate).
 *
 * The S5 environment variable `REGULAIT_SPIFFE_TRUST_BUNDLES` is never read
 * (secure by default, ADR-0180: nothing is trusted that was not uploaded through
 * the audited route); `legacySpiffeEnvSet` only lets the boot log and the list
 * view say it is ignored.
 */
import { and, eq, isNull, spiffeTrustBundles, type Db } from "@regulait/db";
import { SPIFFE_TRUST_BUNDLES_LEGACY_ENV } from "@regulait/shared";
import { pemBundleToDer } from "./x509.js";

const activeWhere = () => and(isNull(spiffeTrustBundles.supersededAt), isNull(spiffeTrustBundles.revokedAt));

/** one domain's active bundle: its id (the token endpoint locks it while it issues, #389 review M1) and its authorities */
export interface SpiffeTrustAnchors {
  bundleId: string;
  authorities: Buffer[];
}

/** trust domain → the active bundle's X.509 authorities (DER). A stored bundle that does not parse throws (fail closed). */
export async function loadSpiffeTrustAnchors(db: Db): Promise<Map<string, SpiffeTrustAnchors>> {
  const rows = await db
    .select({ id: spiffeTrustBundles.id, trustDomain: spiffeTrustBundles.trustDomain, authoritiesPem: spiffeTrustBundles.authoritiesPem })
    .from(spiffeTrustBundles)
    .where(activeWhere());
  const out = new Map<string, SpiffeTrustAnchors>();
  for (const r of rows) out.set(r.trustDomain, { bundleId: r.id, authorities: pemBundleToDer(r.authoritiesPem) });
  return out;
}

/**
 * #389 review M1: inside the transaction that creates a SPIFFE-authenticated grant, hold the authenticating bundle
 * row FOR SHARE and require it unrevoked. A concurrent revocation (which takes the row FOR UPDATE) then either commits
 * first, and this refuses, or waits for this grant and token to commit, and its cascade ends them. A superseded
 * bundle still qualifies: rotation is not revocation (decision 12).
 */
export async function lockSpiffeBundleUnrevoked(tx: Db, bundleId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: spiffeTrustBundles.id })
    .from(spiffeTrustBundles)
    .where(and(eq(spiffeTrustBundles.id, bundleId), isNull(spiffeTrustBundles.revokedAt)))
    .for("share");
  return row !== undefined;
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
