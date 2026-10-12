/**
 * M-068 / M-078 for the web journeys: a spec that allow-lists an egress host
 * on the shared e2e database puts each host back exactly as it found it.
 *
 * `POST /v1/egress-allow-hosts` upserts by host, so a spec cannot tell "my
 * row" from "the row another spec or the seed left" by id. It records, per
 * host it is about to touch, the row that existed before (or that none did),
 * and `restore` re-creates that row with its original opt-ins or removes the
 * one the spec added. A leftover `127.0.0.1` row with `allowPrivateRanges` is
 * the leak this prevents: it lets a later spec reach a loopback endpoint the
 * strict default should refuse.
 */
import { expect, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL } from "./admin-api";
import { steppedUpAs } from "./demo-credentials";

interface AllowHost {
  id: string;
  host: string;
  allowPrivateRanges: boolean;
  allowPlaintextHttp: boolean;
  note: string | null;
}

const CSRF = { "x-regulait-csrf": "1" };

async function listHosts(request: APIRequestContext, baseUrl: string): Promise<AllowHost[]> {
  const res = await request.get(`${baseUrl}/v1/egress-allow-hosts`);
  expect(res.status(), `list egress allow hosts: ${await res.text()}`).toBe(200);
  return ((await res.json()) as { hosts: AllowHost[] }).hosts;
}

export interface EgressAllowSnapshot {
  /** put every recorded host back as it was; throws (after trying every host) if one could not be */
  restore(request: APIRequestContext): Promise<void>;
}

/** record the current state of `hosts` (call it BEFORE the spec adds or changes any of them) */
export async function snapshotEgressAllowHosts(
  request: APIRequestContext,
  baseUrl: string,
  hosts: readonly string[],
): Promise<EgressAllowSnapshot> {
  const listed = await listHosts(request, baseUrl);
  const before = new Map(hosts.map((h) => [h, listed.find((row) => row.host === h) ?? null] as const));
  return {
    async restore(req) {
      const failures: string[] = [];
      const now = await listHosts(req, baseUrl);
      for (const [host, was] of before) {
        const current = now.find((row) => row.host === host);
        if (was) {
          // re-create (an upsert) with the opt-ins it had, whether the spec changed or removed it. Turning an opt-in
          // back on is a relaxation (ADR-0186 A): the admin's signed-in request steps up with her authenticator
          const res = await steppedUpAs(req, ADMIN_EMAIL, "POST", `${baseUrl}/v1/egress-allow-hosts`, {
            host,
            allowPrivateRanges: was.allowPrivateRanges,
            allowPlaintextHttp: was.allowPlaintextHttp,
            ...(was.note ? { note: was.note } : {}),
          });
          if (!res.ok()) failures.push(`${host}: restore returned ${res.status()} ${await res.text()}`);
        } else if (current) {
          const res = await req.delete(`${baseUrl}/v1/egress-allow-hosts/${current.id}`, { headers: CSRF });
          if (!res.ok()) failures.push(`${host}: removal returned ${res.status()} ${await res.text()}`);
        }
      }
      if (failures.length > 0) throw new Error(`M-068: egress allow entries not put back: ${failures.join("; ")}`);
    },
  };
}
