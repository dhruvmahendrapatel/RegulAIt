/**
 * ADR-0186 A — THE APPROVER POOL, and THE ONE GUARD every approval-rule write
 * calls.
 *
 * The eligible pool of a rule (or of a queued approval) is the named approver
 * plus the ACTIVE members of the approver role, never the caller nor anyone
 * linked to the caller by an active delegation; a delegator and their delegate
 * are one principal. A rule whose pool can never reach its quorum is refused
 * when it is WRITTEN — `assertApprovalRuleWritable` — by every writer of an
 * approval rule: the create (`createApprovalRuleRow`, which the admin route and
 * the copilot's `rule_to_approval` applier both call), the edit choke point
 * (`applyRuleEdit`, PATCH and any other enforcing edit), and the version path
 * (minting a version and activating one, including rollback and canary
 * promotion). A write refused here throws `ApprovalRuleWriteRefusedError`,
 * which app.ts answers as the 422 it carries.
 *
 * Deliberately dependency-light (the database package only): the rule writers
 * import it, and org-settings imports the rule writers.
 */
import {
  and,
  approvalAssignmentRules,
  approvalAssignments,
  approvalDelegations,
  approvalRules,
  approvals,
  approvalSlaPolicies,
  configVersions,
  ne,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  orgSettings,
  ORG_SETTINGS_ID,
  roleAssignments,
  roles,
  sql,
  users,
  webauthnCredentials,
  type Db,
  type SQL,
} from "@regulait/db";

type Q = Pick<Db, "select">;

/**
 * Active delegation links in the CONNECTED COMPONENT of `ids` (none when the
 * org turned delegation off): every link reachable from one of `ids` through
 * other active links, so a chain through people outside `ids` (caller → B →
 * C → approver) still joins its ends — `principalRoots` unions over exactly
 * this set. Walked breadth-first; a person is expanded once, so cycles end.
 * `createdBefore` keeps only links that already existed then (B4S-02: a
 * delegation used to decide a queued approval must predate it), and applies
 * to every link of the walk.
 */
export async function activeDelegationLinks(
  db: Q,
  ids: readonly string[],
  opts: { createdBefore?: Date | SQL | null } = {},
): Promise<Array<[string, string]>> {
  const uniq = [...new Set(ids)];
  if (uniq.length === 0) return [];
  // read straight off the singleton (no org-settings import: this module sits
  // under the rule writers, which org-settings itself imports)
  const [org] = await db
    .select({ enabled: orgSettings.approvalDelegationEnabled })
    .from(orgSettings)
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  if (!org?.enabled) return [];
  const now = new Date();
  const live = and(
    lte(approvalDelegations.startsAt, now),
    gt(approvalDelegations.endsAt, now),
    ...(opts.createdBefore ? [lt(approvalDelegations.createdAt, opts.createdBefore)] : []),
  );
  // breadth-first over the links: each round reads the links touching the
  // people reached so far and not yet expanded, until no one new is reached
  const reached = new Set(uniq);
  const links = new Map<string, [string, string]>();
  let frontier = uniq;
  while (frontier.length > 0) {
    const rows = await db
      .select({ id: approvalDelegations.id, from: approvalDelegations.fromUserId, to: approvalDelegations.toUserId })
      .from(approvalDelegations)
      .where(and(or(inArray(approvalDelegations.fromUserId, frontier), inArray(approvalDelegations.toUserId, frontier)), live));
    const next: string[] = [];
    for (const r of rows) {
      links.set(r.id, [r.from, r.to]);
      for (const p of [r.from, r.to]) {
        if (!reached.has(p)) {
          reached.add(p);
          next.push(p);
        }
      }
    }
    frontier = next;
  }
  return [...links.values()];
}

/**
 * B4S-02: a queued approval's `requested_at`, read by the database in the same
 * statement — compared there at full precision, never as a millisecond JS Date.
 */
export function requestedAtOf(approvalId: string): SQL {
  return sql`(SELECT requested_at FROM approvals WHERE id = ${approvalId})`;
}

