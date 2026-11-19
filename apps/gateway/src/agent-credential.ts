/**
 * ADR-0315 (G7, slice 1): the portable, offline-verifiable agent credential. A signed projection of ONE live
 * delegation grant onto ONE registered audience (a third-party enforcement point), in the format of
 * `@regulait/shared` `agent-credential.ts` (RFC 9068 `at+jwt`, RFC 8693 `act`, RFC 9449 `cnf.jkt`).
 *
 * What it never does: widen. The scope is the INTERSECTION of the grant's scope with the audience's scope map (an
 * atom with no mapping row is dropped; nothing maps to more than its atom), and the grant itself never exceeds its
 * sponsor's entitlements, its parent's scope or its parent's remaining budget (ADR-0188 S3, enforced where grants are
 * admitted). Every refusal is a refusal, never a narrower token, and is audited with codes and ids only.
 *
 * Checked at mint, fresh (database clock): the audience is registered and enabled; the binding matches it (a DPoP key
 * thumbprint unless the audience is `bearer`); every link of the grant's chain is live (`loadLiveChain`: not revoked,
 * not expired, identities active, sponsor enabled, placements good, the org dial not `halted` and no agent on the path
 * halted, ADR-0124); a capped grant has budget left; the issuer and its signer exist. The lifetime is the smallest of the
 * requested one, the audience's maximum and the grant's remaining lifetime.
 *
 * Keys: the existing `identity_signing_keys` signers (ES256 by default, EdDSA if the audience pins it); their JWKS is
 * served at `/agent-credentials/.well-known/jwks.json` (agent-credential-routes.ts).
 */
import { randomBytes } from "node:crypto";
import { createLocalJWKSet, jwtVerify, SignJWT, type JSONWebKeySet, type JWTPayload } from "jose";
import {
  AGENT_CREDENTIAL_ISSUER_PATH,
  AGENT_CREDENTIAL_LEEWAY_SECONDS,
  AGENT_CREDENTIAL_TTL_DEFAULT_SECONDS,
  AGENT_CREDENTIAL_TTL_MIN_SECONDS,
  AGENT_CREDENTIAL_TYP,
  agentCredentialActClaim,
  type AgentCredentialAlgorithm,
  type AgentCredentialClaims,
  type DelegationScopeItem,
} from "@regulait/shared";
import { agentCredentialAudiences, agentCredentialAudienceScopes, agentCredentialsIssued, auditLog, eq, type Db } from "@regulait/db";
import { databaseNow } from "./db-clock.js";
import { loadLiveChain, remainingMicros } from "./delegation.js";
import { pairwiseSubject } from "./delegated-token.js";
import { currentIssuerSigner, IdentitySigningKeyError } from "./identity-signing-keys.js";
import { identityIssuer, identitySecretsFor } from "./oauth/common.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** the issuer string: `<public URL>/agent-credentials`; null when the public URL is not configured */
/**
 * An audience's lifecycle, declared once (owner build rule 12). Derived from `disabled_at`, never stored:
 * `enabled` can be disabled (free, audited: it only narrows); `disabled` is terminal, because re-enabling would widen
 * issuance and is a new registration (with its step-up), not a toggle.
 */
export const AUDIENCE_STATES = ["enabled", "disabled"] as const;
export type AudienceState = (typeof AUDIENCE_STATES)[number];
export const AUDIENCE_TRANSITIONS: Readonly<Record<AudienceState, readonly AudienceState[]>> = Object.freeze({
  enabled: ["disabled"],
  disabled: [],
});
export function audienceState(r: { disabledAt: Date | null }): AudienceState {
  return r.disabledAt ? "disabled" : "enabled";
}
/** only an enabled audience is issued to */
export const audienceIssues = (r: { disabledAt: Date | null }) => audienceState(r) === "enabled";

export function agentCredentialIssuer(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = identityIssuer(env);
  return base ? `${base.replace(/\/+$/, "")}${AGENT_CREDENTIAL_ISSUER_PATH}` : null;
}

/** the `identity_signing_keys` algorithm behind each pinnable JWS algorithm */
export const SIGNING_KEY_ALGORITHM_OF = { ES256: "ES256", EdDSA: "Ed25519" } as const satisfies Record<AgentCredentialAlgorithm, string>;

export type AgentCredentialRefusalCode =
  | "audience_unknown"
  | "audience_disabled"
  | "dpop_required"
  | "grant_unknown"
  | "grant_not_live"
  | "org_halted"
  | "agent_halted"
  | "budget_exhausted"
  | "scope_empty"
  | "issuer_not_configured"
  | "secrets_not_configured"
  | "signing_key_unavailable";

export class AgentCredentialRefused extends Error {
  constructor(
    readonly code: AgentCredentialRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentCredentialRefused";
  }
}

type ScopeRow = typeof agentCredentialAudienceScopes.$inferSelect;

