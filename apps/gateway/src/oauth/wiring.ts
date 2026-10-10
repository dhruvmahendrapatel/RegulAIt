/**
 * ADR-0188 slice S5 — whether the routes a delegated token reaches GOVERN the
 * call under its delegation grant (see `oauth/resource.ts`'s header). False
 * until S4's governed paths read `req.authCtx.delegationGrantId` on every
 * route in `WORKLOAD_ROUTES`; the PR that wires them flips it. While false, a
 * verified delegated token is refused 403 `delegated_route_not_wired`, and the
 * RFC 9728 document does not advertise the issuer (never advertise what is
 * refused, ADR-0097). Its own module so the metadata document can read it
 * without importing the verifier.
 */
export const DELEGATED_ROUTES_WIRED: boolean = false;
