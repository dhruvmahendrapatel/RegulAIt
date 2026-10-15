/**
 * ADR-0188 slice S8 — OUTBOUND MCP IDENTITY: a signed assertion per call
 * (decision 8; the format and the claim set are documented in
 * `packages/shared/src/identity/mcp-identity-assertion.ts` and
 * `docs/api/MCP_IDENTITY_ASSERTION.md`).
 *
 * HOW IT IS WIRED. A server whose `identity_propagation` is
 * `signed_assertion` gets one `OutboundIdentity` per governed call
 * (`outboundIdentityFor`). It is handed to `connectUpstream`, which installs
 * `identityAssertionMiddleware` on that connection's egress-guarded fetch and
 * gives the guard the holder's `beforeSend`. The holder starts UNARMED: a
 * connect made before the decision (the manifest sync a `tools/call` on an
 * unknown tool needs) sends nothing. Only after the call is allowed does the
 * caller ARM it (`armOutboundIdentity`) for exactly one JSON-RPC method, and
 * only a request message of that method (`tools/call`, or the method of a
 * governed protocol call) carries an assertion. Each such request gets a
 * freshly signed one with a unique `jti`. `initialize`, notifications, the
 * event-stream GET and the session DELETE carry nothing.
 *
 * AUDITED WHEN SENT. An assertion is signed in the middleware, but its
 * `mcp-identity-assertion-issued` row is written by the egress guard's
 * `beforeSend` hook: after the destination check passed, before the request
 * leaves. A request the guard refuses therefore leaves no "issued" row, and a
 * request whose row cannot be written is not sent.
 *
 * FAIL CLOSED, AS OUR OWN REFUSAL. An opted-in server never silently gets a
 * call without its assertion. Before the call or any identity is sent,
 * `armOutboundIdentity` checks the issuer (REGULAIT_PUBLIC_URL), the pairwise
 * key (from the data key), the server's audience and the signing key (which it
 * captures, so nothing is re-selected later), and refuses the call with an
 * audited `mcp-identity-assertion-unavailable` deny if one is missing. A
 * refusal at send time (a request bound for another origin, a signature or an
 * audit write that fails) writes the same deny and throws
 * `IdentityAssertionRefusedError`, which `classifyUpstreamError` names as our
 * own refusal: never retried, never charged to the upstream's breaker.
 *
 * Open source first (ADR-0176): `jose` signs (already pinned, used by S3); the
 * header is set through the MCP SDK's own fetch middleware hook
 * (`createMiddleware`); `act` is shaped by S3's `actClaimFromChain`; the
 * pairwise ids use S3's pairwise key. What is ours is the decision of when an
 * identity may leave and what it may say.
 *
 * DISCLOSING AGENT WORKLOAD IDS (the S8 follow-up, migration 0196). By
 * default each agent in `act` is a pairwise id for the audience. A server
 * with `disclose_agent_workload_ids` names them by their workload identifiers
 * (SPIFFE IDs) instead, exactly as stored. That is a per-server relaxation
 * (stepped up, audited, reset by a url move), read from the server row at
 * the call, and every "issued" row says which form was sent.
 */
