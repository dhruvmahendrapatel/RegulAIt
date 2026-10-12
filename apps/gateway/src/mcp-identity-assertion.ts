/**
 * ADR-0188 slice S8 — OUTBOUND MCP IDENTITY: a signed assertion per call
 * (decision 8; the format and the claim set are documented in
 * `packages/shared/src/identity/mcp-identity-assertion.ts` and
 * `docs/api/MCP_IDENTITY_ASSERTION.md`).
 *
 * HOW IT IS WIRED. A server whose `identity_propagation` is
 * `signed_assertion` gets one `OutboundIdentity` per governed call
 * (`outboundIdentityFor`). It is handed to `connectUpstream`, which installs
 * `identityAssertionMiddleware` on that connection's (already egress-guarded)
 * fetch. The holder starts UNARMED: a connect made before the decision (the
 * manifest sync a `tools/call` on an unknown tool needs) sends nothing. Only
 * after the call is allowed does the caller ARM it (`armOutboundIdentity`)
 * for exactly one JSON-RPC method, and only a request message of that method
 * (`tools/call`, or the method of a governed protocol call) carries an
 * assertion. Each such request gets a freshly minted one with a unique `jti`,
 * so an upstream that keeps a replay set never sees the same id twice.
 * `initialize`, notifications, the event-stream GET and the session DELETE
 * carry nothing.
 *
 * FAIL CLOSED. An opted-in server never silently gets a call without its
 * assertion: before anything is sent, `armOutboundIdentity` checks that the
 * issuer (REGULAIT_PUBLIC_URL), the pairwise key (from the data key), the
 * server's audience and an active signing key all exist, and refuses the call
 * with an audited `mcp-identity-assertion-unavailable` deny if one does not.
 * The middleware also refuses (throws before the request leaves) when a
 * request would go to an origin other than the one the assertion names.
 *
 * Open source first (ADR-0176): `jose` signs (already pinned, used by S3); the
 * header is set through the MCP SDK's own fetch middleware hook
 * (`createMiddleware`); `act` is S3's `actClaimFromChain`; the pairwise
 * subject is S3's `pairwiseSubject`. What is ours is the decision of when an
 * identity may leave and what it may say.
 */
import { randomBytes, type KeyObject } from "node:crypto";
import { SignJWT, type JWTPayload } from "jose";
import { createMiddleware, type Middleware } from "@modelcontextprotocol/sdk/client/middleware.js";
import { auditLog, type Db } from "@regulait/db";
import {
  actClaimFromChain,
  canonicalMcpAudience,
  IDENTITY_ASSERTION_HEADER,
  IDENTITY_ASSERTION_ISSUED_RULE_ID,
  IDENTITY_ASSERTION_TTL_SECONDS,
  IDENTITY_ASSERTION_TYP,
  IDENTITY_ASSERTION_UNAVAILABLE_RULE_ID,
  IDENTITY_PROPAGATION_CHANGED_RULE_ID,
  IDENTITY_PROPAGATION_UNSUPPORTED,
} from "@regulait/shared";
import type { Decision } from "@regulait/policy-kernel";
import { databaseNow } from "./db-clock.js";
import { pairwiseSubject } from "./delegated-token.js";
import { currentIssuerSigner, IdentitySigningKeyError, ISSUER_JWS_ALG } from "./identity-signing-keys.js";
import { identityIssuer, identitySecretsFor } from "./oauth/common.js";

// ---------------------------------------------------------------------------
// Signing (pure: no database, no clock of its own)
// ---------------------------------------------------------------------------

export interface AssertionSigner {
  kid: string;
  privateKey: KeyObject;
}

export interface SignedAssertion {
  assertion: string;
  jti: string;
  iat: number;
  exp: number;
}

/**
 * Sign one assertion. Claims are exactly `iss`, `aud`, `sub`, `iat`, `exp`,
 * `jti` and, when `actors` is a non-empty chain (root first, leaf last), `act`.
 */
export async function signIdentityAssertion(input: {
  signer: AssertionSigner;
  issuer: string;
  audience: string;
  /** the PAIRWISE subject (never a user id or an email) */
  subject: string;
  actors: ReadonlyArray<{ identifier: string }> | null;
  /** seconds since the epoch, from the database clock */
  iat: number;
  jti?: string;
}): Promise<SignedAssertion> {
  const jti = input.jti ?? randomBytes(32).toString("base64url");
  const exp = input.iat + IDENTITY_ASSERTION_TTL_SECONDS;
  const act = input.actors && input.actors.length > 0 ? actClaimFromChain(input.actors) : undefined;
  const assertion = await new SignJWT(act ? { act: act as unknown as JWTPayload } : {})
    .setProtectedHeader({ alg: ISSUER_JWS_ALG, typ: IDENTITY_ASSERTION_TYP, kid: input.signer.kid })
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setSubject(input.subject)
    .setIssuedAt(input.iat)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(input.signer.privateKey);
  return { assertion, jti, iat: input.iat, exp };
}

