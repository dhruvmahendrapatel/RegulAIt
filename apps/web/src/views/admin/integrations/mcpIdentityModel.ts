/**
 * ADR-0188 S8 — outbound MCP identity, the pure half of the screen: the per-server setting's options and labels,
 * the assertion's format as the admin and the upstream operator read it, and the verification example.
 *
 * The format is set by the gateway (`apps/gateway/src/mcp-identity-assertion.ts`, constants in
 * `packages/shared/src/identity/mcp-identity-assertion.ts`) and documented in `docs/api/MCP_IDENTITY_ASSERTION.md`.
 * `mcpIdentityModel.test.ts` holds this file's example byte-equal to the doc's, and the gateway suite runs the doc's
 * example against a live JWKS, so the snippet shown here is one that has been run.
 */

export type IdentityPropagation = "none" | "signed_assertion";

export const IDENTITY_PROPAGATION_OPTIONS: ReadonlyArray<{ value: IdentityPropagation; label: string }> = [
  { value: "none", label: "Send nothing (default)" },
  { value: "signed_assertion", label: "Signed assertion per call" },
];

/** the request header and JOSE `typ` (the gateway's constants, restated for the screen) */
export const IDENTITY_ASSERTION_HEADER = "RegulAIt-Identity-Assertion";
export const IDENTITY_ASSERTION_TYP = "regulait-mcp-identity+jwt";
export const JWKS_PATH = "/.well-known/jwks.json";

export function identityPropagationOf(server: { identityPropagation?: string | null }): IdentityPropagation {
  return server.identityPropagation === "signed_assertion" ? "signed_assertion" : "none";
}

/**
 * The S8 follow-up: how the agents in `act` are named for one server. `pairwise` (the default) is a per-server id;
 * `workload_id` sends each agent's global workload identifier (its SPIFFE ID) as stored. Only while a signed
 * assertion is sent: anything else reads as the strict value.
 */
export type AgentIdForm = "pairwise" | "workload_id";

export const AGENT_ID_FORM_OPTIONS: ReadonlyArray<{ value: AgentIdForm; label: string }> = [
  { value: "pairwise", label: "Pairwise id per server (default)" },
  { value: "workload_id", label: "Agent workload IDs (SPIFFE)" },
];

export function agentIdFormOf(server: { identityPropagation?: string | null; discloseAgentWorkloadIds?: boolean | null }): AgentIdForm {
  return identityPropagationOf(server) === "signed_assertion" && server.discloseAgentWorkloadIds === true ? "workload_id" : "pairwise";
}

/**
 * The audience an assertion for this server names: the canonical server URI (scheme, host, port, path; no query,
 * fragment or credentials). The same rule as the gateway's `canonicalMcpAudience`.
 */
export function canonicalAudience(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  return `${u.origin}${u.pathname}`;
}

/** the claims, as the screen lists them (the doc's table, shortened) */
export const ASSERTION_CLAIMS: ReadonlyArray<{ claim: string; meaning: string }> = [
  { claim: "iss", meaning: "this deployment's public URL (REGULAIT_PUBLIC_URL)" },
  { claim: "aud", meaning: "this server's URL, without query, fragment or credentials" },
  { claim: "sub", meaning: "the person the call is for, as a pairwise id: stable for this server, unlinkable across servers; never an email, name or user id" },
  {
    claim: "act",
    meaning:
      "only when an agent acts: the chain of agents, the acting agent outermost, each as a pairwise id for this server (never its global workload id), unless this server is set to disclose agent workload IDs",
  },
  { claim: "iat / exp", meaning: "a 60-second lifetime" },
  { claim: "jti", meaning: "unique per assertion: the upstream's replay key" },
];

/** the verification example: byte-equal to the code block in docs/api/MCP_IDENTITY_ASSERTION.md */
export const VERIFY_EXAMPLE = `import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Verify the RegulAIt-Identity-Assertion header of an incoming MCP request.
 *  issuer:   the RegulAIt deployment's public URL, e.g. "https://regulait.example.com"
 *  audience: the audience shown on the server's card in RegulAIt,
 *            e.g. "https://mcp.example.com/mcp"
 */
export function regulaitIdentityVerifier({ issuer, audience }) {
  const jwks = createRemoteJWKSet(new URL(\`\${issuer}/.well-known/jwks.json\`));
  const seen = new Map(); // jti -> exp: each assertion is accepted once
  return async function verify(assertion) {
    const { payload } = await jwtVerify(assertion, jwks, {
      issuer,
      audience,
      typ: "regulait-mcp-identity+jwt",
      algorithms: ["EdDSA"],
      maxTokenAge: "60s",
      clockTolerance: 5,
      requiredClaims: ["sub", "jti", "iat", "exp"],
    });
    const now = Math.floor(Date.now() / 1000);
    for (const [jti, exp] of seen) if (exp + 5 < now) seen.delete(jti);
    if (seen.has(payload.jti)) throw new Error("replayed identity assertion");
    seen.set(payload.jti, payload.exp);
    const actors = [];
    for (let a = payload.act; a; a = a.act) actors.unshift(a.sub);
    // subject: the pairwise id of the person; actors: the agents, root first, acting agent last
    // (pairwise ids, or workload IDs if this server was set to disclose them)
    return { subject: payload.sub, actors };
  };
}
`;
