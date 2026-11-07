/**
 * ADR-0240 — THE ONE SECOND FACTOR OF THE EXTERNAL PORTALS (the supplier portal, ADR-0221, and the auditor portal,
 * ADR-0225). Both portals used to open a session straight from a spent single-use link, so a forwarded or leaked
 * link was the whole credential. While a portal's `…MfaRequired` setting is on (the shipped default, ADR-0180) a
 * spent link opens only a CHALLENGE here; a TOTP code against the grant's factor turns it into the portal's session.
 *
 * REUSED, NOT RE-BUILT (ADR-0176): the TOTP itself is `totp.ts` (the `otpauth` library, the same ±1-step window and
 * the same replay rule the platform login uses), the secret is a data-key envelope (`secrets.ts`, registered in
 * `CIPHERTEXT_COLUMNS`), tokens are 256-bit random values stored as sha256 (`hashToken`), and the rate limit is the
 * gateway's `@fastify/rate-limit`. What is RegulAIt's own is the binding: one factor per external GRANT, enrolment on
 * the first use of a link, a lock after `failuresBeforeLock` wrong or replayed codes, and recovery only through the
 * inviting admin (a reset deletes the factor; the next link enrols again). There is no self-service recovery path.
 *
 * Each portal keeps its own routes, refusal bodies and audit object type; this module holds the state machine and
 * runs inside the portal's transaction, so the link spend, the challenge, the code check and the session commit
 * together.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  and,
  eq,
  externalMfaChallenges,
  externalMfaFactors,
  gt,
  isNull,
  sql,
  type Db,
  type ExternalMfaChallengeRow,
  type ExternalMfaFactorRow,
} from "@regulait/db";
import {
  EXTERNAL_MFA_COOKIE,
  EXTERNAL_MFA_LIMITS as L,
  EXTERNAL_MFA_PATHS,
  EXTERNAL_MFA_TOKEN_PREFIX,
  EXTERNAL_MFA_TOKEN_RE,
  type ExternalMfaPortal,
} from "@regulait/shared";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { hashToken } from "./token-hash.js";
import { generateTotpSecret, otpauthUri, verifyTotp } from "./totp.js";

/** the grant a factor belongs to and the link that was just spent, per portal */
export type ExternalGrantRef =
  | { portal: "supplier"; grantId: string; linkId: string }
  | { portal: "auditor"; grantId: string; linkId: string };

const grantColumn = (portal: ExternalMfaPortal) =>
  portal === "supplier" ? externalMfaFactors.supplierAccessId : externalMfaFactors.auditorGrantId;

export type ExternalMfaState = "none" | "enrolling" | "active" | "locked";

export function factorState(f: Pick<ExternalMfaFactorRow, "activatedAt" | "lockedAt"> | undefined): ExternalMfaState {
  if (!f) return "none";
  if (f.lockedAt) return "locked";
  return f.activatedAt ? "active" : "enrolling";
}

/** the factor of a grant, for the admin views (no secret) */
export async function loadFactorView(db: Db, portal: ExternalMfaPortal, grantId: string) {
  const [f] = await db.select().from(externalMfaFactors).where(eq(grantColumn(portal), grantId));
  return {
    state: factorState(f),
    enrolledAt: f?.activatedAt?.toISOString() ?? null,
    failedAttempts: f?.failedAttempts ?? 0,
    lockedAt: f?.lockedAt?.toISOString() ?? null,
  };
}

/** a challenge handle: 256 random bits, opaque (no grant, factor or code in it); only its sha256 is stored */
export function newChallengeToken(): { token: string; tokenHash: string } {
  const token = EXTERNAL_MFA_TOKEN_PREFIX + randomBytes(32).toString("hex");
  return { token, tokenHash: hashToken(token) };
}

export type StartOutcome =
  | { kind: "locked"; factorId: string }
  | { kind: "challenge"; factorId: string; token: string; expiresAt: Date; enrol: { secret: string; otpauthUri: string } | null };

/**
 * After the portal has SPENT a link (inside its transaction): open the challenge. First use of the grant (or an
 * enrolment that was never proved) gets a fresh secret, shown once; an active factor gets a verify challenge; a
 * locked factor gets nothing. Any earlier open challenge of the factor is revoked, so one is live at a time.
 */
