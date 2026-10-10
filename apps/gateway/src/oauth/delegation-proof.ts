/**
 * ADR-0188 decision 15 step 1 (slice S5) — THE HUMAN DELEGATION PROOF.
 *
 * `POST /v1/delegations/proofs`: a person starts a delegation to one agent.
 * OWNER DECISION 4: only a browser session or an API key (whose owner meets
 * the org MFA rule, enforced by the auth hook, ADR-0181 FX2); never the
 * bootstrap token (no person), a virtual key (already a delegated
 * credential), a runner credential or a delegated token. A `write` scope on a
 * CLASSIFIED project (one with compliance tags, §8.3) also needs a step-up,
 * as approvals do (ADR-0186).
 *
 * WHO MAY DELEGATE WHAT (S5 security review item 2): the person must be a
 * STEWARD of the agent (listed in its `sponsor_user_ids`) and must have access
 * to the project (`assertProjectAttribution`, ADR-0011). STRICT ROOTS (item 6,
 * ADR-0180): a cap is required unless the org set a default cap or allows
 * uncapped roots, and the lifetime defaults to 15 minutes and may not pass the
 * org's `delegation_root_max_lifetime_seconds`. Every refusal is audited.
 *
 * The response is a ONE-USE signed JWT (`typ` `regulait-delegation-proof+jwt`,
 * EdDSA under the issuer's current key, 120 s): never a cookie or a session
 * token. It binds the person (`sub`), the agent identity (`agent`), the
 * agent's output key thumbprint when given (`child_cnf`), and the RFC 8785
 * canonical form of the WHOLE delegation body (`delegation`: scope, resource,
 * project, environment, cap, further depth, expiry). The token endpoint
 * accepts it once (`human_delegation_proof` replay claim) and only for exactly
 * that body. Nothing here creates a grant: the agent must still authenticate
 * and prove its key at the token endpoint.
 */
import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { decodeProtectedHeader, importJWK, jwtVerify, SignJWT, type JWK, type JWTPayload } from "jose";
import { auditLog, eq, projects, workloadIdentities, type Db } from "@regulait/db";
import {
  canonicalDelegationBody,
  createDelegationProofSchema,
  DEFAULT_ROOT_GRANT_LIFETIME_SECONDS,
  DELEGATION_PROOF_TTL_SECONDS,
  DELEGATION_PROOF_TYP,
  type DelegationBody,
} from "@regulait/shared";
import { databaseNow, identityServiceFailure } from "../delegation.js";
import { currentIssuerSigner, ISSUER_JWS_ALG, publishedSigningKeys, signingKeyAccepts } from "../identity-signing-keys.js";
import { loadOrgSettings } from "../org-settings.js";
import { assertProjectAttribution } from "../projects.js";
import { requireStepUp } from "../step-up.js";
import { deploymentEnvironment, gatewayResource, identityIssuer } from "./common.js";

/**
 * A root grant's cap and lifetime under the org's strict-root settings (S5
 * review item 6), shared by the proof route and the root exchange so a setting
 * tightened between the two still applies. `requested` null = the person named
 * no cap.
 */
export function rootCapFor(requested: number | null | undefined, org: { delegationUncappedRootAllowed: boolean; delegationRootDefaultCapMicros: number }): { ok: true; cap: number | null } | { ok: false } {
  if (requested !== null && requested !== undefined) return { ok: true, cap: requested };
  if (org.delegationRootDefaultCapMicros > 0) return { ok: true, cap: org.delegationRootDefaultCapMicros };
  return org.delegationUncappedRootAllowed ? { ok: true, cap: null } : { ok: false };
}
export const rootLifetimeFor = (requested: number | undefined, org: { delegationRootMaxLifetimeSeconds: number }) =>
  requested ?? Math.min(DEFAULT_ROOT_GRANT_LIFETIME_SECONDS, org.delegationRootMaxLifetimeSeconds);

export interface VerifiedDelegationProof {
  jti: string;
  sponsorUserId: string;
  agentIdentityId: string;
  childCnf: string | null;
  body: DelegationBody;
  canonical: string;
  exp: number;
}

