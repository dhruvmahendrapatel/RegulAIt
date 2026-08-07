/**
 * ADR-0066 §2/§3 — VIRTUAL KEYS.
 *
 * A virtual key is a credential we mint and hand to a developer INSTEAD of the
 * vendor key we hold. It carries an owning user, an optional model allow-list,
 * an optional USD budget with a running spend counter, an optional expiry, and
 * an optional pinned upstream credential the holder never sees.
 *
 * THE CEILING INVARIANT — the single property everything here exists to keep
 * true. A virtual key can only ever NARROW. A dispatch on it is allowed iff:
 *
 *     the OWNING USER is entitled to the served agent   (policy kernel)
 *   AND the key's allow-list admits that agent           (this module)
 *   AND the key's budget is not exhausted                (this module)
 *
 * There is no path in this file that can ADD an entitlement. `allowedModels` is
 * intersected with the kernel's answer, never substituted for it — which is why
 * a key listing a model its owner was never granted still denies, and why
 * `gateway-parity.test.ts` asserts precisely that rather than the happy path.
 *
 * DEFAULT-DENY AT THE ROUTE LAYER TOO. A virtual key is not a general-purpose
 * identity: it reaches the dispatch surfaces and nothing else. That is enforced
 * by an explicit ALLOW-LIST (`VIRTUAL_KEY_ALLOWED_ROUTES`), so a route added
 * tomorrow is unreachable on a virtual key until someone deliberately adds it
 * — including, most importantly, the routes that mint credentials and edit
 * grants. A virtual key issued by an admin is NOT an admin.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  and,
  asc,
  auditLog,
  desc,
  eq,
  isNull,
  modelCredentials,
  sql,
  users,
  usageEvents,
  virtualKeys,
  VIRTUAL_KEY_PREFIX,
  type Db,
  type VirtualKeyRow,
} from "@regulait/db";
import { z } from "zod";
import { hashToken } from "./token-hash.js";

export { VIRTUAL_KEY_PREFIX };

/** `GET /v1/models` — the OpenAI/Anthropic discovery surface (ADR-0066 §1). */
export const COMPAT_MODELS_ROUTE = "GET /v1/models";

/**
 * THE VIRTUAL-KEY ROUTE ALLOW-LIST. Default-deny: anything absent here answers
 * 403 `virtual_key_scope` for a virtual-key caller, whatever the owner's own
 * rights are. Conspicuously ABSENT and deliberately so: `POST /v1/virtual-keys`
 * (a key that can mint keys is a key with no expiry), every grant/role/policy
 * route (a key that can widen its own ceiling is not a ceiling), and every
 * credential route (the whole point is that the holder never sees the upstream
 * key).
 */
export const VIRTUAL_KEY_ALLOWED_ROUTES: ReadonlySet<string> = new Set([
  "POST /v1/chat/completions",
  "POST /v1/messages",
  COMPAT_MODELS_ROUTE,
  "POST /v1/agents/:agentId/invoke",
  // identity echo — an SDK's "who am I" call. Read-only, own-scoped already.
  "GET /v1/me",
]);

/** Everything a dispatch needs to know about the key that paid for it. */
export interface VirtualKeyContext {
  id: string;
  name: string;
  /** the OWNER — whose entitlements are the ceiling this key narrows */
  userId: string;
  allowedModels: string[] | null;
  budgetUsd: number | null;
  spentUsd: number;
  upstreamCredentialId: string | null;
}

export function toVirtualKeyContext(row: VirtualKeyRow): VirtualKeyContext {
  return {
    id: row.id,
    name: row.name,
    userId: row.userId,
    allowedModels: row.allowedModels ?? null,
    budgetUsd: row.budgetUsd ?? null,
    spentUsd: row.spentUsd ?? 0,
    upstreamCredentialId: row.upstreamCredentialId ?? null,
  };
}

/** Same 24-byte entropy and the same sha256 as `generateToken()` in auth.ts —
 * deliberately NOT a second hashing scheme. Only the prefix differs, so a
 * virtual key is visibly not an ordinary API key in a log or a `.env`. */
export function generateVirtualKeyToken(): { token: string; tokenHash: string } {
  const token = VIRTUAL_KEY_PREFIX + randomBytes(24).toString("hex");
  return { token, tokenHash: hashToken(token) };
}

