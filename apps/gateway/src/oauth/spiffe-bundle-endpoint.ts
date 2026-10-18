/**
 * ADR-0188 S9 follow-up — FETCHING A TRUST DOMAIN'S BUNDLE FROM ITS SPIFFE
 * BUNDLE ENDPOINT (SPIFFE Federation §5), as the S9 follow-ups note designed it.
 *
 *   GET /v1/identity/spiffe-bundle-endpoints                 every configured endpoint and its refresh state
 *   PUT /v1/identity/spiffe-bundle-endpoints/:trustDomain    set (or disable) a domain's endpoint; fetches once when enabled
 *
 * Secure by default (ADR-0180): no domain has an endpoint until an admin sets
 * one, with an `identity_manage` step-up bound to every field, audited; a
 * refusal is audited too. Air-gapped installs keep upload only (S9): a domain
 * with no endpoint is never fetched and its uploaded bundle never lapses.
 *
 * THE FETCH. Every fetch goes through `guardConnectionCall` (surface
 * `connector`): the egress allow-list decides and audits the call (allow or
 * refusal) and the pinned transport refuses redirects (a SHOULD-follow in
 * Federation §5.2, refused here: an allow-listed endpoint cannot hand the
 * fetch to another host). The URL is also checked against the allow-list
 * when it is set. A fetch has a 10 s budget and the upload's 256 KiB cap.
 *  - `https_web`: Web PKI, the system trust store and the hostname, unchanged;
 *  - `https_spiffe`: the server must present an X.509-SVID for the configured
 *    endpoint SPIFFE ID, chained to the ACTIVE bundle of that ID's trust domain
 *    (for a self-serving endpoint, the domain's own last bundle; an admin
 *    uploads the first one to bootstrap, §5.2.2). The system trust store is not
 *    used (draft-ietf-oauth-spiffe-client-auth §9: SVIDs are never validated
 *    against it).
 *
 * WHAT IS FETCHED passes exactly the upload's checks (`parseSpiffeBundle`; the
 * SPIFFE JSON format only) and is written through the same compare-and-set as
 * an upload (`setSpiffeTrustBundle`, `source = 'fetch'`), by the system
 * principal, so a fetched bundle is superseded, revoked and backstopped like an
 * uploaded one. Only a CHANGE writes a row (and its `spiffe-trust-bundle-set`
 * audit row names the old and new authorities); an unchanged fetch extends the
 * trust window. `spiffe_sequence` never goes backwards (a replayed older bundle
 * is refused). The next fetch follows `spiffe_refresh_hint`, clamped to
 * [60 s, 24 h], five minutes when absent (§5).
 *
 * FAILURE FAILS CLOSED. A failed fetch or a bundle that does not parse changes
 * no bundle: the last good one is kept, the failure is recorded on the endpoint
 * row as a code and audited (`spiffe-bundle-fetch-failed`), and the fetch is
 * retried at most every five minutes (never sooner than the floor). The last
 * good fetched bundle authenticates only until `trust_until` (its last
 * successful fetch + 24 h); after that the domain authenticates nothing until a
 * fetch succeeds (`spiffe-trust-domains.ts`). Disabling the endpoint ends that
 * trust at once (`trust_until = now()`, and only an enabled endpoint's bundle is
 * usable); re-enabling fetches before anything is trusted again.
 *
 * AN UPLOAD IS NOT SILENTLY SUPERSEDED. A fetched write over an active uploaded
 * bundle made at or after the endpoint was last set is refused
 * (`spiffe_bundle_upload_newer`): an admin sets the endpoint again to hand the
 * domain back to it.
 *
 * A REVOCATION IS NOT UNDONE BY A FETCH. Revoking a domain's bundle disables its
 * endpoint in the same transaction (`revokeSpiffeTrustBundle`), and a fetched
 * write into a domain whose bundle was revoked after the endpoint was last set
 * is refused (`spiffe_bundle_revoked`), so only an admin's stepped-up action
 * re-establishes trust.
 *
 * Multi-replica: the scheduler job claims one due endpoint at a time with
 * `FOR UPDATE SKIP LOCKED` and pushes its `next_refresh_at` out by a lease
 * before fetching, so two replicas never fetch one domain at once.
 */
