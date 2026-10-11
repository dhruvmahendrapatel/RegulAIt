/**
 * ADR-0188 slice S5 — whether the routes a delegated token reaches GOVERN the
 * call under its delegation grant (see `oauth/resource.ts`'s header). True
 * since the S4+S5 follow-up: every route in `WORKLOAD_ROUTES` passes
 * `req.authCtx.delegationGrantId` into the governed core (S4 amendment item 7):
 * `/mcp/:serverId` tools/call, tools/list (narrowed to the chain), every other
 * protocol method and the logging relay; the compat dispatch; and the
 * `/v1/models` listing. The resource check also binds the call to the grant's
 * project. While it was false, a verified delegated token was refused 403
 * `delegated_route_not_wired`, and the RFC 9728 document did not advertise the
 * issuer (never advertise what is refused, ADR-0097). Its own module so the
 * metadata document can read it without importing the verifier.
 */
export const DELEGATED_ROUTES_WIRED: boolean = true;