export function isVirtualKeyToken(token: string): boolean {
  return token.startsWith(VIRTUAL_KEY_PREFIX);
}

export type VirtualKeyResolution =
  | { ok: true; row: VirtualKeyRow; ownerDisabled: boolean }
  | { ok: false; reason: "unknown" | "revoked" | "expired" };

/**
 * Resolve a presented `rglv_` token. Returns the distinct reason for a key that
 * really exists but is revoked or expired, so the holder learns WHY — the same
 * courtesy ADR-0022 extends to a deactivated user's API key, and for the same
 * reason: only someone holding the real key ever sees it.
 */
export async function resolveVirtualKey(db: Db, token: string): Promise<VirtualKeyResolution> {
  const [row] = await db
    .select({ key: virtualKeys, disabledAt: users.disabledAt })
    .from(virtualKeys)
    .innerJoin(users, eq(virtualKeys.userId, users.id))
    .where(eq(virtualKeys.tokenHash, hashToken(token)));
  if (!row) return { ok: false, reason: "unknown" };
  if (row.key.revokedAt !== null) return { ok: false, reason: "revoked" };
  if (row.key.expiresAt !== null && row.key.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, row: row.key, ownerDisabled: row.disabledAt !== null };
}

export async function touchVirtualKey(db: Db, id: string): Promise<void> {
  await db.update(virtualKeys).set({ lastUsedAt: new Date() }).where(eq(virtualKeys.id, id));
}

/**
 * The dispatch-time read: turn `req.authCtx.virtualKeyId` back into the full
 * key. Returns null when the request did not arrive on a virtual key, which is
 * every pre-0066 caller — so the enforcement below is a no-op on the ordinary
 * paths, byte-identically.
 *
 * Re-read PER REQUEST rather than cached from authentication on purpose: it is
 * the same discipline `loadOrgSettings` follows for the IP envelope. A budget
 * raised or an allow-list tightened binds on the very next call, with no cache
 * to invalidate and no window in which a revised ceiling is not yet the ceiling.
 */
export async function loadVirtualKeyContext(
  db: Db,
  req: { authCtx: { via: string; virtualKeyId?: string } },
): Promise<VirtualKeyContext | null> {
  if (req.authCtx.via !== "virtual-key" || !req.authCtx.virtualKeyId) return null;
  const [row] = await db.select().from(virtualKeys).where(eq(virtualKeys.id, req.authCtx.virtualKeyId));
  return row ? toVirtualKeyContext(row) : null;
}

// ---------------------------------------------------------------------------
// enforcement — the two checks the dispatch core calls
// ---------------------------------------------------------------------------

/**
 * §3 — THE PER-KEY MODEL ALLOW-LIST.
 *
 * An entry matches the served agent by provider-native model id OR by agent id.
 * Both, because both are things a client can legitimately name: `GET /v1/models`
 * hands out model ids, and `require_agent` resolution mode plus
 * `/v1/agents/:id/invoke` name agent ids. Matching only one of them would make
 * a key that works on one surface silently fail on another, which is the exact
 * class of hole this slice was asked to close.
 *
 * A NULL allow-list means "no per-key restriction" — the owner's entitlements
 * remain the sole ceiling. An EMPTY list means "nothing", and is honoured as
 * written rather than treated as absent; a key someone deliberately emptied
 * must not become a key that allows everything.
 */
export function virtualKeyAdmits(
  vk: VirtualKeyContext,
  agent: { id: string; model: string | null },
): boolean {
  if (vk.allowedModels === null) return true;
  return vk.allowedModels.some((entry) => entry === agent.id || (agent.model !== null && entry === agent.model));
}

export interface VirtualKeyRefusal {
  status: number;
  error: string;
  detail: string;
  ruleId: string;
}

/** The allow-list refusal, shaped like every other honest refusal in this
 * codebase: a real 4xx naming the reason, never a silent substitution to a
 * model the key does allow. */
export function virtualKeyAllowListRefusal(
  vk: VirtualKeyContext,
  agent: { id: string; name: string; model: string | null },
): VirtualKeyRefusal | null {
  if (virtualKeyAdmits(vk, agent)) return null;
  return {
    status: 403,
    error: "virtual_key_model_not_allowed",
    ruleId: "virtual-key-model-not-allowed",
    detail:
      `virtual key '${vk.name}' does not allow agent '${agent.name}'` +
      (agent.model ? ` (model '${agent.model}')` : "") +
      `. A virtual key's allow-list can only NARROW its owner's entitlements — ` +
      `widening it requires the key's issuer, and the owner must be entitled to the model regardless.`,
  };
}

