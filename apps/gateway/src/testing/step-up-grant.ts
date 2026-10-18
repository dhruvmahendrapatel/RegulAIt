/**
 * Test fixture: a browser session for a person and a step-up grant made for exactly one action, written to the real
 * tables (`auth_sessions`, `step_up_grants`) the way `/v1/auth/step-up/verify` writes them. A suite about a protected
 * route uses it to drive the route under the strict step-up policy, and to show that a grant for another kind or
 * other facts is refused and not spent (the pattern of `zz-key-management-step-up.test.ts`).
 */
import { createHash, randomBytes } from "node:crypto";
import { authSessions, eq, stepUpGrants, type Db } from "@regulait/db";
import { stepUpActionDigest } from "@regulait/shared";
import type { StepUpCheckArgs } from "../step-up.js";
import { hashToken } from "../token-hash.js";

export interface TestStepUpGrant {
  sessionToken: string;
  stepUpToken: string;
  grantId: string;
}

/** a fresh session for `userId` and a grant bound to `args` on it (TOTP, two minutes) */
export async function grantStepUpForTest(db: Db, userId: string, args: StepUpCheckArgs): Promise<TestStepUpGrant> {
  const sessionToken = "rgls_" + randomBytes(32).toString("hex");
  const [session] = await db
    .insert(authSessions)
    .values({
      tokenHash: createHash("sha256").update(sessionToken).digest("hex"),
      userId,
      origin: "password",
      expiresAt: new Date(Date.now() + 3_600_000),
      idleExpiresAt: new Date(Date.now() + 3_600_000),
      idleMinutes: 60,
    })
    .returning({ id: authSessions.id });
  const stepUpToken = "rgsu_" + randomBytes(24).toString("hex");
  const [grant] = await db
    .insert(stepUpGrants)
    .values({
      tokenHash: hashToken(stepUpToken),
      userId,
      sessionId: session!.id,
      method: "totp",
      actionKind: args.kind,
      actionDigest: stepUpActionDigest(args.kind, args.facts),
      expiresAt: new Date(Date.now() + 120_000),
    })
    .returning({ id: stepUpGrants.id });
  return { sessionToken, stepUpToken, grantId: grant!.id };
}

/** the headers and cookie a browser sends with the grant (CSRF header, step-up header, session cookie) */
export function stepUpRequest(g: TestStepUpGrant): { headers: Record<string, string>; cookies: Record<string, string> } {
  return { headers: { "x-regulait-csrf": "1", "x-regulait-step-up": g.stepUpToken }, cookies: { regulait_session: g.sessionToken } };
}

/** the session alone, with no grant (what a browser sends before it has stepped up) */
export function sessionRequest(g: TestStepUpGrant): { headers: Record<string, string>; cookies: Record<string, string> } {
  return { headers: { "x-regulait-csrf": "1" }, cookies: { regulait_session: g.sessionToken } };
}

export async function grantSpent(db: Db, grantId: string): Promise<boolean> {
  const [row] = await db.select({ usedAt: stepUpGrants.usedAt }).from(stepUpGrants).where(eq(stepUpGrants.id, grantId));
  return row!.usedAt !== null;
}
