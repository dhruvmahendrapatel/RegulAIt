/**
 * M-068 / M-078 test fixture: a suite that adds an egress allow entry on the
 * shared database removes it before it ends.
 *
 * `POST /v1/egress-allow-hosts` upserts by host, so every suite on the shared
 * database shares ONE `127.0.0.1` row. A leftover row with `allowPrivateRanges`
 * lets a later suite reach a loopback double that the strict posture
 * (ADR-0181 `mcpPrivateRangesDefault=false`) should refuse. Whether that later
 * suite then passes depends on vitest's file order.
 *
 * The removal goes through the audited route, and it never throws: the outcome
 * is recorded, so a failed DELETE cannot skip the rest of an `afterAll`. The
 * caller asserts it in a `finally`, after every other restore and
 * `app.close()` have run:
 *
 *   afterAll(async () => {
 *     const loopback = await removeEgressAllowEntry(app, AUTH, { id: loopbackAllowHostId });
 *     try {
 *       // ...every other restore, then app.close()
 *     } finally {
 *       loopback.assertRemoved();
 *     }
 *   });
 *
 * An entry a single TEST creates is removed per entry from an `afterEach`, so a
 * failing assertion between the POST and an in-body DELETE cannot leave it for
 * the next test or file. The test passes the host through `trackHost`:
 *
 *   const perTest = trackEgressAllowHosts();
 *   afterEach(async () => (await perTest.removeAll(app, AUTH)).assertRemoved());
 *   ...
 *   payload: { host: perTest.trackHost("169.254.169.254"), note: "..." }
 *
 * `scripts/preflight-egress-allow-cleanup.mjs` enforces that every entry a
 * gateway test file creates on the shared database is removed through THIS
 * module, and only through it (#427 review N1): `removeEgressAllowEntry` with
 * the id the create returned, or the tracker's `removeAll` for a host posted as
 * `trackHost(...)`. Both remove by row id, so what they remove is exactly the
 * row that was created; no hand-written filter is read or trusted.
 */
import { normalizeHost } from "../egress-guard.js";

interface InjectResponse {
  statusCode: number;
  body: string;
  json(): unknown;
}

/** the part of the gateway app this needs (a Fastify instance satisfies it) */
export interface EgressAllowInjector {
  inject(opts: { method: "GET" | "DELETE"; url: string; headers: Record<string, string> }): PromiseLike<InjectResponse>;
}

export interface EgressAllowRemoval {
  /** throws if the removal failed; call it in a `finally`, after the rest of the teardown */
  assertRemoved(): void;
}

const ok: EgressAllowRemoval = { assertRemoved: () => {} };
const failed = (why: string): EgressAllowRemoval => ({
  assertRemoved: () => {
    throw new Error(`M-068: the egress allow entry this suite created was not removed: ${why}`);
  },
});

/**
 * Remove an egress allow entry through `DELETE /v1/egress-allow-hosts/:id`, by the id the suite's create returned.
 * An undefined id means nothing was created and nothing is done. A DELETE that does not answer 200 (an id that no
 * longer names a row, for example because a test re-created the entry under a new id) is reported by assertRemoved.
 */
export async function removeEgressAllowEntry(
  app: EgressAllowInjector | undefined,
  headers: Record<string, string>,
  target: { id: string | undefined },
): Promise<EgressAllowRemoval> {
  try {
    if (!target.id) return ok;
    if (!app) return failed(`entry ${target.id} exists but the app was never built`);
    return await deleteById(app, headers, target.id);
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

async function deleteById(app: EgressAllowInjector, headers: Record<string, string>, id: string): Promise<EgressAllowRemoval> {
  const gone = await app.inject({ method: "DELETE", headers, url: `/v1/egress-allow-hosts/${id}` });
  return gone.statusCode === 200 ? ok : failed(`DELETE ${id} returned ${gone.statusCode}: ${gone.body}`);
}

/**
 * Remove every row stored for a host, by id. The route stores `normalizeHost(host)`, so the posted spelling
 * (`" Metadata.Example."`) and the stored one (`"metadata.example"`) are matched the way the route matches them; a
 * row inserted directly with an unnormalised spelling is matched too. No row for the host is not an error.
 */
async function removeByHost(app: EgressAllowInjector | undefined, headers: Record<string, string>, host: string): Promise<EgressAllowRemoval> {
  try {
    if (!app) return ok;
    const listed = await app.inject({ method: "GET", headers, url: "/v1/egress-allow-hosts" });
    if (listed.statusCode !== 200) return failed(`GET /v1/egress-allow-hosts returned ${listed.statusCode}: ${listed.body}`);
    const want = normalizeHost(host);
    const rows = (listed.json() as { hosts: Array<{ id: string; host: string }> }).hosts.filter((h) => normalizeHost(h.host) === want);
    const removals: EgressAllowRemoval[] = [];
    for (const row of rows) removals.push(await deleteById(app, headers, row.id));
    return { assertRemoved: () => removals.forEach((r) => r.assertRemoved()) };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

/** the per-test entries a suite created, removed host by host from `afterEach` */
export interface EgressAllowTracker {
  /** record a host a test is about to allow-list; returns it, so it can sit in the payload */
  trackHost(host: string): string;
  /** remove every tracked host's entry (by its stored, normalised host, so a re-created row is found too) and forget them */
  removeAll(app: EgressAllowInjector | undefined, headers: Record<string, string>): Promise<EgressAllowRemoval>;
}

export function trackEgressAllowHosts(): EgressAllowTracker {
  const hosts = new Set<string>();
  return {
    trackHost(host) {
      hosts.add(host);
      return host;
    },
    async removeAll(app, headers) {
      const removals: EgressAllowRemoval[] = [];
      for (const host of hosts) removals.push(await removeByHost(app, headers, host));
      hosts.clear();
      return {
        assertRemoved: () => {
          for (const r of removals) r.assertRemoved();
        },
      };
    },
  };
}