/**
 * B4S-02 (owner principle): is `roleId` an approver role — named as
 * `approver_role_id` by any approval rule? Adding someone to it widens that
 * rule's approver pool, so the write needs a `settings_relax` step-up.
 */
export async function isApproverRole(db: Q, roleId: string): Promise<boolean> {
  return (await approverRolesNamed(db, [roleId])).has(roleId);
}

/**
 * ADR-0186 decision 27 (PR #198 round 7, finding 41): `approverRoleId` and
 * `approverUserId` are VERSIONED approval-rule fields (an active or canary
 * version can name a different role or person than the base row). So "is named
 * by an approval rule" reads every version that is SERVED — the base row, an
 * active version, a canary version — never the base row alone. A draft is not
 * served; activating or promoting it goes through the rule writers' guard,
 * which locks the roles it names and steps up a widened pool.
 */
const servedVersionField = (field: "approverRoleId" | "approverUserId") =>
  sql<string>`(${configVersions.body} ->> ${field})`;
const servedVersions = and(eq(configVersions.artifactType, "approval_rule"), inArray(configVersions.status, ["active", "canary"]));

/** which of `roleIds` a rule as served names as its approver role */
export async function approverRolesNamed(db: Q, roleIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(roleIds)];
  if (ids.length === 0) return new Set();
  const base = await db
    .select({ roleId: approvalRules.approverRoleId })
    .from(approvalRules)
    .where(inArray(approvalRules.approverRoleId, ids));
  const versioned = await db
    .select({ roleId: servedVersionField("approverRoleId") })
    .from(configVersions)
    .where(and(servedVersions, inArray(servedVersionField("approverRoleId"), ids)));
  return new Set([...base, ...versioned].map((r) => r.roleId).filter((r): r is string => !!r));
}

/** does a rule as served (base row, active or canary version) name `userId` as its approver? */
export async function namedApproverSeatExists(db: Q, userId: string): Promise<boolean> {
  const [base] = await db.select({ id: approvalRules.id }).from(approvalRules).where(eq(approvalRules.approverUserId, userId)).limit(1);
  if (base) return true;
  const [versioned] = await db
    .select({ id: configVersions.id })
    .from(configVersions)
    .where(and(servedVersions, eq(servedVersionField("approverUserId"), userId)))
    .limit(1);
  return !!versioned;
}

/**
 * ADR-0186 A (Class A) — THE APPROVER-ROLE LOCK. A write that adds people to a
 * role (a direct assignment, a group mapping, an onboarding import) decides
 * its step-up on `isApproverRole`, and an approval-rule write that names a role
 * decides ITS step-up on the role's current members. Both lock the role ROW
 * (`FOR UPDATE`; the rule writers through `approvalRuleQuorumRefusal`, inside
 * their transaction) so neither can be decided on a state the other is about
 * to change. Call inside a transaction; returns which of `roleIds` are approver
 * roles, read under the lock.
 */
export async function lockApproverRoles(tx: Q, roleIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(roleIds)].sort();
  if (ids.length === 0) return new Set();
  await tx.select({ id: roles.id }).from(roles).where(inArray(roles.id, ids)).orderBy(roles.id).for("update");
  // decision 27 (finding 41): the base row AND every served version (active, canary)
  return approverRolesNamed(tx, ids);
}

/**
 * ADR-0186 A (PR #198 round 5) — a JIT-provisioned account's default role.
 * Granted only when it is NOT an approver role, decided under the approver-role
 * lock (so a rule edit naming the role cannot interleave): an identity the IdP
 * mints must never join an approver pool silently. Withheld = the caller audits
 * it; an admin may then assign the role with the step-up a role assignment needs.
 */
export async function grantJitDefaultRole(
  db: Pick<Db, "transaction">,
  userId: string,
  roleId: string,
): Promise<"granted" | "withheld"> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Q & Pick<Db, "insert">;
    if ((await lockApproverRoles(tx, [roleId])).has(roleId)) return "withheld" as const;
    await tx.insert(roleAssignments).values({ userId, roleId }).onConflictDoNothing();
    return "granted" as const;
  });
}

