/**
 * ADR-0187 B5-F — RUNNER CREDENTIALS and THE RUNNER ROUTE ALLOW-LIST.
 *
 * Two credentials, both stored only as sha256 (the `hashToken` every other
 * credential uses):
 *   - `rgee_…` a ONE-TIME enrolment token, minted by an admin on the Engines
 *     page for one engine, at most 60 minutes, spent by the register route;
 *   - `rge_…`  the runner token that register hands back. It reaches exactly
 *     `ENGINE_RUNNER_ROUTES` (lease, heartbeat, artifact, result) and nothing
 *     else, for its own engine only.
 *
 * Neither is a user (`userId` null, never admin). The allow-list is enforced by
 * `registerEngineRunnerScopeHook`, which runs right after authentication and
 * BEFORE the admin gate, the same way the virtual-key ceiling does: a route
 * added tomorrow is unreachable on a runner token until it is named in the
 * shared list. It also runs the other way: a runner route refuses every
 * credential that is not a runner token (a person or an API key cannot lease
 * work or post a result).
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, engineEnrollmentTokens, engineRunners, eq, gt, sql, type Db } from "@regulait/db";
import {
  ENGINE_ENROLLMENT_ROUTES,
  ENGINE_ENROLLMENT_TOKEN_PREFIX,
  ENGINE_RUNNER_ROUTES,
  ENGINE_RUNNER_TOKEN_PREFIX,
} from "@regulait/shared";
import { hashToken } from "./token-hash.js";
import type { AuthContext, AuthRefusal } from "./auth.js";

export const RUNNER_ROUTE_SET: ReadonlySet<string> = new Set<string>(ENGINE_RUNNER_ROUTES);
export const ENROLLMENT_ROUTE_SET: ReadonlySet<string> = new Set<string>(ENGINE_ENROLLMENT_ROUTES);
/** every route only a runner credential reaches */
export const ALL_RUNNER_ROUTES: ReadonlySet<string> = new Set<string>([...ENGINE_RUNNER_ROUTES, ...ENGINE_ENROLLMENT_ROUTES]);

// PR #205 review [54]: the gateway no longer mints runner tokens. The runner generates its own
// (`generateRunnerSecret`, packages/engine-runner) and registers only its sha256 — `hashToken`
// over the same `rge_` string — so nothing secret ever travels back to it.

export function generateEnrollmentToken(): { token: string; tokenHash: string } {
  const token = ENGINE_ENROLLMENT_TOKEN_PREFIX + randomBytes(32).toString("hex");
  return { token, tokenHash: hashToken(token) };
}

/**
 * Resolve a presented bearer to a runner or enrolment context, a refusal, or
 * null when the token is not an engine credential at all (the caller then
 * tries the other credential kinds). An enrolment token is only CHECKED here
 * (unexpired); the register route spends it atomically. PR #205 review [54]: a SPENT, unexpired
 * enrolment token still authenticates — to the register route only, where it can do nothing but
 * replay the registration it already made (same runner-token hash → same runner; any other hash
 * is refused). It never mints a second runner.
 */
export async function resolveEngineCredential(db: Db, token: string): Promise<AuthContext | AuthRefusal | null> {
  if (token.startsWith(ENGINE_ENROLLMENT_TOKEN_PREFIX)) {
    const [row] = await db
      .select({ id: engineEnrollmentTokens.id, engineId: engineEnrollmentTokens.engineId, usedAt: engineEnrollmentTokens.usedAt })
      .from(engineEnrollmentTokens)
      .where(and(eq(engineEnrollmentTokens.tokenHash, hashToken(token)), gt(engineEnrollmentTokens.expiresAt, sql`now()`)));
    if (!row) return "engine_enrollment_invalid";
    return {
      userId: null,
      isAdmin: false,
      via: "engine-enrollment",
      engineEnrollmentTokenId: row.id,
      engineEnrollmentSpent: row.usedAt !== null,
      engineId: row.engineId,
    };
  }
  if (token.startsWith(ENGINE_RUNNER_TOKEN_PREFIX)) {
    const [row] = await db
      .select({ id: engineRunners.id, engineId: engineRunners.engineId, revokedAt: engineRunners.revokedAt })
      .from(engineRunners)
      .where(eq(engineRunners.tokenHash, hashToken(token)));
    if (!row) return null;
    if (row.revokedAt !== null) return "engine_runner_revoked";
    await db.update(engineRunners).set({ lastSeenAt: new Date() }).where(eq(engineRunners.id, row.id));
    return { userId: null, isAdmin: false, via: "engine-runner", engineRunnerId: row.id, engineId: row.engineId };
  }
  return null;
}

/** the routes a context may reach, or null when it is not an engine credential */
export function engineCredentialRoutes(ctx: { via: string }): ReadonlySet<string> | null {
  if (ctx.via === "engine-runner") return RUNNER_ROUTE_SET;
  if (ctx.via === "engine-enrollment") return ENROLLMENT_ROUTE_SET;
  return null;
}

/**
 * THE RUNNER ROUTE CEILING, both directions. Registered right after the
 * authentication hook, before the admin gate.
 */
export function registerEngineRunnerScopeHook(app: FastifyInstance): void {
  app.addHook("preHandler", async (req, reply) => {
    const route = `${req.method} ${req.routeOptions.url ?? ""}`;
    const allowed = req.authCtx ? engineCredentialRoutes(req.authCtx) : null;
    if (allowed) {
      if (!allowed.has(route)) {
        return reply.status(403).send({
          error: "engine_runner_scope",
          detail:
            `an engine ${req.authCtx.via === "engine-runner" ? "runner" : "enrolment"} token may only reach ` +
            `${[...allowed].join(", ")}; '${route}' is not one of them.`,
        });
      }
      return;
    }
    if (ALL_RUNNER_ROUTES.has(route)) {
      const enrol = ENROLLMENT_ROUTE_SET.has(route);
      return reply.status(401).send({
        error: "engine_runner_token_required",
        detail: enrol
          ? "registering a runner needs a one-time enrolment token (rgee_…) minted on the Engines page"
          : "this route is for engine runners only: present the runner token (rge_…) registration returned",
      });
    }
  });
}