import { X509Certificate } from "node:crypto";
import type { PeerCertificate } from "node:tls";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, asc, auditLog, eq, spiffeBundleEndpoints, spiffeTrustBundles, sql, type Db, type SpiffeBundleEndpointRow } from "@regulait/db";
import {
  putSpiffeBundleEndpointSchema,
  SPIFFE_BUNDLE_FETCH_TIMEOUT_MS,
  SPIFFE_BUNDLE_MAX_BYTES,
  SPIFFE_FETCHED_BUNDLE_MAX_AGE_SECONDS,
  SPIFFE_REFRESH_DEFAULT_SECONDS,
  SPIFFE_REFRESH_HINT_CEILING_SECONDS,
  SPIFFE_REFRESH_HINT_FLOOR_SECONDS,
  SPIFFE_TRUST_DOMAIN_PATTERN,
  type PutSpiffeBundleEndpoint,
  type SpiffeBundleEndpointListView,
  type SpiffeBundleEndpointView,
} from "@regulait/shared";
import { ConnectionEgressBlockedError, guardConnectionCall, refuseConnectionEgressWrite, type ConnectionEgressDeps } from "../connection-egress.js";
import { EgressBlockedError, EgressRedirectError } from "../egress-guard.js";
import type { PinnedTls } from "../pinned-fetch.js";
import type { SchedulerJobDefinition } from "../scheduler.js";
import { checkStepUp, type StepUpCheckArgs } from "../step-up.js";
import { IdentityAdminError } from "./identity-admin.js";
import { answer, parseSpiffeBundle, rerecordRefusal, setSpiffeTrustBundle, spendOrThrow, type ParsedSpiffeBundle, type SpendStepUp } from "./spiffe-bundles.js";
import { certificateIsAuthority, certificateUriSans, pemBundleToDer, spiffeIdParts } from "./x509.js";
import { databaseNow } from "../delegation.js";

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";
/** how far a claimed endpoint's next refresh is pushed while one replica fetches it */
const CLAIM_LEASE_SECONDS = 120;
/** endpoints refreshed per scheduler pass */
const SWEEP_LIMIT = 20;

export const SPIFFE_BUNDLE_REFRESH_JOB_NAME = "spiffe-bundle-refresh";

// ---------------------------------------------------------------------------
// Pure rules (tested offline)
// ---------------------------------------------------------------------------

/** the next refresh after a success: the bundle's `spiffe_refresh_hint`, clamped; five minutes when it names none */
export function refreshIntervalSeconds(hint: number | null): number {
  if (hint === null) return SPIFFE_REFRESH_DEFAULT_SECONDS;
  return Math.min(SPIFFE_REFRESH_HINT_CEILING_SECONDS, Math.max(SPIFFE_REFRESH_HINT_FLOOR_SECONDS, hint));
}

/** the next attempt after a failure: the polling interval (Federation §5.3), but never more than five minutes, so a
 * long hint cannot let the last good bundle lapse unretried */
export function retryDelaySeconds(lastIntervalSeconds: number): number {
  return Math.max(SPIFFE_REFRESH_HINT_FLOOR_SECONDS, Math.min(lastIntervalSeconds, SPIFFE_REFRESH_DEFAULT_SECONDS));
}

export interface FetchedBundle {
  parsed: ParsedSpiffeBundle;
  sequence: number | null;
  refreshHintSeconds: number | null;
}

/** a fetched body: the SPIFFE bundle format only (never PEM), the upload's checks, and its two top-level members */
export function parseFetchedBundle(text: string, now: Date): FetchedBundle | IdentityAdminError {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return new IdentityAdminError("spiffe_bundle_fetch_format", 422, "a bundle endpoint serves the SPIFFE bundle format (JSON)");
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return new IdentityAdminError("spiffe_bundle_invalid", 422, "the fetched bundle is not JSON");
  }
  const int = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
  if (doc.spiffe_sequence !== undefined && int(doc.spiffe_sequence) === null) return new IdentityAdminError("spiffe_bundle_invalid", 422, "spiffe_sequence is not a non-negative integer");
  if (doc.spiffe_refresh_hint !== undefined && (int(doc.spiffe_refresh_hint) === null || doc.spiffe_refresh_hint === 0)) {
    return new IdentityAdminError("spiffe_bundle_invalid", 422, "spiffe_refresh_hint is not a positive integer");
  }
  const parsed = parseSpiffeBundle(trimmed, now);
  if (parsed instanceof IdentityAdminError) return parsed;
  return { parsed, sequence: int(doc.spiffe_sequence), refreshHintSeconds: int(doc.spiffe_refresh_hint) };
}

