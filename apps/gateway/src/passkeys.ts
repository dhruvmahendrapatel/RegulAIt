/**
 * ADR-0186 A/B — PASSKEYS (WebAuthn credentials; slice A).
 *
 * Self (a signed-in person in a browser session — never an API key):
 *   POST   /v1/auth/passkeys/registration-options  {} → {challengeId, options}
 *   POST   /v1/auth/passkeys                       {challengeId, response, label} → 201 {id, label, createdAt, backedUp}
 *   GET    /v1/auth/passkeys                       → {passkeys:[{id, label, createdAt, lastUsedAt, backedUp}], rpConfigured}
 *   PATCH  /v1/auth/passkeys/:passkeyId            {label} → the passkey (a label is cosmetic: no step-up)
 *   DELETE /v1/auth/passkeys/:passkeyId            → revoked (needs a `passkey_manage` step-up)
 * Admin (default admin gate):
 *   GET    /v1/users/:userId/passkeys · DELETE /v1/users/:userId/passkeys/:passkeyId {reason?}
 *          (revoke, audited; the admin's own `passkey_manage` step-up)
 *
 * WebAuthn is `@simplewebauthn/server` (pinned). RP ID = hostname of
 * `REGULAIT_PUBLIC_URL`; unset → 409 `passkey_rp_unconfigured`. User
 * verification is REQUIRED on every ceremony.
 *
 * ATTESTATION `none` ONLY (ADR-0186 foundation note). Registration requests
 * `attestationType: "none"`, and a response whose attestation format is not
 * `none` is REFUSED BEFORE the library verifies it: verifying a
 * certificate-bearing attestation makes the library fetch the CRL URLs named
 * in the attacker-supplied certificate (an outbound request outside the egress
 * guard). The metadata service is never initialised. What `none` gives up is
 * knowing the authenticator's make and model; no product decision rests on it.
 *
 * THE ENROLMENT BOOTSTRAP RULE (who may add a passkey):
 *  - The account already has a passkey → a `passkey_manage` step-up (with any
 *    method the account has), exactly like revoking one. A stolen session
 *    cannot add an attacker's passkey next to the owner's.
 *  - No passkey yet, but the account can already step up (an authenticator app
 *    or a linked SSO identity) and the org requires `passkey_manage` step-ups →
 *    that step-up. The first passkey is a NEW way to prove it is the person,
 *    so it is gated by the ways that already exist.
 *  - Otherwise (no way to step up at all, or the org relaxed `passkey_manage`)
 *    → the session must be FRESH: established by a human sign-in (password,
 *    OIDC or SAML — never an API-key exchange or the bootstrap token) within
 *    the last 10 minutes. A long-lived stolen cookie, or an API key exchanged
 *    for a session, cannot mint the account's first step-up credential.
 * The rule is checked when the registration ceremony is CREATED (the options
 * route); the ceremony is then single use and bound to this session.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { decodeAttestationObject, isoBase64URL } from "@simplewebauthn/server/helpers";
import { and, asc, auditLog, eq, isNull, sql, users, webauthnChallenges, webauthnCredentials, type Db } from "@regulait/db";
import { registerPasskeySchema, renamePasskeySchema, WEBAUTHN_TRANSPORTS, type WebauthnTransport } from "@regulait/shared";
import { z } from "zod";
import {
  activePasskeys,
  challengeClaimRefusal,
  consumeWebauthnChallenge,
  FIRST_PASSKEY_FRESH_SESSION_SECONDS,
  loadStepUpPolicy,
  PASSKEY_RP_UNCONFIGURED_BODY,
  relyingParty,
  requireStepUp,
  sessionFreshness,
  STEP_UP_CEREMONY_SECONDS,
  stepUpApplies,
  stepUpCallerOf,
  stepUpMethodsFor,
  WEBAUTHN_PROMPT_TIMEOUT_MS,
} from "./step-up.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const HUMAN_SIGN_IN_ORIGINS = new Set(["password", "oidc", "saml"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BROWSER_SESSION_REQUIRED = {
  error: "browser_session_required",
  detail: "only a person signed in to RegulAIt in a browser can manage passkeys — an API key or the bootstrap token cannot",
} as const;

/** a passkey as the API shows it (never the public key or counter) */
function publicPasskey(row: typeof webauthnCredentials.$inferSelect) {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    backedUp: row.backedUp,
  };
}

/** the stored COSE public key (base64url) and the attestation format, read without verifying anything */
export function attestationFormatOf(response: unknown): string | null {
  const att = (response as { response?: { attestationObject?: unknown } })?.response?.attestationObject;
  if (typeof att !== "string" || att.length === 0 || att.length > 64 * 1024) return null;
  try {
    const fmt = decodeAttestationObject(isoBase64URL.toBuffer(att)).get("fmt");
    return typeof fmt === "string" ? fmt : null;
  } catch {
    return null;
  }
}

