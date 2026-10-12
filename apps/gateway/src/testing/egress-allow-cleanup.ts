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
 * `scripts/preflight-egress-allow-cleanup.mjs` enforces that every gateway test
 * file that creates an entry on the shared database reaches a removal from an
 * `afterAll`, and that an entry created inside a test body is tracked for an
 * `afterEach` removal, is a restore inside a `finally`, or is marked
 * `egress-allow-cleanup: afterAll` (a file-scoped entry the afterAll removes).
 */

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
 * Remove an egress allow entry through `DELETE /v1/egress-allow-hosts/:id`.
 *
 * `{ id }` removes the row the suite's POST returned; an undefined id means
 * nothing was created and nothing is done. `{ host }` looks the row up first,
 * for a suite whose row id changes during the run (a test that withdraws and
 * re-adds the entry); no row for the host is not an error.
 */
export async function removeEgressAllowEntry(
  app: EgressAllowInjector | undefined,
  headers: Record<string, string>,
  target: { id: string | undefined } | { host: string },
): Promise<EgressAllowRemoval> {
  try {
    let id: string | undefined;
    if ("host" in target) {
      if (!app) return ok;
      const listed = await app.inject({ method: "GET", headers, url: "/v1/egress-allow-hosts" });
      if (listed.statusCode !== 200) return failed(`GET /v1/egress-allow-hosts returned ${listed.statusCode}: ${listed.body}`);
      const hosts = (listed.json() as { hosts: Array<{ id: string; host: string }> }).hosts;
      id = hosts.find((h) => h.host === target.host)?.id;
    } else {
      id = target.id;
    }
    if (!id) return ok;
    if (!app) return failed(`entry ${id} exists but the app was never built`);
    const gone = await app.inject({ method: "DELETE", headers, url: `/v1/egress-allow-hosts/${id}` });
    return gone.statusCode === 200 ? ok : failed(`DELETE returned ${gone.statusCode}: ${gone.body}`);
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

/** the per-test entries a suite created, removed host by host from `afterEach` */
export interface EgressAllowTracker {
  /** record a host a test is about to allow-list; returns it, so it can sit in the payload */
  trackHost(host: string): string;
  /** remove every tracked host's entry (by host, so a re-created row is found too) and forget them */
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
      for (const host of hosts) removals.push(await removeEgressAllowEntry(app, headers, { host }));
      hosts.clear();
      return {
        assertRemoved: () => {
          for (const r of removals) r.assertRemoved();
        },
      };
    },
  };
}
