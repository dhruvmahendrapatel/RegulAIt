/**
 * ADR-0037 — SCIM 2.0 provisioning (Users + Groups).
 *
 * Federated LOGIN (OIDC, SAML) authenticates a human at sign-in time. It does
 * not cover the enterprise lifecycle: accounts created before first login,
 * attributes pushed from the IdP as source of truth, group membership synced
 * continuously, and — the security-critical one — DEPROVISIONING, which must
 * not wait for a failed login attempt that may never come.
 *
 * Three properties of this file are load-bearing:
 *
 *  1. **It is a separate TRUST PATH.** Every route below authenticates on
 *     `scim_tokens` and on nothing else. A user session cookie does not reach
 *     it; a user's API key does not reach it; the bootstrap token does not
 *     reach it. The routes are auth-exempt in app.ts precisely so the normal
 *     session/api-key hook cannot be the thing that lets a human credential in
 *     through the side. A leaked SCIM token is provisioning power with no user
 *     identity, rotatable without touching a single account.
 *
 *  2. **Deprovision is DEACTIVATE, never delete.** `PATCH active:false` and
 *     `DELETE /Users/:id` both set `users.disabled_at` (ADR-0022) and revoke
 *     every live session on the spot; the user's API keys stop authenticating
 *     by the existing `authenticate()` behaviour, with no second step. The row,
 *     its audit trail, its cost events and its provenance all survive, and
 *     `active:true` restores the account with the same keys. There is no code
 *     path here that deletes a user row, and adding one would violate the
 *     invariant the whole product rests on.
 *
 *  3. **A synced group grants nothing by itself.** `/Groups` records what the
 *     IdP says. Turning that into entitlement requires an admin to have created
 *     a `group_role_mappings` row for it (ADR-0038, migration 0053): an
 *     UNMAPPED group still confers exactly nothing, and there is no "default
 *     role for unmapped groups" setting to turn that into a default-allow. When
 *     a mapping DOES exist, every membership change reconciles the affected
 *     user's `origin='group'` role assignments through the one shared routine in
 *     `group-roles.ts` — never touching an admin's `origin='direct'` grants, and
 *     never reaching `users.isAdmin`, which is not a role and not
 *     group-derivable.
 *
 * Two more invariants SCIM must never be able to cross, both asserted by test:
 * a SCIM-created user has **no password** (`passwordHash` null — SSO or an
 * admin one-time password, never an IdP push) and is **never admin**, however
 * insistently the payload says otherwise; and `users.username` (ADR-0030) is
 * never written from a SCIM payload, for the same impersonation reason SSO
 * never maps identity onto it.
 *
 * Scope, stated honestly: the filter grammar implemented here is the EQUALITY
 * subset real IdP connectors use (`userName eq`, `emails eq`, `externalId eq`,
 * `id eq`, plus `displayName eq` for groups). Anything else is refused with a
 * SCIM `invalidFilter` error rather than silently ignored — ignoring an
 * unsupported filter would answer 200 with the WRONG result set, which for a
 * reconciling connector means "this user does not exist", which means a
 * duplicate account.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  and,
  auditLog,
  authSessions,
  eq,
  groupRoleMappings,
  inArray,
  isNull,
  scimGroupMembers,
  scimGroups,
  scimTokens,
  sql,
  users,
  type Db,
  type SQL,
} from "@regulait/db";
import { z } from "zod";
import { hashToken } from "./auth.js";
import { refuseIfFeatureNotLicensed } from "./licensing.js";
import { reconcileGroupRoles, scimAssertedGroupsFor } from "./group-roles.js";

// ---------------------------------------------------------------------------
// the token credential
// ---------------------------------------------------------------------------

/** distinct from `rgl_` (user API key) and `rgls_` (session) on purpose: the
 * prefix alone tells an operator finding a loose secret which trust path it
 * belongs to, and therefore what revoking it costs. */
export const SCIM_TOKEN_PREFIX = "rglscim_";

