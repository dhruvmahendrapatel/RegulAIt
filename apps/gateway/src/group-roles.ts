/**
 * ADR-0038 — IdP group → RegulAIt role mapping.
 *
 * ONE reconciliation routine, shared by all three identity paths (SCIM group
 * sync, OIDC callback, SAML ACS). Every property the ADR calls non-negotiable
 * lives here rather than being re-implemented per source, because three
 * copies of a default-deny rule is three chances to get it wrong:
 *
 *  1. **Default-deny.** The desired role set is computed ONLY from rows in
 *     `group_role_mappings`. A group nobody mapped contributes nothing; there
 *     is no fallback, no default role, no "unknown group" behaviour to
 *     configure. `reconcileGroupRoles` cannot produce a role that no mapping
 *     names.
 *
 *  2. **Reconciliation, not accumulation.** The user's `origin='group'`
 *     assignments are made to equal the implied set exactly — newly implied
 *     roles are inserted, no-longer-implied ones are removed. Losing a group in
 *     the IdP loses the baseline on the next sync/login, which is the point of
 *     directory-driven access.
 *
 *  3. **It touches `origin='group'` rows and nothing else.** Both the SELECT of
 *     current state and the DELETE are scoped by origin, so an admin's
 *     `origin='direct'` assignment is not merely "not chosen for removal" — it
 *     is not in the set the routine can see or address at all. Combined with
 *     migration 0053's UNIQUE(user, role, origin), a role held BOTH ways is two
 *     rows and a sync can only ever reach one of them.
 *
 *  4. **The missing-claim fail-safe.** `assertedGroups: null` means "this event
 *     carried NO group signal" and reconciliation is SKIPPED entirely — current
 *     state is left alone. `assertedGroups: []` means the IdP authoritatively
 *     said "member of nothing" and DOES reconcile to zero. The difference
 *     between the two is the difference between an IdP hiccup and a
 *     mass-deprovision, so the two cases are distinct types at the boundary,
 *     not an empty-array coincidence.
 *
 *  5. **Additive only, and admin is not reachable.** This file is deliberately
 *     the RECONCILER ONLY — the admin CRUD lives next door in
 *     `group-role-api.ts` — so the module that identity events actually run can
 *     be read end to end, and a test asserts it contains no reference to the
 *     platform admin flag at all. The routine writes exactly
 *     one kind of row — `role_assignments` — and reads exactly one mapping
 *     table whose only target is `roles`. It never writes `users`, so there is
 *     no code path from a group to `users.isAdmin`; and because a group-derived
 *     role is an ordinary role assignment, ADR-0013/0014 UNION-MAX composition
 *     and ADR-0019 per-user revocations apply to it unchanged — a revocation
 *     still beats a role a mapping keeps re-adding.
 */
import {
  and,
  assertedGroups as assertedGroupsTable,
  auditLog,
  eq,
  groupRoleMappings,
  inArray,
  roleAssignments,
  roles,
  scimGroupMembers,
  scimGroups,
  sql,
  users,
  type Db,
  type GroupSource,
} from "@regulait/db";
import { lockApproverRoles } from "./approval-pool.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** what triggered a reconciliation — carried into the audit row so "why does
 * this user have this role" names the actual identity event. */
export type GroupReconcileEvent = {
  /** short machine name, e.g. "saml-login" | "oidc-login" | "scim-group-sync" */
  kind: string;
  /** the provider / SCIM token name, for the human-readable reason line */
  actor: string;
  /** the user id to attribute the audit row to; null → the nil uuid (machine) */
  actorUserId?: string | null;
  /** free-form extras (provider id, group id, …) folded into audit detail */
  detail?: Record<string, unknown>;
};

