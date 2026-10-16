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
import { and, isNull, spiffeTrustBundles, type Db } from "@regulait/db";
import { SPIFFE_TRUST_BUNDLES_LEGACY_ENV } from "@regulait/shared";
import { pemBundleToDer } from "./x509.js";

const activeWhere = () => and(isNull(spiffeTrustBundles.supersededAt), isNull(spiffeTrustBundles.revokedAt));

/** trust domain → the active bundle's X.509 authorities (DER). A stored bundle that does not parse throws (fail closed). */
export async function loadSpiffeTrustAnchors(db: Db): Promise<Map<string, Buffer[]>> {
  const rows = await db
    .select({ trustDomain: spiffeTrustBundles.trustDomain, authoritiesPem: spiffeTrustBundles.authoritiesPem })
    .from(spiffeTrustBundles)
    .where(activeWhere());
  const out = new Map<string, Buffer[]>();
  for (const r of rows) out.set(r.trustDomain, pemBundleToDer(r.authoritiesPem));
  return out;
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
