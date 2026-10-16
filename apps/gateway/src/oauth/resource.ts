/**
 * ADR-0188 decisions 5, 13, 17, 21 (slice S5) — DELEGATED TOKENS AT THE
 * RESOURCE: `POST /mcp/:serverId` and the compat model routes.
 *
 * A request carrying `Authorization: DPoP <jwt>`, or `Bearer <jwt>` whose JOSE
 * `typ` is `at+jwt` (a certificate-bound token, RFC 8705), is a WORKLOAD
 * request. The auth scheme is compared case-insensitively (RFC 9110 §11.1).
 * It is judged by S3's decision 13 verifier (`verifyDelegatedToken`) with:
 *  - the audience = the absolute URL of THIS route under the issuer (RFC 8707);
 *  - the environment = the deploy mode;
 *  - on the mTLS branch, ONLY a certificate that passed decision 21 here: the
 *    presented certificate is validated (`pkijs` path + profile) and must be
 *    a live registered credential of the grant's actor, or of a SPIFFE bundle
 *    entry, before its DER reaches the verifier's thumbprint comparison.
 * Every failure is a 401 with a short code; `use_dpop_nonce` carries a fresh
 * `DPoP-Nonce` (RFC 9449 §9). A valid token resolves to
 * `{via: "workload", userId: <sponsor>, isAdmin: false, workloadIdentityId,
 * delegationGrantId}` and reaches ONLY the routes in `WORKLOAD_ROUTES`.
 *
 * WIRED (S4+S5 follow-up): `DELEGATED_ROUTES_WIRED` is true, because every
 * route in `WORKLOAD_ROUTES` now passes the grant into the governed core, and a
 * workload call must name exactly its grant's project. The history below is
 * kept because it states the invariant the switch guards.
 *
 * FAIL CLOSED UNTIL THE GOVERNED PATHS READ THE GRANT. Authority under a
 * delegated token is the INTERSECTION of the sponsor, every actor and the
 * grant (decision 3); a route that ran the call as the sponsor alone would
 * hand the agent its sponsor's full rights. The governed call paths belong to
 * slice S4 (`executeGovernedToolCall` / dispatch take `delegationGrantId`).
 * Until those routes pass `req.authCtx.delegationGrantId` into the governed
 * core, `DELEGATED_ROUTES_WIRED` stays false and a verified workload request
 * is refused 403 `delegated_route_not_wired` AFTER verification (so a dead
 * chain is still a 401 and is still audited). Flipping it is part of the PR
 * that wires the routes; nothing else flips it.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { auditLog, engineRunners, eq, sql, type Db } from "@regulait/db";
import { verifyDelegatedToken, ACCESS_TOKEN_TYP } from "../delegated-token.js";
import { databaseNow } from "../delegation.js";
import { findWorkloadClient, matchCertificateCredential } from "./clients.js";
import { deploymentEnvironment, gatewayResource, identityIssuer, identitySecretsFor } from "./common.js";
import { presentedClientCertificate } from "./x509.js";
import { DELEGATED_ROUTES_WIRED } from "./wiring.js";
import { selfKindForResource, verifyWorkloadSelfToken } from "./workload-self.js";
import type { WorkloadSelfKind } from "@regulait/shared";
import type { AuthContext } from "../auth.js";

/** the routes a delegated token may reach (an allow-list: a new route is unreachable until named here) */
// written out (not imported from compat-core, which would put the auth hook in an import cycle); the S5 test pins
// them equal to compat-core's MCP_PROXY_ROUTE, COMPAT_ANTHROPIC_ROUTE, COMPAT_OPENAI_ROUTE and COMPAT_MODELS_ROUTE
export const WORKLOAD_ROUTES: ReadonlySet<string> = new Set(["POST /mcp/:serverId", "POST /v1/messages", "POST /v1/chat/completions", "GET /v1/models"]);

export { DELEGATED_ROUTES_WIRED } from "./wiring.js";

/** the project header the MCP proxy and the compat routes read (mcp-proxy's PROJECT_HEADER; the S5 test pins them equal) */
export const WORKLOAD_PROJECT_HEADER = "x-regulait-project-id";

export type WorkloadAuthOutcome =
  | { kind: "none" }
  | { kind: "ok"; ctx: AuthContext }
  | { kind: "refused"; status: 401 | 403 | 503; body: Record<string, unknown>; headers?: Record<string, string> };

/** the auth scheme and token of an Authorization value, scheme lower-cased (RFC 9110); no regular expression */
function schemeAndToken(header: string | undefined): { scheme: string; token: string } | null {
  if (typeof header !== "string") return null;
  const sp = header.indexOf(" ");
  if (sp <= 0) return null;
  const token = header.slice(sp + 1).trim();
  if (token.length === 0 || token.includes(" ")) return null;
  return { scheme: header.slice(0, sp).toLowerCase(), token };
}