export type GroupReconcileResult = {
  /** true when there was NO group signal and current state was left alone */
  skipped: boolean;
  reason: "no_group_signal" | "reconciled";
  /** the groups the event asserted (empty array = authoritative "none") */
  asserted: string[];
  /** the asserted groups that matched no mapping — nothing was granted for them */
  unmapped: string[];
  /** roles implied by currently-mapped, currently-asserted groups */
  impliedRoleIds: string[];
  added: Array<{ roleId: string; roleName: string | null; viaGroups: string[] }>;
  removed: Array<{ roleId: string; roleName: string | null }>;
  /** ADR-0186 decision 29: implied roles NOT granted because they are approver roles */
  withheld: Array<{ roleId: string; roleName: string | null; viaGroups: string[] }>;
};

const SKIPPED: Omit<GroupReconcileResult, "asserted"> = {
  skipped: true,
  reason: "no_group_signal",
  unmapped: [],
  impliedRoleIds: [],
  added: [],
  removed: [],
  withheld: [],
};

/**
 * Normalise a raw claim/attribute value into a group list, or `null` for "no
 * signal".
 *
 * THE fail-safe, in one function, because getting it wrong once is a
 * mass-access-strip:
 *  - `undefined` / `null` (the key is absent from the assertion) → `null`,
 *    meaning DON'T RECONCILE. An IdP that drops the claim on a bad day, or a
 *    misconfigured attribute name, must not read as "this person is in zero
 *    groups".
 *  - an array (INCLUDING the empty array) → an authoritative membership list.
 *    `[]` is the IdP saying "member of nothing" and reconciles to zero.
 *  - a single string → a one-element list; a comma/semicolon-separated string
 *    is split, because several IdPs flatten multi-valued attributes that way.
 *    An empty/whitespace-only string is an authoritative EMPTY list, not a
 *    missing signal — the key was present.
 *  - anything else (a number, an object) → `null`: an unparseable value is a
 *    malformed assertion, and the fail-safe direction is current state.
 */
export function normalizeAssertedGroups(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (Array.isArray(raw)) {
    return dedupe(raw.filter((v): v is string => typeof v === "string"));
  }
  if (typeof raw === "string") {
    return dedupe(raw.split(/[,;]/));
  }
  return null;
}

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

/**
 * The SCIM mapping key for a synced group.
 *
 * `externalId` is the IdP's own id and is what ADR-0038 names. It is nullable
 * (RFC 7643 makes it optional and not every connector sends one), and inventing
 * one would fabricate an identity the IdP never asserted — so a group without
 * an external id is keyed by its displayName, the only stable identifier the
 * IdP actually gave us. An admin mapping such a group maps the name they see.
 */
export const scimGroupKey = (g: { externalId: string | null; displayName: string }): string =>
  g.externalId ?? g.displayName;

/**
 * The full, currently-recorded SCIM group membership of one user, as mapping
 * keys. SCIM membership is stored state rather than a per-event assertion, so
 * it is ALWAYS an authoritative signal: a user in no synced group legitimately
 * reconciles to zero group-derived roles (that state was written by a sync, not
 * inferred from a missing claim).
 */
export async function scimAssertedGroupsFor(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ externalId: scimGroups.externalId, displayName: scimGroups.displayName })
    .from(scimGroupMembers)
    .innerJoin(scimGroups, eq(scimGroups.id, scimGroupMembers.groupId))
    .where(eq(scimGroupMembers.userId, userId));
  return dedupe(rows.map(scimGroupKey));
}

/** record that these groups were asserted, so the admin "unmapped asserted
 * groups" report can answer "your IdP keeps sending this and nothing is mapped
 * to it". Sightings only — a row here grants nothing. */
async function recordSightings(db: Db, source: GroupSource, groups: string[]): Promise<void> {
  for (const externalGroup of groups) {
    await db
      .insert(assertedGroupsTable)
      .values({ source, externalGroup })
      .onConflictDoUpdate({
        target: [assertedGroupsTable.source, assertedGroupsTable.externalGroup],
        set: {
          lastSeenAt: new Date(),
          seenCount: sql`${assertedGroupsTable.seenCount} + 1`,
        },
      });
  }
}

/**
 * THE routine. Given (user, source, asserted group set), make the user's
 * group-derived role assignments equal exactly the set implied by
 * currently-mapped, currently-asserted groups.
 *
 * `asserted === null` → no group signal → returns immediately having changed
 * nothing (see the fail-safe note at the top of this file).
 */