export async function startChallenge(tx: Db, ref: ExternalGrantRef, dataKey: string, accountLabel: string): Promise<StartOutcome> {
  const col = grantColumn(ref.portal);
  let [factor] = await tx.select().from(externalMfaFactors).where(eq(col, ref.grantId)).for("update");
  if (factor?.lockedAt) return { kind: "locked", factorId: factor.id };
  let enrol: { secret: string; otpauthUri: string } | null = null;
  if (!factor || !factor.activatedAt) {
    const secret = generateTotpSecret();
    const secretCiphertext = encryptSecret(dataKey, secret);
    if (!factor) {
      [factor] = await tx
        .insert(externalMfaFactors)
        .values(ref.portal === "supplier" ? { supplierAccessId: ref.grantId, secretCiphertext } : { auditorGrantId: ref.grantId, secretCiphertext })
        .returning();
    } else {
      // an enrolment never proved is no factor: a new link starts it again with a new secret (failures carry over)
      [factor] = await tx
        .update(externalMfaFactors)
        .set({ secretCiphertext, lastUsedStep: null })
        .where(eq(externalMfaFactors.id, factor.id))
        .returning();
    }
    enrol = { secret, otpauthUri: otpauthUri(accountLabel, secret) };
  }
  await tx
    .update(externalMfaChallenges)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(externalMfaChallenges.factorId, factor!.id), isNull(externalMfaChallenges.consumedAt), isNull(externalMfaChallenges.revokedAt)));
  const { token, tokenHash } = newChallengeToken();
  const [challenge] = await tx
    .insert(externalMfaChallenges)
    .values({
      factorId: factor!.id,
      ...(ref.portal === "supplier" ? { supplierInvitationId: ref.linkId } : { auditorLinkId: ref.linkId }),
      tokenHash,
      expiresAt: sql`now() + make_interval(mins => ${L.challengeMinutes})`,
    })
    .returning();
  return { kind: "challenge", factorId: factor!.id, token, expiresAt: challenge!.expiresAt, enrol };
}

export type VerifyOutcome =
  | { ok: true; factor: ExternalMfaFactorRow; challenge: ExternalMfaChallengeRow; enrolled: boolean }
  | { ok: false; reason: "challenge" }
  | { ok: false; reason: "locked"; factor: ExternalMfaFactorRow }
  | { ok: false; reason: "code"; factor: ExternalMfaFactorRow; failures: number; lockedNow: boolean };

/**
 * Check a code against the challenge's factor (inside the portal's transaction, which must COMMIT on a refusal so
 * the failure count holds). A wrong code and a replayed one count the same; reaching the limit locks the factor and
 * revokes its open challenges. On success the challenge is spent, the step recorded and the count reset.
 */
export async function verifyChallenge(tx: Db, portal: ExternalMfaPortal, challengeToken: string, code: string, dataKey: string): Promise<VerifyOutcome> {
  if (!EXTERNAL_MFA_TOKEN_RE.test(challengeToken)) return { ok: false, reason: "challenge" };
  const [row] = await tx
    .select({ challenge: externalMfaChallenges, factor: externalMfaFactors })
    .from(externalMfaChallenges)
    .innerJoin(externalMfaFactors, eq(externalMfaFactors.id, externalMfaChallenges.factorId))
    .where(
      and(
        eq(externalMfaChallenges.tokenHash, hashToken(challengeToken)),
        isNull(externalMfaChallenges.consumedAt),
        isNull(externalMfaChallenges.revokedAt),
        gt(externalMfaChallenges.expiresAt, sql`now()`),
      ),
    )
    .for("update", { of: [externalMfaFactors, externalMfaChallenges] });
  // a challenge of the other portal is no challenge here
  const ofPortal = portal === "supplier" ? row?.factor.supplierAccessId && row.challenge.supplierInvitationId : row?.factor.auditorGrantId && row.challenge.auditorLinkId;
  if (!row || !ofPortal) return { ok: false, reason: "challenge" };
  const { factor, challenge } = row;
  if (factor.lockedAt) return { ok: false, reason: "locked", factor };
  const step = verifyTotp(decryptSecret(dataKey, factor.secretCiphertext), code, factor.lastUsedStep);
  const [proved] =
    step === null
      ? []
      : await tx
          .update(externalMfaFactors)
          .set({ lastUsedStep: step, failedAttempts: 0, activatedAt: sql`coalesce(${externalMfaFactors.activatedAt}, now())` })
          .where(
            and(
              eq(externalMfaFactors.id, factor.id),
              isNull(externalMfaFactors.lockedAt),
              sql`(${externalMfaFactors.lastUsedStep} IS NULL OR ${externalMfaFactors.lastUsedStep} < ${step})`,
            ),
          )
          .returning();
  if (!proved) {
    const failures = factor.failedAttempts + 1;
    const lockedNow = failures >= L.failuresBeforeLock;
    const [after] = await tx
      .update(externalMfaFactors)
      .set({ failedAttempts: sql`least(${externalMfaFactors.failedAttempts} + 1, 100)`, ...(lockedNow ? { lockedAt: sql`now()` } : {}) })
      .where(eq(externalMfaFactors.id, factor.id))
      .returning();
    if (lockedNow) {
      await tx
        .update(externalMfaChallenges)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(externalMfaChallenges.factorId, factor.id), isNull(externalMfaChallenges.consumedAt), isNull(externalMfaChallenges.revokedAt)));
    }
    return { ok: false, reason: "code", factor: after!, failures, lockedNow };
  }
  const [spent] = await tx
    .update(externalMfaChallenges)
    .set({ consumedAt: sql`now()` })
    .where(eq(externalMfaChallenges.id, challenge.id))
    .returning();
  return { ok: true, factor: proved, challenge: spent!, enrolled: factor.activatedAt === null };
}