// ---------------------------------------------------------------------------
// The per-call holder and the fetch middleware
// ---------------------------------------------------------------------------

/** the request would go somewhere the assertion does not name: nothing is sent */
export class IdentityAssertionDestinationError extends Error {
  constructor(readonly expectedOrigin: string, readonly requestedOrigin: string) {
    super(`an identity assertion for ${expectedOrigin} was about to be sent to ${requestedOrigin}; nothing was sent`);
    this.name = "IdentityAssertionDestinationError";
  }
}

/** the method of ONE JSON-RPC request message (not a notification, not a response, not a batch), else null */
export function jsonRpcRequestMethod(body: unknown): string | null {
  if (typeof body !== "string" || body.length === 0) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(body);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
  const m = msg as { method?: unknown; id?: unknown };
  if (typeof m.method !== "string" || m.id === undefined || m.id === null) return null;
  return m.method;
}

const originOf = (input: string | URL): string => {
  try {
    return new URL(typeof input === "string" ? input : input.toString()).origin;
  } catch {
    return "invalid";
  }
};

/**
 * One governed call's outbound identity. Unarmed until the call is allowed;
 * then armed for one JSON-RPC method with the function that signs (and
 * audits) one assertion.
 */
export class OutboundIdentity {
  private armed: { method: string; mint: (method: string) => Promise<string> } | null = null;
  /** how many assertions this call has sent (each with its own `jti`) */
  sent = 0;

  /** `audience` is null when the server's URL has no canonical form: such a holder is never armed */
  constructor(readonly audience: string | null) {}

  get origin(): string {
    return this.audience === null ? "invalid" : originOf(this.audience);
  }

  arm(method: string, mint: (method: string) => Promise<string>): void {
    this.armed = { method, mint };
  }

  disarm(): void {
    this.armed = null;
  }

  /** the header value for this outgoing request, or null when it carries none */
  async headerFor(input: string | URL, init: RequestInit | undefined): Promise<string | null> {
    if (this.armed === null) return null;
    if ((init?.method ?? "GET").toUpperCase() !== "POST") return null;
    if (jsonRpcRequestMethod(init?.body) !== this.armed.method) return null;
    const requested = originOf(input);
    if (requested !== this.origin) throw new IdentityAssertionDestinationError(this.origin, requested);
    const value = await this.armed.mint(this.armed.method);
    this.sent += 1;
    return value;
  }
}

/**
 * The holder of one call to `server`, or null when the server is not opted in
 * (then nothing is ever attached). Created before the call's first connect,
 * unarmed.
 */
export function outboundIdentityFor(server: { url: string; identityPropagation?: string | null }): OutboundIdentity | null {
  if (server.identityPropagation !== "signed_assertion") return null;
  return new OutboundIdentity(canonicalMcpAudience(server.url));
}

/**
 * The fetch middleware (the MCP SDK's own hook) that adds the assertion to
 * the requests the holder selects. A value already in the header is removed
 * first, so nothing but the gateway's own assertion can ride in it.
 */
export function identityAssertionMiddleware(identity: OutboundIdentity): Middleware {
  return createMiddleware(async (next, input, init) => {
    const value = await identity.headerFor(input, init);
    const headers = new Headers(init?.headers);
    headers.delete(IDENTITY_ASSERTION_HEADER);
    if (value !== null) headers.set(IDENTITY_ASSERTION_HEADER, value);
    return next(input, { ...init, headers });
  });
}

// ---------------------------------------------------------------------------
// Arming a call's identity (the fail-closed checks), and minting
// ---------------------------------------------------------------------------

export interface OutboundIdentityContext {
  db: Db;
  dataKey: string | undefined;
  server: { id: string; transport?: string | null };
  /** the person the call is for */
  sponsorUserId: string;
  /** the acting chain (root first), or null when the person calls directly */
  actors: ReadonlyArray<{ identityId: string; identifier: string }> | null;
  /** audit facts of the call (never its arguments) */
  toolName?: string | null;
  projectId?: string | null;
  env?: NodeJS.ProcessEnv;
}

/**
 * After the call is allowed and before anything is sent: arm the holder for
 * `method`, after checking that an assertion can be made. If one cannot, the
 * call is refused with an audited deny: an opted-in upstream never receives
 * the call without the identity it was promised.
 */
