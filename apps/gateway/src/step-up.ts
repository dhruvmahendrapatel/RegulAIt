/**
 * ADR-0186 A — STEP-UP: a fresh second proof, bound to ONE action, at the
 * sensitive action itself (not a login-time attribute).
 *
 * Routes (self = a signed-in user acting for themselves; AgentCoordination §4.9):
 *   POST /v1/auth/step-up/options   {action:{kind, body}} → {stepUpId, methods, actionKind, expiresAt,
 *                                    passkey?:{options}, sso?:{redirectUrl, provider}}
 *   POST /v1/auth/step-up/verify    {stepUpId, method:"totp", code} | {stepUpId, method:"passkey", response}
 *                                   → {stepUpToken:"rgsu_…", expiresAt, method, actionKind}
 *   GET  /v1/auth/step-up/:stepUpId → 200 {status:"granted", stepUpToken, expiresAt} once the identity provider
 *                                    callback verified a fresh SSO login; 202 {status:"pending"} before;
 *                                    409 `sso_reauth_stale` when that request can no longer give a grant
 *
 * HOW A PROTECTED ROUTE USES IT (one helper, `requireStepUp`):
 *
 *   const su = await requireStepUp(db, req, reply, { kind: "owner_change", facts: { objectType, objectId, ownerUserId } });
 *   if (!su.ok) return reply;   // the refusal is already sent
 *
 * The facts are what the SERVER derives from the request being authorised.
 * Without a usable grant the route answers 403 `step_up_required` with
 * `{actionKind, methods, action:{kind, body: facts}}`; the client posts that
 * `action` verbatim to `/options`, proves it is the person, and retries the
 * same request with `x-regulait-step-up: rgsu_…`. The grant is bound to
 * `stepUpActionDigest(kind, facts)`, so the server recomputes the digest from
 * the RETRIED request: a grant made for one action (another owner, another
 * relaxed value, another approval) is refused for any other. A request that
 * needs two step-ups (a settings write that relaxes a value AND changes the
 * break-glass admins) carries both tokens in the one header, comma-separated.
 *
 * GRANTS: `rgsu_` + 256 random bits, only the sha256 stored; single use (an
 * atomic `UPDATE … WHERE used_at IS NULL AND expires_at > now() RETURNING`);
 * bound to the user AND the session that made them, the action kind and the
 * digest; expiry `org_settings.step_up_max_age_seconds` (120 s strict).
 *
 * WHO CAN STEP UP: only a signed-in person in a browser session. An API key or
 * virtual key, a chat tap and a bulk operation never can, so a protected
 * action from one is refused (403 `step_up_required` with no methods, or
 * `chatops_step_up_required`). The deploy-time BOOTSTRAP credential (header or
 * exchanged session) is not a person and has no identity to prove. B4S-06: it
 * passes a step-up ONLY during first-admin setup — while no active admin has a
 * usable step-up method (`adminWithStepUpMethodExists`) — because then nobody
 * could give one and the deployment must still be configurable. From the
 * moment an admin can step up, a protected action from the bootstrap
 * credential is refused 403 `step_up_required` with no methods and
 * `credential: "bootstrap"` (the same shape as an API key's: the action does
 * need a step-up, and this credential can never give one — `step_up_unavailable`
 * would wrongly say the ORG has no way to step up, when an admin does), and
 * GET /v1/org/posture reports `bootstrap_token_configured` while the token is
 * still set.
 *
 * POLICY: `org_settings.step_up_mode` (`required` strict; `off` is a relaxation
 * and itself needs a `settings_relax` step-up) and `step_up_actions` (all six
 * strict; removing one is a relaxation), read on every check.
 *
 * METHODS: `passkey` (an enrolled, unrevoked passkey and a configured
 * relying party), `totp` (an enrolled authenticator; replay-protected by the
 * same verifier as login, with the step burned atomically), `sso` (a linked
 * identity at an enabled OIDC or SAML provider: a FRESH login there — OIDC
 * `prompt=login` + `max_age=0`, SAML `ForceAuthn="true"` — whose returned
 * identity must be this user and whose `auth_time`/`AuthnInstant` must be
 * after the request). No method → 422 `step_up_unavailable`.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateAuthenticationOptions, verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import {
  and,
  auditLog,
  authSessions,
  desc,
  eq,
  federatedIdentities,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  oidcProviders,
  ORG_SETTINGS_ID,
  orgSettings,
  samlProviders,
  sql,
  ssoReauthRequests,
  stepUpGrants,
  users,
  webauthnChallenges,
  webauthnCredentials,
  type Db,
  type SsoReauthRequestRow,
  type WebauthnChallengeRow,
} from "@regulait/db";
import {
  BATCH4_STRICT_DEFAULTS,
  STEP_UP_ACTION_KINDS,
  STEP_UP_HEADER,
  STEP_UP_TOKEN_PREFIX,
  stepUpActionDigest,
  stepUpOptionsSchema,
  stepUpVerifySchema,
  type StepUpActionKind,
  type StepUpMethod,
  type WebauthnChallengePurpose,
} from "@regulait/shared";
import { hashToken } from "./token-hash.js";
import { verifyTotp } from "./totp.js";
import { decryptSecret } from "./secrets.js";
import { resolvePublicUrl } from "./public-url.js";
import { ApprovalRuleWriteRefusedError, type ApprovalRuleStepUp } from "./approval-pool.js";



/** a WebAuthn or step-up ceremony lives at most this long (the DB CHECK holds 5 minutes) */
export const STEP_UP_CEREMONY_SECONDS = 300;
/** the browser prompt's own timeout, inside the ceremony window */
export const WEBAUTHN_PROMPT_TIMEOUT_MS = 120_000;
/** at most one grant per action kind rides one request */
const MAX_PRESENTED_GRANTS = STEP_UP_ACTION_KINDS.length;
/** the action facts a client may hand to /options (a digest input, never stored) */
const MAX_ACTION_BODY_CHARS = 64 * 1024;

// ---------------------------------------------------------------------------
// The single-use challenge claim (A and B)
// ---------------------------------------------------------------------------

export type ChallengeClaim =
  | { ok: true; row: WebauthnChallengeRow }
  | { ok: false; reason: "unknown" | "used" | "expired" };

/**
 * Claim a ceremony row ONCE: `UPDATE … SET used_at = now() WHERE used_at IS NULL
 * AND expires_at > now() RETURNING`, scoped to the caller's user, session and
 * the purpose. Exactly one of any number of concurrent claims succeeds; the
 * others (and every later one) learn why they did not: `used`, `expired`, or
 * `unknown` (no such row for this user, session and purpose — deliberately not
 * distinguished further, so a guess at another user's id learns nothing).
 * The database clock decides expiry, so app-server skew cannot extend a window.
 */