/**
 * G2 (B4S-02 owner principle): can membership of this team ROUTE or CLAIM an
 * approval? A team is named by an enabled routing rule, by an SLA policy that
 * escalates to it (reassign / add an assignee), or by the assignment (or
 * escalation) of a pending approval. A member of such a team may claim the
 * approval and — for every kind but a tool call, whose deciders are fixed at
 * queue time (B4S-02) — decide it; so adding a member is a settings_relax act.
 */
export async function isApprovalTeam(db: Q, teamId: string): Promise<boolean> {
  const [rule] = await db
    .select({ id: approvalAssignmentRules.id })
    .from(approvalAssignmentRules)
    .where(
      and(
        eq(approvalAssignmentRules.enabled, true),
        eq(approvalAssignmentRules.assigneeKind, "team"),
        eq(approvalAssignmentRules.assigneeId, teamId),
      ),
    )
    .limit(1);
  if (rule) return true;
  const [sla] = await db
    .select({ id: approvalSlaPolicies.id })
    .from(approvalSlaPolicies)
    .where(
      and(
        ne(approvalSlaPolicies.escalateAction, "notify_only"),
        eq(approvalSlaPolicies.escalateToKind, "team"),
        eq(approvalSlaPolicies.escalateToId, teamId),
      ),
    )
    .limit(1);
  if (sla) return true;
  const [assigned] = await db
    .select({ id: approvalAssignments.id })
    .from(approvalAssignments)
    .innerJoin(approvals, eq(approvals.id, approvalAssignments.approvalId))
    .where(
      and(
        eq(approvals.status, "pending"),
        or(
          and(eq(approvalAssignments.assigneeKind, "team"), eq(approvalAssignments.assigneeId, teamId)),
          and(eq(approvalAssignments.escalationAssigneeKind, "team"), eq(approvalAssignments.escalationAssigneeId, teamId)),
        ),
      ),
    )
    .limit(1);
  return Boolean(assigned);
}

/** union-find over delegation links: every id → its principal group's root */
export function principalRoots(ids: readonly string[], links: ReadonlyArray<readonly [string, string]>): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  for (const id of ids) find(id);
  for (const [a, b] of links) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const out = new Map<string, string>();
  for (const id of parent.keys()) out.set(id, find(id));
  return out;
}

export interface ApprovalPool {
  /** eligible people: the named approver and active approver-role members, never the caller or anyone delegation-linked to them */
  members: string[];
  /** how many distinct principals they make (a delegator and their delegate are one) */
  principals: number;
}

/**
 * The eligible pool for one approval (or one rule): the named approver plus
 * the ACTIVE members of `approverRoleId` (disabled users never count), minus
 * the caller and everyone linked to the caller by an active delegation.
 *
 * `asOf` (B4S-02, a queued approval's `requested_at`): dual control must not
 * be satisfiable by principals created after the call was queued, so only an
 * account created before then counts, and a role member counts only through a
 * role assignment granted before then (the named approver needs none). A
 * `namedApproverUserId` of null names nobody (the approval's snapshot approver
 * could not be established).
 */
