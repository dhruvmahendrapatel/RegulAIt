/**
 * ADR-0038 — admin surface for IdP-group → role mappings.
 *
 * Deliberately a SEPARATE file from `group-roles.ts`, which holds the
 * reconciliation routine identity events actually run. The split is not
 * cosmetic: it keeps the reconciler small enough to read end to end, and lets a
 * test assert structurally that the reconciler contains no reference to the
 * platform admin flag and writes no `users` row — "there is no code path from a
 * group to isAdmin" rather than "the path we have is never taken".
 *
 * Every route here is admin-only through app.ts's DEFAULT gate (none of them
 * appear in NON_ADMIN_ROUTES): creating a mapping delegates a role's grants to
 * whoever administers the IdP group, which is exactly the kind of act that must
 * not be reachable by a non-admin.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  GROUP_SOURCES,
  and,
  asc,
  assertedGroups as assertedGroupsTable,
  auditLog,
  desc,
  eq,
  groupRoleMappings,
  inArray,
  roleAssignments,
  roles,
  users,
  type Db,
} from "@regulait/db";
import { scimAssertedGroupsFor } from "./group-roles.js";
import { isApproverRole } from "./approval-pool.js";
import { requireStepUp } from "./step-up.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** trim + de-duplicate, the same normalisation the reconciler applies */
const dedupe = (values: string[]): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const t = v.trim();
    if (t.length === 0 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
};

const createMappingSchema = z.object({
  source: z.enum(GROUP_SOURCES),
  externalGroup: z.string().trim().min(1).max(512),
  roleId: z.string().uuid(),
});

