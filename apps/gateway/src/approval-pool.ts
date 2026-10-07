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
  approvalDelegations,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  orgSettings,
  ORG_SETTINGS_ID,
  roleAssignments,
  roles,
  users,
  type Db,
} from "@regulait/db";

type Q = Pick<Db, "select">;

/** active delegation links touching any of `ids` (none when the org turned delegation off) */
export async function activeDelegationLinks(db: Q, ids: readonly string[]): Promise<Array<[string, string]>> {
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
  const rows = await db
    .select({ from: approvalDelegations.fromUserId, to: approvalDelegations.toUserId })
    .from(approvalDelegations)
    .where(
      and(
        or(inArray(approvalDelegations.fromUserId, uniq), inArray(approvalDelegations.toUserId, uniq)),
        lte(approvalDelegations.startsAt, now),
        gt(approvalDelegations.endsAt, now),
      ),
    );
  return rows.map((r) => [r.from, r.to]);
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
 */
export async function loadApprovalPool(
  db: Q,
  input: { namedApproverUserId: string; approverRoleId: string | null; callerUserId: string | null },
): Promise<ApprovalPool> {
  const candidates = new Set<string>([input.namedApproverUserId]);
  if (input.approverRoleId) {
    const members = await db
      .select({ userId: roleAssignments.userId })
      .from(roleAssignments)
      .where(eq(roleAssignments.roleId, input.approverRoleId));
    for (const m of members) candidates.add(m.userId);
  }
  const ids = [...candidates];
  const active = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, ids), isNull(users.disabledAt)));
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
  const facts = { ruleId: args.ruleId, values };
  if (args.stepUp) return args.stepUp(facts);
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
    detail:
      "this change loosens dual control on an approval rule (a lower quorum, a wider approver pool, or removing the " +
      "rule) and needs a step-up, which this write path cannot ask for: make the change as an admin in RegulAIt",
  });
}