export async function loadApprovalPool(
  db: Q,
  input: {
    namedApproverUserId: string | null;
    approverRoleId: string | null;
    callerUserId: string | null;
    asOf?: Date | SQL | null;
    /**
     * ADR-0186 B (PR #198 rounds 5–6): passkey mode. Count only principals who
     * can SIGN, by the decide path's own rule (`eligibilityOf` +
     * `credentialPredates`): a pool member signs themselves with an unrevoked
     * passkey enrolled before this instant, or a DIRECT delegate of theirs signs
     * for them — the delegation created before this instant and live now, the
     * delegate an active account created before this instant holding such a
     * passkey. Anyone else in the delegation component (the member's own
     * delegator, a chain two links away) cannot sign for them and never makes
     * them countable. Members are unchanged; `principals` counts signable ones.
     */
    signableBefore?: Date | SQL | null;
  },
): Promise<ApprovalPool> {
  const candidates = new Set<string>(input.namedApproverUserId ? [input.namedApproverUserId] : []);
  if (input.approverRoleId) {
    const members = await db
      .select({ userId: roleAssignments.userId })
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.roleId, input.approverRoleId),
          ...(input.asOf ? [lt(roleAssignments.createdAt, input.asOf)] : []),
        ),
      );
    for (const m of members) candidates.add(m.userId);
  }
  const ids = [...candidates];
  if (ids.length === 0) return { members: [], principals: 0 };
  const active = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        inArray(users.id, ids),
        isNull(users.disabledAt),
        ...(input.asOf ? [lt(users.createdAt, input.asOf)] : []),
      ),
    );
  let members = active.map((u) => u.id);
  const links = await activeDelegationLinks(db, input.callerUserId ? [...members, input.callerUserId] : members);
  const roots = principalRoots(input.callerUserId ? [...members, input.callerUserId] : members, links);
  if (input.callerUserId) {
    const callerRoot = roots.get(input.callerUserId);
    members = members.filter((m) => m !== input.callerUserId && roots.get(m) !== callerRoot);
  }
  let countable = members;
  if (input.signableBefore && members.length > 0) {
    const memberSet = new Set(members);
    // the decide path's delegation rule: a link FROM a pool member TO the decider, created before
    const priorLinks = await activeDelegationLinks(db, members, { createdBefore: input.signableBefore });
    const delegatesOf = new Map<string, string[]>();
    for (const [from, to] of priorLinks) {
      if (!memberSet.has(from) || to === input.callerUserId) continue;
      delegatesOf.set(from, [...(delegatesOf.get(from) ?? []), to]);
    }
    const outsideDelegates = [...new Set([...delegatesOf.values()].flat())].filter((d) => !memberSet.has(d));
    // a delegate who is not a member must be an active account that existed by then (the decider check)
    const eligibleDelegates = new Set(
      outsideDelegates.length
        ? (
            await db
              .select({ id: users.id })
              .from(users)
              .where(and(inArray(users.id, outsideDelegates), isNull(users.disabledAt), lt(users.createdAt, input.signableBefore)))
          ).map((u) => u.id)
        : [],
    );
    const signers = [...members, ...eligibleDelegates];
    const holders = new Set(
      (
        await db
          .select({ userId: webauthnCredentials.userId })
          .from(webauthnCredentials)
          .where(
            and(
              inArray(webauthnCredentials.userId, signers),
              isNull(webauthnCredentials.revokedAt),
              lt(webauthnCredentials.createdAt, input.signableBefore),
            ),
          )
      ).map((h) => h.userId),
    );
    countable = members.filter(
      (m) =>
        holders.has(m) ||
        (delegatesOf.get(m) ?? []).some((d) => (memberSet.has(d) || eligibleDelegates.has(d)) && holders.has(d)),
    );
  }
  return { members: members.sort(), principals: new Set(countable.map((m) => roots.get(m))).size };
}

export interface QuorumUnsatisfiable {
  status: 422;
  body: { error: "quorum_unsatisfiable"; quorum: number; eligiblePrincipals: number; detail: string };
}

/**
 * Can this rule's pool ever reach its quorum? Best case for the caller: the
 * caller is outside the pool, except for a user-scoped rule, whose subject IS
 * every caller. Returns the refusal, or null. `approverRoleId` must name an
 * existing role (else a 422 `unknown_role`).
 */