export async function consumeWebauthnChallenge(
  db: Db,
  key: { id: string; userId: string; sessionId: string; purpose: WebauthnChallengePurpose },
): Promise<ChallengeClaim> {
  const scope = and(
    eq(webauthnChallenges.id, key.id),
    eq(webauthnChallenges.userId, key.userId),
    eq(webauthnChallenges.sessionId, key.sessionId),
    eq(webauthnChallenges.purpose, key.purpose),
  );
  const [row] = await db
    .update(webauthnChallenges)
    .set({ usedAt: sql`now()` })
    .where(and(scope, isNull(webauthnChallenges.usedAt), gt(webauthnChallenges.expiresAt, sql`now()`)))
    .returning();
  if (row) return { ok: true, row };
  const [seen] = await db
    .select({ usedAt: webauthnChallenges.usedAt })
    .from(webauthnChallenges)
    .where(scope);
  if (!seen) return { ok: false, reason: "unknown" };
  return { ok: false, reason: seen.usedAt ? "used" : "expired" };
}

/** the refusal for a claim that failed (shared by the passkey and step-up ceremonies) */
export function challengeClaimRefusal(reason: "unknown" | "used" | "expired"): { status: number; body: Record<string, unknown> } {
  if (reason === "used") {
    return { status: 409, body: { error: "passkey_challenge_used", detail: "that request was already used — start again" } };
  }
  if (reason === "expired") {
    return { status: 409, body: { error: "passkey_challenge_expired", detail: "that request expired — start again" } };
  }
  return { status: 404, body: { error: "unknown_challenge", detail: "no such request for this session — start again" } };
}

// ---------------------------------------------------------------------------
// The relying party (passkeys)
// ---------------------------------------------------------------------------

export interface RelyingParty {
  /** the WebAuthn RP ID: the hostname of REGULAIT_PUBLIC_URL */
  rpID: string;
  /** the origin a browser ceremony must report */
  origin: string;
  rpName: string;
}

/**
 * The relying party, from `REGULAIT_PUBLIC_URL` only — never the request's
 * Host (a forged Host must not choose which origin a passkey is bound to).
 * Unset (or unusable) → null, and every passkey route answers 409
 * `passkey_rp_unconfigured`.
 */
export function relyingParty(env: NodeJS.ProcessEnv = process.env): RelyingParty | null {
  let pub: string | null;
  try {
    pub = resolvePublicUrl(env);
  } catch {
    return null;
  }
  if (!pub) return null;
  const url = new URL(pub);
  return { rpID: url.hostname, origin: url.origin, rpName: "RegulAIt" };
}

export const PASSKEY_RP_UNCONFIGURED_BODY = {
  error: "passkey_rp_unconfigured",
  detail:
    "passkeys need this deployment's public address: an operator sets REGULAIT_PUBLIC_URL to the https origin " +
    "people reach RegulAIt at (its hostname becomes the passkey relying party)",
} as const;

// ---------------------------------------------------------------------------
// Who is asking, and what the org requires
// ---------------------------------------------------------------------------

export type StepUpCaller =
  | { kind: "bootstrap" }
  | { kind: "key"; via: "api-key" | "virtual-key" }
  | { kind: "session"; userId: string; sessionId: string; origin: string; createdAt?: Date };

/** the credential behind this request, as step-up sees it */
export function stepUpCallerOf(req: FastifyRequest): StepUpCaller {
  const ctx = req.authCtx;
  if (!ctx || ctx.via === "bootstrap") return { kind: "bootstrap" };
  if (ctx.via === "api-key" || ctx.via === "virtual-key") return { kind: "key", via: ctx.via };
  const session = req.sessionAuth;
  if (!ctx.userId || !session) return { kind: "bootstrap" };
  return { kind: "session", userId: ctx.userId, sessionId: session.sessionId, origin: session.origin };
}

export interface StepUpPolicy {
  mode: "required" | "off";
  actions: StepUpActionKind[];
  maxAgeSeconds: number;
}

/** the org's step-up policy right now (the strict defaults when the singleton row does not exist yet) */
export async function loadStepUpPolicy(db: Db): Promise<StepUpPolicy> {
  const [row] = await db
    .select({ mode: orgSettings.stepUpMode, actions: orgSettings.stepUpActions, maxAge: orgSettings.stepUpMaxAgeSeconds })
    .from(orgSettings)
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  if (!row) {
    return {
      mode: BATCH4_STRICT_DEFAULTS.stepUpMode,
      actions: [...BATCH4_STRICT_DEFAULTS.stepUpActions],
      maxAgeSeconds: BATCH4_STRICT_DEFAULTS.stepUpMaxAgeSeconds,
    };
  }
  return { mode: row.mode, actions: row.actions as StepUpActionKind[], maxAgeSeconds: row.maxAge };
}

/** does this action need a step-up under the current policy? */
export function stepUpApplies(policy: StepUpPolicy, kind: StepUpActionKind): boolean {
  return policy.mode === "required" && policy.actions.includes(kind);
}

export interface SsoTarget {
  kind: "oidc" | "saml";
  providerId: string;
  providerName: string;
}

/** the user's most recently used linked identity at an ENABLED provider, or null */
export async function ssoTargetFor(db: Db, userId: string): Promise<SsoTarget | null> {
  const links = await db
    .select({
      oidcProviderId: federatedIdentities.oidcProviderId,
      samlProviderId: federatedIdentities.samlProviderId,
      oidcName: oidcProviders.name,
      oidcEnabled: oidcProviders.enabled,
      samlName: samlProviders.name,
      samlEnabled: samlProviders.enabled,
    })
    .from(federatedIdentities)
    .leftJoin(oidcProviders, eq(oidcProviders.id, federatedIdentities.oidcProviderId))
    .leftJoin(samlProviders, eq(samlProviders.id, federatedIdentities.samlProviderId))
    .where(eq(federatedIdentities.userId, userId))
    .orderBy(sql`${federatedIdentities.lastLoginAt} DESC NULLS LAST`, desc(federatedIdentities.createdAt));
  for (const l of links) {
    if (l.oidcProviderId && l.oidcEnabled) return { kind: "oidc", providerId: l.oidcProviderId, providerName: l.oidcName ?? "" };
    if (l.samlProviderId && l.samlEnabled) return { kind: "saml", providerId: l.samlProviderId, providerName: l.samlName ?? "" };
  }
  return null;
}