export function generateScimToken(): { token: string; tokenHash: string } {
  const token = SCIM_TOKEN_PREFIX + randomBytes(32).toString("hex");
  return { token, tokenHash: hashToken(token) };
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Every route this file mounts under /scim/v2, as Fastify route PATTERNS.
 *
 * app.ts consumes this list twice, and both are required for SCIM to be a
 * separate trust path rather than a second door onto the human one:
 *  - AUTH_EXEMPT_ROUTES, so the session/api-key preHandler never runs here and
 *    a user credential can never be what admits a request;
 *  - NON_ADMIN_ROUTES, so the admin gate (which keys on a USER's isAdmin) does
 *    not 403 a caller that deliberately has no user identity at all.
 * The actual credential check is this file's own scope-level preHandler.
 * Exported rather than duplicated so a route added here cannot be forgotten
 * there — the failure mode of forgetting is a 401/403 that looks like a broken
 * connector, and the failure mode of a stale COPY would be worse.
 */
export const SCIM_ROUTES = [
  "/scim/v2/ServiceProviderConfig",
  "/scim/v2/Users",
  "/scim/v2/Users/:id",
  "/scim/v2/Groups",
  "/scim/v2/Groups/:id",
] as const;

/** the URL prefix the rate limiter keys its per-token bucket on (ADR-0031) */
export const SCIM_PATH_PREFIX = "/scim/v2/";

export type ScimTokenRow = typeof scimTokens.$inferSelect;

declare module "fastify" {
  interface FastifyRequest {
    /** set by the SCIM scope's own preHandler — the ONLY credential these
     * routes accept, and the actor named in every audit row they write */
    scimToken?: ScimTokenRow;
  }
}

// ---------------------------------------------------------------------------
// RFC 7644 envelopes
// ---------------------------------------------------------------------------

export const SCIM_CONTENT_TYPE = "application/scim+json; charset=utf-8";
const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const PATCH_OP_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

/** every `scimType` this file can emit — the RFC 7644 §3.12 detail codes a
 * connector branches on. */
export type ScimType =
  | "invalidFilter"
  | "invalidPath"
  | "invalidSyntax"
  | "invalidValue"
  | "mutability"
  | "noTarget"
  | "tooMany"
  | "uniqueness";

export function scimErrorBody(status: number, detail: string, scimType?: ScimType) {
  return {
    schemas: [ERROR_SCHEMA],
    // RFC 7644 §3.12: `status` is a STRING, not a number. Connectors that
    // parse it as one have been known to blow up on the number form.
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  };
}

function scimError(reply: FastifyReply, status: number, detail: string, scimType?: ScimType) {
  return reply
    .status(status)
    .header("content-type", SCIM_CONTENT_TYPE)
    .send(scimErrorBody(status, detail, scimType));
}

function scimSend(reply: FastifyReply, status: number, body: unknown) {
  return reply.status(status).header("content-type", SCIM_CONTENT_TYPE).send(body);
}

type UserRow = typeof users.$inferSelect;
type GroupRow = typeof scimGroups.$inferSelect;

/**
 * The SCIM projection of a user. Deliberately narrow: it carries the four
 * attributes the IdP owns (userName/email, displayName, active, externalId)
 * and nothing else. No password state, no admin flag, no username, no key
 * material — a provisioning connector has no business reading any of it, and
 * an attribute we do not emit is an attribute an IdP cannot try to own.
 */
export function scimUser(u: UserRow) {
  return {
    schemas: [USER_SCHEMA],
    id: u.id,
    ...(u.scimExternalId ? { externalId: u.scimExternalId } : {}),
    userName: u.email,
    name: { formatted: u.displayName },
    displayName: u.displayName,
    emails: [{ value: u.email, primary: true, type: "work" }],
    // the whole ADR in one line: `active` is the INVERSE of ADR-0022's
    // disabledAt, not a column of its own
    active: u.disabledAt === null,
    meta: {
      resourceType: "User",
      created: u.createdAt,
      location: `/scim/v2/Users/${u.id}`,
    },
  };
}

export function scimGroup(g: GroupRow, members: Array<{ userId: string; display: string }>) {
  return {
    schemas: [GROUP_SCHEMA],
    id: g.id,
    ...(g.externalId ? { externalId: g.externalId } : {}),
    displayName: g.displayName,
    members: members.map((m) => ({ value: m.userId, display: m.display, type: "User" })),
    meta: {
      resourceType: "Group",
      created: g.createdAt,
      lastModified: g.updatedAt,
      location: `/scim/v2/Groups/${g.id}`,
    },
  };
}

function listResponse(resources: unknown[], totalResults: number, startIndex: number) {
  return {
    schemas: [LIST_SCHEMA],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

// ---------------------------------------------------------------------------
// the equality-only filter subset
// ---------------------------------------------------------------------------

export interface ScimFilter {
  attribute: string;
  value: string;
}

/**
 * Parse the `filter` query parameter, accepting ONLY `<attr> eq "<value>"`.
 *
 * Returning `null` means "not a filter I implement" and the caller MUST answer
 * a 400 `invalidFilter`. That refusal is the point: a connector's reconcile
 * step asks "does userName eq X exist?" before creating, and an unsupported
 * filter answered with an unfiltered 200 (or an empty 200) tells it the wrong
 * answer — either way it then creates a duplicate or overwrites the wrong row.
 * A loud 400 makes the unsupported case a configuration error a human fixes,
 * not silent data corruption.
 */
export function parseScimFilter(raw: string): ScimFilter | null {
  const m = /^\s*([A-Za-z][A-Za-z0-9_.]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(raw);
  if (!m) return null;
  // no compound expressions: an "and"/"or"/"not" survives only as part of a
  // quoted value, never as an operator, because the regex above anchors the
  // whole string to ONE comparison.
  return { attribute: m[1]!, value: m[2]!.replace(/\\(.)/g, "$1") };
}

/** which attributes the /Users filter understands, normalised to lower-case */
const USER_FILTER_ATTRS = new Set([
  "username",
  "emails",
  "emails.value",
  "externalid",
  "id",
]);
const GROUP_FILTER_ATTRS = new Set(["displayname", "externalid", "id"]);

// ---------------------------------------------------------------------------
// payload shapes (permissive on purpose)
// ---------------------------------------------------------------------------
// Real connectors send far more than we map (locale, timezone, enterprise
// extension schemas, ...). These schemas are NOT `.strict()`: unknown
// attributes are ignored rather than 400'd, because refusing an Okta payload
// for carrying `nickName` would make the integration unusable while protecting
// nothing. What IS refused is an unsupported *operation* — a filter we cannot
// evaluate, a PATCH path we cannot honour — because those change the ANSWER.

const emailEntry = z.object({
  value: z.string().optional(),
  primary: z.boolean().optional(),
  type: z.string().optional(),
});

const scimUserBody = z.object({
  schemas: z.array(z.string()).optional(),
  userName: z.string().optional(),
  externalId: z.string().optional(),
  displayName: z.string().optional(),
  name: z.object({ formatted: z.string().optional(), givenName: z.string().optional(), familyName: z.string().optional() }).optional(),
  emails: z.array(emailEntry).optional(),
  active: z.boolean().optional(),
});
type ScimUserBody = z.infer<typeof scimUserBody>;

const memberEntry = z.object({ value: z.string().optional(), display: z.string().optional() });

const scimGroupBody = z.object({
  schemas: z.array(z.string()).optional(),
  externalId: z.string().optional(),
  displayName: z.string().optional(),
  members: z.array(memberEntry).optional(),
});

const patchOpBody = z.object({
  schemas: z.array(z.string()).optional(),
  Operations: z
    .array(
      z.object({
        op: z.string(),
        path: z.string().optional(),
        value: z.unknown().optional(),
      }),
    )
    .min(1),
});

/** SCIM's mapping key: the primary email, else the first email, else userName
 * when it is itself an address. Lower-cased — `users.email` is the unique
 * key and case must not be able to mint a second account. */
export function resolveScimEmail(body: ScimUserBody): string | null {
  const primary = body.emails?.find((e) => e.primary && e.value)?.value;
  const first = body.emails?.find((e) => e.value)?.value;
  const candidate = primary ?? first ?? body.userName;
  if (!candidate || !candidate.includes("@")) return null;
  return candidate.trim().toLowerCase();
}

export function resolveScimDisplayName(body: ScimUserBody, fallbackEmail: string): string {
  const d = body.displayName?.trim();
  if (d) return d;
  const f = body.name?.formatted?.trim();
  if (f) return f;
  const composed = [body.name?.givenName, body.name?.familyName]
    .filter((s): s is string => Boolean(s && s.trim()))
    .join(" ")
    .trim();
  if (composed) return composed;
  return fallbackEmail.slice(0, fallbackEmail.indexOf("@"));
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

const idParam = z.object({ id: z.string().uuid() });
const pageQuery = z.object({
  filter: z.string().min(1).max(1024).optional(),
  startIndex: z.coerce.number().int().min(1).default(1),
  count: z.coerce.number().int().min(0).max(1000).default(200),
});

export function registerScimRoutes(app: FastifyInstance, db: Db) {
  // ---- audit ---------------------------------------------------------------
  /**
   * Every provisioning act lands in the ONE audit log, with the acting
   * scim_token named as the actor. The `user_id` column is a NOT NULL uuid of
   * a *user*, and a SCIM token is not a user — so it carries the nil uuid and
   * the real actor is named in `detail.actor` and spelled out in `reason`,
   * exactly as the SAML provider paths do for IdP-driven events. "Who
   * deprovisioned this account, when, and on whose instruction" is answerable
   * from the same trail as every other governed action.
   */
  const audit = (
    token: ScimTokenRow,
    objectType: "user" | "scim_group",
    objectId: string | null,
    ruleId: string,
    reason: string,
    detail: Record<string, unknown>,
    effect: "allow" | "deny" = "allow",
  ) =>
    db.insert(auditLog).values({
      userId: NIL_UUID,
      objectType,
      objectId,
      detail: { phase: "scim", actor: { type: "scim_token", id: token.id, name: token.name }, ...detail },
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });

  const loadUser = async (id: string): Promise<UserRow | null> => {
    const [row] = await db.select().from(users).where(eq(users.id, id));
    return row ?? null;
  };
  const loadUserByEmail = async (email: string): Promise<UserRow | null> => {
    const [row] = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
    return row ?? null;
  };

  /**
   * THE deprovision primitive — the single place `disabledAt` is set from
   * SCIM, so `PATCH active:false` and `DELETE /Users/:id` cannot drift apart.
   *
   * Deactivate, never delete: the row stays, and with it every FK, audit row,
   * cost event and provenance record. Sessions are revoked here and now (an
   * offboarded human must not keep a live browser tab); API keys need no step
   * at all — `authenticate()` refuses a disabled user's key on its next use,
   * by ADR-0022, and reactivation restores them untouched because they were
   * never revoked.
   *
   * Idempotent: an already-disabled user is a no-op that still answers 200.
   */
  const deactivate = async (
    token: ScimTokenRow,
    user: UserRow,
    via: "patch" | "put" | "delete",
  ): Promise<UserRow> => {
    if (user.disabledAt) return user;
    const [row] = await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, user.id))
      .returning();
    const revoked = await db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(authSessions.userId, user.id), isNull(authSessions.revokedAt)))
      .returning({ id: authSessions.id });
    await audit(token, "user", user.id, "scim-user-deactivated",
      `SCIM token '${token.name}' deactivated user '${user.email}' (${via === "delete" ? "DELETE /Users" : "active:false"}) — ${revoked.length} live session(s) revoked; the account is disabled, not deleted`,
      {
        via,
        email: user.email,
        before: { active: true, disabledAt: null },
        after: { active: false, disabledAt: row!.disabledAt },
        sessionsRevoked: revoked.length,
      });
    return row!;
  };

  const reactivate = async (token: ScimTokenRow, user: UserRow): Promise<UserRow> => {
    if (!user.disabledAt) return user;
    const [row] = await db
      .update(users)
      .set({ disabledAt: null })
      .where(eq(users.id, user.id))
      .returning();
    await audit(token, "user", user.id, "scim-user-reactivated",
      `SCIM token '${token.name}' reactivated user '${user.email}' — their existing API keys authenticate again unchanged`,
      {
        email: user.email,
        before: { active: false, disabledAt: user.disabledAt },
        after: { active: true, disabledAt: null },
      });
    return row!;
  };

  /** apply the SCIM-owned attribute set to an existing row. `username`,
   * `isAdmin` and `passwordHash` are conspicuously absent and always will be:
   * an IdP may not name a local login identifier, may not grant admin, and may
   * not set a credential. */
  const applyAttributes = async (
    token: ScimTokenRow,
    user: UserRow,
    next: { email?: string; displayName?: string; externalId?: string | null },
  ): Promise<UserRow> => {
    const patch: Partial<typeof users.$inferInsert> = {};
    if (next.email && next.email !== user.email) patch.email = next.email;
    if (next.displayName && next.displayName !== user.displayName) patch.displayName = next.displayName;
    if (next.externalId !== undefined && next.externalId !== user.scimExternalId) {
      patch.scimExternalId = next.externalId;
    }
    if (Object.keys(patch).length === 0) return user;
    const [row] = await db.update(users).set(patch).where(eq(users.id, user.id)).returning();
    await audit(token, "user", user.id, "scim-user-updated",
      `SCIM token '${token.name}' updated user '${user.email}': ${Object.keys(patch).join(", ")}`,
      {
        email: row!.email,
        changed: Object.keys(patch),
        before: { email: user.email, displayName: user.displayName, externalId: user.scimExternalId },
        after: { email: row!.email, displayName: row!.displayName, externalId: row!.scimExternalId },
      });
    return row!;
  };

  const groupMembers = async (groupId: string) => {
    const rows = await db
      .select({ userId: scimGroupMembers.userId, display: users.displayName })
      .from(scimGroupMembers)
      .innerJoin(users, eq(users.id, scimGroupMembers.userId))
      .where(eq(scimGroupMembers.groupId, groupId));
    return rows;
  };

  /**
   * Set-reconciliation for a full membership push: compute the add/remove
   * deltas against current state and apply only those. This is what makes a
   * REPLAYED full sync converge — an IdP that re-sends the same 400-member
   * group must produce zero writes and zero duplicate rows, not 400 inserts.
   */
  const reconcileMembers = async (
    token: ScimTokenRow,
    group: GroupRow,
    desired: string[],
  ): Promise<void> => {
    const current = (await groupMembers(group.id)).map((m) => m.userId);
    const want = new Set(desired);
    const have = new Set(current);
    const toAdd = desired.filter((id) => !have.has(id));
    const toRemove = current.filter((id) => !want.has(id));
    await addMembers(token, group, toAdd);
    await removeMembers(token, group, toRemove);
  };

  /**
   * ADR-0038 — the ONE place SCIM membership becomes (or stops being)
   * entitlement, called after every membership write.
   *
   * It hands the user's FULL current synced-group set to the shared
   * reconciliation routine rather than the delta, so the outcome depends only on
   * stored state and a replayed sync converges. SCIM membership is stored state,
   * not a per-event assertion, so it is always an authoritative signal: a user
   * in no synced group reconciles to zero group-derived roles.
   *
   * Nothing about it can escalate: it can only ever write `role_assignments`
   * rows whose role an admin explicitly mapped, only ever with `origin='group'`,
   * and an UNMAPPED group still produces nothing.
   */
  const reconcileRolesFor = async (token: ScimTokenRow, userId: string, group: GroupRow) => {
    const asserted = await scimAssertedGroupsFor(db, userId);
    await reconcileGroupRoles(db, userId, "scim", asserted, {
      kind: "scim-group-sync",
      actor: `scim token '${token.name}'`,
      actorUserId: null,
      detail: { scimTokenId: token.id, scimTokenName: token.name, groupId: group.id, group: group.displayName },
    });
  };

  const addMembers = async (token: ScimTokenRow, group: GroupRow, userIds: string[]) => {
    for (const userId of userIds) {
      // ADR-0037: this write records MEMBERSHIP. Whether it becomes entitlement
      // is decided entirely by whether an admin mapped this group (ADR-0038) —
      // an unmapped group still grants nothing, and no mapping can reach
      // `users.isAdmin`.
      const inserted = await db
        .insert(scimGroupMembers)
        .values({ groupId: group.id, userId })
        .onConflictDoNothing()
        .returning({ id: scimGroupMembers.id });
      if (inserted.length === 0) continue; // already a member — converged
      const u = await loadUser(userId);
      await audit(token, "scim_group", group.id, "scim-group-member-added",
        `SCIM token '${token.name}' added '${u?.email ?? userId}' to synced group '${group.displayName}' — entitlement follows only where an admin mapped this group to a role (ADR-0038); an unmapped group grants nothing`,
        { group: group.displayName, groupExternalId: group.externalId, userId, email: u?.email ?? null });
      await reconcileRolesFor(token, userId, group);
    }
  };

  const removeMembers = async (token: ScimTokenRow, group: GroupRow, userIds: string[]) => {
    for (const userId of userIds) {
      const removed = await db
        .delete(scimGroupMembers)
        .where(and(eq(scimGroupMembers.groupId, group.id), eq(scimGroupMembers.userId, userId)))
        .returning({ id: scimGroupMembers.id });
      if (removed.length === 0) continue;
      const u = await loadUser(userId);
      await audit(token, "scim_group", group.id, "scim-group-member-removed",
        `SCIM token '${token.name}' removed '${u?.email ?? userId}' from synced group '${group.displayName}'`,
        { group: group.displayName, groupExternalId: group.externalId, userId, email: u?.email ?? null });
      // ADR-0038: losing the group loses whatever baseline the mapping implied,
      // on the spot. Admin-direct assignments of the same role are untouched.
      await reconcileRolesFor(token, userId, group);
    }
  };

  /** resolve the `members` array of a Group payload to user ids, refusing an
   * unknown member LOUDLY rather than silently dropping it — a silently
   * dropped member is a group that looks synced and is not. */
  const resolveMembers = async (
    raw: Array<{ value?: string }> | undefined,
  ): Promise<{ ids: string[]; unknown: string[] }> => {
    const wanted = (raw ?? [])
      .map((m) => m.value)
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    if (wanted.length === 0) return { ids: [], unknown: [] };
    const uuids = wanted.filter((v) => z.string().uuid().safeParse(v).success);
    const found = uuids.length
      ? await db.select({ id: users.id }).from(users).where(inArray(users.id, uuids))
      : [];
    const foundSet = new Set(found.map((f) => f.id));
    return {
      ids: wanted.filter((v) => foundSet.has(v)),
      unknown: wanted.filter((v) => !foundSet.has(v)),
    };
  };

  // =========================================================================
  // the SCIM scope — its own content-type parser and its own credential
  // =========================================================================
  app.register(async (scope) => {
    // IdPs send `application/scim+json` (RFC 7644 §3.1). Fastify's default
    // JSON parser is bound to `application/json` only, so without this the
    // gateway would 415 every Okta write. Scoped to this plugin, exactly like
    // the SAML ACS's form parser — global parsing is untouched.
    scope.addContentTypeParser(
      "application/scim+json",
      { parseAs: "string" },
      (_req, body: string, done) => {
        if (body.length === 0) return done(null, undefined);
        try {
          done(null, JSON.parse(body));
        } catch (err) {
          done(err as Error);
        }
      },
    );

    /**
     * THE credential check. `scim_tokens` and nothing else:
     *  - no Authorization header (a browser sending only a session cookie) → 401;
     *  - a user's API key (`rgl_…`) → not in this table → 401;
     *  - the deploy-time bootstrap token → not in this table → 401;
     *  - a REVOKED token → the `revoked_at IS NULL` term excludes it → 401.
     * A 401 body is a SCIM error envelope, because the caller is a connector
     * that parses one.
     */
    scope.addHook("preHandler", async (req, reply) => {
      const header = req.headers.authorization;
      if (typeof header !== "string" || !header.startsWith("Bearer ")) {
        return scimError(reply, 401, "a SCIM bearer token is required", undefined);
      }
      const presented = header.slice("Bearer ".length).trim();
      if (presented.length === 0) {
        return scimError(reply, 401, "a SCIM bearer token is required");
      }
      const [row] = await db
        .select()
        .from(scimTokens)
        .where(and(eq(scimTokens.tokenHash, hashToken(presented)), isNull(scimTokens.revokedAt)));
      if (!row) {
        // deliberately the same body for "unknown" and "revoked": the endpoint
        // is not an oracle for which of an attacker's guesses used to be real.
        return scimError(reply, 401, "this SCIM token is not valid");
      }
      await db.update(scimTokens).set({ lastUsedAt: new Date() }).where(eq(scimTokens.id, row.id));
      req.scimToken = row;
    });

    const tokenOf = (req: FastifyRequest): ScimTokenRow => req.scimToken!;

    // ---- discovery --------------------------------------------------------
    // Connectors probe this before their first write. It states the truth,
    // including the parts we do not implement: no bulk, no sort, and a filter
    // capability that exists but is the equality subset (RFC 7644 has no field
    // for "partial filter support", so the honest place to say it is here and
    // in the 400 an unsupported filter earns).
    scope.get("/scim/v2/ServiceProviderConfig", async (_req, reply) =>
      scimSend(reply, 200, {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
        documentationUri: "https://github.com/regulait/docs/adr/0037",
        patch: { supported: true },
        bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter: { supported: true, maxResults: 1000 },
        changePassword: {
          // SCIM never sets a password in RegulAIt. SSO, or an admin-issued
          // one-time password. This is a product invariant, not a gap.
          supported: false,
        },
        sort: { supported: false },
        etag: { supported: false },
        authenticationSchemes: [
          {
            type: "oauthbearertoken",
            name: "OAuth Bearer Token",
            description: "A RegulAIt SCIM token, issued per IdP integration in the admin portal.",
            primary: true,
          },
        ],
        meta: { resourceType: "ServiceProviderConfig", location: "/scim/v2/ServiceProviderConfig" },
      }),
    );

    // =======================================================================
    // /Users
    // =======================================================================

    scope.get("/scim/v2/Users", async (req, reply) => {
      const q = pageQuery.parse(req.query ?? {});
      let where: SQL | undefined;
      if (q.filter !== undefined) {
        const parsed = parseScimFilter(q.filter);
        if (!parsed || !USER_FILTER_ATTRS.has(parsed.attribute.toLowerCase())) {
          return scimError(reply, 400,
            `unsupported filter '${q.filter}' — this deployment implements the equality subset only: ` +
              `userName eq "…", emails eq "…", emails.value eq "…", externalId eq "…", id eq "…"`,
            "invalidFilter");
        }
        const attr = parsed.attribute.toLowerCase();
        if (attr === "id") {
          if (!z.string().uuid().safeParse(parsed.value).success) {
            return scimSend(reply, 200, listResponse([], 0, q.startIndex));
          }
          where = eq(users.id, parsed.value);
        } else if (attr === "externalid") {
          where = eq(users.scimExternalId, parsed.value);
        } else {
          // userName / emails / emails.value all resolve onto the ONE mapping
          // key, case-insensitively, because that is what they all mean here
          where = sql`lower(${users.email}) = ${parsed.value.toLowerCase()}`;
        }
      }
      const rows = await db.select().from(users).where(where);
      const page = rows.slice(q.startIndex - 1, q.startIndex - 1 + q.count);
      return scimSend(reply, 200, listResponse(page.map(scimUser), rows.length, q.startIndex));
    });

    scope.get("/scim/v2/Users/:id", async (req, reply) => {
      const parsed = idParam.safeParse(req.params);
      if (!parsed.success) return scimError(reply, 404, "no such user");
      const user = await loadUser(parsed.data.id);
      if (!user) return scimError(reply, 404, "no such user");
      return scimSend(reply, 200, scimUser(user));
    });

    scope.post("/scim/v2/Users", async (req, reply) => {
      const token = tokenOf(req);
      const parsed = scimUserBody.safeParse(req.body ?? {});
      if (!parsed.success) return scimError(reply, 400, "malformed User resource", "invalidSyntax");
      const body = parsed.data;
      const email = resolveScimEmail(body);
      if (!email) {
        return scimError(reply, 400,
          "userName (or a primary email) must be an email address — it is the account mapping key",
          "invalidValue");
      }

      // IDEMPOTENCY, choice recorded: a re-POST of an existing email is a
      // 409 `uniqueness`, NOT a silent 200 returning the existing resource.
      // Both are SCIM-legal; 409 is what Okta and Entra expect — they follow
      // it with a `userName eq` GET and switch to PATCH. Answering 200 would
      // additionally mean a create attempt could silently ADOPT a pre-existing
      // locally-created account (including an admin's), which is precisely the
      // kind of quiet privilege acquisition this ADR refuses. Never a
      // duplicate row either way: `users.email` is unique.
      const existing = await loadUserByEmail(email);
      if (existing) {
        await audit(token, "user", existing.id, "scim-user-create-conflict",
          `SCIM token '${token.name}' attempted to create '${email}', which already exists — refused as a duplicate (no row created, nothing adopted)`,
          { email, existingUserId: existing.id }, "deny");
        return scimError(reply, 409, `a user with userName '${email}' already exists`, "uniqueness");
      }

      const displayName = resolveScimDisplayName(body, email);
      const active = body.active ?? true;
      const [created] = await db
        .insert(users)
        .values({
          email,
          displayName,
          // NEVER admin. `isAdmin` is not an IdP-assertable attribute; a
          // payload claiming it is ignored, not honoured.
          isAdmin: false,
          // NO password. SCIM does not provision credentials — the user signs
          // in via SSO or receives an admin one-time password. `passwordHash`
          // is left null by omission, and there is no branch below that sets it.
          // `username` (ADR-0030) is likewise never written from a SCIM payload.
          scimExternalId: body.externalId ?? null,
          disabledAt: active ? null : new Date(),
        })
        .returning();
      await audit(token, "user", created!.id, "scim-user-created",
        `SCIM token '${token.name}' provisioned user '${email}'${active ? "" : " (created inactive)"} — no password, never admin`,
        {
          email,
          displayName,
          active,
          externalId: body.externalId ?? null,
          before: null,
          after: { email, displayName, active, isAdmin: false, passwordSet: false },
        });
      reply.header("location", `/scim/v2/Users/${created!.id}`);
      return scimSend(reply, 201, scimUser(created!));
    });

    scope.put("/scim/v2/Users/:id", async (req, reply) => {
      const token = tokenOf(req);
      const p = idParam.safeParse(req.params);
      if (!p.success) return scimError(reply, 404, "no such user");
      const parsed = scimUserBody.safeParse(req.body ?? {});
      if (!parsed.success) return scimError(reply, 400, "malformed User resource", "invalidSyntax");
      let user = await loadUser(p.data.id);
      if (!user) return scimError(reply, 404, "no such user");
      const body = parsed.data;
      const email = resolveScimEmail(body);
      if (!email) {
        return scimError(reply, 400,
          "userName (or a primary email) must be an email address — it is the account mapping key",
          "invalidValue");
      }
      if (email !== user.email) {
        const clash = await loadUserByEmail(email);
        if (clash && clash.id !== user.id) {
          return scimError(reply, 409, `a user with userName '${email}' already exists`, "uniqueness");
        }
      }
      user = await applyAttributes(token, user, {
        email,
        displayName: resolveScimDisplayName(body, email),
        ...(body.externalId !== undefined ? { externalId: body.externalId } : {}),
      });
      // `active` last, so the audit trail reads create/update then the
      // lifecycle event rather than the other way round
      if (body.active === false) user = await deactivate(token, user, "put");
      if (body.active === true) user = await reactivate(token, user);
      return scimSend(reply, 200, scimUser(user));
    });

    scope.patch("/scim/v2/Users/:id", async (req, reply) => {
      const token = tokenOf(req);
      const p = idParam.safeParse(req.params);
      if (!p.success) return scimError(reply, 404, "no such user");
      const parsed = patchOpBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return scimError(reply, 400, `a ${PATCH_OP_SCHEMA} body with a non-empty Operations array is required`, "invalidSyntax");
      }
      let user = await loadUser(p.data.id);
      if (!user) return scimError(reply, 404, "no such user");

      /** the attribute writes accumulated across the operation list, applied
       * once at the end so a two-operation patch is one update and one audit
       * row rather than a partial write per operation */
      const attrs: { email?: string; displayName?: string; externalId?: string | null } = {};
      let activeTarget: boolean | undefined;

      /** one `path`-less operation whose value is an object (the Entra shape:
       * `{op:"replace", value:{active:false}}`) is expanded into the same
       * per-attribute handling as the explicit-path form. */
      const applyOne = (op: string, path: string | undefined, value: unknown): string | null => {
        const attr = (path ?? "").trim().toLowerCase();
        const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
        const bool = (v: unknown): boolean | null => {
          if (typeof v === "boolean") return v;
          // Okta has historically sent the string form
          if (v === "true") return true;
          if (v === "false") return false;
          return null;
        };
        switch (attr) {
          case "active": {
            const b = bool(value);
            if (b === null) return "active must be a boolean";
            activeTarget = b;
            return null;
          }
          case "displayname":
          case "name.formatted": {
            const s = str(value);
            if (!s) return "displayName must be a non-empty string";
            attrs.displayName = s;
            return null;
          }
          case "username":
          case "emails":
          case "emails.value":
          case 'emails[type eq "work"].value':
          case 'emails[primary eq true].value': {
            // NOTE what this does NOT touch: `users.username` (ADR-0030).
            // SCIM's `userName` is the account MAPPING KEY and maps onto
            // `users.email` — never onto the local login identifier, for the
            // same impersonation reason SSO never maps onto it.
            const raw = Array.isArray(value)
              ? (value.find((e) => (e as { primary?: boolean }).primary) ?? value[0])
              : value;
            const s = str(typeof raw === "object" && raw !== null ? (raw as { value?: unknown }).value : raw);
            if (!s || !s.includes("@")) return "userName/emails must be an email address";
            attrs.email = s.toLowerCase();
            return null;
          }
          case "externalid": {
            if (op === "remove") {
              attrs.externalId = null;
              return null;
            }
            const s = str(value);
            if (!s) return "externalId must be a non-empty string";
            attrs.externalId = s;
            return null;
          }
          default:
            return `unsupported patch path '${path ?? "(none)"}'`;
        }
      };

      for (const op of parsed.data.Operations) {
        const verb = op.op.toLowerCase();
        if (verb !== "add" && verb !== "replace" && verb !== "remove") {
          return scimError(reply, 400, `unsupported patch op '${op.op}'`, "invalidSyntax");
        }
        if (op.path === undefined) {
          // path-less form: the value MUST be an attribute object
          if (typeof op.value !== "object" || op.value === null || Array.isArray(op.value)) {
            return scimError(reply, 400, "a path-less patch operation needs an object value", "invalidValue");
          }
          for (const [k, v] of Object.entries(op.value as Record<string, unknown>)) {
            const err = applyOne(verb, k, v);
            if (err) return scimError(reply, 400, err, "invalidPath");
          }
          continue;
        }
        const err = applyOne(verb, op.path, op.value);
        if (err) {
          // Refused, not ignored. Silently dropping an operation we do not
          // understand tells the IdP the push succeeded when the state it
          // asked for does not exist — the exact failure mode that leaves a
          // "deprovisioned" user provisioned.
          return scimError(reply, 400, err, "invalidPath");
        }
      }

      if (attrs.email && attrs.email !== user.email) {
        const clash = await loadUserByEmail(attrs.email);
        if (clash && clash.id !== user.id) {
          return scimError(reply, 409, `a user with userName '${attrs.email}' already exists`, "uniqueness");
        }
      }
      user = await applyAttributes(token, user, attrs);
      // `active:false` on an ALREADY-disabled user is a 200 no-op — `deactivate`
      // returns the row untouched and writes no second audit event. Connectors
      // retry aggressively; a second 409 or a duplicated deactivation event
      // would be noise at best and a stuck sync at worst.
      if (activeTarget === false) user = await deactivate(token, user, "patch");
      if (activeTarget === true) user = await reactivate(token, user);
      return scimSend(reply, 200, scimUser(user));
    });

    /**
     * SCIM's HARD signal, mapped to the SOFT outcome — deliberately.
     *
     * RFC 7644 says DELETE removes the resource. RegulAIt has no hard-delete
     * path for a user (ADR-0022) and this endpoint does not introduce one: the
     * account is DEACTIVATED, its sessions die, its keys stop authenticating,
     * and the row — with every audit, cost and provenance record hanging off
     * it — survives. `active:true` brings it back.
     *
     * The deviation is disclosed rather than hidden: a subsequent
     * `GET /Users/:id` still returns the resource with `active:false` instead
     * of 404. Every connector we care about treats that as deprovisioned.
     * Honouring the letter of the RFC here would mean destroying the evidence
     * of everything the account ever did, which is the opposite of what a
     * governance product is for.
     */
    scope.delete("/scim/v2/Users/:id", async (req, reply) => {
      const token = tokenOf(req);
      const p = idParam.safeParse(req.params);
      if (!p.success) return scimError(reply, 404, "no such user");
      const user = await loadUser(p.data.id);
      if (!user) return scimError(reply, 404, "no such user");
      await deactivate(token, user, "delete");
      return reply.status(204).header("content-type", SCIM_CONTENT_TYPE).send();
    });

    // =======================================================================
    // /Groups — inbound sync ONLY. Nothing here grants anything (ADR-0038).
    // =======================================================================

    const loadGroup = async (id: string): Promise<GroupRow | null> => {
      const [row] = await db.select().from(scimGroups).where(eq(scimGroups.id, id));
      return row ?? null;
    };
    const renderGroup = async (g: GroupRow) => scimGroup(g, await groupMembers(g.id));

    scope.get("/scim/v2/Groups", async (req, reply) => {
      const q = pageQuery.parse(req.query ?? {});
      let where: SQL | undefined;
      if (q.filter !== undefined) {
        const parsed = parseScimFilter(q.filter);
        if (!parsed || !GROUP_FILTER_ATTRS.has(parsed.attribute.toLowerCase())) {
          return scimError(reply, 400,
            `unsupported filter '${q.filter}' — this deployment implements the equality subset only: ` +
              `displayName eq "…", externalId eq "…", id eq "…"`,
            "invalidFilter");
        }
        const attr = parsed.attribute.toLowerCase();
        if (attr === "id") {
          if (!z.string().uuid().safeParse(parsed.value).success) {
            return scimSend(reply, 200, listResponse([], 0, q.startIndex));
          }
          where = eq(scimGroups.id, parsed.value);
        } else if (attr === "externalid") {
          where = eq(scimGroups.externalId, parsed.value);
        } else {
          where = eq(scimGroups.displayName, parsed.value);
        }
      }
      const rows = await db.select().from(scimGroups).where(where);
      const page = rows.slice(q.startIndex - 1, q.startIndex - 1 + q.count);
      const resources = [];
      for (const g of page) resources.push(await renderGroup(g));
      return scimSend(reply, 200, listResponse(resources, rows.length, q.startIndex));
    });

    scope.get("/scim/v2/Groups/:id", async (req, reply) => {
      const p = idParam.safeParse(req.params);
      if (!p.success) return scimError(reply, 404, "no such group");
      const group = await loadGroup(p.data.id);
      if (!group) return scimError(reply, 404, "no such group");
      return scimSend(reply, 200, await renderGroup(group));
    });

    scope.post("/scim/v2/Groups", async (req, reply) => {
      const token = tokenOf(req);
      const parsed = scimGroupBody.safeParse(req.body ?? {});
      if (!parsed.success) return scimError(reply, 400, "malformed Group resource", "invalidSyntax");
      const displayName = parsed.data.displayName?.trim();
      if (!displayName) return scimError(reply, 400, "displayName is required", "invalidValue");
      const externalId = parsed.data.externalId?.trim() || null;
      if (externalId) {
        const [clash] = await db
          .select()
          .from(scimGroups)
          .where(eq(scimGroups.externalId, externalId));
        // idempotent replay of a create: the group already exists under the
        // IdP's own id, so this is a duplicate, not a second group
        if (clash) {
          return scimError(reply, 409, `a group with externalId '${externalId}' already exists`, "uniqueness");
        }
      }
      const { ids, unknown } = await resolveMembers(parsed.data.members);
      if (unknown.length > 0) {
        return scimError(reply, 400,
          `unknown member id(s): ${unknown.join(", ")} — provision the users before adding them to a group`,
          "invalidValue");
      }
      const [group] = await db
        .insert(scimGroups)
        .values({ displayName, externalId })
        .returning();
      await audit(token, "scim_group", group!.id, "scim-group-created",
        `SCIM token '${token.name}' created synced group '${displayName}' — the group grants NOTHING until an admin maps it to a role (ADR-0038)`,
        { displayName, externalId, memberCount: ids.length, grants: "none", before: null, after: { displayName, externalId } });
      await addMembers(token, group!, ids);
      reply.header("location", `/scim/v2/Groups/${group!.id}`);
      return scimSend(reply, 201, await renderGroup(group!));
    });

    scope.put("/scim/v2/Groups/:id", async (req, reply) => {
      const token = tokenOf(req);
      const p = idParam.safeParse(req.params);
      if (!p.success) return scimError(reply, 404, "no such group");
      const parsed = scimGroupBody.safeParse(req.body ?? {});
      if (!parsed.success) return scimError(reply, 400, "malformed Group resource", "invalidSyntax");
      const loaded = await loadGroup(p.data.id);
      if (!loaded) return scimError(reply, 404, "no such group");
      let group: GroupRow = loaded;
      const displayName = parsed.data.displayName?.trim() || group.displayName;
      const externalId =
        parsed.data.externalId !== undefined ? parsed.data.externalId.trim() || null : group.externalId;
      const { ids, unknown } = await resolveMembers(parsed.data.members);
      if (unknown.length > 0) {
        return scimError(reply, 400,
          `unknown member id(s): ${unknown.join(", ")} — provision the users before adding them to a group`,
          "invalidValue");
      }
      if (displayName !== group.displayName || externalId !== group.externalId) {
        const [row] = await db
          .update(scimGroups)
          .set({ displayName, externalId, updatedAt: new Date() })
          .where(eq(scimGroups.id, group.id))
          .returning();
        await audit(token, "scim_group", group.id, "scim-group-updated",
          `SCIM token '${token.name}' updated synced group '${group.displayName}'`,
          {
            before: { displayName: group.displayName, externalId: group.externalId },
            after: { displayName, externalId },
          });
        group = row!;
      }
      // full replace = SET RECONCILIATION. A replayed identical PUT computes
      // empty deltas: no writes, no duplicate members, no audit noise.
      await reconcileMembers(token, group, ids);
      return scimSend(reply, 200, await renderGroup(group));
    });

    scope.patch("/scim/v2/Groups/:id", async (req, reply) => {
      const token = tokenOf(req);
      const p = idParam.safeParse(req.params);
      if (!p.success) return scimError(reply, 404, "no such group");
      const parsed = patchOpBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return scimError(reply, 400, `a ${PATCH_OP_SCHEMA} body with a non-empty Operations array is required`, "invalidSyntax");
      }
      const loaded = await loadGroup(p.data.id);
      if (!loaded) return scimError(reply, 404, "no such group");
      let group: GroupRow = loaded;

      for (const op of parsed.data.Operations) {
        const verb = op.op.toLowerCase();
        if (verb !== "add" && verb !== "replace" && verb !== "remove") {
          return scimError(reply, 400, `unsupported patch op '${op.op}'`, "invalidSyntax");
        }
        const rawPath = (op.path ?? "").trim();
        const path = rawPath.toLowerCase();

        // `members[value eq "<id>"]` — the single-member removal shape Okta
        // and Entra both emit
        const targeted = /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i.exec(rawPath);
        if (targeted) {
          if (verb !== "remove") {
            return scimError(reply, 400, `only 'remove' is supported on a targeted member path`, "invalidPath");
          }
          await removeMembers(token, group, [targeted[1]!]);
          continue;
        }

        if (path === "members") {
          const list = Array.isArray(op.value) ? (op.value as Array<{ value?: string }>) : undefined;
          if (verb === "remove" && list === undefined) {
            // remove with no value = drop every member
            const current = (await groupMembers(group.id)).map((m) => m.userId);
            await removeMembers(token, group, current);
            continue;
          }
          const { ids, unknown } = await resolveMembers(list);
          if (unknown.length > 0) {
            return scimError(reply, 400,
              `unknown member id(s): ${unknown.join(", ")} — provision the users before adding them to a group`,
              "invalidValue");
          }
          if (verb === "add") await addMembers(token, group, ids);
          else if (verb === "remove") await removeMembers(token, group, ids);
          // `replace` on the whole members attribute is a full set push, so it
          // reconciles exactly like PUT
          else await reconcileMembers(token, group, ids);
          continue;
        }

        if (path === "displayname" || path === "externalid" || op.path === undefined) {
          const next: { displayName?: string; externalId?: string | null } = {};
          const takeAttr = (attr: string, value: unknown): string | null => {
            const a = attr.toLowerCase();
            if (a === "displayname") {
              if (typeof value !== "string" || !value.trim()) return "displayName must be a non-empty string";
              next.displayName = value.trim();
              return null;
            }
            if (a === "externalid") {
              if (verb === "remove") {
                next.externalId = null;
                return null;
              }
              if (typeof value !== "string" || !value.trim()) return "externalId must be a non-empty string";
              next.externalId = value.trim();
              return null;
            }
            return `unsupported patch path '${attr}'`;
          };
          if (op.path === undefined) {
            if (typeof op.value !== "object" || op.value === null || Array.isArray(op.value)) {
              return scimError(reply, 400, "a path-less patch operation needs an object value", "invalidValue");
            }
            for (const [k, v] of Object.entries(op.value as Record<string, unknown>)) {
              const err = takeAttr(k, v);
              if (err) return scimError(reply, 400, err, "invalidPath");
            }
          } else {
            const err = takeAttr(rawPath, op.value);
            if (err) return scimError(reply, 400, err, "invalidPath");
          }
          const changed =
            (next.displayName !== undefined && next.displayName !== group.displayName) ||
            (next.externalId !== undefined && next.externalId !== group.externalId);
          if (changed) {
            const [row] = await db
              .update(scimGroups)
              .set({
                ...(next.displayName !== undefined ? { displayName: next.displayName } : {}),
                ...(next.externalId !== undefined ? { externalId: next.externalId } : {}),
                updatedAt: new Date(),
              })
              .where(eq(scimGroups.id, group.id))
              .returning();
            await audit(token, "scim_group", group.id, "scim-group-updated",
              `SCIM token '${token.name}' updated synced group '${group.displayName}'`,
              {
                before: { displayName: group.displayName, externalId: group.externalId },
                after: { displayName: row!.displayName, externalId: row!.externalId },
              });
            group = row!;
          }
          continue;
        }

        return scimError(reply, 400, `unsupported patch path '${op.path}'`, "invalidPath");
      }
      return scimSend(reply, 200, await renderGroup(group));
    });

    /** A GROUP may be deleted — it is inbound sync state, not an identity, and
     * it grants nothing, so removing it destroys no history about a person.
     * Its membership rows cascade. The USER deprovision path is the one that
     * never deletes, and it is a different route entirely. */
    scope.delete("/scim/v2/Groups/:id", async (req, reply) => {
      const token = tokenOf(req);
      const p = idParam.safeParse(req.params);
      if (!p.success) return scimError(reply, 404, "no such group");
      const group = await loadGroup(p.data.id);
      if (!group) return scimError(reply, 404, "no such group");
      const members = await groupMembers(group.id);
      await db.delete(scimGroups).where(eq(scimGroups.id, group.id));
      await audit(token, "scim_group", group.id, "scim-group-deleted",
        `SCIM token '${token.name}' deleted synced group '${group.displayName}' (${members.length} membership record(s) removed; no user account was touched)`,
        {
          displayName: group.displayName,
          externalId: group.externalId,
          memberCount: members.length,
          before: { displayName: group.displayName, memberCount: members.length },
          after: null,
        });
      // ADR-0038: the membership rows cascaded away, so every former member's
      // group-derived roles must be recomputed — a deleted group implies
      // nothing, exactly like a group that no longer lists you. Admin-direct
      // assignments of the same role survive untouched.
      for (const m of members) await reconcileRolesFor(token, m.userId, group);
      return reply.status(204).header("content-type", SCIM_CONTENT_TYPE).send();
    });
  });
}