export async function approvalRuleQuorumRefusal(
  db: Q,
  rule: { approverUserId: string; approverRoleId: string | null; quorum: number; scope?: string | null; userId?: string | null },
): Promise<QuorumUnsatisfiable | { status: 422; body: { error: "unknown_role"; detail: string } } | null> {
  // the named approver's user row is LOCKED (FOR SHARE, inside the writer's
  // transaction): a reactivation deciding its step-up on "does this account hold
  // a named seat" holds that row FOR UPDATE, so neither decides on a state the
  // other is about to change (ADR-0186 A, Class A)
  if (rule.approverUserId) {
    await db.select({ id: users.id }).from(users).where(eq(users.id, rule.approverUserId)).for("share");
  }
  if (rule.approverRoleId) {
    // the role row is LOCKED (inside the writer's transaction): a membership write
    // deciding its step-up on `lockApproverRoles` waits for this rule write, and the
    // other way round (ADR-0186 A, Class A)
    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, rule.approverRoleId)).for("update");
    if (!role) return { status: 422, body: { error: "unknown_role", detail: "approverRoleId names no role" } };
  }
  const pool = await loadApprovalPool(db, {
    namedApproverUserId: rule.approverUserId,
    approverRoleId: rule.approverRoleId,
    callerUserId: rule.scope === "user" && rule.userId ? rule.userId : null,
  });
  if (pool.principals >= rule.quorum) return null;
  return {
    status: 422,
    body: {
      error: "quorum_unsatisfiable",
      quorum: rule.quorum,
      eligiblePrincipals: pool.principals,
      detail:
        `this rule needs ${rule.quorum} different approvers but its pool (the named approver and the active members ` +
        `of its approver role, never the caller, a delegator and their delegate counting once) has only ` +
        `${pool.principals}: add people to the approver role or lower the quorum`,
    },
  };
}

/** a write of an approval rule refused by the satisfiability guard (answered as `status` + `body`) */
export class ApprovalRuleWriteRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.detail ?? body.error));
    this.name = "ApprovalRuleWriteRefusedError";
  }
}

/** the facts of an approval rule as it would stand AFTER a write */
export interface ApprovalRuleShape {
  approverUserId: string;
  approverRoleId?: string | null;
  quorum?: number | null;
  scope?: string | null;
  userId?: string | null;
}

/**
 * THE ONE GUARD. Every write of an approval rule (create, edit, version mint,
 * version activation) passes the rule as it would stand after the write; a
 * pool that can never reach the quorum, or an unknown approver role, throws.
 */
export async function assertApprovalRuleWritable(db: Q, rule: ApprovalRuleShape): Promise<void> {
  const refusal = await approvalRuleQuorumRefusal(db, {
    approverUserId: rule.approverUserId,
    approverRoleId: rule.approverRoleId ?? null,
    quorum: rule.quorum ?? 1,
    scope: rule.scope ?? null,
    userId: rule.userId ?? null,
  });
  if (refusal) throw new ApprovalRuleWriteRefusedError(refusal.status, refusal.body);
}

/** an approval rule's shape from a row (and a body layered over it) */
export function approvalRuleShape(r: Record<string, unknown>): ApprovalRuleShape {
  return {
    approverUserId: String(r.approverUserId ?? ""),
    approverRoleId: (r.approverRoleId as string | null | undefined) ?? null,
    quorum: typeof r.quorum === "number" ? r.quorum : 1,
    scope: (r.scope as string | null | undefined) ?? null,
    userId: (r.userId as string | null | undefined) ?? null,
  };
}

// ---------------------------------------------------------------------------
// ADR-0180 / ADR-0186 A — a write that LOOSENS dual control needs a step-up
// ---------------------------------------------------------------------------

/**
 * The `settings_relax` step-up a loosening approval-rule write must carry,
 * bound to `facts` (`{ruleId, values}`). Supplied by the HTTP route (which has
 * the request); it spends the grant, or throws `ApprovalRuleWriteRefusedError`
 * carrying the step-up refusal.
 */
export type ApprovalRuleStepUp = (facts: { ruleId: string; values: Record<string, unknown> }) => Promise<void>;