/** an endpoint URL: `https`, a host, no userinfo, no fragment (Federation §5.2.1.1, §5.2.2.1) */
export function endpointUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "the endpoint URL does not parse";
  }
  if (u.protocol !== "https:") return "a bundle endpoint URL is https";
  if (u.username || u.password) return "a bundle endpoint URL carries no userinfo";
  if (u.hash) return "a bundle endpoint URL carries no fragment";
  if (!u.hostname) return "a bundle endpoint URL names a host";
  return null;
}

/**
 * `https_spiffe` server authentication (Federation §5.2.2): Node verifies the chain against the bundle's X.509
 * authorities only (`ca` replaces the system store) and the validity window; this checks that the leaf is an
 * X.509-SVID for exactly the configured endpoint SPIFFE ID (one URI SAN, that ID; not a CA). The hostname is not
 * the server's identity in this profile.
 */
export function spiffeEndpointTls(endpointSpiffeId: string, authorities: Buffer[]): PinnedTls {
  return {
    ca: authorities.map((der) => new X509Certificate(der).toString()),
    checkServerIdentity: (_host: string, cert: PeerCertificate) => spiffeServerIdentityProblem(endpointSpiffeId, cert.raw),
  };
}

/** the X.509-SVID profile of a bundle endpoint server's leaf, or undefined when it holds */
export function spiffeServerIdentityProblem(endpointSpiffeId: string, leafDer: Buffer | undefined): Error | undefined {
  if (!leafDer || leafDer.length === 0) return new Error("spiffe_endpoint_no_certificate");
  let sans: string[];
  let isCa: boolean;
  try {
    sans = certificateUriSans(leafDer);
    isCa = certificateIsAuthority(leafDer);
  } catch {
    return new Error("spiffe_endpoint_certificate_invalid");
  }
  if (isCa) return new Error("spiffe_endpoint_certificate_is_ca");
  if (sans.length !== 1 || sans[0] !== endpointSpiffeId) return new Error("spiffe_endpoint_id_mismatch");
  return undefined;
}

// ---------------------------------------------------------------------------
// The fetch
// ---------------------------------------------------------------------------

/** a fetch that did not yield a bundle: a code (recorded and audited), never the response text */
export class BundleFetchError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BundleFetchError";
  }
}

/** TEST ONLY: the guarded transport's dependencies (an injected resolver, for a loopback endpoint) */
export const spiffeBundleFetchTestHooks: { deps?: ConnectionEgressDeps } = {};

/** the X.509 authorities that authenticate an `https_spiffe` endpoint: the ACTIVE bundle of its SPIFFE ID's domain */
async function endpointAuthorities(db: Db, endpointSpiffeId: string): Promise<Buffer[] | null> {
  const parts = spiffeIdParts(endpointSpiffeId);
  if (!parts) return null;
  const [row] = await db
    .select({ authoritiesPem: spiffeTrustBundles.authoritiesPem })
    .from(spiffeTrustBundles)
    .where(and(eq(spiffeTrustBundles.trustDomain, parts.trustDomain), sql`${spiffeTrustBundles.supersededAt} IS NULL AND ${spiffeTrustBundles.revokedAt} IS NULL`));
  return row ? pemBundleToDer(row.authoritiesPem) : null;
}

/** read a body up to `max` bytes, refusing more (the declared length is checked first, then what actually arrives) */
async function boundedText(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > max) throw new BundleFetchError("spiffe_bundle_fetch_too_large");
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new BundleFetchError("spiffe_bundle_fetch_too_large");
    }
    chunks.push(value);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new BundleFetchError("spiffe_bundle_fetch_encoding");
  }
}