async function audit(
  db: Db,
  actorUserId: string,
  targetUserId: string,
  ruleId: string,
  effect: "allow" | "deny",
  reason: string,
  detail: Record<string, unknown>,
) {
  await db.insert(auditLog).values({
    userId: actorUserId || NIL_UUID,
    objectType: "user",
    objectId: targetUserId,
    detail: { subsystem: "passkeys", ...detail },
    effect,
    ruleId,
    ruleChain: [],
    reason,
  });
}

/**
 * Revoke one passkey (kept, never deleted: the decisions it signed stay
 * attributable). The caller has already passed the `passkey_manage` step-up.
 */
async function revokePasskey(
  db: Db,
  args: { ownerUserId: string; passkeyId: string; actorUserId: string; reason: string; byAdmin: boolean },
): Promise<{ ok: true; row: typeof webauthnCredentials.$inferSelect } | { ok: false }> {
  const [row] = await db
    .update(webauthnCredentials)
    .set({ revokedAt: sql`now()`, revokedByUserId: args.actorUserId, revokeReason: args.reason })
    .where(
      and(
        eq(webauthnCredentials.id, args.passkeyId),
        eq(webauthnCredentials.userId, args.ownerUserId),
        isNull(webauthnCredentials.revokedAt),
      ),
    )
    .returning();
  if (!row) return { ok: false };
  await audit(
    db,
    args.actorUserId,
    args.ownerUserId,
    "passkey-revoked",
    "allow",
    args.byAdmin
      ? `an admin revoked passkey '${row.label}' of user ${args.ownerUserId}: ${row.revokeReason}`
      : `user revoked their passkey '${row.label}'`,
    { passkeyId: row.id, byAdmin: args.byAdmin, transitions: { revoked: { from: false, to: true } } },
  );
  return { ok: true, row };
}

/**
 * The enrolment bootstrap rule (see the header). Sends the refusal itself and
 * answers false; true = this session may create a registration ceremony.
 */
async function mayEnrol(db: Db, req: FastifyRequest, reply: FastifyReply, userId: string, sessionId: string): Promise<boolean> {
  const { methods, passkeyCount } = await stepUpMethodsFor(db, userId, req);
  const policy = await loadStepUpPolicy(db);
  // a passkey already exists, or another way to step up does: gated by a passkey_manage step-up
  if (stepUpApplies(policy, "passkey_manage") && (passkeyCount > 0 || methods.length > 0)) {
    const su = await requireStepUp(db, req, reply, { kind: "passkey_manage", facts: { op: "register" } });
    return su.ok;
  }
  // no way to step up yet (or the org relaxed passkey_manage, audited): a fresh human sign-in
  const fresh = await sessionFreshness(db, sessionId);
  const ageSeconds = fresh ? (Date.now() - fresh.createdAt.getTime()) / 1000 : Infinity;
  if (!fresh || !HUMAN_SIGN_IN_ORIGINS.has(fresh.origin) || ageSeconds > FIRST_PASSKEY_FRESH_SESSION_SECONDS) {
    await audit(db, userId, userId, "passkey-enrol-refused", "deny",
      "passkey enrolment refused: the session is not a fresh human sign-in (sign out and in again, then add the passkey)",
      { why: "session_not_fresh", origin: fresh?.origin ?? null, ageSeconds: Number.isFinite(ageSeconds) ? Math.round(ageSeconds) : null });
    await reply.status(403).send({
      error: "fresh_sign_in_required",
      detail:
        "adding your first passkey needs a fresh sign-in: sign out, sign in again with your password or single " +
        `sign-on, and add it within ${FIRST_PASSKEY_FRESH_SESSION_SECONDS / 60} minutes`,
    });
    return false;
  }
  return true;
}

