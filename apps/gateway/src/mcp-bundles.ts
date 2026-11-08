/**
 * ADR-0236 (backlog P11) — governed MCP bundles.
 *
 * A bundle is a named, VERSIONED list of exact (server, tool) pairs that an admin grants to a user, a role or a team
 * as one unit. It is a grant source at the ROLE tier of the pillar-1 kernel (`bundle-tool-allow-list`): a per-user
 * revocation subtracts from it exactly as from a role grant, and every restriction after the grant step (halt, lead
 * ceiling, the actor intersection, ABAC, data scope, rate limits, approvals, admission) still applies. Enforcement is
 * at the existing interception point: `loadEntitlements` feeds the bundle items to the same `evaluate`/`visibleTools`
 * every MCP path already calls (entitlements.ts `loadBundleToolGrants`).
 *
 * GOVERNED:
 *  - default-deny and default-off: `org_settings.mcp_bundles_enabled` is false; while false every write here is
 *    refused (409, audited) and the gateway loads no bundle grant. Turning it on is a `settings_relax` step-up.
 *  - every route is admin-only (the default gate; none is in NON_ADMIN_ROUTES) and every write is audited in the same
 *    transaction as the row (`objectType: "mcp_bundle"`).
 *  - a change to a bundle's tools is a NEW immutable version (append-only in the database), made with a
 *    compare-and-set on `expectedVersion`. A version that ADDS a tool widens access for every holder at once, so it
 *    needs a `settings_relax` step-up; a version that only removes tools narrows and needs none.
 *  - no wildcard: a bundle names exact tools that exist in the inventory; a tool a server adds later is in no bundle.
 *  - the ADR-0091 separation-of-duties gate runs on every mint: a grant (per item, per user; per team member for a
 *    team) and a widening version (per added item, per existing holder).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  and,
  asc,
  auditLog,
  count,
  desc,
  eq,
  inArray,
  isNull,
  mcpBundleGrants,
  mcpBundleVersionItems,
  mcpBundleVersions,
  mcpBundles,
  mcpServers,
  mcpTools,
  roleAssignments,
  roles,
  sql,
  teamMembers,
  teams,
  users,
  type Db,
  type McpBundleRow,
} from "@regulait/db";
import { BUNDLE_SCOPE_TIERS } from "@regulait/policy-kernel";
import { isReservedToolName } from "./mcp-protocol.js";
import { loadOrgSettings } from "./org-settings.js";
import { refuseSodFootprint } from "./sod.js";
import { requireStepUp, CHANGED_CONCURRENTLY } from "./step-up.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";

/** the most (server, tool) pairs one version may list */
export const MCP_BUNDLE_MAX_ITEMS = 200;

export const MCP_BUNDLE_RULE_IDS = Object.freeze({
  created: "mcp-bundle-created",
  updated: "mcp-bundle-updated",
  versioned: "mcp-bundle-versioned",
  archived: "mcp-bundle-archived",
  granted: "mcp-bundle-granted",
  grantRemoved: "mcp-bundle-grant-removed",
  toolTierChanged: "mcp-tool-tier-changed",
  disabled: "mcp-bundle-disabled",
});

const nameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const itemSchema = z.object({ serverId: z.string().uuid(), toolName: z.string().min(1).max(256) }).strict();
const itemsSchema = z.array(itemSchema).max(MCP_BUNDLE_MAX_ITEMS);
const createSchema = z
  .object({
    name: nameSchema,
    description: z.string().max(1000).nullable().optional(),
    approverUserId: z.string().uuid().nullable().optional(),
    items: itemsSchema,
  })
  .strict();
const patchSchema = z
  .object({ description: z.string().max(1000).nullable().optional(), approverUserId: z.string().uuid().nullable().optional() })
  .strict()
  .refine((p) => p.description !== undefined || p.approverUserId !== undefined, { message: "nothing to change" });