/**
 * The projection (pure): every mapping row whose atom the grant holds contributes its scope string. `mcp_tool` atoms
 * name several tools; a row matches when its tool is among them. A `read` row is satisfied by a `write` atom of the
 * same resource only if the grant holds that resource for write (write includes read, as the delegation kernel
 * treats it); a `write` row needs a `write` atom. Returns the sorted, de-duplicated scope strings.
 */
export function projectScope(grantScope: readonly DelegationScopeItem[], mappings: readonly ScopeRow[]): string[] {
  const holds = (row: ScopeRow): boolean =>
    grantScope.some((a) => {
      const kindOk = row.kind === "read" ? a.kind === "read" || a.kind === "write" : a.kind === "write";
      if (!kindOk) return false;
      if (row.resourceType === "mcp_tool") return a.type === "mcp_tool" && a.serverId === row.serverId && (a.toolNames ?? []).includes(row.toolName ?? "");
      if (row.resourceType === "connector") return a.type === "connector" && a.connectorId === row.connectorId;
      return a.type === "agent" && a.agentId === row.agentId;
    });
  return [...new Set(mappings.filter(holds).map((r) => r.scope))].sort();
}

export interface MintAgentCredentialInput {
  grantId: string;
  audienceId: string;
  /** the RFC 7638 thumbprint of the holder's DPoP key; required unless the audience is `bearer` */
  holderJkt: string | null;
  /** the lifetime asked for; bounded by the audience's maximum and the grant's remaining lifetime */
  ttlSeconds?: number;
  dataKey: string | undefined;
  /** the user (or NIL) the audit row names; the token endpoint passes the sponsor */
  env?: NodeJS.ProcessEnv;
}

export interface MintedAgentCredential {
  token: string;
  jti: string;
  claims: AgentCredentialClaims;
  kid: string;
  alg: AgentCredentialAlgorithm;
}

async function auditRefusal(db: Db, input: MintAgentCredentialInput, code: AgentCredentialRefusalCode, sponsorUserId: string | null): Promise<void> {
  await db.insert(auditLog).values({
    userId: sponsorUserId ?? NIL_UUID,
    objectType: "agent_credential",
    objectId: null,
    detail: { subsystem: "agent-credential", grantId: input.grantId, audienceId: input.audienceId, code },
    effect: "deny",
    ruleId: "agent-credential-refused",
    ruleChain: [],
    reason: `an agent credential was refused: ${code}`,
  });
}