/** is this Authorization header a delegated token (and not one of the gateway's own opaque credentials)? */
export function isDelegatedTokenHeader(header: string | undefined): boolean {
  const st = schemeAndToken(header);
  if (!st) return false;
  if (st.scheme === "dpop") return true;
  if (st.scheme !== "bearer" || st.token.split(".").length !== 3) return false;
  try {
    return decodeProtectedHeader(st.token).typ === ACCESS_TOKEN_TYP;
  } catch {
    return false;
  }
}

async function auditRefusal(db: Db, code: string, route: string, grantId: string | null) {
  await db.insert(auditLog).values({
    userId: "00000000-0000-0000-0000-000000000000",
    objectType: "delegation_grant",
    objectId: grantId,
    detail: { phase: "delegated-token-refused", code, route },
    effect: "deny",
    ruleId: "delegated-token-refused",
    ruleChain: [],
    reason: "a delegated access token was refused at a protected route (ADR-0188 decision 13)",
  });
}

/**
 * Authenticate a workload request. `none` = not a delegated token (the
 * caller's other credential paths run unchanged).
 */
export async function authenticateWorkloadRequest(db: Db, req: FastifyRequest, opts: { dataKey?: string | undefined }): Promise<WorkloadAuthOutcome> {
  const header = req.headers.authorization;
  if (!isDelegatedTokenHeader(header)) return { kind: "none" };
  const route = `${req.method} ${req.routeOptions.url ?? ""}`;
  const challenge = (error: string) => ({ "www-authenticate": `DPoP error="${error}", algs="EdDSA Ed25519 ES256"` });
  // ADR-0188 S7: an engine runner's or a PDP client's SELF token is recognised by the one control-plane audience
  // it names, on whatever route it is presented. It is verified as such (never as a delegated token), and the
  // route allow-lists then confine it exactly as they confined the bearer value it replaced (403 elsewhere).
  const selfKind = selfKindOfToken(header!);
  if (selfKind) return authenticateSelfRequest(db, req, route, selfKind, opts, challenge);
  if (!WORKLOAD_ROUTES.has(route)) {
    await auditRefusal(db, "workload_route_not_allowed", route, null);
    return { kind: "refused", status: 403, body: { error: "workload_scope", detail: "a delegated token reaches only the MCP proxy and the compat model routes" } };
  }
  const issuer = identityIssuer();
  const secrets = identitySecretsFor(opts.dataKey);
  if (!issuer || !secrets) return { kind: "refused", status: 503, body: { error: "issuer_not_configured" } };
  const path = new URL(req.url, "http://local").pathname;
  const audience = gatewayResource(issuer, `${issuer}${path}`);
  if (!audience) return { kind: "refused", status: 401, body: { error: "invalid_token", code: "audience_unknown" }, headers: challenge("invalid_token") };

  // decision 21: only a VALIDATED certificate of a registered credential reaches the mTLS branch
  let clientCertificateDer: Uint8Array | null = null;
  const presented = presentedClientCertificate(req);
  if (presented && schemeAndToken(header)!.scheme === "bearer") {
    const now = await databaseNow(db);
    let clientId: unknown;
    try {
      clientId = decodeJwt(schemeAndToken(header)!.token).client_id;
    } catch {
      clientId = undefined;
    }
    const client = typeof clientId === "string" ? await findWorkloadClient(db, clientId, now) : null;
    const m = client ? await matchCertificateCredential(db, client, presented, now) : null;
    if (m?.ok) clientCertificateDer = presented.der;
  }

  const search = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const request = new Request(`${issuer}${path}${search}`, {
    method: req.method,
    headers: {
      authorization: header!,
      ...(typeof req.headers.dpop === "string" ? { dpop: req.headers.dpop } : {}),
    },
  });
  const v = await verifyDelegatedToken(db, { request, audience, env: deploymentEnvironment(), issuer, secrets, clientCertificateDer });
  if (!v.ok) {
    await auditRefusal(db, v.code, route, null);
    return {
      kind: "refused",
      status: 401,
      body: { error: v.error, code: v.code },
      headers: { ...challenge(v.error), ...(v.dpopNonce ? { "dpop-nonce": v.dpopNonce } : {}) },
    };
  }
  const leaf = v.live.links[v.live.links.length - 1]!;
  if (!DELEGATED_ROUTES_WIRED) {
    await auditRefusal(db, "delegated_route_not_wired", route, v.grantId);
    return { kind: "refused", status: 403, body: { error: "delegated_route_not_wired", detail: "this route does not yet govern calls under a delegation grant" } };
  }
  // S4+S5 follow-up: the grant names its project (decision 4), so a workload call is attributed to that project and
  // no other. The routes read the project from this header; it must name exactly the grant's project (absent only
  // when the grant has none), or the call would be decided and billed under another project's facts.
  const projectHeader = req.headers[WORKLOAD_PROJECT_HEADER];
  const named = typeof projectHeader === "string" && projectHeader.length > 0 ? projectHeader.toLowerCase() : null;
  const grantProject = v.live.leaf.projectId ? v.live.leaf.projectId.toLowerCase() : null;
  if (Array.isArray(projectHeader) || named !== grantProject) {
    await auditRefusal(db, "delegation_project_mismatch", route, v.grantId);
    return {
      kind: "refused",
      status: 403,
      body: { error: "delegation_project_mismatch", detail: `send ${WORKLOAD_PROJECT_HEADER} naming exactly the project the delegation grant was made for` },
    };
  }
  return {
    kind: "ok",
    ctx: {
      userId: v.live.leaf.sponsorUserId,
      isAdmin: false,
      via: "workload",
      workloadIdentityId: leaf.identity.id,
      delegationGrantId: v.grantId,
      actorChain: v.live.links.map((l) => l.identity.id),
    },
  };
}