const versionSchema = z.object({ expectedVersion: z.number().int().min(1), items: itemsSchema }).strict();
const grantSchema = z
  .object({
    userId: z.string().uuid().optional(),
    roleId: z.string().uuid().optional(),
    teamId: z.string().uuid().optional(),
    /** ADR-0236 scope tier cap; default 'read' (ADR-0180) */
    maxTier: z.enum(BUNDLE_SCOPE_TIERS).optional(),
  })
  .strict()
  .refine((g) => [g.userId, g.roleId, g.teamId].filter(Boolean).length === 1, { message: "exactly one subject" });
const bundleParam = z.object({ bundleId: z.string().uuid() });
const versionParam = z.object({ bundleId: z.string().uuid(), version: z.coerce.number().int().min(1).max(1_000_000) });
const grantParam = z.object({ bundleId: z.string().uuid(), grantId: z.string().uuid() });
const toolParam = z.object({ toolId: z.string().uuid() });
const dangerousSchema = z.object({ dangerous: z.boolean() }).strict();

type Item = z.infer<typeof itemSchema>;
const itemKey = (i: { serverId: string | null; toolName: string }) => `${i.serverId ?? ""}\u0000${i.toolName}`;

/** de-duplicated, in a stable order (so a digest and a diff never depend on the caller's order) */
function normaliseItems(items: readonly Item[]): Item[] {
  const byKey = new Map(items.map((i) => [itemKey(i), i]));
  return [...byKey.values()].sort((a, b) => a.serverId.localeCompare(b.serverId) || a.toolName.localeCompare(b.toolName));
}

export function bundleView(row: McpBundleRow, extra: { grantCount?: number } = {}) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    approverUserId: row.approverUserId,
    currentVersion: row.currentVersion,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(extra.grantCount !== undefined ? { grantCount: extra.grantCount } : {}),
  };
}

async function versionItems(db: Db, bundleId: string, version: number) {
  return db
    .select({ serverId: mcpBundleVersionItems.serverId, serverName: mcpServers.name, toolName: mcpBundleVersionItems.toolName })
    .from(mcpBundleVersionItems)
    .innerJoin(mcpBundleVersions, eq(mcpBundleVersions.id, mcpBundleVersionItems.versionId))
    .leftJoin(mcpServers, eq(mcpServers.id, mcpBundleVersionItems.serverId))
    .where(and(eq(mcpBundleVersions.bundleId, bundleId), eq(mcpBundleVersions.version, version)))
    .orderBy(asc(mcpBundleVersionItems.serverId), asc(mcpBundleVersionItems.toolName))
    .limit(MCP_BUNDLE_MAX_ITEMS);
}

/** the items that are NOT in the tool inventory (or are protocol-reserved names); [] = every item is a real tool */
async function unknownItems(db: Db, items: readonly Item[]): Promise<Item[]> {
  if (items.length === 0) return [];
  const serverIds = [...new Set(items.map((i) => i.serverId))];
  const known = await db
    .select({ serverId: mcpTools.serverId, toolName: mcpTools.name })
    .from(mcpTools)
    .where(inArray(mcpTools.serverId, serverIds));
  const have = new Set(known.map((k) => itemKey(k)));
  return items.filter((i) => isReservedToolName(i.toolName) || !have.has(itemKey(i)));
}

type Subject = { kind: "user"; id: string } | { kind: "role"; id: string } | { kind: "team"; id: string };

/**
 * The most identities one SoD check covers (review of #697). Above it the grant is refused rather than checked in
 * part: a truncated holder list would let the unchecked members through (fail open).
 */
export const MCP_BUNDLE_SOD_MAX_IDENTITIES = 10_000;

type SodGate = { ok: true } | { ok: false; status: 409 | 422; body: Record<string, unknown> };

/**
 * ADR-0091 — the SoD gate for every tool the subjects would come to hold, as ONE batched check (review of #697: the
 * per-item × per-member loop was an N+1). The identities are resolved in at most three queries (direct users, role
 * assignees, team members), and `refuseSodFootprint` checks every (identity, tool) pair in memory against queries
 * that depend only on the enabled SoD rules. More than MCP_BUNDLE_SOD_MAX_IDENTITIES identities is refused (422).
 */