import { createHmac, randomBytes, type KeyObject } from "node:crypto";
import { SignJWT, type JWTPayload } from "jose";
import { createMiddleware, type Middleware } from "@modelcontextprotocol/sdk/client/middleware.js";
import { and, auditLog, eq, mcpServers, ne, sql, type Db } from "@regulait/db";
import {
  actClaimFromChain,
  AGENT_ID_DISCLOSURE_CHANGED_RULE_ID,
  AGENT_ID_DISCLOSURE_NEEDS_ASSERTION,
  canonicalMcpAudience,
  IDENTITY_ASSERTION_HEADER,
  IDENTITY_ASSERTION_ISSUED_RULE_ID,
  IDENTITY_ASSERTION_TTL_SECONDS,
  IDENTITY_ASSERTION_TYP,
  IDENTITY_ASSERTION_UNAVAILABLE_RULE_ID,
  IDENTITY_AUDIENCE_SHARED,
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
 * The pairwise id of one agent for one audience: an HMAC of the audience and
 * the agent's workload identity id under the S3 pairwise key, domain-separated
 * from the person's `sub`. Stable for one server, unlinkable across servers,
 * and it never carries an admin-typed identifier.
 */
export function pairwiseActor(pairwiseKey: Buffer, audience: string, identityId: string): string {
  return createHmac("sha256", pairwiseKey).update(`act\u0000${audience}\u0000${identityId}`).digest("base64url");
}

/**
 * Sign one assertion. Claims are exactly `iss`, `aud`, `sub`, `iat`, `exp`,
 * `jti` and, when `actors` is a non-empty chain (root first, leaf last), `act`.
 * The caller decides what each actor's `identifier` is (pairwise by default).
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

/**
 * OUR OWN refusal at send time: nothing was sent, a deny is on the trail, and
 * `classifyUpstreamError` never retries it or charges it to the breaker.
 */
export class IdentityAssertionRefusedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "IdentityAssertionRefusedError";
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

/** what arming hands the holder: how to sign one assertion, and how to record a refusal */
export interface ArmedIdentity {
  /** sign one assertion; `record` writes its "issued" row (called once the egress guard has allowed the request) */
  mint: (method: string) => Promise<{ assertion: string; record: () => Promise<void> }>;
  /** write the `mcp-identity-assertion-unavailable` deny of a send-time refusal */
  refuse: (method: string, code: string, why: string) => Promise<void>;
}

/**
 * One governed call's outbound identity. Unarmed until the call is allowed;
 * then armed for one JSON-RPC method.
 */
export class OutboundIdentity {
  private armed: ({ method: string } & ArmedIdentity) | null = null;
  /** the "issued" record of each request that carries an assertion, keyed by the exact init the guard receives */
  private readonly pending = new WeakMap<object, () => Promise<void>>();
  /** how many assertions this call has sent (each with its own `jti`) */
  sent = 0;

  /**
   * `audience` is null when the server's URL has no canonical form: such a holder is never armed.
   * `discloseAgentIds`: name agents by their workload identifiers instead of pairwise ids (the server's opt-in).
   */
  constructor(
    readonly audience: string | null,
    readonly discloseAgentIds = false,
  ) {}

  get origin(): string {
    return this.audience === null ? "invalid" : originOf(this.audience);
  }

  arm(method: string, armed: ArmedIdentity): void {
    this.armed = { method, ...armed };
  }

  disarm(): void {
    this.armed = null;
  }

  private async refusal(method: string, code: string, why: string): Promise<IdentityAssertionRefusedError> {
    try {
      await this.armed?.refuse(method, code, why);
    } catch {
      // the refusal stands even if its row cannot be written; nothing is sent either way
    }
    return new IdentityAssertionRefusedError(code, `identity assertion refused (${code}): ${why}; nothing was sent`);
  }

  /**
   * The init to send for this request: any value in the assertion header
   * removed, and a freshly signed assertion added when this is a request of
   * the armed method. Throws (our own refusal) rather than send without it.
   */
  async prepare(input: string | URL, init: RequestInit | undefined): Promise<RequestInit> {
    const headers = new Headers(init?.headers);
    headers.delete(IDENTITY_ASSERTION_HEADER);
    const out: RequestInit = { ...init, headers };
    const armed = this.armed;
    if (armed === null) return out;
    if ((init?.method ?? "GET").toUpperCase() !== "POST") return out;
    if (jsonRpcRequestMethod(init?.body) !== armed.method) return out;
    const requested = originOf(input);
    if (requested !== this.origin) {
      throw await this.refusal(armed.method, "destination_mismatch", `the request was bound for ${requested}, not ${this.origin}`);
    }
    let minted: { assertion: string; record: () => Promise<void> };
    try {
      minted = await armed.mint(armed.method);
    } catch {
      throw await this.refusal(armed.method, "sign_failed", "the assertion could not be signed");
    }
    headers.set(IDENTITY_ASSERTION_HEADER, minted.assertion);
    this.pending.set(out, minted.record);
    return out;
  }

  /**
   * The egress guard's `beforeSend`: the destination was allowed and the
   * request is about to leave. Writes the "issued" row of a request that
   * carries an assertion; if it cannot be written, the request is not sent.
   */
  async beforeSend(init: RequestInit | undefined): Promise<void> {
    if (!init) return;
    const record = this.pending.get(init);
    if (!record) return;
    this.pending.delete(init);
    try {
      await record();
    } catch {
      throw await this.refusal(this.armed?.method ?? "unknown", "audit_failed", "the disclosure could not be audited");
    }
    this.sent += 1;
  }

  /** the request ended (sent or refused): an unsent assertion's record is dropped, never written */
  forget(init: RequestInit): void {
    this.pending.delete(init);
  }
}

/**
 * The holder of one call to `server`, or null when the server is not opted in
 * (then nothing is ever attached). Created before the call's first connect,
 * unarmed.
 */
export function outboundIdentityFor(server: {
  url: string;
  identityPropagation?: string | null;
  discloseAgentWorkloadIds?: boolean | null;
}): OutboundIdentity | null {
  if (server.identityPropagation !== "signed_assertion") return null;
  // strict unless the row says exactly true (a missing or null value is the pairwise default)
  return new OutboundIdentity(canonicalMcpAudience(server.url), server.discloseAgentWorkloadIds === true);
}

/**
 * The fetch middleware (the MCP SDK's own hook) that adds the assertion to
 * the requests the holder selects. A value already in the header is removed
 * first, so nothing but the gateway's own assertion can ride in it. It wraps
 * the egress-guarded fetch directly, so the guard's `beforeSend` receives the
 * init this produced.
 */
export function identityAssertionMiddleware(identity: OutboundIdentity): Middleware {
  return createMiddleware(async (next, input, init) => {
    const out = await identity.prepare(input, init);
    try {
      return await next(input, out);
    } finally {
      identity.forget(out);
    }
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

async function writeUnavailable(ctx: OutboundIdentityContext, method: string, code: string, why: string): Promise<Decision> {
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
  return decision;
}

/**
 * After the call is allowed and before the call or any identity is sent: arm
 * the holder for `method`, after checking that an assertion can be made and
 * capturing the signing key. If one cannot be made, the call is refused with
 * an audited deny: an opted-in upstream never receives the call without the
 * identity it was promised.
 */
export async function armOutboundIdentity(
  identity: OutboundIdentity,
  method: string,
  ctx: OutboundIdentityContext,
): Promise<{ ok: true } | { ok: false; decision: Decision }> {
  const env = ctx.env ?? process.env;
  const refuse = async (code: string, why: string) => ({ ok: false as const, decision: await writeUnavailable(ctx, method, code, why) });
  if ((ctx.server.transport ?? "streamable_http") === "stdio") {
    return refuse("transport_unsupported", "a stdio upstream has no HTTP request to carry the header");
  }
  const issuer = identityIssuer(env);
  if (!issuer) return refuse("issuer_not_configured", "REGULAIT_PUBLIC_URL does not name this deployment");
  const secrets = identitySecretsFor(ctx.dataKey);
  if (!secrets) return refuse("pairwise_key_unavailable", "the gateway data key is not configured");
  const audience = identity.audience;
  if (!audience) return refuse("audience_invalid", "the server's URL is not an absolute http(s) URL");
  // the signer is captured here, once: a send-time re-selection could fail after the call was decided
  let signer: Awaited<ReturnType<typeof currentIssuerSigner>>;
  try {
    signer = await currentIssuerSigner(ctx.db, env);
  } catch (err) {
    if (err instanceof IdentitySigningKeyError) return refuse(err.code, "no active issuer signing key is available");
    throw err;
  }
  const subject = pairwiseSubject(secrets.pairwiseKey, audience, ctx.sponsorUserId);
  // ADR-0180: agents are named by PAIRWISE ids by default. Global SPIFFE IDs would let two upstreams join on `act.sub`
  // (and through it on the person), and an external identifier is admin-typed text that can carry a name. Only a
  // server whose admin turned on "disclose agent workload IDs" (a stepped-up relaxation) gets them, as stored.
  const disclosed = identity.discloseAgentIds;
  const actors = ctx.actors
    ? ctx.actors.map((a) => ({
        identityId: a.identityId,
        identifier: disclosed ? a.identifier : pairwiseActor(secrets.pairwiseKey, audience, a.identityId),
      }))
    : null;
  const agentIdsDisclosed = disclosed && actors !== null && actors.length > 0;
  identity.arm(method, {
    refuse: async (armedMethod, code, why) => {
      await writeUnavailable(ctx, armedMethod, code, why);
    },
    mint: async (armedMethod) => {
      // the DATABASE clock (M-075), never before the key's activation (the S3 mint rule)
      const now = await databaseNow(ctx.db);
      const iat = Math.max(Math.floor(now.getTime() / 1000), Math.floor(signer.activatedAt.getTime() / 1000));
      const signed = await signIdentityAssertion({ signer, issuer, audience, subject, actors, iat });
      // every disclosure to a third party is on the trail: what was said (never the token), to whom, for whom
      const record = async () => {
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
            actorChain: actors ? actors.map((a) => a.identityId) : null,
            act: actors ? actors.map((a) => a.identifier) : null,
            // were the agents named by their workload IDs (the server's opt-in) rather than pairwise ids?
            agentIdsDisclosed,
            actorIdForm: disclosed ? "workload_id" : "pairwise",
            expiresAt: new Date(signed.exp * 1000).toISOString(),
            projectId: ctx.projectId ?? null,
          },
          effect: "allow",
          ruleId: IDENTITY_ASSERTION_ISSUED_RULE_ID,
          ruleChain: [],
          reason: `signed identity assertion sent to MCP server ${ctx.server.id} for one ${armedMethod} request`,
        });
      };
      return { assertion: signed.assertion, record };
    },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The per-server setting (PATCH /v1/servers/:serverId)
// ---------------------------------------------------------------------------

export {
  agentIdDisclosureUpdate,
  identityPropagationUpdate,
  type AgentIdDisclosureUpdate,
  type IdentityPropagationUpdate,
} from "@regulait/shared";

/** a stdio server has no HTTP request to carry the header: turning it on is refused, nothing is saved */
export function refuseIdentityPropagationOnStdio(
  isStdio: boolean,
  requested: string | undefined,
  discloseAgentIds?: boolean,
): { status: 409; body: { error: typeof IDENTITY_PROPAGATION_UNSUPPORTED; detail: string } } | null {
  if (!isStdio || (requested !== "signed_assertion" && discloseAgentIds !== true)) return null;
  return {
    status: 409,
    body: {
      error: IDENTITY_PROPAGATION_UNSUPPORTED,
      detail: "this server is a stdio upstream: there is no HTTP request to carry an identity assertion. Nothing was saved.",
    },
  };
}

/** agent workload IDs ride only in an assertion: asking for them on a server that is not sent one is refused (409) */
export function refuseAgentIdDisclosureWithoutAssertion(update: { refused: boolean }): {
  status: 409;
  body: { error: typeof AGENT_ID_DISCLOSURE_NEEDS_ASSERTION; detail: string };
} | null {
  if (!update.refused) return null;
  return {
    status: 409,
    body: {
      error: AGENT_ID_DISCLOSURE_NEEDS_ASSERTION,
      detail:
        "agent workload IDs are sent only inside a signed identity assertion, and this server is not set to receive one " +
        "(identity propagation must be signed_assertion, already or in this request). Nothing was saved.",
    },
  };
}

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Two opted-in servers must not share an audience: an assertion minted for one
 * would verify at the other. Returns the 409 refusal when another opted-in
 * server's canonical audience equals `url`'s, else null. Inside a transaction,
 * call `lockIdentityAudiences` first so two concurrent opt-ins cannot both pass.
 */
export async function refuseSharedIdentityAudience(
  db: DbOrTx,
  serverId: string,
  url: string,
): Promise<{ status: 409; body: { error: typeof IDENTITY_AUDIENCE_SHARED; detail: string } } | null> {
  const audience = canonicalMcpAudience(url);
  if (!audience) return null;
  const others = await db
    .select({ id: mcpServers.id, name: mcpServers.name, url: mcpServers.url })
    .from(mcpServers)
    .where(and(eq(mcpServers.identityPropagation, "signed_assertion"), ne(mcpServers.id, serverId)));
  const clash = others.find((o) => canonicalMcpAudience(o.url) === audience);
  if (!clash) return null;
  return {
    status: 409,
    body: {
      error: IDENTITY_AUDIENCE_SHARED,
      detail:
        `MCP server '${clash.name}' already receives identity assertions for the audience ${audience}; an assertion for one ` +
        `would verify at the other. Nothing was saved.`,
    },
  };
}

/** serialise opt-ins inside the caller's transaction (released at commit or rollback) */
export async function lockIdentityAudiences(tx: DbOrTx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('regulait/adr0188/s8/identity-audience'))`);
}

/** every change of a server's identity propagation is on the trail with both values; turning it on as a relaxation */
export async function auditIdentityPropagationChange(
  db: DbOrTx,
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

/** every change of a server's "disclose agent workload IDs" opt-in is on the trail with both values; on as a relaxation */
export async function auditAgentIdDisclosureChange(
  db: DbOrTx,
  args: {
    userId: string;
    serverId: string;
    label: string;
    from: boolean;
    to: boolean;
    url: string;
    update: { relaxed: { discloseAgentWorkloadIds: true } | null; reset: "url_move" | "propagation_off" | null };
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
      from: { discloseAgentWorkloadIds: args.from },
      to: { discloseAgentWorkloadIds: args.to },
      url: args.url,
      audience: canonicalMcpAudience(args.url),
      relaxation: args.update.relaxed !== null,
      ...(args.update.relaxed ? { relaxed: args.update.relaxed, stepUp: args.stepUp } : {}),
      ...(args.update.reset === "url_move" ? { resetByUrlMove: true } : {}),
      ...(args.update.reset === "propagation_off" ? { resetByPropagationOff: true } : {}),
    },
    effect: "allow",
    ruleId: AGENT_ID_DISCLOSURE_CHANGED_RULE_ID,
    ruleChain: [],
    reason:
      `${args.label}: disclose agent workload IDs ${String(args.from)} → ${String(args.to)}` +
      (args.update.relaxed
        ? " — a relaxation of the strict default: agents in each assertion are named by their global workload IDs, " +
          "which upstreams can correlate across servers"
        : args.update.reset === "url_move"
          ? " — the url moved, and the opt-in does not follow it to a new destination"
          : args.update.reset === "propagation_off"
            ? " — identity propagation was turned off, and the IDs ride only in an assertion"
            : ""),
  });
}