/** one fetch of `endpoint`, through the egress guard; the body text, or a `BundleFetchError` */
export async function fetchBundleText(db: Db, endpoint: Pick<SpiffeBundleEndpointRow, "trustDomain" | "url" | "profile" | "endpointSpiffeId">, deps: ConnectionEgressDeps = {}): Promise<string> {
  let tls: PinnedTls | undefined;
  if (endpoint.profile === "https_spiffe") {
    const authorities = endpoint.endpointSpiffeId ? await endpointAuthorities(db, endpoint.endpointSpiffeId) : null;
    if (!authorities || authorities.length === 0) throw new BundleFetchError("spiffe_endpoint_trust_domain_unknown");
    tls = spiffeEndpointTls(endpoint.endpointSpiffeId!, authorities);
  }
  let fetchImpl: typeof fetch;
  try {
    ({ fetchImpl } = await guardConnectionCall(db, {
      surface: "connector",
      baseUrl: endpoint.url,
      objectId: null,
      label: `SPIFFE bundle endpoint of ${endpoint.trustDomain}`,
      detail: { purpose: "spiffe_bundle_fetch", trustDomain: endpoint.trustDomain, profile: endpoint.profile },
      deps: { ...deps, ...(tls ? { tls } : {}) },
    }));
  } catch (e) {
    if (e instanceof ConnectionEgressBlockedError) throw new BundleFetchError("egress_blocked");
    throw e;
  }
  let res: Response;
  try {
    res = await fetchImpl(endpoint.url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(SPIFFE_BUNDLE_FETCH_TIMEOUT_MS) });
  } catch (e) {
    if (e instanceof EgressRedirectError) throw new BundleFetchError("spiffe_bundle_fetch_redirect");
    if (e instanceof EgressBlockedError) throw new BundleFetchError("egress_blocked");
    // the TLS refusal (an SVID for another ID, an untrusted chain) or a network error: a code, never the message
    const cause = (e as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
    const msg = typeof cause?.message === "string" ? cause.message : "";
    if (msg.startsWith("spiffe_endpoint_")) throw new BundleFetchError(msg.split(/\s/)[0]!.slice(0, 64));
    if (typeof cause?.code === "string" && /CERT|SELF_SIGNED|SIGNATURE|UNABLE_TO|HOSTNAME|ALTNAME/.test(cause.code)) throw new BundleFetchError("spiffe_bundle_fetch_tls");
    if ((e as { name?: string } | null)?.name === "TimeoutError" || (e as { name?: string } | null)?.name === "AbortError") throw new BundleFetchError("spiffe_bundle_fetch_timeout");
    throw new BundleFetchError("spiffe_bundle_fetch_network");
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    throw new BundleFetchError("spiffe_bundle_fetch_status");
  }
  return boundedText(res, SPIFFE_BUNDLE_MAX_BYTES);
}

// ---------------------------------------------------------------------------
// One refresh: fetch, compare, write (or keep the last good bundle)
// ---------------------------------------------------------------------------

export type RefreshOutcome =
  | { trustDomain: string; outcome: "changed"; bundleId: string; sequence: number | null }
  | { trustDomain: string; outcome: "unchanged"; bundleId: string }
  | { trustDomain: string; outcome: "failed"; code: string }
  | { trustDomain: string; outcome: "skipped" };

const secondsFromNow = (s: number) => sql`now() + make_interval(secs => ${s}::double precision)`;

async function recordFailure(db: Db, endpoint: SpiffeBundleEndpointRow, code: string, intervalSeconds: number): Promise<RefreshOutcome> {
  await db
    .update(spiffeBundleEndpoints)
    .set({
      lastAttemptAt: sql`now()`,
      lastErrorCode: code,
      consecutiveFailures: sql`${spiffeBundleEndpoints.consecutiveFailures} + 1`,
      nextRefreshAt: secondsFromNow(retryDelaySeconds(intervalSeconds)),
    })
    .where(and(eq(spiffeBundleEndpoints.trustDomain, endpoint.trustDomain), eq(spiffeBundleEndpoints.enabled, true)));
  await db.insert(auditLog).values({
    userId: SYSTEM_USER_ID,
    objectType: "spiffe_trust_bundle",
    objectId: null,
    detail: { phase: "fetch_failed", trustDomain: endpoint.trustDomain, url: endpoint.url, profile: endpoint.profile, code, consecutiveFailures: endpoint.consecutiveFailures + 1 },
    effect: "deny",
    ruleId: "spiffe-bundle-fetch-failed",
    ruleChain: [],
    reason: `the SPIFFE bundle of ${endpoint.trustDomain} could not be refreshed (${code}); the last good bundle is kept until its trust window ends (ADR-0188 S9 follow-up)`,
  });
  return { trustDomain: endpoint.trustDomain, outcome: "failed", code };
}