export async function reconcileGroupRoles(
  db: Db,
  userId: string,
  source: GroupSource,
  asserted: string[] | null,
  event: GroupReconcileEvent,
): Promise<GroupReconcileResult> {
  if (asserted === null) return { ...SKIPPED, asserted: [] };

  const groups = dedupe(asserted);
  await recordSightings(db, source, groups);

  // 1. what do the CURRENTLY-MAPPED, CURRENTLY-ASSERTED groups imply?
  //    DEFAULT-DENY lives in this query: only rows an admin created contribute,
  //    so an unmapped group contributes nothing and there is nothing to
  //    configure about it.
  const mappings =
    groups.length === 0
      ? []
      : await db
          .select()
          .from(groupRoleMappings)
          .where(
            and(
              eq(groupRoleMappings.source, source),
              inArray(groupRoleMappings.externalGroup, groups),
            ),
          );
  const mappedGroups = new Set(mappings.map((m) => m.externalGroup));
  const unmapped = groups.filter((g) => !mappedGroups.has(g));

  /** roleId → the asserted groups that implied it (provenance for the audit) */
  const impliedBy = new Map<string, string[]>();
  for (const m of mappings) {
    const list = impliedBy.get(m.roleId) ?? [];
    list.push(m.externalGroup);
    impliedBy.set(m.roleId, list);
  }
  const impliedRoleIds = [...impliedBy.keys()];

  // 2. current GROUP-DERIVED state. Scoped by origin: direct assignments are
  //    not in this set, so they cannot be selected for removal below.
  const current = await db
    .select({ roleId: roleAssignments.roleId })
    .from(roleAssignments)
    .where(and(eq(roleAssignments.userId, userId), eq(roleAssignments.origin, "group")));
  const have = new Set(current.map((r) => r.roleId));

  const toAdd = impliedRoleIds.filter((id) => !have.has(id));
  const toRemove = [...have].filter((id) => !impliedBy.has(id));

  const nameById = await roleNames(db, [...toAdd, ...toRemove]);

  // 3. apply. Insert is onConflictDoNothing so a replayed sync converges;
  //    delete is scoped to origin='group' a SECOND time (belt to the braces of
  //    having selected only group rows) — an admin's direct grant is a
  //    different row and is unreachable from here.
  //
  //    ADR-0186 decision 29 (PR #198 follow-up, finding 48): an IdP group never
  //    adds anyone to an APPROVER role (one an approval rule as served names) —
  //    the same rule as the JIT default role (`grantJitDefaultRole`). Decided per
  //    role under the approver-role lock, so a rule edit naming the role cannot
  //    interleave. Withheld and audited; an admin may assign the role directly,
  //    with the settings_relax step-up a role assignment needs.
  const added: GroupReconcileResult["added"] = [];
  const withheld: GroupReconcileResult["withheld"] = [];
  for (const roleId of toAdd) {
    const outcome = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      if ((await lockApproverRoles(tx, [roleId])).has(roleId)) return "withheld" as const;
      await tx.insert(roleAssignments).values({ userId, roleId, origin: "group" }).onConflictDoNothing();
      return "granted" as const;
    });
    const entry = { roleId, roleName: nameById.get(roleId) ?? null, viaGroups: impliedBy.get(roleId) ?? [] };
    if (outcome === "withheld") withheld.push(entry);
    else added.push(entry);
  }
  const removed: GroupReconcileResult["removed"] = [];
  for (const roleId of toRemove) {
    await db
      .delete(roleAssignments)
      .where(
        and(
          eq(roleAssignments.userId, userId),
          eq(roleAssignments.roleId, roleId),
          eq(roleAssignments.origin, "group"),
        ),
      );
    removed.push({ roleId, roleName: nameById.get(roleId) ?? null });
  }

  await auditReconciliation(db, userId, source, event, {
    asserted: groups,
    unmapped,
    mappingsFired: mappings.map((m) => ({
      mappingId: m.id,
      externalGroup: m.externalGroup,
      roleId: m.roleId,
      roleName: nameById.get(m.roleId) ?? null,
    })),
    added,
    removed,
    withheld,
  });

  return {
    skipped: false,
    reason: "reconciled",
    asserted: groups,
    unmapped,
    impliedRoleIds,
    added,
    removed,
    withheld,
  };
}