export async function armOutboundIdentity(
  identity: OutboundIdentity,
  method: string,
  ctx: OutboundIdentityContext,
): Promise<{ ok: true } | { ok: false; decision: Decision }> {
  const env = ctx.env ?? process.env;
  const refuse = async (code: string, why: string): Promise<{ ok: false; decision: Decision }> => {
    const decision: Decision = {
      effect: "deny",
      ruleId: IDENTITY_ASSERTION_UNAVAILABLE_RULE_ID,
      ruleChain: [],
      reason:
        `MCP server ${ctx.server.id} is set to receive a signed identity assertion on every call, and none can be made ` +
        `(${code}): ${why}. The call was not sent.`,
    };
    await ctx.db.insert(auditLog).values({
      userId: ctx.sponsorUserId,
      serverId: ctx.server.id,
      objectType: "mcp_server",
      objectId: ctx.server.id,
      toolName: ctx.toolName ?? null,
      detail: { phase: "identity-assertion", method, code, projectId: ctx.projectId ?? null, receiptClass: "decision" },
      ...decision,
    });
    return { ok: false, decision };
  };
  if ((ctx.server.transport ?? "streamable_http") === "stdio") {
    return refuse("transport_unsupported", "a stdio upstream has no HTTP request to carry the header");
  }
  const issuer = identityIssuer(env);
  if (!issuer) return refuse("issuer_not_configured", "REGULAIT_PUBLIC_URL does not name this deployment");
  const secrets = identitySecretsFor(ctx.dataKey);
  if (!secrets) return refuse("pairwise_key_unavailable", "the gateway data key is not configured");
  const audience = identity.audience;
  if (!audience) return refuse("audience_invalid", "the server's URL is not an absolute http(s) URL");
  try {
    await currentIssuerSigner(ctx.db, env);
  } catch (err) {
    if (err instanceof IdentitySigningKeyError) return refuse(err.code, "no active issuer signing key is available");
    throw err;
  }
  const subject = pairwiseSubject(secrets.pairwiseKey, audience, ctx.sponsorUserId);
  identity.arm(method, async (armedMethod) => {
    const signer = await currentIssuerSigner(ctx.db, env);
    // the DATABASE clock (M-075), never before the key's activation (the S3 mint rule)
    const now = await databaseNow(ctx.db);
    const iat = Math.max(Math.floor(now.getTime() / 1000), Math.floor(signer.activatedAt.getTime() / 1000));
    const signed = await signIdentityAssertion({ signer, issuer, audience, subject, actors: ctx.actors, iat });
    // every disclosure to a third party is on the trail: what was said (never the token), to whom, for whom
    await ctx.db.insert(auditLog).values({
      userId: ctx.sponsorUserId,
      serverId: ctx.server.id,
      objectType: "mcp_server",
      objectId: ctx.server.id,
      toolName: ctx.toolName ?? null,
      detail: {
        phase: "identity-assertion",
        method: armedMethod,
        jti: signed.jti,
        kid: signer.kid,
        audience,
        sub: subject,
        actorChain: ctx.actors ? ctx.actors.map((a) => a.identityId) : null,
        expiresAt: new Date(signed.exp * 1000).toISOString(),
        projectId: ctx.projectId ?? null,
      },
      effect: "allow",
      ruleId: IDENTITY_ASSERTION_ISSUED_RULE_ID,
      ruleChain: [],
      reason: `signed identity assertion sent to MCP server ${ctx.server.id} for one ${armedMethod} request`,
    });
    return signed.assertion;
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The per-server setting (PATCH /v1/servers/:serverId)
// ---------------------------------------------------------------------------

export { identityPropagationUpdate, type IdentityPropagationUpdate } from "@regulait/shared";

/** a stdio server has no HTTP request to carry the header: turning it on is refused, nothing is saved */
export function refuseIdentityPropagationOnStdio(
  isStdio: boolean,
  requested: string | undefined,
): { status: 409; body: { error: typeof IDENTITY_PROPAGATION_UNSUPPORTED; detail: string } } | null {
  if (!isStdio || requested !== "signed_assertion") return null;
  return {
    status: 409,
    body: {
      error: IDENTITY_PROPAGATION_UNSUPPORTED,
      detail: "this server is a stdio upstream: there is no HTTP request to carry an identity assertion. Nothing was saved.",
    },
  };
}

/** every change of a server's identity propagation is on the trail with both values; turning it on as a relaxation */
export async function auditIdentityPropagationChange(
  db: Db,
  args: {
    userId: string;
    serverId: string;
    label: string;
    from: string;
    to: string;
    url: string;
    update: { relaxed: { identityPropagation: "signed_assertion" } | null; resetByUrlMove: boolean };
    stepUp: string | null;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    userId: args.userId,
    serverId: args.serverId,
    objectType: "mcp_server",
    objectId: args.serverId,
    detail: {
      phase: "update",
      from: { identityPropagation: args.from },
      to: { identityPropagation: args.to },
      url: args.url,
      audience: canonicalMcpAudience(args.url),
      relaxation: args.update.relaxed !== null,
      ...(args.update.relaxed ? { relaxed: args.update.relaxed, stepUp: args.stepUp } : {}),
      ...(args.update.resetByUrlMove ? { resetByUrlMove: true } : {}),
    },
    effect: "allow",
    ruleId: IDENTITY_PROPAGATION_CHANGED_RULE_ID,
    ruleChain: [],
    reason:
      `${args.label}: identity propagation ${args.from} → ${args.to}` +
      (args.update.relaxed
        ? " — a relaxation of the strict default: each call now sends this server a signed assertion of who it is for"
        : args.update.resetByUrlMove
          ? " — the url moved, and the opt-in does not follow it to a new destination"
          : ""),
  });
}