/** the endpoint state after a good fetch: the trust window restarts, and the next fetch follows the refresh hint */
const successState = (intervalSeconds: number) => ({
  lastAttemptAt: sql`now()`,
  lastSuccessAt: sql`now()`,
  lastErrorCode: null,
  consecutiveFailures: 0,
  trustUntil: secondsFromNow(SPIFFE_FETCHED_BUNDLE_MAX_AGE_SECONDS),
  nextRefreshAt: secondsFromNow(intervalSeconds),
});

/**
 * Refresh one endpoint now. Never throws for a fetch or a bundle problem (it is recorded and audited); a database
 * error propagates (the scheduler records the pass as failed and the endpoint is retried after its lease).
 */
export async function refreshSpiffeBundleEndpoint(db: Db, endpoint: SpiffeBundleEndpointRow, deps: ConnectionEgressDeps = spiffeBundleFetchTestHooks.deps ?? {}): Promise<RefreshOutcome> {
  if (!endpoint.enabled) return { trustDomain: endpoint.trustDomain, outcome: "skipped" };
  let fetched: FetchedBundle;
  try {
    const text = await fetchBundleText(db, endpoint, deps);
    const out = parseFetchedBundle(text, await databaseNow(db));
    if (out instanceof IdentityAdminError) return recordFailure(db, endpoint, out.code, SPIFFE_REFRESH_DEFAULT_SECONDS);
    fetched = out;
  } catch (e) {
    if (e instanceof BundleFetchError) return recordFailure(db, endpoint, e.code, SPIFFE_REFRESH_DEFAULT_SECONDS);
    throw e;
  }
  const interval = refreshIntervalSeconds(fetched.refreshHintSeconds);
  const [active] = await db
    .select({ id: spiffeTrustBundles.id, digest: spiffeTrustBundles.digest })
    .from(spiffeTrustBundles)
    .where(and(eq(spiffeTrustBundles.trustDomain, endpoint.trustDomain), sql`${spiffeTrustBundles.supersededAt} IS NULL AND ${spiffeTrustBundles.revokedAt} IS NULL`));
  // only while still enabled: a fetch racing a disable never reopens the trust window the disable closed
  const onSuccess = (t: Db) =>
    t
      .update(spiffeBundleEndpoints)
      .set(successState(interval))
      .where(and(eq(spiffeBundleEndpoints.trustDomain, endpoint.trustDomain), eq(spiffeBundleEndpoints.enabled, true)));
  if (active && active.digest === fetched.parsed.digest) {
    await onSuccess(db);
    return { trustDomain: endpoint.trustDomain, outcome: "unchanged", bundleId: active.id };
  }
  try {
    const view = await setSpiffeTrustBundle(db, { trustDomain: endpoint.trustDomain, bundle: "", replacesBundleId: active?.id ?? null }, fetched.parsed, SYSTEM_USER_ID, undefined, {
      source: "fetch",
      sequence: fetched.sequence,
      endpointUrl: endpoint.url,
      inTx: async (t, bundleId) => {
        // a revocation is never undone by a fetch: refused when a bundle of the domain was revoked at or after the
        // endpoint was last set by an admin (the revocation also disabled it; only a stepped-up PUT re-enables it)
        const revoked = await t.execute<{ n: number }>(sql`
          select count(*)::int as n from spiffe_trust_bundles b join spiffe_bundle_endpoints e on e.trust_domain = b.trust_domain
          where b.trust_domain = ${endpoint.trustDomain} and b.revoked_at is not null and b.revoked_at >= e.updated_at`);
        if ((revoked.rows[0]?.n ?? 0) > 0) throw new IdentityAdminError("spiffe_bundle_revoked", 409, `a bundle of ${endpoint.trustDomain} was revoked; an admin must set its endpoint again`);
        // an admin's upload is never silently replaced by a fetch: refused when the bundle this write supersedes (inTx runs
        // after the supersede) is an upload made at or after the endpoint was last set (setting it again hands it back)
        const uploaded = await t.execute<{ n: number }>(sql`
          select count(*)::int as n from spiffe_trust_bundles b join spiffe_bundle_endpoints e on e.trust_domain = b.trust_domain
          where b.trust_domain = ${endpoint.trustDomain} and b.superseded_by_bundle_id = ${bundleId} and b.source = 'upload'
            and b.created_at >= e.updated_at`);
        if ((uploaded.rows[0]?.n ?? 0) > 0)
          throw new IdentityAdminError("spiffe_bundle_upload_newer", 409, `the active bundle of ${endpoint.trustDomain} was uploaded after its endpoint was set; an admin must set the endpoint again`);
        const enabled = await t
          .update(spiffeBundleEndpoints)
          .set(successState(interval))
          .where(and(eq(spiffeBundleEndpoints.trustDomain, endpoint.trustDomain), eq(spiffeBundleEndpoints.enabled, true)))
          .returning({ td: spiffeBundleEndpoints.trustDomain });
        if (enabled.length === 0) throw new IdentityAdminError("spiffe_bundle_endpoint_disabled", 409, `the endpoint of ${endpoint.trustDomain} was disabled meanwhile`);
      },
    });
    return { trustDomain: endpoint.trustDomain, outcome: "changed", bundleId: view.id, sequence: fetched.sequence };
  } catch (e) {
    if (!(e instanceof IdentityAdminError)) throw e;
    if (e.code === "spiffe_bundle_unchanged") {
      await onSuccess(db);
      return { trustDomain: endpoint.trustDomain, outcome: "unchanged", bundleId: active?.id ?? "" };
    }
    return recordFailure(db, endpoint, e.code, interval);
  }
}