/** the user's unrevoked passkeys (id, credential id, transports) */
export async function activePasskeys(db: Db, userId: string) {
  return db
    .select({ id: webauthnCredentials.id, credentialId: webauthnCredentials.credentialId, transports: webauthnCredentials.transports })
    .from(webauthnCredentials)
    .where(and(eq(webauthnCredentials.userId, userId), isNull(webauthnCredentials.revokedAt)));
}

/**
 * B4S-07: a fresh SSO sign-in is offered as a step-up only on a SECURE request
 * — https to the gateway, or https at a trusted proxy (`req.protocol` is
 * Fastify's trust-gated answer, the same one `requestIsSecure` in auth.ts
 * gives; not imported from there, which imports this module). Over plain http
 * the browser-binding cookie the callback checks cannot be `Secure` and the
 * identity provider's redirect would carry the state in the clear, so the
 * method is neither listed nor started.
 */
export function ssoStepUpUsable(req: FastifyRequest | null | undefined): boolean {
  return req?.protocol === "https";
}

/**
 * The step-up methods this user can use now, strongest first: passkey (an
 * unrevoked passkey AND a configured relying party), totp (enrolled), sso (a
 * linked identity at an enabled provider, and — given the request — only when
 * that request is secure, `ssoStepUpUsable`).
 */
export async function stepUpMethodsFor(
  db: Db,
  userId: string,
  req?: FastifyRequest,
): Promise<{ methods: StepUpMethod[]; sso: SsoTarget | null; passkeyCount: number }> {
  const methods: StepUpMethod[] = [];
  const passkeys = await activePasskeys(db, userId);
  if (passkeys.length > 0 && relyingParty()) methods.push("passkey");
  const [u] = await db.select({ totpEnabled: users.totpEnabled }).from(users).where(eq(users.id, userId));
  if (u?.totpEnabled) methods.push("totp");
  const linked = await ssoTargetFor(db, userId);
  const sso = linked && (req === undefined || ssoStepUpUsable(req)) ? linked : null;
  if (sso) methods.push("sso");
  return { methods, sso, passkeyCount: passkeys.length };
}

/**
 * B4S-06: does any ACTIVE administrator have a usable step-up method — an
 * enrolled authenticator app, an unrevoked passkey (with a relying party
 * configured: without one no passkey can be used by anyone), or a linked
 * identity at an enabled SSO provider? An SSO link counts whatever the current
 * request's scheme: whether a fresh SSO sign-in is usable depends on how the
 * ADMIN reaches RegulAIt, not on how the bootstrap caller did (a plain-http
 * request to the gateway port must not reopen the bootstrap door).
 */
export async function adminWithStepUpMethodExists(db: Db): Promise<boolean> {
  const passkey = relyingParty()
    ? sql`EXISTS (SELECT 1 FROM ${webauthnCredentials} wc WHERE wc.user_id = ${users.id} AND wc.revoked_at IS NULL)`
    : sql`false`;
  const [hit] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.isAdmin, true),
        isNull(users.disabledAt),
        sql`(${users.totpEnabled} = true OR ${passkey} OR EXISTS (
          SELECT 1 FROM ${federatedIdentities} fi
          LEFT JOIN ${oidcProviders} op ON op.id = fi.oidc_provider_id
          LEFT JOIN ${samlProviders} sp ON sp.id = fi.saml_provider_id
          WHERE fi.user_id = ${users.id} AND (op.enabled = true OR sp.enabled = true)))`,
      ),
    )
    .limit(1);
  return Boolean(hit);
}

/** what GET /v1/org/posture says about the bootstrap credential (B4S-06) */
export async function bootstrapStepUpPosture(db: Db, bootstrapConfigured: boolean) {
  const adminCanStepUp = await adminWithStepUpMethodExists(db);
  return {
    configured: bootstrapConfigured,
    adminWithStepUpMethod: adminCanStepUp,
    passesStepUp: bootstrapConfigured && !adminCanStepUp,
    findings:
      bootstrapConfigured && adminCanStepUp
        ? [
            {
              code: "bootstrap_token_configured",
              detail:
                "REGULAIT_BOOTSTRAP_TOKEN is still set although an administrator can now step up: it is a full-admin " +
                "credential with no identity. Protected actions from it are refused; unset it (and restart) once " +
                "first-admin setup is done.",
            },
          ]
        : [],
  };
}

// ---------------------------------------------------------------------------
// The check every protected route makes
// ---------------------------------------------------------------------------

export interface StepUpCheckArgs {
  kind: StepUpActionKind;
  /** the request facts the SERVER derived; the digest input */
  facts: Record<string, unknown>;
  /** how the decision arrived: a chat tap or a bulk operation can never step up */
  channel?: "http" | "chat" | "bulk";
}

export type StepUpOutcome =
  | { ok: true; method: StepUpMethod | "not_required" | "bootstrap" }
  | { ok: false; status: number; body: Record<string, unknown> };

/** the grant tokens a request presents (comma-separated, at most one per kind) */
function presentedTokens(req: FastifyRequest): string[] {
  const raw = req.headers[STEP_UP_HEADER];
  const joined = Array.isArray(raw) ? raw.join(",") : typeof raw === "string" ? raw : "";
  return joined
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.startsWith(STEP_UP_TOKEN_PREFIX) && t.length <= 128)
    .slice(0, MAX_PRESENTED_GRANTS);
}

/** why a person whose only way to step up is single sign-on cannot use it on this request (B4S-07) */
const SSO_NEEDS_HTTPS_NOTE =
  " (your single sign-on can confirm it's you only when RegulAIt is reached over https, which this request was not)";

const STEP_UP_REQUIRED_DETAIL =
  "this action needs you to confirm it's you: get a step-up for it (POST /v1/auth/step-up/options with the `action` " +
  `below, then /verify) and send the same request again with the ${STEP_UP_HEADER} header`;

/**
 * THE CHECK. `spend: true` claims the matching grant (single use); `spend:
 * false` only looks (for a request that needs two step-ups, so neither grant
 * is burned by the other's refusal). Never sends anything.
 */