export function registerPasskeyRoutes(app: FastifyInstance, db: Db): void {
  const selfCaller = (req: FastifyRequest) => {
    const c = stepUpCallerOf(req);
    return c.kind === "session" ? c : null;
  };
  const passkeyIdOf = (params: unknown) => {
    const id = (params as { passkeyId?: unknown })?.passkeyId;
    return typeof id === "string" && UUID_RE.test(id) ? id : null;
  };

  // ---- registration options ------------------------------------------------
  app.post("/v1/auth/passkeys/registration-options", async (req, reply) => {
    const caller = selfCaller(req);
    if (!caller) return reply.status(403).send(BROWSER_SESSION_REQUIRED);
    const rp = relyingParty();
    if (!rp) return reply.status(409).send(PASSKEY_RP_UNCONFIGURED_BODY);
    if (!(await mayEnrol(db, req, reply, caller.userId, caller.sessionId))) return reply;
    const [user] = await db.select().from(users).where(eq(users.id, caller.userId));
    if (!user) return reply.status(404).send({ error: "unknown_user" });
    const existing = await activePasskeys(db, caller.userId);
    const options = await generateRegistrationOptions({
      rpName: rp.rpName,
      rpID: rp.rpID,
      userName: user.email,
      userDisplayName: user.displayName ?? user.email,
      // the WebAuthn user handle: the account id's bytes (no personal data)
      userID: new TextEncoder().encode(user.id),
      challenge: randomBytes(32),
      timeout: WEBAUTHN_PROMPT_TIMEOUT_MS,
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
    const [row] = await db
      .insert(webauthnChallenges)
      .values({
        userId: caller.userId,
        sessionId: caller.sessionId,
        purpose: "register",
        challenge: options.challenge,
        expiresAt: sql`now() + make_interval(secs => ${STEP_UP_CEREMONY_SECONDS})`,
      })
      .returning({ id: webauthnChallenges.id });
    return { challengeId: row!.id, options };
  });

  // ---- register ------------------------------------------------------------
  app.post("/v1/auth/passkeys", async (req, reply) => {
    const caller = selfCaller(req);
    if (!caller) return reply.status(403).send(BROWSER_SESSION_REQUIRED);
    const rp = relyingParty();
    if (!rp) return reply.status(409).send(PASSKEY_RP_UNCONFIGURED_BODY);
    const body = registerPasskeySchema.parse(req.body ?? {});
    const claim = await consumeWebauthnChallenge(db, {
      id: body.challengeId,
      userId: caller.userId,
      sessionId: caller.sessionId,
      purpose: "register",
    });
    if (!claim.ok) {
      const r = challengeClaimRefusal(claim.reason);
      return reply.status(r.status).send(r.body);
    }
    // ATTESTATION `none` ONLY, decided BEFORE the library verifies anything
    const fmt = attestationFormatOf(body.response);
    if (fmt !== "none") {
      await audit(db, caller.userId, caller.userId, "passkey-attestation-refused", "deny",
        `passkey registration refused: attestation format '${fmt ?? "unreadable"}' is not 'none' (never verified, nothing fetched)`,
        { fmt: fmt ?? null });
      return reply.status(422).send({
        error: "passkey_attestation_refused",
        detail:
          "this passkey sent a manufacturer attestation, which RegulAIt does not accept: try again (the browser " +
          "should not send one), or use a different passkey",
      });
    }
    let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verified = await verifyRegistrationResponse({
        response: body.response as unknown as RegistrationResponseJSON,
        expectedChallenge: claim.row.challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: true,
      });
    } catch (err) {
      await audit(db, caller.userId, caller.userId, "passkey-registration-failed", "deny",
        "passkey registration failed verification",
        { error: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
      return reply.status(422).send({ error: "passkey_signature_invalid", detail: "the passkey response could not be verified — try again" });
    }
    if (!verified.verified || verified.registrationInfo.fmt !== "none" || !verified.registrationInfo.userVerified) {
      return reply.status(422).send({ error: "passkey_signature_invalid", detail: "the passkey response could not be verified — try again" });
    }
    const info = verified.registrationInfo;
    const transports = (info.credential.transports ?? []).filter((t): t is WebauthnTransport =>
      (WEBAUTHN_TRANSPORTS as readonly string[]).includes(t),
    );
    const aaguid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(info.aaguid) ? info.aaguid : null;
    const inserted = await db
      .insert(webauthnCredentials)
      .values({
        userId: caller.userId,
        credentialId: info.credential.id,
        publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
        counter: info.credential.counter,
        transports,
        aaguid,
        backedUp: info.credentialBackedUp,
        label: body.label,
      })
      .onConflictDoNothing()
      .returning();
    const row = inserted[0];
    if (!row) return reply.status(409).send({ error: "passkey_already_registered", detail: "this passkey is already registered" });
    await audit(db, caller.userId, caller.userId, "passkey-registered", "allow",
      `user registered passkey '${row.label}' (attestation none, user verification required)`,
      { passkeyId: row.id, backedUp: row.backedUp, transports });
    return reply.status(201).send({ id: row.id, label: row.label, createdAt: row.createdAt.toISOString(), backedUp: row.backedUp });
  });

  // ---- list ----------------------------------------------------------------
  app.get("/v1/auth/passkeys", async (req, reply) => {
    const caller = selfCaller(req);
    if (!caller) return reply.status(403).send(BROWSER_SESSION_REQUIRED);
    const rows = await db
      .select()
      .from(webauthnCredentials)
      .where(and(eq(webauthnCredentials.userId, caller.userId), isNull(webauthnCredentials.revokedAt)))
      .orderBy(asc(webauthnCredentials.createdAt));
    return { passkeys: rows.map(publicPasskey), rpConfigured: relyingParty() !== null };
  });

  // ---- rename (cosmetic: no step-up) ---------------------------------------
  app.patch("/v1/auth/passkeys/:passkeyId", async (req, reply) => {
    const caller = selfCaller(req);
    if (!caller) return reply.status(403).send(BROWSER_SESSION_REQUIRED);
    const passkeyId = passkeyIdOf(req.params);
    if (!passkeyId) return reply.status(404).send({ error: "unknown_passkey" });
    const body = renamePasskeySchema.parse(req.body ?? {});
    const [before] = await db
      .select()
      .from(webauthnCredentials)
      .where(and(eq(webauthnCredentials.id, passkeyId), eq(webauthnCredentials.userId, caller.userId), isNull(webauthnCredentials.revokedAt)));
    if (!before) return reply.status(404).send({ error: "unknown_passkey" });
    const [row] = await db
      .update(webauthnCredentials)
      .set({ label: body.label })
      .where(eq(webauthnCredentials.id, passkeyId))
      .returning();
    await audit(db, caller.userId, caller.userId, "passkey-renamed", "allow", "user renamed a passkey", {
      passkeyId,
      transitions: { label: { from: before.label, to: row!.label } },
    });
    return publicPasskey(row!);
  });

  // ---- revoke (self; passkey_manage step-up) --------------------------------
  app.delete("/v1/auth/passkeys/:passkeyId", async (req, reply) => {
    const caller = selfCaller(req);
    if (!caller) return reply.status(403).send(BROWSER_SESSION_REQUIRED);
    const passkeyId = passkeyIdOf(req.params);
    if (!passkeyId) return reply.status(404).send({ error: "unknown_passkey" });
    const [owned] = await db
      .select({ id: webauthnCredentials.id })
      .from(webauthnCredentials)
      .where(and(eq(webauthnCredentials.id, passkeyId), eq(webauthnCredentials.userId, caller.userId), isNull(webauthnCredentials.revokedAt)));
    if (!owned) return reply.status(404).send({ error: "unknown_passkey" });
    const su = await requireStepUp(db, req, reply, { kind: "passkey_manage", facts: { op: "revoke", passkeyId } });
    if (!su.ok) return reply;
    const out = await revokePasskey(db, {
      ownerUserId: caller.userId,
      passkeyId,
      actorUserId: caller.userId,
      reason: "revoked by its owner",
      byAdmin: false,
    });
    if (!out.ok) return reply.status(404).send({ error: "unknown_passkey" });
    return { ...publicPasskey(out.row), revoked: true };
  });

  // ---- admin: list and revoke another user's passkeys -----------------------
  const userIdOf = (params: unknown) => {
    const id = (params as { userId?: unknown })?.userId;
    return typeof id === "string" && UUID_RE.test(id) ? id : null;
  };
  app.get("/v1/users/:userId/passkeys", async (req, reply) => {
    const userId = userIdOf(req.params);
    if (!userId) return reply.status(404).send({ error: "unknown_user" });
    const rows = await db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, userId))
      .orderBy(asc(webauthnCredentials.createdAt));
    return {
      passkeys: rows.map((r) => ({
        ...publicPasskey(r),
        revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
        revokeReason: r.revokeReason,
      })),
    };
  });

  const adminRevokeBody = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict();
  app.delete("/v1/users/:userId/passkeys/:passkeyId", async (req, reply) => {
    const userId = userIdOf(req.params);
    const passkeyId = passkeyIdOf(req.params);
    if (!userId || !passkeyId) return reply.status(404).send({ error: "unknown_passkey" });
    const body = adminRevokeBody.parse(req.body ?? {});
    const [owned] = await db
      .select({ id: webauthnCredentials.id })
      .from(webauthnCredentials)
      .where(and(eq(webauthnCredentials.id, passkeyId), eq(webauthnCredentials.userId, userId), isNull(webauthnCredentials.revokedAt)));
    if (!owned) return reply.status(404).send({ error: "unknown_passkey" });
    const su = await requireStepUp(db, req, reply, { kind: "passkey_manage", facts: { op: "revoke", userId, passkeyId } });
    if (!su.ok) return reply;
    const out = await revokePasskey(db, {
      ownerUserId: userId,
      passkeyId,
      actorUserId: req.authCtx.userId ?? NIL_UUID,
      reason: body.reason ?? "revoked by an admin",
      byAdmin: true,
    });
    if (!out.ok) return reply.status(404).send({ error: "unknown_passkey" });
    return { ...publicPasskey(out.row), revoked: true, revokedAt: out.row.revokedAt?.toISOString() ?? null };
  });
}