/** claim the most overdue enabled endpoint (pushing its next refresh out by a lease), or null when none is due */
async function claimDueEndpoint(db: Db): Promise<SpiffeBundleEndpointRow | null> {
  const r = await db.execute<{ trust_domain: string }>(sql`
    update spiffe_bundle_endpoints set next_refresh_at = now() + make_interval(secs => ${CLAIM_LEASE_SECONDS}::double precision)
    where trust_domain = (
      select trust_domain from spiffe_bundle_endpoints
      where enabled and next_refresh_at is not null and next_refresh_at <= now()
      order by next_refresh_at limit 1 for update skip locked)
    returning trust_domain`);
  const td = r.rows[0]?.trust_domain;
  if (!td) return null;
  const [row] = await db.select().from(spiffeBundleEndpoints).where(eq(spiffeBundleEndpoints.trustDomain, td));
  return row ?? null;
}

/** the scheduler pass: refresh every due endpoint (up to `SWEEP_LIMIT`) */
export async function runSpiffeBundleRefreshSweep(db: Db, deps?: ConnectionEgressDeps): Promise<{ refreshed: number; changed: number; failed: number }> {
  const out = { refreshed: 0, changed: 0, failed: 0 };
  for (let i = 0; i < SWEEP_LIMIT; i++) {
    const endpoint = await claimDueEndpoint(db);
    if (!endpoint) break;
    const r = await refreshSpiffeBundleEndpoint(db, endpoint, deps ?? spiffeBundleFetchTestHooks.deps ?? {});
    out.refreshed++;
    if (r.outcome === "changed") out.changed++;
    if (r.outcome === "failed") out.failed++;
  }
  return out;
}