export async function checkStepUp(
  db: Db,
  req: FastifyRequest,
  args: StepUpCheckArgs,
  opts: { spend?: boolean } = {},
): Promise<StepUpOutcome> {
  const spend = opts.spend ?? true;
  const policy = await loadStepUpPolicy(db);
  if (!stepUpApplies(policy, args.kind)) return { ok: true, method: "not_required" };
  const caller = stepUpCallerOf(req);
  const action = { kind: args.kind, body: args.facts };
  if (args.channel === "chat") {
    return {
      ok: false,
      status: 403,
      body: {
        error: "chatops_step_up_required",
        actionKind: args.kind,
        methods: [],
        detail: "a decision from chat cannot confirm who made it: open it in RegulAIt and confirm it's you there",
      },
    };
  }
  if (caller.kind === "bootstrap") {
    // B4S-06: first-admin setup only (see the header)
    if (!(await adminWithStepUpMethodExists(db))) return { ok: true, method: "bootstrap" };
    return {
      ok: false,
      status: 403,
      body: {
        error: "step_up_required",
        actionKind: args.kind,
        methods: [],
        credential: "bootstrap",
        detail:
          "the bootstrap credential cannot confirm who is acting, and an administrator here can: sign in to RegulAIt " +
          "as that administrator and do this there (the bootstrap credential passes a step-up only until an admin " +
          "has a way to give one; unset REGULAIT_BOOTSTRAP_TOKEN once setup is done)",
      },
    };
  }
  if (caller.kind === "key" || args.channel === "bulk") {
    return {
      ok: false,
      status: 403,
      body: {
        error: "step_up_required",
        actionKind: args.kind,
        methods: [],
        detail:
          caller.kind === "key"
            ? "an API key cannot confirm who is acting: sign in to RegulAIt in a browser and do this there, " +
              "or an admin may remove this action from the step-up list (audited, itself needs a step-up)"
            : "a bulk operation cannot be stepped up: do this one item at a time and confirm it's you for each",
        ...(caller.kind === "key" ? { credential: "api_key" } : {}),
      },
    };
  }
  const digest = stepUpActionDigest(args.kind, args.facts);
  const tokens = presentedTokens(req);
  if (tokens.length > 0) {
    const where = and(
      inArray(stepUpGrants.tokenHash, tokens.map((t) => hashToken(t))),
      eq(stepUpGrants.userId, caller.userId),
      eq(stepUpGrants.sessionId, caller.sessionId),
      eq(stepUpGrants.actionKind, args.kind),
      eq(stepUpGrants.actionDigest, digest),
      isNull(stepUpGrants.usedAt),
      // statement time, not transaction time: a protected write may check inside a transaction begun before the grant
      gt(stepUpGrants.expiresAt, sql`statement_timestamp()`),
    );
    const [hit] = spend
      ? await db.update(stepUpGrants).set({ usedAt: sql`statement_timestamp()` }).where(where).returning({ method: stepUpGrants.method })
      : await db.select({ method: stepUpGrants.method }).from(stepUpGrants).where(where).limit(1);
    if (hit) return { ok: true, method: hit.method };
    await db.insert(auditLog).values({
      userId: caller.userId,
      objectType: "user",
      objectId: caller.userId,
      detail: { subsystem: "step-up", actionKind: args.kind, presented: tokens.length },
      effect: "deny",
      ruleId: "step-up-grant-refused",
      ruleChain: [],
      reason:
        `a step-up was presented for '${args.kind}' but none is valid for this action ` +
        "(used, expired, made in another session, or made for a different action)",
    });
  }
  const { methods } = await stepUpMethodsFor(db, caller.userId, req);
  if (methods.length === 0) {
    return {
      ok: false,
      status: 422,
      body: {
        error: "step_up_unavailable",
        actionKind: args.kind,
        methods: [],
        detail:
          "this action needs you to confirm it's you, and your account has no way to: enrol an authenticator app " +
          "or a passkey on your Account page first" +
          ((await ssoTargetFor(db, caller.userId)) ? SSO_NEEDS_HTTPS_NOTE : ""),
      },
    };
  }
  return {
    ok: false,
    status: 403,
    body: {
      error: "step_up_required",
      actionKind: args.kind,
      methods,
      action,
      detail: STEP_UP_REQUIRED_DETAIL,
      ...(tokens.length > 0 ? { presentedGrant: "not_valid_for_this_action" } : {}),
    },
  };
}

/**
 * THE ONE HELPER every protected route calls. Sends the refusal itself and
 * answers `{ok: false}`; on `{ok: true}` the grant (if one was needed) has
 * been spent and the route proceeds.
 *
 *   requireStepUp(db, req, reply, { kind, facts, channel? }): Promise<{ ok: true; method } | { ok: false }>
 */
export async function requireStepUp(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  args: StepUpCheckArgs,
): Promise<{ ok: true; method: StepUpMethod | "not_required" | "bootstrap" } | { ok: false }> {
  const out = await checkStepUp(db, req, args, { spend: true });
  if (out.ok) return out;
  await reply.status(out.status).send(out.body);
  return { ok: false };
}

/**
 * A request that needs SEVERAL step-ups (a stewardship write that changes the
 * steward AND lifts a suspension): every one is looked at first without
 * spending, so one refusal never burns another's grant; then each is spent.
 * Sends the first refusal itself; true = proceed.
 */
export async function requireStepUps(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  list: readonly StepUpCheckArgs[],
): Promise<boolean> {
  if (list.length === 1) return (await requireStepUp(db, req, reply, list[0]!)).ok;
  for (const args of list) {
    const out = await checkStepUp(db, req, args, { spend: false });
    if (!out.ok) {
      await reply.status(out.status).send(out.body);
      return false;
    }
  }
  for (const args of list) {
    if (!(await requireStepUp(db, req, reply, args)).ok) return false;
  }
  return true;
}

/**
 * ADR-0186 A: the `owner_change` step-up for one object and its new owner,
 * shared by every writer of an accountable owner (the server and connector
 * owner routes, POST /v1/agents/:id/owner and the agent stewardship PATCH), so
 * a grant made for one of them is good for the same change through another.
 */
export function ownerChangeStepUpArgs(objectType: string, objectId: string, ownerUserId: string | null): StepUpCheckArgs {
  return { kind: "owner_change", facts: { objectType, objectId, ownerUserId } };
}

/**
 * B4S-05: lifting a revocation (deleting it) or narrowing one from `full` to
 * `read_only` gives an entitlement back — a `settings_relax` step-up bound to
 * which revocation, of which kind, for whom, and (for a scope change) to what.
 */
export function revocationLiftStepUp(
  kind: "mcp" | "agent" | "connector",
  revocationId: string,
  userId?: string,
): StepUpCheckArgs {
  return { kind: "settings_relax", facts: { values: { revocationLifted: { kind, revocationId, ...(userId ? { userId } : {}) } } } };
}
export function revocationScopeStepUp(kind: "mcp" | "connectors", revocationId: string, scope: string): StepUpCheckArgs {
  return { kind: "settings_relax", facts: { values: { revocationScope: { kind, revocationId, scope } } } };
}

/**
 * The same check for a writer that has no reply in hand (it returns the
 * refusal for its caller to send): null = proceed, the grant (if one was
 * needed) spent.
 */
