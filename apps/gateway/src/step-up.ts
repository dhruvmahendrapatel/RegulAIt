/**
 * ADR-0186 A — STEP-UP (slice A, Claude). FOUNDATION: routes answer 501, the
 * settings hook admits everything, and one real helper — the single-use
 * challenge claim — that slices A and B both build on.
 *
 * Routes (self = a signed-in user acting for themselves; AgentCoordination §4.9):
 *   POST /v1/auth/step-up/options   {action:{kind, body}} → {stepUpId, methods, passkey:{options}, sso:{redirectUrl}}
 *   POST /v1/auth/step-up/verify    {stepUpId, method:"totp", code} | {stepUpId, method:"passkey", response}
 *                                   → {stepUpToken:"rgsu_…", expiresAt}
 *   GET  /v1/auth/step-up/:stepUpId → the token once the IdP callback verified a fresh SSO login
 * The grant rides `x-regulait-step-up` (`STEP_UP_HEADER`). API keys, chat taps and
 * bulk decide cannot step up.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, gt, isNull, sql, webauthnChallenges, type Db, type WebauthnChallengeRow } from "@regulait/db";
import { BATCH4_NOT_BUILT, type WebauthnChallengePurpose } from "@regulait/shared";

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

// ---------------------------------------------------------------------------
// The settings_relax hook (called by PUT /v1/org/settings before the write)
// ---------------------------------------------------------------------------

export interface SettingsRelaxFacts {
  /** the keys this write changes to a value looser than their strict default */
  relaxedKeys: readonly string[];
  /** the new values of those keys (the step-up's action facts) */
  values: Readonly<Record<string, unknown>>;
}

/**
 * SLICE A FILLS THIS. A relaxation of any strict setting needs a `settings_relax`
 * step-up (ADR-0186 §Migration 0170): when `relaxedKeys` is non-empty and
 * `settings_relax` is in `org_settings.step_up_actions` under `step_up_mode =
 * required`, the request must carry a grant bound to
 * `stepUpActionDigest("settings_relax", values)`, else this returns the 403
 * `step_up_required` body (or 422 `step_up_unavailable`). The foundation admits
 * every write (returns null), so today's behaviour is unchanged.
 */
export async function settingsRelaxStepUpRefusal(
  _db: Db,
  _req: FastifyRequest,
  _facts: SettingsRelaxFacts,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  return null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerStepUpRoutes(app: FastifyInstance, _db: Db): void {
  const notBuilt = async (_req: unknown, reply: FastifyReply) => reply.status(501).send(BATCH4_NOT_BUILT);
  app.post("/v1/auth/step-up/options", notBuilt);
  app.post("/v1/auth/step-up/verify", notBuilt);
  app.get("/v1/auth/step-up/:stepUpId", notBuilt);
}