async function bundleSodGate(db: Db, subjects: readonly Subject[], items: readonly Item[], actorUserId: string | null, bundleId: string): Promise<SodGate> {
  if (items.length === 0 || subjects.length === 0) return { ok: true };
  const cap = MCP_BUNDLE_SOD_MAX_IDENTITIES + 1;
  const ids = new Set(subjects.filter((x) => x.kind === "user").map((x) => x.id));
  const roleIds = subjects.filter((x) => x.kind === "role").map((x) => x.id);
  const teamIds = subjects.filter((x) => x.kind === "team").map((x) => x.id);
  if (roleIds.length > 0) {
    for (const r of await db.selectDistinct({ userId: roleAssignments.userId }).from(roleAssignments).where(inArray(roleAssignments.roleId, roleIds)).limit(cap)) ids.add(r.userId);
  }
  if (teamIds.length > 0) {
    for (const m of await db.selectDistinct({ userId: teamMembers.userId }).from(teamMembers).where(inArray(teamMembers.teamId, teamIds)).limit(cap)) ids.add(m.userId);
  }
  if (ids.size > MCP_BUNDLE_SOD_MAX_IDENTITIES) {
    return {
      ok: false,
      status: 422,
      body: {
        error: "bundle_holders_too_many",
        detail: `This change would give the bundle's tools to more than ${MCP_BUNDLE_SOD_MAX_IDENTITIES} people at once, which is more than one separation-of-duties check covers. Grant it to smaller teams or roles. Nothing was saved.`,
      },
    };
  }
  const sod = await refuseSodFootprint(
    db,
    { capabilities: items.map((i) => ({ kind: "mcp_tool" as const, objectId: i.serverId, toolName: i.toolName, mode: null })), userIds: [...ids] },
    actorUserId,
    { kind: "mcp_bundle", bundleId, subjects: subjects.map((x) => `${x.kind}:${x.id}`).slice(0, 50), toolCount: items.length },
  );
  return sod ? { ok: false, status: 409, body: sod } : { ok: true };
}

const subjectOf = (g: { userId: string | null; roleId: string | null; teamId: string | null }): Subject =>
  g.userId ? { kind: "user", id: g.userId } : g.roleId ? { kind: "role", id: g.roleId } : { kind: "team", id: g.teamId! };

