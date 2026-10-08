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
  const [hit] = await db.select({ id: approvalRules.id }).from(approvalRules).where(eq(approvalRules.approverRoleId, roleId)).limit(1);
  return !!hit;
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
  input: { namedApproverUserId: string | null; approverRoleId: string | null; callerUserId: string | null; asOf?: Date | SQL | null },
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
  return { members: members.sort(), principals: new Set(members.map((m) => roots.get(m))).size };
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
  if (rule.approverRoleId) {
    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, rule.approverRoleId));
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
async function requireRuleStepUp(
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