export function spiffeBundleRefreshJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: SPIFFE_BUNDLE_REFRESH_JOB_NAME,
      description:
        "Fetch the SPIFFE bundle of every trust domain whose bundle endpoint is due (up to 20 per pass), through the " +
        "egress guard. A changed bundle is written and audited; a failure keeps the last good bundle and is audited. " +
        "Authentication does not depend on the job running: a fetched bundle stops authenticating 24 hours after its " +
        "last successful fetch.",
      adr: "ADR-0188",
      defaultIntervalSeconds: 60,
      run: async (ctx) => {
        const out = await runSpiffeBundleRefreshSweep(ctx.db);
        return { itemsProcessed: out.refreshed, detail: { ...out } };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// The admin routes
// ---------------------------------------------------------------------------

export function spiffeBundleEndpointView(r: SpiffeBundleEndpointRow): SpiffeBundleEndpointView {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    trustDomain: r.trustDomain,
    url: r.url,
    profile: r.profile,
    endpointSpiffeId: r.endpointSpiffeId,
    enabled: r.enabled,
    nextRefreshAt: r.enabled ? iso(r.nextRefreshAt) : null,
    lastAttemptAt: iso(r.lastAttemptAt),
    lastSuccessAt: iso(r.lastSuccessAt),
    lastErrorCode: r.lastErrorCode,
    consecutiveFailures: r.consecutiveFailures,
    trustUntil: iso(r.trustUntil),
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listSpiffeBundleEndpoints(db: Db): Promise<SpiffeBundleEndpointListView> {
  const rows = await db.select().from(spiffeBundleEndpoints).orderBy(asc(spiffeBundleEndpoints.trustDomain)).limit(500);
  return { items: rows.map(spiffeBundleEndpointView) };
}

/** the step-up binds every field of the change */
export function spiffeBundleEndpointStepUp(trustDomain: string, input: PutSpiffeBundleEndpoint): StepUpCheckArgs {
  return {
    kind: "identity_manage",
    facts: { op: "spiffe_bundle_endpoint_set", trustDomain, url: input.url, profile: input.profile, endpointSpiffeId: input.endpointSpiffeId, enabled: input.enabled },
  };
}

async function auditEndpointRefusal(db: Db, actorUserId: string, trustDomain: string | null, err: IdentityAdminError | { code: string; message: string }, extra: Record<string, unknown> = {}) {
  await db.insert(auditLog).values({
    userId: actorUserId,
    objectType: "spiffe_trust_bundle",
    objectId: null,
    detail: { phase: "endpoint_set_refused", trustDomain, code: err.code, ...extra },
    effect: "deny",
    ruleId: "spiffe-bundle-endpoint-refused",
    ruleChain: [],
    reason: `refused: ${err.message} (ADR-0188 S9 follow-up)`,
  });
}

/** set a domain's endpoint (validated first; the step-up is claimed last, inside the write) */
export async function setSpiffeBundleEndpoint(db: Db, trustDomain: string, input: PutSpiffeBundleEndpoint, actorUserId: string, spend?: SpendStepUp): Promise<SpiffeBundleEndpointRow> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [before] = await t.select().from(spiffeBundleEndpoints).where(eq(spiffeBundleEndpoints.trustDomain, trustDomain)).for("update");
    const values = {
      url: input.url,
      profile: input.profile,
      endpointSpiffeId: input.endpointSpiffeId,
      enabled: input.enabled,
      // enabling (or changing where it fetches from) fetches at once; disabling stops the schedule
      nextRefreshAt: input.enabled ? sql`now()` : null,
      // disabling ends trust in the fetched bundle at once (secure by default, ADR-0180); a re-enable fetches before it trusts
      ...(input.enabled ? {} : { trustUntil: sql`now()` }),
      updatedBy: actorUserId,
      updatedAt: sql`now()`,
      // a new source starts with no failure history; the last good bundle's window is kept (it is still that bundle)
      ...(before && (before.url !== input.url || before.profile !== input.profile || before.endpointSpiffeId !== input.endpointSpiffeId)
        ? { lastErrorCode: null, consecutiveFailures: 0 }
        : {}),
    };
    const [row] = before
      ? await t.update(spiffeBundleEndpoints).set(values).where(eq(spiffeBundleEndpoints.trustDomain, trustDomain)).returning()
      : await t
          .insert(spiffeBundleEndpoints)
          .values({ trustDomain, ...values })
          .returning();
    await t.insert(auditLog).values({
      userId: actorUserId,
      objectType: "spiffe_trust_bundle",
      objectId: null,
      detail: {
        phase: before ? "endpoint_update" : "endpoint_add",
        trustDomain,
        url: input.url,
        profile: input.profile,
        endpointSpiffeId: input.endpointSpiffeId,
        enabled: input.enabled,
        before: before ? { url: before.url, profile: before.profile, endpointSpiffeId: before.endpointSpiffeId, enabled: before.enabled } : null,
      },
      effect: "allow",
      ruleId: "spiffe-bundle-endpoint-set",
      ruleChain: [],
      reason: input.enabled
        ? `the SPIFFE bundle of ${trustDomain} is fetched from ${input.url} (${input.profile}); a changed bundle replaces the active one`
        : `fetching the SPIFFE bundle of ${trustDomain} is off; its last fetched bundle stopped authenticating now (an uploaded bundle is unaffected)`,
    });
    await spendOrThrow(t, spend);
    return row!;
  });
}