export async function stepUpRefusal(
  db: Db,
  req: FastifyRequest,
  args: StepUpCheckArgs,
  opts: { spend?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const out = await checkStepUp(db, req, args, opts);
  return out.ok ? null : { status: out.status, body: out.body };
}

/**
 * The `settings_relax` step-up an approval-rule write that LOOSENS dual control
 * carries (ADR-0180, `assertApprovalRuleLooseningStepUp`): handed by the HTTP
 * route to the rule writer, which calls it inside its lock with the facts it
 * derived (`{ruleId, values}`). Spends the grant (on `db`, outside the
 * writer's transaction, so a refusal's audit row survives the rollback), or
 * throws the refusal for app.ts to answer.
 */
export function approvalRuleStepUp(db: Db, req: FastifyRequest): ApprovalRuleStepUp {
  return async (facts) => {
    const refusal = await stepUpRefusal(db, req, { kind: "settings_relax", facts: { ...facts } });
    if (refusal) throw new ApprovalRuleWriteRefusedError(refusal.status, refusal.body);
  };
}

// ---------------------------------------------------------------------------
// The org-settings hooks (called by PUT /v1/org/settings before the write)
// ---------------------------------------------------------------------------

export interface SettingsRelaxFacts {
  /** the keys this write changes to a value looser than their strict default */
  relaxedKeys: readonly string[];
  /** the new values of those keys (the step-up's action facts) */
  values: Readonly<Record<string, unknown>>;
}

/**
 * A relaxation of any strict setting needs a `settings_relax` step-up bound to
 * exactly the relaxed keys and their new values (`facts = {values}`). Decided
 * against the policy STORED now, so turning `step_up_mode` off, or removing
 * `settings_relax` from `step_up_actions`, itself needs the step-up.
 */
export async function settingsRelaxStepUpRefusal(
  db: Db,
  req: FastifyRequest,
  facts: SettingsRelaxFacts,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const out = await checkStepUp(db, req, { kind: "settings_relax", facts: { values: { ...facts.values } } });
  return out.ok ? null : { status: out.status, body: out.body };
}

/**
 * `settings_relax` for a setting written by its OWN route (not `PUT
 * /v1/org/settings`): a relaxation never skips the step-up because it has a
 * dedicated endpoint. `relaxed` names each setting this write moves to a value
 * looser than its strict default (and different from what is stored) with its
 * new value — the same `{values}` facts the settings writer binds, keys
 * namespaced where the setting lives outside `org_settings`. Empty → nothing
 * is relaxed and nothing is asked (tightening needs no step-up). Sends the
 * refusal itself.
 */
export async function requireRelaxStepUp(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  relaxed: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  if (Object.keys(relaxed).length === 0) return true;
  const out = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { values: { ...relaxed } } });
  return out.ok;
}

/** the keys of `next` that differ from `current` and are looser than `strict` (equality-defined strictness) */
export function relaxedAgainst(
  next: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
  strict: Readonly<Record<string, unknown>>,
  namespace = "",
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined || !(k in strict)) continue;
    if (JSON.stringify(v) === JSON.stringify(current[k])) continue;
    if (JSON.stringify(v) === JSON.stringify(strict[k])) continue;
    out[namespace + k] = v;
  }
  return out;
}

/** a break-glass list as a set: null (never set) and [] both name nobody, and order means nothing */
function breakGlassSet(v: unknown): string {
  return JSON.stringify(Array.isArray(v) ? [...new Set(v.map(String))].sort() : []);
}

/**
 * The break-glass fields of an org-settings write that really change what is
 * stored, or null. `breakGlassUserIds` compares as a SET (a stored null and a
 * submitted [] both name nobody; the same people in another order are the
 * same list), so re-saving an unchanged sign-in policy asks for nothing.
 */