async function roleNames(db: Db, roleIds: string[]): Promise<Map<string, string>> {
  const ids = dedupe(roleIds);
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: roles.id, name: roles.name })
    .from(roles)
    .where(inArray(roles.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * One audit row per reconciliation, in the SINGLE audit log, naming the
 * triggering identity event, the asserted groups, the mappings that fired, and
 * every insert/remove with its origin. A change-free reconciliation is recorded
 * too: "the IdP asserted these groups and nothing changed" is the answer to
 * half the support questions this feature will generate.
 */
async function auditReconciliation(
  db: Db,
  userId: string,
  source: GroupSource,
  event: GroupReconcileEvent,
  detail: {
    asserted: string[];
    unmapped: string[];
    mappingsFired: Array<{ mappingId: string; externalGroup: string; roleId: string; roleName: string | null }>;
    added: GroupReconcileResult["added"];
    removed: GroupReconcileResult["removed"];
    withheld: GroupReconcileResult["withheld"];
  },
): Promise<void> {
  const [subject] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  const changes: string[] = [];
  for (const a of detail.added) {
    changes.push(`+${a.roleName ?? a.roleId} (origin=group, via ${a.viaGroups.join(", ")})`);
  }
  for (const r of detail.removed) {
    changes.push(`-${r.roleName ?? r.roleId} (origin=group, no longer implied)`);
  }
  for (const w of detail.withheld) {
    changes.push(`WITHHELD ${w.roleName ?? w.roleId} (an approver role, via ${w.viaGroups.join(", ")})`);
  }
  const reason =
    `${event.kind} (${event.actor}) reconciled group-derived roles for '${subject?.email ?? userId}': ` +
    `asserted [${detail.asserted.join(", ") || "none"}]` +
    (detail.unmapped.length > 0
      ? `, unmapped (granted nothing) [${detail.unmapped.join(", ")}]`
      : "") +
    ` — ${changes.length > 0 ? changes.join("; ") : "no change"}` +
    ` (admin-direct assignments untouched)`;

  // one deny row per withheld approver role, as the JIT default role's `sso-default-role-withheld`
  for (const w of detail.withheld) {
    await db.insert(auditLog).values({
      userId: event.actorUserId ?? NIL_UUID,
      objectType: "group_role_mapping",
      objectId: userId,
      effect: "deny",
      ruleId: "group-role-withheld",
      ruleChain: [],
      reason:
        `${event.kind} (${event.actor}) did NOT add '${subject?.email ?? userId}' to role '${w.roleName ?? w.roleId}' ` +
        `(via ${w.viaGroups.join(", ")}): it is an approver role, and an identity provider's group never joins an ` +
        "approver pool silently (an admin may assign it, with a step-up)",
      detail: { phase: "group-role-reconcile", event: event.kind, source, roleId: w.roleId, viaGroups: w.viaGroups },
    });
  }
  await db.insert(auditLog).values({
    userId: event.actorUserId ?? NIL_UUID,
    objectType: "group_role_mapping",
    objectId: userId,
    effect: "allow",
    ruleId: "group-role-reconciled",
    ruleChain: [],
    reason,
    detail: {
      phase: "group-role-reconcile",
      event: event.kind,
      actor: event.actor,
      source,
      subjectUserId: userId,
      subjectEmail: subject?.email ?? null,
      assertedGroups: detail.asserted,
      unmappedGroups: detail.unmapped,
      mappingsFired: detail.mappingsFired,
      assignmentsAdded: detail.added.map((a) => ({ ...a, origin: "group" })),
      assignmentsRemoved: detail.removed.map((r) => ({ ...r, origin: "group" })),
      ...(event.detail ?? {}),
    },
  });
}
