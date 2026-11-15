/**
 * ADR-0334: the managed browser extension's device, as the identity layer needs it. Kept apart from the routes so the
 * OAuth modules (token endpoint, self-token verifier) can read it without importing the route module.
 *
 * A browser extension is a workload identity of kind `browser_extension` (the endpoint agent's ADR-0195 SD4b pattern):
 * its install-time P-256 key is bound through S6's one-key-one-identity path, and it reaches the gateway only with an
 * S7 DPoP-bound self token. Its `browser_devices` row is what an admin revokes.
 */
import { and, browserDevices, eq, isNull, type Db } from "@regulait/db";
import { BROWSER_EXTENSION_PATHS } from "@regulait/shared";

/** the routes a browser extension's self token reaches, and nothing else (`via: "browser-extension"`) */
export const BROWSER_EXTENSION_TOKEN_ROUTES: ReadonlySet<string> = new Set([
  `POST ${BROWSER_EXTENSION_PATHS.policy}`,
  `POST ${BROWSER_EXTENSION_PATHS.events}`,
  `POST ${BROWSER_EXTENSION_PATHS.promptCaptures}`,
]);

/** is the identity a browser extension device that exists and is not revoked (read now, on every token use) */
export async function browserDeviceLive(db: Db, identityId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: browserDevices.id })
    .from(browserDevices)
    .where(and(eq(browserDevices.identityId, identityId), isNull(browserDevices.revokedAt)))
    .limit(1);
  return Boolean(row);
}