/**
 * Does moving a rule from `before` to `after` (null = the rule is deleted)
 * loosen dual control? Yes when the quorum goes down, when the eligible pool
 * (`loadApprovalPool`, the same pool the satisfiability guard and the queue
 * use) gains anyone who was not in it before or counts more principals, or
 * when the rule (and so its approval requirement) is removed. Raising the
 * quorum or narrowing the pool is not.
 */
export async function approvalRuleLoosens(db: Q, before: ApprovalRuleShape, after: ApprovalRuleShape | null): Promise<boolean> {
  if (!after) return true;
  if ((after.quorum ?? 1) < (before.quorum ?? 1)) return true;
  const poolOf = (r: ApprovalRuleShape) =>
    loadApprovalPool(db, {
      namedApproverUserId: r.approverUserId,
      approverRoleId: r.approverRoleId ?? null,
      callerUserId: r.scope === "user" && r.userId ? r.userId : null,
    });
  const [was, now] = [await poolOf(before), await poolOf(after)];
  if (now.principals > was.principals) return true;
  const prior = new Set(was.members);
  return now.members.some((m) => !prior.has(m));
}

/**
 * THE LOOSENING GUARD, run by every approval-rule writer beside
 * `assertApprovalRuleWritable` (the edit choke point's row write, version
 * activation — mint-and-activate, activate, rollback, canary promotion — and
 * the delete). A write that loosens dual control needs the `settings_relax`
 * step-up (`stepUp`, from the route). A writer with no request to step up
 * (no `stepUp`) is refused whenever the stored policy asks for it: fail
 * closed, never a silent loosening.
 */
export async function assertApprovalRuleLooseningStepUp(
  db: Q,
  args: { ruleId: string; before: ApprovalRuleShape; after: ApprovalRuleShape | null; stepUp?: ApprovalRuleStepUp | null },
): Promise<void> {
  if (!(await approvalRuleLoosens(db, args.before, args.after))) return;
  const values: Record<string, unknown> = args.after
    ? { quorum: args.after.quorum ?? 1, approverRoleId: args.after.approverRoleId ?? null, approverUserId: args.after.approverUserId }
    : { deleted: true };
  return requireRuleStepUp(
    db,
    { ruleId: args.ruleId, values },
    args.stepUp,
    "this change loosens dual control on an approval rule (a lower quorum, a wider approver pool, or removing the " +
      "rule) and needs a step-up, which this write path cannot ask for: make the change as an admin in RegulAIt",
  );
}

/**
 * B4S-05: removing a rate limit or a data-scope rule removes a restriction —
 * the same `settings_relax` step-up as removing an approval rule, bound to
 * `{ruleId, values: {deleted: true}}`.
 */
export async function assertRuleRemovalStepUp(
  db: Q,
  args: { ruleId: string; stepUp?: ApprovalRuleStepUp | null },
): Promise<void> {
  return requireRuleStepUp(
    db,
    { ruleId: args.ruleId, values: { deleted: true } },
    args.stepUp,
    "removing a governance rule removes the restriction it enforces and needs a step-up, which this write path " +
      "cannot ask for: make the change as an admin in RegulAIt",
  );
}

/** the step-up a rule write that loosens a protection carries: the route's (`stepUp`), or a fail-closed refusal */
export async function requireRuleStepUp(
  db: Q,
  facts: { ruleId: string; values: Record<string, unknown> },
  stepUp: ApprovalRuleStepUp | null | undefined,
  detail: string,
): Promise<void> {
  if (stepUp) return stepUp(facts);
  // no request in hand: decide from the stored policy (the strict default when the singleton does not exist yet)
  const [org] = await db
    .select({ mode: orgSettings.stepUpMode, actions: orgSettings.stepUpActions })
    .from(orgSettings)
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  const applies = !org || (org.mode === "required" && (org.actions as string[]).includes("settings_relax"));
  if (!applies) return;
  throw new ApprovalRuleWriteRefusedError(403, {
    error: "step_up_required",
    actionKind: "settings_relax",
    methods: [],
    action: { kind: "settings_relax", body: facts },
    detail,
  });
}
