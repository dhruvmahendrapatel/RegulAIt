/**
 * ADR-0210 — the OIDC profile's public metadata: the discovery document and the JWKS a standard OIDC validator (an
 * upstream MCP server's) fetches to verify an `oidc_bearer` identity assertion.
 *
 *   GET /mcp-identity/.well-known/openid-configuration   issuer `<public URL>/mcp-identity`, jwks_uri, ES256
 *   GET /mcp-identity/.well-known/jwks.json              the ES256 public halves only (active, and retired ones
 *                                                        inside their overlap; never a revoked key)
 *
 * Public by definition (public keys and metadata, fetched with no RegulAIt credential), like the workload identity
 * JWKS and the `/federation` issuer's documents (route-classes.ts). The Ed25519 keys are never listed here, and the
 * ES256 keys are never listed in `/.well-known/jwks.json`.
 */
import type { FastifyInstance } from "fastify";
import type { Db } from "@regulait/db";
import { MCP_IDENTITY_OIDC_DISCOVERY_PATH, MCP_IDENTITY_OIDC_JWKS_PATH } from "@regulait/shared";
import { jwksDocument, publishedSigningKeys } from "./identity-signing-keys.js";
import { mcpIdentityOidcDiscoveryDocument, mcpIdentityOidcIssuer } from "./mcp-identity-assertion.js";

export function registerMcpIdentityOidcRoutes(app: FastifyInstance, db: Db): void {
  app.get(MCP_IDENTITY_OIDC_DISCOVERY_PATH, async (_req, reply) => {
    const issuer = mcpIdentityOidcIssuer();
    if (!issuer) return reply.status(404).send({ error: "issuer_not_configured", detail: "the identity assertion issuer needs REGULAIT_PUBLIC_URL" });
    return reply.header("cache-control", "public, max-age=300").type("application/json").send(JSON.stringify(mcpIdentityOidcDiscoveryDocument(issuer)));
  });
  // short cache: a revocation must reach validators quickly
  app.get(MCP_IDENTITY_OIDC_JWKS_PATH, async (_req, reply) => {
    const doc = jwksDocument(await publishedSigningKeys(db, undefined, "ES256"));
    return reply.header("cache-control", "public, max-age=60").type("application/jwk-set+json").send(JSON.stringify(doc));
  });
}
