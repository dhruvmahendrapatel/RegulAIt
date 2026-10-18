/**
 * ADR-0187 B5-F — RUNNER CREDENTIALS and THE RUNNER ROUTE ALLOW-LIST, and
 * ADR-0188 S7 — THE PDP CLIENT'S ONE ROUTE.
 *
 * Two runner credentials:
 *   - `rgee_…` a ONE-TIME enrolment token, minted by an admin on the Engines
 *     page for one engine, at most 60 minutes, spent by the register route
 *     (stored only as sha256, the `hashToken` every other credential uses);
 *   - the runner's OWN KEY (S7, OWNER DECISION 8: the `rge_` bearer token is
 *     retired). The runner generates it, registers its public half at
 *     enrolment as its workload identity's credential, and presents a
 *     DPoP-bound self token from `POST /oauth/token` (`oauth/workload-self.ts`).
 *     It reaches exactly `ENGINE_RUNNER_ROUTES` (lease, self-test, key rotation,
 *     heartbeat, artifact, result) and nothing else, for its own engine only.
 *
 * A PDP client (a data-plane proxy, S7: the `pdp` virtual key is retired) is a
 * workload identity of kind `pdp` with a registered key and a self token that
 * reaches `POST /v1/authz/check` and nothing else.
 *
 * None is a user (`userId` null, never admin). The allow-lists are enforced by
 * `registerEngineRunnerScopeHook`, which runs right after authentication and
 * BEFORE the admin gate, the same way the virtual-key ceiling does: a route
 * added tomorrow is unreachable on either credential until it is named in the
 * shared list. It also runs the other way: a runner route refuses every
 * credential that is not a runner's (a person or an API key cannot lease work
 * or post a result).
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, engineEnrollmentTokens, eq, gt, sql, type Db } from "@regulait/db";
import { ENGINE_ENROLLMENT_ROUTES, ENGINE_ENROLLMENT_TOKEN_PREFIX, ENGINE_RUNNER_ROUTES } from "@regulait/shared";
import { hashToken } from "./token-hash.js";
import { ENDPOINT_AGENT_TOKEN_ROUTES } from "./endpoint-agent.js";
import type { AuthContext, AuthRefusal } from "./auth.js";

export const RUNNER_ROUTE_SET: ReadonlySet<string> = new Set<string>(ENGINE_RUNNER_ROUTES);
export const ENROLLMENT_ROUTE_SET: ReadonlySet<string> = new Set<string>(ENGINE_ENROLLMENT_ROUTES);
/** every route only a runner credential reaches */
export const ALL_RUNNER_ROUTES: ReadonlySet<string> = new Set<string>([...ENGINE_RUNNER_ROUTES, ...ENGINE_ENROLLMENT_ROUTES]);
/** ADR-0188 S7 (AER-027 kept): THE PDP CLIENT'S ENTIRE WORLD */
export const PDP_CLIENT_ROUTES: ReadonlySet<string> = new Set<string>(["POST /v1/authz/check"]);


// PR #205 review [54], ADR-0188 S7: the gateway never mints a runner credential. The runner generates
// its own KEY (packages/engine-runner) and registers only the public half, so nothing secret ever
// travels back to it, and nothing a gateway stores could ever authenticate as it.

export function generateEnrollmentToken(): { token: string; tokenHash: string } {
  const token = ENGINE_ENROLLMENT_TOKEN_PREFIX + randomBytes(32).toString("hex");
  return { token, tokenHash: hashToken(token) };
}

/**
 * Resolve a presented bearer to an enrolment context, a refusal, or null when
 * the token is not an enrolment token (the caller then tries the other
 * credential kinds). An enrolment token is only CHECKED here (unexpired); the
 * register route spends it atomically. PR #205 review [54]: a SPENT, unexpired
 * enrolment token still authenticates — to the register route only, where it can do nothing but
 * replay the registration it already made (the same key → the same runner; any other key is
 * refused). It never mints a second runner. ADR-0188 S7: no bearer value resolves to a RUNNER any
 * more (the `rge_` token is retired); a runner authenticates with its key (`oauth/workload-self.ts`).
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
  return null;
}

/** the routes a context may reach, or null when it is not a runner, enrolment or PDP-client credential */
export function engineCredentialRoutes(ctx: { via: string }): ReadonlySet<string> | null {
  if (ctx.via === "engine-runner") return RUNNER_ROUTE_SET;
  if (ctx.via === "engine-enrollment") return ENROLLMENT_ROUTE_SET;
  if (ctx.via === "pdp") return PDP_CLIENT_ROUTES;
  // ADR-0195 SD4b: an endpoint agent's self token reaches its config, reports and key rotation only
  if (ctx.via === "endpoint-agent") return ENDPOINT_AGENT_TOKEN_ROUTES;
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
      if (!allowed.has(route) && (req.authCtx.via === "pdp" || req.authCtx.via === "endpoint-agent")) {
        return reply.status(403).send({
          error: "workload_scope",
          detail: `a${req.authCtx.via === "pdp" ? " PDP client's" : "n endpoint agent's"} token may only reach ${[...allowed].join(", ")}; '${route}' is not one of them.`,
        });
      }
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
          : "this route is for engine runners only: present the runner's DPoP-bound token (POST /oauth/token with the key it registered)",
      });
    }
  });
}