// ===========================================================================
// admin surface — issue / rotate / revoke tokens, and sync status
// ===========================================================================
// Ordinary /v1 admin routes: the default admin gate in app.ts applies, and
// they audit as `scim_token`. The plaintext is returned EXACTLY ONCE, the same
// contract as api_keys and one-time passwords.

const publicToken = (t: ScimTokenRow) => ({
  id: t.id,
  name: t.name,
  createdAt: t.createdAt,
  lastUsedAt: t.lastUsedAt,
  revokedAt: t.revokedAt,
});

const tokenIdParam = z.object({ tokenId: z.string().uuid() });
const createScimTokenSchema = z.object({ name: z.string().min(1).max(128) }).strict();

export function registerScimAdminRoutes(app: FastifyInstance, db: Db) {
  const auditToken = (
    actorUserId: string | null,
    tokenId: string | null,
    ruleId: string,
    reason: string,
    detail: Record<string, unknown>,
  ) =>
    db.insert(auditLog).values({
      userId: actorUserId ?? NIL_UUID,
      objectType: "scim_token",
      objectId: tokenId,
      detail,
      effect: "allow",
      ruleId,
      ruleChain: [],
      reason,
    });

  app.get("/v1/scim/tokens", async () => ({
    tokens: (await db.select().from(scimTokens)).map(publicToken),
  }));

  app.post("/v1/scim/tokens", async (req, reply) => {
    // ADR-0052 §4: SCIM provisioning is a TIER FEATURE, enforced where it is
    // ENABLED. Minting a token is the enabling act; an already-issued token
    // keeps working (committed footprint, §5), and rotate/revoke stay open —
    // rotating a credential narrows exposure and revoking one is offboarding,
    // neither of which a commercial state may block.
    const flagRefusal = await refuseIfFeatureNotLicensed(db, {
      actorUserId: req.authCtx.userId,
      feature: "scim_provisioning",
      what: "issuing a SCIM provisioning token",
    });
    if (flagRefusal) return reply.status(flagRefusal.status).send(flagRefusal.body);
    const body = createScimTokenSchema.parse(req.body);
    const { token, tokenHash } = generateScimToken();
    const [row] = await db.insert(scimTokens).values({ name: body.name, tokenHash }).returning();
    await auditToken(req.authCtx.userId, row!.id, "scim-token-issued",
      `SCIM provisioning token '${body.name}' issued — it can create, update and DEACTIVATE users on this deployment`,
      { phase: "scim-token-issued", name: body.name });
    // shown exactly once, sha256 at rest — same contract as an API key
    return reply.status(201).send({ ...publicToken(row!), token });
  });

  /** Rotation replaces the SECRET on the same row, so the integration keeps
   * its identity (and its audit history keeps naming the same token) while the
   * old secret stops working the instant this returns. */
  app.post("/v1/scim/tokens/:tokenId/rotate", async (req, reply) => {
    const { tokenId } = tokenIdParam.parse(req.params);
    const [existing] = await db.select().from(scimTokens).where(eq(scimTokens.id, tokenId));
    if (!existing) return reply.status(404).send({ error: "unknown_scim_token" });
    if (existing.revokedAt) {
      return reply.status(409).send({
        error: "scim_token_revoked",
        detail: "this token is revoked — issue a new one instead of rotating a dead credential",
      });
    }
    const { token, tokenHash } = generateScimToken();
    const [row] = await db
      .update(scimTokens)
      .set({ tokenHash, lastUsedAt: null })
      .where(eq(scimTokens.id, tokenId))
      .returning();
    await auditToken(req.authCtx.userId, tokenId, "scim-token-rotated",
      `SCIM provisioning token '${existing.name}' rotated — the previous secret stopped working immediately`,
      { phase: "scim-token-rotated", name: existing.name });
    return { ...publicToken(row!), token };
  });

  app.post("/v1/scim/tokens/:tokenId/revoke", async (req, reply) => {
    const { tokenId } = tokenIdParam.parse(req.params);
    const [row] = await db
      .update(scimTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(scimTokens.id, tokenId), isNull(scimTokens.revokedAt)))
      .returning();
    if (!row) return reply.status(404).send({ error: "unknown_or_already_revoked" });
    await auditToken(req.authCtx.userId, tokenId, "scim-token-revoked",
      `SCIM provisioning token '${row.name}' revoked — no further provisioning is possible with it`,
      { phase: "scim-token-revoked", name: row.name });
    return publicToken(row);
  });

  /** the sync-status surface: is the integration alive, and what has it
   * actually synced? Counts only — no user rows, no secrets. */
  app.get("/v1/scim/status", async () => {
    const tokens = await db.select().from(scimTokens);
    const count = async (rows: Promise<Array<{ n: number }>>) => (await rows)[0]?.n ?? 0;
    const provisionedUsers = await count(
      db.select({ n: sql<number>`count(*)::int` }).from(users)
        .where(sql`${users.scimExternalId} is not null`),
    );
    const deactivatedUsers = await count(
      db.select({ n: sql<number>`count(*)::int` }).from(users)
        .where(sql`${users.scimExternalId} is not null and ${users.disabledAt} is not null`),
    );
    const groups = await count(db.select({ n: sql<number>`count(*)::int` }).from(scimGroups));
    const memberships = await count(
      db.select({ n: sql<number>`count(*)::int` }).from(scimGroupMembers),
    );
    // ADR-0038: how many synced groups actually confer something. The rest are
    // inert, which is the default and the safe direction — but it should be
    // VISIBLE that "12 groups synced" and "2 groups grant anything" are
    // different numbers.
    const mappedGroups = await count(
      db.select({ n: sql<number>`count(distinct ${groupRoleMappings.externalGroup})::int` })
        .from(groupRoleMappings)
        .where(eq(groupRoleMappings.source, "scim")),
    );
    const lastUsedAt = tokens
      .map((t) => t.lastUsedAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    return {
      tokens: tokens.map(publicToken),
      activeTokens: tokens.filter((t) => !t.revokedAt).length,
      lastUsedAt,
      counts: {
        provisionedUsers,
        deactivatedUsers,
        groups,
        memberships,
        /** ADR-0038: distinct synced groups an admin has mapped to a role */
        mappedGroups,
      },
      /** stated in the payload, not just in the docs: a synced group is inert
       * unless an admin created an ADR-0038 mapping for it. This flag is about
       * the UNMAPPED case and is permanently false — there is deliberately no
       * "default role for unmapped groups" setting to flip it. */
      unmappedGroupsGrantEntitlement: false,
      /** and no mapping, of any group, can ever produce the platform admin bit */
      isAdminGroupDerivable: false,
    };
  });
}