/** POST /v1/delegations/proofs */
export async function createDelegationProofRoute(db: Db, req: FastifyRequest, reply: FastifyReply) {
  const ctx = req.authCtx;
  // OWNER DECISION 4: a person, by session or by their own API key, and nothing else
  if (!ctx.userId || (ctx.via !== "session" && ctx.via !== "api-key")) {
    return reply.status(403).send({ error: "delegation_proof_credential", detail: "a delegation is started by a signed-in person or their own API key" });
  }
  const issuer = identityIssuer();
  if (!issuer) return reply.status(503).send({ error: "issuer_not_configured", detail: "REGULAIT_PUBLIC_URL must name this deployment" });
  const body = createDelegationProofSchema.parse(req.body ?? {});
  const env = deploymentEnvironment();
  if (body.env !== env) return reply.status(400).send({ error: "env_mismatch", detail: `this deployment serves '${env}'` });
  const resource = gatewayResource(issuer, body.resource);
  if (!resource) return reply.status(400).send({ error: "invalid_target", detail: "the resource is not one of this gateway's protected resources" });

  const userId = ctx.userId;
  /** every refusal past the credential check is an audited deny (S5 review items 2 and 6) */
  const refuseProof = async (status: number, error: string, detail: string) => {
    await db.insert(auditLog).values({
      userId,
      objectType: "delegation_grant",
      objectId: null,
      detail: { phase: "delegation-proof", code: error, agentIdentityId: body.agentIdentityId, projectId: body.projectId, via: ctx.via },
      effect: "deny",
      ruleId: "delegation-proof-refused",
      ruleChain: [],
      reason: `a delegation proof was refused: ${error} (ADR-0188 decision 15, S5 review)`,
    });
    return reply.status(status).send({ error, detail });
  };
  const [ident] = await db.select().from(workloadIdentities).where(eq(workloadIdentities.id, body.agentIdentityId));
  // an identity that is not in service could never be granted: say so now, with the same predicate (S3)
  if (!ident || identityServiceFailure({ ...ident, agentHaltedAt: null, agentLifecycle: null, agentEnabled: true, builderArchivedAt: null, runnerRevokedAt: null }, env) !== null) {
    return reply.status(400).send({ error: "agent_identity_unavailable", detail: "no active workload identity with that id in this environment" });
  }
  // S5 review item 2: only a steward of THIS agent may delegate to it
  if (!ident.sponsorUserIds.includes(userId)) {
    return refuseProof(403, "delegation_not_steward", "only a steward of this agent may delegate to it");
  }
  const [project] = await db.select({ id: projects.id, classifications: projects.classifications }).from(projects).where(eq(projects.id, body.projectId));
  if (!project) return reply.status(400).send({ error: "project_not_found" });
  // ... and only on a project the person may work on (the gateway's project check, ADR-0011)
  const access = await assertProjectAttribution(db, project.id, userId, ctx.isAdmin);
  if (!access.ok) return refuseProof(403, "delegation_project_access", "you do not have access to this project");
  const org = await loadOrgSettings(db);
  const maxDepth = body.maxDepth ?? org.delegationMaxDepth;
  if (maxDepth > org.delegationMaxDepth) {
    return reply.status(400).send({ error: "delegation_depth", detail: `at most ${org.delegationMaxDepth} further delegations` });
  }
  // S5 review item 6 (ADR-0180): a cap is required and the lifetime is short, unless an admin relaxed either
  const cap = rootCapFor(body.capMicros, org);
  if (!cap.ok) return refuseProof(400, "delegation_cap_required", "name a spending cap: this organisation does not allow uncapped delegations");
  const lifetime = rootLifetimeFor(body.lifetimeSeconds, org);
  if (lifetime > org.delegationRootMaxLifetimeSeconds) {
    return refuseProof(400, "delegation_lifetime", `a delegation lives at most ${org.delegationRootMaxLifetimeSeconds} seconds in this organisation`);
  }
  const writes = body.authorizationDetails.some((s) => s.kind === "write");
  if (writes && (project.classifications ?? []).length > 0) {
    const su = await requireStepUp(db, req, reply, {
      kind: "identity_manage",
      facts: { op: "delegation_proof", agentIdentityId: ident.id, projectId: project.id, resource },
    });
    if (!su.ok) return reply;
  }

  const now = await databaseNow(db);
  const iat = Math.floor(now.getTime() / 1000);
  const delegation: DelegationBody = {
    authorization_details: body.authorizationDetails,
    resource,
    project_id: project.id,
    env,
    cap_micros: cap.cap,
    max_depth: maxDepth,
    expires_at: iat + lifetime,
  };
  const canonical = canonicalDelegationBody(delegation);
  const signer = await currentIssuerSigner(db);
  const jti = randomBytes(32).toString("base64url");
  const proof = await new SignJWT({
    agent: ident.id,
    ...(body.agentKeyThumbprint ? { child_cnf: body.agentKeyThumbprint } : {}),
    delegation: canonical,
  })
    .setProtectedHeader({ alg: ISSUER_JWS_ALG, typ: DELEGATION_PROOF_TYP, kid: signer.kid })
    .setIssuer(issuer)
    .setAudience(issuer)
    .setSubject(userId)
    .setJti(jti)
    .setIssuedAt(Math.max(iat, Math.floor(signer.activatedAt.getTime() / 1000)))
    .setExpirationTime(iat + DELEGATION_PROOF_TTL_SECONDS)
    .sign(signer.privateKey);
  await db.insert(auditLog).values({
    userId,
    objectType: "delegation_grant",
    objectId: null,
    detail: { phase: "delegation-proof", agentIdentityId: ident.id, projectId: project.id, resource, env, capMicros: delegation.cap_micros, maxDepth, expiresAt: delegation.expires_at, via: ctx.via },
    effect: "allow",
    ruleId: "delegation-proof",
    ruleChain: [],
    reason: "a person issued a one-use delegation proof to a workload identity (ADR-0188 decision 15)",
  });
  return reply.status(201).send({ proof, expiresIn: DELEGATION_PROOF_TTL_SECONDS, delegation });
}