/** the inviting admin's recovery: the factor is deleted (its challenges with it); the next link enrols again */
export async function resetFactor(tx: Db, portal: ExternalMfaPortal, grantId: string): Promise<ExternalMfaFactorRow | undefined> {
  const [gone] = await tx.delete(externalMfaFactors).where(eq(grantColumn(portal), grantId)).returning();
  return gone;
}

/** revoke every open challenge of a portal (the portal was turned off) */
export async function revokePortalChallenges(tx: Db, portal: ExternalMfaPortal): Promise<number> {
  const linkCol = portal === "supplier" ? externalMfaChallenges.supplierInvitationId : externalMfaChallenges.auditorLinkId;
  const rows = await tx
    .update(externalMfaChallenges)
    .set({ revokedAt: sql`now()` })
    .where(and(sql`${linkCol} IS NOT NULL`, isNull(externalMfaChallenges.consumedAt), isNull(externalMfaChallenges.revokedAt)))
    .returning({ id: externalMfaChallenges.id });
  return rows.length;
}

// ---------------------------------------------------------------------------------------------------------------
// the challenge cookie: HttpOnly, SameSite=Strict, scoped to the portal's verify path only
// ---------------------------------------------------------------------------------------------------------------

export function challengeCookie(portal: ExternalMfaPortal, token: string, secure: boolean, maxAgeSeconds: number): string {
  return `${EXTERNAL_MFA_COOKIE}=${token}; Path=${EXTERNAL_MFA_PATHS[portal]}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}` + (secure ? "; Secure" : "");
}

export const challengeCookieFor = (portal: ExternalMfaPortal, token: string, expiresAt: Date, secure: boolean) =>
  challengeCookie(portal, token, secure, Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)));


// ---------------------------------------------------------------------------------------------------------------
// the per-challenge rate limit (on top of each portal's per-address bucket and the gateway-wide limiter)
// ---------------------------------------------------------------------------------------------------------------

type Limiter = (req: FastifyRequest) => Promise<{ isExceeded: boolean; ttlInSeconds: number }>;

export function externalMfaLimiter(app: FastifyInstance): (req: FastifyRequest, reply: FastifyReply, challengeToken: string) => Promise<boolean> {
  let limiter: Limiter | null = null;
  const bucket = new WeakMap<FastifyRequest, string>();
  return async (req, reply, challengeToken) => {
    // REGULAIT_RATE_LIMIT=off turns every HTTP limiter off at once; this bucket follows it
    if (!app.hasDecorator("createRateLimit")) return false;
    limiter ??= app.createRateLimit({
      keyGenerator: (r: FastifyRequest) => bucket.get(r) ?? `xm:addr:${r.ip}`,
      max: L.perChallenge.max,
      timeWindow: L.perChallenge.windowMs,
      allowList: () => false,
    }) as unknown as Limiter;
    bucket.set(req, `xm:ch:${hashToken(challengeToken)}`);
    const v = await limiter(req);
    if (!v.isExceeded) return false;
    await reply.status(429).header("retry-after", String(v.ttlInSeconds)).send({
      error: "rate_limited",
      detail: `Too many codes. Try again in ${Math.max(1, Math.ceil(v.ttlInSeconds / 60))} minutes.`,
      retryAfterSeconds: v.ttlInSeconds,
    });
    return true;
  };
}
