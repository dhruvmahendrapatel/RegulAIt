/**
 * ADR-0334: the managed browser extension's device, as the identity layer needs it. Kept apart from the routes so the
 * OAuth modules (token endpoint, self-token verifier) can read it without importing the route module.
 *
 * A browser extension is a workload identity of kind `browser_extension` (the endpoint agent's ADR-0195 SD4b pattern):
 * its install-time P-256 key is bound through S6's one-key-one-identity path, and it reaches the gateway only with an
 * S7 DPoP-bound self token. Its `browser_devices` row is what an admin revokes.
 */
import { and, BROWSER_IDENTITY_SETTING, browserDevices, eq, isNull, runWithRlsSystem, sql, type Db } from "@regulait/db";
import { BROWSER_EXTENSION_PATHS } from "@regulait/shared";

/** the routes a browser extension's self token reaches, and nothing else (`via: "browser-extension"`) */
export const BROWSER_EXTENSION_TOKEN_ROUTES: ReadonlySet<string> = new Set([
  `POST ${BROWSER_EXTENSION_PATHS.policy}`,
  `POST ${BROWSER_EXTENSION_PATHS.events}`,
  `POST ${BROWSER_EXTENSION_PATHS.promptCaptures}`,
]);

/** name the device's workload identity for the rest of the transaction `t` (what its row-level policies match) */
export const nameDeviceIdentity = (t: Db, identityId: string) => t.execute(sql`select set_config(${BROWSER_IDENTITY_SETTING}, ${identityId}, true)`);

/**
 * Row-level security (ADR-0234; security review #867): a device's statements run under `credential_request`, in one
 * transaction that names its workload identity in `regulait.browser_identity_id`, so the policies admit only that
 * device's own row and evidence. A missing or other identity matches no row. The scope is entered here rather than
 * inherited, because the token endpoint and the self-token check run before (or outside) the request's own scope.
 */
export function asDeviceIdentity<T>(db: Db, identityId: string, fn: (t: Db) => Promise<T>): Promise<T> {
  return runWithRlsSystem("credential_request", "browser-extension.device", () =>
    db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      await nameDeviceIdentity(t, identityId);
      return fn(t);
    }),
  );
}

/** is the identity a browser extension device that exists and is not revoked (read now, on every token use) */
export async function browserDeviceLive(db: Db, identityId: string): Promise<boolean> {
  const [row] = await asDeviceIdentity(db, identityId, (t) =>
    t
      .select({ id: browserDevices.id })
      .from(browserDevices)
      .where(and(eq(browserDevices.identityId, identityId), isNull(browserDevices.revokedAt)))
      .limit(1),
  );
  return Boolean(row);
}