/**
 * §2 — THE PER-KEY BUDGET, enforced BEFORE any provider work.
 *
 * Same discipline as the pillar-5 project budget: the FIRST crossing is allowed
 * (measured cost is only knowable after the call returns) and every call after
 * it is refused. 402 rather than 409 because the condition is exactly "this
 * credential has no funds left", it is terminal until an operator raises the
 * budget, and an OpenAI SDK treats 402 as terminal rather than retrying it the
 * way it retries 429.
 */
export function virtualKeyBudgetRefusal(vk: VirtualKeyContext): VirtualKeyRefusal | null {
  if (vk.budgetUsd === null) return null;
  if (vk.spentUsd < vk.budgetUsd) return null;
  return {
    status: 402,
    error: "virtual_key_budget_exhausted",
    ruleId: "virtual-key-budget-exhausted",
    detail:
      `virtual key '${vk.name}' has spent $${vk.spentUsd.toFixed(6)} of its $${vk.budgetUsd.toFixed(2)} budget. ` +
      `The call was refused rather than run unbilled — raise the budget or issue a new key.`,
  };
}

/**
 * Post-dispatch: move the MEASURED cost onto the key's counter. An UNPRICED
 * agent adds 0 — a measured token count never becomes an invented dollar, which
 * is the same rule `usage_events.cost_usd` follows. The increment is done in
 * SQL rather than read-modify-write so two concurrent dispatches on one key
 * cannot lose a charge.
 */
export async function recordVirtualKeySpend(
  db: Db,
  virtualKeyId: string,
  costUsd: number | null,
): Promise<void> {
  if (costUsd === null || costUsd === 0) return;
  await db
    .update(virtualKeys)
    .set({ spentUsd: sql`${virtualKeys.spentUsd} + ${costUsd}` })
    .where(eq(virtualKeys.id, virtualKeyId));
}

// ---------------------------------------------------------------------------
// admin / self-service API
// ---------------------------------------------------------------------------