/** mint one credential, or throw `AgentCredentialRefused` (audited) */
export async function mintAgentCredential(db: Db, input: MintAgentCredentialInput): Promise<MintedAgentCredential> {
  let sponsor: string | null = null;
  const refuse = async (code: AgentCredentialRefusalCode, message: string): Promise<never> => {
    await auditRefusal(db, input, code, sponsor);
    throw new AgentCredentialRefused(code, message);
  };

  const [audience] = await db.select().from(agentCredentialAudiences).where(eq(agentCredentialAudiences.id, input.audienceId));
  if (!audience) return refuse("audience_unknown", "no such registered audience");
  if (!audienceIssues(audience)) return refuse("audience_disabled", "this audience is disabled");
  if (audience.binding === "dpop" && !input.holderJkt) return refuse("dpop_required", "this audience requires a DPoP-bound credential");

  const now = await databaseNow(db);
  const live = await loadLiveChain(db, input.grantId, now);
  if (!live) return refuse("grant_unknown", "no such delegation grant");
  sponsor = live.leaf.sponsorUserId;
  // the live-chain predicate already covers the ADR-0124 kill switch (org dial halted, a halted agent on the path),
  // suspended or revoked identities, a disabled sponsor, revocation and expiry: one fresh check, the delegation's own
  if (live.failure) {
    const f = live.failure.code;
    if (f === "org_halted") return refuse("org_halted", "the organisation's execution mode is halted");
    if (f === "agent_halted") return refuse("agent_halted", "an agent in the delegation chain is halted");
    return refuse("grant_not_live", `link ${live.failure.index} of the delegation chain is not live (${f})`);
  }
  const identityIds = live.links.map((l) => l.identity.id);

  const remaining = remainingMicros(live.leaf);
  if (remaining !== null && remaining <= 0) return refuse("budget_exhausted", "the grant has no budget left");

  const mappings = await db.select().from(agentCredentialAudienceScopes).where(eq(agentCredentialAudienceScopes.audienceId, audience.id));
  const scope = projectScope(live.leaf.scope, mappings);
  if (scope.length === 0) return refuse("scope_empty", "nothing the grant holds is mapped at this audience");

  const issuer = agentCredentialIssuer(input.env);
  if (!issuer) return refuse("issuer_not_configured", "the agent credential issuer needs REGULAIT_PUBLIC_URL");
  const secrets = identitySecretsFor(input.dataKey);
  if (!secrets) return refuse("secrets_not_configured", "the pairwise key needs the data key");
  const alg = audience.algorithm;
  let signer;
  try {
    signer = await currentIssuerSigner(db, input.env, SIGNING_KEY_ALGORITHM_OF[alg]);
  } catch (err) {
    if (err instanceof IdentitySigningKeyError) return refuse("signing_key_unavailable", "no active signing key for the audience's algorithm");
    throw err;
  }

  const iat = Math.floor(now.getTime() / 1000);
  const grantLeft = Math.floor((live.leaf.expiresAt.getTime() - now.getTime()) / 1000);
  const ttl = Math.min(input.ttlSeconds ?? AGENT_CREDENTIAL_TTL_DEFAULT_SECONDS, audience.maxTtlSeconds, grantLeft);
  if (ttl < AGENT_CREDENTIAL_TTL_MIN_SECONDS) return refuse("grant_not_live", "the grant expires too soon for a credential");
  const jti = randomBytes(32).toString("base64url");
  const leaf = live.links[live.links.length - 1]!;
  const act = live.links.length > 1 ? agentCredentialActClaim(live.links.map((l) => l.identity.identifier)) : undefined;
  const claims: AgentCredentialClaims = {
    iss: issuer,
    aud: audience.audience,
    sub: pairwiseSubject(secrets.pairwiseKey, audience.audience, live.leaf.sponsorUserId),
    client_id: leaf.identity.identifier,
    ...(act ? { act } : {}),
    scope: scope.join(" "),
    regulait_grant: live.leaf.id,
    ...(live.leaf.runId ? { regulait_run: live.leaf.runId } : {}),
    ...(remaining !== null && live.leaf.capMicros !== null ? { regulait_budget: { currency: "USD" as const, cap_micros: live.leaf.capMicros, remaining_micros: remaining } } : {}),
    ...(audience.binding === "dpop" && input.holderJkt ? { cnf: { jkt: input.holderJkt } } : {}),
    iat,
    nbf: iat,
    exp: iat + ttl,
    jti,
  };
  const { iss, aud, sub, iat: _i, nbf: _n, exp: _e, jti: _j, ...rest } = claims;
  const token = await new SignJWT(rest as unknown as JWTPayload)
    .setProtectedHeader({ alg, typ: AGENT_CREDENTIAL_TYP, kid: signer.kid })
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject(sub)
    .setIssuedAt(iat)
    .setNotBefore(iat)
    .setExpirationTime(iat + ttl)
    .setJti(jti)
    .sign(signer.privateKey);

  // the issued row and its audit commit together; the token itself is never stored
  await db.transaction(async (tx) => {
    await tx.insert(agentCredentialsIssued).values({ jti, audienceId: audience.id, grantId: live.leaf.id, issuedAt: now, expiresAt: new Date((iat + ttl) * 1000) });
    await tx.insert(auditLog).values({
      userId: live.leaf.sponsorUserId,
      objectType: "agent_credential",
      objectId: null,
      detail: { subsystem: "agent-credential", jti, audienceId: audience.id, grantId: live.leaf.id, chain: identityIds, scope, ttlSeconds: ttl, alg, kid: signer.kid, binding: audience.binding },
      effect: "allow",
      ruleId: "agent-credential-issued",
      ruleChain: [],
      reason: `agent credential issued for audience '${audience.name}' (${scope.length} scope value(s), ${ttl} s)`,
    });
  });
  return { token, jti, claims, kid: signer.kid, alg };
}

/**
 * THE REFERENCE VERIFIER (offline): what ADR-0315 §4 asks of a third party, executable. The algorithm is the
 * audience's PINNED one (never read from the token); `typ`, `iss`, `aud` and the time claims are checked with the
 * documented leeway; when `holderJkt` is given (the verifier checked a DPoP proof), it must equal `cnf.jkt`, and a
 * DPoP-bound credential without it is refused. The status-list check is slice 2.
 */
export async function verifyAgentCredential(
  token: string,
  opts: { jwks: JSONWebKeySet; issuer: string; audience: string; algorithm: AgentCredentialAlgorithm; binding: "dpop" | "bearer"; holderJkt?: string; now?: Date },
): Promise<AgentCredentialClaims> {
  const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(opts.jwks), {
    algorithms: [opts.algorithm],
    issuer: opts.issuer,
    audience: opts.audience,
    typ: AGENT_CREDENTIAL_TYP,
    clockTolerance: AGENT_CREDENTIAL_LEEWAY_SECONDS,
    requiredClaims: ["iss", "aud", "sub", "exp", "nbf", "iat", "jti"],
    ...(opts.now ? { currentDate: opts.now } : {}),
  });
  if (!protectedHeader.kid) throw new Error("the credential names no kid");
  const claims = payload as unknown as AgentCredentialClaims;
  if (typeof claims.client_id !== "string" || typeof claims.scope !== "string" || typeof claims.regulait_grant !== "string") throw new Error("the credential lacks a required claim");
  if (opts.binding === "dpop") {
    if (!claims.cnf?.jkt) throw new Error("a DPoP audience's credential must carry cnf.jkt");
    if (opts.holderJkt !== claims.cnf.jkt) throw new Error("the DPoP key does not match cnf.jkt");
  }
  return claims;
}