/**
 * Verify a delegation proof (signature by a published issuer key the key's
 * lifecycle accepts, `typ`, `iss`/`aud` = our issuer, expiry on the DATABASE
 * clock, the body parses). Claims nothing.
 */
export async function verifyDelegationProof(db: Db, token: string, issuer: string, now: Date): Promise<VerifiedDelegationProof | null> {
  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return null;
  }
  if (header.alg !== ISSUER_JWS_ALG || header.typ !== DELEGATION_PROOF_TYP || typeof header.kid !== "string") return null;
  const key = (await publishedSigningKeys(db, now)).find((k) => k.kid === header.kid);
  if (!key) return null;
  let p: JWTPayload;
  try {
    p = (
      await jwtVerify(token, await importJWK({ kty: "OKP", crv: "Ed25519", x: key.publicJwk.x } as JWK, ISSUER_JWS_ALG), {
        algorithms: [ISSUER_JWS_ALG],
        typ: DELEGATION_PROOF_TYP,
        issuer,
        audience: issuer,
        currentDate: now,
        requiredClaims: ["sub", "jti", "iat", "exp"],
      })
    ).payload;
  } catch {
    return null;
  }
  if (!signingKeyAccepts(key, p.iat!, now)) return null;
  if (typeof p.agent !== "string" || typeof p.delegation !== "string" || typeof p.jti !== "string") return null;
  if (p.exp! - p.iat! > DELEGATION_PROOF_TTL_SECONDS) return null;
  let body: DelegationBody;
  try {
    body = JSON.parse(p.delegation) as DelegationBody;
    if (canonicalDelegationBody(body) !== p.delegation) return null;
  } catch {
    return null;
  }
  return {
    jti: p.jti,
    sponsorUserId: p.sub!,
    agentIdentityId: p.agent,
    childCnf: typeof p.child_cnf === "string" ? p.child_cnf : null,
    body,
    canonical: p.delegation,
    exp: p.exp!,
  };
}