export function breakGlassChange(
  differs: Record<string, unknown>,
  before: { localSignIn?: unknown; breakGlassUserIds?: unknown } = {},
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if ("localSignIn" in differs && differs.localSignIn !== before.localSignIn) out.localSignIn = differs.localSignIn;
  if ("breakGlassUserIds" in differs && breakGlassSet(differs.breakGlassUserIds) !== breakGlassSet(before.breakGlassUserIds)) {
    out.breakGlassUserIds = differs.breakGlassUserIds;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * `break_glass`: changing who holds the break-glass key (`breakGlassUserIds`)
 * or the local sign-in mode it opens (`localSignIn`). Called twice by the
 * settings writer: first without spending (before the relax check), then
 * spending, so a write that needs both step-ups never burns one on the other.
 */
export async function breakGlassStepUpRefusal(
  db: Db,
  req: FastifyRequest,
  facts: Record<string, unknown>,
  opts: { spend: boolean },
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const out = await checkStepUp(db, req, { kind: "break_glass", facts }, { spend: opts.spend });
  return out.ok ? null : { status: out.status, body: out.body };
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

async function issueGrant(
  db: Db,
  args: {
    userId: string;
    sessionId: string;
    stepUpId: string;
    method: StepUpMethod;
    credentialId?: string | null;
    kind: StepUpActionKind;
    digest: string;
  },
): Promise<{ stepUpToken: string; expiresAt: string; method: StepUpMethod; actionKind: StepUpActionKind }> {
  const policy = await loadStepUpPolicy(db);
  const token = STEP_UP_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const [row] = await db
    .insert(stepUpGrants)
    .values({
      tokenHash: hashToken(token),
      userId: args.userId,
      sessionId: args.sessionId,
      stepUpId: args.stepUpId,
      method: args.method,
      credentialId: args.method === "passkey" ? (args.credentialId ?? null) : null,
      actionKind: args.kind,
      actionDigest: args.digest,
      // the database clock, in the same statement as created_at's default
      expiresAt: sql`now() + make_interval(secs => ${policy.maxAgeSeconds})`,
    })
    .returning({ expiresAt: stepUpGrants.expiresAt });
  await db.insert(auditLog).values({
    userId: args.userId,
    objectType: "user",
    objectId: args.userId,
    detail: {
      subsystem: "step-up",
      method: args.method,
      actionKind: args.kind,
      actionDigest: args.digest,
      stepUpId: args.stepUpId,
      maxAgeSeconds: policy.maxAgeSeconds,
      ...(args.credentialId ? { credentialId: args.credentialId } : {}),
    },
    effect: "allow",
    ruleId: "step-up-granted",
    ruleChain: [],
    reason: `step-up for '${args.kind}' proven by ${args.method}; single use, valid ${policy.maxAgeSeconds}s, this session only`,
  });
  return { stepUpToken: token, expiresAt: row!.expiresAt.toISOString(), method: args.method, actionKind: args.kind };
}

async function auditStepUpFailure(db: Db, userId: string, method: string, why: string, detail: Record<string, unknown>) {
  await db.insert(auditLog).values({
    userId,
    objectType: "user",
    objectId: userId,
    detail: { subsystem: "step-up", method, why, ...detail },
    effect: "deny",
    ruleId: "step-up-failed",
    ruleChain: [],
    reason: `step-up by ${method} failed: ${why}`,
  });
}

// ---------------------------------------------------------------------------
// Fresh SSO login (the shared half; the protocol halves live in auth.ts / saml.ts)
// ---------------------------------------------------------------------------

/**
 * The identity-provider callback's FIRST act on a step-up state: claim the
 * ceremony it belongs to, once. The state is single use (two concurrent
 * callbacks: one wins); an expired, already-verified or already-claimed
 * request is not found. No session is read: an IdP callback arrives as a
 * cross-site navigation (SAML: a cross-site POST) that carries no Strict
 * session cookie, so the grant is COLLECTED later by the session that started
 * it (`GET /v1/auth/step-up/:stepUpId`).
 */
export async function claimSsoReauthByState(
  db: Db,
  kind: "oidc" | "saml",
  state: string,
  providerId?: string,
): Promise<SsoReauthRequestRow | null> {
  const [row] = await db
    .select()
    .from(ssoReauthRequests)
    .where(
      and(
        eq(ssoReauthRequests.state, state),
        eq(ssoReauthRequests.providerKind, kind),
        isNull(ssoReauthRequests.verifiedAt),
        gt(ssoReauthRequests.expiresAt, sql`now()`),
        ...(providerId
          ? [kind === "oidc" ? eq(ssoReauthRequests.oidcProviderId, providerId) : eq(ssoReauthRequests.samlProviderId, providerId)]
          : []),
      ),
    );
  if (!row) return null;
  const [claimed] = await db
    .update(webauthnChallenges)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(webauthnChallenges.id, row.stepUpId),
        eq(webauthnChallenges.purpose, "step_up"),
        isNull(webauthnChallenges.usedAt),
        gt(webauthnChallenges.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: webauthnChallenges.id });
  return claimed ? row : null;
}

/** is there a live step-up request with this state (so the callback is a step-up, not a login)? */
export async function isSsoReauthState(db: Db, kind: "oidc" | "saml", state: string): Promise<boolean> {
  const [row] = await db
    .select({ id: ssoReauthRequests.id })
    .from(ssoReauthRequests)
    .where(and(eq(ssoReauthRequests.state, state), eq(ssoReauthRequests.providerKind, kind)));
  return Boolean(row);
}

export type SsoReauthVerdict =
  | { ok: true }
  | { ok: false; status: 403; error: "sso_reauth_identity_mismatch" }
  | { ok: false; status: 409; error: "sso_reauth_stale" };

/**
 * Decide a claimed fresh-login callback: the identity the provider returned
 * must be LINKED to the user who asked (`linkedUserId`, from the federated
 * anchor — never an asserted email), and the provider must have
 * authenticated them AFTER the request (`authTime` strictly later than
 * `requested_at`; a missing time is stale). Only then is the request marked
 * verified; the grant is issued when the session collects it. Audited either
 * way.
 */
export async function finishSsoReauth(
  db: Db,
  row: SsoReauthRequestRow,
  returned: { linkedUserId: string | null; authTime: Date | null; providerName: string },
): Promise<SsoReauthVerdict> {
  const base = { subsystem: "step-up", method: "sso", providerKind: row.providerKind, stepUpId: row.stepUpId, provider: returned.providerName };
  if (returned.linkedUserId !== row.userId) {
    await db.insert(auditLog).values({
      userId: row.userId,
      objectType: "user",
      objectId: row.userId,
      detail: { ...base, why: "identity_mismatch", returnedLinkedUser: returned.linkedUserId },
      effect: "deny",
      ruleId: "step-up-failed",
      ruleChain: [],
      reason: `fresh SSO login for a step-up refused: provider '${returned.providerName}' returned an identity that is not this user's`,
    });
    return { ok: false, status: 403, error: "sso_reauth_identity_mismatch" };
  }
  if (!returned.authTime || returned.authTime.getTime() <= row.requestedAt.getTime()) {
    await db.insert(auditLog).values({
      userId: row.userId,
      objectType: "user",
      objectId: row.userId,
      detail: {
        ...base,
        why: "stale",
        requestedAt: row.requestedAt.toISOString(),
        authTime: returned.authTime ? returned.authTime.toISOString() : null,
      },
      effect: "deny",
      ruleId: "step-up-failed",
      ruleChain: [],
      reason:
        `fresh SSO login for a step-up refused: provider '${returned.providerName}' did not authenticate the person ` +
        "after the request (its auth time is missing or earlier)",
    });
    return { ok: false, status: 409, error: "sso_reauth_stale" };
  }
  await db
    .update(ssoReauthRequests)
    .set({ verifiedAt: sql`now()`, authTime: returned.authTime })
    .where(and(eq(ssoReauthRequests.id, row.id), isNull(ssoReauthRequests.verifiedAt)));
  return { ok: true };
}

const STEP_UP_PAGE_COPY: Record<string, { title: string; detail: string }> = {
  ok: { title: "Confirmed", detail: "You signed in again. Return to RegulAIt: the action you started continues there." },
  sso_reauth_identity_mismatch: {
    title: "That was a different account",
    detail:
      "You signed in at your identity provider as someone other than the person using RegulAIt. Close this window, " +
      "then try again and sign in as yourself.",
  },
  sso_reauth_stale: {
    title: "Sign-in wasn't fresh",
    detail:
      "Your identity provider did not ask you to sign in again, or this request is no longer usable. Close this " +
      "window and start again from RegulAIt.",
  },
};

/**
 * The page the identity-provider callback answers a step-up with (a browser
 * navigation: HTML; anything else: JSON). Static text only — nothing from the
 * request is echoed into it.
 */
export function stepUpResultPage(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  outcome: "ok" | "sso_reauth_identity_mismatch" | "sso_reauth_stale",
  stepUpId: string | null,
) {
  const copy = STEP_UP_PAGE_COPY[outcome]!;
  const accept = typeof req.headers.accept === "string" ? req.headers.accept : "";
  if (!accept.includes("text/html")) {
    return reply
      .status(status)
      .send(outcome === "ok" ? { ok: true, stepUpId } : { error: outcome, detail: copy.detail });
  }
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(copy.title)} — RegulAIt</title><style>
:root{color-scheme:light dark;--bg:#f6f7f9;--panel:#fff;--ink:#14171c;--muted:#4a5260;--line:#d9dde3}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--panel:#171b21;--ink:#e8eaee;--muted:#a7aebb;--line:#2a3039}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{max-width:440px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:1.25rem;margin:0 0 8px}p{color:var(--muted);margin:0}
</style></head><body><main><h1>${esc(copy.title)}</h1><p>${esc(copy.detail)}</p></main></body></html>`;
  return reply.status(status).header("content-type", "text/html; charset=utf-8").send(html);
}

/** what a protocol half needs to start a fresh login */
export interface SsoReauthStartArgs {
  providerId: string;
  stepUpId: string;
  userId: string;
  sessionId: string;
  actionDigest: string;
}
export interface SsoReauthStart {
  redirectUrl: string;
  /** the browser-binding cookie the callback will require (set on the /options response) */
  setCookie: string | null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const BROWSER_SESSION_REQUIRED = {
  error: "browser_session_required",
  detail: "only a person signed in to RegulAIt in a browser can do this — an API key or the bootstrap token cannot",
} as const;

const stepUpIdParam = (params: unknown) => {
  const id = (params as { stepUpId?: unknown })?.stepUpId;
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
};

export function registerStepUpRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string } = {}): void {
  // ---- POST /v1/auth/step-up/options -------------------------------------
  app.post("/v1/auth/step-up/options", async (req, reply) => {
    const caller = stepUpCallerOf(req);
    if (caller.kind !== "session") return reply.status(403).send(BROWSER_SESSION_REQUIRED);
    const body = stepUpOptionsSchema.parse(req.body ?? {});
    const kind = body.action.kind;
    const facts = body.action.body;
    if (JSON.stringify(facts).length > MAX_ACTION_BODY_CHARS) {
      return reply.status(413).send({ error: "step_up_action_too_large", detail: "the action facts are larger than any action has" });
    }
    const digest = stepUpActionDigest(kind, facts);
    const { methods, sso } = await stepUpMethodsFor(db, caller.userId, req);
    if (methods.length === 0) {
      return reply.status(422).send({
        error: "step_up_unavailable",
        actionKind: kind,
        methods: [],
        detail:
          "your account has no way to confirm it's you yet: enrol an authenticator app or a passkey on your Account page" +
          ((await ssoTargetFor(db, caller.userId)) ? SSO_NEEDS_HTTPS_NOTE : ""),
      });
    }

    // hygiene: this user's own finished ceremonies (never another purpose's rows)
    await db
      .delete(webauthnChallenges)
      .where(
        and(
          eq(webauthnChallenges.userId, caller.userId),
          inArray(webauthnChallenges.purpose, ["register", "step_up"]),
          lt(webauthnChallenges.expiresAt, sql`now() - interval '1 hour'`),
        ),
      );
    const rp = relyingParty();
    let passkeyOptions: Awaited<ReturnType<typeof generateAuthenticationOptions>> | null = null;
    if (methods.includes("passkey") && rp) {
      const creds = await activePasskeys(db, caller.userId);
      passkeyOptions = await generateAuthenticationOptions({
        rpID: rp.rpID,
        allowCredentials: creds.map((c) => ({ id: c.credentialId, transports: c.transports })),
        challenge: randomBytes(32),
        userVerification: "required",
        timeout: WEBAUTHN_PROMPT_TIMEOUT_MS,
      });
    }
    const challenge = passkeyOptions?.challenge ?? randomBytes(32).toString("base64url");
    const [row] = await db
      .insert(webauthnChallenges)
      .values({
        userId: caller.userId,
        sessionId: caller.sessionId,
        purpose: "step_up",
        challenge,
        actionKind: kind,
        actionDigest: digest,
        expiresAt: sql`now() + make_interval(secs => ${STEP_UP_CEREMONY_SECONDS})`,
      })
      .returning();
    let ssoStart: SsoReauthStart | null = null;
    // B4S-07: a fresh SSO sign-in is never STARTED on an insecure request
    // (stepUpMethodsFor already left it out; checked again where it starts)
    if (sso && ssoStepUpUsable(req)) {
      try {
        const args: SsoReauthStartArgs = {
          providerId: sso.providerId,
          stepUpId: row!.id,
          userId: caller.userId,
          sessionId: caller.sessionId,
          actionDigest: digest,
        };
        // lazy: the protocol halves import this module, never the reverse at load time
        ssoStart =
          sso.kind === "oidc"
            ? await (await import("./auth.js")).beginOidcReauth(db, opts.dataKey, req, args)
            : await (await import("./saml.js")).beginSamlReauth(db, opts.dataKey, req, args);
      } catch (err) {
        await auditStepUpFailure(db, caller.userId, "sso", "start_failed", {
          providerKind: sso.kind,
          providerId: sso.providerId,
          error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
        });
        ssoStart = null;
      }
    }
    const offered = methods.filter((m) => (m === "sso" ? ssoStart !== null : m === "passkey" ? passkeyOptions !== null : true));
    if (offered.length === 0) {
      return reply.status(422).send({
        error: "step_up_unavailable",
        actionKind: kind,
        methods: [],
        detail: "your identity provider could not be reached for a fresh sign-in, and your account has no other way to confirm it's you",
      });
    }
    if (ssoStart?.setCookie) void reply.header("set-cookie", ssoStart.setCookie);
    return {
      stepUpId: row!.id,
      actionKind: kind,
      methods: offered,
      expiresAt: row!.expiresAt.toISOString(),
      ...(passkeyOptions ? { passkey: { options: passkeyOptions } } : {}),
      ...(ssoStart ? { sso: { redirectUrl: ssoStart.redirectUrl, provider: sso!.providerName } } : {}),
    };
  });

  // ---- POST /v1/auth/step-up/verify --------------------------------------
  app.post("/v1/auth/step-up/verify", async (req, reply) => {
    const caller = stepUpCallerOf(req);
    if (caller.kind !== "session") return reply.status(403).send(BROWSER_SESSION_REQUIRED);
    const body = stepUpVerifySchema.parse(req.body ?? {});
    // ONE attempt per ceremony: claimed before the proof is checked, so a
    // wrong code cannot be retried against the same stepUpId (start again)
    const claim = await consumeWebauthnChallenge(db, {
      id: body.stepUpId,
      userId: caller.userId,
      sessionId: caller.sessionId,
      purpose: "step_up",
    });
    if (!claim.ok) {
      const r = challengeClaimRefusal(claim.reason);
      return reply.status(r.status).send(r.body);
    }
    const ceremony = claim.row;
    const kind = ceremony.actionKind as StepUpActionKind;
    const digest = ceremony.actionDigest!;

    if (body.method === "totp") {
      const [user] = await db.select().from(users).where(eq(users.id, caller.userId));
      if (!user?.totpEnabled || !user.totpSecretCiphertext) {
        return reply.status(409).send({ error: "totp_not_enabled", detail: "no authenticator app is enrolled on this account" });
      }
      if (!opts.dataKey) return reply.status(409).send({ error: "data_key_required" });
      const step = verifyTotp(decryptSecret(opts.dataKey, user.totpSecretCiphertext), body.code, user.totpLastUsedStep);
      // the step is burned ATOMICALLY: a code replayed concurrently (or a step
      // at or before the last one used, at login or here) matches no row
      const burned =
        step === null
          ? []
          : await db
              .update(users)
              .set({ totpLastUsedStep: step })
              .where(
                and(
                  eq(users.id, user.id),
                  sql`(${users.totpLastUsedStep} IS NULL OR ${users.totpLastUsedStep} < ${step})`,
                ),
              )
              .returning({ id: users.id });
      if (burned.length === 0) {
        await auditStepUpFailure(db, user.id, "totp", "invalid_or_replayed_code", { actionKind: kind, stepUpId: ceremony.id });
        return reply.status(401).send({ error: "invalid_code", detail: "that code wasn't accepted — start again with a new code" });
      }
      return issueGrant(db, { userId: user.id, sessionId: caller.sessionId, stepUpId: ceremony.id, method: "totp", kind, digest });
    }

    // passkey
    const rp = relyingParty();
    if (!rp) return reply.status(409).send(PASSKEY_RP_UNCONFIGURED_BODY);
    const response = body.response as unknown as AuthenticationResponseJSON;
    const credentialId = typeof response?.id === "string" ? response.id : "";
    const [cred] = credentialId
      ? await db
          .select()
          .from(webauthnCredentials)
          .where(
            and(
              eq(webauthnCredentials.credentialId, credentialId),
              eq(webauthnCredentials.userId, caller.userId),
              isNull(webauthnCredentials.revokedAt),
            ),
          )
      : [];
    const invalid = async (why: string) => {
      await auditStepUpFailure(db, caller.userId, "passkey", why, { actionKind: kind, stepUpId: ceremony.id });
      return reply.status(422).send({
        error: "passkey_signature_invalid",
        detail: "the passkey response could not be verified — try again with a passkey registered to your account",
      });
    };
    if (!cred) return invalid("unknown_or_revoked_credential");
    let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        credential: {
          id: cred.credentialId,
          publicKey: isoBase64URL.toBuffer(cred.publicKey),
          counter: cred.counter,
          transports: cred.transports,
        },
        requireUserVerification: true,
      });
    } catch (err) {
      return invalid(`verification_error: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`);
    }
    if (!verified.verified || !verified.authenticationInfo.userVerified) return invalid("not_verified");
    // the counter moves forward once: a concurrent use of the same assertion matches no row
    const [moved] = await db
      .update(webauthnCredentials)
      .set({
        counter: verified.authenticationInfo.newCounter,
        lastUsedAt: sql`now()`,
        backedUp: verified.authenticationInfo.credentialBackedUp,
      })
      .where(
        and(
          eq(webauthnCredentials.id, cred.id),
          eq(webauthnCredentials.counter, cred.counter),
          isNull(webauthnCredentials.revokedAt),
        ),
      )
      .returning({ id: webauthnCredentials.id });
    if (!moved) return invalid("counter_race");
    return issueGrant(db, {
      userId: caller.userId,
      sessionId: caller.sessionId,
      stepUpId: ceremony.id,
      method: "passkey",
      credentialId: cred.id,
      kind,
      digest,
    });
  });

  // ---- GET /v1/auth/step-up/:stepUpId (collect a fresh-SSO grant) ---------
  app.get("/v1/auth/step-up/:stepUpId", async (req, reply) => {
    const caller = stepUpCallerOf(req);
    if (caller.kind !== "session") return reply.status(403).send(BROWSER_SESSION_REQUIRED);
    const stepUpId = stepUpIdParam(req.params);
    if (!stepUpId) return reply.status(404).send({ error: "unknown_step_up" });
    const mine = and(
      eq(ssoReauthRequests.stepUpId, stepUpId),
      eq(ssoReauthRequests.userId, caller.userId),
      eq(ssoReauthRequests.sessionId, caller.sessionId),
    );
    // single use: the verified request is collected once, by the session that started it
    const [collected] = await db
      .update(ssoReauthRequests)
      .set({ usedAt: sql`now()` })
      .where(
        and(mine, isNotNull(ssoReauthRequests.verifiedAt), isNull(ssoReauthRequests.usedAt), gt(ssoReauthRequests.expiresAt, sql`now()`)),
      )
      .returning();
    if (collected) {
      const [ceremony] = await db.select().from(webauthnChallenges).where(eq(webauthnChallenges.id, stepUpId));
      const grant = await issueGrant(db, {
        userId: caller.userId,
        sessionId: caller.sessionId,
        stepUpId,
        method: "sso",
        kind: ceremony!.actionKind as StepUpActionKind,
        digest: collected.actionDigest,
      });
      return { status: "granted", ...grant };
    }
    const [row] = await db.select().from(ssoReauthRequests).where(mine);
    if (!row) return reply.status(404).send({ error: "unknown_step_up" });
    const [ceremony] = await db
      .select({ usedAt: webauthnChallenges.usedAt, expiresAt: webauthnChallenges.expiresAt })
      .from(webauthnChallenges)
      .where(eq(webauthnChallenges.id, stepUpId));
    const live = !row.verifiedAt && !row.usedAt && row.expiresAt.getTime() > Date.now() && ceremony && !ceremony.usedAt;
    if (live) return reply.status(202).send({ status: "pending" });
    return reply.status(409).send({
      error: "sso_reauth_stale",
      detail: "this sign-in request is no longer usable (expired, refused or already collected) — start again",
    });
  });
}

/** the fresh-session window for a first passkey (see passkeys.ts) */
export const FIRST_PASSKEY_FRESH_SESSION_SECONDS = 600;

/** when the session behind this request was created, and how (for the first-passkey rule) */
export async function sessionFreshness(db: Db, sessionId: string): Promise<{ createdAt: Date; origin: string } | null> {
  const [row] = await db
    .select({ createdAt: authSessions.createdAt, origin: authSessions.origin })
    .from(authSessions)
    .where(eq(authSessions.id, sessionId));
  return row ?? null;
}