/** the self-token kind an Authorization header's token names by its (not yet verified) audience, or null */
function selfKindOfToken(header: string): WorkloadSelfKind | null {
  const issuer = identityIssuer();
  const st = schemeAndToken(header);
  // a self token presented as `Bearer` is still judged as one (and refused: it exists only DPoP-bound)
  if (!issuer || !st || (st.scheme !== "dpop" && st.scheme !== "bearer")) return null;
  let aud: unknown;
  try {
    aud = decodeJwt(st.token).aud;
  } catch {
    return null;
  }
  return typeof aud === "string" ? selfKindForResource(issuer, aud) : null;
}

/**
 * ADR-0188 S7 — a self token at a control-plane route: verified by
 * `verifyWorkloadSelfToken`; the context is the runner (its engine and row) or
 * the PDP client, never a person and never an admin. A delegated token is not
 * accepted here, and a self token is accepted nowhere else.
 */
async function authenticateSelfRequest(
  db: Db,
  req: FastifyRequest,
  route: string,
  kind: WorkloadSelfKind,
  opts: { dataKey?: string | undefined },
  challenge: (error: string) => Record<string, string>,
): Promise<WorkloadAuthOutcome> {
  const issuer = identityIssuer();
  const secrets = identitySecretsFor(opts.dataKey);
  if (!issuer || !secrets) return { kind: "refused", status: 503, body: { error: "issuer_not_configured" } };
  const path = new URL(req.url, "http://local").pathname;
  const search = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const request = new Request(`${issuer}${path}${search}`, {
    method: req.method,
    headers: {
      authorization: req.headers.authorization!,
      ...(typeof req.headers.dpop === "string" ? { dpop: req.headers.dpop } : {}),
    },
  });
  const v = await verifyWorkloadSelfToken(db, { request, kind, env: deploymentEnvironment(), issuer, secrets });
  if (!v.ok) {
    await auditSelfRefusal(db, v.code, route);
    // ADR-0187: the runner's loop reads a revoked runner as `revoked` (it re-enrols or stops and says so)
    const runnerRevoked = v.code === "engine_runner_revoked";
    return {
      kind: "refused",
      status: 401,
      body: runnerRevoked ? { error: "engine_runner_revoked", code: v.code, next: "revoked" } : { error: v.error, code: v.code },
      headers: { ...challenge(v.error), ...(v.dpopNonce ? { "dpop-nonce": v.dpopNonce } : {}) },
    };
  }
  const { identity, authCredentialId, runner } = v.subject;
  if (kind === "engine_runner") {
    // the ADR-0187 last-seen stamp the runner's bearer path kept
    // M-075: the database clock, as every other stamp on this row
    await db.update(engineRunners).set({ lastSeenAt: sql`now()` }).where(eq(engineRunners.id, runner!.id));
    return {
      kind: "ok",
      ctx: { userId: null, isAdmin: false, via: "engine-runner", engineRunnerId: runner!.id, engineId: runner!.engineId, workloadIdentityId: identity.id, workloadCredentialId: authCredentialId },
    };
  }
  return { kind: "ok", ctx: { userId: null, isAdmin: false, via: "pdp", workloadIdentityId: identity.id, workloadCredentialId: authCredentialId } };
}

async function auditSelfRefusal(db: Db, code: string, route: string) {
  await db.insert(auditLog).values({
    userId: "00000000-0000-0000-0000-000000000000",
    objectType: "workload_identity",
    objectId: null,
    detail: { phase: "workload-token-refused", code, route },
    effect: "deny",
    ruleId: "workload-token-refused",
    ruleChain: [],
    reason: "a workload self token was refused at a control-plane route (ADR-0188 S7)",
  });
}

/** send a refusal produced above */
export function sendWorkloadRefusal(reply: FastifyReply, out: Extract<WorkloadAuthOutcome, { kind: "refused" }>) {
  for (const [k, v] of Object.entries(out.headers ?? {})) void reply.header(k, v);
  return reply.status(out.status).send(out.body);
}