const domainParam = z.object({ trustDomain: z.string().regex(SPIFFE_TRUST_DOMAIN_PATTERN) });
const actorOf = (req: FastifyRequest) => req.authCtx.userId ?? SYSTEM_USER_ID;

export function spiffeBundleEndpointHandlers(db: Db) {
  return {
    list: async (_req: FastifyRequest, reply: FastifyReply) => reply.send(await listSpiffeBundleEndpoints(db)),
    set: async (req: FastifyRequest, reply: FastifyReply) => {
      const params = domainParam.safeParse(req.params);
      const body = putSpiffeBundleEndpointSchema.safeParse(req.body ?? {});
      if (!params.success || !body.success) {
        const issues = [...(params.success ? [] : params.error.issues), ...(body.success ? [] : body.error.issues)];
        await auditEndpointRefusal(db, actorOf(req), params.success ? params.data.trustDomain : null, { code: "request_invalid", message: "a malformed PUT /v1/identity/spiffe-bundle-endpoints/:trustDomain request" }, {
          issues: issues.slice(0, 20).map((i) => ({ path: i.path.map(String), message: i.message })),
        });
        return reply.status(400).send({ error: "invalid_body", detail: issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      }
      const { trustDomain } = params.data;
      const input = body.data;
      // validated BEFORE the step-up, as an upload is: a destination that could never be fetched is refused unconfirmed
      const urlProblem = endpointUrlProblem(input.url);
      if (urlProblem) {
        const err = new IdentityAdminError("spiffe_endpoint_url_invalid", 422, urlProblem);
        await auditEndpointRefusal(db, actorOf(req), trustDomain, err);
        return answer(reply, err);
      }
      if (input.profile === "https_spiffe" && !(await endpointAuthorities(db, input.endpointSpiffeId!))) {
        const err = new IdentityAdminError(
          "spiffe_endpoint_trust_domain_unknown",
          422,
          `the endpoint's SPIFFE ID is in a trust domain with no active bundle; upload that domain's bundle first to bootstrap https_spiffe`,
        );
        await auditEndpointRefusal(db, actorOf(req), trustDomain, err);
        return answer(reply, err);
      }
      if (input.enabled) {
        const blocked = await refuseConnectionEgressWrite(db, {
          surface: "connector",
          baseUrl: input.url,
          userId: req.authCtx.userId ?? null,
          objectId: null,
          phase: "spiffe_bundle_endpoint_set",
          label: `SPIFFE bundle endpoint of ${trustDomain}`,
          detail: { purpose: "spiffe_bundle_fetch", trustDomain },
          ...(spiffeBundleFetchTestHooks.deps ? { deps: spiffeBundleFetchTestHooks.deps } : {}),
        });
        if (blocked) return reply.status(400).send(blocked);
      }
      const args = spiffeBundleEndpointStepUp(trustDomain, input);
      const look = await checkStepUp(db, req, args, { spend: false });
      if (!look.ok) return reply.status(look.status).send(look.body);
      let row: SpiffeBundleEndpointRow;
      try {
        row = await setSpiffeBundleEndpoint(db, trustDomain, input, actorOf(req), (conn) => checkStepUp(conn, req, args));
      } catch (e) {
        return answer(reply, await rerecordRefusal(db, req, args, e));
      }
      // enabled: fetch once now, so the admin sees the result; the scheduler keeps it fresh from here
      const refresh = row.enabled ? await refreshSpiffeBundleEndpoint(db, row) : null;
      const [after] = await db.select().from(spiffeBundleEndpoints).where(eq(spiffeBundleEndpoints.trustDomain, trustDomain));
      return reply.send({ endpoint: spiffeBundleEndpointView(after ?? row), refresh });
    },
  };
}