export function registerGroupRoleMappingRoutes(app: FastifyInstance, db: Db): void {
  const auditAdmin = (
    actorUserId: string | null,
    objectId: string | null,
    ruleId: string,
    reason: string,
    detail: Record<string, unknown>,
  ) =>
    db.insert(auditLog).values({
      userId: actorUserId ?? NIL_UUID,
      objectType: "group_role_mapping",
      objectId,
      effect: "allow",
      ruleId,
      ruleChain: [],
      reason,
      detail: { phase: "group-role-mapping-admin", ...detail },
    });

  /** every mapping, newest first, with the role it confers named. */
  app.get("/v1/group-role-mappings", async (req) => {
    const q = z
      .object({ source: z.enum(GROUP_SOURCES).optional() })
      .parse(req.query ?? {});
    const rows = await db
      .select({
        id: groupRoleMappings.id,
        source: groupRoleMappings.source,
        externalGroup: groupRoleMappings.externalGroup,
        roleId: groupRoleMappings.roleId,
        roleName: roles.name,
        createdAt: groupRoleMappings.createdAt,
      })
      .from(groupRoleMappings)
      .innerJoin(roles, eq(roles.id, groupRoleMappings.roleId))
      .where(q.source ? eq(groupRoleMappings.source, q.source) : undefined)
      .orderBy(desc(groupRoleMappings.createdAt));
    return {
      mappings: rows,
      /** said in the payload, not only in the docs — the UI repeats it because
       * the natural assumption on seeing a synced group list is that something
       * was granted. */
      unmappedGroupsGrantEntitlement: false,
    };
  });

  app.post("/v1/group-role-mappings", async (req, reply) => {
    const body = createMappingSchema.parse(req.body);
    const [role] = await db.select().from(roles).where(eq(roles.id, body.roleId));
    if (!role) return reply.status(422).send({ error: "unknown_role" });
    // B4S-02 (owner principle): mapping a group to an approver role adds its
    // holders to that approver pool — the same settings_relax step-up as
    // assigning the role directly, bound to the group and the role
    if (await isApproverRole(db, body.roleId)) {
      const facts = { values: { approverRoleGroup: { source: body.source, externalGroup: body.externalGroup, roleId: body.roleId } } };
      if (!(await requireStepUp(db, req, reply, { kind: "settings_relax", facts })).ok) return reply;
    }
    const [row] = await db
      .insert(groupRoleMappings)
      .values(body)
      .onConflictDoNothing()
      .returning();
    if (!row) {
      const [existing] = await db
        .select()
        .from(groupRoleMappings)
        .where(
          and(
            eq(groupRoleMappings.source, body.source),
            eq(groupRoleMappings.externalGroup, body.externalGroup),
            eq(groupRoleMappings.roleId, body.roleId),
          ),
        );
      return reply.status(409).send({ error: "mapping_exists", mapping: existing });
    }
    await auditAdmin(req.authCtx.userId ?? null, row.id, "group-role-mapping-created",
      `admin mapped ${body.source} group '${body.externalGroup}' to role '${role.name}' — holders of that group gain the role's baseline on their next login/sync, and nothing beyond it (isAdmin is not a role and is not reachable from a mapping)`,
      { source: body.source, externalGroup: body.externalGroup, roleId: role.id, roleName: role.name });
    return reply.status(201).send({ ...row, roleName: role.name });
  });

  /**
   * Deleting a mapping does NOT retroactively strip anyone here — the
   * group-derived assignments it created are removed by the next reconciliation
   * for each affected user, on their next login or sync, exactly like a group
   * membership disappearing in the IdP. That keeps ONE removal path
   * (reconciliation) rather than a second, subtly-different one.
   */
  app.delete("/v1/group-role-mappings/:mappingId", async (req, reply) => {
    const { mappingId } = z.object({ mappingId: z.string().uuid() }).parse(req.params);
    const [row] = await db
      .select({
        id: groupRoleMappings.id,
        source: groupRoleMappings.source,
        externalGroup: groupRoleMappings.externalGroup,
        roleId: groupRoleMappings.roleId,
        roleName: roles.name,
      })
      .from(groupRoleMappings)
      .innerJoin(roles, eq(roles.id, groupRoleMappings.roleId))
      .where(eq(groupRoleMappings.id, mappingId));
    if (!row) return reply.status(404).send({ error: "unknown_mapping" });
    await db.delete(groupRoleMappings).where(eq(groupRoleMappings.id, mappingId));
    await auditAdmin(req.authCtx.userId ?? null, mappingId, "group-role-mapping-deleted",
      `admin removed the mapping of ${row.source} group '${row.externalGroup}' to role '${row.roleName}' — the group-derived assignments it created are reconciled away on each holder's next login/sync; admin-direct assignments of the same role are untouched`,
      { source: row.source, externalGroup: row.externalGroup, roleId: row.roleId, roleName: row.roleName });
    return { removed: true };
  });

  /**
   * The "unmapped asserted groups" report — ADR-0038 honest-risk #3. Every
   * group any identity path has ever asserted, joined against the mappings, so
   * the ones conferring nothing are visible instead of silently inert. This is
   * where an IdP-side rename shows up as "seen 400 times, mapped to nothing".
   */
  app.get("/v1/group-role-mappings/asserted-groups", async (req) => {
    const q = z
      .object({ source: z.enum(GROUP_SOURCES).optional(), unmappedOnly: z.coerce.boolean().optional() })
      .parse(req.query ?? {});
    const [sightings, mappings] = await Promise.all([
      db
        .select()
        .from(assertedGroupsTable)
        .where(q.source ? eq(assertedGroupsTable.source, q.source) : undefined)
        .orderBy(desc(assertedGroupsTable.lastSeenAt), asc(assertedGroupsTable.externalGroup)),
      db
        .select({
          source: groupRoleMappings.source,
          externalGroup: groupRoleMappings.externalGroup,
          roleId: groupRoleMappings.roleId,
          roleName: roles.name,
        })
        .from(groupRoleMappings)
        .innerJoin(roles, eq(roles.id, groupRoleMappings.roleId)),
    ]);
    const key = (s: string, g: string) => `${s}::${g}`;
    const byGroup = new Map<string, Array<{ roleId: string; roleName: string }>>();
    for (const m of mappings) {
      const k = key(m.source, m.externalGroup);
      const list = byGroup.get(k) ?? [];
      list.push({ roleId: m.roleId, roleName: m.roleName });
      byGroup.set(k, list);
    }
    const rows = sightings.map((s) => {
      const mapped = byGroup.get(key(s.source, s.externalGroup)) ?? [];
      return {
        source: s.source,
        externalGroup: s.externalGroup,
        firstSeenAt: s.firstSeenAt,
        lastSeenAt: s.lastSeenAt,
        seenCount: s.seenCount,
        mapped: mapped.length > 0,
        roles: mapped,
      };
    });
    const filtered = q.unmappedOnly ? rows.filter((r) => !r.mapped) : rows;
    return { assertedGroups: filtered, unmappedCount: rows.filter((r) => !r.mapped).length };
  });

  /**
   * PROVENANCE for the roster / access-preview surface: which roles does this
   * user hold, and WHY — an admin action (`direct`) or a named group+mapping
   * (`group`). "Why does this user have this role?" has to be answerable
   * without reading the audit log, and a role held BOTH ways shows both.
   */
  app.get("/v1/users/:userId/role-provenance", async (req, reply) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const [subject] = await db.select().from(users).where(eq(users.id, userId));
    if (!subject) return reply.status(404).send({ error: "unknown_user" });
    const assignments = await db
      .select({
        roleId: roleAssignments.roleId,
        roleName: roles.name,
        origin: roleAssignments.origin,
        assignedAt: roleAssignments.createdAt,
      })
      .from(roleAssignments)
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .where(eq(roleAssignments.userId, userId));

    const roleIds = dedupe(assignments.map((a) => a.roleId));
    const mappings =
      roleIds.length === 0
        ? []
        : await db
            .select()
            .from(groupRoleMappings)
            .where(inArray(groupRoleMappings.roleId, roleIds));
    const scimGroupsForUser = new Set(await scimAssertedGroupsFor(db, userId));

    const byRole = new Map<string, { roleName: string; origins: Set<string>; assignedAt: Date }>();
    for (const a of assignments) {
      const cur = byRole.get(a.roleId);
      if (cur) cur.origins.add(a.origin);
      else byRole.set(a.roleId, { roleName: a.roleName, origins: new Set([a.origin]), assignedAt: a.assignedAt });
    }

    const rows = [...byRole.entries()].map(([roleId, v]) => {
      const via = mappings
        .filter((m) => m.roleId === roleId)
        .map((m) => ({
          mappingId: m.id,
          source: m.source,
          externalGroup: m.externalGroup,
          /** only SCIM membership is stored state we can check here; SAML/OIDC
           * groups are per-assertion and are named in the audit trail instead */
          currentlyAssertedViaScim: m.source === "scim" && scimGroupsForUser.has(m.externalGroup),
        }));
      const origins = [...v.origins].sort();
      return {
        roleId,
        roleName: v.roleName,
        origins,
        /** the summary the UI shows: direct | group | both */
        provenance: origins.length > 1 ? "both" : origins[0]!,
        assignedAt: v.assignedAt,
        ...(via.length > 0 ? { viaMappings: via } : {}),
      };
    });
    return {
      userId,
      email: subject.email,
      /** stated so the UI never has to infer it: isAdmin is not a role and no
       * mapping can produce it (ADR-0038). */
      isAdmin: subject.isAdmin,
      isAdminGroupDerivable: false,
      roles: rows,
    };
  });
}