export function registerMcpBundleRoutes(app: FastifyInstance, db: Db): void {
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? NIL_USER;
  const audit = (
    tx: Db,
    req: FastifyRequest,
    bundleId: string | null,
    ruleId: string,
    effect: "allow" | "deny",
    reason: string,
    detail: Record<string, unknown>,
  ) => tx.insert(auditLog).values({ userId: actor(req), objectType: "mcp_bundle", objectId: bundleId, detail, effect, ruleId, ruleChain: [], reason });

  const loadBundle = async (bundleId: string) => (await db.select().from(mcpBundles).where(eq(mcpBundles.id, bundleId)))[0];

  /** default-off: every write is refused, and the refusal is on the trail, while the org setting is false */
  const refuseWhenDisabled = async (req: FastifyRequest, reply: FastifyReply, bundleId: string | null, op: string): Promise<boolean> => {
    if ((await loadOrgSettings(db)).mcpBundlesEnabled) return false;
    await audit(db, req, bundleId, MCP_BUNDLE_RULE_IDS.disabled, "deny", `MCP bundle ${op} refused: MCP bundles are turned off for this organisation`, { phase: op });
    await reply.status(409).send({
      error: "mcp_bundles_disabled",
      detail: "MCP bundles are turned off for this organisation; an admin turns them on in Organisation settings (mcpBundlesEnabled). Nothing was saved.",
    });
    return true;
  };

  /** an approver must be an existing, enabled person */
  const refuseBadApprover = async (approverUserId: string | null | undefined, reply: FastifyReply): Promise<boolean> => {
    if (!approverUserId) return false;
    const [u] = await db.select({ id: users.id, disabledAt: users.disabledAt }).from(users).where(eq(users.id, approverUserId));
    if (u && !u.disabledAt) return false;
    await reply.status(400).send({ error: "unknown_approver", detail: "the approver must be an existing, enabled person. Nothing was saved." });
    return true;
  };

  const refuseUnknownItems = async (items: readonly Item[], reply: FastifyReply): Promise<boolean> => {
    const unknown = await unknownItems(db, items);
    if (unknown.length === 0) return false;
    await reply.status(400).send({
      error: "unknown_tools",
      detail: "every bundle item must be a tool in the MCP inventory (sync the server's manifest first). Nothing was saved.",
      unknown: unknown.slice(0, 20),
    });
    return true;
  };

  // --- read -----------------------------------------------------------------

  app.get("/v1/mcp-bundles", async () => {
    const [org, rows, counts] = await Promise.all([
      loadOrgSettings(db),
      db.select().from(mcpBundles).orderBy(asc(mcpBundles.name)).limit(500),
      db.select({ bundleId: mcpBundleGrants.bundleId, n: count() }).from(mcpBundleGrants).groupBy(mcpBundleGrants.bundleId).limit(500),
    ]);
    const byBundle = new Map(counts.map((c) => [c.bundleId, Number(c.n)]));
    return { enabled: org.mcpBundlesEnabled, bundles: rows.map((r) => bundleView(r, { grantCount: byBundle.get(r.id) ?? 0 })) };
  });

  app.get("/v1/mcp-bundles/:bundleId", async (req, reply) => {
    const { bundleId } = bundleParam.parse(req.params);
    const bundle = await loadBundle(bundleId);
    if (!bundle) return reply.status(404).send({ error: "unknown_bundle" });
    const [items, versions] = await Promise.all([
      versionItems(db, bundleId, bundle.currentVersion),
      db
        .select({ version: mcpBundleVersions.version, createdBy: mcpBundleVersions.createdBy, createdAt: mcpBundleVersions.createdAt })
        .from(mcpBundleVersions)
        .where(eq(mcpBundleVersions.bundleId, bundleId))
        .orderBy(desc(mcpBundleVersions.version))
        .limit(100),
    ]);
    return { ...bundleView(bundle), items, versions: versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })) };
  });

  app.get("/v1/mcp-bundles/:bundleId/versions/:version", async (req, reply) => {
    const { bundleId, version } = versionParam.parse(req.params);
    const [row] = await db
      .select({ version: mcpBundleVersions.version, createdBy: mcpBundleVersions.createdBy, createdAt: mcpBundleVersions.createdAt })
      .from(mcpBundleVersions)
      .where(and(eq(mcpBundleVersions.bundleId, bundleId), eq(mcpBundleVersions.version, version)));
    if (!row) return reply.status(404).send({ error: "unknown_version" });
    return { bundleId, ...row, createdAt: row.createdAt.toISOString(), items: await versionItems(db, bundleId, version) };
  });

  // --- bundle CRUD ------------------------------------------------------------

  app.post("/v1/mcp-bundles", async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", detail: "expected { name (lower-case letters, digits, hyphens), description?, items: [{ serverId, toolName }] }" });
    if (await refuseWhenDisabled(req, reply, null, "create")) return reply;
    const items = normaliseItems(parsed.data.items);
    if (await refuseUnknownItems(items, reply)) return reply;
    if (await refuseBadApprover(parsed.data.approverUserId, reply)) return reply;
    const created = await db.transaction(async (tx) => {
      const [bundle] = await tx
        .insert(mcpBundles)
        .values({
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          approverUserId: parsed.data.approverUserId ?? null,
          currentVersion: 1,
          createdBy: req.authCtx.userId ?? null,
        })
        .onConflictDoNothing()
        .returning();
      if (!bundle) return null;
      const [v] = await tx.insert(mcpBundleVersions).values({ bundleId: bundle.id, version: 1, createdBy: req.authCtx.userId ?? null }).returning();
      if (items.length > 0) await tx.insert(mcpBundleVersionItems).values(items.map((i) => ({ versionId: v!.id, serverId: i.serverId, toolName: i.toolName })));
      await audit(tx as unknown as Db, req, bundle.id, MCP_BUNDLE_RULE_IDS.created, "allow", `MCP bundle '${bundle.name}' created at version 1 with ${items.length} tool(s); nobody holds it yet`, {
        phase: "create",
        name: bundle.name,
        version: 1,
        approverUserId: bundle.approverUserId,
        items,
      });
      return bundle;
    });
    if (!created) return reply.status(409).send({ error: "bundle_exists", detail: "a bundle with this name already exists" });
    return reply.status(201).send({ ...bundleView(created), items });
  });

  app.patch("/v1/mcp-bundles/:bundleId", async (req, reply) => {
    const { bundleId } = bundleParam.parse(req.params);
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", detail: "expected { description?, approverUserId? }" });
    const before = await loadBundle(bundleId);
    if (!before) return reply.status(404).send({ error: "unknown_bundle" });
    if (await refuseWhenDisabled(req, reply, bundleId, "update")) return reply;
    if (await refuseBadApprover(parsed.data.approverUserId, reply)) return reply;
    // review of #697: who signs off a dangerous tool is part of what the hold enforces, so naming a different approver
    // is a governed relaxation (a step-up). Clearing the approver only tightens (dangerous calls then fail closed).
    const naming = parsed.data.approverUserId !== undefined && parsed.data.approverUserId !== null && parsed.data.approverUserId !== before.approverUserId;
    if (naming) {
      const su = await requireStepUp(db, req, reply, {
        kind: "settings_relax",
        facts: { op: "mcp_bundle_approver", bundleId, approverBefore: before.approverUserId, approverAfter: parsed.data.approverUserId },
      });
      if (!su.ok) return reply;
    }
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(mcpBundles)
        .set({
          ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
          ...(parsed.data.approverUserId !== undefined ? { approverUserId: parsed.data.approverUserId } : {}),
          updatedAt: sql`now()`,
        })
        // compare-and-set: the step-up was decided on the approver read above
        .where(and(eq(mcpBundles.id, bundleId), sql`${mcpBundles.approverUserId} IS NOT DISTINCT FROM ${before.approverUserId}`))
        .returning();
      if (!updated) return null;
      const approverChanged = parsed.data.approverUserId !== undefined && parsed.data.approverUserId !== before.approverUserId;
      await audit(
        tx as unknown as Db,
        req,
        bundleId,
        MCP_BUNDLE_RULE_IDS.updated,
        "allow",
        `MCP bundle '${updated.name}': ${[parsed.data.description !== undefined ? "description" : null, approverChanged ? "approver for dangerous tools" : null].filter(Boolean).join(" and ") || "nothing"} changed`,
        { phase: "update", ...(approverChanged ? { approverBefore: before.approverUserId, approverAfter: updated.approverUserId } : {}) },
      );
      return updated;
    });
    if (!row) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    return bundleView(row);
  });

  /**
   * A change to the tools is a NEW version. `expectedVersion` is a compare-and-set: the step-up (when the change adds
   * tools) is decided on the version read here, so the write happens only if that is still the current version.
   */
  app.put("/v1/mcp-bundles/:bundleId/items", async (req, reply) => {
    const { bundleId } = bundleParam.parse(req.params);
    const parsed = versionSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", detail: "expected { expectedVersion, items: [{ serverId, toolName }] }" });
    const bundle = await loadBundle(bundleId);
    if (!bundle) return reply.status(404).send({ error: "unknown_bundle" });
    if (await refuseWhenDisabled(req, reply, bundleId, "version")) return reply;
    if (bundle.archivedAt) return reply.status(409).send({ error: "bundle_archived", detail: "an archived bundle cannot change. Nothing was saved." });
    if (bundle.currentVersion !== parsed.data.expectedVersion) {
      return reply.status(409).send({ error: "version_conflict", detail: `the bundle is at version ${bundle.currentVersion}, not ${parsed.data.expectedVersion}. Nothing was saved.`, currentVersion: bundle.currentVersion });
    }
    const items = normaliseItems(parsed.data.items);
    if (await refuseUnknownItems(items, reply)) return reply;
    const before = await versionItems(db, bundleId, bundle.currentVersion);
    const beforeKeys = new Set(before.map(itemKey));
    const afterKeys = new Set(items.map(itemKey));
    const added = items.filter((i) => !beforeKeys.has(itemKey(i)));
    const removed = before.filter((i) => !afterKeys.has(itemKey(i))).map((i) => ({ serverId: i.serverId, toolName: i.toolName }));
    if (added.length === 0 && removed.length === 0) return reply.status(409).send({ error: "no_change", detail: "the items are the same as the current version. Nothing was saved." });
    if (added.length > 0) {
      // ADR-0091: every existing holder would come to hold the added tools
      const holders = await db.select().from(mcpBundleGrants).where(eq(mcpBundleGrants.bundleId, bundleId));
      const gate = await bundleSodGate(db, holders.map(subjectOf), added, req.authCtx.userId ?? null, bundleId);
      if (!gate.ok) return reply.status(gate.status).send(gate.body);
      // a version that adds tools widens access for every holder at once: a governed relaxation
      const su = await requireStepUp(db, req, reply, {
        kind: "settings_relax",
        facts: { op: "mcp_bundle_widen", bundleId, fromVersion: bundle.currentVersion, added },
      });
      if (!su.ok) return reply;
    }
    const nextVersion = bundle.currentVersion + 1;
    const out = await db.transaction(async (tx) => {
      // compare-and-set under the row lock: the diff and the step-up above were decided on `expectedVersion`
      const [locked] = await tx.select().from(mcpBundles).where(eq(mcpBundles.id, bundleId)).for("update");
      if (!locked || locked.archivedAt || locked.currentVersion !== bundle.currentVersion) return null;
      const [v] = await tx.insert(mcpBundleVersions).values({ bundleId, version: nextVersion, createdBy: req.authCtx.userId ?? null }).returning();
      if (items.length > 0) await tx.insert(mcpBundleVersionItems).values(items.map((i) => ({ versionId: v!.id, serverId: i.serverId, toolName: i.toolName })));
      const [updated] = await tx.update(mcpBundles).set({ currentVersion: nextVersion, updatedAt: sql`now()` }).where(eq(mcpBundles.id, bundleId)).returning();
      await audit(
        tx as unknown as Db,
        req,
        bundleId,
        MCP_BUNDLE_RULE_IDS.versioned,
        "allow",
        `MCP bundle '${locked.name}' changed from version ${locked.currentVersion} to ${nextVersion}: ${added.length} tool(s) added, ${removed.length} removed, for every holder`,
        { phase: "version", fromVersion: locked.currentVersion, version: nextVersion, added, removed },
      );
      return updated!;
    });
    if (!out) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    return { ...bundleView(out), items, added, removed };
  });

  /** archive: the bundle grants nothing from now on; its versions and grant rows stay as history */
  app.delete("/v1/mcp-bundles/:bundleId", async (req, reply) => {
    const { bundleId } = bundleParam.parse(req.params);
    if (!(await loadBundle(bundleId))) return reply.status(404).send({ error: "unknown_bundle" });
    const out = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(mcpBundles)
        .set({ archivedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(mcpBundles.id, bundleId), isNull(mcpBundles.archivedAt)))
        .returning();
      if (!updated) return null;
      const [{ n }] = (await tx.select({ n: count() }).from(mcpBundleGrants).where(eq(mcpBundleGrants.bundleId, bundleId))) as [{ n: number }];
      await audit(tx as unknown as Db, req, bundleId, MCP_BUNDLE_RULE_IDS.archived, "allow", `MCP bundle '${updated.name}' archived: its ${Number(n)} grant(s) confer nothing from now on`, {
        phase: "archive",
        version: updated.currentVersion,
        grants: Number(n),
      });
      return updated;
    });
    if (!out) return reply.status(409).send({ error: "bundle_archived", detail: "the bundle is already archived" });
    return bundleView(out);
  });

  // --- grants -----------------------------------------------------------------

  app.get("/v1/mcp-bundles/:bundleId/grants", async (req, reply) => {
    const { bundleId } = bundleParam.parse(req.params);
    if (!(await loadBundle(bundleId))) return reply.status(404).send({ error: "unknown_bundle" });
    const rows = await db
      .select({
        id: mcpBundleGrants.id,
        userId: mcpBundleGrants.userId,
        userEmail: users.email,
        roleId: mcpBundleGrants.roleId,
        roleName: roles.name,
        teamId: mcpBundleGrants.teamId,
        teamName: teams.name,
        maxTier: mcpBundleGrants.maxTier,
        grantedBy: mcpBundleGrants.grantedBy,
        createdAt: mcpBundleGrants.createdAt,
      })
      .from(mcpBundleGrants)
      .leftJoin(users, eq(users.id, mcpBundleGrants.userId))
      .leftJoin(roles, eq(roles.id, mcpBundleGrants.roleId))
      .leftJoin(teams, eq(teams.id, mcpBundleGrants.teamId))
      .where(eq(mcpBundleGrants.bundleId, bundleId))
      .orderBy(asc(mcpBundleGrants.createdAt))
      .limit(1000);
    return { grants: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) };
  });

  app.post("/v1/mcp-bundles/:bundleId/grants", async (req, reply) => {
    const { bundleId } = bundleParam.parse(req.params);
    const parsed = grantSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", detail: "expected exactly one of { userId, roleId, teamId }, and maxTier? (read, write or dangerous)" });
    const maxTier = parsed.data.maxTier ?? "read";
    const bundle = await loadBundle(bundleId);
    if (!bundle) return reply.status(404).send({ error: "unknown_bundle" });
    if (await refuseWhenDisabled(req, reply, bundleId, "grant")) return reply;
    if (bundle.archivedAt) return reply.status(409).send({ error: "bundle_archived", detail: "an archived bundle cannot be granted. Nothing was saved." });
    if (maxTier === "dangerous" && !bundle.approverUserId) {
      return reply.status(400).send({
        error: "approver_required",
        detail: "a grant that reaches dangerous tools needs the bundle to name an approver (every such call pauses for them). Nothing was saved.",
      });
    }
    const subject: Subject = parsed.data.userId
      ? { kind: "user", id: parsed.data.userId }
      : parsed.data.roleId
        ? { kind: "role", id: parsed.data.roleId }
        : { kind: "team", id: parsed.data.teamId! };
    const label =
      subject.kind === "user"
        ? (await db.select({ l: users.email }).from(users).where(eq(users.id, subject.id)))[0]?.l
        : subject.kind === "role"
          ? (await db.select({ l: roles.name }).from(roles).where(eq(roles.id, subject.id)))[0]?.l
          : (await db.select({ l: teams.name }).from(teams).where(eq(teams.id, subject.id)))[0]?.l;
    if (label === undefined) return reply.status(404).send({ error: `unknown_${subject.kind}` });
    const items = (await versionItems(db, bundleId, bundle.currentVersion)).flatMap((i) => (i.serverId ? [{ serverId: i.serverId, toolName: i.toolName }] : []));
    const gate = await bundleSodGate(db, [subject], items, req.authCtx.userId ?? null, bundleId);
    if (!gate.ok) return reply.status(gate.status).send(gate.body);
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(mcpBundleGrants)
        .values({
          bundleId,
          userId: subject.kind === "user" ? subject.id : null,
          roleId: subject.kind === "role" ? subject.id : null,
          teamId: subject.kind === "team" ? subject.id : null,
          maxTier,
          grantedBy: req.authCtx.userId ?? null,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) return null;
      await audit(
        tx as unknown as Db,
        req,
        bundleId,
        MCP_BUNDLE_RULE_IDS.granted,
        "allow",
        `MCP bundle '${bundle.name}' (version ${bundle.currentVersion}, ${items.length} tool(s)) granted to ${subject.kind} ${label} up to the ${maxTier} tier; each person's own revocations still apply`,
        { phase: "grant", grantId: created.id, subjectKind: subject.kind, subjectId: subject.id, version: bundle.currentVersion, maxTier },
      );
      return created;
    });
    if (!row) return reply.status(409).send({ error: "grant_exists", detail: `this ${subject.kind} already holds this bundle` });
    return reply.status(201).send({ id: row.id, bundleId, userId: row.userId, roleId: row.roleId, teamId: row.teamId, maxTier: row.maxTier, createdAt: row.createdAt.toISOString() });
  });

  /** revocation is never refused by the org setting: taking access away is always allowed */
  app.delete("/v1/mcp-bundles/:bundleId/grants/:grantId", async (req, reply) => {
    const { bundleId, grantId } = grantParam.parse(req.params);
    const bundle = await loadBundle(bundleId);
    if (!bundle) return reply.status(404).send({ error: "unknown_bundle" });
    const removed = await db.transaction(async (tx) => {
      const [gone] = await tx
        .delete(mcpBundleGrants)
        .where(and(eq(mcpBundleGrants.id, grantId), eq(mcpBundleGrants.bundleId, bundleId)))
        .returning();
      if (!gone) return false;
      const s = subjectOf(gone);
      await audit(tx as unknown as Db, req, bundleId, MCP_BUNDLE_RULE_IDS.grantRemoved, "allow", `MCP bundle '${bundle.name}' revoked from ${s.kind} ${s.id}`, {
        phase: "grant",
        grantId,
        subjectKind: s.kind,
        subjectId: s.id,
      });
      return true;
    });
    if (!removed) return reply.status(404).send({ error: "unknown_grant" });
    return reply.status(204).send();
  });

  // --- scope tiers ------------------------------------------------------------

  /**
   * ADR-0236: flag a tool as DANGEROUS (the top scope tier). Flagging tightens and needs no step-up; clearing the flag
   * lets bundle holders call it without a per-call approval again, so it is a `settings_relax` step-up. Audited either
   * way. Not gated by the bundle setting: it is a property of the tool.
   */
  app.put("/v1/mcp-tools/:toolId/dangerous", async (req, reply) => {
    const { toolId } = toolParam.parse(req.params);
    const parsed = dangerousSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", detail: "expected { dangerous: boolean }" });
    const [tool] = await db.select().from(mcpTools).where(eq(mcpTools.id, toolId));
    if (!tool) return reply.status(404).send({ error: "unknown_tool" });
    if (tool.dangerous === parsed.data.dangerous) return { id: tool.id, serverId: tool.serverId, name: tool.name, kind: tool.kind, dangerous: tool.dangerous };
    if (!parsed.data.dangerous) {
      const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { op: "mcp_tool_dangerous_clear", toolId } });
      if (!su.ok) return reply;
    }
    const out = await db.transaction(async (tx) => {
      // compare-and-set: the step-up was decided on the flag read above
      const [updated] = await tx
        .update(mcpTools)
        .set({ dangerous: parsed.data.dangerous })
        .where(and(eq(mcpTools.id, toolId), eq(mcpTools.dangerous, tool.dangerous)))
        .returning();
      if (!updated) return null;
      await tx.insert(auditLog).values({
        userId: actor(req),
        serverId: updated.serverId,
        toolName: updated.name,
        objectType: "mcp_server",
        objectId: updated.serverId,
        detail: { phase: "tool-tier", toolId, dangerous: updated.dangerous },
        effect: "allow",
        ruleId: MCP_BUNDLE_RULE_IDS.toolTierChanged,
        ruleChain: [],
        reason: updated.dangerous
          ? `tool '${updated.name}' flagged dangerous: through an MCP bundle it needs a dangerous-tier grant and every call pauses for the bundle's approver`
          : `tool '${updated.name}' is no longer flagged dangerous`,
      });
      return updated;
    });
    if (!out) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    return { id: out.id, serverId: out.serverId, name: out.name, kind: out.kind, dangerous: out.dangerous };
  });
}
