import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { apiKeys, eq, isNull, users, and, type Db } from "@regulait/db";

export interface AuthContext {
  /** null only for the bootstrap token, which has no user identity */
  userId: string | null;
  isAdmin: boolean;
  via: "bootstrap" | "api-key";
}

export const TOKEN_PREFIX = "rgl_";

export function generateToken(): { token: string; tokenHash: string } {
  const token = TOKEN_PREFIX + randomBytes(24).toString("hex");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Resolve a Bearer token to an auth context. The bootstrap token (deploy-time
 * config) acts as an admin with no user identity — it exists only to create
 * the first real admin user and key. Returns null for anything invalid, and
 * the distinct marker "disabled" for a VALID key whose user is deactivated
 * (ADR-0022) — so the 401 can say WHY without leaking anything to holders of
 * invalid tokens (only someone holding the real key ever sees it).
 */
export async function authenticate(
  db: Db,
  bootstrapToken: string | undefined,
  authorizationHeader: string | undefined,
): Promise<AuthContext | null | "disabled"> {
  if (!authorizationHeader?.startsWith("Bearer ")) return null;
  const token = authorizationHeader.slice("Bearer ".length).trim();
  if (token.length === 0) return null;

  if (bootstrapToken && safeEqual(token, bootstrapToken)) {
    return { userId: null, isAdmin: true, via: "bootstrap" };
  }

  const [row] = await db
    .select({
      keyId: apiKeys.id,
      userId: apiKeys.userId,
      isAdmin: users.isAdmin,
      disabledAt: users.disabledAt,
    })
    .from(apiKeys)
    .innerJoin(users, eq(apiKeys.userId, users.id))
    .where(and(eq(apiKeys.tokenHash, hashToken(token)), isNull(apiKeys.revokedAt)));
  if (!row) return null;
  // ADR-0022: a deactivated user's keys stop authenticating IMMEDIATELY — no
  // lastUsedAt touch, no context. Reactivation restores them unchanged
  // (deactivate ≠ delete; the keys were never revoked).
  if (row.disabledAt !== null) return "disabled";

  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.keyId));
  return { userId: row.userId, isAdmin: row.isAdmin, via: "api-key" };
}