const createSchema = z.object({
  name: z.string().min(1).max(200),
  /** admin-only: issue on behalf of another user. Defaults to the caller. */
  userId: z.string().uuid().optional(),
  /** null/absent = no per-key model restriction */
  allowedModels: z.array(z.string().min(1)).nullable().optional(),
  budgetUsd: z.number().nonnegative().nullable().optional(),
  /** ISO-8601 */
  expiresAt: z.string().datetime().nullable().optional(),
  /** admin-only: pin the platform credential this key proxies to */
  upstreamCredentialId: z.string().uuid().nullable().optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  allowedModels: z.array(z.string().min(1)).nullable().optional(),
  budgetUsd: z.number().nonnegative().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

const keyIdParam = z.object({ keyId: z.string().uuid() });

/** What a read of a virtual key returns. NEVER the token, and never the
 * upstream credential's material — only that a pin exists and to which row. */
function publicKey(row: VirtualKeyRow) {
  return {
    id: row.id,
    name: row.name,
    userId: row.userId,
    allowedModels: row.allowedModels ?? null,
    budgetUsd: row.budgetUsd ?? null,
    spentUsd: row.spentUsd ?? 0,
    budgetRemainingUsd:
      row.budgetUsd === null ? null : Math.max(0, row.budgetUsd - (row.spentUsd ?? 0)),
    upstreamCredentialId: row.upstreamCredentialId ?? null,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    /** derived, so a caller does not have to re-implement the expiry rule */
    active:
      row.revokedAt === null && (row.expiresAt === null || row.expiresAt.getTime() > Date.now()),
  };
}

export function registerVirtualKeyRoutes(app: FastifyInstance, db: Db) {
  // ---- POST /v1/virtual-keys ------------------------------------------------
  app.post("/v1/virtual-keys", async (req, reply) => {
    const actor = req.authCtx.userId;
    const body = createSchema.parse(req.body);
    const ownerId = body.userId ?? actor;
    if (!ownerId) {
      return reply.status(400).send({
        error: "owner_required",
        detail:
          "the bootstrap token has no user identity — name the owning user in `userId`, because a virtual key with no owner has no entitlement ceiling to narrow",
      });
    }
    // A non-admin may issue keys ONLY for themselves. Issuing on behalf of
    // someone else would be minting a credential against another human's
    // entitlements, which is a widening dressed as a convenience.
    if (!req.authCtx.isAdmin && ownerId !== actor) {
      return reply.status(403).send({
        error: "not_key_owner",
        detail: "a non-admin may issue virtual keys only for themselves",
      });
    }
    const [owner] = await db.select().from(users).where(eq(users.id, ownerId));
    if (!owner) return reply.status(404).send({ error: "user_not_found" });

    // Pinning WHICH platform credential a key burns is an org-wide act (it
    // decides whose vendor bill this traffic lands on), so it stays admin-only.
    let upstreamCredentialId: string | null = null;
    if (body.upstreamCredentialId != null) {
      if (!req.authCtx.isAdmin) {
        return reply.status(403).send({
          error: "admin_only_field",
          detail: "pinning an upstream platform credential to a virtual key is an admin action",
        });
      }
      const [cred] = await db
        .select({ id: modelCredentials.id })
        .from(modelCredentials)
        .where(eq(modelCredentials.id, body.upstreamCredentialId));
      if (!cred) {
        return reply.status(404).send({
          error: "credential_not_found",
          detail: "no platform model credential with that id",
        });
      }
      upstreamCredentialId = cred.id;
    }

    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      return reply.status(400).send({
        error: "expiry_in_the_past",
        detail: "an already-expired key would authenticate nothing — pick a future expiry or omit it",
      });
    }

    const { token, tokenHash } = generateVirtualKeyToken();
    const [row] = await db
      .insert(virtualKeys)
      .values({
        name: body.name,
        userId: ownerId,
        tokenHash,
        allowedModels: body.allowedModels ?? null,
        budgetUsd: body.budgetUsd ?? null,
        upstreamCredentialId,
        expiresAt,
        createdBy: actor,
      })
      .returning();
    await db.insert(auditLog).values({
      userId: actor ?? ownerId,
      objectType: "virtual_key",
      objectId: row!.id,
      detail: {
        phase: "issue",
        name: body.name,
        ownerUserId: ownerId,
        allowedModels: body.allowedModels ?? null,
        budgetUsd: body.budgetUsd ?? null,
        expiresAt: expiresAt?.toISOString() ?? null,
        upstreamCredentialPinned: upstreamCredentialId !== null,
      },
      effect: "allow",
      ruleId: "virtual-key-issued",
      ruleChain: [],
      reason: `virtual key '${body.name}' issued for user ${ownerId}; its ceiling is that user's entitlements`,
    });
    // The token is returned ONCE, exactly like an API key. It is not stored and
    // is not recoverable — only its sha256 ever touched the database.
    return reply.status(201).send({ ...publicKey(row!), token });
  });

  // ---- GET /v1/virtual-keys -------------------------------------------------
  app.get("/v1/virtual-keys", async (req, reply) => {
    // ADR-0022 visibility: a non-admin sees their OWN keys and no one else's.
    const rows = req.authCtx.isAdmin
      ? await db.select().from(virtualKeys).orderBy(desc(virtualKeys.createdAt))
      : req.authCtx.userId
        ? await db
            .select()
            .from(virtualKeys)
            .where(eq(virtualKeys.userId, req.authCtx.userId))
            .orderBy(desc(virtualKeys.createdAt))
        : [];
    return reply.send({ keys: rows.map(publicKey) });
  });

  // ---- GET /v1/virtual-keys/:keyId/usage -----------------------------------
  // Per-key spend, read straight off the ONE ledger rather than off the
  // enforcement counter, so the two can be compared instead of assumed equal.
  app.get("/v1/virtual-keys/:keyId/usage", async (req, reply) => {
    const { keyId } = keyIdParam.parse(req.params);
    const [row] = await db.select().from(virtualKeys).where(eq(virtualKeys.id, keyId));
    if (!row) return reply.status(404).send({ error: "virtual_key_not_found" });
    if (!req.authCtx.isAdmin && row.userId !== req.authCtx.userId) {
      // invisible rather than 403 — a non-owner learns nothing about it
      return reply.status(404).send({ error: "virtual_key_not_found" });
    }
    const events = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.virtualKeyId, keyId))
      .orderBy(asc(usageEvents.at));
    const meteredUsd = events.reduce((acc, e) => acc + (e.costUsd ?? 0), 0);
    return reply.send({
      key: publicKey(row),
      /** the ledger's own total; `spentUsd` on the key is the enforcement
       * counter. They agree unless a row was pruned — and that is exactly the
       * kind of thing that should be visible rather than assumed. */
      meteredUsd,
      events: events.length,
      unpricedEvents: events.filter((e) => e.costUsd === null).length,
    });
  });

  // ---- PATCH /v1/virtual-keys/:keyId ---------------------------------------
  app.patch("/v1/virtual-keys/:keyId", async (req, reply) => {
    const { keyId } = keyIdParam.parse(req.params);
    const body = patchSchema.parse(req.body);
    const [row] = await db.select().from(virtualKeys).where(eq(virtualKeys.id, keyId));
    if (!row) return reply.status(404).send({ error: "virtual_key_not_found" });
    if (!req.authCtx.isAdmin && row.userId !== req.authCtx.userId) {
      return reply.status(404).send({ error: "virtual_key_not_found" });
    }
    // THE ONE PLACE A "NARROWING" CREDENTIAL COULD WIDEN ITSELF. Being the
    // OWNER is not enough to raise a budget or extend an allow-list: an admin
    // who issues a contractor a $20 key would otherwise watch that contractor
    // PATCH it to $10,000. Only the ISSUER (or an admin) may loosen a key.
    //
    // A self-issued key has `created_by == user_id`, so the self-service case is
    // unaffected — which is the whole point of keying on the issuer rather than
    // on admin-ness. Revocation is deliberately NOT restricted: it only ever
    // narrows, so an owner may always kill their own key.
    const loosening =
      body.allowedModels !== undefined || body.budgetUsd !== undefined || body.expiresAt !== undefined;
    if (loosening && !req.authCtx.isAdmin && row.createdBy !== req.authCtx.userId) {
      return reply.status(403).send({
        error: "not_key_issuer",
        detail:
          "this virtual key's budget, allow-list and expiry are the ISSUER's settings — being the owner lets you rename or revoke it, not raise its ceiling",
      });
    }
    const patch: Partial<typeof virtualKeys.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.allowedModels !== undefined) patch.allowedModels = body.allowedModels;
    if (body.budgetUsd !== undefined) patch.budgetUsd = body.budgetUsd;
    if (body.expiresAt !== undefined) patch.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (Object.keys(patch).length === 0) return reply.send(publicKey(row));
    const [updated] = await db
      .update(virtualKeys)
      .set(patch)
      .where(eq(virtualKeys.id, keyId))
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? row.userId,
      objectType: "virtual_key",
      objectId: keyId,
      detail: { phase: "update", changed: body, ownerUserId: row.userId },
      effect: "allow",
      ruleId: "virtual-key-updated",
      ruleChain: [],
      reason: `virtual key '${updated!.name}' updated`,
    });
    return reply.send(publicKey(updated!));
  });

  // ---- DELETE /v1/virtual-keys/:keyId (revoke) ------------------------------
  app.delete("/v1/virtual-keys/:keyId", async (req, reply) => {
    const { keyId } = keyIdParam.parse(req.params);
    const [row] = await db.select().from(virtualKeys).where(eq(virtualKeys.id, keyId));
    if (!row) return reply.status(404).send({ error: "virtual_key_not_found" });
    if (!req.authCtx.isAdmin && row.userId !== req.authCtx.userId) {
      return reply.status(404).send({ error: "virtual_key_not_found" });
    }
    // Revoke, never delete: the spend rows in `usage_events` reference this id
    // and the audit trail must still resolve it.
    const [updated] = await db
      .update(virtualKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(virtualKeys.id, keyId), isNull(virtualKeys.revokedAt)))
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? row.userId,
      objectType: "virtual_key",
      objectId: keyId,
      detail: { phase: "revoke", ownerUserId: row.userId, alreadyRevoked: !updated },
      effect: "allow",
      ruleId: "virtual-key-revoked",
      ruleChain: [],
      reason: `virtual key '${row.name}' revoked — it authenticates nothing from this moment on`,
    });
    return reply.send(publicKey(updated ?? row));
  });
}
